//! Pixel operations. Images are always one of `ImageLuma8`, `ImageLumaA8`, `ImageRgb8`, or
//! `ImageRgba8` (see [`crate::decode::normalize`]).

use fast_image_resize::{self as fir, PixelType};
use image::{DynamicImage, GrayAlphaImage, GrayImage, RgbImage, RgbaImage};

use crate::error::{Error, Result};
use crate::limits::Limits;
use crate::orientation::Transform;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fit {
    Cover,
    Contain,
    Fill,
    Inside,
    Outside,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kernel {
    Nearest,
    Linear,
    Cubic,
    Mitchell,
    Lanczos2,
    Lanczos3,
}

#[derive(Clone, Debug)]
pub struct ResizeSpec {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fit: Fit,
    /// Where to crop (`Cover`) or embed (`Contain`), in the output frame. Each component is in
    /// `[0, 1]`, where `(0, 0)` is the top-left corner.
    pub gravity: (f64, f64),
    pub kernel: Kernel,
    pub without_enlargement: bool,
    pub without_reduction: bool,
    /// Straight (non-premultiplied) RGBA, used by `Contain`.
    pub background: [u8; 4],
}

pub fn channels(img: &DynamicImage) -> u8 {
    img.color().channel_count()
}

fn pixel_type(img: &DynamicImage) -> PixelType {
    match img {
        DynamicImage::ImageLuma8(_) => PixelType::U8,
        DynamicImage::ImageLumaA8(_) => PixelType::U8x2,
        DynamicImage::ImageRgb8(_) => PixelType::U8x3,
        DynamicImage::ImageRgba8(_) => PixelType::U8x4,
        _ => unreachable!("images are normalized to 8 bits per channel after decoding"),
    }
}

/// Builds an image with the same layout as `like`.
fn from_raw(like: &DynamicImage, width: u32, height: u32, data: Vec<u8>) -> DynamicImage {
    const MSG: &str = "buffer size matches dimensions";
    match channels(like) {
        1 => GrayImage::from_raw(width, height, data).expect(MSG).into(),
        2 => GrayAlphaImage::from_raw(width, height, data)
            .expect(MSG)
            .into(),
        3 => RgbImage::from_raw(width, height, data).expect(MSG).into(),
        _ => RgbaImage::from_raw(width, height, data).expect(MSG).into(),
    }
}

fn into_raw(img: DynamicImage) -> Vec<u8> {
    match img {
        DynamicImage::ImageLuma8(i) => i.into_raw(),
        DynamicImage::ImageLumaA8(i) => i.into_raw(),
        DynamicImage::ImageRgb8(i) => i.into_raw(),
        DynamicImage::ImageRgba8(i) => i.into_raw(),
        _ => unreachable!("images are normalized to 8 bits per channel after decoding"),
    }
}

/// Port of sharp's `ResolveShrink`. Returns `(horizontal, vertical)` shrink factors, where values
/// greater than one reduce the image.
fn resolve_shrink(
    (width, height): (u32, u32),
    (target_width, target_height): (Option<u32>, Option<u32>),
    fit: Fit,
    without_enlargement: bool,
    without_reduction: bool,
) -> (f64, f64) {
    let (width, height) = (f64::from(width), f64::from(height));
    let (mut hshrink, mut vshrink) = (1.0, 1.0);
    match (target_width, target_height) {
        (Some(tw), Some(th)) => {
            hshrink = width / f64::from(tw);
            vshrink = height / f64::from(th);
            match fit {
                Fit::Cover | Fit::Outside => {
                    let shrink = hshrink.min(vshrink);
                    (hshrink, vshrink) = (shrink, shrink);
                }
                Fit::Contain | Fit::Inside => {
                    let shrink = hshrink.max(vshrink);
                    (hshrink, vshrink) = (shrink, shrink);
                }
                Fit::Fill => {}
            }
        }
        (Some(tw), None) => {
            hshrink = width / f64::from(tw);
            if fit != Fit::Fill {
                vshrink = hshrink;
            }
        }
        (None, Some(th)) => {
            vshrink = height / f64::from(th);
            if fit != Fit::Fill {
                hshrink = vshrink;
            }
        }
        (None, None) => {}
    }
    if without_reduction {
        hshrink = hshrink.min(1.0);
        vshrink = vshrink.min(1.0);
    } else if without_enlargement {
        hshrink = hshrink.max(1.0);
        vshrink = vshrink.max(1.0);
    }
    // Don't shrink an axis to zero.
    (hshrink.min(width), vshrink.min(height))
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
        spec.fit,
        spec.without_enlargement,
        spec.without_reduction,
    );
    1.0 / hshrink.min(vshrink)
}

