//! HEIF (like iPhone photos, usually HEVC), only with the pool's `dangerouslyUseSystemHeifDecoder`
//! option. It's the only format that isn't decoded with memory-safe Rust: the system's libheif (C++,
//! with codec plugins like libde265) decodes it. The worker loads libheif and its plugins at startup
//! (`load`), before its sandbox blocks opening files, and before the fork server forks. Never on
//! wasm, which can't load libraries.
//!
//! libheif applies the container's transformations (`irot`, `imir`, `clap`) itself, so the image
//! has no orientation, and converts to 8-bit RGB(A). It allocates with `malloc`, so the allocator's
//! limit doesn't see it, and `C_DECODER_BYTES_PER_PIXEL` estimates it instead.

use crate::decode::ftyp_brands;
#[cfg(target_family = "wasm")]
use crate::error::{Error, Result};

/// HEVC image and sequence brands. AVIF has its own (`avif`, `avis`), and is detected first.
const BRANDS: [&[u8; 4]; 8] = [
    b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"hevm", b"hevs",
];
const SEQUENCE_BRANDS: [&[u8; 4]; 5] = [b"hevc", b"hevx", b"hevm", b"hevs", b"msf1"];

/// Roughly how many bytes per pixel libheif allocates while decoding, on top of the input and the
/// image it's copied into: a copy of the compressed data, the decoded YCbCr planes (and alpha), and
/// their RGB(A) conversion. Measured with peak RSS on noisy 16 MP images (libheif 1.23, libde265
/// 1.0), rounded up: 8.5 for RGB, and 10 for RGBA.
pub const C_DECODER_BYTES_PER_PIXEL: u64 = 10;

/// An ISOBMFF `ftyp` box with an HEVC brand, as its major brand or a compatible one.
pub fn is_heif(input: &[u8]) -> bool {
    ftyp_brands(input).any(|brand| BRANDS.contains(&brand))
}

/// Image sequences, which might also have a still image (the one libheif decodes).
pub fn has_sequence_brand(input: &[u8]) -> bool {
    ftyp_brands(input).any(|brand| SEQUENCE_BRANDS.contains(&brand))
}

#[cfg(target_family = "wasm")]
pub fn check_available() -> Result<()> {
    Err(Error::UnsupportedFormat(
        "input is HEIF, which the wasm backend doesn't support".into(),
    ))
}

#[cfg(target_family = "wasm")]
pub fn decoder(_input: &[u8]) -> Result<Box<dyn image::ImageDecoder + '_>> {
    Err(check_available().unwrap_err())
}

#[cfg(not(target_family = "wasm"))]
pub use self::system::{check_available, decoder, load};

#[cfg(not(target_family = "wasm"))]
mod system {
    use std::ffi::{CStr, c_char, c_int, c_uint, c_void};
    use std::marker::PhantomData;
    use std::ptr;
    use std::sync::OnceLock;

    use image::error::{
        DecodingError, ImageFormatHint, LimitError, LimitErrorKind, UnsupportedError,
        UnsupportedErrorKind,
    };
    use image::{ColorType, ImageDecoder, ImageError, ImageResult};
    use libloading::Library;

    use crate::error::{Error, Result};

    #[cfg(target_os = "macos")]
    const LIBRARY_NAMES: &[&str] = &[
        "libheif.1.dylib",
        "/opt/homebrew/lib/libheif.1.dylib",
        "/usr/local/lib/libheif.1.dylib",
        "/opt/local/lib/libheif.1.dylib",
    ];
    #[cfg(windows)]
    const LIBRARY_NAMES: &[&str] = &["heif.dll", "libheif.dll"];
    #[cfg(all(unix, not(target_os = "macos")))]
    const LIBRARY_NAMES: &[&str] = &["libheif.so.1"];

    // From libheif's headers.
    const ERROR_OK: c_int = 0;
    const ERROR_UNSUPPORTED_FILETYPE: c_int = 3;
    const ERROR_UNSUPPORTED_FEATURE: c_int = 4;
    const ERROR_MEMORY_ALLOCATION: c_int = 6;
    const COLORSPACE_RGB: c_int = 1;
    const CHROMA_INTERLEAVED_RGB: c_int = 10;
    const CHROMA_INTERLEAVED_RGBA: c_int = 11;
    const CHANNEL_INTERLEAVED: c_int = 10;
    const PROFILE_PROF: c_uint = u32::from_be_bytes(*b"prof");
    const PROFILE_RICC: c_uint = u32::from_be_bytes(*b"rICC");

