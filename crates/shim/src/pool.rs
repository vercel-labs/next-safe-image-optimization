//! A pool of worker processes (`crates/worker`). Each live worker has a driver thread that sends it
//! one request at a time, with blocking I/O. A watchdog thread kills workers that exceed their
//! request's timeout, which also unblocks their driver.
//!
//! Workers are untrusted: a worker that sends a malformed response is killed.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

/// These must match `crates/core/src/protocol.rs`.
const EXIT_OUT_OF_MEMORY: i32 = 86;
const EXIT_VERSION_MISMATCH: i32 = 87;
const EXIT_SANDBOX_FAILED: i32 = 88;
const EXIT_MEMORY_LIMIT: i32 = 90;

pub struct Config {
    pub worker_path: PathBuf,
    pub max_processes: usize,
    pub idle_timeout: Duration,
    /// The worker's `RLIMIT_DATA` in bytes, or 0 for none.
    pub memory_limit: u64,
}

pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Failure {
            code,
            message: message.into(),
        }
    }
}

pub type Done = Box<dyn FnOnce(Result<Vec<u8>, Failure>) + Send>;

pub struct Job {
    /// `[u64 LE length][request]`.
    pub frame: Vec<u8>,
    /// Starts when a worker picks up the job, not when it's queued.
    pub timeout: Option<Duration>,
    pub max_response_bytes: u64,
    pub done: Done,
}

pub struct Pool {
    config: Config,
    state: Mutex<State>,
    available: Condvar,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Job>,
    /// Driver threads waiting for a job.
    idle: usize,
    /// Driver threads, idle or not. Each has at most one worker.
    live: usize,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Nothing panics while holding these locks, but if something did, the state is still usable.
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}

impl Pool {
    pub fn new(config: Config) -> io::Result<Arc<Self>> {
        WATCHDOG.start()?;
        Ok(Arc::new(Pool {
            config,
            state: Mutex::default(),
            available: Condvar::new(),
        }))
    }

    pub fn submit(self: &Arc<Self>, job: Job) {
        let mut state = lock(&self.state);
        state.queue.push_back(job);
        if state.queue.len() > state.idle && state.live < self.config.max_processes {
            let pool = self.clone();
            match thread::Builder::new()
                .name("blunt-worker-driver".into())
                .spawn(move || pool.drive())
            {
                Ok(_) => state.live += 1,
                // Fail the job unless an existing driver can pick it up.
                Err(err) if state.live == 0 => {
                    let job = state.queue.pop_back().expect("just pushed");
                    drop(state);
                    let message = format!("failed to spawn a thread: {err}");
                    (job.done)(Err(Failure::new("ERR_WORKER_SPAWN", message)));
                    return;
                }
                Err(_) => {}
            }
        }
        self.available.notify_one();
    }

    fn next_job(&self) -> Option<Job> {
        let mut state = lock(&self.state);
        loop {
            if let Some(job) = state.queue.pop_front() {
                return Some(job);
            }
            state.idle += 1;
            let (guard, wait) = self
                .available
                .wait_timeout(state, self.config.idle_timeout)
                .unwrap_or_else(|err| err.into_inner());
            state = guard;
            state.idle -= 1;
            if wait.timed_out() && state.queue.is_empty() {
                state.live -= 1;
                return None;
            }
        }
    }

    /// The driver thread. On Linux, the worker exits when the thread that spawned it exits (see
    /// `crates/worker`), so this thread outlives its worker.
    fn drive(&self) {
        let mut worker: Option<Worker> = None;
        while let Some(job) = self.next_job() {
            let w = match &mut worker {
                Some(w) => w,
                None => match Worker::spawn(&self.config) {
                    Ok(w) => worker.insert(w),
                    Err(failure) => {
                        (job.done)(Err(failure));
                        continue;
                    }
                },
            };
            let result = w.run(&job);
            if result.is_err() || w.process.killed() {
                worker = None;
            }
            (job.done)(result);
        }
    }
}

struct Process {
    child: Mutex<Child>,
    killed: AtomicBool,
}

impl Process {
    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        // Fails if the process already exited. std doesn't signal a process that it has reaped,
        // so this can't hit a reused pid.
        let _ = lock(&self.child).kill();
    }

    fn killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }

    /// Kills the process if it's still running, and waits for it to exit.
    fn wait(&self) -> io::Result<ExitStatus> {
        let mut child = lock(&self.child);
        let _ = child.kill();
        child.wait()
    }
}

struct Worker {
    process: Arc<Process>,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

enum ExchangeError {
    Io,
    InvalidResponse(String),
}

impl From<io::Error> for ExchangeError {
    fn from(_: io::Error) -> Self {
        ExchangeError::Io
    }
}

impl Worker {
    fn spawn(config: &Config) -> Result<Self, Failure> {
        let path = &config.worker_path;
        let mut command = Command::new(path);
        command
            .arg(env!("CARGO_PKG_VERSION"))
            .arg(std::process::id().to_string())
            .arg(config.memory_limit.to_string())
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // rav1d logs errors to stderr. Debug builds show them (and anything else).
            .stderr(if cfg!(debug_assertions) {
                Stdio::inherit()
            } else {
                Stdio::null()
            });
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|err| {
            let message = format!("failed to spawn {}: {err}", path.display());
            Failure::new("ERR_WORKER_SPAWN", message)
        })?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        Ok(Worker {
            process: Arc::new(Process {
                child: Mutex::new(child),
                killed: AtomicBool::new(false),
            }),
            stdin,
            stdout,
        })
    }

