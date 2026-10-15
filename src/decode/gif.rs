//! GIF via the gif crate directly, so that frames must fit inside the logical screen. Otherwise a
//! file with a 1x1 screen can contain a 65535x65535 frame. Only the first frame is decoded.

use std::num::NonZeroU64;

use image::DynamicImage;

use super::{Header, InputFormat, alloc, from_raw_u8};
use crate::error::{Error, Result};
use crate::interrupt::{Interrupt, InterruptibleReader};
use crate::limits::Limits;

fn map_err(err: gif::DecodingError) -> Error {
    Error::Decode(err.to_string())
}

const ROWS_PER_CHECK: usize = 64;

/// Like `Decoder::read_into_buffer`, but checks for interrupts between batches of rows. LZW data can
/// expand enormously, so checking on input reads alone isn't enough.
fn read_frame<R: std::io::Read>(
    decoder: &mut gif::Decoder<R>,
    buf: &mut [u8],
    row_len: usize,
    interlaced: bool,
    interrupt: &Interrupt,
) -> Result<()> {
    let truncated = || Error::Decode("GIF image data is truncated".into());
    if interlaced {
        let height = buf.len() / row_len;
        let mut rows = 0;
        for (start, step) in [(0, 8), (4, 8), (2, 4), (1, 2)] {
            for y in (start..height).step_by(step) {
                if rows % ROWS_PER_CHECK == 0 {
                    interrupt.check()?;
                }
                rows += 1;
                let row = &mut buf[y * row_len..(y + 1) * row_len];
                if !decoder.fill_buffer(row).map_err(map_err)? {
                    return Err(truncated());
                }
            }
        }
    } else {
        for rows in buf.chunks_mut(row_len * ROWS_PER_CHECK) {
            interrupt.check()?;
            if !decoder.fill_buffer(rows).map_err(map_err)? {
                return Err(truncated());
            }
        }
    }
    Ok(())
}

pub fn decode(
    input: &[u8],
    limits: &Limits,
    interrupt: &Interrupt,
    pixels: bool,
) -> Result<(Header, Option<DynamicImage>)> {
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::RGBA);
    options.check_frame_consistency(true);
    options.set_memory_limit(gif::MemoryLimit::Bytes(
        NonZeroU64::new(limits.memory.max(1)).expect("non-zero"),
    ));
    let mut decoder = options
        .read_info(InterruptibleReader::new(input, interrupt))
        .map_err(map_err)?;
    let (width, height) = (u32::from(decoder.width()), u32::from(decoder.height()));
    limits.check_input(width, height)?;

    let frame = decoder
        .next_frame_info()
        .map_err(map_err)?
        .ok_or_else(|| Error::Decode("GIF has no frames".into()))?;
    let (left, top) = (usize::from(frame.left), usize::from(frame.top));
    let (frame_width, frame_height) = (usize::from(frame.width), usize::from(frame.height));
    let interlaced = frame.interlaced;
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
    read_frame(
        &mut decoder,
        &mut frame_buf,
        frame_width * 4,
        interlaced,
        interrupt,
    )?;

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
