# @next/safe-image-optimization

An image optimization library for Node.js, built for Next.js's image optimizer (`next/image`).

## Usage

```js
const { defaultPool } = require('@next/safe-image-optimization')

const output = await defaultPool()
  .prepare(input, {
    allowedInputFormats: ['jpeg', 'png', 'webp', 'avif'],
    limitInputPixels: 268402689,
  })
  .rotate() // auto-orient using EXIF metadata
  .resize(640, null, { withoutEnlargement: true })
  .timeoutMs(10_000)
  .webp({ quality: 75 })
  .toBuffer()
```

To read an image's format and dimensions without decoding its pixels:

```js
const meta = await defaultPool().prepare(input).timeoutMs(5_000).metadata()
// {
//   format: 'jpeg',
//   width: 1920,
//   height: 1080,
//   hasAlpha: false,
//   orientation: 1,
//   hasProfile: true,
//   autoOrient: { width: 1920, height: 1080 },
// }
```

### Supported formats and operations

- **Input formats:** JPEG, PNG, WebP, GIF, TIFF, AVIF, and SVG (in-memory `Buffer` or `Uint8Array` only).
- **Output formats:** JPEG (`.jpeg()`), PNG (`.png()`), WebP (`.webp()`), and GIF (`.gif()`). Output is always 8-bit sRGB with metadata stripped.
- **Operations:**
  - `.autoOrient()` or `.rotate()`: orient using EXIF metadata, or rotate by a multiple of 90°.
  - `.resize(width, height, options)`: resize while preserving aspect ratio (cropping from the center when both width and height are given), with `withoutEnlargement`, `withoutReduction`, and `kernel` options.
- **Input restrictions and limits:**
  - `allowedInputFormats` restricts which formats are accepted (detected from the file contents).
  - `allowAnimated: false` rejects animated images with `ERR_ANIMATED` before decoding; otherwise, only the first frame is decoded.
  - `limitInputPixels`, `limitAllocatorMemoryBytes`, and `limitOutputBytes` bound image dimensions, memory use, and output size.
  - `.timeoutMs(ms)` cancels processing if an image takes too long. There is no default timeout, so you should set one when handling untrusted images.
- **Errors:** Processing errors throw a `SafeImageOptimizationError` with a stable `code` property (such as `ERR_UNSUPPORTED_FORMAT`, `ERR_LIMIT_EXCEEDED`, or `ERR_TIMEOUT`). Invalid options throw a `TypeError`.

### Worker pools

Images are processed in a pool of background workers, one image per worker at a time. Workers start on demand, and by default, each one is replaced after processing a single image (except on Windows; see `maxImagesPerWorker`). Workers are also replaced if they crash or time out, and exit when idle.

`defaultPool()` returns a shared pool sized to `os.availableParallelism()`. You can also create a pool with custom settings:

```js
const { Pool } = require('@next/safe-image-optimization')

const pool = new Pool({
  concurrency: 4,
  idleTimeoutMs: 30_000,
})

const output = await pool.prepare(input).timeoutMs(10_000).webp().toBuffer()
```

## Purpose

[sharp](https://sharp.pixelplumbing.com/) (built on libvips) is a fast, general-purpose image processing library with a broad set of features. `@next/safe-image-optimization` has a similar chainable API so it is familiar to use, but it is built around different goals:

- **Focused scope:** It implements only the small set of operations needed for Next.js's [image optimizer](https://nextjs.org/docs/app/getting-started/images) and [ImageResponse](https://nextjs.org/docs/app/api-reference/functions/image-response).
- **Designed for untrusted input:** Web servers often optimize images uploaded by users or fetched from remote URLs. This library decodes images using memory-safe Rust libraries inside separate, sandboxed worker processes (or WebAssembly worker threads) with per-image memory and time limits. If an image triggers a bug, exceeds its memory budget, or times out, only that worker stops—the main Node.js process continues running unaffected.

Because of these goals, `@next/safe-image-optimization` has a much smaller feature set than sharp and trades some performance for isolation.

While this library is designed to protect against untrusted input, it may still have vulnerabilities. You should only fetch remote images from trusted sources or your own object storage. Use Next.js's [`images.remotePatterns` configuration](https://nextjs.org/docs/app/getting-started/images#remote-images) to restrict allowed image sources.

### Documentation

- **[Safety model](docs/safety.md)** — decoders, worker isolation, sandboxing, and resource limits
- **[Differences from sharp](docs/sharp.md)** — API, operation, and format differences
- **[Color handling](docs/colors.md)** — sRGB conversion, ICC profiles, bit depth, CMYK, and HDR
- **[Platform support](docs/platforms.md)** — supported operating systems, CPU architectures, and comparison with sharp
- **[WebAssembly backend](docs/wasm.md)** — using and building the WebAssembly worker backend
- **[Future work](docs/future-work.md)** — planned improvements

## Development

Requires Rust (version pinned in `rust-toolchain.toml`), Node.js 24, and pnpm (`npm install --global pnpm`).

```sh
pnpm install
pnpm build          # or `pnpm build:release` for release builds
pnpm test           # end-to-end tests
cargo test          # Rust unit tests
pnpm lint           # clippy, rustfmt, and TypeScript typechecking

# Regenerate TypeScript protocol types after changing request options in crates/core
# (requires `cargo install typeshare-cli --version 1.13.4 --locked`)
pnpm generate
```

See [docs/wasm.md](docs/wasm.md) for instructions on building and testing the WebAssembly backend.
