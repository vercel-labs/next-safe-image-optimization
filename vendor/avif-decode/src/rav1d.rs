use crate::{Error, Result};
use crate::color::{ChromaSampling, Depth, MatrixCoefficients, Range};
use imgref::ImgRef;
use rav1d::pixel::{self, YUVRange};
use rav1d::{Decoder, PixelLayout, PlanarImageComponent, Picture, Rav1dError, Settings};

pub(crate) struct Rav1dDecoder {
    decoder: Decoder,
}

impl Rav1dDecoder {
    #[inline]
    pub(crate) fn new(threads: usize) -> Result<Self> {
        let mut settings = Settings::new();
        // rav1d supports up to 256 threads; 0 means one per logical CPU
        settings.set_n_threads(threads.min(256) as u32);
        // Still images are decoded one frame at a time, so there's nothing to pipeline:
        // keep a single frame context to make each decoded frame available immediately
        // (tile decoding is still multi-threaded via `n_threads`).
        settings.set_max_frame_delay(1);
        // Grain changes the output pixels, and the other decoders synthesize it too
        // (libaom and libavif both apply it), so it must not be left to the caller
        settings.set_apply_grain(true);
        Ok(Self { decoder: Decoder::with_settings(&settings)? })
    }

    /// Take AV1-compressed data and decode a *single* frame into raw frame data (YUV pixels). This is for AVIF, and can't handle video.
    ///
    /// Feeds one AV1 temporal unit (a single AVIF item) to the decoder and returns its picture.
    /// For a layered item this is the final layer, which is the complete image.
    ///
    /// See [yuv](https://lib.rs/yuv) crate for conversion to RGB.
    pub(crate) fn decode_frame(&mut self, av1_data: &[u8]) -> Result<Frame> {
        let mut buf = Vec::new();
        buf.try_reserve_exact(av1_data.len())?;
        buf.extend_from_slice(av1_data);

        // A layered (progressively decodable) item decodes to one picture per layer, and only
        // the last one is the complete image: later layers refine the earlier ones, and film
        // grain is applied on the final layer only
        let mut last_pic = None;

        // One AVIF item is a single temporal unit, so one `send_data` consumes it all.
        // If the decoder is still holding a frame (the item had more than one frame),
        // take the pending frame out and retry, so that `send_data` can make progress.
        let mut res = self.decoder.send_data(buf.into_boxed_slice(), None, None, None);
        loop {
            match res {
                Ok(()) => break,
                Err(Rav1dError::TryAgain) => {
                    // if there's no frame to drain, the decoder can't accept this data
                    last_pic = Some(self.decoder.get_picture().map_err(|_| Rav1dError::TryAgain)?);
                    res = self.decoder.send_pending_data();
                },
                Err(err) => return Err(err.into()),
            }
        }

        // Take pictures until the decoder stops producing them, and keep the newest one.
        loop {
            match self.decoder.get_picture() {
                Ok(pic) => last_pic = Some(pic),
                // nothing decoded: report the decoder's own reason for stopping
                Err(err) => return last_pic.map(Frame).ok_or(err.into()),
            }
        }
    }
}

impl From<Rav1dError> for Error {
    fn from(err: Rav1dError) -> Self {
        Self::Rav1d(err)
    }
}

/// A decoded frame
pub struct Frame(Picture);

impl Frame {
    #[inline]
    pub(crate) fn single_plane_img<T: bytemuck::Pod>(&self, plane_n: u8) -> Result<ImgRef<'_, T>> {
        let component = PlanarImageComponent::try_from(usize::from(plane_n))?;

        let pixel_bytes = if self.0.bit_depth() <= 8 { 1 } else { 2 };
        if pixel_bytes != std::mem::size_of::<T>() {
            return Err(Error::InternalError("pixel size"));
        }

