//! Runs one request through `protocol::handle`, for counting its instructions under Valgrind
//! (`packages/bench/instructions.ts`). Usage: `instructions <request file>`, where the file is a
//! request in the worker's format (`[input][options JSON][u32 LE length of the JSON]`).
//!
//! It's an example, rather than a crate, so that CI can copy this one file into a checkout of the
//! base branch and build it there without touching `Cargo.lock`. So it only uses `nsio-core`'s
//! public API and the standard library.
//!
//! It prints the response's JSON, so the caller can check that the request succeeded. Reading the
//! file, and starting the process, are included in the count, but they're the same for every
//! version of the worker.

use std::io::Write;

#[global_allocator]
static GLOBAL: nsio_core::ExitOnOom = nsio_core::ExitOnOom;

fn main() {
    let path = std::env::args_os()
        .nth(1)
        .expect("usage: instructions <request file>");
    let request = std::fs::read(path).expect("failed to read the request");
    let frame = nsio_core::protocol::handle(request, || {});
    // `[u64 LE length][u32 LE length of the JSON][JSON]`.
    let json_len = u32::from_le_bytes(frame.head[8..12].try_into().unwrap()) as usize;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&frame.head[12..][..json_len]).unwrap();
    writeln!(stdout).unwrap();
}
