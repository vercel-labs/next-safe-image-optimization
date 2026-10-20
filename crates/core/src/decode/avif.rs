//! AVIF via avif-decode (vendored to disable rav1d's asm), which parses the container with
//! avif-parse and decodes with rav1d, a Rust port of dav1d.
//!
//! Known gap: avif-parse doesn't expose `colr` (ICC), `irot`/`imir` (orientation), or `clap`
//! (cropping), so they're ignored. Grid (tiled) images and image sequences are rejected.

use avif_decode::{Image, Options};
use image::metadata::Orientation;
use image::{DynamicImage, ImageBuffer, Pixel};

use crate::decode::{Header, InputFormat};
use crate::error::{Error, Result};
use crate::limits::Limits;

fn map_err(err: avif_decode::Error) -> Error {
    use avif_decode::Error as E;
    match err {
        E::Avif(avif_parse::Error::Unsupported(msg)) | E::Unsupported(msg) => {
            Error::UnsupportedFormat(format!("AVIF: {msg}"))
        }
        E::Avif(avif_parse::Error::OutOfMemory) => {
            Error::LimitExceeded("AVIF container is too large".into())
        }
        err => Error::Decode(err.to_string()),
    }
}

fn to_dynamic<P: Pixel>(
    width: u32,
    height: u32,
    data: Vec<P::Subpixel>,
) -> Result<ImageBuffer<P, Vec<P::Subpixel>>> {
    ImageBuffer::from_raw(width, height, data)
        .ok_or_else(|| Error::Decode("decoder output size doesn't match dimensions".into()))
}

fn to_dynamic_image(img: Image) -> Result<DynamicImage> {
    use bytemuck::allocation::cast_vec;
    macro_rules! convert {
        ($img:expr, $variant:ident) => {{
            let img = $img;
            let (width, height) = (img.width() as u32, img.height() as u32);
            DynamicImage::$variant(to_dynamic(width, height, cast_vec(img.into_buf()))?)
        }};
    }
    // avif-decode allocates its output with `ImgVec::new`, so rows aren't padded.
    Ok(match img {
        Image::Rgb8(img) => convert!(img, ImageRgb8),
        Image::Rgba8(img) => convert!(img, ImageRgba8),
        Image::Gray8(img) => convert!(img, ImageLuma8),
        Image::Rgb16(img) => convert!(img, ImageRgb16),
        Image::Rgba16(img) => convert!(img, ImageRgba16),
        Image::Gray16(img) => convert!(img, ImageLuma16),
    })
}

pub fn decode(
    input: &[u8],
    limits: &Limits,
    pixels: bool,
) -> Result<(Header, Option<DynamicImage>)> {
    // Concurrency comes from running more workers: with one thread, rav1d decodes on the calling
    // thread, and nothing is spawned (which wasm doesn't support).
    let mut options = Options::default();
    options.threads = Some(1);
    let decoder = avif_decode::Decoder::from_reader_with_options(&mut &input[..], options)
        .map_err(map_err)?;
    let avif = decoder.avif_data();
    let seq = avif
        .primary_item_metadata()
        .map_err(|err| map_err(err.into()))?;
    let (width, height) = (seq.max_frame_width.get(), seq.max_frame_height.get());
    limits.check_input(width, height)?;

    let has_alpha = avif.alpha_item.is_some();
    let header = Header {
        format: InputFormat::Avif,
        width,
        height,
        has_alpha,
        orientation: Orientation::NoTransforms,
        icc_profile: None,
    };
    if !pixels {
        return Ok((header, None));
    }

    let image = to_dynamic_image(decoder.to_image().map_err(map_err)?)?;
    if (image.width(), image.height()) != (width, height) {
        return Err(Error::Decode(
            "AVIF frame size doesn't match the sequence header".into(),
        ));
    }
    Ok((header, Some(image)))
}