fn scaled_dim(dim: u32, shrink: f64) -> f64 {
    (f64::from(dim) / shrink).round().max(1.0)
}

/// Resizes in the input frame, where `transform` is the rotation that will be applied afterwards.
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
    let gravity = transform.input_gravity(spec.gravity);
    let (hshrink, vshrink) = resolve_shrink(
        (width, height),
        (target_width, target_height),
        spec.fit,
        spec.without_enlargement,
        spec.without_reduction,
    );
    let resized_width = scaled_dim(width, hshrink);
    let resized_height = scaled_dim(height, vshrink);
    // Check before casting: extreme aspect ratios with `outside` can overflow `u32`.
    limits.check_output(resized_width, resized_height, channels(&img))?;
    let (resized_width, resized_height) = (resized_width as u32, resized_height as u32);

    match (spec.fit, target_width, target_height) {
        (Fit::Cover, Some(tw), Some(th)) => {
            // Crop before resizing so that we don't resample pixels we're going to throw away.
            let out_width = tw.min(resized_width);
            let out_height = th.min(resized_height);
            let crop_width = (f64::from(out_width) * hshrink).min(f64::from(width));
            let crop_height = (f64::from(out_height) * vshrink).min(f64::from(height));
            let crop = fir::CropBox {
                left: (f64::from(width) - crop_width) * gravity.0,
                top: (f64::from(height) - crop_height) * gravity.1,
                width: crop_width,
                height: crop_height,
            };
            resample(img, out_width, out_height, Some(crop), spec.kernel)
        }
        (Fit::Contain, Some(tw), Some(th)) => {
            let resized = resample(img, resized_width, resized_height, None, spec.kernel)?;
            let (canvas_width, canvas_height) = (tw.max(resized_width), th.max(resized_height));
            // `embed` adds an alpha channel for transparent backgrounds.
            let adds_alpha = spec.background[3] != u8::MAX && !has_alpha(&resized);
            limits.check_output(
                f64::from(canvas_width),
                f64::from(canvas_height),
                channels(&resized) + u8::from(adds_alpha),
            )?;
            Ok(embed(
                resized,
                (canvas_width, canvas_height),
                gravity,
                spec.background,
            ))
        }
        _ => resample(img, resized_width, resized_height, None, spec.kernel),
    }
}

fn lanczos2(x: f64) -> f64 {
    fn sinc(x: f64) -> f64 {
        if x == 0.0 {
            1.0
        } else {
            let x = x * std::f64::consts::PI;
            x.sin() / x
        }
    }
    if (-2.0..2.0).contains(&x) {
        sinc(x) * sinc(x / 2.0)
    } else {
        0.0
    }
}

