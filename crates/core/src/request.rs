//! Request options. The TypeScript wrapper (`packages/nsio`) passes them through mostly as the
//! caller wrote them, and only validates the few that it uses itself. So this is where they're
//! validated, and unknown fields are rejected. Those errors are `Error::InvalidOptions`, which the
//! wrapper throws as `TypeError`s.

use serde::Deserialize;
use typeshare_annotation::typeshare;

use crate::decode::InputFormat;
use crate::encode::{GifSpec, JpegSpec, OutputFormat, OutputSpec, PngSpec, WebpSpec};
use crate::error::{Error, Result};
use crate::limits::{Animated, Limits};
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
    /// 0 removes each of these limits.
    limit_input_pixels: Option<f64>,
    limit_allocator_memory_bytes: Option<f64>,
    limit_output_bytes: Option<f64>,
    allowed_input_formats: Option<Vec<InputFormat>>,
    animated: Option<Animated>,
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
    serde_json::from_slice(json).map_err(|err| {
        // The caller never sees the JSON, so the position alone would mean nothing to them.
        let line = err
            .line()
            .checked_sub(1)
            .and_then(|index| json.split(|&b| b == b'\n').nth(index))
            .unwrap_or_default();
        let message = format!("{err} in {}", String::from_utf8_lossy(line));
        // `JSON.stringify` never truncates its output.
        if err.is_eof() {
            Error::Internal(format!("invalid request: {message}"))
        } else {
            invalid(message)
        }
    })
}

fn invalid(message: String) -> Error {
    Error::InvalidOptions(message)
}

/// `max` may be infinite. Casting the result to an integer type saturates.
fn int(name: &str, value: f64, min: f64, max: f64) -> Result<f64> {
    if value.fract() != 0.0 || !(min..=max).contains(&value) {
        let range = if max.is_infinite() {
            format!("of at least {min}")
        } else {
            format!("between {min} and {max}")
        };
        return Err(invalid(format!(
            "{name} must be an integer {range}, got {value}"
        )));
    }
    Ok(value)
}

/// 0 removes the limit.
fn limit(name: &str, value: f64) -> Result<u64> {
    let value = int(name, value, 0.0, f64::INFINITY)? as u64;
    Ok(if value == 0 { u64::MAX } else { value })
}

pub fn parse_limits(options: Option<LimitOptions>) -> Result<Limits> {
    let mut limits = Limits::default();
    if let Some(options) = options {
        if let Some(pixels) = options.limit_input_pixels {
            limits.input_pixels = limit("limitInputPixels", pixels)?;
        }
        if let Some(memory) = options.limit_allocator_memory_bytes {
            limits.memory = limit("limitAllocatorMemoryBytes", memory)?;
        }
        if let Some(bytes) = options.limit_output_bytes {
            limits.output_bytes = limit("limitOutputBytes", bytes)?;
        }
        if let Some(formats) = options.allowed_input_formats {
            if formats.is_empty() {
                return Err(invalid("allowInputFormats() must not be empty".into()));
            }
            limits.input_formats = formats;
        }
        limits.animated = options.animated.unwrap_or(limits.animated);
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
        width: dim("resize.width", options.width)?,
        height: dim("resize.height", options.height)?,
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
    use crate::error::ErrorCode;

    #[test]
    fn parses_transform() {
        let request = parse(
            br#"{"transform":{"limits":{"limitAllocatorMemoryBytes":1000},"rotate":90,"resize":{"width":10},
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

    fn error(json: &str) -> Error {
        parse(json.as_bytes())
            .and_then(|request| match request {
                Request::Transform(options) => parse_pipeline(options).map(drop),
                Request::Metadata(options) => parse_limits(Some(options)).map(drop),
            })
            .expect_err(json)
    }

    #[test]
    fn rejects_invalid_options() {
        for (json, prefix) in [
            (r#"{"transform":{"rotate":45}}"#, "rotate only supports"),
            (
                r#"{"transform":{"resize":{"width":0}}}"#,
                "resize.width must be",
            ),
            (
                r#"{"transform":{"resize":{"fit":"contain"}}}"#,
                "unknown field `fit`",
            ),
            (
                r#"{"transform":{"resize":{"kernel":"mitchell"}}}"#,
                "unknown variant `mitchell`",
            ),
            (
                r#"{"transform":{"jpeg":{"mozjpeg":"yes"}}}"#,
                "invalid type: string",
            ),
            (
                r#"{"transform":{"format":"png","png":{"compressionLevel":10}}}"#,
                "png.compressionLevel must be",
            ),
            (
                r#"{"transform":{"format":"avif"}}"#,
                "unknown variant `avif`",
            ),
            (
                r#"{"transform":{"limits":{"failOn":"none"}}}"#,
                "unknown field `failOn`",
            ),
            (
                r#"{"metadata":{"limitAllocatorMemoryBytes":-1}}"#,
                "limitAllocatorMemoryBytes must be",
            ),
            (
                r#"{"metadata":{"limitOutputBytes":-1}}"#,
                "limitOutputBytes must be",
            ),
            (
                r#"{"metadata":{"allowedInputFormats":[]}}"#,
                "allowInputFormats() must not be empty",
            ),
            (
                r#"{"metadata":{"allowedInputFormats":["bmp"]}}"#,
                "unknown variant `bmp`",
            ),
            (r#"{"other":{}}"#, "unknown variant `other`"),
        ] {
            let err = error(json);
            assert_eq!(err.code(), ErrorCode::InvalidOptions, "{json}");
            assert!(err.to_string().starts_with(prefix), "{json}: {err}");
        }
    }

    #[test]
    fn errors_include_the_json() {
        let json = "{\"transform\":\n{\"resize\":{\"fit\":\"contain\"}}}";
        let message = error(json).to_string();
        assert!(
            message.ends_with(r#" in {"resize":{"fit":"contain"}}}"#),
            "{message}"
        );
    }

    #[test]
    fn truncated_requests_are_internal() {
        for json in ["", "{\"transform\":"] {
            assert_eq!(error(json).code(), ErrorCode::Internal, "{json}");
        }
    }
}
