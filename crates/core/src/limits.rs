use crate::error::{Error, Result};

/// Same as sharp's default `limitInputPixels`.
pub const DEFAULT_INPUT_PIXELS: u64 = 0x3FFF * 0x3FFF;
/// Same as `image::Limits::default()`.
pub const DEFAULT_MEMORY: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Limits {
    /// Maximum `width * height` of the input image.
    pub input_pixels: u64,
    /// Maximum memory in bytes that the worker may allocate while processing the request (enforced
    /// by `ExitOnOom`, for Rust allocations). Also passed to `image`'s decoders, and checked
    /// against the output size and the C encoders' estimated memory, which `ExitOnOom` can't see.
    pub memory: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            input_pixels: DEFAULT_INPUT_PIXELS,
            memory: DEFAULT_MEMORY,
        }
    }
}

impl Limits {
    pub fn check_input(&self, width: u32, height: u32) -> Result<()> {
        if width == 0 || height == 0 {
            return Err(Error::Decode("image has zero width or height".into()));
        }
        let pixels = u64::from(width) * u64::from(height);
        if pixels > self.input_pixels {
            return Err(Error::LimitExceeded(format!(
                "input image is {width}x{height} ({pixels} pixels), which exceeds the limit of \
                 {} pixels",
                self.input_pixels
            )));
        }
        Ok(())
    }

    pub fn check_alloc(&self, bytes: u64) -> Result<()> {
        if bytes > self.memory {
            return Err(Error::LimitExceeded(format!(
                "processing requires a {bytes} byte buffer, which exceeds the memory limit of {} \
                 bytes",
                self.memory
            )));
        }
        Ok(())
    }

    /// Dimensions are floats because computed sizes can overflow `u32`.
    pub fn check_output(&self, width: f64, height: f64, channels: u8) -> Result<()> {
        let bytes = width * height * f64::from(channels);
        let max_dim = f64::from(u32::MAX);
        if bytes.is_nan() || bytes > self.memory as f64 || width > max_dim || height > max_dim {
            return Err(Error::LimitExceeded(format!(
                "output image would be {width}x{height}, which exceeds the memory limit of {} bytes",
                self.memory
            )));
        }
        Ok(())
    }

    pub fn image_limits(&self) -> image::Limits {
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(self.memory);
        limits
    }
}
