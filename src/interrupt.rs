//! Cooperative cancellation (via `AbortSignal`) and timeouts.
//!
//! Most decoders don't support cancellation, so we check at a few points:
//! - Between pipeline stages.
//! - While reading the input (see [`InterruptibleReader`]), which covers decoders that stream their
//!   input (JPEG, PNG, TIFF, lossless WebP). Lossy WebP buffers its input up-front. Checks are
//!   amortized over input bytes, so highly compressible images are checked less often. After an
//!   error, zune-jpeg (in non-strict mode) still converts what it decoded so far, which is one
//!   pass over the image.
//! - Between batches of rows while decoding GIF frames.
//! - In libwebp's progress hook while encoding WebP, and between row batches while encoding PNG.

use std::io::{self, BufRead, Cursor, Read, Seek, SeekFrom};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::error::{Error, Result};

#[derive(Clone, Default)]
pub struct Interrupt {
    cancelled: Option<Arc<AtomicBool>>,
    deadline: Option<Instant>,
}

impl Interrupt {
    /// The timeout starts counting when this is called, so this should be constructed when work
    /// begins, not when it's queued.
    pub fn new(cancelled: Option<Arc<AtomicBool>>, timeout: Option<Duration>) -> Self {
        Self {
            cancelled,
            deadline: timeout.and_then(|t| Instant::now().checked_add(t)),
        }
    }

    pub fn check(&self) -> Result<()> {
        if let Some(cancelled) = &self.cancelled
            && cancelled.load(Ordering::Relaxed)
        {
            return Err(Error::Aborted);
        }
        if let Some(deadline) = self.deadline
            && Instant::now() >= deadline
        {
            return Err(Error::Timeout);
        }
        Ok(())
    }

    /// Decoders and encoders swallow the cause of I/O errors, so if one fails, use this to check if
    /// it was because we interrupted it.
    pub fn check_after_error(&self, err: Error) -> Error {
        self.check().err().unwrap_or(err)
    }
}

/// An in-memory reader that fails with an I/O error once the [`Interrupt`] triggers.
///
/// zune-jpeg reads its input one byte at a time through this (via zune-core's blanket
/// `ZByteReaderTrait` impl for `BufRead + Seek`), so checks are amortized over the amount of work.
pub struct InterruptibleReader<'a> {
    inner: Cursor<&'a [u8]>,
    interrupt: &'a Interrupt,
    work: usize,
}

/// Roughly how many bytes to read between checks. Compressed data expands a lot, so keep this small.
const CHECK_INTERVAL: usize = 16 * 1024;

impl<'a> InterruptibleReader<'a> {
    pub fn new(data: &'a [u8], interrupt: &'a Interrupt) -> Self {
        Self {
            inner: Cursor::new(data),
            interrupt,
            work: 0,
        }
    }

    #[inline]
    fn check(&mut self, bytes: usize) -> io::Result<()> {
        // Count each call too, since some callers make many tiny reads.
        self.work += bytes + 1;
        if self.work >= CHECK_INTERVAL {
            // Once interrupted, `work` stays over the interval, so every later call fails too.
            // zune-jpeg ignores errors from most single-byte reads.
            self.interrupt.check().map_err(io::Error::other)?;
            self.work = 0;
        }
        Ok(())
    }
}

impl Read for InterruptibleReader<'_> {
    #[inline]
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.check(buf.len())?;
        self.inner.read(buf)
    }
}

impl BufRead for InterruptibleReader<'_> {
    #[inline]
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        self.check(0)?;
        self.inner.fill_buf()
    }

    #[inline]
    fn consume(&mut self, amount: usize) {
        // `fill_buf` returns all remaining input, so count what's actually consumed. The next read
        // performs the check.
        self.work += amount;
        self.inner.consume(amount)
    }
}

impl Seek for InterruptibleReader<'_> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.check(0)?;
        self.inner.seek(pos)
    }
}
