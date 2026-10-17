//! AVIF via avif-decode (vendored to disable rav1d's asm), which parses the container with
//! avif-parse and decodes with rav1d, a Rust port of dav1d.
//!
//! Known gaps:
//! - avif-parse pre-allocates some buffers from box sizes and entry counts declared in the file,
//!   before reading them. These are bounded by `try_reserve`, not by the memory limit.
//! - avif-parse doesn't expose `colr` (ICC), `irot`/`imir` (orientation), or `clap` (cropping),
//!   so they're ignored. Grid (tiled) images and image sequences are rejected.

use avif_decode::{Image, Options};
use image::metadata::Orientation;
use image::{DynamicImage, ImageBuffer, Pixel};

use crate::decode::{Header, InputFormat};
use crate::error::{Error, Result};
use crate::limits::Limits;

/// Every frame is a full decode at up to the image's size, and a frame (especially one that only
/// repeats a previous frame with `show_existing_frame`) can take just a few bytes. Still images
/// have one frame per spatial layer, and AVIF allows at most 4 layers.
const MAX_FRAMES: usize = 8;

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

/// Mirrors `get_uleb128` in rav1d: at most 8 bytes, and the value must fit in a `u32`.
fn leb128(data: &mut &[u8]) -> Option<usize> {
    let mut value = 0u64;
    for i in 0..8 {
        let (&byte, rest) = data.split_first()?;
        *data = rest;
        value |= u64::from(byte & 0x7F) << (i * 7);
        if byte & 0x80 == 0 {
            return usize::try_from(u32::try_from(value).ok()?).ok();
        }
    }
    None
}

/// Counts the OBUs that start a frame (`OBU_FRAME_HEADER`, `OBU_FRAME`, and
/// `OBU_REDUNDANT_FRAME_HEADER`, which rav1d treats as a frame header when none is pending). Walks
/// OBU headers the way rav1d does, and rejects anything it can't walk instead of trying to resync.
fn count_frames(mut data: &[u8]) -> Result<usize> {
    let malformed = || Error::Decode("malformed AV1 bitstream".into());
    let mut frames = 0;
    while let Some(&header) = data.first() {
        data = &data[1..];
        if matches!((header >> 3) & 0xF, 3 | 6 | 7) {
            frames += 1;
        }
        let has_extension = header & 0b100 != 0;
        let has_size = header & 0b10 != 0;
        if has_extension {
            data = data.get(1..).ok_or_else(malformed)?;
        }
        if !has_size {
            // The OBU extends to the end of the data.
            break;
        }
        let size = leb128(&mut data).ok_or_else(malformed)?;
        data = data.get(size..).ok_or_else(malformed)?;
    }
    Ok(frames)
}

fn check_frames(av1: &[u8]) -> Result<()> {
    if count_frames(av1)? > MAX_FRAMES {
        return Err(Error::LimitExceeded(format!(
            "AVIF item has more than {MAX_FRAMES} frames"
        )));
    }
    Ok(())
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
    // Threads are left to the caller: with one thread, rav1d decodes on the calling thread, so
    // panics are caught by `catch_panics`, and nothing is spawned on wasm.
    let mut options = Options::default();
    options.threads = Some(1);
    let mut decoder = avif_decode::Decoder::from_reader_with_options(&mut &input[..], options)
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

    check_frames(&avif.primary_item)?;
    if let Some(alpha) = &avif.alpha_item {
        check_frames(alpha)?;
    }

    // Measured peak RSS on noisy 16 MP images matches the YUV planes of the color and alpha frames
    // (rav1d keeps the color frame as a reference while decoding alpha), plus a copy of the AV1
    // data. Film grain synthesis outputs a second copy of each frame.
    let pixels = u64::from(width) * u64::from(height);
    let alpha_seq = avif
        .alpha_item_metadata()
        .map_err(|err| map_err(err.into()))?;
    let frame_bytes = |seq: &avif_parse::AV1Metadata| {
        let sample_bytes = if seq.bit_depth > 8 { 2 } else { 1 };
        let chroma = match (seq.monochrome, seq.chroma_subsampling) {
            (true, _) => 0,
            (false, (true, true)) => pixels / 2,
            (false, (true, false) | (false, true)) => pixels,
            (false, (false, false)) => pixels * 2,
        };
        (pixels + chroma) * sample_bytes * 2
    };
    let decoder_bytes = frame_bytes(&seq)
        + alpha_seq.as_ref().map_or(0, frame_bytes)
        + avif.primary_item.len() as u64
        + avif.alpha_item.as_ref().map_or(0, |a| a.len() as u64);

    let high_depth = seq.bit_depth > 8;
    let channels = match (has_alpha, seq.monochrome) {
        (true, _) => 4,
        (false, true) => 1,
        (false, false) => 3,
    };
    let output_bytes = pixels * channels * if high_depth { 2 } else { 1 };
    // `normalize` converts high bit depths to a second, 8-bit buffer.
    let normalize_bytes = if high_depth { pixels * channels } else { 0 };
    limits.check_alloc(decoder_bytes + output_bytes + normalize_bytes)?;

    // rav1d checks every frame header against this, before allocating the frame.
    decoder.options_mut().frame_size_limit =
        u32::try_from(pixels).map_err(|_| Error::LimitExceeded("AVIF is too large".into()))?;
    let image = to_dynamic_image(decoder.to_image().map_err(map_err)?)?;
    if (image.width(), image.height()) != (width, height) {
        return Err(Error::Decode(
            "AVIF frame size doesn't match the sequence header".into(),
        ));
    }
    Ok((header, Some(image)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obu(obu_type: u8, payload: &[u8]) -> Vec<u8> {
        assert!(payload.len() < 0x80);
        let mut out = vec![(obu_type << 3) | 0b10, payload.len() as u8];
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn leb128_matches_rav1d() {
        assert_eq!(leb128(&mut &[0x05][..]), Some(5));
        assert_eq!(leb128(&mut &[0x80, 0x01][..]), Some(128));
        // Redundant continuation bytes are allowed, up to 8 bytes.
        assert_eq!(leb128(&mut &[0x81, 0x80, 0x80, 0x00][..]), Some(1));
        assert_eq!(leb128(&mut &[0x80; 8][..]), None);
        assert_eq!(leb128(&mut &[0xFF, 0xFF, 0xFF, 0xFF, 0x1F][..]), None);
        assert_eq!(leb128(&mut &[0x80][..]), None);
    }

    #[test]
    fn counts_frames() {
        let mut data = obu(2, &[]);
        data.extend(obu(1, &[0; 10]));
        data.extend(obu(6, &[0; 20]));
        // With an extension byte.
        data.extend([(3 << 3) | 0b110, 0, 1, 0]);
        data.extend(obu(7, &[0; 3]));
        data.extend(obu(4, &[0; 3]));
        assert_eq!(count_frames(&data).unwrap(), 3);

        // Without a size field, the last OBU extends to the end, including bytes that look like
        // frame headers.
        let mut no_size = data.clone();
        no_size.push(4 << 3);
        no_size.extend(obu(6, &[]));
        assert_eq!(count_frames(&no_size).unwrap(), 3);

        data.extend([6 << 3 | 0b10, 10, 0]);
        assert!(count_frames(&data).is_err());
    }

    #[test]
    fn rejects_many_frames() {
        let one = obu(6, &[0; 4]);
        assert!(check_frames(&one.repeat(MAX_FRAMES)).is_ok());
        assert!(matches!(
            check_frames(&one.repeat(MAX_FRAMES + 1)),
            Err(Error::LimitExceeded(_))
        ));
    }
}