fn resample(
    img: DynamicImage,
    width: u32,
    height: u32,
    crop: Option<fir::CropBox>,
    kernel: Kernel,
) -> Result<DynamicImage> {
    if crop.is_none() && (width, height) == (img.width(), img.height()) {
        return Ok(img);
    }
    let pixel_type = pixel_type(&img);
    let src = fir::images::ImageRef::new(img.width(), img.height(), img.as_bytes(), pixel_type)
        .map_err(|e| Error::Internal(e.to_string()))?;
    let mut dst = fir::images::Image::new(width, height, pixel_type);

    let algorithm = match kernel {
        Kernel::Nearest => fir::ResizeAlg::Nearest,
        Kernel::Linear => fir::ResizeAlg::Convolution(fir::FilterType::Bilinear),
        Kernel::Cubic => fir::ResizeAlg::Convolution(fir::FilterType::CatmullRom),
        Kernel::Mitchell => fir::ResizeAlg::Convolution(fir::FilterType::Mitchell),
        Kernel::Lanczos2 => fir::ResizeAlg::Convolution(fir::FilterType::Custom(
            fir::Filter::new("Lanczos2", lanczos2, 2.0).expect("valid filter support"),
        )),
        Kernel::Lanczos3 => fir::ResizeAlg::Convolution(fir::FilterType::Lanczos3),
    };
    // Alpha is premultiplied during resampling by default.
    let mut options = fir::ResizeOptions::new().resize_alg(algorithm);
    if let Some(crop) = crop {
        options = options.crop(crop.left, crop.top, crop.width, crop.height);
    }
    fir::Resizer::new()
        .resize(&src, &mut dst, &options)
        .map_err(|e| Error::Internal(e.to_string()))?;
    Ok(from_raw(&img, width, height, dst.into_vec()))
}

fn has_alpha(img: &DynamicImage) -> bool {
    img.color().has_alpha()
}

fn luma([r, g, b, _]: [u8; 4]) -> u8 {
    // Rec. 709 coefficients.
    (0.2126 * f64::from(r) + 0.7152 * f64::from(g) + 0.0722 * f64::from(b)).round() as u8
}

/// Places `img` on a `canvas` filled with `background`, positioned by `gravity`.
fn embed(
    img: DynamicImage,
    (canvas_width, canvas_height): (u32, u32),
    gravity: (f64, f64),
    background: [u8; 4],
) -> DynamicImage {
    let (width, height) = (img.width(), img.height());
    if (width, height) == (canvas_width, canvas_height) {
        return img;
    }
    let img = if background[3] != u8::MAX && !has_alpha(&img) {
        match img {
            DynamicImage::ImageLuma8(_) => DynamicImage::ImageLumaA8(img.to_luma_alpha8()),
            _ => DynamicImage::ImageRgba8(img.to_rgba8()),
        }
    } else {
        img
    };
    let fill: Vec<u8> = match &img {
        DynamicImage::ImageLuma8(_) => vec![luma(background)],
        DynamicImage::ImageLumaA8(_) => vec![luma(background), background[3]],
        DynamicImage::ImageRgb8(_) => background[..3].to_vec(),
        _ => background.to_vec(),
    };

    let bpp = fill.len();
    let row_len = canvas_width as usize * bpp;
    let mut data = fill.repeat(canvas_width as usize * canvas_height as usize);
    let left = (f64::from(canvas_width - width) * gravity.0) as usize;
    let top = (f64::from(canvas_height - height) * gravity.1) as usize;
    let src_row_len = width as usize * bpp;
    for (y, src_row) in img.as_bytes().chunks_exact(src_row_len).enumerate() {
        let start = (top + y) * row_len + left * bpp;
        data[start..start + src_row_len].copy_from_slice(src_row);
    }
    from_raw(&img, canvas_width, canvas_height, data)
}

/// One separable blur pass, applied horizontally then vertically.
enum BlurPass {
    Box {
        radius: usize,
    },
    /// Fixed-point weights summing to `1 << WEIGHT_BITS`, centered.
    Kernel(Vec<u32>),
}

const WEIGHT_BITS: u32 = 12;

/// Below this, box blurs approximate a Gaussian poorly, and an exact kernel is cheap anyway.
const MIN_BOX_SIGMA: f64 = 3.0;

