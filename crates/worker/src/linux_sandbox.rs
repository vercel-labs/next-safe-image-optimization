//! The worker's sandbox on Linux: a memory limit, exiting with the parent, and (on x86_64, aarch64,
//! and riscv64) seccomp filters.

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

#[cfg(any(
    target_arch = "x86_64",
    target_arch = "aarch64",
    target_arch = "riscv64"
))]
pub use self::seccomp::{Filters, compile_filters, enable};

#[cfg(any(
    target_arch = "x86_64",
    target_arch = "aarch64",
    target_arch = "riscv64"
))]
mod seccomp {
    use libc::{ENOSYS, EPERM, c_long};
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
        SeccompRule, TargetArch,
    };

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

    /// With `threads`, for libheif's codec plugins (libde265 always starts a thread, and deadlocks
    /// if it can't): what glibc's `pthread_create` and a new thread's setup use, besides `clone`
    /// (only with `CLONE_THREAD`, so not `fork`) and `clone3`. `clone3`'s flags are in memory, which
    /// seccomp can't read, so it fails with `ENOSYS` instead, and glibc falls back to `clone`.
    const THREADS: &[c_long] = &[libc::SYS_set_robust_list, libc::SYS_rseq];

    /// Two filters (three with threads), because seccompiler's have a single action for matched
    /// syscalls. The kernel takes the strictest action of all filters, so the `KILLED` filter wins
    /// over the allowlist's `EPERM`, and `clone3`'s `ENOSYS` wins over the allowlist allowing it.
    pub struct Filters {
        killed: BpfProgram,
        no_clone3: Option<BpfProgram>,
        allowed: BpfProgram,
    }

    pub fn compile_filters(threads: bool) -> Result<Filters, seccompiler::Error> {
        let arch = TargetArch::try_from(std::env::consts::ARCH)?;
        let filter = |rules: Vec<(c_long, Vec<SeccompRule>)>, other, matched| {
            SeccompFilter::new(rules.into_iter().collect(), other, matched, arch)
                .and_then(BpfProgram::try_from)
        };
        let any_args = |syscalls: &[c_long]| -> Vec<_> {
            syscalls.iter().map(|&nr| (nr, Vec::new())).collect()
        };
        let mut allowed = any_args(ALLOWED);
        let mut no_clone3 = None;
        if threads {
            allowed.extend(any_args(THREADS));
            allowed.extend(any_args(&[libc::SYS_clone3]));
            let thread = libc::CLONE_THREAD as u64;
            allowed.push((
                libc::SYS_clone,
                vec![SeccompRule::new(vec![SeccompCondition::new(
                    0,
                    SeccompCmpArgLen::Qword,
                    SeccompCmpOp::MaskedEq(thread),
                    thread,
                )?])?],
            ));
            no_clone3 = Some(filter(
                any_args(&[libc::SYS_clone3]),
                SeccompAction::Allow,
                SeccompAction::Errno(ENOSYS as u32),
            )?);
        }
        Ok(Filters {
            killed: filter(
                any_args(KILLED),
                SeccompAction::Allow,
                SeccompAction::KillProcess,
            )?,
            no_clone3,
            allowed: filter(
                allowed,
                SeccompAction::Errno(EPERM as u32),
                SeccompAction::Allow,
            )?,
        })
    }

    /// Installs the filters on every thread (`SECCOMP_FILTER_FLAG_TSYNC`). The worker is
    /// single-threaded, but a thread started before this would otherwise be unsandboxed (and
    /// threads started after it inherit the filters). Also sets `PR_SET_NO_NEW_PRIVS`, which
    /// installing a filter without `CAP_SYS_ADMIN` requires.
    pub fn enable(filters: &Filters) -> Result<(), seccompiler::Error> {
        // The allowlist blocks `prctl` and `seccomp`, so it goes last.
        seccompiler::apply_filter_all_threads(&filters.killed)?;
        if let Some(no_clone3) = &filters.no_clone3 {
            seccompiler::apply_filter_all_threads(no_clone3)?;
        }
        seccompiler::apply_filter_all_threads(&filters.allowed)
    }
}
