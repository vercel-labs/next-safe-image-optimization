//! PNG via the png crate directly. `image` uses the full allocation budget as png's metadata limit
//! (allowing a ~0.5 MB iCCP chunk to inflate to 512 MiB) and forces text chunk decoding.

use image::DynamicImage;
use png::{ColorType, Transformations};

use super::{Header, InputFormat, alloc, from_raw_u8, orientation_from_exif};
use crate::error::{Error, Result};
use crate::interrupt::{Interrupt, InterruptibleReader};
use crate::limits::Limits;

fn map_err(err: png::DecodingError) -> Error {
    match err {
        png::DecodingError::LimitsExceeded => {
            Error::LimitExceeded("PNG metadata exceeds the size limit".into())
        }
        err => Error::Decode(err.to_string()),
    }
}

pub fn decode(
    input: &[u8],
    limits: &Limits,
    interrupt: &Interrupt,
    pixels: bool,
) -> Result<(Header, Option<DynamicImage>)> {
    let mut options = png::DecodeOptions::default();
    // We don't use text chunks, and zTXt/iTXt are compressed.
    options.set_ignore_text_chunk(true);
    let mut decoder =
        png::Decoder::new_with_options(InterruptibleReader::new(input, interrupt), options);
    // This bounds buffered ancillary chunks (including the inflated iCCP profile), not image data.
    decoder.set_limits(png::Limits {
        bytes: limits.metadata_bytes() as usize,
    });
    decoder.set_transformations(Transformations::EXPAND | Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(map_err)?;

    let info = reader.info();
    let (width, height) = (info.width, info.height);
    limits.check_input(width, height)?;
    let icc_profile = info.icc_profile.as_ref().map(|icc| icc.to_vec());
    let orientation = orientation_from_exif(info.exif_metadata.as_deref());

    let (color_type, _) = reader.output_color_type();
    let channels = match color_type {
        ColorType::Grayscale => 1,
        ColorType::GrayscaleAlpha => 2,
        ColorType::Rgb => 3,
        ColorType::Rgba => 4,
        ColorType::Indexed => unreachable!("EXPAND converts indexed images"),
    };
    let header = Header {
        format: InputFormat::Png,
        width,
        height,
        has_alpha: channels == 2 || channels == 4,
        orientation,
        icc_profile,
    };
    if !pixels {
        return Ok((header, None));
    }

    // For APNG, this is the default image (which may not be part of the animation).
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| Error::LimitExceeded("PNG is too large".into()))?;
    let mut buf = alloc(limits, size)?;
    let frame = reader.next_frame(&mut buf).map_err(map_err)?;
    buf.truncate(frame.buffer_size());
    Ok((header, Some(from_raw_u8(width, height, channels, buf)?)))
}
