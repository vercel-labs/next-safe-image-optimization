# WebAssembly backend

Alongside native worker processes, `@next/safe-image-optimization` has a WebAssembly (`wasm32-wasip1`) build of the same image processing pipeline. Install it alongside the main package:

```sh
npm install @next/safe-image-optimization @next/safe-image-optimization-wasm32
```

## When it is used

By default, a `Pool` uses native worker processes when a native binary is available for the current platform, and otherwise falls back to the WebAssembly backend, if `@next/safe-image-optimization-wasm32` is installed. If neither is available, creating a `Pool` throws an error.

To choose the WebAssembly backend explicitly, set the `NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND=wasm` environment variable. It's read when each `Pool` is created, and creating one throws an error if `@next/safe-image-optimization-wasm32` isn't installed. Likewise, `NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND=native` requires the native backend, and throws an error if no native binary is available. `pool.backend` reports which backend a pool uses.

## How it works

The WebAssembly backend runs a pool of Node.js `worker_threads`. Each worker thread hosts its own WebAssembly instance and handles one image at a time:

- **Sandboxing:** The WebAssembly module has no access to the filesystem, network, environment variables, or arbitrary JavaScript code. Its imports are limited to a small set of stubbed WASI functions and are verified against an allowlist at build time.
- **Memory limits:** Each WebAssembly instance's memory is capped by the pool's `limitProcessMemoryBytes` option (default 768 MiB), in addition to the per-image `limitAllocatorMemoryBytes` limit (default 512 MiB). Unlike the native backend, this hard limit works on macOS and Windows as well as Linux.
- **Crash and timeout recovery:** If an image exceeds a memory limit, triggers a WebAssembly trap (such as a Rust panic), or exceeds `timeoutMs()`, the worker thread is terminated and replaced before the next request.

Compared to native worker processes, the WebAssembly backend runs anywhere Node.js runs (with the same `@next/safe-image-optimization-wasm32` package on every platform), but image processing is slower and runs in threads within the Node.js process rather than separate OS processes (`forkServer` is ignored).

## Building and testing from source

Building the WebAssembly module requires the `wasm32-wasip1` Rust target and [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) (used to compile the `libwebp` and `mozjpeg` C encoders):

```sh
rustup target add wasm32-wasip1
WASI_SDK_PATH=/path/to/wasi-sdk pnpm build:wasm
# Or for an optimized release build:
WASI_SDK_PATH=/path/to/wasi-sdk pnpm build:wasm:release

# Builds the module first (or `pnpm test:wasm:release`).
WASI_SDK_PATH=/path/to/wasi-sdk pnpm test:wasm
```

The module is in `target/wasm32-wasip1/debug/nsio_wasm.wasm` (or `release`). To use it from another project, set `NEXT_SAFE_IMAGE_OPTIMIZATION_WASM_PATH` to its path.
