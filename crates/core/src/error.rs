use std::fmt;

use serde::Serialize;
use typeshare_annotation::typeshare;

/// Errors are sent to JS as a code and a message (see `protocol.rs`), so that the JS wrapper can
/// construct an `Error` with a stable `code` property.
#[derive(Debug)]
pub enum Error {
    UnsupportedFormat(String),
    /// An animated image, with `allowAnimated: false`.
    Animated(String),
    LimitExceeded(String),
    Decode(String),
    Encode(String),
    /// Options the caller passed (see `request.rs`). The JS wrapper throws these as `TypeError`s.
    InvalidOptions(String),
    /// This should never happen: a malformed request from the JS wrapper, or an unexpected error
    /// from a library.
    Internal(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Responses send error codes as their index in this enum (see `protocol.rs`).
#[typeshare]
// `Serialize` is only for the `serde` attributes, which typeshare reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum ErrorCode {
    #[serde(rename = "ERR_UNSUPPORTED_FORMAT")]
    UnsupportedFormat,
    #[serde(rename = "ERR_LIMIT_EXCEEDED")]
    LimitExceeded,
    #[serde(rename = "ERR_DECODE_FAILED")]
    DecodeFailed,
    #[serde(rename = "ERR_ENCODE_FAILED")]
    EncodeFailed,
    #[serde(rename = "ERR_INTERNAL")]
    Internal,
    /// The input is animated, with `allowAnimated: false`.
    #[serde(rename = "ERR_ANIMATED")]
    Animated,
    /// Thrown as a `TypeError`, not a `BluntError`.
    #[serde(rename = "ERR_INVALID_OPTIONS")]
    InvalidOptions,
}

impl Error {
    pub fn code(&self) -> ErrorCode {
        match self {
            Error::UnsupportedFormat(_) => ErrorCode::UnsupportedFormat,
            Error::Animated(_) => ErrorCode::Animated,
            Error::LimitExceeded(_) => ErrorCode::LimitExceeded,
            Error::Decode(_) => ErrorCode::DecodeFailed,
            Error::Encode(_) => ErrorCode::EncodeFailed,
            Error::InvalidOptions(_) => ErrorCode::InvalidOptions,
            Error::Internal(_) => ErrorCode::Internal,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::UnsupportedFormat(msg) => write!(f, "Unsupported format: {msg}"),
            Error::Animated(msg) => write!(f, "Animated images are not allowed: {msg}"),
            Error::LimitExceeded(msg) => write!(f, "Limit exceeded: {msg}"),
            Error::Decode(msg) => write!(f, "Failed to decode image: {msg}"),
            Error::Encode(msg) => write!(f, "Failed to encode image: {msg}"),
            // Becomes a `TypeError`, like the wrapper's own, which have no prefix either.
            Error::InvalidOptions(msg) => f.write_str(msg),
            Error::Internal(msg) => write!(f, "Internal error: {msg}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<image::ImageError> for Error {
    fn from(err: image::ImageError) -> Self {
        use image::ImageError as E;
        match err {
            E::Limits(err) => Error::LimitExceeded(err.to_string()),
            E::Unsupported(err) => Error::UnsupportedFormat(err.to_string()),
            E::Encoding(err) => Error::Encode(err.to_string()),
            err @ (E::Decoding(_) | E::Parameter(_) | E::IoError(_)) => {
                Error::Decode(err.to_string())
            }
        }
    }
}
