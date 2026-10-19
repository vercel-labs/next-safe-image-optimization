//! Encoders. Encoders only ever see pixel buffers that we produced, so they aren't sandboxed.
//! Metadata (EXIF, ICC, etc.) is never written: output is always untagged sRGB.

mod gif;
mod jpeg;
mod png;
mod webp;

use image::DynamicImage;

pub use self::gif::GifSpec;
pub use self::jpeg::{JpegSpec, QuantizationTable};
pub use self::png::PngSpec;
pub use self::webp::WebpSpec;
use crate::error::{Error, Result};
use crate::limits::Limits;

#[derive(Clone, Debug)]
pub enum OutputSpec {
    Jpeg(JpegSpec),
    Png(PngSpec),
    Webp(WebpSpec),
    Gif(GifSpec),
}

impl OutputSpec {
    pub fn format_name(&self) -> &'static str {
        match self {
            OutputSpec::Jpeg(_) => "jpeg",
            OutputSpec::Png(_) => "png",
            OutputSpec::Webp(_) => "webp",
            OutputSpec::Gif(_) => "gif",
        }
    }
}

pub struct Encoded {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub channels: u8,
}

/// Roughly how many bytes per pixel an encoder allocates, on top of the image itself. Measured with
/// peak RSS on noisy 16 MP images, rounded up.
fn bytes_per_pixel(img: &DynamicImage, spec: &OutputSpec) -> u64 {
    let has_alpha = img.color().has_alpha();
    let channels = u64::from(img.color().channel_count());
    match spec {
        // Flattening or converting to RGB, then a `u8` plane and `i16` coefficients per component.
        OutputSpec::Jpeg(_) => match img {
            DynamicImage::ImageLuma8(_) => 3,
            DynamicImage::ImageRgb8(_) => 9 + 2,
            _ => 3 + 9 + 2,
        },
        // Output can be about as large as the input, and the output buffer grows by doubling.
        OutputSpec::Png(_) => 2 * channels,
        // libwebp's ARGB copy, plus YUV planes for lossy. Lossless needs hash chains and backward
        // references. Lossy alpha is compressed losslessly, with more memory at higher efforts.
        OutputSpec::Webp(spec) if spec.lossless || spec.near_lossless => 42,
        OutputSpec::Webp(spec) if has_alpha => {
            if spec.effort <= 4 {
                32
            } else {
                44
            }
        }
        OutputSpec::Webp(_) => 10,
        // An RGBA copy, palette indices, and the output.
        OutputSpec::Gif(_) => 6,
    }
}

pub fn encode(img: DynamicImage, spec: &OutputSpec, limits: &Limits) -> Result<Encoded> {
    let (width, height) = (img.width(), img.height());
    let pixels = u64::from(width) * u64::from(height);
    limits.check_alloc(pixels.saturating_mul(bytes_per_pixel(&img, spec)))?;
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
