//! Decoders. Each format calls its decoder crate directly (except TIFF) so that we can configure
//! safety options that `image` doesn't expose. See `AGENTS.md` for the rationale per format.

mod avif;
mod gif;
mod jpeg;
mod png;
mod tiff;
mod webp;

use image::DynamicImage;
use image::metadata::Orientation;

use crate::error::{Error, Result};
use crate::limits::Limits;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputFormat {
    Jpeg,
    Png,
    Webp,
    Gif,
    Tiff,
    Avif,
}

impl InputFormat {
    pub fn name(self) -> &'static str {
        match self {
            InputFormat::Jpeg => "jpeg",
            InputFormat::Png => "png",
            InputFormat::Webp => "webp",
            InputFormat::Gif => "gif",
            InputFormat::Tiff => "tiff",
            InputFormat::Avif => "avif",
        }
    }
}

pub struct Header {
    pub format: InputFormat,
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub orientation: Orientation,
    pub icc_profile: Option<Vec<u8>>,
}

pub struct Decoded {
    pub header: Header,
    /// Always 8 bits per channel (see [`normalize`]).
    pub image: DynamicImage,
}

/// Detects the format from magic bytes. We never trust file extensions or content types.
pub fn detect(input: &[u8]) -> Result<InputFormat> {
    match input {
        [0xFF, 0xD8, 0xFF, ..] => Ok(InputFormat::Jpeg),
        [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n', ..] => Ok(InputFormat::Png),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Ok(InputFormat::Gif),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Ok(InputFormat::Webp),
        // Classic TIFF and BigTIFF, in both byte orders.
        [b'I', b'I', 42 | 43, 0, ..] | [b'M', b'M', 0, 42 | 43, ..] => Ok(InputFormat::Tiff),
        // An ISOBMFF `ftyp` box with the still image (`avif`) or sequence (`avis`) major brand.
        // avif-parse rejects sequences with a clearer error than ours.
        [
            _,
            _,
            _,
            _,
            b'f',
            b't',
            b'y',
            b'p',
            b'a',
            b'v',
            b'i',
            b'f' | b's',
            ..,
        ] => Ok(InputFormat::Avif),
        _ => Err(Error::UnsupportedFormat(
            "input is not a JPEG, PNG, WebP, GIF, TIFF, or AVIF image".into(),
        )),
    }
}

pub fn header(input: &[u8], limits: &Limits) -> Result<Header> {
    Ok(run(input, limits, false)?.0)
}

pub fn decode(input: &[u8], limits: &Limits) -> Result<Decoded> {
    let (header, image) = run(input, limits, true)?;
    let image = normalize(image.expect("pixels were requested"));
    Ok(Decoded { header, image })
}

fn run(input: &[u8], limits: &Limits, pixels: bool) -> Result<(Header, Option<DynamicImage>)> {
    match detect(input)? {
        InputFormat::Jpeg => jpeg::decode(input, limits, pixels),
        InputFormat::Png => png::decode(input, limits, pixels),
        InputFormat::Webp => webp::decode(input, limits, pixels),
        InputFormat::Gif => gif::decode(input, limits, pixels),
        InputFormat::Tiff => tiff::decode(input, limits, pixels),
        InputFormat::Avif => avif::decode(input, limits, pixels),
    }
}

/// Converts to 8 bits per channel. Nothing downstream needs more precision for web output, and it
/// halves the memory of 16-bit images.
pub fn normalize(img: DynamicImage) -> DynamicImage {
    use DynamicImage as D;
    match img {
        D::ImageLuma8(_) | D::ImageLumaA8(_) | D::ImageRgb8(_) | D::ImageRgba8(_) => img,
        D::ImageLuma16(_) => D::ImageLuma8(img.to_luma8()),
        D::ImageLumaA16(_) => D::ImageLumaA8(img.to_luma_alpha8()),
        _ if img.color().has_alpha() => D::ImageRgba8(img.to_rgba8()),
        _ => D::ImageRgb8(img.to_rgb8()),
    }
}

/// Builds an image from a decoder's output buffer. `channels` must be 1-4.
fn from_raw_u8(width: u32, height: u32, channels: u8, data: Vec<u8>) -> Result<DynamicImage> {
    let invalid = || Error::Decode("decoder output size doesn't match dimensions".into());
    Ok(match channels {
        1 => image::GrayImage::from_raw(width, height, data)
            .ok_or_else(invalid)?
            .into(),
        2 => image::GrayAlphaImage::from_raw(width, height, data)
            .ok_or_else(invalid)?
            .into(),
        3 => image::RgbImage::from_raw(width, height, data)
            .ok_or_else(invalid)?
            .into(),
        4 => image::RgbaImage::from_raw(width, height, data)
            .ok_or_else(invalid)?
            .into(),
        _ => {
            return Err(Error::Decode(format!(
                "unexpected channel count {channels}"
            )));
        }
    })
}

/// Allocates a zeroed output buffer after checking it against the memory limit.
fn alloc(limits: &Limits, bytes: usize) -> Result<Vec<u8>> {
    limits.check_alloc(bytes as u64)?;
    Ok(vec![0; bytes])
}

fn orientation_from_exif(exif: Option<&[u8]>) -> Orientation {
    exif.and_then(Orientation::from_exif_chunk)
        .unwrap_or(Orientation::NoTransforms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_formats() {
        assert_eq!(detect(b"\xFF\xD8\xFF\xE0").unwrap(), InputFormat::Jpeg);
        assert_eq!(detect(b"\x89PNG\r\n\x1a\n").unwrap(), InputFormat::Png);
        assert_eq!(detect(b"GIF89a").unwrap(), InputFormat::Gif);
        assert_eq!(detect(b"RIFF\0\0\0\0WEBPVP8 ").unwrap(), InputFormat::Webp);
        assert_eq!(detect(b"II*\0").unwrap(), InputFormat::Tiff);
        assert_eq!(detect(b"MM\0*").unwrap(), InputFormat::Tiff);
        assert_eq!(detect(b"\0\0\0\x1cftypavif").unwrap(), InputFormat::Avif);
        assert!(detect(b"\0\0\0\x1cftypheic").is_err());
        assert!(detect(b"<svg").is_err());
        assert!(detect(b"").is_err());
    }
}
