use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::protocol::{EXIT_MEMORY_LIMIT, EXIT_OUT_OF_MEMORY};

/// The system allocator, but it tracks how much memory is allocated, and exits when that exceeds
/// [`set_memory_limit`] (with [`EXIT_MEMORY_LIMIT`]) or when an allocation fails (with
/// [`EXIT_OUT_OF_MEMORY`]), so that the parent can tell these apart from other crashes. The default
/// would abort, which looks like any other panic.
///
/// This only sees Rust allocations: libwebp and mozjpeg (C) allocate with `malloc` directly. The OS-level
/// limit (`RLIMIT_DATA`, set by the worker) covers that.
///
/// Fallible allocations (`try_reserve`) also exit. That's fine: the request fails either way, and
/// the worker doesn't own anything that needs cleaning up.
pub struct ExitOnOom;

static ALLOCATED: AtomicUsize = AtomicUsize::new(0);
static LIMIT: AtomicUsize = AtomicUsize::new(usize::MAX);

/// Limits the total size of live allocations, including ones made before this call.
pub fn set_memory_limit(bytes: usize) {
    LIMIT.store(bytes, Ordering::Relaxed);
}

/// Exits without running `atexit` handlers or flushing stdio, which could allocate or deadlock
/// (another thread may be holding a lock). On wasm, this calls WASI's `proc_exit`.
pub fn exit_immediately(code: i32) -> ! {
    unsafe { libc::_exit(code) }
}

fn grow(bytes: usize) {
    let allocated = ALLOCATED
        .fetch_add(bytes, Ordering::Relaxed)
        .saturating_add(bytes);
    if allocated > LIMIT.load(Ordering::Relaxed) {
        exit_immediately(EXIT_MEMORY_LIMIT);
    }
}

fn shrink(bytes: usize) {
    ALLOCATED.fetch_sub(bytes, Ordering::Relaxed);
}

fn check(ptr: *mut u8) -> *mut u8 {
    if ptr.is_null() {
        exit_immediately(EXIT_OUT_OF_MEMORY);
    }
    ptr
}

unsafe impl GlobalAlloc for ExitOnOom {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        grow(layout.size());
        check(unsafe { System.alloc(layout) })
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        grow(layout.size());
        check(unsafe { System.alloc_zeroed(layout) })
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        shrink(layout.size());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if new_size > layout.size() {
            grow(new_size - layout.size());
        }
        let ptr = check(unsafe { System.realloc(ptr, layout, new_size) });
        if new_size < layout.size() {
            shrink(layout.size() - new_size);
        }
        ptr
    }
}
