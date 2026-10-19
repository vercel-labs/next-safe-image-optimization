//! Request options. These come from the TypeScript wrapper in `js/`, which validates them first.
//! We validate again, since the wrapper isn't a security boundary.

use serde::Deserialize;

use crate::encode::{GifSpec, JpegSpec, OutputSpec, PngSpec, QuantizationTable, WebpSpec};
use crate::error::{Error, Result};
use crate::limits::Limits;
use crate::ops::{self, ResizeSpec};
use crate::pipeline::Pipeline;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Transform(Box<TransformOptions>),
    Metadata(LimitOptions),
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Fit {
    Cover,
    Contain,
    Fill,
    Inside,
    Outside,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kernel {
    Nearest,
    Linear,
    Cubic,
    Mitchell,
    Lanczos2,
    Lanczos3,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum OutputFormat {
    Jpeg,
    Png,
    Webp,
    Gif,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Color {
    /// 0-255
    r: f64,
    g: f64,
    b: f64,
    /// 0-1
    alpha: f64,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResizeOptions {
    width: Option<f64>,
    height: Option<f64>,
    fit: Option<Fit>,
    /// 0 (left) to 1 (right).
    gravity_x: Option<f64>,
    /// 0 (top) to 1 (bottom).
    gravity_y: Option<f64>,
    kernel: Option<Kernel>,
    without_enlargement: Option<bool>,
    without_reduction: Option<bool>,
    background: Option<Color>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BlurOptions {
    /// Omit for a mild 3x3 box blur.
    sigma: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JpegOptions {
    quality: Option<f64>,
    progressive: Option<bool>,
    /// `true` for 4:2:0 (the default), `false` for 4:4:4.
    chroma_subsampling: Option<bool>,
    optimize_coding: Option<bool>,
    quantization_table: Option<f64>,
    mozjpeg: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PngOptions {
    compression_level: Option<f64>,
    adaptive_filtering: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WebpOptions {
    quality: Option<f64>,
    alpha_quality: Option<f64>,
    lossless: Option<bool>,
    near_lossless: Option<bool>,
    smart_subsample: Option<bool>,
    effort: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GifOptions {
    effort: Option<f64>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LimitOptions {
    /// 0 disables the limit.
    limit_input_pixels: Option<f64>,
    limit_allocator_memory: Option<f64>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransformOptions {
    limits: Option<LimitOptions>,
    auto_orient: Option<bool>,
    /// Clockwise degrees, a multiple of 90.
    rotate: Option<f64>,
    resize: Option<ResizeOptions>,
    blur: Option<BlurOptions>,
    /// Defaults to the input format.
    format: Option<OutputFormat>,
    jpeg: Option<JpegOptions>,
    png: Option<PngOptions>,
    webp: Option<WebpOptions>,
    gif: Option<GifOptions>,
}

pub fn parse(json: &[u8]) -> Result<Request> {
    serde_json::from_slice(json).map_err(|err| Error::Internal(format!("invalid request: {err}")))
}

fn invalid(message: String) -> Error {
    Error::Internal(format!("invalid request: {message}"))
}

fn int(name: &str, value: f64, min: f64, max: f64) -> Result<f64> {
    if value.fract() != 0.0 || !(min..=max).contains(&value) {
        return Err(invalid(format!(
            "{name} must be an integer between {min} and {max}, got {value}"
        )));
    }
    Ok(value)
}

fn number(name: &str, value: f64, min: f64, max: f64) -> Result<f64> {
    if !(min..=max).contains(&value) {
        return Err(invalid(format!(
            "{name} must be between {min} and {max}, got {value}"
        )));
    }
    Ok(value)
}

const MAX_SAFE_INTEGER: f64 = 9007199254740991.0;

pub fn parse_limits(options: Option<LimitOptions>) -> Result<Limits> {
    let mut limits = Limits::default();
    if let Some(options) = options {
        if let Some(pixels) = options.limit_input_pixels {
            let pixels = int("limitInputPixels", pixels, 0.0, MAX_SAFE_INTEGER)? as u64;
            limits.input_pixels = if pixels == 0 { u64::MAX } else { pixels };
        }
        if let Some(memory) = options.limit_allocator_memory {
            limits.memory = int("limitAllocatorMemory", memory, 1.0, MAX_SAFE_INTEGER)? as u64;
        }
    }
    Ok(limits)
}

fn parse_resize(options: ResizeOptions) -> Result<ResizeSpec> {
    let dim = |name, value: Option<f64>| {
        value
            .map(|v| int(name, v, 1.0, f64::from(u32::MAX)).map(|v| v as u32))
            .transpose()
    };
    let gravity = |name, value: Option<f64>| number(name, value.unwrap_or(0.5), 0.0, 1.0);
    let background = match options.background {
        None => [0, 0, 0, u8::MAX],
        Some(c) => [
            int("background.r", c.r, 0.0, 255.0)? as u8,
            int("background.g", c.g, 0.0, 255.0)? as u8,
            int("background.b", c.b, 0.0, 255.0)? as u8,
            (number("background.alpha", c.alpha, 0.0, 1.0)? * 255.0).round() as u8,
        ],
    };
    Ok(ResizeSpec {
        width: dim("width", options.width)?,
        height: dim("height", options.height)?,
        fit: match options.fit.unwrap_or(Fit::Cover) {
            Fit::Cover => ops::Fit::Cover,
            Fit::Contain => ops::Fit::Contain,
            Fit::Fill => ops::Fit::Fill,
            Fit::Inside => ops::Fit::Inside,
            Fit::Outside => ops::Fit::Outside,
        },
        gravity: (
            gravity("gravityX", options.gravity_x)?,
            gravity("gravityY", options.gravity_y)?,
        ),
        kernel: match options.kernel.unwrap_or(Kernel::Lanczos3) {
            Kernel::Nearest => ops::Kernel::Nearest,
            Kernel::Linear => ops::Kernel::Linear,
            Kernel::Cubic => ops::Kernel::Cubic,
            Kernel::Mitchell => ops::Kernel::Mitchell,
            Kernel::Lanczos2 => ops::Kernel::Lanczos2,
            Kernel::Lanczos3 => ops::Kernel::Lanczos3,
        },
        without_enlargement: options.without_enlargement.unwrap_or(false),
        without_reduction: options.without_reduction.unwrap_or(false),
        background,
    })
}

fn parse_output(options: &mut TransformOptions) -> Result<Option<OutputSpec>> {
    let Some(format) = options.format.take() else {
        return Ok(None);
    };
    Ok(Some(match format {
        OutputFormat::Jpeg => {
            let mut spec = JpegSpec::default();
            if let Some(o) = options.jpeg.take() {
                if o.mozjpeg == Some(true) {
                    spec.apply_mozjpeg_preset();
                }
                if let Some(q) = o.quality {
                    spec.quality = int("jpeg.quality", q, 1.0, 100.0)? as u8;
                }
                spec.progressive = o.progressive.unwrap_or(spec.progressive);
                spec.chroma_subsampling = o.chroma_subsampling.unwrap_or(spec.chroma_subsampling);
                spec.optimize_coding = o.optimize_coding.unwrap_or(spec.optimize_coding);
                if let Some(t) = o.quantization_table {
                    let index = int("jpeg.quantizationTable", t, 0.0, 8.0)? as u32;
                    spec.quantization_table =
                        QuantizationTable::from_index(index).expect("index is in range");
                }
            }
            OutputSpec::Jpeg(spec)
        }
        OutputFormat::Png => {
            let mut spec = PngSpec::default();
            if let Some(o) = options.png.take() {
                if let Some(level) = o.compression_level {
                    spec.compression_level = int("png.compressionLevel", level, 0.0, 9.0)? as u8;
                }
                spec.adaptive_filtering = o.adaptive_filtering.unwrap_or(spec.adaptive_filtering);
            }
            OutputSpec::Png(spec)
        }
        OutputFormat::Webp => {
            let mut spec = WebpSpec::default();
            if let Some(o) = options.webp.take() {
                if let Some(q) = o.quality {
                    spec.quality = int("webp.quality", q, 1.0, 100.0)? as f32;
                }
                if let Some(q) = o.alpha_quality {
                    spec.alpha_quality = int("webp.alphaQuality", q, 0.0, 100.0)? as u8;
                }
                if let Some(e) = o.effort {
                    spec.effort = int("webp.effort", e, 0.0, 6.0)? as u8;
                }
                spec.lossless = o.lossless.unwrap_or(spec.lossless);
                spec.near_lossless = o.near_lossless.unwrap_or(spec.near_lossless);
                spec.smart_subsample = o.smart_subsample.unwrap_or(spec.smart_subsample);
            }
            OutputSpec::Webp(spec)
        }
        OutputFormat::Gif => {
            let mut spec = GifSpec::default();
            if let Some(o) = options.gif.take()
                && let Some(e) = o.effort
            {
                spec.effort = int("gif.effort", e, 1.0, 10.0)? as u8;
            }
            OutputSpec::Gif(spec)
        }
    }))
}

pub fn parse_pipeline(mut options: Box<TransformOptions>) -> Result<Pipeline> {
    let limits = parse_limits(options.limits.take())?;
    let rotate = match options.rotate {
        None => 0,
        Some(angle) => {
            let angle = int("rotate", angle, -3600.0, 3600.0)? as i32;
            if angle % 90 != 0 {
                return Err(invalid(format!(
                    "rotate only supports multiples of 90 degrees, got {angle}"
                )));
            }
            angle
        }
    };
    let blur = match options.blur.take() {
        None => None,
        Some(BlurOptions { sigma: None }) => Some(None),
        Some(BlurOptions { sigma: Some(s) }) => Some(Some(number("blur", s, 0.3, 1000.0)?)),
    };
    let output = parse_output(&mut options)?;
    Ok(Pipeline {
        limits,
        auto_orient: options.auto_orient.unwrap_or(false),
        rotate,
        resize: options.resize.take().map(parse_resize).transpose()?,
        blur,
        output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_transform() {
        let request = parse(
            br#"{"transform":{"limits":{"limitAllocatorMemory":1000},"rotate":90,"resize":{"width":10},
                "blur":{},"format":"webp","webp":{"quality":50}}}"#,
        )
        .unwrap();
        let Request::Transform(options) = request else {
            panic!("expected a transform request");
        };
        let pipeline = parse_pipeline(options).unwrap();
        assert_eq!(pipeline.limits.memory, 1000);
        assert_eq!(pipeline.rotate, 90);
        assert_eq!(pipeline.resize.unwrap().width, Some(10));
        assert_eq!(pipeline.blur, Some(None));
        assert!(matches!(pipeline.output, Some(OutputSpec::Webp(spec)) if spec.quality == 50.0));
    }

    #[test]
    fn rejects_invalid_options() {
        for json in [
            r#"{"transform":{"rotate":45}}"#,
            r#"{"transform":{"resize":{"width":0}}}"#,
            r#"{"transform":{"format":"avif"}}"#,
            r#"{"transform":{"unknown":1}}"#,
            r#"{"metadata":{"limitAllocatorMemory":0}}"#,
            r#"{"other":{}}"#,
        ] {
            let result = parse(json.as_bytes()).and_then(|request| match request {
                Request::Transform(options) => parse_pipeline(options).map(drop),
                Request::Metadata(options) => parse_limits(Some(options)).map(drop),
            });
            assert!(result.is_err(), "{json}");
        }
    }
}
