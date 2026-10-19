use std::alloc::{GlobalAlloc, Layout, System};

use crate::protocol::EXIT_OUT_OF_MEMORY;

/// The system allocator, but exits with [`EXIT_OUT_OF_MEMORY`] when an allocation fails, so that
/// the parent can tell an out-of-memory crash from other crashes. The default would abort, which
/// looks like any other panic.
///
/// Fallible allocations (`try_reserve`) also exit. That's fine: the request fails either way, and
/// the worker doesn't own anything that needs cleaning up.
pub struct ExitOnOom;

/// Exits without running `atexit` handlers or flushing stdio, which could allocate or deadlock
/// (another thread may be holding a lock). On wasm, this calls WASI's `proc_exit`.
pub fn exit_immediately(code: i32) -> ! {
    unsafe { libc::_exit(code) }
}

fn check(ptr: *mut u8) -> *mut u8 {
    if ptr.is_null() {
        exit_immediately(EXIT_OUT_OF_MEMORY);
    }
    ptr
}

unsafe impl GlobalAlloc for ExitOnOom {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        check(unsafe { System.alloc(layout) })
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        check(unsafe { System.alloc_zeroed(layout) })
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        check(unsafe { System.realloc(ptr, layout, new_size) })
    }
}
