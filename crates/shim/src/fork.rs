//! Forking workers from a fork server (unix only): a worker process started with `--fork-server`,
//! once per pool (and again if it exits). Forking skips `exec` and loading the binary, which is
//! most of the cost of starting a worker. The protocol is documented in
//! `crates/worker/src/fork_server.rs`.
//!
//! The server's thread waits for it to exit, so on Linux, `PR_SET_PDEATHSIG` kills the server
//! only when Node exits, and the server's workers with it. Otherwise, the server exits when its
//! socket closes: when the pool and all of its workers are gone.
//!
//! On Linux, the server sends a pidfd for each worker, so the watchdog kills workers directly,
//! even if the server is stuck. Replies from the server time out, so a stuck server can't block
//! a driver forever either.

use std::io::{self, PipeReader, PipeWriter, Read};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::ExitStatusExt;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::Duration;

use crate::pool::{Config, Failure, command, exit_failure, lock, spawn_failure};

const SPAWN: u8 = 0;
const KILL: u8 = 1;
const MESSAGE_LEN: usize = 9;

/// For the server to start, fork a worker, or report its exit status after it's been killed. It
/// only needs to start or fork a process that's already loaded, so this is generous.
const SERVER_TIMEOUT: Duration = Duration::from_secs(10);

/// Starts a server when it's first needed, and replaces it if it exits.
#[derive(Default)]
pub struct ForkServer {
    server: Mutex<Option<Arc<Server>>>,
}

impl ForkServer {
    pub fn spawn(&self, config: &Config) -> Result<(Child, PipeWriter, PipeReader), Failure> {
        let mut server = lock(&self.server);
        // Retries once, in case the server exited since the last spawn.
        for _ in 0..2 {
            let current = match &*server {
                Some(current) if !current.exited.load(Ordering::SeqCst) => current.clone(),
                _ => server.insert(Server::start(config)?).clone(),
            };
            match current.fork() {
                Ok(child) => return Ok(child),
                Err(Some(failure)) => return Err(failure),
                Err(None) => current.exited.store(true, Ordering::SeqCst),
            }
        }
        Err(Failure::new("ERR_WORKER_SPAWN", "the fork server exited"))
    }
}

/// A running fork server.
struct Server {
    control: Mutex<UnixStream>,
    next_id: AtomicU64,
    exited: Arc<AtomicBool>,
}

impl Server {
    fn start(config: &Config) -> Result<Arc<Self>, Failure> {
        let failed = |err: io::Error| {
            Failure::new(
                "ERR_WORKER_SPAWN",
                format!("failed to start the fork server: {err}"),
            )
        };
        let (mut control, theirs) = UnixStream::pair().map_err(failed)?;
        let mut command = command(config);
        command
            .arg("--fork-server")
            .stdin(Stdio::from(OwnedFd::from(theirs)))
            .stdout(Stdio::null());
        let path = config.worker_path.clone();
        let exited = Arc::new(AtomicBool::new(false));
        let thread_exited = exited.clone();
        let (sender, started) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("blunt-fork-server".into())
            .spawn(move || {
                let mut child = match command.spawn() {
                    Ok(child) => child,
                    Err(err) => return drop(sender.send(Err(spawn_failure(&path, err)))),
                };
                // Closes the server's end of the socket in this process.
                drop(command);
                match handshake(&mut control) {
                    Ok(()) => drop(sender.send(Ok(control))),
                    Err(err) => {
                        // If it already exited, this keeps its exit status.
                        let _ = child.kill();
                        let failure = match (err.kind(), child.wait()) {
                            (io::ErrorKind::UnexpectedEof, Ok(status)) => exit_failure(status),
                            (io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut, _) => {
                                Failure::new(
                                    "ERR_WORKER_SPAWN",
                                    format!("the fork server didn't start in {SERVER_TIMEOUT:?}"),
                                )
                            }
                            _ => Failure::new(
                                "ERR_WORKER_SPAWN",
                                format!("the fork server didn't start: {err}"),
                            ),
                        };
                        return drop(sender.send(Err(failure)));
                    }
                }
                let _ = child.wait();
                thread_exited.store(true, Ordering::SeqCst);
            })
            .map_err(failed)?;
        let control = started.recv().unwrap_or_else(|_| {
            Err(Failure::new(
                "ERR_WORKER_SPAWN",
                "the fork server didn't start",
            ))
        })?;
        Ok(Arc::new(Server {
            control: Mutex::new(control),
            next_id: AtomicU64::new(0),
            exited,
        }))
    }

