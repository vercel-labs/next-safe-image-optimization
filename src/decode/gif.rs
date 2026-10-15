//! GIF via the gif crate directly, so that frames must fit inside the logical screen. Otherwise a
//! file with a 1x1 screen can contain a 65535x65535 frame. Only the first frame is decoded.

use std::num::NonZeroU64;

use image::DynamicImage;

use super::{Header, InputFormat, alloc, from_raw_u8};
use crate::error::{Error, Result};
use crate::limits::Limits;

fn map_err(err: gif::DecodingError) -> Error {
    Error::Decode(err.to_string())
}

pub fn decode(
    input: &[u8],
    limits: &Limits,
    pixels: bool,
) -> Result<(Header, Option<DynamicImage>)> {
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::RGBA);
    options.check_frame_consistency(true);
    options.set_memory_limit(gif::MemoryLimit::Bytes(
        NonZeroU64::new(limits.memory.max(1)).expect("non-zero"),
    ));
    let mut decoder = options.read_info(input).map_err(map_err)?;
    let (width, height) = (u32::from(decoder.width()), u32::from(decoder.height()));
    limits.check_input(width, height)?;

    let frame = decoder
        .next_frame_info()
        .map_err(map_err)?
        .ok_or_else(|| Error::Decode("GIF has no frames".into()))?;
    let (left, top) = (usize::from(frame.left), usize::from(frame.top));
    let (frame_width, frame_height) = (usize::from(frame.width), usize::from(frame.height));
    let covers_screen = (frame_width, frame_height) == (width as usize, height as usize);
    // Pixels outside of the first frame are transparent.
    let opaque = frame.transparent.is_none() && covers_screen;

    let header = Header {
        format: InputFormat::Gif,
        width,
        height,
        has_alpha: !opaque,
        orientation: image::metadata::Orientation::NoTransforms,
        icc_profile: decoder.icc_profile().map(<[u8]>::to_vec),
    };
    if !pixels {
        return Ok((header, None));
    }

    let mut frame_buf = alloc(limits, decoder.buffer_size())?;
    decoder.read_into_buffer(&mut frame_buf).map_err(map_err)?;

    let canvas = if covers_screen {
        frame_buf
    } else {
        // `check_frame_consistency` guarantees that the frame fits inside the screen.
        let row_len = width as usize * 4;
        let mut canvas = alloc(limits, row_len * height as usize)?;
        for (y, src) in frame_buf.chunks_exact(frame_width * 4).enumerate() {
            let start = (top + y) * row_len + left * 4;
            canvas[start..start + src.len()].copy_from_slice(src);
        }
        canvas
    };
    let image = from_raw_u8(width, height, 4, canvas)?;
    let image = if opaque {
        DynamicImage::ImageRgb8(image.to_rgb8())
    } else {
        image
    };
    Ok((header, Some(image)))
}
