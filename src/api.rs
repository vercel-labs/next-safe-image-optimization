//! The native API. This is internal: the public, sharp-like API is the TypeScript wrapper in `js/`,
//! which validates arguments before calling into here. We validate again, since the wrapper isn't a
//! security boundary.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::encode::{GifSpec, JpegSpec, OutputSpec, PngSpec, QuantizationTable, WebpSpec};
use crate::error::Error;
use crate::interrupt::Interrupt;
use crate::limits::Limits;
use crate::ops::{self, ResizeSpec};
use crate::pipeline::{self, Pipeline};

#[napi(string_enum = "lowercase")]
pub enum Fit {
    Cover,
    Contain,
    Fill,
    Inside,
    Outside,
}

#[napi(string_enum = "lowercase")]
pub enum Kernel {
    Nearest,
    Linear,
    Cubic,
    Mitchell,
    Lanczos2,
    Lanczos3,
}

#[napi(string_enum = "lowercase")]
pub enum OutputFormat {
    Jpeg,
    Png,
    Webp,
    Gif,
}

#[napi(object)]
pub struct NativeColor {
    /// 0-255
    pub r: f64,
    pub g: f64,
    pub b: f64,
    /// 0-1
    pub alpha: f64,
}

#[napi(object)]
pub struct NativeResizeOptions {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub fit: Option<Fit>,
    /// 0 (left) to 1 (right).
    pub gravity_x: Option<f64>,
    /// 0 (top) to 1 (bottom).
    pub gravity_y: Option<f64>,
    pub kernel: Option<Kernel>,
    pub without_enlargement: Option<bool>,
    pub without_reduction: Option<bool>,
    pub background: Option<NativeColor>,
}

#[napi(object)]
pub struct NativeBlurOptions {
    /// Omit for a mild 3x3 box blur.
    pub sigma: Option<f64>,
}

#[napi(object)]
pub struct NativeJpegOptions {
    pub quality: Option<f64>,
    pub progressive: Option<bool>,
    /// `true` for 4:2:0 (the default), `false` for 4:4:4.
    pub chroma_subsampling: Option<bool>,
    pub optimize_coding: Option<bool>,
    pub quantization_table: Option<f64>,
    pub mozjpeg: Option<bool>,
}

#[napi(object)]
pub struct NativePngOptions {
    pub compression_level: Option<f64>,
    pub adaptive_filtering: Option<bool>,
}

#[napi(object)]
pub struct NativeWebpOptions {
    pub quality: Option<f64>,
    pub alpha_quality: Option<f64>,
    pub lossless: Option<bool>,
    pub near_lossless: Option<bool>,
    pub smart_subsample: Option<bool>,
    pub effort: Option<f64>,
}

#[napi(object)]
pub struct NativeGifOptions {
    pub effort: Option<f64>,
}

#[napi(object)]
pub struct NativeLimitOptions {
    /// 0 disables the limit.
    pub limit_input_pixels: Option<f64>,
    pub limit_memory: Option<f64>,
    /// 0 disables the timeout.
    pub timeout_ms: Option<f64>,
}

#[napi(object)]
pub struct NativeTransformOptions {
    pub limits: Option<NativeLimitOptions>,
    pub auto_orient: Option<bool>,
    /// Clockwise degrees, a multiple of 90.
    pub rotate: Option<f64>,
    pub resize: Option<NativeResizeOptions>,
    pub blur: Option<NativeBlurOptions>,
    /// Defaults to the input format.
    pub format: Option<OutputFormat>,
    pub jpeg: Option<NativeJpegOptions>,
    pub png: Option<NativePngOptions>,
    pub webp: Option<NativeWebpOptions>,
    pub gif: Option<NativeGifOptions>,
}

#[napi(object)]
pub struct NativeError {
    pub code: String,
    pub message: String,
}

#[napi(object)]
pub struct NativeOutputInfo {
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub channels: u32,
    pub size: f64,
}

/// Exactly one of `error` or the other fields is set.
#[napi(object)]
pub struct NativeTransformResult {
    pub data: Option<Buffer>,
    pub info: Option<NativeOutputInfo>,
    pub error: Option<NativeError>,
}

#[napi(object)]
pub struct NativeMetadata {
    pub format: String,
    /// Stored dimensions, before applying the EXIF orientation.
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    /// EXIF orientation, 1-8.
    pub orientation: u32,
    pub has_profile: bool,
}

/// Exactly one of `error` or `metadata` is set.
#[napi(object)]
pub struct NativeMetadataResult {
    pub metadata: Option<NativeMetadata>,
    pub error: Option<NativeError>,
}

/// Cooperative cancellation for in-flight work. The JS wrapper calls `cancel()` from an
/// `AbortSignal`'s `abort` event.
#[napi]
pub struct CancelToken {
    cancelled: Arc<AtomicBool>,
}

