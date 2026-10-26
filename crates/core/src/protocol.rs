//! The worker protocol, shared by the native worker process and the wasm module. `js/protocol.ts`
//! is the other side.
//!
//! A request is `[input][options JSON][u32 LE length of the JSON]`. The options are at the end so
//! that the input can be decoded in place. Requests come from our JS wrapper (trusted), but
//! responses go back to a parent that treats them as untrusted.
//!
//! A response is `[u64 LE length of the rest][u32 LE length of the JSON][JSON][data]`. The JSON is
//! a [`Response`], like `{"type":"transform","meta":{...}}`, and `data` is the encoded image
//! (empty for metadata and errors). The JSON is first, so that the encoded image can be written
//! out without copying it.
//!
//! Items marked `#[typeshare]` (here, and the request options in `request.rs`) are exported to
//! `js/protocol.generated.ts` by `pnpm generate`.

use serde::Serialize;
use typeshare_annotation::typeshare;

use crate::alloc::set_memory_limit;
use crate::decode::InputFormat;
use crate::encode::OutputFormat;
use crate::error::{Error, ErrorCode, Result};
use crate::limits::Limits;
use crate::pipeline;
use crate::request::{self, Request};

/// Worker exit codes, besides 0 (stdin closed).
#[typeshare]
pub const EXIT_OUT_OF_MEMORY: i32 = 86;
#[typeshare]
pub const EXIT_VERSION_MISMATCH: i32 = 87;
#[typeshare]
pub const EXIT_SANDBOX_FAILED: i32 = 88;
#[typeshare]
pub const EXIT_INVALID_FRAME: i32 = 89;
/// Allocations exceeded the request's `limitAllocatorMemory` (see `alloc.rs`).
#[typeshare]
pub const EXIT_MEMORY_LIMIT: i32 = 90;

/// The most JSON that a response may have (64 KiB). The data's limit is the request's
/// `limitOutputBytes`.
#[typeshare]
// A literal, because typeshare exports `64 * 1024` as 64.
pub const MAX_JSON_BYTES: u32 = 65536;
/// Error messages are truncated to this many characters, which keeps the JSON well within
/// `MAX_JSON_BYTES`.
const MAX_MESSAGE_CHARS: usize = 1000;

const LENGTH_PREFIX: usize = 8;
const JSON_LENGTH: usize = 4;

#[typeshare]
#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "meta")]
enum Response {
    Transform(TransformResponse),
    Metadata(MetadataResponse),
    Error(ErrorResponse),
}

/// Describes the encoded image in `data`.
#[typeshare]
#[derive(Serialize)]
struct TransformResponse {
    format: OutputFormat,
    width: u32,
    height: u32,
    channels: u8,
}

#[typeshare]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataResponse {
    format: InputFormat,
    width: u32,
    height: u32,
    has_alpha: bool,
    /// EXIF orientation, 1-8.
    orientation: u8,
    has_profile: bool,
}

#[typeshare]
#[derive(Serialize)]
struct ErrorResponse {
    code: ErrorCode,
    message: String,
}

/// A framed response is `head` followed by `data`. They're separate so that the encoded image
/// doesn't have to be copied.
pub struct Frame {
    /// The length prefixes and the JSON.
    pub head: Vec<u8>,
    pub data: Vec<u8>,
}

/// Processes a request and returns the framed response.
pub fn handle(request: Vec<u8>) -> Frame {
    let result = run(request);
    // The next request's input is read before its limit is known.
    set_memory_limit(usize::MAX);
    let (response, data) = result.unwrap_or_else(|err| {
        let mut message = err.to_string();
        if let Some((end, _)) = message.char_indices().nth(MAX_MESSAGE_CHARS) {
            message.truncate(end);
        }
        let response = Response::Error(ErrorResponse {
            code: err.code(),
            message,
        });
        (response, Vec::new())
    });
    let mut head = vec![0; LENGTH_PREFIX + JSON_LENGTH];
    serde_json::to_writer(&mut head, &response).expect("responses are serializable");
    let json_len = (head.len() - LENGTH_PREFIX - JSON_LENGTH) as u32;
    let len = (head.len() - LENGTH_PREFIX + data.len()) as u64;
    head[..LENGTH_PREFIX].copy_from_slice(&len.to_le_bytes());
    head[LENGTH_PREFIX..][..JSON_LENGTH].copy_from_slice(&json_len.to_le_bytes());
    Frame { head, data }
}

