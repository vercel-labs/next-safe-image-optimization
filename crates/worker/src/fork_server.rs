//! The fork server (unix only). With `--fork-server`, the worker gets a Unix socket as stdin, and
//! forks a new worker each time the shim asks, so that workers skip `exec` and loading the binary.
//! It's single-threaded (forking only copies the calling thread), and never sees any image data.
//! It has no seccomp filter: workers install theirs after forking, and a filter for the server
//! would have to allow everything they do before that.
//!
//! The shim sends `[u8 op][u64 LE id]` messages (keep in sync with `crates/shim/src/fork.rs`):
//!
//! - `SPAWN`, with three file descriptors attached (`SCM_RIGHTS`): the new worker's stdin and
//!   stdout, and a status socket. The server sends the worker's pid on the status socket (or a
//!   negated errno, if `fork` failed), with a pidfd attached on Linux (if `pidfd_open` works), and
//!   then its wait status once it exits (`i32 LE`s).
//! - `KILL`: kills the worker, unless it already exited. Ids aren't reused, and the server forgets
//!   an id when it reaps the worker, so a late `KILL` can't hit a reused pid. The shim only uses
//!   this without a pidfd.
//!
//! Only a parent can reap a process, so the server reports exit statuses for the shim. Workers
//! close every file descriptor the server holds, including the socket, so they can't ask it to do
//! anything.

use std::io::{self, Write};
use std::mem::{self, ManuallyDrop};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::ptr;
use std::sync::atomic::{AtomicI32, Ordering};

use blunt_core::exit_immediately;
use blunt_core::protocol::{EXIT_INVALID_FRAME, EXIT_SANDBOX_FAILED};

const SPAWN: u8 = 0;
const KILL: u8 = 1;
const MESSAGE_LEN: usize = 9;

const CONTROL: RawFd = libc::STDIN_FILENO;

struct Worker {
    id: u64,
    pid: libc::pid_t,
    status: UnixStream,
}

enum Message {
    Spawn {
        id: u64,
        stdin: OwnedFd,
        stdout: OwnedFd,
        status: UnixStream,
    },
    Kill {
        id: u64,
    },
}

/// The write end of a pipe that wakes up the loop when a worker exits.
static WAKE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_child_exit(_: libc::c_int) {
    // This only fails (and clobbers `errno`) if the pipe is full, which would take more unread
    // wakeups than there are workers.
    unsafe { libc::write(WAKE.load(Ordering::Relaxed), [0u8].as_ptr().cast(), 1) };
}

/// Only returns in a newly forked worker, with its pipes as stdin and stdout. Exits when the
/// socket closes.
pub fn serve() {
    let (wake, wake_writer) = pipe();
    WAKE.store(wake_writer.as_raw_fd(), Ordering::Relaxed);
    on_sigchld(on_child_exit as *const () as libc::sighandler_t);

    // Tells the shim that we started.
    if control().write_all(&[0]).is_err() {
        exit_immediately(0);
    }

    let mut workers: Vec<Worker> = Vec::new();
    loop {
        reap(&mut workers);
        let mut fds = [
            libc::pollfd {
                fd: CONTROL,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: wake.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        // Interrupted when a worker exits.
        if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, -1) } <= 0 {
            continue;
        }
        if fds[1].revents != 0 {
            let mut buf = [0; 64];
            while unsafe { libc::read(wake.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) } > 0 {}
        }
        if fds[0].revents == 0 {
            continue;
        }
        match receive() {
            // The shim closed the socket.
            None => exit_immediately(0),
            Some(Message::Kill { id }) => {
                if let Some(worker) = workers.iter().find(|worker| worker.id == id) {
                    unsafe { libc::kill(worker.pid, libc::SIGKILL) };
                }
            }
            Some(Message::Spawn {
                id,
                stdin,
                stdout,
                mut status,
            }) => match unsafe { libc::fork() } {
                0 => {
                    on_sigchld(libc::SIG_DFL);
                    // Replacing fd 0 also closes this process's copy of the socket.
                    if unsafe { libc::dup2(stdin.as_raw_fd(), libc::STDIN_FILENO) } < 0
                        || unsafe { libc::dup2(stdout.as_raw_fd(), libc::STDOUT_FILENO) } < 0
                    {
                        exit_immediately(EXIT_SANDBOX_FAILED);
                    }
                    // Closes everything else: the wake pipe, and every status socket (including
                    // other workers').
                    return;
                }
                -1 => {
                    let errno = io::Error::last_os_error().raw_os_error().unwrap_or(0);
                    let _ = status.write_all(&(-errno).to_le_bytes());
                }
                pid => {
                    // The worker can't be reaped yet, so this can't open a reused pid.
                    let pidfd = pidfd_open(pid);
                    let fds: Vec<BorrowedFd> = pidfd.iter().map(|fd| fd.as_fd()).collect();
                    let _ = blunt_scm::send(status.as_fd(), &pid.to_le_bytes(), &fds);
                    workers.push(Worker { id, pid, status });
                }
            },
        }
    }
}

/// Writes the wait status of every worker that exited.
fn reap(workers: &mut Vec<Worker>) {
    loop {
        let mut status = 0;
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if pid <= 0 {
            return;
        }
        if let Some(i) = workers.iter().position(|worker| worker.pid == pid) {
            let _ = workers
                .swap_remove(i)
                .status
                .write_all(&status.to_le_bytes());
        }
    }
}

/// Returns `None` if the socket closed. The shim is trusted, so an invalid message is a bug.
fn receive() -> Option<Message> {
    let mut message = [0u8; MESSAGE_LEN];
    let control = unsafe { BorrowedFd::borrow_raw(CONTROL) };
    let fds = blunt_scm::receive(control, &mut message).ok()?;
    let id = u64::from_le_bytes(message[1..].try_into().expect("8 bytes"));
    Some(match (message[0], <[OwnedFd; 3]>::try_from(fds)) {
        (SPAWN, Ok([stdin, stdout, status])) => Message::Spawn {
            id,
            stdin,
            stdout,
            status: UnixStream::from(status),
        },
        (KILL, Err(fds)) if fds.is_empty() => Message::Kill { id },
        _ => exit_immediately(EXIT_INVALID_FRAME),
    })
}

#[cfg(target_os = "linux")]
fn pidfd_open(pid: libc::pid_t) -> Option<OwnedFd> {
    // Fails on Linux before 5.3, or if another sandbox (like an old container runtime) blocks it.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd as RawFd) })
}

#[cfg(not(target_os = "linux"))]
fn pidfd_open(_: libc::pid_t) -> Option<OwnedFd> {
    None
}

/// The socket, without taking ownership of fd 0.
fn control() -> ManuallyDrop<UnixStream> {
    ManuallyDrop::new(unsafe { UnixStream::from_raw_fd(CONTROL) })
}

fn pipe() -> (OwnedFd, OwnedFd) {
    let mut fds = [0; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        exit_immediately(EXIT_SANDBOX_FAILED);
    }
    for fd in fds {
        unsafe { libc::fcntl(fd, libc::F_SETFL, libc::O_NONBLOCK) };
    }
    unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
}

fn on_sigchld(handler: libc::sighandler_t) {
    let mut action: libc::sigaction = unsafe { mem::zeroed() };
    action.sa_sigaction = handler;
    action.sa_flags = libc::SA_NOCLDSTOP | libc::SA_RESTART;
    unsafe {
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGCHLD, &action, ptr::null_mut());
    }
}