    /// `heif_error`, returned by value.
    #[repr(C)]
    struct HeifError {
        code: c_int,
        subcode: c_int,
        /// Owned by libheif, and only valid until the next call on the same object.
        message: *const c_char,
    }

    /// The start of `heif_decoding_options`, up to version 2. It's only ever allocated by
    /// `heif_decoding_options_alloc`, which fills in the rest with defaults.
    #[repr(C)]
    struct DecodingOptions {
        version: u8,
        ignore_transformations: u8,
        start_progress: *const c_void,
        on_progress: *const c_void,
        end_progress: *const c_void,
        progress_user_data: *mut c_void,
        convert_hdr_to_8bit: u8,
    }

    type Context = c_void;
    type Handle = c_void;
    type Image = c_void;

    /// libheif's functions (`heif_<name>`), and their signatures in its headers. All of them exist
    /// since libheif 1.13 (which added `heif_init`).
    macro_rules! api {
        ($($name:ident: fn($($arg:ty),*) $(-> $ret:ty)?;)*) => {
            struct Api {
                $($name: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)*
            }

            impl Api {
                /// SAFETY: the signatures must match the library's.
                unsafe fn load(library: &Library) -> Result<Self, libloading::Error> {
                    Ok(Api {
                        $($name: unsafe {
                            *library.get(concat!("heif_", stringify!($name)).as_bytes())?
                        },)*
                    })
                }
            }
        };
    }

    api! {
        init: fn(*const c_void) -> HeifError;
        context_alloc: fn() -> *mut Context;
        context_free: fn(*mut Context);
        context_set_max_decoding_threads: fn(*mut Context, c_int);
        context_read_from_memory_without_copy:
            fn(*mut Context, *const c_void, usize, *const c_void) -> HeifError;
        context_get_primary_image_handle: fn(*mut Context, *mut *mut Handle) -> HeifError;
        image_handle_release: fn(*const Handle);
        image_handle_get_width: fn(*const Handle) -> c_int;
        image_handle_get_height: fn(*const Handle) -> c_int;
        image_handle_has_alpha_channel: fn(*const Handle) -> c_int;
        image_handle_get_color_profile_type: fn(*const Handle) -> c_uint;
        image_handle_get_raw_color_profile_size: fn(*const Handle) -> usize;
        image_handle_get_raw_color_profile: fn(*const Handle, *mut c_void) -> HeifError;
        decoding_options_alloc: fn() -> *mut DecodingOptions;
        decoding_options_free: fn(*mut DecodingOptions);
        decode_image:
            fn(*const Handle, *mut *mut Image, c_int, c_int, *const DecodingOptions) -> HeifError;
        image_release: fn(*const Image);
        image_get_width: fn(*const Image, c_int) -> c_int;
        image_get_height: fn(*const Image, c_int) -> c_int;
        image_get_bits_per_pixel_range: fn(*const Image, c_int) -> c_int;
        image_get_plane_readonly: fn(*const Image, c_int, *mut c_int) -> *const u8;
    }

    struct Libheif {
        api: Api,
        /// Never unloaded: it's in a static.
        _library: Library,
    }

    static LIBHEIF: OnceLock<Result<Libheif, String>> = OnceLock::new();

    /// Loads libheif and its plugins (from libheif's default plugin directory), or returns why it
    /// couldn't. Only the first call does anything.
    pub fn load() -> Result<(), String> {
        match LIBHEIF.get_or_init(Libheif::load) {
            Ok(_) => Ok(()),
            Err(err) => Err(err.clone()),
        }
    }

    impl Libheif {
        fn load() -> Result<Self, String> {
            let mut errors = Vec::new();
            for &name in LIBRARY_NAMES {
                // SAFETY: loading runs the library's initializers, which is how it's meant to be
                // used.
                let library = match unsafe { Library::new(name) } {
                    Ok(library) => library,
                    Err(err) => {
                        errors.push(err.to_string());
                        continue;
                    }
                };
                // SAFETY: `api!` has libheif's signatures.
                let api = unsafe { Api::load(&library) }
                    .map_err(|err| format!("{name} is older than libheif 1.13: {err}"))?;
                // Loads the plugins.
                check(unsafe { (api.init)(ptr::null()) })
                    .map_err(|err| format!("heif_init failed: {err}"))?;
                return Ok(Libheif {
                    api,
                    _library: library,
                });
            }
            Err(errors.join(", "))
        }
    }

    pub fn check_available() -> Result<()> {
        api().map(drop)
    }

