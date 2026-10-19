//! JPEG via zune-jpeg directly, because `image` doesn't let us lower the progressive scan limit or
//! enforce a memory limit.

use image::DynamicImage;
use zune_jpeg::JpegDecoder;
use zune_jpeg::zune_core::bytestream::ZCursor;
use zune_jpeg::zune_core::colorspace::ColorSpace;
use zune_jpeg::zune_core::options::DecoderOptions;

use crate::decode::{Header, InputFormat, alloc, from_raw_u8, orientation_from_exif};
use crate::error::{Error, Result};
use crate::limits::Limits;

/// Every progressive scan is a pass over the whole image, even if the scan contains no data, so a
/// tiny file can force `scans * pixels` work. Common encoders emit about 10 scans. zune-jpeg's
/// default is 100.
const MAX_SCANS: usize = 32;

/// zune-jpeg does work quadratic in the number of extended XMP (APP1) segments, because it re-sorts
/// them after every marker. Real files have a handful of APP1 segments; this is generous.
const MAX_APP1_MARKERS: usize = 4096;

struct Scan {
    sos_markers: usize,
}

/// Counts marker byte pairs anywhere in the input, which is an upper bound on what any parser can
/// see: entropy-coded data can't contain them, and payloads only add false positives. (Walking the
/// segment structure instead would have to match zune-jpeg's parser exactly, or an attacker could
/// hide segments from us.) Linear in the input size.
fn prescan(data: &[u8]) -> Result<Scan> {
    let mut app1_markers = 0;
    let mut sos_markers = 0;
    for pair in data.windows(2) {
        match pair {
            [0xFF, 0xE1] => app1_markers += 1,
            [0xFF, 0xDA] => sos_markers += 1,
            _ => {}
        }
    }
    if app1_markers > MAX_APP1_MARKERS {
        return Err(Error::LimitExceeded(format!(
            "JPEG has more than {MAX_APP1_MARKERS} APP1 segments"
        )));
    }
    Ok(Scan { sos_markers })
}

fn map_err(err: zune_jpeg::errors::DecodeErrors) -> Error {
    Error::Decode(format!("{err:?}"))
}

pub fn decode(
    input: &[u8],
    limits: &Limits,
    pixels: bool,
) -> Result<(Header, Option<DynamicImage>)> {
    let scan = prescan(input)?;

    // An axis can't be longer than the pixel limit. The actual pixel limit is checked after parsing
    // the headers.
    let max_dim = usize::try_from(limits.input_pixels).unwrap_or(usize::MAX);
    let options = DecoderOptions::default()
        .set_max_width(max_dim)
        .set_max_height(max_dim)
        .set_strict_mode(false)
        .jpeg_set_max_scans(MAX_SCANS);
    let mut decoder = JpegDecoder::new_with_options(ZCursor::new(input), options);
    decoder.decode_headers().map_err(map_err)?;
    let info = decoder
        .info()
        .ok_or_else(|| Error::Decode("missing JPEG header".into()))?;
    let (width, height) = (u32::from(info.width), u32::from(info.height));
    limits.check_input(width, height)?;

    // CMYK and YCCK are converted to RGB naively. We ignore CMYK ICC profiles (see `color.rs`).
    let grayscale = decoder.input_colorspace() == Some(ColorSpace::Luma);
    let header = Header {
        format: InputFormat::Jpeg,
        width,
        height,
        has_alpha: false,
        orientation: orientation_from_exif(decoder.exif().map(Vec::as_slice)),
        icc_profile: decoder.icc_profile(),
    };
    if !pixels {
        return Ok((header, None));
    }

    let out_colorspace = if grayscale {
        ColorSpace::Luma
    } else {
        ColorSpace::RGB
    };
    decoder.set_options(options.jpeg_set_out_colorspace(out_colorspace));
    let channels = out_colorspace.num_components() as u8;
    let out_bytes = width as usize * height as usize * usize::from(channels);

    // Progressive and multi-scan images buffer i16 DCT coefficients for every component, padded
    // to whole MCUs.
    if info.sof.is_progressive() || scan.sos_markers > 1 {
        let padded = |dim: u32| u64::from(dim.div_ceil(16) * 16);
        let coefficient_bytes = padded(width) * padded(height) * u64::from(info.components) * 2;
        limits.check_alloc(out_bytes as u64 + coefficient_bytes)?;
    }
    let mut buf = alloc(limits, out_bytes)?;
    decoder.decode_into(&mut buf).map_err(map_err)?;
    Ok((header, Some(from_raw_u8(width, height, channels, buf)?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(marker: u8, payload: &[u8]) -> Vec<u8> {
        let len = (payload.len() + 2) as u16;
        let mut out = vec![0xFF, marker];
        out.extend_from_slice(&len.to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn prescan_counts_scans() {
        let mut data = vec![0xFF, 0xD8];
        data.extend(segment(0xDA, &[0; 4]));
        data.extend([0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56]);
        data.extend(segment(0xDA, &[0; 4]));
        data.extend([0xFF, 0xD9]);
        assert_eq!(prescan(&data).unwrap().sos_markers, 2);
    }

    #[test]
    fn prescan_rejects_excessive_app1_segments() {
        // Hiding segments inside another segment's payload doesn't help, unlike with a parser.
        let mut hidden = Vec::new();
        for _ in 0..=MAX_APP1_MARKERS {
            hidden.extend(segment(0xE1, b"x"));
        }
        let mut data = vec![0xFF, 0xD8, 0xFF, 0xD0, 0x00, 0x06];
        let (inside, outside) = hidden.split_at(hidden.len() / 2);
        data.extend(segment(0xE1, inside));
        data.extend(outside);
        assert!(matches!(prescan(&data), Err(Error::LimitExceeded(_))));
    }
}
