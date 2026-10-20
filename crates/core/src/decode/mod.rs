//! Decoders. Everything goes through `image`, which detects the format from its magic bytes (never
//! file extensions or content types). AVIF is plugged in with hooks (see `avif.rs`).
//!
//! The worker's memory limits and the caller's timeout bound what decoders can do, so the only
//! check before decoding is the pixel limit.

mod avif;

use std::io::Cursor;
use std::sync::Once;

use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, hooks};

use crate::decode::avif::AvifDecoder;
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

    /// Only these formats are decoded. `image` detects more (BMP, ICO, PNM, QOI, etc.), which fail
    /// because their features are disabled. But Cargo unifies features across the dependency
    /// graph, so another crate could enable them without us noticing.
    fn from_image_format(format: Option<ImageFormat>) -> Result<Self> {
        Ok(match format {
            Some(ImageFormat::Jpeg) => InputFormat::Jpeg,
            Some(ImageFormat::Png) => InputFormat::Png,
            Some(ImageFormat::WebP) => InputFormat::Webp,
            Some(ImageFormat::Gif) => InputFormat::Gif,
            Some(ImageFormat::Tiff) => InputFormat::Tiff,
            Some(ImageFormat::Avif) => InputFormat::Avif,
            _ => {
                return Err(Error::UnsupportedFormat(
                    "input is not a JPEG, PNG, WebP, GIF, TIFF, or AVIF image".into(),
                ));
            }
        })
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

/// Registers our AVIF decoder with `image` (hooks are global, so once per process).
///
/// The detection hook is needed even though `image` detects AVIF on its own: its built-in
/// detection selects its built-in AVIF decoder (dav1d, which we don't enable), and only formats
/// detected by a hook are looked up in the decoding hooks. Detection hooks are checked before
/// `image`'s own magic bytes, so ours wins.
fn register_hooks() {
    static HOOKS: Once = Once::new();
    HOOKS.call_once(|| {
        for signature in avif::SIGNATURES {
            hooks::register_format_detection_hook(
                avif::EXTENSION.into(),
                signature,
                Some(avif::SIGNATURE_MASK),
            );
        }
        hooks::register_decoding_hook(
            avif::EXTENSION.into(),
            Box::new(|reader| Ok(Box::new(AvifDecoder::new(reader)?))),
        );
    });
}

fn reader(input: &[u8]) -> Result<(ImageReader<Cursor<&[u8]>>, InputFormat)> {
    register_hooks();
    let reader = ImageReader::new(Cursor::new(input))
        .with_guessed_format()
        .map_err(|err| Error::Decode(err.to_string()))?;
    let format = InputFormat::from_image_format(reader.format())?;
    Ok((reader, format))
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
    let (mut reader, format) = reader(input)?;
    reader.limits(limits.image_limits());
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    limits.check_input(width, height)?;
    let header = Header {
        format,
        width,
        height,
        has_alpha: decoder.color_type().has_alpha(),
        orientation: decoder.orientation()?,
        icc_profile: decoder.icc_profile()?,
    };
    if !pixels {
        return Ok((header, None));
    }

    // For animations, this is the first frame.
    let image = DynamicImage::from_decoder(decoder)?;
    Ok((header, Some(drop_opaque_gif_alpha(format, image))))
}

/// GIF frames always decode as RGBA. Drop the alpha channel if the frame turned out to be opaque,
/// so that it's treated like other opaque images (e.g. PNG output doesn't get an alpha channel).
fn drop_opaque_gif_alpha(format: InputFormat, image: DynamicImage) -> DynamicImage {
    match image {
        DynamicImage::ImageRgba8(rgba)
            if format == InputFormat::Gif && rgba.pixels().all(|p| p[3] == u8::MAX) =>
        {
            DynamicImage::ImageRgba8(rgba).to_rgb8().into()
        }
        image => image,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(input: &[u8]) -> Result<InputFormat> {
        reader(input).map(|(_, format)| format)
    }

    #[test]
    fn detects_formats() {
        assert_eq!(detect(b"\xFF\xD8\xFF\xE0").unwrap(), InputFormat::Jpeg);
        assert_eq!(detect(b"\x89PNG\r\n\x1a\n").unwrap(), InputFormat::Png);
        assert_eq!(detect(b"GIF89a").unwrap(), InputFormat::Gif);
        assert_eq!(detect(b"RIFF\0\0\0\0WEBPVP8 ").unwrap(), InputFormat::Webp);
        assert_eq!(detect(b"II*\0").unwrap(), InputFormat::Tiff);
        assert_eq!(detect(b"MM\0*").unwrap(), InputFormat::Tiff);
        // Including box sizes that `image`'s own signature doesn't allow.
        assert_eq!(detect(b"\0\0\0\x1cftypavif").unwrap(), InputFormat::Avif);
        assert_eq!(detect(b"\x01\0\0\x1cftypavis").unwrap(), InputFormat::Avif);
        for unsupported in [
            &b"\0\0\0\x1cftypheic"[..],
            b"<svg",
            b"",
            b"BM",
            b"P6\n1 1\n255\n",
            b"qoif",
            b"farbfeld",
        ] {
            assert!(matches!(
                detect(unsupported),
                Err(Error::UnsupportedFormat(_))
            ));
        }
    }
}
