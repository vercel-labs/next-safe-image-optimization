# blunt-image-optimization

A safer image optimization library for Node.js, intended to replace [sharp](https://sharp.pixelplumbing.com/) in Next.js's image optimizer. The API is similar to sharp's, but much smaller.

sharp (libvips) decodes untrusted images with C libraries. This library decodes with memory-safe Rust decoders from the [image-rs](https://github.com/image-rs) ecosystem, configured with explicit memory limits, in sandboxed worker processes.

```js
const { blunt } = require('blunt-image-optimization')

const output = await blunt(input, { limitInputPixels: 268402689 })
  .rotate() // auto-orient using EXIF
  .resize(640, null, { withoutEnlargement: true })
  .webp({ quality: 75 })
  .toBuffer()
```

## Features

- **Input:** JPEG, PNG, WebP, GIF, TIFF, AVIF. Only the first frame of animations is decoded. AVIF ICC profiles, orientation (`irot`/`imir`), and cropping (`clap`) are ignored, and grid (tiled) AVIFs and AVIF sequences are rejected.
- **Output:** JPEG, PNG, WebP, GIF. Metadata is stripped, and ICC profiles are converted to sRGB (like sharp).
- **Operations:** auto-orient, rotate (multiples of 90°), resize (all of sharp's `fit` modes, gravity, kernels), blur.
- `metadata()` reads the header without decoding pixels.
- `timeout({ seconds })`, like sharp's, which kills the worker if processing takes too long. There's no default timeout, but you should set one for untrusted input.
- Errors are `BluntError`s with a stable `code`.
- TypeScript types are included.

## Safety model

| Layer | Status |
| --- | --- |
| Memory-safe decoders | `zune-jpeg`, `png`, `image-webp`, `gif`, and `tiff` (all via `image`), and `avif-decode` (`avif-parse` and `rav1d`, without asm). |
| Memory limits | `limitInputPixels` (default 268402689, like sharp). `limitAllocatorMemory` (default 512 MiB) bounds what each image may allocate: the worker's allocator tracks every Rust allocation, and the worker exits with `ERR_LIMIT_EXCEEDED` if they exceed it. The limit is also passed to decoders as their allocation budget, and libwebp's estimated memory is checked against it up front. The pool's `limitProcessMemory` (default 768 MiB) is a hard, OS-enforced limit per worker (`RLIMIT_DATA` on Linux, the memory's maximum size for wasm) that also covers libwebp, which the allocator can't see. It has no effect on macOS (whose `RLIMIT_DATA` counts reserved address space, so it rejects any useful limit) or Windows yet. |
| CPU limits | `timeout()` bounds the wall time of each image, by killing its worker. There's no default, so set one for untrusted input: decoders aren't configured to bound their own work (a small file can be slow to decode). Blur cost is bounded regardless of sigma. |
| Process isolation | Images are processed in worker processes, never in the Node process. A panic, abort, or allocation failure only ends the worker, and is reported as an error (`ERR_WORKER_CRASHED` or `ERR_OUT_OF_MEMORY`). This covers rav1d, which calls its DSP routines and picture allocator through `extern "C"` function pointers, where panics can't unwind. Workers get an empty environment, and on Linux (x86_64 and aarch64) a seccomp filter blocks every syscall besides reading and writing already-open file descriptors (their pipes and stderr), memory management, and exiting: no opening files or sockets, and no spawning processes. Workers are reused, one image at a time, so a compromised worker could affect later images. The input is copied before processing, so JS can't mutate it mid-decode. |
| Encoders | They only see pixels we produced. Lossy WebP uses libwebp (C), because `image-webp` only encodes lossless. |
| wasm | The `wasm32-wasip1` build runs in worker threads. Its only imports are a few stubbed-out WASI functions (no filesystem, environment, or JS access), and the build fails if it imports anything else. Each instance's memory has a configurable maximum. |

See [AGENTS.md](AGENTS.md) for per-decoder details.

## Differences from sharp

- Only in-memory input (never file paths). Exports `blunt()` instead of a default export.
- `rotate(angle)` only supports multiples of 90. There is no `flip`, `extract`, `composite`, etc.
- No HEIF or SVG input. No AVIF, HEIF, or animated output.
- No YCbCr TIFF input, which includes most JPEG-compressed TIFFs.
- PNG output is always lossless truecolor: `png({ quality })` is accepted but ignored (no palette quantization), and `adaptiveFiltering` defaults to `true`.
- JPEG uses `jpeg-encoder`, not mozjpeg. `mozjpeg: true` approximates mozjpeg's settings, but without trellis quantization, so files are somewhat larger.
- `blur(sigma)` uses a Gaussian kernel for σ < 3, and a three-pass box blur above that.
- CMYK JPEGs are converted to RGB naively, ignoring their ICC profile.
- `limitInputPixels` also applies to `metadata()`.

## Development

Requires Rust (version pinned in `rust-toolchain.toml`), Node.js 24, and pnpm (via corepack).

```sh
pnpm install
pnpm build:debug    # or `pnpm build` for release
pnpm test           # e2e tests (fixtures are generated with sharp, never committed)
cargo test          # unit tests
pnpm lint

# wasm (needs https://github.com/WebAssembly/wasi-sdk to compile libwebp)
rustup target add wasm32-wasip1
WASI_SDK_PATH=/path/to/wasi-sdk pnpm build:wasm
pnpm test:wasm
```

## Pools

Images are processed by a pool of workers, one image per worker at a time. Workers start on demand, exit when idle, and are replaced if they crash or time out. By default, pipelines share a pool with up to `os.availableParallelism()` workers. To configure one:

```js
const { blunt, Pool } = require('blunt-image-optimization')

const pool = new Pool({ concurrency: 4, idleTimeout: 30_000 })
const output = await blunt(input, { pool }).timeout({ seconds: 10 }).webp().toBuffer()
```

The native backend uses worker processes. Without a native binding for the platform, or with `backend: 'wasm'` (or `BLUNT_IMAGE_OPTIMIZATION_BACKEND=wasm`), workers are threads running a wasm build. `limitProcessMemory` limits each worker's memory.

## Future work

- wasm2c-sandboxed decoders for formats without a trustworthy Rust implementation (SVG, HEIF).
- Sandboxing on macOS and Windows, and killing workers via a Job Object when the parent dies on Windows.
- AVIF output, PNG palette quantization, and ICC-aware CMYK conversion.
