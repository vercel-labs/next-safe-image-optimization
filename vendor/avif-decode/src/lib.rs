//! Decoding AVIF images (AV1 + HEIF) straight to uncompressed pixels (RGBA, etc).
//! Decoding is done by [rav1d](https://lib.rs/crates/rav1d), a Rust port of dav1d, so there's no C library to build.
//!
//! (an older version of this library supports libaom instead)
use crate::image::{AlphaTarget, Planes, write_alpha8, write_alpha16};
use crate::rav1d::Rav1dDecoder;
use crate::color::MatrixCoefficients;
use imgref::ImgVec;
use rgb::*;
use std::collections::TryReserveError;
use std::io;

use quick_error::quick_error;

mod color;
mod rav1d;
mod image;

quick_error! {
    #[derive(Debug)]
    #[non_exhaustive]
    pub enum Error {
        Io(err: io::Error) {
            display("{}", err)
            from()
        }
        Rav1d(err: ::rav1d::Rav1dError) {
            display("rav1d error ({})", err)
        }
        Avif(err: avif_parse::Error) {
            display("{}", err)
            from()
        }
        Yuv(err: yuv::YuvError) {
            display("{}", err)
            from()
        }
        Unsupported(msg: &'static str) {
            display("{}", msg)
        }
        InternalError(msg: &'static str) {
            display("{}", msg)
        }
    }
}

impl From<TryReserveError> for Error {
    fn from(_: TryReserveError) -> Self {
        Self::Io(io::ErrorKind::OutOfMemory.into())
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

pub enum Image {
    Rgb8(ImgVec<Rgb<u8>>),
    Rgb16(ImgVec<Rgb<u16>>),
    Rgba8(ImgVec<Rgba<u8>>),
    Rgba16(ImgVec<Rgba<u16>>),
    Gray8(ImgVec<Gray<u8>>),
    Gray16(ImgVec<Gray<u16>>),
}


/// The pixel format of a decoded image. Samples are interleaved, and 16-bit samples use the full
/// 16-bit range, regardless of the image's bit depth.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum PixelFormat {
    Rgb8,
    Rgb16,
    Rgba8,
    Rgba16,
    Gray8,
    Gray16,
}

impl PixelFormat {
    /// Bytes per pixel
    #[inline]
    #[must_use]
    pub fn bytes_per_pixel(self) -> usize {
        match self {
            Self::Gray8 => 1,
            Self::Gray16 => 2,
            Self::Rgb8 => 3,
            Self::Rgba8 => 4,
            Self::Rgb16 => 6,
            Self::Rgba16 => 8,
        }
    }
}

/// What [`Decoder::decode_into`] writes, from the AV1 sequence header
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct OutputFormat {
    pub width: usize,
    pub height: usize,
    pub pixel_format: PixelFormat,
}

impl OutputFormat {
    /// The size of the output buffer in bytes
    #[inline]
    #[must_use]
    pub fn buffer_len(&self) -> usize {
        self.width * self.height * self.pixel_format.bytes_per_pixel()
    }
}

/// Decoder settings
#[derive(Clone, Debug, Default)]
#[non_exhaustive]
pub struct Options {
    /// Decoding threads. `None` uses the available parallelism (up to 32). With `Some(1)`,
    /// decoding happens on the calling thread.
    pub threads: Option<usize>,
}

/// AVIF decoder + converter
pub struct Decoder {
    options: Options,
    avif: avif_parse::AvifData,
}

impl Decoder {
    #[inline(always)]
    pub fn from_avif(mut avif_file_data: &[u8]) -> Result<Self> {
        Self::from_reader(&mut avif_file_data)
    }

    #[inline]
    pub fn from_reader<R: io::Read + ?Sized>(avif_file_data_reader: &mut R) -> Result<Self> {
        Self::from_reader_with_options(avif_file_data_reader, Options::default())
    }

    /// Parses the file, but doesn't start decoding until [`Decoder::to_image`]
    #[inline]
    pub fn from_reader_with_options<R: io::Read + ?Sized>(avif_file_data_reader: &mut R, options: Options) -> Result<Self> {
        let avif = avif_parse::read_avif(avif_file_data_reader)?;
        Ok(Self { avif, options })
    }

    /// The parsed container, e.g. for reading the AV1 sequence header before decoding
    #[inline]
    #[must_use]
    pub fn avif_data(&self) -> &avif_parse::AvifData {
        &self.avif
    }

    /// The dimensions and pixel format of the image, before decoding it. Decoding fails if the
    /// frames don't match the sequence header.
    pub fn output_format(&self) -> Result<OutputFormat> {
        let seq = self.avif.primary_item_metadata()?;
        let has_alpha = self.avif.alpha_item.is_some();
        let pixel_format = match (has_alpha, seq.monochrome, seq.bit_depth > 8) {
            (true, _, false) => PixelFormat::Rgba8,
            (true, _, true) => PixelFormat::Rgba16,
            (false, true, false) => PixelFormat::Gray8,
            (false, true, true) => PixelFormat::Gray16,
            (false, false, false) => PixelFormat::Rgb8,
            (false, false, true) => PixelFormat::Rgb16,
        };
        Ok(OutputFormat {
            width: seq.max_frame_width.get() as usize,
            height: seq.max_frame_height.get() as usize,
            pixel_format,
        })
    }

