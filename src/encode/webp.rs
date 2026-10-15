//! WebP via libwebp (C). `image-webp` only supports lossless encoding.

use std::ffi::{c_int, c_void};
use std::mem::MaybeUninit;

use image::DynamicImage;
use libwebp_sys as sys;

use super::check_dimensions;
use crate::error::{Error, Result};
use crate::interrupt::Interrupt;

#[derive(Clone, Debug)]
pub struct WebpSpec {
    /// 0-100
    pub quality: f32,
    /// 0-100
    pub alpha_quality: u8,
    pub lossless: bool,
    pub near_lossless: bool,
    pub smart_subsample: bool,
    /// 0 (fastest) to 6 (slowest). libwebp's `method`.
    pub effort: u8,
}

impl Default for WebpSpec {
    fn default() -> Self {
        // Same as sharp.
        Self {
            quality: 80.0,
            alpha_quality: 100,
            lossless: false,
            near_lossless: false,
            smart_subsample: false,
            effort: 4,
        }
    }
}

struct Picture(sys::WebPPicture);

impl Drop for Picture {
    fn drop(&mut self) {
        unsafe { sys::WebPPictureFree(&mut self.0) }
    }
}

struct MemoryWriter(sys::WebPMemoryWriter);

impl Drop for MemoryWriter {
    fn drop(&mut self) {
        unsafe { sys::WebPMemoryWriterClear(&mut self.0) }
    }
}

/// Returning 0 aborts encoding.
unsafe extern "C" fn progress_hook(_percent: c_int, picture: *const sys::WebPPicture) -> c_int {
    // SAFETY: `user_data` is set to a `&Interrupt` that outlives `WebPEncode`.
    let interrupt = unsafe { &*((*picture).user_data as *const Interrupt) };
    c_int::from(interrupt.check().is_ok())
}

pub fn encode(img: DynamicImage, spec: &WebpSpec, interrupt: &Interrupt) -> Result<(Vec<u8>, u8)> {
    check_dimensions(&img, sys::WEBP_MAX_DIMENSION, "WebP")?;
    let img = match img {
        DynamicImage::ImageLuma8(_) => DynamicImage::ImageRgb8(img.to_rgb8()),
        DynamicImage::ImageLumaA8(_) => DynamicImage::ImageRgba8(img.to_rgba8()),
        img => img,
    };
    let has_alpha = img.color().has_alpha();
    let fail = |what: &str| Error::Encode(format!("libwebp: {what}"));

    // These structs are zeroed first, so that fields an init function skips (like padding) are
    // still initialized.
    // SAFETY: `WebPConfigInitInternal` sets every field when it returns non-zero.
    let mut config = unsafe {
        let mut config = MaybeUninit::<sys::WebPConfig>::zeroed();
        if sys::WebPConfigInitInternal(
            config.as_mut_ptr(),
            sys::WebPPreset::WEBP_PRESET_DEFAULT,
            spec.quality,
            sys::WEBP_ENCODER_ABI_VERSION as c_int,
        ) == 0
        {
            return Err(fail("version mismatch"));
        }
        config.assume_init()
    };
    config.method = c_int::from(spec.effort);
    config.alpha_quality = c_int::from(spec.alpha_quality);
    config.use_sharp_yuv = c_int::from(spec.smart_subsample);
    if spec.lossless || spec.near_lossless {
        config.lossless = 1;
    }
    if spec.near_lossless {
        // Like libvips, `quality` doubles as the near-lossless preprocessing level.
        config.near_lossless = spec.quality as c_int;
    }
    // We parallelize across images, not within one.
    config.thread_level = 0;
    if unsafe { sys::WebPValidateConfig(&config) } == 0 {
        return Err(fail("invalid configuration"));
    }

    // SAFETY: as above.
    let mut picture = Picture(unsafe {
        let mut picture = MaybeUninit::<sys::WebPPicture>::zeroed();
        if sys::WebPPictureInitInternal(
            picture.as_mut_ptr(),
            sys::WEBP_ENCODER_ABI_VERSION as c_int,
        ) == 0
        {
            return Err(fail("version mismatch"));
        }
        picture.assume_init()
    });
    // libwebp converts ARGB to YUV itself when encoding lossy images (using sharp YUV if enabled).
    picture.0.use_argb = 1;
    picture.0.width = img.width() as c_int;
    picture.0.height = img.height() as c_int;
    let stride = (img.width() * u32::from(img.color().bytes_per_pixel())) as c_int;
    // SAFETY: the buffer is `stride * height` bytes, and is copied into the picture.
    let imported = unsafe {
        if has_alpha {
            sys::WebPPictureImportRGBA(&mut picture.0, img.as_bytes().as_ptr(), stride)
        } else {
            sys::WebPPictureImportRGB(&mut picture.0, img.as_bytes().as_ptr(), stride)
        }
    };
    if imported == 0 {
        return Err(fail("out of memory"));
    }
    drop(img);

    // SAFETY: zeroed, then initialized by `WebPMemoryWriterInit`.
    let mut writer = MemoryWriter(unsafe {
        let mut writer = MaybeUninit::<sys::WebPMemoryWriter>::zeroed();
        sys::WebPMemoryWriterInit(writer.as_mut_ptr());
        writer.assume_init()
    });
    picture.0.writer = Some(sys::WebPMemoryWrite);
    picture.0.custom_ptr = &mut writer.0 as *mut sys::WebPMemoryWriter as *mut c_void;
    picture.0.progress_hook = Some(progress_hook);
    picture.0.user_data = interrupt as *const Interrupt as *mut c_void;

    // SAFETY: `config` was validated, `picture` was initialized and imported, and `writer` and
    // `interrupt` outlive this call.
    if unsafe { sys::WebPEncode(&config, &mut picture.0) } == 0 {
        return Err(match picture.0.error_code {
            sys::WebPEncodingError::VP8_ENC_ERROR_USER_ABORT => {
                interrupt.check_after_error(fail("aborted"))
            }
            code => fail(&format!("{code:?}")),
        });
    }
    let data = if writer.0.size == 0 {
        Vec::new()
    } else {
        // SAFETY: `mem` points to `size` bytes written by `WebPMemoryWrite`.
        unsafe { std::slice::from_raw_parts(writer.0.mem, writer.0.size) }.to_vec()
    };
    Ok((data, if has_alpha { 4 } else { 3 }))
}