fn run(mut request: Vec<u8>) -> Result<(Response, Vec<u8>)> {
    let invalid = || Error::Internal("invalid request: truncated".into());
    let json_len_start = request.len().checked_sub(4).ok_or_else(invalid)?;
    let json_len = u32::from_le_bytes(request[json_len_start..].try_into().unwrap()) as usize;
    let json_start = json_len_start.checked_sub(json_len).ok_or_else(invalid)?;
    let request_options = request::parse(&request[json_start..json_len_start])?;
    request.truncate(json_start);
    let input = request;

    Ok(match request_options {
        Request::Transform(options) => {
            let pipeline = request::parse_pipeline(options)?;
            limit_allocator_memory(&pipeline.limits);
            let output = pipeline::run(input, &pipeline)?;
            let encoded = output.encoded;
            let response = Response::Transform(TransformResponse {
                format: output.format,
                width: encoded.width,
                height: encoded.height,
                channels: encoded.channels,
            });
            (response, encoded.data)
        }
        Request::Metadata(options) => {
            let limits = request::parse_limits(Some(options))?;
            limit_allocator_memory(&limits);
            let header = pipeline::metadata(&input, &limits)?;
            let response = Response::Metadata(MetadataResponse {
                format: header.format,
                width: header.width,
                height: header.height,
                has_alpha: header.has_alpha,
                orientation: header.orientation.to_exif(),
                has_profile: header.icc_profile.is_some(),
            });
            (response, Vec::new())
        }
    })
}

/// The limit covers everything the worker has allocated, including the request itself.
fn limit_allocator_memory(limits: &Limits) {
    set_memory_limit(usize::try_from(limits.memory).unwrap_or(usize::MAX));
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn request(input: &[u8], json: &str) -> Vec<u8> {
        let mut request = input.to_vec();
        request.extend_from_slice(json.as_bytes());
        request.extend_from_slice(&(json.len() as u32).to_le_bytes());
        request
    }

    /// Returns the JSON and the data.
    fn split(frame: Frame) -> (Value, Vec<u8>) {
        let mut bytes = frame.head;
        bytes.extend_from_slice(&frame.data);
        let len = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        assert_eq!(len as usize, bytes.len() - 8);
        let json_len = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let data = bytes.split_off(12 + json_len);
        (serde_json::from_slice(&bytes[12..]).unwrap(), data)
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
        let (response, data) = split(handle(request(&png, r#"{"transform":{"format":"jpeg"}}"#)));
        let meta = json!({"format": "jpeg", "width": 3, "height": 2, "channels": 3});
        assert_eq!(response, json!({"type": "transform", "meta": meta}));
        assert_eq!(data[..2], [0xFF, 0xD8]);

        let (response, data) = split(handle(request(&png, r#"{"metadata":{}}"#)));
        let meta = json!({
            "format": "png",
            "width": 3,
            "height": 2,
            "hasAlpha": false,
            "orientation": 1,
            "hasProfile": false,
        });
        assert_eq!(response, json!({"type": "metadata", "meta": meta}));
        assert!(data.is_empty());
    }

    #[test]
    fn errors() {
        for (request, code) in [
            (Vec::new(), "ERR_INTERNAL"),
            (vec![0, 0, 0, 0xFF], "ERR_INTERNAL"),
            (request(b"not an image", "{}"), "ERR_INVALID_OPTIONS"),
            (
                request(b"not an image", r#"{"metadata":{}}"#),
                "ERR_UNSUPPORTED_FORMAT",
            ),
        ] {
            let (response, data) = split(handle(request));
            assert_eq!(response["type"], "error");
            assert_eq!(response["meta"]["code"], code);
            assert!(response["meta"]["message"].is_string());
            assert!(data.is_empty());
        }
    }

    #[test]
    fn long_error_messages_are_truncated() {
        // The message includes the JSON.
        let json = format!(r#"{{"other":"{}"}}"#, "é".repeat(100_000));
        let (response, _) = split(handle(request(b"", &json)));
        assert_eq!(response["meta"]["code"], "ERR_INVALID_OPTIONS");
        let message = response["meta"]["message"].as_str().unwrap();
        assert_eq!(message.chars().count(), MAX_MESSAGE_CHARS);
    }
}
