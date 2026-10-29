# Future work

Possible future improvements:

- **Additional formats and encoding features:**
  - AVIF output encoding
  - PNG palette quantization for smaller files
  - Sandboxed decoders (compiled to C with `wasm2c`) for formats without good permissively-licensed Rust alternatives such as HEIF
- **Animated output:** When `allowAnimated: true` (the default), transforming every frame of an animated image when the output format supports animation (such as GIF or WebP), rather than only decoding the first frame.
