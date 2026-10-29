# WebAssembly backend

Alongside native worker processes, `@next/safe-image-optimization` ships a WebAssembly (`wasm32-wasip1`) build of the same image processing pipeline.

## When it is used

By default, a `Pool` uses native worker processes when a native binary is available for the current platform, and automatically falls back to the WebAssembly backend otherwise.

You can also choose the WebAssembly backend explicitly:

- **Per pool:** `new Pool({ backend: 'wasm' })`
- **With an environment variable:** `NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND=wasm`

To require the native backend and throw an error if no native binary is available, pass `backend: 'native'`.

## How it works

The WebAssembly backend runs a pool of Node.js `worker_threads`. Each worker thread hosts its own WebAssembly instance and handles one image at a time:

- **Sandboxing:** The WebAssembly module has no access to the filesystem, network, environment variables, or arbitrary JavaScript code. Its imports are limited to a small set of stubbed WASI functions and are verified against an allowlist at build time.
- **Memory limits:** Each WebAssembly instance's memory is capped by the pool's `limitProcessMemoryBytes` option (default 768 MiB), in addition to the per-image `limitAllocatorMemoryBytes` limit (default 512 MiB). Unlike the native backend, this hard limit works on macOS and Windows as well as Linux.
- **Crash and timeout recovery:** If an image exceeds a memory limit, triggers a WebAssembly trap (such as a Rust panic), or exceeds `timeoutMs()`, the worker thread is terminated and replaced before the next request.

Compared to native worker processes, the WebAssembly backend runs anywhere Node.js runs without needing a platform-specific binary, but image processing is slower and runs in threads within the Node.js process rather than separate OS processes (`forkServer` is ignored).

## Building and testing from source

Building the WebAssembly module requires the `wasm32-wasip1` Rust target and [wasi-sdk](https://github.com/WebAssembly/wasi-sdk) (used to compile the `libwebp` and `mozjpeg` C encoders):

```sh
rustup target add wasm32-wasip1
WASI_SDK_PATH=/path/to/wasi-sdk pnpm build:wasm
# Or for an optimized release build:
WASI_SDK_PATH=/path/to/wasi-sdk pnpm build:wasm:release

pnpm test:wasm
```
