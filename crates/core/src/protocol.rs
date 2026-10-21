//! The worker protocol, shared by the native worker process and the wasm module. `js/protocol.ts`
//! is the other side.
//!
//! A request is `[input][options JSON][u32 LE length of the JSON]`. The options are at the end so
//! that the input can be decoded in place. Requests come from our JS wrapper (trusted), but
//! responses go back to a parent that treats them as untrusted.
//!
//! A response is `[u64 LE length of the rest][kind u8][...]`:
//! - `KIND_TRANSFORM`: `[format u8][width u32][height u32][channels u8][data]`
//! - `KIND_METADATA`: `[format u8][width u32][height u32][has_alpha u8][orientation u8][has_profile u8]`
//! - `KIND_ERROR`: `[code u8][UTF-8 message]`
//!
//! Integers are little-endian. Formats and error codes are indexes into [`FORMATS`] and
//! [`ERROR_CODES`].

use crate::alloc::set_memory_limit;
use crate::error::{Error, Result};
use crate::limits::Limits;
use crate::pipeline;
use crate::request::{self, Request};

/// Worker exit codes, besides 0 (stdin closed). These must match `crates/shim/src/pool.rs` and
/// `js/wasm-worker.ts`.
pub const EXIT_OUT_OF_MEMORY: i32 = 86;
pub const EXIT_VERSION_MISMATCH: i32 = 87;
pub const EXIT_SANDBOX_FAILED: i32 = 88;
pub const EXIT_INVALID_FRAME: i32 = 89;
/// Allocations exceeded the request's `limitAllocatorMemory` (see `alloc.rs`).
pub const EXIT_MEMORY_LIMIT: i32 = 90;

pub const KIND_TRANSFORM: u8 = 0;
pub const KIND_METADATA: u8 = 1;
pub const KIND_ERROR: u8 = 2;

pub const FORMATS: [&str; 7] = ["jpeg", "png", "webp", "gif", "tiff", "avif", "svg"];
pub const ERROR_CODES: [&str; 6] = [
    "ERR_UNSUPPORTED_FORMAT",
    "ERR_LIMIT_EXCEEDED",
    "ERR_DECODE_FAILED",
    "ERR_ENCODE_FAILED",
    "ERR_INTERNAL",
    "ERR_ANIMATED",
];

const LENGTH_PREFIX: usize = 8;

/// A response is `head` followed by `data`. They're separate so that the encoded image doesn't
/// have to be copied.
pub struct Response {
    /// Includes the length prefix.
    pub head: Vec<u8>,
    pub data: Vec<u8>,
}

/// Processes a request and returns the response.
pub fn handle(request: Vec<u8>) -> Response {
    let mut response = Response {
        head: vec![0; LENGTH_PREFIX],
        data: Vec::new(),
    };
    let result = run(request, &mut response);
    // The next request's input is read before its limit is known.
    set_memory_limit(usize::MAX);
    if let Err(err) = result {
        response.head.truncate(LENGTH_PREFIX);
        response.head.push(KIND_ERROR);
        response.head.push(error_index(&err));
        response.head.extend_from_slice(err.to_string().as_bytes());
        response.data = Vec::new();
    }
    let len = (response.head.len() - LENGTH_PREFIX + response.data.len()) as u64;
    response.head[..LENGTH_PREFIX].copy_from_slice(&len.to_le_bytes());
    response
}

fn run(mut request: Vec<u8>, response: &mut Response) -> Result<()> {
    let invalid = || Error::Internal("invalid request: truncated".into());
    let json_len_start = request.len().checked_sub(4).ok_or_else(invalid)?;
    let json_len = u32::from_le_bytes(request[json_len_start..].try_into().unwrap()) as usize;
    let json_start = json_len_start.checked_sub(json_len).ok_or_else(invalid)?;
    let request_options = request::parse(&request[json_start..json_len_start])?;
    request.truncate(json_start);
    let input = request;

    match request_options {
        Request::Transform(options) => {
            let pipeline = request::parse_pipeline(options)?;
            limit_allocator_memory(&pipeline.limits);
            let output = pipeline::run(input, &pipeline)?;
            let encoded = output.encoded;
            let head = &mut response.head;
            head.push(KIND_TRANSFORM);
            head.push(format_index(output.format));
            head.extend_from_slice(&encoded.width.to_le_bytes());
            head.extend_from_slice(&encoded.height.to_le_bytes());
            head.push(encoded.channels);
            response.data = encoded.data;
        }
        Request::Metadata(options) => {
            let limits = request::parse_limits(Some(options))?;
            limit_allocator_memory(&limits);
            let header = pipeline::metadata(&input, &limits)?;
            let head = &mut response.head;
            head.push(KIND_METADATA);
            head.push(format_index(header.format.name()));
            head.extend_from_slice(&header.width.to_le_bytes());
            head.extend_from_slice(&header.height.to_le_bytes());
            head.push(u8::from(header.has_alpha));
            head.push(header.orientation.to_exif());
            head.push(u8::from(header.icc_profile.is_some()));
        }
    }
    Ok(())
}

/// The limit covers everything the worker has allocated, including the request itself.
fn limit_allocator_memory(limits: &Limits) {
    set_memory_limit(usize::try_from(limits.memory).unwrap_or(usize::MAX));
}

fn format_index(name: &str) -> u8 {
    FORMATS
        .iter()
        .position(|&format| format == name)
        .expect("format is in FORMATS") as u8
}

fn error_index(err: &Error) -> u8 {
    ERROR_CODES
        .iter()
        .position(|&code| code == err.code())
        .expect("code is in ERROR_CODES") as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(input: &[u8], json: &str) -> Vec<u8> {
        let mut request = input.to_vec();
        request.extend_from_slice(json.as_bytes());
        request.extend_from_slice(&(json.len() as u32).to_le_bytes());
        request
    }

    fn bytes(response: Response) -> Vec<u8> {
        let mut bytes = response.head;
        bytes.extend_from_slice(&response.data);
        let len = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        assert_eq!(len as usize, bytes.len() - 8);
        bytes.split_off(8)
    }

    #[test]
    fn transform() {
        let mut png = Vec::new();
        {
            let mut encoder = ::png::Encoder::new(&mut png, 3, 2);
            encoder.set_color(::png::ColorType::Rgb);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[128; 18]).unwrap();
        }
        let body = bytes(handle(request(&png, r#"{"transform":{"format":"jpeg"}}"#)));
        assert_eq!(body[0], KIND_TRANSFORM);
        assert_eq!(FORMATS[usize::from(body[1])], "jpeg");
        assert_eq!(body[2..6], 3u32.to_le_bytes());
        assert_eq!(body[6..10], 2u32.to_le_bytes());
        assert_eq!(body[10], 3);
        assert_eq!(body[11..13], [0xFF, 0xD8]);

        let body = bytes(handle(request(&png, r#"{"metadata":{}}"#)));
        assert_eq!(body, [KIND_METADATA, 1, 3, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0]);
    }

    #[test]
    fn errors() {
        for (request, code) in [
            (Vec::new(), "ERR_INTERNAL"),
            (vec![0, 0, 0, 0xFF], "ERR_INTERNAL"),
            (request(b"not an image", "{}"), "ERR_INTERNAL"),
            (
                request(b"not an image", r#"{"metadata":{}}"#),
                "ERR_UNSUPPORTED_FORMAT",
            ),
        ] {
            let body = bytes(handle(request));
            assert_eq!(body[0], KIND_ERROR);
            assert_eq!(ERROR_CODES[usize::from(body[1])], code);
            assert!(std::str::from_utf8(&body[2..]).is_ok());
        }
    }
}
