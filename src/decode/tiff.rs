//! TIFF via `image`, which handles the many TIFF color types and planar configurations for us. We
//! pre-scan the first IFD with the tiff crate to reject inputs that `image` can't bound:
//!
//! - JPEG-compressed TIFFs create a new, unbounded JPEG decoder for every strip or tile, and the
//!   embedded JPEG's dimensions aren't checked against the tile. Every tile can reference the same
//!   tiny JPEG, so a few KB of input can force gigabytes of allocation.
//! - Tiles much larger than the image (and the memory limit).

use std::io::Cursor;

use image::{DynamicImage, ImageDecoder};
use tiff::tags::Tag;

use super::{Header, InputFormat};
use crate::error::{Error, Result};
use crate::limits::Limits;

fn map_err(err: tiff::TiffError) -> Error {
    match err {
        tiff::TiffError::LimitsExceeded => Error::LimitExceeded("TIFF exceeds limits".into()),
        err => Error::Decode(err.to_string()),
    }
}

/// Old-style (6) and new-style (7) JPEG compression.
const JPEG_COMPRESSION: [u16; 2] = [6, 7];

fn prescan(input: &[u8], limits: &Limits) -> Result<()> {
    let mut decoder = tiff::decoder::Decoder::new(Cursor::new(input))
        .map_err(map_err)?
        .with_limits(tiff_limits(limits));
    let (width, height) = decoder.dimensions().map_err(map_err)?;
    limits.check_input(width, height)?;

    let compression = decoder
        .find_tag_unsigned::<u16>(Tag::Compression)
        .map_err(map_err)?;
    if compression.is_some_and(|c| JPEG_COMPRESSION.contains(&c)) {
        return Err(Error::UnsupportedFormat(
            "JPEG-compressed TIFF images are not supported".into(),
        ));
    }

    // Each tile is decoded into a buffer of the full tile size (up to 16 bytes per pixel), even when
    // the image is smaller than a tile. Tile dimensions must be multiples of 16, so small images
    // commonly have one tile that's larger than the image.
    let tile_width = decoder
        .find_tag_unsigned::<u32>(Tag::TileWidth)
        .map_err(map_err)?;
    let tile_height = decoder
        .find_tag_unsigned::<u32>(Tag::TileLength)
        .map_err(map_err)?;
    if let (Some(tile_width), Some(tile_height)) = (tile_width, tile_height) {
        limits.check_alloc(u64::from(tile_width) * u64::from(tile_height) * 16)?;
    }
    Ok(())
}

fn tiff_limits(limits: &Limits) -> tiff::decoder::Limits {
    let mut tiff_limits = tiff::decoder::Limits::default();
    let memory = usize::try_from(limits.memory).unwrap_or(usize::MAX);
    tiff_limits.decoding_buffer_size = memory;
    tiff_limits.intermediate_buffer_size = memory;
    tiff_limits.ifd_value_size = limits.metadata_bytes() as usize;
    tiff_limits
}

pub fn decode(
    input: &[u8],
    limits: &Limits,
    pixels: bool,
) -> Result<(Header, Option<DynamicImage>)> {
    prescan(input, limits)?;

    let mut decoder = image::codecs::tiff::TiffDecoder::new(Cursor::new(input))?;
    decoder.set_limits(limits.image_limits())?;
    let (width, height) = decoder.dimensions();
    limits.check_input(width, height)?;
    let header = Header {
        format: InputFormat::Tiff,
        width,
        height,
        has_alpha: decoder.color_type().has_alpha(),
        orientation: decoder.orientation()?,
        icc_profile: decoder.icc_profile()?,
    };
    if !pixels {
        return Ok((header, None));
    }
    limits.check_alloc(decoder.total_bytes())?;
    Ok((header, Some(DynamicImage::from_decoder(decoder)?)))
}
