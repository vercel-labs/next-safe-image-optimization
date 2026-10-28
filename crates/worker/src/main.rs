//! The worker process. The JS wrapper (`js/native.ts`) spawns it with the arguments `<version>
//! <parent pid> <memory limit in bytes, or 0>`, an empty environment, and pipes for stdin and
//! stdout. On unix, it instead spawns it once as a fork server (`--fork-server`), which forks
//! workers with the same setup, except that stdin and stdout are a Unix socket (see
//! `fork_server.rs`).
//!
//! Requests arrive on stdin as `[u64 LE length][request]`, and responses are written to stdout
//! (see `blunt_core::protocol`). The worker handles one request at a time. It exits when stdin
//! closes, and when the parent exits, even mid-request (see `requests`), so that it doesn't outlive
//! the parent.

use std::ffi::OsStr;
use std::io::{self, Read, Write};
#[cfg(not(target_os = "linux"))]
use std::sync::mpsc;
#[cfg(not(target_os = "linux"))]
use std::thread;

use blunt_core::exit_immediately;
use blunt_core::protocol::{self, EXIT_INVALID_FRAME, EXIT_SANDBOX_FAILED, EXIT_VERSION_MISMATCH};
#[cfg(target_os = "linux")]
use blunt_worker::linux_sandbox;

#[cfg(unix)]
mod fork_server;
#[cfg(unix)]
mod node_ipc;

#[global_allocator]
static GLOBAL: blunt_core::ExitOnOom = blunt_core::ExitOnOom;

fn main() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new(env!("CARGO_PKG_VERSION"))) {
        exit_immediately(EXIT_VERSION_MISMATCH);
    }
    let mut number = || {
        args.next()
            .and_then(|arg| arg.to_str()?.parse::<u64>().ok())
    };
    let parent = number().and_then(|pid| u32::try_from(pid).ok());
    let memory_limit = number().unwrap_or(0);
    let fork_server = args.next().is_some_and(|arg| arg == "--fork-server");

    // Forked workers inherit the limit.
    #[cfg(target_os = "linux")]
    if memory_limit > 0 && linux_sandbox::limit_process_memory(memory_limit).is_err() {
        exit_immediately(EXIT_SANDBOX_FAILED);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = memory_limit;

    #[cfg(target_os = "linux")]
    linux_sandbox::exit_with_parent(parent);
    #[cfg(not(target_os = "linux"))]
    let _ = parent;

    // Before forking, so that forked workers share the compiled filter.
    #[cfg(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))]
    let filters =
        linux_sandbox::compile_filters().unwrap_or_else(|_| exit_immediately(EXIT_SANDBOX_FAILED));

    #[cfg(unix)]
    if fork_server {
        let server = std::process::id();
        fork_server::serve();
        // Now in a forked worker, which doesn't inherit `PR_SET_PDEATHSIG`.
        #[cfg(target_os = "linux")]
        linux_sandbox::exit_with_parent(Some(server));
        #[cfg(not(target_os = "linux"))]
        let _ = server;
    }
    #[cfg(not(unix))]
    let _ = fork_server;

    let mut output = take_stdout();

    #[cfg(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))]
    if linux_sandbox::enable(&filters).is_err() {
        exit_immediately(EXIT_SANDBOX_FAILED);
    }
    #[cfg(not(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    )))]
    let _ = EXIT_SANDBOX_FAILED;

    for request in requests() {
        let response = protocol::handle(request);
        let written = output
            .write_all(&response.head)
            .and_then(|()| output.write_all(&response.data))
            .and_then(|()| output.flush());
        if written.is_err() {
            // The parent is gone.
            exit_immediately(0);
        }
    }
}

/// On Linux, the main thread reads each request after handling the last one, without another
/// thread. It doesn't need to notice stdin closing mid-request: `PR_SET_PDEATHSIG` kills the worker
/// if its parent (Node or the fork server) exits, and otherwise, the parent kills it directly.
#[cfg(target_os = "linux")]
fn requests() -> impl Iterator<Item = Vec<u8>> {
    let mut stdin = io::stdin().lock();
    std::iter::repeat_with(move || read_request(&mut stdin))
}

/// Elsewhere, a separate thread reads requests, so that the worker exits as soon as stdin closes,
/// even while it's busy. That's the only way it can notice that its parent exited (and on macOS,
/// the only way to end a forked worker after its fork server exits).
#[cfg(not(target_os = "linux"))]
fn requests() -> impl Iterator<Item = Vec<u8>> {
    let (sender, requests) = mpsc::sync_channel(0);
    thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        loop {
            if sender.send(read_request(&mut stdin)).is_err() {
                exit_immediately(0);
            }
        }
    });
    requests.into_iter()
}

/// Exits if stdin closes.
fn read_request(stdin: &mut impl Read) -> Vec<u8> {
    let mut len = [0; 8];
    if stdin.read_exact(&mut len).is_err() {
        exit_immediately(0);
    }
    let Ok(len) = usize::try_from(u64::from_le_bytes(len)) else {
        exit_immediately(EXIT_INVALID_FRAME);
    };
    let mut request = Vec::with_capacity(len);
    match stdin.take(len as u64).read_to_end(&mut request) {
        Ok(read) if read == len => request,
        _ => exit_immediately(0),
    }
}

/// Moves stdout to a private file descriptor and points fd 1 at stderr, so that nothing else
/// (like a stray `println!` in a dependency) can corrupt responses.
#[cfg(unix)]
fn take_stdout() -> std::fs::File {
    use std::os::fd::FromRawFd;

    let fd = unsafe { libc::dup(libc::STDOUT_FILENO) };
    if fd < 0 || unsafe { libc::dup2(libc::STDERR_FILENO, libc::STDOUT_FILENO) } < 0 {
        exit_immediately(EXIT_SANDBOX_FAILED);
    }
    // SAFETY: `fd` is a new file descriptor that nothing else owns.
    unsafe { std::fs::File::from_raw_fd(fd) }
}

#[cfg(not(unix))]
fn take_stdout() -> io::Stdout {
    io::stdout()
}

#[cfg(test)]
mod tests {
    /// `js/native.ts` passes `package.json`'s version, which has to match.
    #[test]
    fn version_matches_package_json() {
        let package = include_str!("../../../package.json");
        let version = format!(r#""version": "{}""#, env!("CARGO_PKG_VERSION"));
        assert!(
            package.contains(&version),
            "package.json doesn't have {version}"
        );
    }
}
