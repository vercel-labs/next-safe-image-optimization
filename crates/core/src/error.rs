use std::fmt;

/// Errors are sent to JS as a code and a message (see `protocol.rs`), so that the JS wrapper can
/// construct an `Error` with a stable `code` property.
#[derive(Debug)]
pub enum Error {
    UnsupportedFormat(String),
    LimitExceeded(String),
    Decode(String),
    Encode(String),
    /// This should never happen: an invalid request (the JS wrapper validates options first), or
    /// an unexpected error from a library.
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
