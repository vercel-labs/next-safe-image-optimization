//! The native binding. It only manages worker processes: images are processed by
//! `blunt-image-optimization-worker` (`crates/worker`). This is internal: the public API is the
//! TypeScript wrapper in `js/`, which encodes requests and decodes responses (`js/protocol.ts`).

#![deny(clippy::all)]

mod pool;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::pool::{Config, Failure, Job, Pool};

/// The platform in napi's format (like `linux-x64-gnu`), which the worker's file name includes.
#[napi]
pub fn target() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        os => os,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        arch => arch,
    };
    let abi = if cfg!(target_env = "musl") {
        "-musl"
    } else if cfg!(target_env = "msvc") {
        "-msvc"
    } else if cfg!(all(target_os = "linux", target_env = "gnu")) {
        "-gnu"
    } else {
        ""
    };
    format!("{os}-{arch}{abi}")
}

#[napi(object)]
pub struct PoolOptions {
    pub worker_path: String,
    pub max_processes: u32,
    pub idle_timeout_ms: u32,
}

#[napi(object)]
pub struct RunOptions {
    /// Omit to wait indefinitely.
    pub timeout_ms: Option<f64>,
    /// A larger response is treated as a crash.
    pub max_response_bytes: f64,
}

#[napi(object)]
pub struct RunError {
    pub code: String,
    pub message: String,
}

/// Exactly one of `response` or `error` is set. `response` is untrusted.
#[napi(object)]
pub struct RunResult {
    pub response: Option<Buffer>,
    pub error: Option<RunError>,
}

#[napi]
pub struct WorkerPool {
    pool: Arc<Pool>,
}

fn invalid(message: String) -> napi::Error {
    napi::Error::new(Status::InvalidArg, message)
}

type Resolver = Box<dyn FnOnce(Env) -> napi::Result<RunResult> + Send>;

#[napi]
impl WorkerPool {
    #[napi(constructor)]
    pub fn new(options: PoolOptions) -> napi::Result<Self> {
        if options.max_processes == 0 {
            return Err(invalid("maxProcesses must be at least 1".into()));
        }
        let pool = Pool::new(Config {
            worker_path: PathBuf::from(options.worker_path),
            max_processes: options.max_processes as usize,
            idle_timeout: Duration::from_millis(u64::from(options.idle_timeout_ms)),
        })
        .map_err(|err| {
            napi::Error::from_reason(format!("failed to start the watchdog thread: {err}"))
        })?;
        Ok(WorkerPool { pool })
    }

    /// Sends `[input][optionsJson][u32 LE length of optionsJson]` to a worker (see
    /// `crates/core/src/protocol.rs`). `input` is copied before this returns, so the caller may
    /// reuse the buffer immediately. (Reading from memory that JS can concurrently mutate would be
    /// a data race.)
    #[napi(ts_return_type = "Promise<RunResult>")]
    pub fn run<'env>(
        &self,
        env: &'env Env,
        input: &[u8],
        options_json: String,
        options: RunOptions,
    ) -> napi::Result<Object<'env>> {
        let timeout = options
            .timeout_ms
            .map(|ms| {
                Duration::try_from_secs_f64(ms / 1000.0)
                    .map_err(|_| invalid(format!("invalid timeout: {ms}")))
            })
            .transpose()?;
        let json_len = u32::try_from(options_json.len())
            .map_err(|_| invalid("options are too large".into()))?;
        let request_len = input.len() + options_json.len() + 4;
        let mut frame = Vec::with_capacity(8 + request_len);
        frame.extend_from_slice(&(request_len as u64).to_le_bytes());
        frame.extend_from_slice(input);
        frame.extend_from_slice(options_json.as_bytes());
        frame.extend_from_slice(&json_len.to_le_bytes());

        let (deferred, promise) = env.create_deferred::<RunResult, Resolver>()?;
        self.pool.submit(Job {
            frame,
            timeout,
            max_response_bytes: options.max_response_bytes as u64,
            done: Box::new(move |result: std::result::Result<Vec<u8>, Failure>| {
                deferred.resolve(Box::new(move |_env| {
                    Ok(match result {
                        Ok(response) => RunResult {
                            response: Some(response.into()),
                            error: None,
                        },
                        Err(failure) => RunResult {
                            response: None,
                            error: Some(RunError {
                                code: failure.code.to_owned(),
                                message: failure.message,
                            }),
                        },
                    })
                }))
            }),
        });
        Ok(promise)
    }
}
