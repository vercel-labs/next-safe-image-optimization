//! Encoders. Encoders only ever see pixel buffers that we produced, so they aren't sandboxed.
//! Metadata (EXIF, ICC, etc.) is never written: output is always untagged sRGB.

mod gif;
mod jpeg;
mod png;
mod webp;

use image::DynamicImage;
use serde::{Deserialize, Serialize};
use typeshare_annotation::typeshare;

pub use self::gif::GifSpec;
pub use self::jpeg::JpegSpec;
pub use self::png::PngSpec;
pub use self::webp::WebpSpec;
use crate::error::{Error, Result};
use crate::limits::Limits;

#[typeshare]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Jpeg,
    Png,
    Webp,
    Gif,
}

#[derive(Clone, Debug)]
pub enum OutputSpec {
    Jpeg(JpegSpec),
    Png(PngSpec),
    Webp(WebpSpec),
    Gif(GifSpec),
}

impl OutputSpec {
    pub fn format(&self) -> OutputFormat {
        match self {
            OutputSpec::Jpeg(_) => OutputFormat::Jpeg,
            OutputSpec::Png(_) => OutputFormat::Png,
            OutputSpec::Webp(_) => OutputFormat::Webp,
            OutputSpec::Gif(_) => OutputFormat::Gif,
        }
    }
}

pub struct Encoded {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub channels: u8,
}

/// Roughly how many bytes per pixel the C encoders (libwebp and mozjpeg) allocate, on top of the
/// image itself and their output. They allocate with `malloc`, so the worker's allocator doesn't
/// count it, and `limitProcessMemory` isn't enforced everywhere. The other encoders are Rust, so
/// the allocator limits them. Measured with peak RSS on noisy 16 MP images, rounded up.
fn c_encoder_bytes_per_pixel(img: &DynamicImage, spec: &OutputSpec) -> u64 {
    match spec {
        // Its ARGB copy, plus YUV planes for lossy. Lossless needs hash chains and backward
        // references. Lossy alpha is compressed losslessly, with more memory at higher efforts.
        OutputSpec::Webp(spec) if spec.lossless || spec.near_lossless => 42,
        OutputSpec::Webp(spec) if img.color().has_alpha() => {
            if spec.effort <= 4 {
                32
            } else {
                44
            }
        }
        OutputSpec::Webp(_) => 10,
        // Trellis quantization keeps the whole image's DCT coefficients. Scan optimization also
        // buffers each candidate scan, which grows with quality.
        OutputSpec::Jpeg(spec) if spec.mozjpeg => {
            if matches!(img.color(), image::ColorType::L8 | image::ColorType::La8) {
                12
            } else {
                16
            }
        }
        _ => 0,
    }
}

pub fn encode(img: DynamicImage, spec: &OutputSpec, limits: &Limits) -> Result<Encoded> {
    let (width, height) = (img.width(), img.height());
    let pixels = u64::from(width) * u64::from(height);
    limits.check_alloc(pixels.saturating_mul(c_encoder_bytes_per_pixel(&img, spec)))?;
    let (data, channels) = match spec {
        OutputSpec::Jpeg(spec) => jpeg::encode(img, spec)?,
        OutputSpec::Png(spec) => png::encode(&img, spec)?,
        OutputSpec::Webp(spec) => webp::encode(img, spec)?,
        OutputSpec::Gif(spec) => gif::encode(img, spec)?,
    };
    Ok(Encoded {
        data,
        width,
        height,
        channels,
    })
}

/// Composites onto black and drops the alpha channel, like sharp/libvips does for formats without
/// alpha. Compositing onto black is the same as premultiplying.
fn flatten(img: DynamicImage) -> DynamicImage {
    let premultiply = |c: u8, a: u8| ((u16::from(c) * u16::from(a) + 127) / 255) as u8;
    match img {
        DynamicImage::ImageRgba8(img) => {
            let mut out = image::RgbImage::new(img.width(), img.height());
            for (dst, src) in out.pixels_mut().zip(img.pixels()) {
                let [r, g, b, a] = src.0;
                dst.0 = [premultiply(r, a), premultiply(g, a), premultiply(b, a)];
            }
            out.into()
        }
        DynamicImage::ImageLumaA8(img) => {
            let mut out = image::GrayImage::new(img.width(), img.height());
            for (dst, src) in out.pixels_mut().zip(img.pixels()) {
                let [l, a] = src.0;
                dst.0 = [premultiply(l, a)];
            }
            out.into()
        }
        img => img,
    }
}

fn check_dimensions(img: &DynamicImage, max: u32, format: &str) -> Result<()> {
    if img.width() > max || img.height() > max {
        return Err(Error::LimitExceeded(format!(
            "{format} images can be at most {max}x{max}, got {}x{}",
            img.width(),
            img.height()
        )));
    }
    Ok(())
}
