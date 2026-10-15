#![deny(clippy::all)]
// Test builds don't register the napi exports, so everything reachable only from them looks unused.
#![cfg_attr(test, allow(dead_code))]

mod api;
mod color;
mod decode;
mod encode;
mod error;
mod interrupt;
mod limits;
mod ops;
mod orientation;
mod pipeline;

// mimalloc is C, so it isn't used on wasm (where the default allocator is dlmalloc).
#[cfg(not(target_family = "wasm"))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