    fn run(&mut self, job: &Job) -> Result<Vec<u8>, Failure> {
        let alarm = job
            .timeout
            .map(|timeout| WATCHDOG.arm(Instant::now() + timeout, self.process.clone()));
        let result = self.exchange(&job.frame, job.max_response_bytes);
        if let Some(alarm) = alarm {
            WATCHDOG.disarm(alarm);
        }
        // If the response arrived just before the deadline, use it anyway. The driver replaces the
        // killed worker.
        let err = match result {
            Ok(response) => return Ok(response),
            Err(err) => err,
        };
        let status = self.process.wait();
        if self.process.killed() {
            let timeout = job.timeout.unwrap_or_default();
            let message = format!("processing took longer than {timeout:?}");
            return Err(Failure::new("ERR_TIMEOUT", message));
        }
        Err(match (err, status) {
            (ExchangeError::InvalidResponse(message), _) => Failure::new(
                "ERR_WORKER_CRASHED",
                format!("the worker sent an invalid response: {message}"),
            ),
            (ExchangeError::Io, Ok(status)) => match status.code() {
                Some(EXIT_OUT_OF_MEMORY) => Failure::new("ERR_OUT_OF_MEMORY", "out of memory"),
                Some(EXIT_MEMORY_LIMIT) => Failure::new(
                    "ERR_LIMIT_EXCEEDED",
                    "Limit exceeded: processing allocated more than limitAllocatorMemory",
                ),
                Some(EXIT_VERSION_MISMATCH) => Failure::new(
                    "ERR_WORKER_SPAWN",
                    "the worker binary doesn't match the native binding's version",
                ),
                Some(EXIT_SANDBOX_FAILED) => Failure::new(
                    "ERR_WORKER_SPAWN",
                    "the worker failed to set up its sandbox",
                ),
                _ => Failure::new(
                    "ERR_WORKER_CRASHED",
                    format!("the worker crashed ({status})"),
                ),
            },
            (ExchangeError::Io, Err(err)) => {
                Failure::new("ERR_WORKER_CRASHED", format!("the worker crashed ({err})"))
            }
        })
    }

    fn exchange(
        &mut self,
        frame: &[u8],
        max_response_bytes: u64,
    ) -> Result<Vec<u8>, ExchangeError> {
        self.stdin.write_all(frame)?;
        self.stdin.flush()?;
        let mut len = [0; 8];
        self.stdout.read_exact(&mut len)?;
        let len = u64::from_le_bytes(len);
        if len > max_response_bytes {
            return Err(ExchangeError::InvalidResponse(format!(
                "{len} bytes exceeds the limit of {max_response_bytes} bytes"
            )));
        }
        let mut response = Vec::new();
        response
            .try_reserve_exact(len as usize)
            .map_err(|err| ExchangeError::InvalidResponse(err.to_string()))?;
        (&mut self.stdout).take(len).read_to_end(&mut response)?;
        if response.len() as u64 != len {
            return Err(ExchangeError::Io);
        }
        Ok(response)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.process.wait();
    }
}

/// Shared by all pools, so that each pool doesn't need its own (never-ending) thread.
static WATCHDOG: Watchdog = Watchdog {
    alarms: Mutex::new(Alarms {
        next_id: 0,
        pending: Vec::new(),
    }),
    changed: Condvar::new(),
    started: Mutex::new(false),
};

struct Watchdog {
    alarms: Mutex<Alarms>,
    changed: Condvar,
    started: Mutex<bool>,
}

struct Alarms {
    next_id: u64,
    pending: Vec<Alarm>,
}

struct Alarm {
    id: u64,
    deadline: Instant,
    process: Arc<Process>,
}

impl Watchdog {
    /// Starts the thread, unless it's already running.
    fn start(&'static self) -> io::Result<()> {
        let mut started = lock(&self.started);
        if !*started {
            thread::Builder::new()
                .name("blunt-watchdog".into())
                .spawn(|| self.run())?;
            *started = true;
        }
        Ok(())
    }

    fn arm(&self, deadline: Instant, process: Arc<Process>) -> u64 {
        let mut alarms = lock(&self.alarms);
        let id = alarms.next_id;
        alarms.next_id += 1;
        alarms.pending.push(Alarm {
            id,
            deadline,
            process,
        });
        self.changed.notify_one();
        id
    }

    fn disarm(&self, id: u64) {
        lock(&self.alarms).pending.retain(|alarm| alarm.id != id);
    }

    fn run(&self) {
        let mut alarms = lock(&self.alarms);
        loop {
            let now = Instant::now();
            let (expired, pending) = alarms
                .pending
                .drain(..)
                .partition::<Vec<_>, _>(|alarm| alarm.deadline <= now);
            alarms.pending = pending;
            if !expired.is_empty() {
                drop(alarms);
                for alarm in expired {
                    alarm.process.kill();
                }
                alarms = lock(&self.alarms);
                continue;
            }
            alarms = match alarms.pending.iter().map(|alarm| alarm.deadline).min() {
                None => self
                    .changed
                    .wait(alarms)
                    .unwrap_or_else(|err| err.into_inner()),
                Some(deadline) => {
                    self.changed
                        .wait_timeout(alarms, deadline - now)
                        .unwrap_or_else(|err| err.into_inner())
                        .0
                }
            };
        }
    }
}
