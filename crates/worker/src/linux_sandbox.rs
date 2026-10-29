//! The worker's sandbox on Linux: a memory limit, exiting with the parent, and (on x86_64 and
//! aarch64) seccomp filters.

use std::io;

/// Sets the hard (and soft) `RLIMIT_DATA`. Unlike the allocator's limit, this also covers libwebp
/// and mozjpeg (C), but it can't distinguish going over the limit from any other allocation failure.
///
/// Linux counts private writable mappings (so all of `malloc`'s memory, but not code or address
/// space that's only reserved). Not on macOS, which counts all reserved address space (hundreds of
/// GiB at startup on arm64), and rejects any smaller limit with `EINVAL`.
pub fn limit_process_memory(bytes: u64) -> io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: bytes as libc::rlim_t,
        rlim_max: bytes as libc::rlim_t,
    };
    if unsafe { libc::setrlimit(libc::RLIMIT_DATA, &limit) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Asks the kernel to kill us when the parent exits. Strictly, this fires when the parent *thread*
/// that spawned us exits: for Node, the JS thread that started the worker (or fork server), which
/// also owns its pipes. The fork server is single-threaded.
pub fn exit_with_parent(parent: Option<u32>) {
    unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) };
    // In case the parent exited before `prctl`.
    if parent.is_some_and(|pid| unsafe { libc::getppid() } as u32 != pid) {
        nsio_core::exit_immediately(0);
    }
}

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
pub use self::seccomp::{Filters, compile_filters, enable};

#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
mod seccomp {
    use libc::{EPERM, c_long};
    use seccompiler::{BpfProgram, SeccompAction, SeccompFilter, TargetArch};

    /// Everything the worker needs after startup: reading requests and writing responses (and
    /// rav1d's logging, to stderr), memory management, threads synchronizing, and exiting.
    /// Anything else (opening files, sockets, spawning processes, etc.) fails with `EPERM`, except
    /// for `KILLED`.
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
        libc::SYS_exit,
        libc::SYS_exit_group,
    ];

    /// Kill the whole process instead. `abort` raises `SIGABRT` with these (glibc's with
    /// `tgkill(getpid(), gettid(), SIGABRT)`, musl's with `tkill`), so it ends the worker with
    /// `SIGSYS` instead. The filter can't only allow signaling the worker itself: it's compiled
    /// before forking, so it can't contain the worker's pid. And signaling any other process owned
    /// by the same user (like Node or the fork server) only kills the worker.
    const KILLED: &[c_long] = &[libc::SYS_tgkill, libc::SYS_tkill];

    /// Two filters, because seccompiler's have a single action for matched syscalls. The kernel
    /// takes the strictest action of all filters, so the `KILLED` filter wins over the allowlist's
    /// `EPERM`.
    pub struct Filters {
        killed: BpfProgram,
        allowed: BpfProgram,
    }

    pub fn compile_filters() -> Result<Filters, seccompiler::Error> {
        let arch = TargetArch::try_from(std::env::consts::ARCH)?;
        let filter = |syscalls: &[c_long], other, matched| {
            SeccompFilter::new(
                syscalls.iter().map(|&nr| (nr, Vec::new())).collect(),
                other,
                matched,
                arch,
            )
            .and_then(BpfProgram::try_from)
        };
        Ok(Filters {
            killed: filter(KILLED, SeccompAction::Allow, SeccompAction::KillProcess)?,
            allowed: filter(
                ALLOWED,
                SeccompAction::Errno(EPERM as u32),
                SeccompAction::Allow,
            )?,
        })
    }

    /// Installs the filters on every thread (`SECCOMP_FILTER_FLAG_TSYNC`). The worker is
    /// single-threaded, but a thread started before this would otherwise be unsandboxed. Also sets
    /// `PR_SET_NO_NEW_PRIVS`, which installing a filter without `CAP_SYS_ADMIN` requires.
    pub fn enable(filters: &Filters) -> Result<(), seccompiler::Error> {
        // The allowlist blocks `prctl` and `seccomp`, so it goes last.
        seccompiler::apply_filter_all_threads(&filters.killed)?;
        seccompiler::apply_filter_all_threads(&filters.allowed)
    }
}