        // Chroma planes are subsampled depending on the pixel layout
        let (ss_hor, ss_ver) = match (plane_n != 0, self.0.pixel_layout()) {
            (false, _) | (true, PixelLayout::I444) => (0u8, 0u8),
            (true, PixelLayout::I420) => (1, 1),
            (true, PixelLayout::I422) => (1, 0),
            (true, _) => return Err(Error::InternalError("unknown pixel layout")),
        };
        let w = (self.0.width() as usize + usize::from(ss_hor)) >> ss_hor;
        let h = (self.0.height() as usize + usize::from(ss_ver)) >> ss_ver;

        // rav1d uses one stride for luma, and one shared by both chroma planes
        let stride_bytes = self.0.stride(component) as usize;
        if stride_bytes == 0 || !stride_bytes.is_multiple_of(pixel_bytes) {
            return Err(Error::InternalError("stride"));
        }
        let stride = stride_bytes / pixel_bytes;
        if stride < w || w == 0 || h == 0 {
            return Err(Error::InternalError("stride"));
        }

        // rav1d allocates whole rows of pixels, so `stride * h` stays within the plane's buffer
        let len = stride * h;
        let plane = self.0.plane(component);
        let buf = plane.get(..len * pixel_bytes).ok_or(Error::InternalError("plane size"))?;
        let buf = bytemuck::try_cast_slice(buf).map_err(|_| Error::InternalError("plane alignment"))?;
        Ok(ImgRef::new_stride(buf, w, h, stride))
    }

    /// Whether image uses chroma subsampling or not
    #[inline]
    pub fn chroma_sampling(&self) -> Result<ChromaSampling> {
        Ok(match self.0.pixel_layout() {
            PixelLayout::I400 => ChromaSampling::Monochrome,
            PixelLayout::I420 => ChromaSampling::Cs420,
            PixelLayout::I422 => ChromaSampling::Cs422,
            PixelLayout::I444 => ChromaSampling::Cs444,
        })
    }

    /// How many bits per pixel that is
    #[inline]
    pub fn depth(&self) -> Result<Depth> {
        Ok(match self.0.bits_per_component().map(|b| b.0) {
            Some(8) => Depth::Depth8,
            Some(10) => Depth::Depth10,
            Some(12) => Depth::Depth12,
            _ => return Err(Error::InternalError("bit depth")),
        })
    }

    /// Flavor of YUV used for the pixels
    ///
    /// See [yuv](https://lib.rs/yuv) crate for conversion to RGB.
    #[inline]
    #[must_use]
    pub fn matrix_coefficients(&self) -> Option<MatrixCoefficients> {
        use pixel::MatrixCoefficients as M;
        // rav1d maps both BT.601 and BT.470BG to `BT470BG`, which use the same matrix
        Some(match self.0.matrix_coefficients() {
            M::Identity => MatrixCoefficients::Identity,
            M::BT709 => MatrixCoefficients::BT709,
            M::BT470M => MatrixCoefficients::Fcc,
            M::BT470BG => MatrixCoefficients::BT470BG,
            M::ST170M => MatrixCoefficients::BT601,
            M::ST240M => MatrixCoefficients::SMPTE240,
            M::YCgCo => MatrixCoefficients::YCgCo,
            M::BT2020NonConstantLuminance | M::BT2020ConstantLuminance => MatrixCoefficients::BT2020NCL,
            M::ST2085 => MatrixCoefficients::SMPTE2085,
            M::ChromaticityDerivedNonConstantLuminance => MatrixCoefficients::ChromatNCL,
            M::ChromaticityDerivedConstantLuminance => MatrixCoefficients::ChromatCL,
            M::ICtCp => MatrixCoefficients::ICtCp,
            _ => return None,
        })
    }

    /// Whether pixels are in 0-255 or 16-235/240 range.
    #[inline(always)]
    #[must_use]
    pub fn range(&self) -> Range {
        match self.0.color_range() {
            YUVRange::Full => Range::Full,
            YUVRange::Limited => Range::Limited,
        }
    }
}