    /// Decodes into `buf`, which must be [`OutputFormat::buffer_len`] bytes, without padding
    /// between rows. 16-bit samples are native-endian, so `buf` must be aligned to 2 bytes for
    /// them.
    ///
    /// Unlike [`Decoder::to_image`], this doesn't allocate the output.
    #[inline(never)]
    pub fn decode_into(mut self, buf: &mut [u8]) -> Result<()> {
        let format = self.output_format()?;
        if buf.len() != format.buffer_len() {
            return Err(Error::InternalError("output buffer size"));
        }
        let threads = self.options.threads
            .unwrap_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get()).min(32));
        let mut decoder = Rav1dDecoder::new(threads)?;
        self.decode_with(&mut decoder, format, buf)
    }

    #[inline(never)]
    pub fn to_image(self) -> Result<Image> {
        let format = self.output_format()?;
        let (width, height) = (format.width, format.height);
        macro_rules! decode {
            ($variant:ident, $pixel:ty) => {{
                let mut out = Vec::<$pixel>::new();
                out.try_reserve_exact(width * height)?;
                out.resize(width * height, <$pixel>::default());
                self.decode_into(bytemuck::cast_slice_mut(out.as_mut_slice()))?;
                Image::$variant(ImgVec::new(out, width, height))
            }};
        }
        Ok(match format.pixel_format {
            PixelFormat::Rgb8 => decode!(Rgb8, Rgb<u8>),
            PixelFormat::Rgb16 => decode!(Rgb16, Rgb<u16>),
            PixelFormat::Rgba8 => decode!(Rgba8, Rgba<u8>),
            PixelFormat::Rgba16 => decode!(Rgba16, Rgba<u16>),
            PixelFormat::Gray8 => decode!(Gray8, Gray<u8>),
            PixelFormat::Gray16 => decode!(Gray16, Gray<u16>),
        })
    }

    fn decode_with(&mut self, decoder: &mut Rav1dDecoder, format: OutputFormat, buf: &mut [u8]) -> Result<()> {
        // The color conversion leaves placeholders in the alpha channel, and then alpha is written
        // separately, so that the color frame can be freed before decoding alpha
        let has_alpha = self.avif.alpha_item.is_some();
        let color = decoder.decode_frame(&std::mem::take(&mut self.avif.primary_item))?;
        if color.dimensions() != (format.width, format.height) {
            return Err(Error::Unsupported("frame size doesn't match the sequence header"));
        }
        let mismatch = || Error::Unsupported("frame pixel format doesn't match the sequence header");
        use PixelFormat as F;
        match (color.planes()?, format.pixel_format) {
            (Planes::YuvPlanes8 { y, u, v, chroma_sampling }, F::Rgb8 | F::Rgba8) => {
                color.yuv_to_rgb8(y, u, v, chroma_sampling, buf, has_alpha)?;
            },
            (Planes::Mono8(y), F::Gray8 | F::Rgba8) => color.yuv_to_gray8(y, buf, has_alpha)?,
            (Planes::Mono16(y, depth), F::Gray16 | F::Rgba16) => {
                color.yuv_to_gray16(y, depth, samples16(buf)?, has_alpha)?;
            },
            (Planes::YuvPlanes16 { y, u, v, chroma_sampling, depth }, F::Rgb16 | F::Rgba16) => {
                color.yuv_to_rgb16(y, u, v, depth, chroma_sampling, samples16(buf)?, has_alpha)?;
            },
            _ => return Err(mismatch()),
        }
        let color_mc = color.matrix_coefficients().unwrap_or(MatrixCoefficients::Identity);
        drop(color);

        if let Some(alpha_av1) = self.avif.alpha_item.take() {
            let alpha = decoder.decode_frame(&alpha_av1)?;
            drop(alpha_av1);
            let range = alpha.range();
            if let Some(alpha_mc) = alpha.matrix_coefficients().filter(|&mc| mc != MatrixCoefficients::Identity)
                && color_mc != alpha_mc {
                return Err(Error::Unsupported("alpha image has color info"));
            }
            let target = match format.pixel_format {
                F::Rgba8 => AlphaTarget::Rgba8(bytemuck::cast_slice_mut(buf)),
                F::Rgba16 => AlphaTarget::Rgba16(bytemuck::cast_slice_mut(samples16(buf)?)),
                _ => return Err(Error::InternalError("alpha without an alpha channel")),
            };
            match alpha.planes()? {
                Planes::YuvPlanes8 { y, .. } | Planes::Mono8(y) => {
                    write_alpha8(target, format.width, y, range, self.avif.premultiplied_alpha)?;
                },
                Planes::YuvPlanes16 { y, depth, .. } | Planes::Mono16(y, depth) => {
                    write_alpha16(target, format.width, y, depth, range, self.avif.premultiplied_alpha)?;
                },
            }
        } else if has_alpha {
            return Err(Error::InternalError("alpha item missing"));
        }
        Ok(())
    }
}

fn samples16(buf: &mut [u8]) -> Result<&mut [u16]> {
    bytemuck::try_cast_slice_mut(buf).map_err(|_| Error::InternalError("output buffer alignment"))
}
