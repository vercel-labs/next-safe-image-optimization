//! AVIF via `image`'s encoder: ravif, which encodes with rav1e (Rust, without asm or threads).
//! Always 8-bit 4:4:4 YCbCr, plus a separate alpha plane if any pixel isn't opaque.

use image::codecs::avif::AvifEncoder;
use image::{DynamicImage, ImageEncoder};

use crate::encode::check_dimensions;
use crate::error::{Error, Result};

#[derive(Clone, Debug)]
pub struct AvifSpec {
    /// 1-100, on ravif's scale (for both color and alpha), which isn't libaom's. Measured with
    /// SSIMULACRA2 on the Kodak photos, sharp's 50 matches ravif's 70, 70 matches 88, and 80
    /// matches 91.
    pub quality: u8,
    /// 0 (fastest) to 9 (slowest), like sharp's. ravif's speed is `10 - effort`.
    pub effort: u8,
}

impl Default for AvifSpec {
    fn default() -> Self {
        // Like sharp's defaults (quality 50 on libaom's scale).
        Self {
            quality: 70,
            effort: 4,
        }
    }
}

pub fn encode(img: DynamicImage, spec: &AvifSpec) -> Result<(Vec<u8>, u8)> {
    // rav1e rejects larger frames (`InvalidWidth`/`InvalidHeight`).
    check_dimensions(&img, u32::from(u16::MAX), "AVIF")?;
    let has_alpha = img.color().has_alpha();
    let mut out = Vec::new();
    // One thread also means one tile. Otherwise, ravif sizes tiles by the CPU count (which it can't
    // read in the sandbox), and the output would depend on the machine.
    AvifEncoder::new_with_speed_quality(&mut out, 10 - spec.effort.min(9), spec.quality)
        .with_num_threads(Some(1))
        .write_image(
            img.as_bytes(),
            img.width(),
            img.height(),
            img.color().into(),
        )
        .map_err(|e| Error::Encode(e.to_string()))?;
    // Grayscale is encoded as color. Like WebP's, this is the alpha channel we encoded, even if ravif
    // dropped it for being opaque.
    Ok((out, if has_alpha { 4 } else { 3 }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode;
    use crate::limits::Limits;

    fn round_trip(img: DynamicImage) -> (DynamicImage, u8) {
        let (avif, channels) = encode(img, &AvifSpec::default()).unwrap();
        let decoded = decode::decode(&avif, &Limits::default(), |_, _| 1.0).unwrap();
        assert_eq!(decoded.header.format, decode::InputFormat::Avif);
        (decoded.image, channels)
    }

    fn max_error(a: &[u8], b: &[u8]) -> u8 {
        assert_eq!(a.len(), b.len());
        a.iter().zip(b).map(|(a, b)| a.abs_diff(*b)).max().unwrap()
    }

    #[test]
    fn encodes_rgb() {
        // Odd dimensions, smooth gradients.
        let img = image::RgbImage::from_fn(67, 33, |x, y| {
            image::Rgb([(x * 3) as u8, (y * 7) as u8, 128])
        });
        let (decoded, channels) = round_trip(img.clone().into());
        assert_eq!(channels, 3);
        let decoded = decoded.into_rgb8();
        assert_eq!(decoded.dimensions(), (67, 33));
        let error = max_error(&decoded, &img);
        assert!(error < 24, "max error {error}");
    }

    #[test]
    fn encodes_alpha() {
        let img =
            image::RgbaImage::from_fn(40, 30, |x, _| image::Rgba([200, 100, 50, (x * 6) as u8]));
        let (decoded, channels) = round_trip(img.clone().into());
        assert_eq!(channels, 4);
        assert!(decoded.color().has_alpha());
        let decoded = decoded.into_rgba8();
        let alpha = |img: &image::RgbaImage| img.pixels().map(|p| p.0[3]).collect::<Vec<_>>();
        let error = max_error(&alpha(&decoded), &alpha(&img));
        assert!(error < 16, "max alpha error {error}");
    }

    #[test]
    fn encodes_gray() {
        let img = image::GrayImage::from_fn(16, 16, |x, y| image::Luma([(x * 16 + y) as u8]));
        let (decoded, channels) = round_trip(img.into());
        assert_eq!(channels, 3);
        assert_eq!((decoded.width(), decoded.height()), (16, 16));
        assert!(!decoded.color().has_alpha());
    }

    #[test]
    fn rejects_large_dimensions() {
        let img = DynamicImage::ImageLuma8(image::GrayImage::new(65536, 1));
        let err = encode(img, &AvifSpec::default()).unwrap_err();
        assert!(matches!(err, Error::LimitExceeded(_)), "{err}");
    }
}
