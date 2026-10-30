// The targets that CI builds the worker for (the `build` job in
// .github/workflows/build_and_test.yml), and their platform names, which `js/native.ts` uses in file
// and package names.

/** Like `x86_64-unknown-linux-gnu` → `linux-x64-gnu`. Returns `undefined` for unknown targets. */
export function platform(triple) {
  const [arch, , os, abi] = triple.split('-')
  const nodeArch = { x86_64: 'x64', aarch64: 'arm64', riscv64gc: 'riscv64' }[arch]
  const nodeOs = { darwin: 'darwin', windows: 'win32', linux: 'linux' }[os]
  if (nodeArch === undefined || nodeOs === undefined) {
    return undefined
  }
  return abi === undefined ? `${nodeOs}-${nodeArch}` : `${nodeOs}-${nodeArch}-${abi}`
}

export const TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
  'riscv64gc-unknown-linux-gnu',
]
