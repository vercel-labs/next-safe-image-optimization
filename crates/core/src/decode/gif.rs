//! GIF is decoded with `image`'s `GifDecoder`. This only checks for animation.

use crate::error::{Error, Result};

/// GIFs don't declare animations, so a GIF is animated if it has a second frame. `GifDecoder` can
/// only find one by decoding it (`into_frames`), so this scans for one without LZW decoding.
pub fn has_second_frame(input: &[u8]) -> Result<bool> {
    let mut options = ::gif::DecodeOptions::new();
    options.set_color_output(::gif::ColorOutput::Indexed);
    options.skip_frame_decoding(true);
    let decode_error = |err: ::gif::DecodingError| Error::Decode(err.to_string());
    let mut decoder = options.read_info(input).map_err(decode_error)?;
    if decoder.next_frame_info().map_err(decode_error)?.is_none() {
        return Ok(false);
    }
    // Like the decoder, which only reads the first frame, ignore errors after it.
    Ok(matches!(decoder.next_frame_info(), Ok(Some(_))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_frame() {
        let gif = |frames: usize| {
            let mut gif = Vec::new();
            let mut encoder =
                ::gif::Encoder::new(&mut gif, 2, 2, &[0, 0, 0, 255, 255, 255]).unwrap();
            for _ in 0..frames {
                let frame = ::gif::Frame::from_indexed_pixels(2, 2, vec![0, 1, 1, 0], None);
                encoder.write_frame(&frame).unwrap();
            }
            drop(encoder);
            gif
        };
        assert!(!has_second_frame(&gif(1)).unwrap());
        assert!(has_second_frame(&gif(2)).unwrap());
        // Truncated after the first frame.
        let two = gif(2);
        assert!(!has_second_frame(&two[..gif(1).len() - 1 + 5]).unwrap());
        assert!(has_second_frame(b"GIF89a").is_err());
    }
}
