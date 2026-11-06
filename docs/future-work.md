# Future work

Possible future improvements:

- **Additional formats and encoding features:**
  - AVIF output encoding
  - PNG palette quantization for smaller files
  - Sandboxed decoders (compiled to C with `wasm2c`) for formats without good permissively-licensed Rust alternatives such as HEIF
- **Performance:** Decoding a JPEG at a reduced DCT scale when the result is about to be shrunk (libvips's shrink-on-load, which `Bun.Image` also does), which is most of sharp's advantage when generating a thumbnail from a large JPEG — see [`packages/bench`](../packages/bench/README.md).
- **Animated output:** A new `animated()` mode (alongside `'first-frame'` and `'reject'`) that transforms every frame of an animated image when the output format supports animation (such as GIF or WebP), rather than only decoding the first frame.
