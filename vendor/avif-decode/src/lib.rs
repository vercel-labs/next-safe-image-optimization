//! Decoding AVIF images (AV1 + HEIF) straight to uncompressed pixels (RGBA, etc).
//! Decoding is done by [rav1d](https://lib.rs/crates/rav1d), a Rust port of dav1d, so there's no C library to build.
//!
//! (an older version of this library supports libaom instead)
use crate::image::{Planes, write_alpha8, write_alpha16};
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

    #[inline(never)]
    pub fn to_image(mut self) -> Result<Image> {
        let threads = self.options.threads
            .unwrap_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get()).min(32));
        let mut decoder = Rav1dDecoder::new(threads)?;
        self.decode_with(&mut decoder)
    }

    fn decode_with(&mut self, decoder: &mut Rav1dDecoder) -> Result<Image> {
        // Conversion puts placeholders in the alpha channel, and then updates alpha, so that the
        // color frame can be freed before decoding alpha
        let has_alpha = self.avif.alpha_item.is_some();
        let color = decoder.decode_frame(&std::mem::take(&mut self.avif.primary_item))?;
        let mut img = match color.planes()? {
            Planes::YuvPlanes8 { y, u, v, chroma_sampling } => {
                color.yuv_to_rgb8(y, u, v, chroma_sampling, has_alpha)?
            },
            Planes::Mono8(y) => color.yuv_to_gray8(y, has_alpha)?,
            Planes::Mono16(y, depth) => color.yuv_to_gray16(y, depth, has_alpha)?,
            Planes::YuvPlanes16 { y, u, v, chroma_sampling, depth } => {
                color.yuv_to_rgb16(y, u, v, depth, chroma_sampling, has_alpha)?
            },
        };
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
            match alpha.planes()? {
                Planes::YuvPlanes8 { y, .. } | Planes::Mono8(y) => {
                    write_alpha8(&mut img, y, range, self.avif.premultiplied_alpha)?;
                },
                Planes::YuvPlanes16 { y, depth, .. } | Planes::Mono16(y, depth) => {
                    write_alpha16(&mut img, y, depth, range, self.avif.premultiplied_alpha)?;
                },
            }
        } else if has_alpha {
            return Err(Error::InternalError("alpha item missing"));
        }
        Ok(img)
    }
}
