//! The parts of the worker (`main.rs`) that its integration tests use.

#[cfg(target_os = "linux")]
pub mod linux_sandbox;
