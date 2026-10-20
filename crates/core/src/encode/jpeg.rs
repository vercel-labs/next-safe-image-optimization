use image::DynamicImage;
use jpeg_encoder::{ChromaSubsamplingMethod, ColorType, Encoder, SamplingFactor};

use crate::encode::{check_dimensions, flatten};
use crate::error::{Error, Result};

/// Always 4:2:0, with optimized Huffman tables, like sharp's defaults.
#[derive(Clone, Debug)]
pub struct JpegSpec {
    /// 1-100
    pub quality: u8,
    /// Encode with mozjpeg (C), with its defaults: progressive, with trellis quantization,
    /// overshoot deringing, scan optimization, and quantization table 3. Otherwise, a baseline
    /// JPEG with jpeg-encoder.
    pub mozjpeg: bool,
}

impl Default for JpegSpec {
    fn default() -> Self {
        // Same as sharp.
        Self {
            quality: 80,
            mozjpeg: false,
        }
    }
}

pub fn encode(img: DynamicImage, spec: &JpegSpec) -> Result<(Vec<u8>, u8)> {
    // libjpeg's `JPEG_MAX_DIMENSION` (mozjpeg aborts above it), like sharp.
    check_dimensions(&img, 65500, "JPEG")?;
    let img = flatten(img);
    let img = match img {
        DynamicImage::ImageLuma8(_) => img,
        _ => DynamicImage::ImageRgb8(img.into_rgb8()),
    };
    let out = if spec.mozjpeg {
        encode_mozjpeg(&img, spec)?
    } else {
        encode_jpeg_encoder(&img, spec)?
    };
    Ok((out, img.color().channel_count()))
}

fn encode_jpeg_encoder(img: &DynamicImage, spec: &JpegSpec) -> Result<Vec<u8>> {
    let color_type = match img {
        DynamicImage::ImageLuma8(_) => ColorType::Luma,
        _ => ColorType::Rgb,
    };
    let mut out = Vec::new();
    let mut encoder = Encoder::new(&mut out, spec.quality);
    encoder.set_optimized_huffman_tables(true);
    encoder.set_sampling_factor(SamplingFactor::F_2_2);
    encoder.set_chroma_subsampling_method(ChromaSubsamplingMethod::Average);
    encoder
        .encode(
            img.as_bytes(),
            img.width() as u16,
            img.height() as u16,
            color_type,
        )
        .map_err(|e| Error::Encode(e.to_string()))?;
    Ok(out)
}

/// mozjpeg reports errors by unwinding, which aborts the worker (`panic = "abort"`). They aren't
/// expected for images we produced, besides `malloc` failing.
fn encode_mozjpeg(img: &DynamicImage, spec: &JpegSpec) -> Result<Vec<u8>> {
    let error = |e: std::io::Error| Error::Encode(format!("mozjpeg: {e}"));
    // mozjpeg's defaults are its "max compression" profile, which is also sharp's mozjpeg preset.
    let mut compress = mozjpeg::Compress::new(match img {
        DynamicImage::ImageLuma8(_) => mozjpeg::ColorSpace::JCS_GRAYSCALE,
        _ => mozjpeg::ColorSpace::JCS_RGB,
    });
    compress.set_size(img.width() as usize, img.height() as usize);
    let table = mozjpeg_qtable(spec.quality);
    compress.set_luma_qtable(&table);
    compress.set_chroma_qtable(&table);

    let mut started = compress.start_compress(Vec::new()).map_err(error)?;
    started.write_scanlines(img.as_bytes()).map_err(error)?;
    started.finish().map_err(error)
}

/// mozjpeg's default (luma and chroma) table, scaled like `jpeg_set_quality(quality, TRUE)`, which
/// is what libvips calls. `Compress::set_quality` doesn't force baseline (8-bit) tables, so it
/// writes 16-bit tables at lower qualities.
fn mozjpeg_qtable(quality: u8) -> mozjpeg::qtable::QTable {
    // `jpeg_quality_scaling`, in percent.
    let quality = u32::from(quality.clamp(1, 100));
    let scale = if quality < 50 {
        5000 / quality
    } else {
        200 - quality * 2
    };
    // `scaled` takes a quality, and scales by `50 / quality` (below 50) or `(100 - quality) / 50`,
    // then rounds in `f32`. libjpeg rounds halves up, which the nudge preserves: other products are
    // at least 0.01 away from a half, and the nudge is at most 418 (the largest entry) * 0.00001.
    let scale = scale as f32 + 0.001;
    let quality = if scale >= 100.0 {
        5000.0 / scale
    } else {
        100.0 - scale / 2.0
    };
    mozjpeg::qtable::NRobidoux.scaled(quality, quality)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mozjpeg_qtable_matches_libjpeg() {
        let base = unsafe { std::slice::from_raw_parts(mozjpeg::qtable::NRobidoux.as_ptr(), 64) };
        for quality in 1..=100 {
            let scale = if quality < 50 {
                5000 / quality
            } else {
                200 - quality * 2
            };
            // `jpeg_add_quant_table` with `force_baseline`.
            let expected = base.iter().map(|&c| ((c * scale + 50) / 100).clamp(1, 255));
            let table = mozjpeg_qtable(quality as u8);
            let actual = unsafe { std::slice::from_raw_parts(table.as_ptr(), 64) };
            assert!(expected.eq(actual.iter().copied()), "quality {quality}");
        }
    }

    fn decode(jpeg: &[u8]) -> DynamicImage {
        image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).unwrap()
    }

    #[test]
    fn mozjpeg_encodes() {
        let img = DynamicImage::ImageRgb8(image::RgbImage::from_fn(67, 33, |x, y| {
            image::Rgb([(x * 3) as u8, (y * 7) as u8, 128])
        }));
        let spec = JpegSpec {
            mozjpeg: true,
            ..JpegSpec::default()
        };
        let (jpeg, channels) = encode(img.clone(), &spec).unwrap();
        assert_eq!(channels, 3);
        let decoded = decode(&jpeg).into_rgb8();
        assert_eq!(decoded.dimensions(), (67, 33));
        let error = decoded
            .pixels()
            .zip(img.as_rgb8().unwrap().pixels())
            .flat_map(|(a, b)| a.0.into_iter().zip(b.0))
            .map(|(a, b)| u32::from(a.abs_diff(b)))
            .max()
            .unwrap();
        assert!(error < 16, "max error {error}");

        let gray = DynamicImage::ImageLuma8(image::GrayImage::new(9, 9));
        let (jpeg, channels) = encode(gray, &spec).unwrap();
        assert_eq!(channels, 1);
        assert_eq!(decode(&jpeg).color(), image::ColorType::L8);
    }
}
