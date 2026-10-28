//! The fork server (unix only). With `--fork-server`, the worker forks a new worker each time the
//! parent (`js/native.ts`) asks, so that workers skip `exec` and loading the binary. It's
//! single-threaded (forking only copies the calling thread), and never sees any image data. It has
//! no seccomp filter: workers install theirs after forking (compiled before the server started), and
//! a filter for the server would have to allow everything they do before that.
//!
//! The parent spawns it with Node's IPC channel as fd 3 (see `node_ipc.rs`), which can pass file
//! descriptors. For each worker, the server creates a socketpair and forks. One end is the worker's
//! stdin and stdout, and the server sends the other to the parent, so there's no socket that
//! another process could connect to. The server exits when the channel closes.
//!
//! The parent sends `Message`s (keep in sync with `js/native.ts`):
//!
//! - `spawn`: forks a worker. The server replies `spawned` with the worker's pid and socket, or
//!   `spawnFailed`.
//! - `kill`: kills the worker, unless it already exited. Ids aren't reused, and the server forgets
//!   an id when it reaps the worker, so a late `kill` can't hit a reused pid.
//!
//! Only a parent can reap a process, so after reaping a worker, the server replies `exited` with
//! its exit code or signal number. Workers close every file descriptor the server holds, so they
//! can't ask it to do anything.

use std::env;
use std::io;
use std::mem;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::ptr;
use std::sync::atomic::{AtomicI32, Ordering};

use blunt_core::exit_immediately;
use blunt_core::protocol::{EXIT_INVALID_FRAME, EXIT_SANDBOX_FAILED};
use serde::{Deserialize, Serialize};

use crate::node_ipc::{self, Channel, Event};

/// Where the parent puts the IPC channel.
const CHANNEL_FD: RawFd = 3;

struct Worker {
    id: u64,
    pid: libc::pid_t,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Message {
    Spawn { id: u64 },
    Kill { id: u64 },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Reply {
    /// Sent with the worker's socket.
    Spawned {
        id: u64,
        pid: libc::pid_t,
    },
    SpawnFailed {
        id: u64,
        error: String,
    },
    /// Exactly one of `code` and `signal` is set.
    Exited {
        id: u64,
        code: Option<i32>,
        signal: Option<i32>,
    },
}

/// Tagged with the worker's id.
type Parent = Channel<u64>;

/// The write end of a pipe that wakes up the loop when a worker exits.
static WAKE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_child_exit(_: libc::c_int) {
    // This only fails (and clobbers `errno`) if the pipe is full, which would take more unread
    // wakeups than there are workers.
    unsafe { libc::write(WAKE.load(Ordering::Relaxed), [0u8].as_ptr().cast(), 1) };
}

/// Only returns in a newly forked worker, with its socket as stdin and stdout. Exits when the IPC
/// channel closes.
pub fn serve() {
    // Node adds its IPC variables (like `NODE_CHANNEL_FD`) to the empty environment it spawns us
    // with. Workers' environments are empty without them (though `/proc/<pid>/environ` still shows
    // the server's original environment).
    for (key, _) in env::vars_os() {
        // SAFETY: there's only one thread.
        unsafe { env::remove_var(key) };
    }
    // SAFETY: nothing else uses fd 3.
    let mut parent: Parent = unsafe { Channel::open(CHANNEL_FD) }
        .unwrap_or_else(|_| exit_immediately(EXIT_SANDBOX_FAILED));
    let (wake, wake_writer) = pipe();
    WAKE.store(wake_writer.as_raw_fd(), Ordering::Relaxed);
    on_sigchld(on_child_exit as *const () as libc::sighandler_t);

    let mut workers: Vec<Worker> = Vec::new();
    loop {
        reap(&mut workers, &parent);
        let mut fds = [
            libc::pollfd {
                fd: parent.as_raw_fd(),
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
        let events = match parent.receive() {
            Ok(events) => events,
            Err(node_ipc::Error::Closed) => exit_immediately(0),
            // The parent is trusted, so this is a bug.
            Err(node_ipc::Error::Invalid) => exit_immediately(EXIT_INVALID_FRAME),
        };
        for event in events {
            match event {
                Event::Lost(id) => {
                    // Node retries a few times, but this most likely means the parent ran out of
                    // file descriptors (`MSG_CTRUNC`), so fail the spawn instead.
                    kill(&workers, id);
                    send(
                        &parent,
                        &Reply::SpawnFailed {
                            id,
                            error: "couldn't send the worker's socket".into(),
                        },
                    );
                }
                Event::Message(Message::Kill { id }) => kill(&workers, id),
                Event::Message(Message::Spawn { id }) => {
                    let (ours, theirs) = match UnixStream::pair() {
                        Ok(pair) => pair,
                        Err(err) => {
                            send(
                                &parent,
                                &Reply::SpawnFailed {
                                    id,
                                    error: format!("failed to create a socket: {err}"),
                                },
                            );
                            continue;
                        }
                    };
                    match unsafe { libc::fork() } {
                        0 => {
                            on_sigchld(libc::SIG_DFL);
                            let fd = theirs.as_raw_fd();
                            if unsafe { libc::dup2(fd, libc::STDIN_FILENO) } < 0
                                || unsafe { libc::dup2(fd, libc::STDOUT_FILENO) } < 0
                            {
                                exit_immediately(EXIT_SANDBOX_FAILED);
                            }
                            // Closes everything else: the channel, the sockets sent to the parent,
                            // both of this socketpair's original fds, and the wake pipe.
                            return;
                        }
                        -1 => {
                            let err = io::Error::last_os_error();
                            send(
                                &parent,
                                &Reply::SpawnFailed {
                                    id,
                                    error: format!("failed to fork: {err}"),
                                },
                            );
                        }
                        pid => {
                            drop(theirs);
                            let reply = Reply::Spawned { id, pid };
                            if parent.send_socket(&reply, ours.into(), id).is_err() {
                                exit_immediately(0);
                            }
                            workers.push(Worker { id, pid });
                        }
                    }
                }
            }
        }
    }
}

/// Exits if the parent is gone.
fn send(parent: &Parent, reply: &Reply) {
    if parent.send(reply).is_err() {
        exit_immediately(0);
    }
}

fn kill(workers: &[Worker], id: u64) {
    if let Some(worker) = workers.iter().find(|worker| worker.id == id) {
        unsafe { libc::kill(worker.pid, libc::SIGKILL) };
    }
}

/// Replies `exited` for every worker that exited.
fn reap(workers: &mut Vec<Worker>, parent: &Parent) {
    loop {
        let mut status = 0;
        let pid = unsafe { libc::waitpid(-1, &mut status, libc::WNOHANG) };
        if pid <= 0 {
            return;
        }
        if let Some(i) = workers.iter().position(|worker| worker.pid == pid) {
            let id = workers.swap_remove(i).id;
            send(
                parent,
                &if libc::WIFSIGNALED(status) {
                    Reply::Exited {
                        id,
                        code: None,
                        signal: Some(libc::WTERMSIG(status)),
                    }
                } else {
                    Reply::Exited {
                        id,
                        code: Some(libc::WEXITSTATUS(status)),
                        signal: None,
                    }
                },
            );
        }
    }
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
