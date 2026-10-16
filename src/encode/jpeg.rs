use image::DynamicImage;
use jpeg_encoder::{
    ChromaSubsamplingMethod, ColorType, Encoder, QuantizationTableType, SamplingFactor,
};

use crate::encode::{check_dimensions, flatten};
use crate::error::{Error, Result};

/// Quantization table indices, matching mozjpeg (and therefore sharp's `quantisationTable`).
#[derive(Clone, Copy, Debug)]
pub enum QuantizationTable {
    AnnexK = 0,
    Flat = 1,
    MsSsim = 2,
    ImageMagick = 3,
    PsnrHvsM = 4,
    KleinSilversteinCarney = 5,
    WatsonTaylorBorthwick = 6,
    AhumadaWatsonPeterson = 7,
    PetersonAhumadaWatson = 8,
}

impl QuantizationTable {
    pub fn from_index(index: u32) -> Option<Self> {
        use QuantizationTable as Q;
        Some(match index {
            0 => Q::AnnexK,
            1 => Q::Flat,
            2 => Q::MsSsim,
            3 => Q::ImageMagick,
            4 => Q::PsnrHvsM,
            5 => Q::KleinSilversteinCarney,
            6 => Q::WatsonTaylorBorthwick,
            7 => Q::AhumadaWatsonPeterson,
            8 => Q::PetersonAhumadaWatson,
            _ => return None,
        })
    }

    fn to_encoder_type(self) -> QuantizationTableType {
        use QuantizationTable as Q;
        use QuantizationTableType as T;
        match self {
            Q::AnnexK => T::Default,
            Q::Flat => T::Flat,
            Q::MsSsim => T::CustomMsSsim,
            Q::ImageMagick => T::ImageMagick,
            Q::PsnrHvsM => T::CustomPsnrHvs,
            Q::KleinSilversteinCarney => T::KleinSilversteinCarney,
            Q::WatsonTaylorBorthwick => T::DentalXRays,
            Q::AhumadaWatsonPeterson => T::VisualDetectionModel,
            Q::PetersonAhumadaWatson => T::ImprovedDetectionModel,
        }
    }
}

#[derive(Clone, Debug)]
pub struct JpegSpec {
    /// 1-100
    pub quality: u8,
    pub progressive: bool,
    /// `false` is 4:4:4, `true` is 4:2:0.
    pub chroma_subsampling: bool,
    pub optimize_coding: bool,
    pub quantization_table: QuantizationTable,
}

impl Default for JpegSpec {
    fn default() -> Self {
        // Same as sharp.
        Self {
            quality: 80,
            progressive: false,
            chroma_subsampling: true,
            optimize_coding: true,
            quantization_table: QuantizationTable::AnnexK,
        }
    }
}

impl JpegSpec {
    /// Approximates sharp's `mozjpeg: true` preset. jpeg-encoder doesn't implement trellis
    /// quantization or scan optimization, so files are somewhat larger than mozjpeg's.
    pub fn apply_mozjpeg_preset(&mut self) {
        self.progressive = true;
        self.optimize_coding = true;
        self.quantization_table = QuantizationTable::ImageMagick;
    }
}

pub fn encode(img: DynamicImage, spec: &JpegSpec) -> Result<(Vec<u8>, u8)> {
    check_dimensions(&img, u32::from(u16::MAX), "JPEG")?;
    let img = flatten(img);
    let (color_type, channels) = match img {
        DynamicImage::ImageLuma8(_) => (ColorType::Luma, 1),
        _ => (ColorType::Rgb, 3),
    };
    let img = if channels == 3 {
        DynamicImage::ImageRgb8(img.into_rgb8())
    } else {
        img
    };

    let mut out = Vec::new();
    let mut encoder = Encoder::new(&mut out, spec.quality);
    encoder.set_progressive(spec.progressive);
    encoder.set_optimized_huffman_tables(spec.optimize_coding);
    encoder.set_sampling_factor(if spec.chroma_subsampling {
        SamplingFactor::F_2_2
    } else {
        SamplingFactor::F_1_1
    });
    encoder.set_chroma_subsampling_method(ChromaSubsamplingMethod::Average);
    let table = spec.quantization_table.to_encoder_type();
    encoder.set_quantization_tables(table.clone(), table);
    encoder
        .encode(
            img.as_bytes(),
            img.width() as u16,
            img.height() as u16,
            color_type,
        )
        .map_err(|e| Error::Encode(e.to_string()))?;
    Ok((out, channels))
}
