# Platform support

`@next/safe-image-optimization` requires **Node.js 20.9.0 or newer**.

Because the library communicates with standalone worker binaries (or WebAssembly worker threads) instead of loading a native Node-API addon, it does not link against Node.js or depend on a specific Node.js ABI version.

## Supported platforms

Native worker binaries are built for the following operating systems and CPU architectures:

| Operating System    | CPU Architectures                      | Notes                                                             |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Linux (glibc 2.28+) | `x64`, `arm64`, `riscv64`              | Uses `gnu` worker binaries, falling back to `musl` if unavailable |
| Linux (musl)        | `x64`, `arm64`                         | Statically linked                                                 |
| macOS (10.13+)      | `arm64` (Apple Silicon), `x64` (Intel) |                                                                   |
| Windows             | `x64`, `arm64`                         | MSVC builds                                                       |

On any other platform or architecture where Node.js runs, the pool automatically falls back to the [WebAssembly backend](wasm.md) if `@next/safe-image-optimization-wasm32` is installed (unless `NEXT_SAFE_IMAGE_OPTIMIZATION_BACKEND=native` is set). On FreeBSD and in WebContainers, it's installed automatically. Elsewhere, install it explicitly.

## OS-specific safety features

Per-image limits (`limitInputPixels`, `limitAllocatorMemoryBytes`, `limitOutputBytes`, and `timeoutMs`) and worker process isolation work on every platform. Some additional OS-level features vary by platform:

| Platform                          | System call sandbox (`seccomp`) | Hard worker memory limit (`limitProcessMemoryBytes`) | Fast worker startup (`forkServer`) |
| --------------------------------- | ------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| Linux (`x64`, `arm64`, `riscv64`) | Yes                             | Yes (`RLIMIT_DATA`)                                  | Yes                                |
| macOS (`arm64`, `x64`)            | No                              | No                                                   | Yes                                |
| Windows (`x64`, `arm64`)          | No                              | No                                                   | No (spawns each worker)            |
| WebAssembly (all OSes)            | WebAssembly sandbox             | Yes (WebAssembly memory maximum)                     | N/A (worker threads)               |

See [Safety model](safety.md) for details on how these features work.

## Comparison with sharp

Both `@next/safe-image-optimization` and sharp require Node.js `>= 20.9.0` and provide prebuilt native binaries for Linux (`x64` and `arm64` on glibc and musl, plus `riscv64` on glibc), macOS (`arm64` and `x64`), Windows (`x64` and `arm64`), and WebAssembly (`wasm32`).

The main differences in platform support are:

- **Additional native architectures in sharp:** sharp also publishes prebuilt native binaries for 32-bit ARM Linux (`linux-arm`), 64-bit PowerPC Linux (`linux-ppc64`), IBM Z Linux (`linux-s390x`), and 32-bit x86 Windows (`win32-ia32`). On those platforms, `@next/safe-image-optimization` uses the WebAssembly backend instead (with `@next/safe-image-optimization-wasm32` installed).
- **WebAssembly fallback:** like sharp's `@img/sharp-wasm32`, the WebAssembly build is in a separate package (`@next/safe-image-optimization-wasm32`). Like sharp, the build is only installed by default on FreeBSD and in WebContainers, through `@next/safe-image-optimization-freebsd-wasm` and `@next/safe-image-optimization-webcontainers-wasm`. pnpm 12 doesn't install sharp's `@img/sharp-freebsd-wasm32` on FreeBSD (it infers `cpu: ["wasm32"]` from the name), which is why these aren't named `-wasm32`. Unlike sharp, `@next/safe-image-optimization` falls back to it automatically on any platform where it's installed and no native binary is.
