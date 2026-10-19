//! Decoding, processing, and encoding. This runs in a worker process (or a wasm instance), never in
//! the Node process itself. See `crates/worker` and `crates/wasm`.

#![deny(clippy::all)]

mod alloc;
mod color;
mod decode;
mod encode;
mod error;
mod limits;
mod ops;
mod orientation;
mod pipeline;
pub mod protocol;
mod request;

pub use crate::alloc::{ExitOnOom, exit_immediately, set_memory_limit};