fn gaussian_kernel(sigma: f64) -> Vec<u32> {
    let radius = (3.0 * sigma).ceil() as i64;
    let weights: Vec<f64> = (-radius..=radius)
        .map(|i| (-((i * i) as f64) / (2.0 * sigma * sigma)).exp())
        .collect();
    let total: f64 = weights.iter().sum();
    let scale = f64::from(1u32 << WEIGHT_BITS) / total;
    let mut kernel: Vec<u32> = weights.iter().map(|w| (w * scale).round() as u32).collect();
    // Fix rounding so that a constant image stays constant.
    let sum: u32 = kernel.iter().sum();
    let center = radius as usize;
    kernel[center] = (kernel[center] + (1 << WEIGHT_BITS)).saturating_sub(sum);
    kernel
}

/// A Gaussian blur. For large `sigma`, approximates it with three box blurs so that the cost is
/// independent of `sigma`. With `sigma == None`, performs a single 3x3 box blur, like sharp's
/// `blur()` without arguments.
pub fn blur(img: DynamicImage, sigma: Option<f64>) -> Result<DynamicImage> {
    let passes: Vec<BlurPass> = match sigma {
        None => vec![BlurPass::Box { radius: 1 }],
        Some(sigma) if sigma < MIN_BOX_SIGMA => vec![BlurPass::Kernel(gaussian_kernel(sigma))],
        Some(sigma) => box_radii_for_gaussian(sigma, 3)
            .into_iter()
            .map(|radius| BlurPass::Box { radius })
            .collect(),
    };
    if img.width() == 0 || img.height() == 0 {
        return Ok(img);
    }

    let (width, height) = (img.width() as usize, img.height() as usize);
    let pixel_type = pixel_type(&img);
    let channels = usize::from(channels(&img));
    let alpha = has_alpha(&img);
    let mul_div = fir::MulDiv::new();
    // A zero-sized image with the same layout.
    let like = from_raw(&img, 0, 0, Vec::new());
    let mut buf = into_raw(img);
    let fir_err = |e: fir::ImageError| Error::Internal(e.to_string());
    let fir_buf_err = |e: fir::ImageBufferError| Error::Internal(e.to_string());

    // Blurring straight alpha would bleed the color of transparent pixels.
    if alpha {
        let mut view =
            fir::images::Image::from_slice_u8(width as u32, height as u32, &mut buf, pixel_type)
                .map_err(fir_buf_err)?;
        mul_div.multiply_alpha_inplace(&mut view).map_err(fir_err)?;
    }

    let mut tmp = vec![0u8; buf.len()];
    for pass in passes {
        match pass {
            BlurPass::Box { radius } => {
                box_blur_horizontal(&buf, &mut tmp, width, channels, radius);
                box_blur_vertical(&tmp, &mut buf, width, height, channels, radius);
            }
            BlurPass::Kernel(kernel) => {
                convolve_horizontal(&buf, &mut tmp, width, channels, &kernel);
                convolve_vertical(&tmp, &mut buf, width, height, channels, &kernel);
            }
        }
    }

    if alpha {
        let mut view =
            fir::images::Image::from_slice_u8(width as u32, height as u32, &mut buf, pixel_type)
                .map_err(fir_buf_err)?;
        mul_div.divide_alpha_inplace(&mut view).map_err(fir_err)?;
    }
    Ok(from_raw(&like, width as u32, height as u32, buf))
}

/// From "Fast Almost-Gaussian Filtering" (Kovesi, 2010).
fn box_radii_for_gaussian(sigma: f64, passes: usize) -> Vec<usize> {
    let n = passes as f64;
    let ideal_width = (12.0 * sigma * sigma / n + 1.0).sqrt();
    let mut lower = ideal_width.floor() as i64;
    if lower % 2 == 0 {
        lower -= 1;
    }
    let lower = lower.max(1);
    let upper = lower + 2;
    let lf = lower as f64;
    let m = ((12.0 * sigma * sigma - n * lf * lf - 4.0 * n * lf - 3.0 * n) / (-4.0 * lf - 4.0))
        .round()
        .max(0.0) as usize;
    (0..passes)
        .map(|i| if i < m { lower } else { upper })
        .map(|width| (width as usize - 1) / 2)
        .collect()
}

