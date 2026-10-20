//! The worker process. The shim (`crates/shim`) spawns it with the arguments `<version> <parent
//! pid> <memory limit in bytes, or 0>`, an empty environment, and pipes for stdin and stdout.
//!
//! Requests arrive on stdin as `[u64 LE length][request]`, and responses are written to stdout
//! (see `blunt_core::protocol`). The worker handles one request at a time. It exits as soon as
//! stdin closes, even mid-request, so that it doesn't outlive the parent.

use std::ffi::OsStr;
use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::thread;

use blunt_core::exit_immediately;
use blunt_core::protocol::{self, EXIT_INVALID_FRAME, EXIT_SANDBOX_FAILED, EXIT_VERSION_MISMATCH};

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

    #[cfg(target_os = "linux")]
    if memory_limit > 0 && limit_process_memory(memory_limit).is_err() {
        exit_immediately(EXIT_SANDBOX_FAILED);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = memory_limit;

    #[cfg(target_os = "linux")]
    sandbox::exit_with_parent(parent);
    #[cfg(not(target_os = "linux"))]
    let _ = parent;

    let mut output = take_stdout();
    let (sender, requests) = mpsc::sync_channel(0);
    let (started, start) = mpsc::channel();
    thread::spawn(move || {
        let _ = started.send(());
        read_requests(sender)
    });
    // The sandbox would block the thread's own setup (like glibc registering `rseq`).
    let _ = start.recv();

    #[cfg(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))]
    if sandbox::enable().is_err() {
        exit_immediately(EXIT_SANDBOX_FAILED);
    }
    #[cfg(not(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    )))]
    let _ = EXIT_SANDBOX_FAILED;

    for request in requests {
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

/// Reads requests on a separate thread, so that the worker notices when stdin closes (because
/// the parent exited or killed the worker) even while it's busy.
fn read_requests(sender: mpsc::SyncSender<Vec<u8>>) -> ! {
    let mut stdin = io::stdin().lock();
    loop {
        let mut len = [0; 8];
        if stdin.read_exact(&mut len).is_err() {
            exit_immediately(0);
        }
        let Ok(len) = usize::try_from(u64::from_le_bytes(len)) else {
            exit_immediately(EXIT_INVALID_FRAME);
        };
        let mut request = Vec::with_capacity(len);
        match (&mut stdin).take(len as u64).read_to_end(&mut request) {
            Ok(read) if read == len => {}
            _ => exit_immediately(0),
        }
        if sender.send(request).is_err() {
            exit_immediately(0);
        }
    }
}

/// Sets the hard (and soft) `RLIMIT_DATA`. Unlike the allocator's limit, this also covers libwebp
/// (C), but it can't distinguish going over the limit from any other allocation failure.
///
/// Linux counts private writable mappings (so all of `malloc`'s memory, but not code or address
/// space that's only reserved). Not on macOS, which counts all reserved address space (hundreds of
/// GiB at startup on arm64), and rejects any smaller limit with `EINVAL`.
#[cfg(target_os = "linux")]
fn limit_process_memory(bytes: u64) -> Result<(), ()> {
    let limit = libc::rlimit {
        rlim_cur: bytes as libc::rlim_t,
        rlim_max: bytes as libc::rlim_t,
    };
    if unsafe { libc::setrlimit(libc::RLIMIT_DATA, &limit) } != 0 {
        return Err(());
    }
    Ok(())
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

#[cfg(target_os = "linux")]
mod sandbox {
    /// Asks the kernel to kill us when the parent exits. Strictly, this fires when the parent
    /// *thread* that spawned us exits, but the shim spawns each worker from a thread that lives
    /// at least as long as the worker.
    pub fn exit_with_parent(parent: Option<u32>) {
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) };
        // In case the parent exited before `prctl`.
        if parent.is_some_and(|pid| unsafe { libc::getppid() } as u32 != pid) {
            blunt_core::exit_immediately(0);
        }
    }

    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    pub use self::seccomp::enable;

    #[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
    mod seccomp {
        use libc::{
            BPF_ABS, BPF_JEQ, BPF_JMP, BPF_K, BPF_LD, BPF_RET, BPF_W, EPERM, SECCOMP_RET_ALLOW,
            SECCOMP_RET_ERRNO, SECCOMP_RET_KILL_PROCESS, c_long, sock_filter, sock_fprog,
        };

        #[cfg(target_arch = "x86_64")]
        const AUDIT_ARCH: u32 = 0xC000_003E;
        #[cfg(target_arch = "aarch64")]
        const AUDIT_ARCH: u32 = 0xC000_00B7;

        /// Everything the worker needs after startup: reading requests and writing responses
        /// (and rav1d's logging, to stderr), memory management, threads synchronizing, and
        /// aborting. Anything else (opening files, sockets, spawning processes, etc.) fails with
        /// `EPERM`.
        const ALLOWED: &[c_long] = &[
            libc::SYS_read,
            libc::SYS_write,
            libc::SYS_brk,
            libc::SYS_mmap,
            libc::SYS_munmap,
            libc::SYS_mremap,
            libc::SYS_mprotect,
            libc::SYS_madvise,
            libc::SYS_futex,
            libc::SYS_sched_yield,
            libc::SYS_getrandom,
            libc::SYS_clock_gettime,
            libc::SYS_restart_syscall,
            libc::SYS_rt_sigreturn,
            libc::SYS_rt_sigprocmask,
            libc::SYS_rt_sigaction,
            libc::SYS_sigaltstack,
            libc::SYS_getpid,
            libc::SYS_gettid,
            libc::SYS_tgkill,
            libc::SYS_exit,
            libc::SYS_exit_group,
        ];

        fn statement(code: u32, k: u32) -> sock_filter {
            sock_filter {
                code: code as u16,
                jt: 0,
                jf: 0,
                k,
            }
        }

        fn jump_if_equal(k: u32, jt: u8, jf: u8) -> sock_filter {
            sock_filter {
                code: (BPF_JMP | BPF_JEQ | BPF_K) as u16,
                jt,
                jf,
                k,
            }
        }

        /// Installs the filter on every thread (`SECCOMP_FILTER_FLAG_TSYNC`), including the
        /// stdin reader.
        pub fn enable() -> Result<(), ()> {
            // Offsets into `struct seccomp_data`.
            const NR: u32 = 0;
            const ARCH: u32 = 4;

            let mut filter = vec![
                statement(BPF_LD | BPF_W | BPF_ABS, ARCH),
                jump_if_equal(AUDIT_ARCH, 1, 0),
                statement(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
                statement(BPF_LD | BPF_W | BPF_ABS, NR),
            ];
            for &nr in ALLOWED {
                filter.push(jump_if_equal(nr as u32, 0, 1));
                filter.push(statement(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
            }
            filter.push(statement(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM as u32));
            let program = sock_fprog {
                len: filter.len() as u16,
                filter: filter.as_mut_ptr(),
            };

            // Required to install a filter without `CAP_SYS_ADMIN`.
            if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
                return Err(());
            }
            let result = unsafe {
                libc::syscall(
                    libc::SYS_seccomp,
                    libc::SECCOMP_SET_MODE_FILTER,
                    libc::SECCOMP_FILTER_FLAG_TSYNC,
                    &program,
                )
            };
            if result != 0 { Err(()) } else { Ok(()) }
        }
    }
}
