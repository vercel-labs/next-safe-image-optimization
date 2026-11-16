//! The wasm module (`wasm32-wasip1`), driven by `packages/nsio/wasm-worker.ts`. It imports its
//! memory, so that JS can choose its maximum size, and the only other imports are a few WASI
//! functions that JS stubs out, and `nsio.decoded`.
//!
//! To process a request, JS calls `nsio_alloc(len)`, writes the request (see
//! `nsio_core::protocol`) to the returned pointer, and calls `nsio_handle(ptr, len)`. For
//! transforms, that calls `nsio.decoded()` once the input is decoded. It returns a pointer to four
//! `u32`s, `[head pointer, head length, data pointer, data length]`. After copying the response
//! out, JS calls `nsio_free_response()`.
//!
//! A panic traps, and running out of memory calls `proc_exit` with `EXIT_OUT_OF_MEMORY`. Either way,
//! JS discards the instance.

use std::mem::ManuallyDrop;
use std::sync::Mutex;

use nsio_core::protocol::{self, Frame};

#[global_allocator]
static GLOBAL: nsio_core::ExitOnOom = nsio_core::ExitOnOom;

struct Current {
    /// Owns the buffers that `parts` points to.
    _response: Frame,
    parts: [u32; 4],
}

static CURRENT: Mutex<Option<Box<Current>>> = Mutex::new(None);

/// Tells JS that the input is decoded, so that the pool can stop the decode timeout.
fn decoded() {
    #[cfg(target_family = "wasm")]
    {
        #[link(wasm_import_module = "nsio")]
        unsafe extern "C" {
            safe fn decoded();
        }
        decoded();
    }
    // `turbo run build` also builds this crate for the host, where there's nothing to import.
}

#[unsafe(no_mangle)]
pub extern "C" fn nsio_alloc(len: usize) -> *mut u8 {
    ManuallyDrop::new(Vec::<u8>::with_capacity(len)).as_mut_ptr()
}

/// # Safety
///
/// `ptr` must come from `nsio_alloc(len)`, and the request must be fully written.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nsio_handle(ptr: *mut u8, len: usize) -> *const u32 {
    // SAFETY: `nsio_alloc` allocated a `Vec` with capacity `len`, and JS initialized it.
    let request = unsafe { Vec::from_raw_parts(ptr, len, len) };
    let response = protocol::handle(request, decoded);
    let parts = [
        response.head.as_ptr() as u32,
        response.head.len() as u32,
        response.data.as_ptr() as u32,
        response.data.len() as u32,
    ];
    let current = Box::new(Current {
        _response: response,
        parts,
    });
    let ptr = current.parts.as_ptr();
    *CURRENT.lock().unwrap() = Some(current);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn nsio_free_response() {
    CURRENT.lock().unwrap().take();
}
