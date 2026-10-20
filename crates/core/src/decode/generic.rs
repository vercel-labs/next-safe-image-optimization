//! JPEG (zune-jpeg), PNG, GIF, WebP, and TIFF, via `image`. The worker's memory limits and the
//! caller's timeout bound what these decoders can do, so we only check the pixel limit, before
//! decoding.

use std::io::Cursor;

use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};

use crate::decode::{Header, InputFormat};
use crate::error::Result;
use crate::limits::Limits;

fn image_format(format: InputFormat) -> ImageFormat {
    match format {
        InputFormat::Jpeg => ImageFormat::Jpeg,
        InputFormat::Png => ImageFormat::Png,
        InputFormat::Webp => ImageFormat::WebP,
        InputFormat::Gif => ImageFormat::Gif,
        InputFormat::Tiff => ImageFormat::Tiff,
        InputFormat::Avif => unreachable!("AVIF is decoded by avif-decode"),
    }
}

pub fn decode(
    input: &[u8],
    format: InputFormat,
    limits: &Limits,
    pixels: bool,
) -> Result<(Header, Option<DynamicImage>)> {
    let mut reader = ImageReader::with_format(Cursor::new(input), image_format(format));
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
