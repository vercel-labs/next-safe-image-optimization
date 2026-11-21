//! Runs one request through `protocol::handle`, for counting its instructions under Valgrind
//! (`packages/bench/instructions.ts`). Usage: `instructions < request`, where stdin is a request
//! in the worker's format (`[input][options JSON][u32 LE length of the JSON]`), like the worker's
//! own stdin, but without the length frame: it reads one request, to the end.
//!
//! It's an example, rather than a crate, so that CI can copy this one file into a checkout of the
//! base branch and build it there without touching `Cargo.lock`. So it only uses `nsio-core`'s
//! public API and the standard library.
//!
//! It prints the response's JSON, so the caller can check that the request succeeded. Reading the
//! request, and starting the process, are included in the count, but they're the same for every
//! version of the worker.

use std::io::{Read, Write};

#[global_allocator]
static GLOBAL: nsio_core::ExitOnOom = nsio_core::ExitOnOom;

fn main() {
    let mut request = Vec::new();
    std::io::stdin()
        .lock()
        .read_to_end(&mut request)
        .expect("failed to read the request from stdin");
    let frame = nsio_core::protocol::handle(request, || {});
    // `[u64 LE length][u32 LE length of the JSON][JSON]`.
    let json_len = u32::from_le_bytes(frame.head[8..12].try_into().unwrap()) as usize;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&frame.head[12..][..json_len]).unwrap();
    writeln!(stdout).unwrap();
}
