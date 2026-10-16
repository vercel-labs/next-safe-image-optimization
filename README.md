# blunt-image-optimization

A safer image optimization library for Node.js, intended to replace [sharp](https://sharp.pixelplumbing.com/) in Next.js's image optimizer. The API is similar to sharp's, but much smaller.

sharp (libvips) decodes untrusted images with C libraries. This library decodes with memory-safe Rust decoders from the [image-rs](https://github.com/image-rs) ecosystem, configured with explicit memory limits.

```js
const { blunt } = require('blunt-image-optimization')

const output = await blunt(input, { limitInputPixels: 268402689 })
  .rotate() // auto-orient using EXIF
  .resize(640, null, { withoutEnlargement: true })
  .webp({ quality: 75 })
  .toBuffer()
```

## Features

- **Input:** JPEG, PNG, WebP, GIF, TIFF. Only the first frame of animations is decoded.
- **Output:** JPEG, PNG, WebP, GIF. Metadata is stripped, and ICC profiles are converted to sRGB (like sharp).
- **Operations:** auto-orient, rotate (multiples of 90°), resize (all of sharp's `fit` modes, gravity, kernels), blur.
- `metadata()` reads the header without decoding pixels.
- Errors are `BluntError`s with a stable `code`.
- TypeScript types are included.

## Safety model

| Layer | Status |
| --- | --- |
| Memory-safe decoders | `zune-jpeg`, `png`, `image-webp`, `gif`, `tiff` (via `image`). |
| Memory limits | `limitInputPixels` (default 268402689, like sharp), and `limitMemory` (default 512 MiB), which bounds the estimated memory of each stage (decode, resize, blur, encode) and is passed to decoders as their allocation budget. Decoder metadata buffers (ICC, EXIF) have a separate, smaller cap. Frames must match (or fit inside) the declared canvas. |
| CPU limits | There are no timeouts, and processing can't be cancelled. Work is bounded by the pixel and memory limits, plus format-specific bounds: at most 32 progressive JPEG scans, and at most 4096 JPEG APP1 segments. JPEG-compressed TIFFs are rejected. Blur cost is bounded regardless of sigma. |
| Crash safety | Panics are caught and reported as `ERR_INTERNAL`. The input is copied before processing, so JS can't mutate it mid-decode. |
| Encoders | Not sandboxed: they only see pixels we produced. Lossy WebP uses libwebp (C), because `image-webp` only encodes lossless. |
| wasm | The `wasm32-wasip1-threads` build has no WASI filesystem or environment access. The build also fails if the module imports WASI functions outside an allowlist (which has no filesystem functions). This is defense in depth, not a sandbox: a compromised module can still reach JS globals through napi. |

See [AGENTS.md](AGENTS.md) for per-decoder details.

## Differences from sharp

- Only in-memory input (never file paths). Exports `blunt()` instead of a default export.
- `rotate(angle)` only supports multiples of 90. There is no `flip`, `extract`, `composite`, etc.
- No AVIF or HEIF, SVG, or animated output.
- PNG output is always lossless truecolor: `png({ quality })` is accepted but ignored (no palette quantization), and `adaptiveFiltering` defaults to `true`.
- JPEG uses `jpeg-encoder`, not mozjpeg. `mozjpeg: true` approximates mozjpeg's settings, but without trellis quantization, so files are somewhat larger.
- `blur(sigma)` uses a Gaussian kernel for σ < 3, and a three-pass box blur above that.
- CMYK JPEGs are converted to RGB naively, ignoring their ICC profile.
- No `timeout()`.
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
rustup target add wasm32-wasip1-threads
WASI_SDK_PATH=/path/to/wasi-sdk pnpm build:wasm
pnpm test:wasi
```

Processing runs on the libuv thread pool, so concurrency is bounded by `UV_THREADPOOL_SIZE` (default 4). That pool is shared with `fs` and `dns`.

## Future work

- wasm2c-sandboxed decoders for formats without a trustworthy Rust implementation (SVG, HEIF/AVIF).
- A per-thread allocation limit (via the global allocator) to bound decoder memory that isn't covered by decoder options, such as lossless WebP's Huffman tables.
- seccomp-based process isolation on Linux.
- AVIF output, PNG palette quantization, and ICC-aware CMYK conversion.
