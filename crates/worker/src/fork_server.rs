//! The fork server (unix only). With `--fork-server <socket>`, the worker forks a new worker each
//! time the parent (`js/native.ts`) asks, so that workers skip `exec` and loading the binary. It's
//! single-threaded (forking only copies the calling thread), and never sees any image data. It has
//! no seccomp filter: workers install theirs after forking, and a filter for the server would have
//! to allow everything they do before that.
//!
//! The parent listens on `<socket>` (an abstract name on Linux, or else a path). Each worker's
//! stdin and stdout are a connection to it: the server connects, sends the worker's token (so that
//! the parent knows which worker it is), and forks.
//!
//! The parent sends `[u8 op][u64 LE id][16-byte token]` messages on stdin (keep in sync with
//! `js/native.ts`):
//!
//! - `SPAWN`: connects with the token, and forks a worker. The server replies `SPAWNED` with the
//!   worker's pid, or a negated errno if connecting or forking failed.
//! - `KILL`: kills the worker, unless it already exited. The token is unused. Ids aren't reused,
//!   and the server forgets an id when it reaps the worker, so a late `KILL` can't hit a reused pid.
//!
//! Replies on stdout are `[u8 kind][u64 LE id][i32 LE value]`. Only a parent can reap a process, so
//! after reaping a worker, the server replies `EXITED` with its exit code, or its negated signal
//! number. Workers close every file descriptor the server holds, so they can't ask it to do
//! anything.

use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read, Write};
use std::mem::{self, ManuallyDrop};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::ptr;
use std::sync::atomic::{AtomicI32, Ordering};

use blunt_core::exit_immediately;
use blunt_core::protocol::{EXIT_INVALID_FRAME, EXIT_SANDBOX_FAILED};

const SPAWN: u8 = 0;
const KILL: u8 = 1;
const TOKEN_LEN: usize = 16;
const MESSAGE_LEN: usize = 1 + 8 + TOKEN_LEN;

const SPAWNED: u8 = 0;
const EXITED: u8 = 1;
const REPLY_LEN: usize = 1 + 8 + 4;

struct Worker {
    id: u64,
    pid: libc::pid_t,
}

enum Message {
    Spawn { id: u64, token: [u8; TOKEN_LEN] },
    Kill { id: u64 },
}

/// The write end of a pipe that wakes up the loop when a worker exits.
static WAKE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_child_exit(_: libc::c_int) {
    // This only fails (and clobbers `errno`) if the pipe is full, which would take more unread
    // wakeups than there are workers.
    unsafe { libc::write(WAKE.load(Ordering::Relaxed), [0u8].as_ptr().cast(), 1) };
}

/// Only returns in a newly forked worker, with its connection as stdin and stdout. Exits when
/// stdin closes.
pub fn serve(socket: &OsStr) {
    let (wake, wake_writer) = pipe();
    WAKE.store(wake_writer.as_raw_fd(), Ordering::Relaxed);
    on_sigchld(on_child_exit as *const () as libc::sighandler_t);

    let mut workers: Vec<Worker> = Vec::new();
    loop {
        reap(&mut workers);
        let mut fds = [
            libc::pollfd {
                fd: libc::STDIN_FILENO,
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
            // The parent closed stdin.
            None => exit_immediately(0),
            Some(Message::Kill { id }) => {
                if let Some(worker) = workers.iter().find(|worker| worker.id == id) {
                    unsafe { libc::kill(worker.pid, libc::SIGKILL) };
                }
            }
            Some(Message::Spawn { id, token }) => {
                let connection = match connect(socket, &token) {
                    Ok(connection) => connection,
                    Err(err) => {
                        reply(SPAWNED, id, -err.raw_os_error().unwrap_or(libc::EIO));
                        continue;
                    }
                };
                match unsafe { libc::fork() } {
                    0 => {
                        on_sigchld(libc::SIG_DFL);
                        // Replacing fds 0 and 1 also closes this process's copies of the server's
                        // stdin and stdout.
                        let fd = connection.as_raw_fd();
                        if unsafe { libc::dup2(fd, libc::STDIN_FILENO) } < 0
                            || unsafe { libc::dup2(fd, libc::STDOUT_FILENO) } < 0
                        {
                            exit_immediately(EXIT_SANDBOX_FAILED);
                        }
                        // Closes everything else: the connection's original fd, and the wake pipe.
                        return;
                    }
                    -1 => {
                        let errno = io::Error::last_os_error().raw_os_error().unwrap_or(0);
                        reply(SPAWNED, id, -errno);
                    }
                    pid => {
                        reply(SPAWNED, id, pid);
                        workers.push(Worker { id, pid });
                    }
                }
            }
        }
    }
}

/// Replies `EXITED` for every worker that exited.
fn reap(workers: &mut Vec<Worker>) {
    loop {
        let mut status = 0;
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if pid <= 0 {
            return;
        }
        if let Some(i) = workers.iter().position(|worker| worker.pid == pid) {
            let value = if libc::WIFSIGNALED(status) {
                -libc::WTERMSIG(status)
            } else {
                libc::WEXITSTATUS(status)
            };
            reply(EXITED, workers.swap_remove(i).id, value);
        }
    }
}

/// Returns `None` if stdin closed. The parent is trusted, so an invalid message is a bug.
fn receive() -> Option<Message> {
    let mut message = [0u8; MESSAGE_LEN];
    fd(libc::STDIN_FILENO).read_exact(&mut message).ok()?;
    let id = u64::from_le_bytes(message[1..9].try_into().expect("8 bytes"));
    Some(match message[0] {
        SPAWN => Message::Spawn {
            id,
            token: message[9..].try_into().expect("a token"),
        },
        KILL => Message::Kill { id },
        _ => exit_immediately(EXIT_INVALID_FRAME),
    })
}

fn reply(kind: u8, id: u64, value: i32) {
    let mut message = [0u8; REPLY_LEN];
    message[0] = kind;
    message[1..9].copy_from_slice(&id.to_le_bytes());
    message[9..].copy_from_slice(&value.to_le_bytes());
    if fd(libc::STDOUT_FILENO).write_all(&message).is_err() {
        // The parent is gone.
        exit_immediately(0);
    }
}

fn connect(socket: &OsStr, token: &[u8]) -> io::Result<UnixStream> {
    let mut connection = connect_to(socket)?;
    connection.write_all(token)?;
    Ok(connection)
}

#[cfg(target_os = "linux")]
fn connect_to(socket: &OsStr) -> io::Result<UnixStream> {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::net::SocketAddr;

    UnixStream::connect_addr(&SocketAddr::from_abstract_name(socket.as_bytes())?)
}

#[cfg(not(target_os = "linux"))]
fn connect_to(socket: &OsStr) -> io::Result<UnixStream> {
    UnixStream::connect(socket)
}

/// Without taking ownership of the file descriptor.
fn fd(fd: RawFd) -> ManuallyDrop<File> {
    ManuallyDrop::new(unsafe { File::from_raw_fd(fd) })
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
