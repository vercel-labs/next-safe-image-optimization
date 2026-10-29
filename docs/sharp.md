# Differences from sharp

`@next/safe-image-optimization` has a chainable API inspired by [sharp](https://sharp.pixelplumbing.com/) to make switching straightforward, but the two libraries have different goals:

- **sharp** (built on libvips) is a fast, general-purpose image processing library with a broad feature set and wide format support.
- **`@next/safe-image-optimization`** is built specifically for Next.js's image optimizer (`next/image`). It supports only the operations Next.js needs and runs them in isolated workers using memory-safe Rust decoders.

Because of these different goals, `@next/safe-image-optimization` is not a drop-in replacement for sharp.

## API and pipeline

- **Pools instead of a default function:** Pipelines are created with `defaultPool().prepare(input, options)` or `pool.prepare(input, options)` instead of calling `sharp(input, options)`.
- **In-memory input only:** Input must be a `Buffer`, `Uint8Array`, `ArrayBuffer`, or `ArrayBufferView`. File paths and streams are not supported.
- **Strict option validation:** Unsupported or unknown options (such as `fit`, `progressive`, or `sequentialRead`) are rejected with a `TypeError` instead of being ignored. Most options are validated in the worker when `toBuffer()` or `metadata()` is called, so invalid options reject the returned promise rather than throwing synchronously.
- **Timeouts:** Set timeouts in milliseconds with `timeoutMs(ms)` instead of sharp's `timeout({ seconds })`.
- **Errors:** Processing failures reject with a `SafeImageOptimizationError` that has a stable `code` property (such as `ERR_UNSUPPORTED_FORMAT`, `ERR_LIMIT_EXCEEDED`, or `ERR_TIMEOUT`).
- **`limitInputPixels`:** Applies to `metadata()` and to the target render size of SVGs, in addition to raster decoding. Like sharp, it does not apply to raster images embedded inside an SVG.
- **Removing limits:** `0` removes any limit or timeout, like sharp's `limitInputPixels: 0` and `timeout({ seconds: 0 })`. `limitInputPixels` doesn't accept sharp's `false` (no limit) or `true` (the default).

## Operations

- **Resizing:** `resize()` always behaves like sharp's default `fit: 'cover'` with centered cropping (`position: 'centre'`). Other `fit` modes, crop positions, and background colors are not supported. Supported resampling `kernel` values are `nearest`, `linear`, `cubic`, and `lanczos3`. Because resizing uses Rust's `image` crate rather than libvips, output pixels differ slightly and resizing is slower.
- **Rotation:** `rotate(angle)` only supports multiples of 90°. Calling `rotate()` with no arguments (or `autoOrient()`) rotates the image according to its EXIF orientation.
- **Other operations:** Operations that Next.js does not use—such as `extract`, `flip`, `flop`, `blur`, `sharpen`, `composite`, `flatten`, and `trim`—are not included.

## Formats

- **Unsupported formats:** HEIF input is not supported. AVIF, HEIF, and TIFF output are not supported.
- **Animated images:** Only the first frame of animated GIF, WebP, APNG, and AVIF images is decoded, and animated output is not supported. Passing `allowAnimated: false` rejects animated inputs with `ERR_ANIMATED` before decoding.
- **AVIF input:** Grid (tiled) AVIFs and AVIF image sequences are rejected. Orientation (`irot`, `imir`) and cropping (`clap`) properties in the AVIF container are ignored.
- **SVG input:** SVGs are rendered with `resvg` instead of `librsvg`. Text elements are not rendered (no fonts are bundled; Next.js Open Graph images convert text to paths with Satori), `<image>` elements only load `data:` URLs, and compressed `.svgz` files are not supported.
- **TIFF input:** YCbCr TIFFs (which includes most JPEG-compressed TIFFs) are not supported.
- **JPEG output:** Encodes baseline JPEGs with the pure-Rust `jpeg-encoder` crate by default, which produces somewhat larger files than sharp. Passing `mozjpeg: true` uses mozjpeg with the same preset as sharp (including progressive encoding), though it is compiled without assembly optimizations and is slower than in sharp. Individual options like `progressive`, `chromaSubsampling` (always 4:2:0), `optimiseCoding` (always enabled), and `quantisationTable` are not configurable.
- **PNG output:** Always produces lossless truecolor PNGs. Palette quantization (`palette` / `quality`) is not supported, and `adaptiveFiltering` defaults to `true` (sharp defaults to `false`).

## Colors, metadata, and platforms

- **Metadata:** All metadata (such as EXIF, XMP, and IPTC) is stripped from output images. `metadata()` returns a smaller set of fields: `format`, `width`, `height`, `hasAlpha`, `orientation`, `hasProfile`, and `autoOrient`.
- **Colors:** Output is always untagged 8-bit sRGB, and sharp's color configuration methods (`keepIccProfile()`, `withIccProfile()`, `withMetadata()`, `toColourspace()`, `pipelineColourspace()`, `gamma()`, `keepGainMap()`, `withGainMap()`) are not supported. See [Color handling](colors.md) for details on ICC profiles, bit depth, CICP, CMYK, and HDR, including a comparison with sharp's default color behavior.
- **Platforms:** See [Platform support](platforms.md) for supported operating systems and CPU architectures compared to sharp.
