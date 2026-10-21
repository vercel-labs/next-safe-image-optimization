//! Decoders. `image` detects the format from its magic bytes (never file extensions or content
//! types). Raster formats are decoded with `image`'s decoders, except AVIF (see `avif.rs`).
//! Anything else that looks like an SVG is rendered with resvg (see `svg.rs`).
//!
//! The worker's memory limits and the caller's timeout bound what decoders can do, so the only
//! check before decoding is the pixel limit (and the caller's allowed formats, and animation).

mod avif;
mod gif;
mod svg;

use std::io::Cursor;
use std::sync::Once;

use image::codecs::gif::GifDecoder;
use image::codecs::jpeg::JpegDecoder;
use image::codecs::png::PngDecoder;
use image::codecs::tiff::TiffDecoder;
use image::codecs::webp::WebPDecoder;
use image::metadata::Orientation;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, hooks};
use serde::Deserialize;

use crate::decode::avif::AvifDecoder;
use crate::decode::svg::Svg;
use crate::error::{Error, Result};
use crate::limits::Limits;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputFormat {
    Jpeg,
    Png,
    Webp,
    Gif,
    Tiff,
    Avif,
    Svg,
}

impl InputFormat {
    pub const ALL: [InputFormat; 7] = [
        InputFormat::Jpeg,
        InputFormat::Png,
        InputFormat::Webp,
        InputFormat::Gif,
        InputFormat::Tiff,
        InputFormat::Avif,
        InputFormat::Svg,
    ];

    pub fn name(self) -> &'static str {
        match self {
            InputFormat::Jpeg => "jpeg",
            InputFormat::Png => "png",
            InputFormat::Webp => "webp",
            InputFormat::Gif => "gif",
            InputFormat::Tiff => "tiff",
            InputFormat::Avif => "avif",
            InputFormat::Svg => "svg",
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
                    "input is not a JPEG, PNG, WebP, GIF, TIFF, AVIF, or SVG image".into(),
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

/// Registers our AVIF detection hook with `image` (hooks are global, so once per process).
///
/// `image` detects AVIF on its own, but only with the `avif` major brand and a box size under
/// 64 KiB. Detection hooks are checked before `image`'s own magic bytes.
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
    });
}

/// Detects the format, and checks that it's allowed.
fn open(input: &[u8], limits: &Limits) -> Result<InputFormat> {
    let format = detect(input)?;
    limits.check_format(format)?;
    Ok(format)
}

fn detect(input: &[u8]) -> Result<InputFormat> {
    register_hooks();
    let reader = ImageReader::new(Cursor::new(input))
        .with_guessed_format()
        .map_err(|err| Error::Decode(err.to_string()))?;
    if reader.format().is_none() && svg::is_svg(input) {
        return Ok(InputFormat::Svg);
    }
    InputFormat::from_image_format(reader.format())
}

pub fn header(input: &[u8], limits: &Limits) -> Result<Header> {
    match open(input, limits)? {
        InputFormat::Svg => Ok(Svg::parse(input, limits)?.header()),
        format => Ok(run(input, format, limits, false)?.0),
    }
}

/// `vector_scale` is called with the natural size of a vector image (SVG), and returns the scale
/// to render it at.
pub fn decode(
    input: &[u8],
    limits: &Limits,
    vector_scale: impl FnOnce(u32, u32) -> f64,
) -> Result<Decoded> {
    match open(input, limits)? {
        InputFormat::Svg => {
            let svg = Svg::parse(input, limits)?;
            let image = svg.render(vector_scale(svg.width, svg.height), limits)?;
            Ok(Decoded {
                header: svg.header(),
                image,
            })
        }
        format => {
            let (header, image) = run(input, format, limits, true)?;
            let image = normalize(image.expect("pixels were requested"));
            Ok(Decoded { header, image })
        }
    }
}

/// Like `ImageReader::into_decoder`, but only for our formats, and with our AVIF decoder. Checks
/// for animation with each format's decoder where it can, before decoding any pixels.
fn raster_decoder<'a>(
    input: &'a [u8],
    format: InputFormat,
    limits: &Limits,
) -> Result<Box<dyn ImageDecoder + 'a>> {
    let reject_animated = |is_animated: &mut dyn FnMut() -> Result<bool>| {
        if !limits.animated && is_animated()? {
            return Err(Error::Animated(format!(
                "input is an animated {}",
                format.name().to_uppercase()
            )));
        }
        Ok(())
    };
    let reader = Cursor::new(input);
    let mut decoder: Box<dyn ImageDecoder> = match format {
        InputFormat::Jpeg => Box::new(JpegDecoder::new(reader)?),
        InputFormat::Png => {
            let decoder = PngDecoder::with_limits(reader, limits.image_limits())?;
            reject_animated(&mut || Ok(decoder.is_apng()?))?;
            Box::new(decoder)
        }
        InputFormat::Webp => {
            let decoder = WebPDecoder::new(reader)?;
            reject_animated(&mut || Ok(decoder.has_animation()))?;
            Box::new(decoder)
        }
        InputFormat::Gif => {
            reject_animated(&mut || gif::has_second_frame(input))?;
            Box::new(GifDecoder::new(reader)?)
        }
        InputFormat::Tiff => Box::new(TiffDecoder::new(reader)?),
        InputFormat::Avif => {
            // Before parsing, which rejects sequences as unsupported.
            reject_animated(&mut || Ok(avif::has_sequence_brand(input)))?;
            Box::new(AvifDecoder::new(reader)?)
        }
        InputFormat::Svg => return Err(Error::Internal("SVG is not a raster format".into())),
    };
    decoder.set_limits(limits.image_limits())?;
    Ok(decoder)
}

fn run(
    input: &[u8],
    format: InputFormat,
    limits: &Limits,
    pixels: bool,
) -> Result<(Header, Option<DynamicImage>)> {
    let mut decoder = raster_decoder(input, format, limits)?;
    let (width, height) = decoder.dimensions();
    limits.check_input_pixels(width, height)?;
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
        assert_eq!(
            detect(b"<?xml version=\"1.0\"?><svg").unwrap(),
            InputFormat::Svg
        );
        // Magic bytes win over text.
        assert_eq!(detect(b"GIF89a<svg").unwrap(), InputFormat::Gif);
        for unsupported in [
            &b"\0\0\0\x1cftypheic"[..],
            b"<html>",
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