/// Sum of `values(clamp(i, 0, len - 1))` for `i` in `-radius..=radius`, i.e. the initial window,
/// with edge pixels repeated.
fn initial_window_sum(len: usize, radius: usize, value: impl Fn(usize) -> u32) -> u32 {
    let in_bounds = radius.min(len - 1);
    let mut sum = value(0) * radius as u32;
    for i in 0..=in_bounds {
        sum += value(i);
    }
    sum + value(len - 1) * (radius - in_bounds) as u32
}

fn box_blur_horizontal(src: &[u8], dst: &mut [u8], width: usize, channels: usize, radius: usize) {
    let div = (2 * radius + 1) as u32;
    let row_len = width * channels;
    for (src_row, dst_row) in src.chunks_exact(row_len).zip(dst.chunks_exact_mut(row_len)) {
        for ch in 0..channels {
            let value = |x: usize| u32::from(src_row[x * channels + ch]);
            let mut sum = initial_window_sum(width, radius, value);
            for x in 0..width {
                dst_row[x * channels + ch] = ((sum + div / 2) / div) as u8;
                sum += value((x + radius + 1).min(width - 1));
                sum -= value(x.saturating_sub(radius));
            }
        }
    }
}

fn box_blur_vertical(
    src: &[u8],
    dst: &mut [u8],
    width: usize,
    height: usize,
    channels: usize,
    radius: usize,
) {
    let div = (2 * radius + 1) as u32;
    let row_len = width * channels;
    let row = |y: usize| &src[y * row_len..(y + 1) * row_len];
    let mut sums: Vec<u32> = (0..row_len)
        .map(|i| initial_window_sum(height, radius, |y| u32::from(row(y)[i])))
        .collect();
    for (y, dst_row) in dst.chunks_exact_mut(row_len).enumerate() {
        let (next, prev) = (
            row((y + radius + 1).min(height - 1)),
            row(y.saturating_sub(radius)),
        );
        for i in 0..row_len {
            dst_row[i] = ((sums[i] + div / 2) / div) as u8;
            sums[i] = sums[i] + u32::from(next[i]) - u32::from(prev[i]);
        }
    }
}

fn convolve_horizontal(src: &[u8], dst: &mut [u8], width: usize, channels: usize, kernel: &[u32]) {
    let radius = kernel.len() / 2;
    let row_len = width * channels;
    let round = 1 << (WEIGHT_BITS - 1);
    for (src_row, dst_row) in src.chunks_exact(row_len).zip(dst.chunks_exact_mut(row_len)) {
        for x in 0..width {
            for ch in 0..channels {
                let mut sum = round;
                for (k, &weight) in kernel.iter().enumerate() {
                    let sx = (x + k).saturating_sub(radius).min(width - 1);
                    sum += weight * u32::from(src_row[sx * channels + ch]);
                }
                dst_row[x * channels + ch] = (sum >> WEIGHT_BITS) as u8;
            }
        }
    }
}

