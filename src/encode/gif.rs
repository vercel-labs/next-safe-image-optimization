use image::DynamicImage;

use super::check_dimensions;
use crate::error::{Error, Result};

#[derive(Clone, Debug)]
pub struct GifSpec {
    /// 1 (fastest) to 10 (slowest), like sharp. Controls NeuQuant's sampling.
    pub effort: u8,
}

impl Default for GifSpec {
    fn default() -> Self {
        Self { effort: 7 }
    }
}

pub fn encode(img: DynamicImage, spec: &GifSpec) -> Result<(Vec<u8>, u8)> {
    check_dimensions(&img, u32::from(u16::MAX), "GIF")?;
    let (width, height) = (img.width() as u16, img.height() as u16);
    let channels = if img.color().has_alpha() { 4 } else { 3 };
    let mut rgba = img.into_rgba8().into_raw();
    // NeuQuant's speed is 1 (best) to 30 (fastest). effort 7 maps to the gif crate's default of 10.
    let speed = 1 + (10 - i32::from(spec.effort.clamp(1, 10))) * 3;
    let frame = gif::Frame::from_rgba_speed(width, height, &mut rgba, speed);

    let mut out = Vec::new();
    {
        let mut encoder = gif::Encoder::new(&mut out, width, height, &[])
            .map_err(|e| Error::Encode(e.to_string()))?;
        encoder
            .write_frame(&frame)
            .map_err(|e| Error::Encode(e.to_string()))?;
    }
    Ok((out, channels))
}
