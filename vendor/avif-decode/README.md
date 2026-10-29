# Pure Rust AVIF decoder and AVIF to PNG converter

> [!NOTE]
> This is a vendored fork of [kornelski/avif-decode](https://github.com/kornelski/avif-decode), used by @next/safe-image-optimization. It's a squashed git subtree of upstream commit `2be10e2`. Changes from upstream:
>
> - rav1d's asm is disabled on all targets (only the `bitdepth_8` and `bitdepth_16` features), so that decoding is entirely Rust.
> - rav1d is a git dependency on an unreleased revision, for its Rust API (`rav1d::Decoder`) instead of the `dav1d_*` C API, which avoids `unsafe` FFI calls.
> - `Options` sets the thread count. `Decoder::from_reader_with_options` parses the container without starting rav1d, and `avif_data()` exposes the parsed container (e.g. to check the sequence header's dimensions before decoding).
> - `output_format()` reports the dimensions and pixel format from the sequence header, before decoding, and `decode_into` decodes into a caller-provided buffer of that format (instead of allocating one). `to_image` is built on `decode_into`. Decoding fails if the frame doesn't match the sequence header.
> - Decoding frees the color frame before decoding alpha.
>
> To pull upstream changes, run `git subtree pull --prefix=vendor/avif-decode https://github.com/kornelski/avif-decode main --squash` from the repository root.

It can be used as a Rust library for decoding AVIF images (AV1 + HEIF) straight to uncompressed pixels (RGBA, etc). Decoding is done by [rav1d](https://lib.rs/crates/rav1d), a Rust port of dav1d, so there's no C library to build.

Optionally can be built as a CLI that converts AVIF  to standard PNG images. Expect the PNG to bemany times larger than the AVIF input.

## Usage

```bash
avif_decode input.avif output.png
```

It always processes one file at a time. If output path is omitted, it'll be the same as the input, except with a `.png` extension. Add `-f` to overwrite output files.

### Install from source

Requires [Rust 1.98 or later](https://rustup.rs).

```bash
cargo install avif-decode
```

## Features

### Supported AVIF features

 * 8-, 10-, and 12-bit deep images. Images are saved as 16-bit PNG when necessary.
 * RGB and many flavors of YUV color spaces in both full and "studio" range.
 * AV1 film grain synthesis
 * Alpha channel, in both premultiplied and uncorrelated alpha modes.
 * 4:4:4, 4:2:2, 4:2:0 chroma modes. Chroma subsampling uses box upsampling.
   BTW: The AVIF spec intentionally left chroma upsampling algorithm unspecified, so images using 4:2:0 or 4:2:2 modes will have decoder-dependent distortions. It's best to never use chroma subsampling modes in AVIF.

### Unsupported features

 * Any form of HDR. Maybe later.
 * Embedded ICC color profiles. AV1 already supports *so many* color spaces, it'd be rude to support an extra color conversion layer that's complex and unecessary.
 * The kitchen sink of pointless HEIF features. I'm writing an image decoder, not Photoshop. Lossless cropping (`clap`) is a dangerous footgun for a Web format. Operating point selection (`a1op`) is simplified to using the final layer.

## License

New BSD