fn convolve_vertical(
    src: &[u8],
    dst: &mut [u8],
    width: usize,
    height: usize,
    channels: usize,
    kernel: &[u32],
) {
    let radius = kernel.len() / 2;
    let row_len = width * channels;
    let round = 1 << (WEIGHT_BITS - 1);
    let mut sums = vec![0u32; row_len];
    for (y, dst_row) in dst.chunks_exact_mut(row_len).enumerate() {
        sums.fill(round);
        for (k, &weight) in kernel.iter().enumerate() {
            let sy = (y + k).saturating_sub(radius).min(height - 1);
            let src_row = &src[sy * row_len..(sy + 1) * row_len];
            for (sum, &value) in sums.iter_mut().zip(src_row) {
                *sum += weight * u32::from(value);
            }
        }
        for (out, &sum) in dst_row.iter_mut().zip(&sums) {
            *out = (sum >> WEIGHT_BITS) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_radii() {
        // A Gaussian's variance is the sum of the box variances, `((2r + 1)^2 - 1) / 12`.
        for sigma in [MIN_BOX_SIGMA, 5.0, 20.0, 100.0, 1000.0] {
            let variance: f64 = box_radii_for_gaussian(sigma, 3)
                .into_iter()
                .map(|r| (((2 * r + 1) * (2 * r + 1)) as f64 - 1.0) / 12.0)
                .sum();
            let actual = variance.sqrt();
            assert!((actual - sigma).abs() / sigma < 0.1, "{sigma} vs {actual}");
        }
    }

    #[test]
    fn gaussian_kernel_sums_to_one() {
        for sigma in [0.3, 0.5, 1.0, 2.9] {
            let kernel = gaussian_kernel(sigma);
            assert_eq!(kernel.iter().sum::<u32>(), 1 << WEIGHT_BITS);
            assert_eq!(kernel.len() % 2, 1);
        }
    }

    #[test]
    fn small_sigma_blurs() {
        let img: DynamicImage = GrayImage::from_fn(5, 5, |x, y| {
            image::Luma([if (x, y) == (2, 2) { 255 } else { 0 }])
        })
        .into();
        let out = blur(img, Some(0.5)).unwrap();
        let center = out.as_bytes()[12];
        assert!(center < 255 && center > 100, "{center}");
        assert!(out.as_bytes()[11] > 0);
    }

    #[test]
    fn blur_preserves_constant_image() {
        let img: DynamicImage = RgbImage::from_pixel(17, 9, image::Rgb([10, 200, 30])).into();
        let out = blur(img.clone(), Some(4.0)).unwrap();
        assert_eq!(out.as_bytes(), img.as_bytes());
    }

    #[test]
    fn blur_large_radius() {
        let img: DynamicImage = GrayImage::from_fn(5, 3, |x, _| image::Luma([x as u8 * 50])).into();
        let out = blur(img, Some(1000.0)).unwrap();
        assert_eq!(out.width(), 5);
    }

    #[test]
    fn shrink() {
        let r = |w, h, tw, th, fit| resolve_shrink((w, h), (tw, th), fit, false, false);
        assert_eq!(r(1000, 500, Some(100), Some(100), Fit::Cover), (5.0, 5.0));
        assert_eq!(
            r(1000, 500, Some(100), Some(100), Fit::Inside),
            (10.0, 10.0)
        );
        assert_eq!(r(1000, 500, Some(100), None, Fit::Fill), (10.0, 1.0));
        assert_eq!(
            resolve_shrink((10, 10), (Some(20), Some(20)), Fit::Cover, true, false),
            (1.0, 1.0)
        );
    }

    #[test]
    fn cover_crops_with_gravity() {
        let img: DynamicImage = GrayImage::from_fn(4, 2, |x, _| image::Luma([x as u8])).into();
        let spec = |gravity| ResizeSpec {
            width: Some(2),
            height: Some(2),
            fit: Fit::Cover,
            gravity,
            kernel: Kernel::Nearest,
            without_enlargement: false,
            without_reduction: false,
            background: [0, 0, 0, 255],
        };
        let limits = Limits::default();
        let left = resize(img.clone(), &spec((0.0, 0.5)), Transform::IDENTITY, &limits).unwrap();
        assert_eq!(left.as_bytes(), &[0, 1, 0, 1]);
        let right = resize(img, &spec((1.0, 0.5)), Transform::IDENTITY, &limits).unwrap();
        assert_eq!(right.as_bytes(), &[2, 3, 2, 3]);
    }

    #[test]
    fn contain_embeds() {
        let img: DynamicImage = GrayImage::from_pixel(2, 1, image::Luma([255])).into();
        let spec = ResizeSpec {
            width: Some(2),
            height: Some(3),
            fit: Fit::Contain,
            gravity: (0.5, 0.0),
            kernel: Kernel::Nearest,
            without_enlargement: true,
            without_reduction: false,
            background: [0, 0, 0, 255],
        };
        let out = resize(img, &spec, Transform::IDENTITY, &Limits::default()).unwrap();
        assert_eq!((out.width(), out.height()), (2, 3));
        assert_eq!(out.as_bytes(), &[255, 255, 0, 0, 0, 0]);
    }
}
