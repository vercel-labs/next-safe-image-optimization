//! WebP via image-webp directly, so that we can set a memory limit. Without one, metadata chunks
//! are allocated based on their declared size (up to 4 GiB) before being read.
//!
//! Known gap: the lossless (VP8L) decoder can allocate Huffman tables disproportionate to the input
//! size, and isn't bounded by the memory limit.

use std::io::Cursor;

use image::DynamicImage;
use image_webp::{DecodingError, WebPDecoder};

use crate::decode::{Header, InputFormat, alloc, from_raw_u8, orientation_from_exif};
use crate::error::{Error, Result};
use crate::limits::Limits;

fn map_err(err: DecodingError) -> Error {
    match err {
        DecodingError::MemoryLimitExceeded => {
            Error::LimitExceeded("WebP metadata exceeds the size limit".into())
        }
        err => Error::Decode(err.to_string()),
    }
}

fn u24(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], 0])
}

/// Iterates over RIFF chunks as `(fourcc, payload)`, stopping at the first malformed chunk.
fn chunks(mut data: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> {
    std::iter::from_fn(move || {
        let header = data.get(..8)?;
        let size = u32::from_le_bytes(header[4..8].try_into().unwrap()) as usize;
        let payload = data.get(8..8usize.checked_add(size)?)?;
        let fourcc = &header[..4];
        // Chunks are padded to an even size.
        data = data.get(8 + size + (size & 1)..).unwrap_or_default();
        Some((fourcc, payload))
    })
}

/// The dimensions declared by a VP8 or VP8L bitstream header.
fn bitstream_dims(fourcc: &[u8], payload: &[u8]) -> Option<(u32, u32)> {
    match fourcc {
        b"VP8 " => {
            let header = payload.get(..10)?;
            let width = u32::from(u16::from_le_bytes([header[6], header[7]]) & 0x3FFF);
            let height = u32::from(u16::from_le_bytes([header[8], header[9]]) & 0x3FFF);
            Some((width, height))
        }
        b"VP8L" => {
            let header = payload.get(..5)?;
            let bits = u32::from_le_bytes(header[1..5].try_into().unwrap());
            Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1))
        }
        _ => None,
    }
}

/// image-webp checks the canvas size from the VP8X header against our limits, but allocates and
/// decodes using the sizes from the bitstream headers, and only compares them afterwards. A 1x1
/// canvas could otherwise contain a 16383x16383 frame. Checks the first frame, which is the only
/// one we decode.
fn check_frame_dims(input: &[u8], (width, height): (u32, u32)) -> Result<()> {
    let mismatch = || Error::Decode("WebP frame size doesn't match the canvas".into());
    for (fourcc, payload) in chunks(input.get(12..).unwrap_or_default()) {
        if let Some(dims) = bitstream_dims(fourcc, payload) {
            return if dims == (width, height) {
                Ok(())
            } else {
                Err(mismatch())
            };
        }
        if fourcc == b"ANMF" {
            let header = payload.get(..16).ok_or_else(mismatch)?;
            let (x, y) = (u24(&header[0..3]) * 2, u24(&header[3..6]) * 2);
            let frame = (u24(&header[6..9]) + 1, u24(&header[9..12]) + 1);
            if x + frame.0 > width || y + frame.1 > height {
                return Err(mismatch());
            }
            let dims = chunks(&payload[16..]).find_map(|(fourcc, p)| bitstream_dims(fourcc, p));
            return if dims.is_none_or(|dims| dims == frame) {
                Ok(())
            } else {
                Err(mismatch())
            };
        }
    }
    Ok(())
}

