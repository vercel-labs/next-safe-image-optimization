//! `--system-heif`, with HEVC fixtures from the system's libheif and its encoder plugin (x265),
//! decoded by the worker binary, in its sandbox. Skipped if libheif or its HEVC encoder isn't
//! installed, unless `NSIO_TEST_LIBHEIF=1`.

#![cfg(unix)]

use std::ffi::{CStr, c_char, c_int, c_void};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::ptr;

use libloading::Library;
use serde_json::{Value, json};

const LIBRARY_NAMES: &[&str] = &[
    "libheif.so.1",
    "libheif.1.dylib",
    "/opt/homebrew/lib/libheif.1.dylib",
    "/usr/local/lib/libheif.1.dylib",
];

#[repr(C)]
struct HeifError {
    code: c_int,
    subcode: c_int,
    message: *const c_char,
}

#[repr(C)]
struct Writer {
    version: c_int,
    write: unsafe extern "C" fn(*mut c_void, *const c_void, usize, *mut c_void) -> HeifError,
}

unsafe extern "C" fn write(
    _: *mut c_void,
    data: *const c_void,
    size: usize,
    out: *mut c_void,
) -> HeifError {
    let out = unsafe { &mut *out.cast::<Vec<u8>>() };
    out.extend_from_slice(unsafe { std::slice::from_raw_parts(data.cast(), size) });
    HeifError {
        code: 0,
        subcode: 0,
        message: c"Success".as_ptr(),
    }
}

fn check(err: HeifError) -> Result<(), String> {
    if err.code == 0 {
        return Ok(());
    }
    Err(unsafe { CStr::from_ptr(err.message) }
        .to_string_lossy()
        .into_owned())
}

/// Encodes `pixels` (RGB, or RGBA with `alpha`) as HEVC.
fn encode(width: u32, height: u32, alpha: bool, pixels: &[u8]) -> Result<Vec<u8>, String> {
    let library = LIBRARY_NAMES
        .iter()
        .find_map(|&name| unsafe { Library::new(name) }.ok())
        .ok_or("libheif isn't installed")?;
    macro_rules! f {
        ($name:literal: fn($($arg:ty),*) $(-> $ret:ty)?) => {
            *library
                .get::<unsafe extern "C" fn($($arg),*) $(-> $ret)?>($name)
                .map_err(|err| err.to_string())?
        };
    }
    let channels = if alpha { 4 } else { 3 };
    let (w, h) = (width as c_int, height as c_int);
    unsafe {
        check(f!("heif_init": fn(*const c_void) -> HeifError)(ptr::null()))?;
        let context = f!("heif_context_alloc": fn() -> *mut c_void)();
        let mut image = ptr::null_mut();
        // RGB, interleaved RGB(A).
        let chroma = if alpha { 11 } else { 10 };
        check(
            f!("heif_image_create": fn(c_int, c_int, c_int, c_int, *mut *mut c_void) -> HeifError)(
                w, h, 1, chroma, &mut image,
            ),
        )?;
        check(
            f!("heif_image_add_plane": fn(*mut c_void, c_int, c_int, c_int, c_int) -> HeifError)(
                image, 10, w, h, 8,
            ),
        )?;
        let mut stride = 0;
        let plane = f!("heif_image_get_plane": fn(*mut c_void, c_int, *mut c_int) -> *mut u8)(
            image,
            10,
            &mut stride,
        );
        let row = width as usize * channels;
        for (y, src) in pixels.chunks_exact(row).enumerate() {
            ptr::copy_nonoverlapping(src.as_ptr(), plane.add(y * stride as usize), row);
        }
        let mut encoder = ptr::null_mut();
        check(f!("heif_context_get_encoder_for_format":
            fn(*mut c_void, c_int, *mut *mut c_void) -> HeifError)(
            context,
            1,
            &mut encoder,
        ))
        .map_err(|err| format!("no HEVC encoder: {err}"))?;
        check(
            f!("heif_encoder_set_lossy_quality": fn(*mut c_void, c_int) -> HeifError)(encoder, 95),
        )?;
        check(f!("heif_context_encode_image":
            fn(*mut c_void, *const c_void, *mut c_void, *const c_void, *mut *mut c_void) -> HeifError)(
            context,
            image,
            encoder,
            ptr::null(),
            ptr::null_mut(),
        ))?;
        let mut out = Vec::new();
        let writer = Writer { version: 1, write };
        check(
            f!("heif_context_write": fn(*mut c_void, *const Writer, *mut c_void) -> HeifError)(
                context,
                &writer,
                (&raw mut out).cast(),
            ),
        )?;
        Ok(out)
    }
}

