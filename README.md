# blunt-image-optimization

A safer image optimization library for Node.js, intended to replace [sharp](https://sharp.pixelplumbing.com/) in Next.js's image optimizer. The API is loosely based on sharp's, so it's easy to switch, but much smaller. It isn't a drop-in replacement: sharp compatibility is a rough guideline, not a rule, and the API differs where that makes it clearer (like `timeoutMs(ms)` instead of `timeout({ seconds })`).

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

- **Input:** JPEG, PNG, WebP, GIF, TIFF, AVIF, SVG. Only the first frame of animations is decoded. AVIF ICC profiles, orientation (`irot`/`imir`), and cropping (`clap`) are ignored, and grid (tiled) AVIFs and AVIF sequences are rejected.
- `allowedInputFormats` restricts the input formats (detected from the contents, never a file extension or content type), and `allowAnimated: false` rejects animated images with `ERR_ANIMATED`. Both are checked before decoding, and also apply to `metadata()`.
- **Output:** JPEG, PNG, WebP, GIF. Metadata is stripped, and ICC profiles are converted to sRGB (like sharp).
- **Operations:** auto-orient, rotate (multiples of 90°), resize (sharp's default `fit: 'cover'`, centered).
- `metadata()` reads the header without decoding pixels.
- `timeoutMs(ms)`, like sharp's `timeout({ seconds })`, which kills the worker if processing takes too long. There's no default timeout, but you should set one for untrusted input.
- Errors are `BluntError`s with a stable `code`.
- TypeScript types are included.

## Safety model

| Layer | Status |
| --- | --- |
| Memory-safe decoders | `zune-jpeg`, `png`, `image-webp`, `gif`, and `tiff` (all via `image`), `avif-decode` (`avif-parse` and `rav1d`, without asm), and `resvg` (SVG, which only loads embedded `data:` URLs, never files). |
| Memory limits | `limitInputPixels` (default 268402689, like sharp). For SVGs, it applies to the natural and rendered sizes, but **not to raster images embedded in the SVG**, which are only bounded by the memory limits and `timeoutMs()`. `limitAllocatorMemoryBytes` (default 512 MiB) bounds what each image may allocate: the worker's allocator tracks every Rust allocation, and the worker exits with `ERR_LIMIT_EXCEEDED` if they exceed it. The limit is also passed to decoders as their allocation budget, and the C encoders' (libwebp and mozjpeg) estimated memory is checked against it up front. The pool's `limitProcessMemoryBytes` (default 768 MiB) is a hard, OS-enforced limit per worker (`RLIMIT_DATA` on Linux, the memory's maximum size for wasm) that also covers the C encoders, which the allocator can't see. It has no effect on macOS (whose `RLIMIT_DATA` counts reserved address space, so it rejects any useful limit) or Windows yet. `limitOutputBytes` (default 128 MiB) bounds the encoded image, and so how much the pool will buffer from a worker. |
| CPU limits | `timeoutMs()` bounds the wall time of each image, by killing its worker. There's no default, so set one for untrusted input: decoders aren't configured to bound their own work (a small file can be slow to decode). Blur cost is bounded regardless of sigma. |
| Process isolation | Images are processed in worker processes, never in the Node process. A panic, abort, or allocation failure only ends the worker, and is reported as an error (`ERR_WORKER_CRASHED` or `ERR_OUT_OF_MEMORY`). This covers rav1d, which calls its DSP routines and picture allocator through `extern "C"` function pointers, where panics can't unwind. Workers get an empty environment, and on Linux (x86_64 and aarch64) a seccomp filter blocks every syscall besides reading and writing already-open file descriptors (their pipes and stderr), memory management, and exiting: no opening files or sockets, and no spawning processes. Workers are reused, one image at a time, so a compromised worker could affect later images. On Linux and macOS, workers are forked from a fork server (one per pool) to start faster, so they share its address space layout (ASLR) instead of each getting their own. An attacker who finds a memory-safety bug can learn the layout by crashing workers repeatedly, because each replacement has the same layout, so ASLR is weaker against brute force than with spawned workers. The fork server itself isn't sandboxed by seccomp: it never sees image data, and only takes commands from the Node process. Forked workers talk to the Node process over a Unix socket that it listens on (in the abstract namespace on Linux, or else in a private temporary directory), and each identifies itself with a random one-time token, so other processes that connect are ignored. The input is copied before processing, so JS can't mutate it mid-decode. |
| Encoders | They only see pixels we produced. Lossy WebP uses libwebp (C), because `image-webp` only encodes lossless. JPEG uses `jpeg-encoder`, or mozjpeg (C) with `mozjpeg: true`. |
| wasm | The `wasm32-wasip1` build runs in worker threads. Its only imports are a few stubbed-out WASI functions (no filesystem, environment, or JS access), and the build fails if it imports anything else. Each instance's memory has a configurable maximum. |

See [AGENTS.md](AGENTS.md) for per-decoder details.

## Differences from sharp

- Only in-memory input (never file paths). Exports `blunt()` instead of a default export.
- Unsupported options (like `fit` or `progressive`) are rejected with a `TypeError`, instead of being ignored. Most options are validated by the worker, so `toBuffer()` or `metadata()` rejects with it, instead of the method throwing. `sequentialRead` is accepted, but ignored.
- `rotate(angle)` only supports multiples of 90. There is no `blur`, `flip`, `extract`, `composite`, etc.
- `resize()` is always like sharp's default `fit: 'cover'` with `position: 'centre'`: there's no `fit`, `position`, or `background`. `kernel` supports `nearest`, `linear`, `cubic`, and `lanczos3` (the filters that `image` implements), and resampling isn't sharp's, so pixels differ slightly. Resizing is slower than sharp's, and its intermediate buffer (16 bytes per pixel, for the input width times the output height) counts against `limitAllocatorMemoryBytes`.
- No HEIF input. No AVIF, HEIF, or animated output.
- SVGs are rendered with resvg, not librsvg. Text isn't rendered (there are no fonts), `<image>` only loads `data:` URLs, and SVGZ isn't supported. That covers Next.js's OG images, whose text Satori has already converted to paths.
- No YCbCr TIFF input, which includes most JPEG-compressed TIFFs.
- PNG output is always lossless truecolor: `png({ quality })` is accepted but ignored (no palette quantization), and `adaptiveFiltering` defaults to `true`.
- JPEG uses `jpeg-encoder` by default, not mozjpeg, so files are somewhat larger than sharp's. `mozjpeg: true` uses mozjpeg, like sharp, but built without its SIMD assembly, so it's slower than sharp's. `progressive`, `chromaSubsampling` (always 4:2:0), `optimiseCoding` (always on), and `quantisationTable` aren't supported. JPEGs may be progressive: they always are with `mozjpeg: true` (its defaults, like sharp's preset), and never are without it.
- CMYK JPEGs are converted to RGB naively, ignoring their ICC profile.
- `limitInputPixels` also applies to `metadata()`, and to the size an SVG is rendered at. It doesn't apply to raster images embedded in an SVG (neither does sharp's).

## Development

Requires Rust (version pinned in `rust-toolchain.toml`), Node.js 24, and pnpm (via corepack).

```sh
pnpm install
pnpm build          # or `pnpm build:release` for release
pnpm test           # e2e tests (fixtures are generated with sharp, never committed)
cargo test          # unit tests
pnpm lint

# After changing request options in crates/core (needs `cargo install typeshare-cli --version 1.13.4 --locked`)
pnpm generate

# wasm (needs https://github.com/WebAssembly/wasi-sdk to compile libwebp and mozjpeg)
rustup target add wasm32-wasip1
WASI_SDK_PATH=/path/to/wasi-sdk pnpm build:wasm
# Use build:wasm:release for release builds.
pnpm test:wasm
```

## Pools

Images are processed by a pool of workers, one image per worker at a time. Workers start on demand, exit when idle, and are replaced if they crash or time out. By default, pipelines share a pool with up to `os.availableParallelism()` workers. To configure one:

```js
const { blunt, Pool } = require('blunt-image-optimization')

const pool = new Pool({ concurrency: 4, idleTimeoutMs: 30_000 })
const output = await blunt(input, { pool }).timeoutMs(10_000).webp().toBuffer()
```

The native backend uses worker processes. Without a native worker binary for the platform, or with `backend: 'wasm'` (or `BLUNT_IMAGE_OPTIMIZATION_BACKEND=wasm`), workers are threads running a wasm build. `limitProcessMemoryBytes` limits each worker's memory.

## Future work

- wasm2c-sandboxed decoders for formats without a trustworthy Rust implementation (HEIF).
- Sandboxing on macOS and Windows, and killing workers via a Job Object when the parent dies on Windows.
- AVIF output, PNG palette quantization, and ICC-aware CMYK conversion.
- Animated output: with `allowAnimated: true` (the default), transforming every frame of an animated image when the output format supports animation (e.g. GIF or WebP), instead of only the first frame.
