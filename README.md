# @next/safe-image-optimization

[![Open on npmx.dev](https://npmx.dev/api/registry/badge/version/@next/safe-image-optimization)](https://npmx.dev/package/@next/safe-image-optimization) [![MIT Licensed](https://npmx.dev/api/registry/badge/license/@next/safe-image-optimization)](https://npmx.dev/package/@next/safe-image-optimization)

A Node.js library built for [Next.js]'s image optimizer ([`next/image`]) with a small feature set, small binary size, and a focus on security.

Untrusted images are processed using memory-safe decoders, process-level isolation, and Linux [seccomp] sandboxing.

This library does not currently have a stable API. Features may be removed to reduce binary size.

[Next.js]: https://nextjs.org/
[`next/image`]: https://nextjs.org/docs/app/getting-started/images
[seccomp]: https://en.wikipedia.org/wiki/Seccomp

## Usage

```js
const { defaultPool } = require('@next/safe-image-optimization')

const output = await defaultPool()
  .prepare(input)
  .allowInputFormats(['jpeg', 'png', 'webp', 'avif']) // 'svg' is disabled by default
  .limitInputPixels(268402689)
  .timeoutMs(10_000)
  .autoOrient() // using EXIF metadata
  .resize(640, null, { withoutEnlargement: true })
  .webp({ quality: 75 }) // also supports `.jpeg()`, `.png()`, and `.gif()`
  .toBuffer({ signal: request.signal }) // abort if the client disconnects
```

You can read a file's format and dimensions without decoding the full image:

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

## Supported formats

- **Input formats:** JPEG, PNG, WebP, GIF, TIFF, AVIF, and SVG (disabled by default).
- **Output formats:** JPEG, PNG, WebP, and GIF. Output is always 8-bit sRGB with metadata stripped.

Images must be passed into `.prepare()` as an in-memory `Buffer`, `ArrayBufferView`, `ArrayBuffer`, or `SharedArrayBuffer`.

## Image operations

Operations always run in the same order regardless of call order: `.autoOrient()`, then `.rotate()`, then `.resize()`.

### `.autoOrient()`

Rotates and flips the image using its EXIF orientation metadata, which is then stripped from the output along with all other metadata.

### `.rotate(angle)`

Rotates the image clockwise by `angle` degrees, which must be a multiple of 90 (negative angles rotate counterclockwise, from `-3600` to `3600`). Calling `.rotate()` again replaces the previous angle.

Ignores EXIF orientation unless `.autoOrient()` is also called (which runs first).

### `.resize(width, height, [options])`

Resizes the image while preserving its aspect ratio. You can also pass a single options object (`.resize({ width, height, ... })`), or pass `null`/`undefined` for either dimension to compute it from the aspect ratio.

If both `width` and `height` are given, the image is scaled to cover the target dimensions and cropped from the center. This is equivalent to [sharp's default `fit: 'cover'` and `position: 'centre'`][sharp-resize].

- **`width`**: Target width in pixels (positive integer).
- **`height`**: Target height in pixels (positive integer).
- **`kernel`**: Resampling filter — `'nearest'`, `'linear'`, `'cubic'`, or `'lanczos3'` (default).
- **`withoutEnlargement`**: Do not enlarge the image if it is already smaller than the target dimensions. Default: `false`.
- **`withoutReduction`**: Do not shrink the image if it is already larger than the target dimensions. Default: `false`.

[sharp-resize]: https://sharp.pixelplumbing.com/api-resize/#resize

## Output format options

If no output format method is called, `.toBuffer()` encodes using the input format (or PNG for SVG inputs). TIFF and AVIF inputs require choosing an output format explicitly. Calling another format method replaces the previous format and its options.

Pass `.toBuffer({ resolveWithObject: true })` to receive `{ data, info }` (with `format`, `width`, `height`, and `channels`) instead of just a `Buffer`.

### `.jpeg([options])`

Encodes as JPEG using 4:2:0 chroma subsampling. Transparent pixels are composited onto black.

- **`quality`**: Compression quality, `1`–`100`. Default: `80`.
- **`mozjpeg`**: Encode with [mozjpeg] instead of the pure-Rust [`jpeg-encoder`]. Produces smaller files at the cost of slower encoding. Output is progressive when `true` and baseline when `false`. Default: `false`.

[mozjpeg]: https://github.com/mozilla/mozjpeg
[`jpeg-encoder`]: https://github.com/vstroebel/jpeg-encoder

### `.png([options])`

Encodes as lossless 8-bit truecolor PNG.

- **`compressionLevel`**: zlib compression level, `0`–`9`. Default: `6`.
- **`adaptiveFiltering`**: Use adaptive row filtering. Default: `true` (sharp defaults to `false`).

### `.webp([options])`

Encodes as WebP using [libwebp].

- **`quality`**: Compression quality, `1`–`100`. When `nearLossless` is enabled, also controls the near-lossless preprocessing level. Default: `80`.
- **`alphaQuality`**: Alpha channel compression quality, `0`–`100`. Default: `100`.
- **`lossless`**: Use lossless compression. Default: `false`.
- **`nearLossless`**: Use near-lossless compression. Default: `false`.
- **`smartSubsample`**: Use high-quality chroma subsampling (`use_sharp_yuv`) for lossy encoding. Default: `false`.
- **`effort`**: CPU effort, `0` (fastest) to `6` (slowest). Default: `4`.

[libwebp]: https://chromium.googlesource.com/webm/libwebp

### `.gif([options])`

Encodes as a single-frame GIF.

- **`effort`**: CPU effort for color quantization, `1` (fastest) to `10` (slowest). Default: `7`.

## Restrictions and limits

### `.allowInputFormats(formats)`

Restricts which file formats are accepted as an array of strings.

Valid formats are `'jpeg'`, `'png'`, `'webp'`, `'gif'`, `'tiff'`, `'avif'`, and `'svg'`. SVG is not enabled by default.

### `.animated(mode)`

Support for animated inputs (APNG, animated WebP, animated GIF, and AVIF sequences) is limited.

- **`'first-frame'`** (default): Decode only the first frame.
- **`'reject'`**: Reject animated inputs with `ERR_ANIMATED` before decoding any pixels.

### `.limitInputPixels(pixels)`

Rejects input images where `width * height` exceeds `pixels` with `ERR_LIMIT_EXCEEDED` before decoding.

For SVGs (disabled by default), this applies to both the natural and rendered dimensions, but **not** to embedded raster images (`<image href="data:...">`).

This limit acts as a sanity check, but should be used in combination with `.limitAllocatorMemoryBytes()`, the pool's `limitProcessMemoryBytes`, and `.timeoutMs()`, which provide much stronger guarantees against untrusted input.

Default: `268_402_689` (`0x3FFF * 0x3FFF`). `0` disables this limit (not recommended).

### `.limitAllocatorMemoryBytes(bytes)`

Applies a best-effort limit to the total memory (in bytes) a worker's memory allocator may use while processing a single image. Multiple images processed in parallel can exceed this limit.

Enforcement happens using a global Rust allocator shim. C/C++ dependencies (`libwebp` and `mozjpeg`) do not use this allocator shim, so estimated values are used instead.

On Linux or when using WASM, `limitProcessMemoryBytes` provides much stronger security guarantees.

Default: `512 * 1024 * 1024` (512 MiB). `0` disables this limit (not recommended).

### `.limitOutputBytes(bytes)`

Limits the encoded output image size in bytes. Does not apply to `.metadata()`, as that does not produce an output image.

Default: `128 * 1024 * 1024` (128 MiB). `0` disables this limit (not recommended).

### `.timeoutMs(ms)`

Limits the total wall time of processing in milliseconds, _after_ a worker process gets the image from the queue. If the timer expires, the worker is killed.

Default: `0` (no limit). Always set a timeout when handling untrusted images.

### `.decodeTimeoutMs(ms)`

A secondary wall-time limit in milliseconds for decoding the input. This should be used in combination with `.timeoutMs()`.

Decoding is often much faster than encoding, but time complexity bugs in a decoder are more likely to be exploitable than those in the encoder. For this reason, `decodeTimeoutMs` should be set to a much smaller value than `timeoutMs` (e.g. 50% or less).

When used with `.metadata()`, this applies to the entire request, and behaves the same as `.timeoutMs()`.

Default: `0` (no limit).

### Cancellation

`.toBuffer({ signal })` and `.metadata({ signal })` accept an `AbortSignal`.

When aborted, a queued request is removed from the queue or an in-progress worker is killed, and the promise rejects with `signal.reason`.

## Worker pools

Images are processed using a pool of processes (native) or threads (WASM only). `defaultPool()` returns a shared pool with default options. You can create a custom worker pool:

```js
const { Pool } = require('@next/safe-image-optimization')

// all of these settings are optional, the default settings are shown
const pool = new Pool({
  /**
   * How many processes (or wasm instances) can be used to process requests in parallel. Workers are
   * created lazily. Each worker processes a single image at a time.
   *
   * In future versions of this library, some codecs may use their own thread pools to process parts
   * of the same image in parallel, so this is not a hard cap on total parallelism or CPU usage.
   */
  maxWorkers: os.availableParallelism(),
  /**
   * How many times the same worker can be used before being killed and replaced.
   *
   * If there is a vulnerability in an image codec, a malicious input image could corrupt memory in
   * a worker, leaking information across requests. A limit of `1` ensures that memory is not shared
   * across requests. A value of `0` means workers can be reused indefinitely (not recommended).
   *
   * Increasing this limit can improve performance on platforms where spawning a new process is
   * expensive.
   */
  maxImagesPerWorker: process.platform === 'win32' ? 64 : 1,
  /**
   * How long to keep an idle worker alive after processing an image. This has no effect if
   * `maxImagesPerWorker` is 1. A value of 0 never cleans up idle processes.
   */
  idleTimeoutMs: 10_000, // 10 seconds
  /**
   * Uses a lightweight fork server process and the `fork()` call to create new workers on macOS
   * and Linux. This reduces the overhead of creating new processes compared to `posix_spawn()`.
   *
   * Forked workers share the same address space layout which can reduce the effectiveness of
   * [ASLR]. For added security, you can turn this feature off.
   *
   * This depends on unsupported parts of [Node.js `'ipc'` channel API][ipc]. Bun and Deno are
   * compatible with our implementation.
   *
   * Ignored on Windows and when using WASM.
   *
   * [ASLR]: https://en.wikipedia.org/wiki/Address_space_layout_randomization
   * [ipc]: https://nodejs.org/api/child_process.html#optionsstdio
   */
  forkServer: true,
  /**
   * The maximum memory usage of each worker in bytes, enforced by the OS or platform. This option
   * is only supported on Linux or when using WASM.
   *
   * This is a backstop for `limitAllocatorMemoryBytes()`, and should be set to a larger value. It
   * covers non-Rust image codecs (libwebp and mozjpeg).
   *
   * 0 means no limit (not recommended).
   *
   * - On Linux, this is enforced using [`RLIMIT_DATA`].
   * - On WASM, this is enforced by configuring the maximum number of pages when constructing
   *   [`WebAssembly.Memory`].
   *
   * [`RLIMIT_DATA`]: https://sourceware.org/glibc/manual/2.44/html_node/Limits-on-Resources.html#index-struct-rlimit64
   * [`WebAssembly.Memory`]: https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory
   */
  limitProcessMemoryBytes: 768 * 1024 * 1024, // 768 MiB
})

const output = await pool.prepare(input).timeoutMs(10_000).webp().toBuffer()
```

Idle workers don't keep the process alive, so pools don't need to be closed. To stop a pool's workers, `await pool.close()` finishes the images already submitted first, and `await pool.destroy()` stops them immediately.

You can use the [`await using` syntax] to close the pool at the end of a scope.

```js
async function encodeManyWithNewPool(inputImages) {
  await using pool = new Pool()
  return await Promise.all(
    inputImages.map((input) => pool.prepare(input).resize(640).webp().toBuffer()),
  )
  // pool is closed when it leaves the scope
}
```

[`await using` syntax]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/await_using

## Errors

Most processing errors are handled as `SafeImageOptimizationError` with a stable `code` property:

```js
const { SafeImageOptimizationError } = require('@next/safe-image-optimization')

try {
  await defaultPool().prepare(input).timeoutMs(5_000).webp().toBuffer()
} catch (err) {
  if (err instanceof SafeImageOptimizationError) {
    console.error(err.code, err.message)
  } else {
    throw err // e.g. a TypeError
  }
}
```

There are a couple of cases where `SafeImageOptimizationError` is not used:

- Argument validation errors throw or reject using a `TypeError` with `code: 'ERR_INVALID_OPTIONS'`. Most pipeline option validation rejects the promise asynchronously, while some wrapper-checked arguments throw synchronously.
- Aborting a request with `{ signal }` rejects with `signal.reason`.

### Error codes

- **`ERR_UNSUPPORTED_FORMAT`**: The input format is not in `.allowInputFormats()`, or the image uses format features that are unsupported (e.g. YCbCr or a tiled/grid AVIF).
- **`ERR_ANIMATED`**: The input image is animated and `.animated('reject')` was set.
- **`ERR_LIMIT_EXCEEDED`**: Processing exceeded `.limitInputPixels()`, `.limitAllocatorMemoryBytes()`, `.limitOutputBytes()`, or a format's maximum output dimensions.
- **`ERR_DECODE_FAILED`**: The input image is malformed or could not be decoded.
- **`ERR_ENCODE_FAILED`**: The output image could not be encoded.
- **`ERR_TIMEOUT`**: Processing exceeded `.timeoutMs()`, or decoding exceeded `.decodeTimeoutMs()`.
- **`ERR_OUT_OF_MEMORY`**: The worker ran out of memory, either because it exceeded the pool's `limitProcessMemoryBytes` or because the system ran out of memory. If the operating system's OOM killer terminates the worker process, you may see an `ERR_WORKER_CRASHED` instead.
- **`ERR_WORKER_CRASHED`**: The worker crashed unexpectedly or sent a malformed response.
- **`ERR_WORKER_SPAWN`**: A worker process or WebAssembly worker thread could not be started (for example, a missing binary, version mismatch, or Linux `seccomp` sandbox failure).
- **`ERR_BACKEND_UNAVAILABLE`**: Thrown by `new Pool()` (and `defaultPool()`) when there is no native worker binary for the current platform and `@next/safe-image-optimization-wasm32` is not installed (or its version doesn't match).
- **`ERR_POOL_CLOSED`**: The pool was closed with `.close()` before the request was submitted, or stopped with `.destroy()` while the request was queued or running.
- **`ERR_INTERNAL`**: An unexpected internal error (a bug in the library).
- **`ERR_INVALID_OPTIONS`**: Set on `TypeError` (not `SafeImageOptimizationError`) for invalid arguments, out-of-range values, or unknown option fields.

## Additional documentation

- **[Safety model](docs/safety.md)** — decoders, worker isolation, sandboxing, and resource limits
- **[Differences from sharp](docs/sharp.md)** — API, operation, and format differences
- **[Color handling](docs/colors.md)** — sRGB conversion, ICC profiles, bit depth, CMYK, and HDR
- **[Platform support](docs/platforms.md)** — supported operating systems, CPU architectures, and comparison with sharp
- **[WebAssembly backend](docs/wasm.md)** — using and building the WebAssembly worker backend
- **[Benchmark](packages/bench/README.md)** — throughput against sharp, `@napi-rs/image`, and `Bun.Image`, and how to run it
- **[Future work](docs/future-work.md)** — planned improvements

## Development

Requires Rust (version pinned in `rust-toolchain.toml`), Node.js 24, and pnpm (`npm install --global pnpm`).

```sh
pnpm install
pnpm build          # or `pnpm build:release` for release builds
pnpm test           # Rust unit tests and end-to-end tests (builds first)
pnpm test:release   # end-to-end tests with a release build
pnpm lint           # clippy and oxlint
pnpm quality        # clippy, rustfmt, oxlint, oxfmt, and TypeScript typechecking
pnpm quality:fix   # clippy's and oxlint's fixes, rustfmt, and oxfmt

# Regenerate TypeScript protocol types after changing request options in crates/core
# (requires `cargo install typeshare-cli --version 1.13.4 --locked`)
pnpm generate
```

See [docs/wasm.md](docs/wasm.md) for instructions on building and testing the WebAssembly backend.
