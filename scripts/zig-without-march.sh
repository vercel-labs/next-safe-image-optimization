#!/bin/sh
# `zig` for cargo-zigbuild on riscv64 (`CARGO_ZIGBUILD_ZIG_PATH`, set by `build-native.mjs`).
#
# libwebp-sys always passes `-march=<arch>`, and cargo-zigbuild replaces any `-march` on riscv64 with
# `-march=generic_rv64` (no extensions). That overrides the `-mcpu=generic_rv64+m+a+f+d+c` that
# cargo-zigbuild passes before it, so clang picks the soft-float ABI, whose glibc headers
# (`gnu/stubs-lp64.h`) zig doesn't include. This drops `-march`, leaving cargo-zigbuild's `-mcpu`.
for arg do
  shift
  case $arg in
    -march=*) ;;
    *) set -- "$@" "$arg" ;;
  esac
done
exec zig "$@"