pub fn decode(
    input: &[u8],
    limits: &Limits,
    pixels: bool,
) -> Result<(Header, Option<DynamicImage>)> {
    let mut decoder = WebPDecoder::new(Cursor::new(input)).map_err(map_err)?;
    decoder.set_memory_limit(limits.metadata_bytes() as usize);
    let (width, height) = decoder.dimensions();
    limits.check_input(width, height)?;

    let has_alpha = decoder.has_alpha();
    let exif = decoder.exif_metadata().map_err(map_err)?;
    let header = Header {
        format: InputFormat::Webp,
        width,
        height,
        has_alpha,
        orientation: orientation_from_exif(exif.as_deref()),
        icc_profile: decoder.icc_profile().map_err(map_err)?,
    };
    if !pixels {
        return Ok((header, None));
    }

    check_frame_dims(input, (width, height))?;
    let size = decoder
        .output_buffer_size()
        .ok_or_else(|| Error::LimitExceeded("WebP is too large".into()))?;
    let pixels = u64::from(width) * u64::from(height);
    // Lossy images are decoded into YUV planes first (1.5 bytes per pixel), and lossless images
    // without alpha into a temporary RGBA buffer. Animations also decode the frame separately from
    // the canvas.
    let scratch = if decoder.is_lossy() {
        pixels * 3 / 2
    } else {
        pixels * 4
    };
    let animation = if decoder.is_animated() { pixels * 4 } else { 0 };
    limits.check_alloc(size as u64 + scratch + animation)?;
    let mut buf = alloc(limits, size)?;
    // For animations, this is the first frame composited onto the canvas.
    decoder.read_image(&mut buf).map_err(map_err)?;
    let channels = if has_alpha { 4 } else { 3 };
    Ok((header, Some(from_raw_u8(width, height, channels, buf)?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(fourcc: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = fourcc.to_vec();
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(payload);
        if payload.len() % 2 == 1 {
            out.push(0);
        }
        out
    }

    fn vp8_payload(width: u16, height: u16) -> Vec<u8> {
        let mut payload = vec![0, 0, 0, 0x9D, 0x01, 0x2A];
        payload.extend_from_slice(&width.to_le_bytes());
        payload.extend_from_slice(&height.to_le_bytes());
        payload
    }

    fn webp(chunks: &[Vec<u8>]) -> Vec<u8> {
        let mut out = b"RIFF\0\0\0\0WEBP".to_vec();
        for c in chunks {
            out.extend_from_slice(c);
        }
        out
    }

    #[test]
    fn frame_dims() {
        let vp8x = chunk(b"VP8X", &[0; 10]);
        let input = webp(&[vp8x.clone(), chunk(b"VP8 ", &vp8_payload(100, 50))]);
        assert!(check_frame_dims(&input, (100, 50)).is_ok());
        assert!(check_frame_dims(&input, (1, 1)).is_err());

        // VP8L: signature, then 14-bit (width - 1) and (height - 1).
        let bits: u32 = 99 | (49 << 14);
        let mut vp8l = vec![0x2F];
        vp8l.extend_from_slice(&bits.to_le_bytes());
        let input = webp(&[vp8x.clone(), chunk(b"VP8L", &vp8l)]);
        assert!(check_frame_dims(&input, (100, 50)).is_ok());
        assert!(check_frame_dims(&input, (100, 49)).is_err());

        // ANMF: a 10x10 frame at (4, 2), containing a bitstream of the wrong size.
        let mut anmf = vec![2, 0, 0, 1, 0, 0, 9, 0, 0, 9, 0, 0, 0, 0, 0, 0];
        anmf.extend(chunk(b"VP8 ", &vp8_payload(10, 10)));
        let input = webp(&[vp8x.clone(), chunk(b"ANIM", &[0; 6]), chunk(b"ANMF", &anmf)]);
        assert!(check_frame_dims(&input, (14, 12)).is_ok());
        assert!(check_frame_dims(&input, (13, 12)).is_err());
        anmf.truncate(16);
        anmf.extend(chunk(b"VP8 ", &vp8_payload(16383, 16383)));
        let input = webp(&[vp8x, chunk(b"ANMF", &anmf)]);
        assert!(check_frame_dims(&input, (14, 12)).is_err());
    }
}