    /// Fails with `None` if the server exited (or is stuck).
    fn fork(self: &Arc<Self>) -> Result<(Child, PipeWriter, PipeReader), Option<Failure>> {
        let failed = |err: io::Error| {
            Some(Failure::new(
                "ERR_WORKER_SPAWN",
                format!("failed to create a pipe: {err}"),
            ))
        };
        let (stdin_reader, stdin) = io::pipe().map_err(failed)?;
        let (stdout, stdout_writer) = io::pipe().map_err(failed)?;
        let (status, theirs) = UnixStream::pair().map_err(failed)?;
        status
            .set_read_timeout(Some(SERVER_TIMEOUT))
            .map_err(failed)?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let fds = [stdin_reader.as_fd(), stdout_writer.as_fd(), theirs.as_fd()];
        self.send(SPAWN, id, &fds).map_err(|_| None)?;
        // Otherwise, we'd never see the worker's stdout or the status socket close.
        drop((stdin_reader, stdout_writer, theirs));
        let mut pid = [0; 4];
        let Ok(fds) = blunt_scm::receive(status.as_fd(), &mut pid) else {
            self.abandon();
            return Err(None);
        };
        let pid = i32::from_le_bytes(pid);
        if pid <= 0 {
            let err = io::Error::from_raw_os_error(pid.wrapping_neg());
            let message = format!("failed to fork a worker: {err}");
            return Err(Some(Failure::new("ERR_WORKER_SPAWN", message)));
        }
        let child = Child {
            server: self.clone(),
            id,
            #[cfg(target_os = "linux")]
            pidfd: fds.into_iter().next(),
            status: Mutex::new(Status::Running(status)),
        };
        #[cfg(not(target_os = "linux"))]
        drop(fds);
        Ok((child, stdin, stdout))
    }

    fn send(&self, op: u8, id: u64, fds: &[BorrowedFd]) -> io::Result<()> {
        let mut message = [0; MESSAGE_LEN];
        message[0] = op;
        message[1..].copy_from_slice(&id.to_le_bytes());
        let control = lock(&self.control);
        let result = blunt_scm::send(control.as_fd(), &message, fds);
        drop(control);
        if result.is_err() {
            // A partial message would desynchronize the stream.
            self.abandon();
        }
        result
    }

    /// Makes the server exit (if it isn't stuck), and the pool start another.
    fn abandon(&self) {
        self.exited.store(true, Ordering::SeqCst);
        let _ = lock(&self.control).shutdown(std::net::Shutdown::Both);
    }
}

/// Waits for the server's first byte, which it sends once it starts.
fn handshake(control: &mut UnixStream) -> io::Result<()> {
    control.set_read_timeout(Some(SERVER_TIMEOUT))?;
    let mut byte = [0];
    control.read_exact(&mut byte)?;
    control.set_read_timeout(None)
}

fn read_i32(reader: &mut impl Read) -> io::Result<i32> {
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(i32::from_le_bytes(bytes))
}

/// A worker forked by the server.
pub struct Child {
    server: Arc<Server>,
    id: u64,
    #[cfg(target_os = "linux")]
    pidfd: Option<OwnedFd>,
    status: Mutex<Status>,
}

enum Status {
    Running(UnixStream),
    Exited(ExitStatus),
    /// The server exited or got stuck before reporting it.
    Unknown(&'static str),
}

impl Child {
    /// Without a pidfd, this goes through the server. If the server exited, this does nothing,
    /// but on Linux, the worker exited with it.
    pub fn kill(&self) {
        // Like the server, a pidfd can't hit a reused pid.
        #[cfg(target_os = "linux")]
        if let Some(pidfd) = &self.pidfd
            && unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    pidfd.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            } == 0
        {
            return;
        }
        let _ = self.server.send(KILL, self.id, &[]);
    }

    /// Kills the worker if it's still running, and waits for the server to report its exit.
    pub fn wait(&self) -> io::Result<ExitStatus> {
        self.kill();
        let mut status = lock(&self.status);
        if let Status::Running(socket) = &mut *status {
            *status = match read_i32(socket) {
                Ok(raw) => Status::Exited(ExitStatus::from_raw(raw)),
                Err(err)
                    if matches!(
                        err.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    self.server.abandon();
                    Status::Unknown("the fork server didn't report the exit status")
                }
                Err(_) => Status::Unknown("the fork server exited"),
            };
        }
        match *status {
            Status::Exited(exited) => Ok(exited),
            Status::Unknown(message) => Err(io::Error::other(message)),
            // Not reachable: it was just replaced.
            Status::Running(_) => Err(io::Error::other("the fork server exited")),
        }
    }
}
