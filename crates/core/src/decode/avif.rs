//! AVIF via avif-decode (vendored to disable rav1d's asm), which parses the container with
//! avif-parse and decodes with rav1d, a Rust port of dav1d. `image`'s own AVIF decoder is dav1d
//! (C), so `decode::raster_decoder` uses this instead.
//!
//! Known gap: avif-parse doesn't expose `colr` (ICC), `irot`/`imir` (orientation), or `clap`
//! (cropping), so they're ignored. Grid (tiled) images and image sequences are rejected.

use std::io::Read;

use avif_decode::{OutputFormat, PixelFormat};
use image::error::{
    DecodingError, ImageFormatHint, LimitError, LimitErrorKind, UnsupportedError,
    UnsupportedErrorKind,
};
use image::{ColorType, ImageDecoder, ImageError, ImageFormat, ImageResult};

/// The extension that `image`'s detection hook uses to identify the format.
pub const EXTENSION: &str = "avif";

/// An ISOBMFF `ftyp` box (after its size) with the still image (`avif`) or sequence (`avis`)
/// major brand. avif-parse rejects sequences with a clearer error than image-rs.
pub const SIGNATURES: [&[u8]; 2] = [b"\0\0\0\0ftypavif", b"\0\0\0\0ftypavis"];
/// Ignores the box size.
pub const SIGNATURE_MASK: &[u8] = b"\0\0\0\0\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xFF";

const HINT: ImageFormatHint = ImageFormatHint::Exact(ImageFormat::Avif);

fn map_err(err: avif_decode::Error) -> ImageError {
    use avif_decode::Error as E;
    match err {
        E::Avif(avif_parse::Error::Unsupported(msg)) | E::Unsupported(msg) => {
            ImageError::Unsupported(UnsupportedError::from_format_and_kind(
                HINT,
                UnsupportedErrorKind::GenericFeature(msg.into()),
            ))
        }
        E::Avif(avif_parse::Error::OutOfMemory) => {
            ImageError::Limits(LimitError::from_kind(LimitErrorKind::InsufficientMemory))
        }
        err => ImageError::Decoding(DecodingError::new(HINT, err.to_string())),
    }
}

pub struct AvifDecoder {
    decoder: avif_decode::Decoder,
    format: OutputFormat,
}

impl AvifDecoder {
    pub fn new(mut reader: impl Read) -> ImageResult<Self> {
        // Concurrency comes from running more workers: with one thread, rav1d decodes on the
        // calling thread, and nothing is spawned (which wasm doesn't support).
        let mut options = avif_decode::Options::default();
        options.threads = Some(1);
        let decoder = avif_decode::Decoder::from_reader_with_options(&mut reader, options)
            .map_err(map_err)?;
        let format = decoder.output_format().map_err(map_err)?;
        Ok(AvifDecoder { decoder, format })
    }
}

impl ImageDecoder for AvifDecoder {
    fn dimensions(&self) -> (u32, u32) {
        // From the sequence header's `u32`s.
        (self.format.width as u32, self.format.height as u32)
    }

    fn color_type(&self) -> ColorType {
        match self.format.pixel_format {
            PixelFormat::Gray8 => ColorType::L8,
            PixelFormat::Gray16 => ColorType::L16,
            PixelFormat::Rgb8 => ColorType::Rgb8,
            PixelFormat::Rgb16 => ColorType::Rgb16,
            PixelFormat::Rgba8 => ColorType::Rgba8,
            PixelFormat::Rgba16 => ColorType::Rgba16,
            _ => unreachable!("avif-decode added a pixel format"),
        }
    }

    /// Decodes straight into `buf`, without an intermediate copy.
    fn read_image(self, buf: &mut [u8]) -> ImageResult<()> {
        self.decoder.decode_into(buf).map_err(map_err)
    }

    fn read_image_boxed(self: Box<Self>, buf: &mut [u8]) -> ImageResult<()> {
        (*self).read_image(buf)
    }
}

/// Image sequences have the `avis` brand, as their major brand (which avif-parse rejects) or a
/// compatible brand (alongside a still image, which avif-parse decodes).
pub fn has_sequence_brand(input: &[u8]) -> bool {
    let Some(size) = input.first_chunk::<4>() else {
        return false;
    };
    // The box size includes the 8 byte header, then the major brand, minor version, and
    // compatible brands.
    let end = (u32::from_be_bytes(*size) as usize).min(input.len());
    let major = input.get(8..12).and_then(|b| b.first_chunk::<4>());
    let (compatible, _) = input.get(16..end).unwrap_or_default().as_chunks::<4>();
    major
        .into_iter()
        .chain(compatible)
        .any(|brand| brand == b"avis")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sequence_brand() {
        assert!(has_sequence_brand(b"\0\0\0\x10ftypavis\0\0\0\0"));
        assert!(has_sequence_brand(b"\0\0\0\x18ftypavif\0\0\0\0mif1avis"));
        assert!(!has_sequence_brand(b"\0\0\0\x18ftypavif\0\0\0\0mif1miaf"));
        // `avis` after the end of the box.
        assert!(!has_sequence_brand(b"\0\0\0\x14ftypavif\0\0\0\0mif1avis"));
    }
}