#[napi]
impl CancelToken {
    #[allow(clippy::new_without_default)]
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    #[napi]
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

fn invalid(message: String) -> napi::Error {
    napi::Error::new(Status::InvalidArg, message)
}

fn int(name: &str, value: f64, min: f64, max: f64) -> napi::Result<f64> {
    if value.fract() != 0.0 || !(min..=max).contains(&value) {
        return Err(invalid(format!(
            "{name} must be an integer between {min} and {max}, got {value}"
        )));
    }
    Ok(value)
}

fn number(name: &str, value: f64, min: f64, max: f64) -> napi::Result<f64> {
    if !(min..=max).contains(&value) {
        return Err(invalid(format!(
            "{name} must be between {min} and {max}, got {value}"
        )));
    }
    Ok(value)
}

const MAX_SAFE_INTEGER: f64 = 9007199254740991.0;

fn parse_limits(options: Option<NativeLimitOptions>) -> napi::Result<(Limits, Option<Duration>)> {
    let mut limits = Limits::default();
    let mut timeout = None;
    if let Some(options) = options {
        if let Some(pixels) = options.limit_input_pixels {
            let pixels = int("limitInputPixels", pixels, 0.0, MAX_SAFE_INTEGER)? as u64;
            limits.input_pixels = if pixels == 0 { u64::MAX } else { pixels };
        }
        if let Some(memory) = options.limit_memory {
            limits.memory = int("limitMemory", memory, 1.0, MAX_SAFE_INTEGER)? as u64;
        }
        if let Some(ms) = options.timeout_ms {
            let ms = int("timeout", ms, 0.0, MAX_SAFE_INTEGER)? as u64;
            timeout = (ms > 0).then(|| Duration::from_millis(ms));
        }
    }
    Ok((limits, timeout))
}

fn parse_resize(options: NativeResizeOptions) -> napi::Result<ResizeSpec> {
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

fn parse_output(options: &mut NativeTransformOptions) -> napi::Result<Option<OutputSpec>> {
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

fn parse_pipeline(mut options: NativeTransformOptions) -> napi::Result<Pipeline> {
    let (limits, timeout) = parse_limits(options.limits.take())?;
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
        Some(NativeBlurOptions { sigma: None }) => Some(None),
        Some(NativeBlurOptions { sigma: Some(s) }) => Some(Some(number("blur", s, 0.3, 1000.0)?)),
    };
    let output = parse_output(&mut options)?;
    Ok(Pipeline {
        limits,
        timeout,
        auto_orient: options.auto_orient.unwrap_or(false),
        rotate,
        resize: options.resize.take().map(parse_resize).transpose()?,
        blur,
        output,
    })
}

impl From<Error> for NativeError {
    fn from(err: Error) -> Self {
        NativeError {
            code: err.code().to_owned(),
            message: err.to_string(),
        }
    }
}

/// Decoders see untrusted input. A panic on a libuv thread would abort the process, so turn it
/// into an error instead.
fn catch_panics<T>(f: impl FnOnce() -> crate::error::Result<T>) -> crate::error::Result<T> {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|payload| {
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        Err(Error::Internal(message))
    })
}

pub struct TransformTask {
    input: Vec<u8>,
    pipeline: Pipeline,
    cancelled: Option<Arc<AtomicBool>>,
}

impl Task for TransformTask {
    type Output = crate::error::Result<pipeline::Output>;
    type JsValue = NativeTransformResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let input = std::mem::take(&mut self.input);
        Ok(catch_panics(|| {
            let interrupt = Interrupt::new(self.cancelled.clone(), self.pipeline.timeout);
            pipeline::run(input, &self.pipeline, &interrupt)
        }))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(match output {
            Ok(output) => {
                let encoded = output.encoded;
                NativeTransformResult {
                    info: Some(NativeOutputInfo {
                        format: output.format.to_owned(),
                        width: encoded.width,
                        height: encoded.height,
                        channels: u32::from(encoded.channels),
                        size: encoded.data.len() as f64,
                    }),
                    data: Some(encoded.data.into()),
                    error: None,
                }
            }
            Err(err) => NativeTransformResult {
                data: None,
                info: None,
                error: Some(err.into()),
            },
        })
    }
}

/// `input` is copied before this returns, so the caller may reuse the buffer immediately. (Reading
/// from memory that JS can concurrently mutate would be a data race.)
#[napi(ts_return_type = "Promise<NativeTransformResult>")]
pub fn transform(
    input: &[u8],
    options: NativeTransformOptions,
    token: Option<&CancelToken>,
) -> napi::Result<AsyncTask<TransformTask>> {
    Ok(AsyncTask::new(TransformTask {
        input: input.to_vec(),
        pipeline: parse_pipeline(options)?,
        cancelled: token.map(|t| t.cancelled.clone()),
    }))
}

pub struct MetadataTask {
    input: Vec<u8>,
    limits: Limits,
    timeout: Option<Duration>,
    cancelled: Option<Arc<AtomicBool>>,
}

impl Task for MetadataTask {
    type Output = crate::error::Result<crate::decode::Header>;
    type JsValue = NativeMetadataResult;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(catch_panics(|| {
            let interrupt = Interrupt::new(self.cancelled.clone(), self.timeout);
            pipeline::metadata(&self.input, &self.limits, &interrupt)
        }))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(match output {
            Ok(header) => NativeMetadataResult {
                metadata: Some(NativeMetadata {
                    format: header.format.name().to_owned(),
                    width: header.width,
                    height: header.height,
                    has_alpha: header.has_alpha,
                    orientation: u32::from(header.orientation.to_exif()),
                    has_profile: header.icc_profile.is_some(),
                }),
                error: None,
            },
            Err(err) => NativeMetadataResult {
                metadata: None,
                error: Some(err.into()),
            },
        })
    }
}

#[napi(ts_return_type = "Promise<NativeMetadataResult>")]
pub fn metadata(
    input: &[u8],
    limits: Option<NativeLimitOptions>,
    token: Option<&CancelToken>,
) -> napi::Result<AsyncTask<MetadataTask>> {
    let (limits, timeout) = parse_limits(limits)?;
    Ok(AsyncTask::new(MetadataTask {
        input: input.to_vec(),
        limits,
        timeout,
        cancelled: token.map(|t| t.cancelled.clone()),
    }))
}
