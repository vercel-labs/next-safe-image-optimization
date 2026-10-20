//! Converts images with embedded ICC profiles to sRGB, like sharp does by default. Output images
//! never carry an ICC profile, so this is required for wide-gamut (e.g. Display P3) inputs to
//! render correctly.
//!
//! `image` only supports CICP color spaces, so this uses moxcms (which `image` already depends on)
//! directly. moxcms's default parsing options reject profiles over 10 MB and cap LUT sizes.

use image::DynamicImage;
use moxcms::{ColorProfile, DataColorSpace, Layout, TransformOptions};

/// Invalid or unsupported profiles are ignored, as browsers do.
pub fn to_srgb(img: DynamicImage, icc: &[u8]) -> DynamicImage {
    let Ok(profile) = ColorProfile::new_from_slice(icc) else {
        return img;
    };
    let layout = match (&img, profile.color_space) {
        (DynamicImage::ImageRgb8(_), DataColorSpace::Rgb) => Layout::Rgb,
        (DynamicImage::ImageRgba8(_), DataColorSpace::Rgb) => Layout::Rgba,
        (DynamicImage::ImageLuma8(_), DataColorSpace::Gray) => Layout::Gray,
        (DynamicImage::ImageLumaA8(_), DataColorSpace::Gray) => Layout::GrayAlpha,
        // e.g. CMYK profiles on JPEGs that were already (naively) converted to RGB.
        _ => return img,
    };
    let srgb = ColorProfile::new_srgb();
    let Ok(transform) =
        profile.create_transform_8bit(layout, &srgb, layout, TransformOptions::default())
    else {
        return img;
    };

    let mut out = vec![0u8; img.as_bytes().len()];
    if transform.transform(img.as_bytes(), &mut out).is_err() {
        return img;
    }
    let (width, height) = (img.width(), img.height());
    match img {
        DynamicImage::ImageRgb8(_) => image::RgbImage::from_raw(width, height, out).map(Into::into),
        DynamicImage::ImageRgba8(_) => {
            image::RgbaImage::from_raw(width, height, out).map(Into::into)
        }
        DynamicImage::ImageLuma8(_) => {
            image::GrayImage::from_raw(width, height, out).map(Into::into)
        }
        DynamicImage::ImageLumaA8(_) => {
            image::GrayAlphaImage::from_raw(width, height, out).map(Into::into)
        }
        _ => None,
    }
    .expect("transform preserves the buffer size")
}