/// A smooth gradient, which lossy HEVC keeps close.
fn gradient(width: u32, height: u32, alpha: bool) -> Vec<u8> {
    let mut pixels = Vec::new();
    for y in 0..height {
        for x in 0..width {
            pixels.extend([(x * 255 / width) as u8, (y * 255 / height) as u8, 128]);
            if alpha {
                pixels.push(((x + y) * 255 / (width + height)) as u8);
            }
        }
    }
    pixels
}

/// Sends each request to one worker, and returns the responses' JSON and data.
fn run(flags: &[&str], requests: &[(&[u8], Value)]) -> Vec<(Value, Vec<u8>)> {
    let mut worker = Command::new(env!("CARGO_BIN_EXE_safe-image-optimization-worker"))
        .args([
            env!("CARGO_PKG_VERSION"),
            &std::process::id().to_string(),
            "0",
        ])
        .args(flags)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut stdin = worker.stdin.take().unwrap();
    let mut stdout = worker.stdout.take().unwrap();
    let responses = requests
        .iter()
        .map(|(input, options)| {
            let json = options.to_string();
            let mut request = input.to_vec();
            request.extend_from_slice(json.as_bytes());
            request.extend_from_slice(&(json.len() as u32).to_le_bytes());
            stdin
                .write_all(&(request.len() as u64).to_le_bytes())
                .unwrap();
            stdin.write_all(&request).unwrap();

            let mut len = [0; 8];
            stdout.read_exact(&mut len).unwrap();
            let mut response = vec![0; u64::from_le_bytes(len) as usize];
            stdout.read_exact(&mut response).unwrap();
            let json_len = u32::from_le_bytes(response[..4].try_into().unwrap()) as usize;
            let data = response.split_off(4 + json_len);
            (serde_json::from_slice(&response[4..]).unwrap(), data)
        })
        .collect();
    drop(stdin);
    assert!(worker.wait().unwrap().success());
    responses
}

fn decode_png(data: &[u8]) -> (png::OutputInfo, Vec<u8>) {
    let mut reader = png::Decoder::new(std::io::Cursor::new(data))
        .read_info()
        .unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut pixels).unwrap();
    pixels.truncate(info.buffer_size());
    (info, pixels)
}

#[test]
fn decodes_heif() {
    let (width, height) = (64, 48);
    let fixtures = [false, true].map(|alpha| {
        let pixels = gradient(width, height, alpha);
        encode(width, height, alpha, &pixels).map(|heif| (alpha, pixels, heif))
    });
    let fixtures = match fixtures.into_iter().collect::<Result<Vec<_>, _>>() {
        Ok(fixtures) => fixtures,
        Err(err) if std::env::var_os("NSIO_TEST_LIBHEIF").is_none_or(|v| v != "1") => {
            eprintln!("skipped: {err}");
            return;
        }
        Err(err) => panic!("{err}"),
    };

    for (alpha, pixels, heif) in &fixtures {
        // Twice, to check that libde265's threads come and go in the sandbox.
        let transform = json!({"transform": {"format": "png", "resize": {"width": width}}});
        let responses = run(
            &["--system-heif=required"],
            &[
                (heif, json!({"metadata": {}})),
                (heif, transform.clone()),
                (heif, transform),
            ],
        );
        let channels = if *alpha { 4 } else { 3 };
        assert_eq!(
            responses[0].0,
            json!({"type": "metadata", "meta": {
                "format": "heif",
                "width": width,
                "height": height,
                "hasAlpha": alpha,
                "orientation": 1,
                "hasProfile": false,
            }})
        );
        for (response, data) in &responses[1..] {
            assert_eq!(
                *response,
                json!({"type": "transform", "meta": {
                    "format": "png", "width": width, "height": height, "channels": channels,
                }})
            );
            let (info, decoded) = decode_png(data);
            assert_eq!((info.width, info.height), (width, height));
            let diff: u64 = decoded
                .iter()
                .zip(pixels)
                .map(|(&a, &b)| u64::from(a.abs_diff(b)))
                .sum();
            let mean = diff as f64 / pixels.len() as f64;
            assert!(mean < 3.0, "mean difference of {mean}");
        }
    }

    let heif = &fixtures[0].2;
    for (flags, options, message) in [
        (&[][..], json!({}), "dangerouslyUseSystemHeifDecoder"),
        (
            &["--system-heif"],
            json!({"allowedInputFormats": ["jpeg"]}),
            "allowed input formats",
        ),
    ] {
        let responses = run(flags, &[(heif, json!({ "metadata": options }))]);
        let meta = &responses[0].0["meta"];
        assert_eq!(meta["code"], "ERR_UNSUPPORTED_FORMAT");
        assert!(
            meta["message"].as_str().unwrap().contains(message),
            "{meta}"
        );
    }
}
