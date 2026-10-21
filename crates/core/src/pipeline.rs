use crate::color;
use crate::decode::{self, Header, InputFormat};
use crate::encode::{self, Encoded, GifSpec, JpegSpec, OutputSpec, PngSpec, WebpSpec};
use crate::error::{Error, Result};
use crate::limits::Limits;
use crate::ops::{self, ResizeSpec};
use crate::orientation::Transform;

#[derive(Clone, Debug, Default)]
pub struct Pipeline {
    pub limits: Limits,
    pub auto_orient: bool,
    /// Clockwise, a multiple of 90. Applied after auto-orientation.
    pub rotate: i32,
    pub resize: Option<ResizeSpec>,
    /// `Some(None)` is a mild 3x3 box blur.
    pub blur: Option<Option<f64>>,
    /// `None` uses the input format, with default options.
    pub output: Option<OutputSpec>,
}

pub struct Output {
    pub encoded: Encoded,
    pub format: &'static str,
}

pub fn run(input: Vec<u8>, pipeline: &Pipeline) -> Result<Output> {
    // Vector images have no orientation, so only the rotation applies.
    let decoded = decode::decode(&input, &pipeline.limits, |width, height| {
        pipeline.resize.as_ref().map_or(1.0, |spec| {
            let transform = Transform::from_rotation(pipeline.rotate);
            ops::vector_scale((width, height), spec, transform)
        })
    })?;
    drop(input);

    let output = match &pipeline.output {
        Some(spec) => spec.clone(),
        None => default_output(decoded.header.format)?,
    };

    let mut transform = Transform::IDENTITY;
    if pipeline.auto_orient {
        transform = Transform::from_orientation(decoded.header.orientation);
    }
    transform = transform.then(Transform::from_rotation(pipeline.rotate));

    let mut img = decoded.image;
    if let Some(spec) = &pipeline.resize {
        img = ops::resize(img, spec, transform, &pipeline.limits)?;
    }
    // After resizing, because it's cheaper on fewer pixels.
    if let Some(icc) = &decoded.header.icc_profile {
        img = color::to_srgb(img, icc);
    }
    img.apply_orientation(transform.to_orientation());
    if let Some(sigma) = pipeline.blur {
        img = ops::blur(img, sigma)?;
    }

    let encoded = encode::encode(img, &output, &pipeline.limits)?;
    Ok(Output {
        encoded,
        format: output.format_name(),
    })
}

fn default_output(format: InputFormat) -> Result<OutputSpec> {
    Ok(match format {
        InputFormat::Jpeg => OutputSpec::Jpeg(JpegSpec::default()),
        // Like sharp.
        InputFormat::Png | InputFormat::Svg => OutputSpec::Png(PngSpec::default()),
        InputFormat::Webp => OutputSpec::Webp(WebpSpec::default()),
        InputFormat::Gif => OutputSpec::Gif(GifSpec::default()),
        InputFormat::Tiff | InputFormat::Avif => {
            return Err(Error::UnsupportedFormat(format!(
                "{} output is not supported, choose an output format explicitly",
                format.name().to_uppercase()
            )));
        }
    })
}

pub fn metadata(input: &[u8], limits: &Limits) -> Result<Header> {
    decode::header(input, limits)
}
