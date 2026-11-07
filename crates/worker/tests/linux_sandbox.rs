//! Checks the seccomp filters in a child process (this test, run again with `SANDBOXED` set to
//! whether to allow threads), which `abort` kills. It runs without the test harness, so the child
//! doesn't run any other tests, and is single-threaded, like the worker.

#[cfg(all(
    target_os = "linux",
    any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64"
    )
))]
const SANDBOXED: &str = "NSIO_TEST_SANDBOXED";

#[cfg(all(
    target_os = "linux",
    any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64"
    )
))]
fn main() {
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Command, Stdio};

    if let Some(threads) = std::env::var_os(SANDBOXED) {
        sandboxed(threads == "threads");
    }
    for threads in ["", "threads"] {
        let output = Command::new(std::env::current_exe().unwrap())
            .env(SANDBOXED, threads)
            .stderr(Stdio::inherit())
            .output()
            .unwrap();
        // Printed right before aborting, so a failed assertion can't pass (if it aborts instead of
        // unwinding).
        assert_eq!(String::from_utf8_lossy(&output.stdout), "checked\n");
        assert_eq!(
            output.status.signal(),
            Some(libc::SIGSYS),
            "the child ({threads:?}) exited with {}",
            output.status
        );
    }
}

#[cfg(all(
    target_os = "linux",
    any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64"
    )
))]
fn sandboxed(threads: bool) -> ! {
    use std::fs::File;
    use std::thread;

    use nsio_worker::linux_sandbox::{compile_filters, enable};

    let open = || File::open("/").map(drop).map_err(|err| err.raw_os_error());
    assert_eq!(open(), Ok(()));
    enable(&compile_filters(threads).unwrap()).unwrap();
    assert_eq!(open(), Err(Some(libc::EPERM)));

    let spawned = thread::Builder::new().spawn(open);
    if threads {
        // The thread is sandboxed too.
        assert_eq!(spawned.unwrap().join().unwrap(), Err(Some(libc::EPERM)));
    } else {
        assert!(spawned.is_err());
    }
    // Never a new process.
    assert_eq!(unsafe { libc::fork() }, -1);

    println!("checked");
    std::process::abort();
}

#[cfg(not(all(
    target_os = "linux",
    any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64"
    )
)))]
fn main() {}
