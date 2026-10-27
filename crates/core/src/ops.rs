//! Pixel operations. Images are always one of `ImageLuma8`, `ImageLumaA8`, `ImageRgb8`, or
//! `ImageRgba8` (see [`crate::decode::normalize`]).

use image::imageops::{self, FilterType};
use image::{DynamicImage, ImageBuffer, Pixel};

use crate::error::Result;
use crate::limits::Limits;
use crate::orientation::Transform;

/// The filters that `image` implements, named like sharp's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kernel {
    Nearest,
    Linear,
    Cubic,
    Lanczos3,
}

/// Like sharp's `fit: 'cover'` (its default): the aspect ratio is kept, and if both dimensions are
/// given, the excess is cropped, centered.
#[derive(Clone, Debug)]
pub struct ResizeSpec {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub kernel: Kernel,
    pub without_enlargement: bool,
    pub without_reduction: bool,
}

pub fn channels(img: &DynamicImage) -> u8 {
    img.color().channel_count()
}

/// Port of sharp's `ResolveShrink`, for `fit: 'cover'`. Returns `(horizontal, vertical)` shrink
/// factors, where values greater than one reduce the image.
fn resolve_shrink(
    (width, height): (u32, u32),
    (target_width, target_height): (Option<u32>, Option<u32>),
    without_enlargement: bool,
    without_reduction: bool,
) -> (f64, f64) {
    let (width, height) = (f64::from(width), f64::from(height));
    let mut shrink = match (target_width, target_height) {
        // The cropped axis shrinks less.
        (Some(tw), Some(th)) => (width / f64::from(tw)).min(height / f64::from(th)),
        (Some(tw), None) => width / f64::from(tw),
        (None, Some(th)) => height / f64::from(th),
        (None, None) => 1.0,
    };
    if without_reduction {
        shrink = shrink.min(1.0);
    } else if without_enlargement {
        shrink = shrink.max(1.0);
    }
    // Don't shrink an axis to zero.
    (shrink.min(width), shrink.min(height))
}

/// The scale to render a vector image at, given its natural size. Like sharp, this is the common
/// part of both axes' shrink factors, so that [`resize`] only has the rest left to do (if
/// anything).
pub fn vector_scale((width, height): (u32, u32), spec: &ResizeSpec, transform: Transform) -> f64 {
    let targets = transform.input_dims((spec.width, spec.height));
    if targets == (None, None) {
        return 1.0;
    }
    let (hshrink, vshrink) = resolve_shrink(
        (width, height),
        targets,
        spec.without_enlargement,
        spec.without_reduction,
    );
    1.0 / hshrink.min(vshrink)
}

fn scaled_dim(dim: u32, shrink: f64) -> f64 {
    (f64::from(dim) / shrink).round().max(1.0)
}

/// The output size on one axis, and how many input pixels it covers (all of them, unless it's
/// cropped to `target`).
fn crop_dim(dim: u32, target: Option<u32>, shrink: f64) -> (f64, u32) {
    let resized = scaled_dim(dim, shrink);
    match target {
        Some(target) if f64::from(target) < resized => {
            let cropped = (f64::from(target) * shrink).round() as u32;
            (f64::from(target), cropped.clamp(1, dim))
        }
        _ => (resized, dim),
    }
}

/// Resizes in the input frame, where `transform` is the rotation that will be applied afterwards.
/// The crop is centered, so it's the same in either frame.
pub fn resize(
    img: DynamicImage,
    spec: &ResizeSpec,
    transform: Transform,
    limits: &Limits,
) -> Result<DynamicImage> {
    let (width, height) = (img.width(), img.height());
    let (target_width, target_height) = transform.input_dims((spec.width, spec.height));
    if target_width.is_none() && target_height.is_none() {
        return Ok(img);
    }
    let (hshrink, vshrink) = resolve_shrink(
        (width, height),
        (target_width, target_height),
        spec.without_enlargement,
        spec.without_reduction,
    );
    // Crop before resizing, so that we don't resample pixels we're going to throw away.
    let (out_width, crop_width) = crop_dim(width, target_width, hshrink);
    let (out_height, crop_height) = crop_dim(height, target_height, vshrink);
    // Check before casting, in case of overflow.
    limits.check_output(out_width, out_height, channels(&img))?;
    let (out_width, out_height) = (out_width as u32, out_height as u32);
    let crop = (
        (width - crop_width) / 2,
        (height - crop_height) / 2,
        crop_width,
        crop_height,
    );
    if crop == (0, 0, width, height) && (out_width, out_height) == (width, height) {
        return Ok(img);
    }
    // `imageops::resize` resamples vertically first, into an RGBA `f32` buffer.
    limits.check_alloc(u64::from(crop_width) * u64::from(out_height) * 16)?;
    Ok(resample(img, crop, out_width, out_height, spec.kernel))
}

