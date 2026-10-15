use std::fmt;

/// Errors are reported to JS as `{ code, message }` instead of a thrown napi error so that the JS
/// wrapper can construct an `Error` with a stable `code` property. napi-rs can't attach custom codes
/// to async task rejections on every platform (wasm drops the original JS error object).
#[derive(Debug)]
pub enum Error {
    UnsupportedFormat(String),
    LimitExceeded(String),
    Decode(String),
    Encode(String),
    /// A panic was caught. This should never happen, but decoders are fed untrusted input, and an
    /// uncaught panic on a libuv thread would abort the process.
    Internal(String),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::UnsupportedFormat(_) => "ERR_UNSUPPORTED_FORMAT",
            Error::LimitExceeded(_) => "ERR_LIMIT_EXCEEDED",
            Error::Decode(_) => "ERR_DECODE_FAILED",
            Error::Encode(_) => "ERR_ENCODE_FAILED",
            Error::Internal(_) => "ERR_INTERNAL",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::UnsupportedFormat(msg) => write!(f, "Unsupported format: {msg}"),
            Error::LimitExceeded(msg) => write!(f, "Limit exceeded: {msg}"),
            Error::Decode(msg) => write!(f, "Failed to decode image: {msg}"),
            Error::Encode(msg) => write!(f, "Failed to encode image: {msg}"),
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
