//! Request options. These come from the TypeScript wrapper in `js/`, which validates them first.
//! We validate again, since the wrapper isn't a security boundary.

use serde::Deserialize;
use typeshare_annotation::typeshare;

use crate::decode::InputFormat;
use crate::encode::{GifSpec, JpegSpec, OutputSpec, PngSpec, WebpSpec};
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

/// The filters that `image` implements, named like sharp's.
#[typeshare]
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kernel {
    Nearest,
    Linear,
    Cubic,
    Lanczos3,
}

#[typeshare]
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum OutputFormat {
    Jpeg,
    Png,
    Webp,
    Gif,
}

/// Like sharp's `fit: 'cover'`: with both dimensions, the excess is cropped, centered.
#[typeshare]
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResizeOptions {
    width: Option<f64>,
    height: Option<f64>,
    kernel: Option<Kernel>,
    without_enlargement: Option<bool>,
    without_reduction: Option<bool>,
}

#[typeshare]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JpegOptions {
    quality: Option<f64>,
    mozjpeg: Option<bool>,
}

#[typeshare]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PngOptions {
    compression_level: Option<f64>,
    adaptive_filtering: Option<bool>,
}

#[typeshare]
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

#[typeshare]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GifOptions {
    effort: Option<f64>,
}

#[typeshare]
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LimitOptions {
    /// 0 disables the limit.
    limit_input_pixels: Option<f64>,
    limit_allocator_memory: Option<f64>,
    allowed_input_formats: Option<Vec<InputFormat>>,
    allow_animated: Option<bool>,
}

#[typeshare]
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransformOptions {
    limits: Option<LimitOptions>,
    auto_orient: Option<bool>,
    /// Clockwise degrees, a multiple of 90.
    rotate: Option<f64>,
    resize: Option<ResizeOptions>,
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
        if let Some(formats) = options.allowed_input_formats {
            if formats.is_empty() {
                return Err(invalid("allowedInputFormats must not be empty".into()));
            }
            limits.input_formats = formats;
        }
        limits.animated = options.allow_animated.unwrap_or(limits.animated);
    }
    Ok(limits)
}

fn parse_resize(options: ResizeOptions) -> Result<ResizeSpec> {
    let dim = |name, value: Option<f64>| {
        value
            .map(|v| int(name, v, 1.0, f64::from(u32::MAX)).map(|v| v as u32))
            .transpose()
    };
    Ok(ResizeSpec {
        width: dim("width", options.width)?,
        height: dim("height", options.height)?,
        kernel: match options.kernel.unwrap_or(Kernel::Lanczos3) {
            Kernel::Nearest => ops::Kernel::Nearest,
            Kernel::Linear => ops::Kernel::Linear,
            Kernel::Cubic => ops::Kernel::Cubic,
            Kernel::Lanczos3 => ops::Kernel::Lanczos3,
        },
        without_enlargement: options.without_enlargement.unwrap_or(false),
        without_reduction: options.without_reduction.unwrap_or(false),
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
                if let Some(q) = o.quality {
                    spec.quality = int("jpeg.quality", q, 1.0, 100.0)? as u8;
                }
                spec.mozjpeg = o.mozjpeg.unwrap_or(spec.mozjpeg);
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
    let output = parse_output(&mut options)?;
    Ok(Pipeline {
        limits,
        auto_orient: options.auto_orient.unwrap_or(false),
        rotate,
        resize: options.resize.take().map(parse_resize).transpose()?,
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
                "format":"webp","webp":{"quality":50}}}"#,
        )
        .unwrap();
        let Request::Transform(options) = request else {
            panic!("expected a transform request");
        };
        let pipeline = parse_pipeline(options).unwrap();
        assert_eq!(pipeline.limits.memory, 1000);
        assert_eq!(pipeline.rotate, 90);
        assert_eq!(pipeline.resize.unwrap().width, Some(10));
        assert!(matches!(pipeline.output, Some(OutputSpec::Webp(spec)) if spec.quality == 50.0));
    }

    #[test]
    fn rejects_invalid_options() {
        for json in [
            r#"{"transform":{"rotate":45}}"#,
            r#"{"transform":{"resize":{"width":0}}}"#,
            r#"{"transform":{"resize":{"width":1,"fit":"contain"}}}"#,
            r#"{"transform":{"resize":{"width":1,"kernel":"mitchell"}}}"#,
            r#"{"transform":{"blur":{}}}"#,
            r#"{"transform":{"format":"avif"}}"#,
            r#"{"transform":{"unknown":1}}"#,
            r#"{"metadata":{"limitAllocatorMemory":0}}"#,
            r#"{"metadata":{"allowedInputFormats":[]}}"#,
            r#"{"metadata":{"allowedInputFormats":["bmp"]}}"#,
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
