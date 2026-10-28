//! Checks the seccomp filters in a child process (this test, run again with `SANDBOXED` set), which
//! `abort` kills. It runs without the test harness, so the child doesn't run any other tests, and
//! only has the threads it starts itself.

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
fn main() {
    use std::os::unix::process::ExitStatusExt;
    use std::process::{Command, Stdio};

    const SANDBOXED: &str = "BLUNT_TEST_SANDBOXED";
    if std::env::var_os(SANDBOXED).is_some() {
        sandboxed();
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .env(SANDBOXED, "1")
        .stderr(Stdio::inherit())
        .output()
        .unwrap();
    // Printed right before aborting, so a failed assertion can't pass (if it aborts instead of
    // unwinding).
    assert_eq!(String::from_utf8_lossy(&output.stdout), "checked\n");
    assert_eq!(
        output.status.signal(),
        Some(libc::SIGSYS),
        "the child exited with {}",
        output.status
    );
}

#[cfg(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]
fn sandboxed() -> ! {
    use std::fs::File;
    use std::sync::mpsc;
    use std::thread;

    use blunt_worker::linux_sandbox::{compile_filters, enable};

    let open = || File::open("/").map(drop).map_err(|err| err.raw_os_error());
    // Started before the filters, like the worker's stdin reader, so it only gets them through
    // `TSYNC`.
    let (go, wait) = mpsc::channel();
    let thread = thread::spawn(move || {
        wait.recv().unwrap();
        open()
    });

    assert_eq!(open(), Ok(()));
    enable(&compile_filters().unwrap()).unwrap();
    assert_eq!(open(), Err(Some(libc::EPERM)));
    go.send(()).unwrap();
    assert_eq!(thread.join().unwrap(), Err(Some(libc::EPERM)));

    println!("checked");
    std::process::abort();
}

#[cfg(not(all(
    target_os = "linux",
    any(target_arch = "x86_64", target_arch = "aarch64")
)))]
fn main() {}