/// Uses `image`'s resampling, which is simple but not especially fast (no SIMD, and an `f32`
/// intermediate). If resizing proves to be a significant performance issue, consider a dedicated
/// crate like `fast_image_resize`.
fn resample(
    mut img: DynamicImage,
    crop: (u32, u32, u32, u32),
    width: u32,
    height: u32,
    kernel: Kernel,
) -> DynamicImage {
    fn resample_buffer<P: Pixel<Subpixel = u8> + 'static>(
        img: &ImageBuffer<P, Vec<u8>>,
        (x, y, crop_width, crop_height): (u32, u32, u32, u32),
        width: u32,
        height: u32,
        filter: FilterType,
    ) -> ImageBuffer<P, Vec<u8>> {
        let view = imageops::crop_imm(img, x, y, crop_width, crop_height);
        imageops::resize(&*view, width, height, filter)
    }

    let filter = match kernel {
        Kernel::Nearest => FilterType::Nearest,
        Kernel::Linear => FilterType::Triangle,
        Kernel::Cubic => FilterType::CatmullRom,
        Kernel::Lanczos3 => FilterType::Lanczos3,
    };
    // `imageops::resize` expects premultiplied alpha. Resampling straight alpha would bleed the
    // color of transparent pixels into their neighbors.
    premultiply_alpha(&mut img);
    let mut out: DynamicImage = match &img {
        DynamicImage::ImageLuma8(i) => resample_buffer(i, crop, width, height, filter).into(),
        DynamicImage::ImageLumaA8(i) => resample_buffer(i, crop, width, height, filter).into(),
        DynamicImage::ImageRgb8(i) => resample_buffer(i, crop, width, height, filter).into(),
        DynamicImage::ImageRgba8(i) => resample_buffer(i, crop, width, height, filter).into(),
        _ => unreachable!("images are normalized to 8 bits per channel after decoding"),
    };
    unpremultiply_alpha(&mut out);
    out
}

/// Applies `f(color, alpha)` to each color channel, if the image has alpha (which is last).
fn map_colors(img: &mut DynamicImage, f: impl Fn(u32, u32) -> u8) {
    fn map<const N: usize>(data: &mut [u8], f: impl Fn(u32, u32) -> u8) {
        for pixel in data.as_chunks_mut::<N>().0 {
            let alpha = u32::from(pixel[N - 1]);
            for c in &mut pixel[..N - 1] {
                *c = f(u32::from(*c), alpha);
            }
        }
    }
    match img {
        DynamicImage::ImageLumaA8(i) => map::<2>(i, f),
        DynamicImage::ImageRgba8(i) => map::<4>(i, f),
        _ => {}
    }
}

fn premultiply_alpha(img: &mut DynamicImage) {
    map_colors(img, |c, alpha| ((c * alpha + 127) / 255) as u8);
}

fn unpremultiply_alpha(img: &mut DynamicImage) {
    map_colors(img, |c, alpha| match alpha {
        0 => 0,
        _ => ((c * 255 + alpha / 2) / alpha).min(255) as u8,
    });
}

#[cfg(test)]
mod tests {
    use image::{GrayAlphaImage, GrayImage};

    use super::*;

    #[test]
    fn shrink() {
        let r = |w, h, tw, th| resolve_shrink((w, h), (tw, th), false, false);
        assert_eq!(r(1000, 500, Some(100), Some(100)), (5.0, 5.0));
        assert_eq!(r(1000, 500, Some(100), None), (10.0, 10.0));
        assert_eq!(r(1000, 500, None, Some(100)), (5.0, 5.0));
        assert_eq!(
            resolve_shrink((10, 10), (Some(20), Some(20)), true, false),
            (1.0, 1.0)
        );
        assert_eq!(
            resolve_shrink((10, 10), (Some(5), None), false, true),
            (1.0, 1.0)
        );
    }

    fn spec(width: u32, height: u32) -> ResizeSpec {
        ResizeSpec {
            width: Some(width),
            height: Some(height),
            kernel: Kernel::Nearest,
            without_enlargement: false,
            without_reduction: false,
        }
    }

    #[test]
    fn cover_crops_centered() {
        let img: DynamicImage = GrayImage::from_fn(4, 2, |x, _| image::Luma([x as u8])).into();
        let out = resize(img, &spec(2, 2), Transform::IDENTITY, &Limits::default()).unwrap();
        assert_eq!(out.as_bytes(), &[1, 2, 1, 2]);
    }

    #[test]
    fn premultiplies_alpha() {
        // A transparent white pixel next to an opaque black one.
        let img: DynamicImage = GrayAlphaImage::from_fn(2, 1, |x, _| {
            image::LumaA([255 - x as u8 * 255, x as u8 * 255])
        })
        .into();
        let mut spec = spec(1, 1);
        spec.height = None;
        spec.kernel = Kernel::Linear;
        let out = resize(img, &spec, Transform::IDENTITY, &Limits::default()).unwrap();
        // Half transparent, and still black.
        assert_eq!(out.as_bytes(), &[0, 128]);
    }
}
