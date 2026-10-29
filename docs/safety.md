# Safety model

Web applications frequently optimize images uploaded by users or fetched from external URLs. Because image formats are complex, malformed or maliciously crafted files can trigger bugs in decoders, allocate excessive memory, or hang a server.

`@next/safe-image-optimization` uses multiple layers of defense so that handling untrusted images cannot crash or compromise the main Node.js process.

## Memory-safe decoders

Most image-parsing vulnerabilities occur while decoding untrusted input. Every supported input format is decoded with memory-safe Rust libraries from the [image-rs](https://github.com/image-rs) ecosystem:

- **JPEG, PNG, WebP, GIF, and TIFF:** decoded via the `image` crate (`zune-jpeg`, `png`, `image-webp`, `gif`, and `tiff`).
- **AVIF:** decoded via `avif-decode` (`avif-parse` and `rav1d`, built with assembly disabled).
- **SVG:** rendered via `resvg`. External files and network URLs are never loaded; `<image>` elements only accept inline `data:` URLs.

C libraries (`libwebp` for lossy WebP and `mozjpeg` when `mozjpeg: true` is enabled) are only used for encoding, where the input is already validated pixel data produced by this library.

## Process isolation

Image processing never runs on the main Node.js thread or in the main process's memory space. Instead, a pool of workers processes one image at a time:

- **Native backend (default):** each worker is a separate OS process communicating with Node.js over pipes.
- **WebAssembly backend:** each worker is a Node.js worker thread running an isolated WebAssembly instance (see [WebAssembly backend](wasm.md)).

If a worker panics, aborts, or runs out of memory while handling an image, only that worker exits. The pool rejects that image's promise with `ERR_WORKER_CRASHED` or `ERR_OUT_OF_MEMORY` and starts a new worker for subsequent images.

Input buffers are copied before processing begins so JavaScript code cannot modify the input while a worker is reading it, and every response from a worker is validated before being returned to the caller. Because workers are reused sequentially across requests, a compromised worker could affect later images handled by that same worker.

## OS sandboxing

On Linux (`x64`, `arm64`, and `riscv64`), each worker installs a [`seccomp` system call filter](https://en.wikipedia.org/wiki/Seccomp) before processing any images. Once active, the worker cannot access the filesystem, open network sockets, or spawn new processes.

If a Linux worker fails to install its `seccomp` filter on a supported platform, it exits immediately and requests fail with `ERR_WORKER_SPAWN` unless `NEXT_SAFE_IMAGE_OPTIMIZATION_DANGEROUSLY_IGNORE_SECCOMP_FAILURES=1` is set.

Linux and WebAssembly enforce platform-level memory limits. On Linux, this is accomplished using [`RLIMIT_DATA`].

[`RLIMIT_DATA`]: https://sourceware.org/glibc/manual/2.44/html_node/Limits-on-Resources.html#index-struct-rlimit64

### Worker fork server

On Linux and macOS, each pool starts a lightweight helper process (the fork server) that forks new workers instead of spawning each worker binary from scratch. The helper process never touches image data and only receives spawn and termination commands from the Node.js process.

Forking makes starting replacement workers much faster, with one trade-off: forked workers inherit the helper process's memory layout (ASLR) rather than getting a randomized layout on every spawn. If you prefer each worker to be spawned independently with a fresh memory layout, pass `forkServer: false` when creating a `Pool`.

## Memory and CPU limits

Resource limits prevent a single image from exhausting server memory or CPU time:

- **Input dimensions (`limitInputPixels`, default ~268 megapixels):** Rejects images whose `width * height` exceeds the limit before decoding pixels. For SVGs, this applies to both the declared SVG dimensions and the rendered output dimensions. However, raster images embedded inside an SVG (`<image href="data:...">`) are decoded during SVG rendering and are only bounded by the memory and timeout limits below.
- **Per-image memory (`limitAllocatorMemoryBytes`, default 512 MiB):** Caps the total memory a worker's Rust allocator may use for a single image, including the input buffer and intermediate resize buffers. Exceeding this limit stops the worker and rejects with `ERR_LIMIT_EXCEEDED`. Before calling the C encoders (`libwebp` and `mozjpeg`), the worker also checks their estimated working memory against this limit.
- **Per-worker memory (`limitProcessMemoryBytes`, default 768 MiB):** A hard limit on each worker's total memory, covering both Rust allocations and the C encoders. This is enforced by the OS on Linux ([`RLIMIT_DATA`]) and by the WebAssembly runtime on all platforms when using the `wasm` backend. It is not currently enforced for native workers on macOS or Windows.
- **Output size (`limitOutputBytes`, default 128 MiB):** Caps the size of the encoded image and the maximum response size the main process will buffer from a worker.
- **Processing time (`timeoutMs()`):** Limits how long a worker may spend on one image (starting when a worker picks up the request). If the timer expires, the worker is forcibly terminated and the request fails with `ERR_TIMEOUT`. There is no default timeout, so you should always set `timeoutMs()` when processing untrusted input.
