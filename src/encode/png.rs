use image::DynamicImage;
use png::{BitDepth, ColorType, DeflateCompression, Encoder, Filter};

use crate::error::{Error, Result};

#[derive(Clone, Debug)]
pub struct PngSpec {
    /// zlib compression level, 0-9.
    pub compression_level: u8,
    pub adaptive_filtering: bool,
}

impl Default for PngSpec {
    fn default() -> Self {
        Self {
            compression_level: 6,
            // sharp defaults to `false`, but sharp's `quality` option enables palette quantization
            // (which works best without filtering). We only produce truecolor output, which almost
            // always benefits from filtering.
            adaptive_filtering: true,
        }
    }
}

fn map_err(err: impl std::fmt::Display) -> Error {
    Error::Encode(err.to_string())
}

pub fn encode(img: &DynamicImage, spec: &PngSpec) -> Result<(Vec<u8>, u8)> {
    let (color_type, channels) = match img {
        DynamicImage::ImageLuma8(_) => (ColorType::Grayscale, 1),
        DynamicImage::ImageLumaA8(_) => (ColorType::GrayscaleAlpha, 2),
        DynamicImage::ImageRgb8(_) => (ColorType::Rgb, 3),
        _ => (ColorType::Rgba, 4),
    };
    let mut out = Vec::new();
    let mut encoder = Encoder::new(&mut out, img.width(), img.height());
    encoder.set_color(color_type);
    encoder.set_depth(BitDepth::Eight);
    encoder.set_deflate_compression(match spec.compression_level {
        0 => DeflateCompression::NoCompression,
        level => DeflateCompression::Level(level),
    });
    encoder.set_filter(if spec.adaptive_filtering {
        Filter::Adaptive
    } else {
        Filter::NoFilter
    });

    let mut writer = encoder.write_header().map_err(map_err)?;
    {
        let mut stream = writer.stream_writer().map_err(map_err)?;
        std::io::Write::write_all(&mut stream, img.as_bytes()).map_err(map_err)?;
        stream.finish().map_err(map_err)?;
    }
    writer.finish().map_err(map_err)?;
    Ok((out, channels))
}