    fn api() -> Result<&'static Api> {
        match LIBHEIF.get() {
            Some(Ok(libheif)) => Ok(&libheif.api),
            Some(Err(err)) => Err(Error::UnsupportedFormat(format!(
                "input is HEIF, but the worker couldn't load libheif ({err})"
            ))),
            None => Err(Error::UnsupportedFormat(
                "input is HEIF, which is only supported with the pool's \
                 dangerouslyUseSystemHeifDecoder option"
                    .into(),
            )),
        }
    }

    pub fn decoder(input: &[u8]) -> Result<Box<dyn ImageDecoder + '_>> {
        Ok(Box::new(HeifDecoder::new(input)?))
    }

    fn hint() -> ImageFormatHint {
        ImageFormatHint::Name("HEIF".into())
    }

    fn check(err: HeifError) -> ImageResult<()> {
        if err.code == ERROR_OK {
            return Ok(());
        }
        let message = if err.message.is_null() {
            format!("libheif error {}.{}", err.code, err.subcode)
        } else {
            // SAFETY: libheif's messages are NUL-terminated, and this is before the next call.
            unsafe { CStr::from_ptr(err.message) }
                .to_string_lossy()
                .into_owned()
        };
        Err(match err.code {
            // Like a compression format without a plugin.
            ERROR_UNSUPPORTED_FILETYPE | ERROR_UNSUPPORTED_FEATURE => {
                ImageError::Unsupported(UnsupportedError::from_format_and_kind(
                    hint(),
                    UnsupportedErrorKind::GenericFeature(message),
                ))
            }
            // Including libheif's own security limits.
            ERROR_MEMORY_ALLOCATION => {
                ImageError::Limits(LimitError::from_kind(LimitErrorKind::InsufficientMemory))
            }
            _ => ImageError::Decoding(DecodingError::new(hint(), message)),
        })
    }

    fn decoding_error(message: String) -> ImageError {
        ImageError::Decoding(DecodingError::new(hint(), message))
    }

    /// The primary image. Borrows the input, which libheif reads without copying.
    struct HeifDecoder<'a> {
        api: &'static Api,
        context: *mut Context,
        /// Null until `new` gets it.
        handle: *mut Handle,
        width: u32,
        height: u32,
        has_alpha: bool,
        input: PhantomData<&'a [u8]>,
    }

    impl<'a> HeifDecoder<'a> {
        fn new(input: &'a [u8]) -> Result<Self> {
            let api = api()?;
            let context = unsafe { (api.context_alloc)() };
            if context.is_null() {
                return Err(Error::Internal("heif_context_alloc failed".into()));
            }
            let mut decoder = HeifDecoder {
                api,
                context,
                handle: ptr::null_mut(),
                width: 0,
                height: 0,
                has_alpha: false,
                input: PhantomData,
            };
            // Decodes tiles on this thread. Codec plugins may still start their own (libde265
            // always starts one, which is why the seccomp filter allows threads with libheif).
            unsafe { (api.context_set_max_decoding_threads)(context, 0) };
            // SAFETY: the context doesn't outlive the input.
            check(unsafe {
                (api.context_read_from_memory_without_copy)(
                    context,
                    input.as_ptr().cast(),
                    input.len(),
                    ptr::null(),
                )
            })?;
            check(unsafe { (api.context_get_primary_image_handle)(context, &mut decoder.handle) })?;
            let handle = decoder.handle;
            let dimension = |value: c_int| {
                u32::try_from(value)
                    .map_err(|_| Error::Decode(format!("invalid HEIF size {value}")))
            };
            decoder.width = dimension(unsafe { (api.image_handle_get_width)(handle) })?;
            decoder.height = dimension(unsafe { (api.image_handle_get_height)(handle) })?;
            decoder.has_alpha = unsafe { (api.image_handle_has_alpha_channel)(handle) } != 0;
            Ok(decoder)
        }
    }

    impl Drop for HeifDecoder<'_> {
        fn drop(&mut self) {
            unsafe {
                if !self.handle.is_null() {
                    (self.api.image_handle_release)(self.handle);
                }
                (self.api.context_free)(self.context);
            }
        }
    }

    /// Releases a decoded image.
    struct DecodedImage<'a>(&'a Api, *mut Image);

    impl Drop for DecodedImage<'_> {
        fn drop(&mut self) {
            unsafe { (self.0.image_release)(self.1) };
        }
    }

    impl ImageDecoder for HeifDecoder<'_> {
        /// After libheif's transformations.
        fn dimensions(&self) -> (u32, u32) {
            (self.width, self.height)
        }

        fn color_type(&self) -> ColorType {
            if self.has_alpha {
                ColorType::Rgba8
            } else {
                ColorType::Rgb8
            }
        }

        /// Only ICC profiles (`prof` and `rICC`). libheif converts with `nclx` profiles itself.
        fn icc_profile(&mut self) -> ImageResult<Option<Vec<u8>>> {
            let api = self.api;
            let kind = unsafe { (api.image_handle_get_color_profile_type)(self.handle) };
            if kind != PROFILE_PROF && kind != PROFILE_RICC {
                return Ok(None);
            }
            let size = unsafe { (api.image_handle_get_raw_color_profile_size)(self.handle) };
            let mut icc = vec![0u8; size];
            check(unsafe {
                (api.image_handle_get_raw_color_profile)(self.handle, icc.as_mut_ptr().cast())
            })?;
            Ok(Some(icc))
        }

        fn read_image(self, buf: &mut [u8]) -> ImageResult<()> {
            let api = self.api;
            let options = unsafe { (api.decoding_options_alloc)() };
            if options.is_null() {
                return Err(ImageError::Limits(LimitError::from_kind(
                    LimitErrorKind::InsufficientMemory,
                )));
            }
            // SAFETY: `options` is at least as large as its version.
            unsafe {
                if (*options).version >= 2 {
                    (*options).convert_hdr_to_8bit = 1;
                }
            }
            let (chroma, channels) = if self.has_alpha {
                (CHROMA_INTERLEAVED_RGBA, 4)
            } else {
                (CHROMA_INTERLEAVED_RGB, 3)
            };
            let mut image = ptr::null_mut();
            let result = unsafe {
                (api.decode_image)(self.handle, &mut image, COLORSPACE_RGB, chroma, options)
            };
            unsafe { (api.decoding_options_free)(options) };
            check(result)?;
            let image = DecodedImage(api, image);

            let width = unsafe { (api.image_get_width)(image.1, CHANNEL_INTERLEAVED) };
            let height = unsafe { (api.image_get_height)(image.1, CHANNEL_INTERLEAVED) };
            if (i64::from(width), i64::from(height))
                != (i64::from(self.width), i64::from(self.height))
            {
                return Err(decoding_error(format!(
                    "decoded image is {width}x{height}, but its header says {}x{}",
                    self.width, self.height
                )));
            }
            let bits =
                unsafe { (api.image_get_bits_per_pixel_range)(image.1, CHANNEL_INTERLEAVED) };
            if bits != 8 {
                return Err(decoding_error(format!(
                    "libheif decoded {bits} bits per channel, instead of 8"
                )));
            }
            let mut stride: c_int = 0;
            let plane = unsafe {
                (api.image_get_plane_readonly)(image.1, CHANNEL_INTERLEAVED, &mut stride)
            };
            let row = self.width as usize * channels;
            let stride = usize::try_from(stride).unwrap_or(0);
            if plane.is_null() || stride < row || buf.len() != row * self.height as usize {
                return Err(decoding_error(
                    "libheif returned an invalid image plane".into(),
                ));
            }
            for (y, dst) in buf.chunks_exact_mut(row).enumerate() {
                // SAFETY: the plane has `height` rows, `stride` bytes apart, each with at least
                // `row` bytes.
                let src = unsafe { std::slice::from_raw_parts(plane.add(y * stride), row) };
                dst.copy_from_slice(src);
            }
            Ok(())
        }

        fn read_image_boxed(self: Box<Self>, buf: &mut [u8]) -> ImageResult<()> {
            (*self).read_image(buf)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brands() {
        assert!(is_heif(b"\0\0\0\x18ftypheic\0\0\0\0mif1heic"));
        assert!(is_heif(b"\0\0\0\x18ftypmif1\0\0\0\0mif1heix"));
        assert!(!is_heif(b"\0\0\0\x18ftypmif1\0\0\0\0mif1miaf"));
        assert!(!is_heif(b"\0\0\0\x18ftypavif\0\0\0\0mif1avif"));
        // Not an `ftyp` box.
        assert!(!is_heif(b"\0\0\0\x18moovheic\0\0\0\0mif1heic"));
        // `heic` after the end of the box.
        assert!(!is_heif(b"\0\0\0\x14ftypmif1\0\0\0\0mif1heic"));

        assert!(has_sequence_brand(b"\0\0\0\x18ftypheic\0\0\0\0mif1msf1"));
        assert!(has_sequence_brand(b"\0\0\0\x10ftyphevc\0\0\0\0"));
        assert!(!has_sequence_brand(b"\0\0\0\x18ftypheic\0\0\0\0mif1heic"));
    }
}
