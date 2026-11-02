// Detects whether Node is running on musl (like Alpine). Copied from napi-rs's generated binding
// loader, with types added:
// https://github.com/napi-rs/napi-rs/blob/d782ef16fb88e26e5cd48502daa19b7202eb2f98/cli/src/api/templates/js-binding.ts#L259-L310
//
// MIT License
//
// Copyright (c) 2020-present LongYinan
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

interface Report {
  header?: { glibcVersionRuntime?: string }
  sharedObjects?: string[]
}

export const isMusl = (): boolean => {
  let musl: boolean | null = false
  if (process.platform === 'linux') {
    musl = isMuslFromFilesystem()
    if (musl === null) {
      musl = isMuslFromReport()
    }
    if (musl === null) {
      musl = isMuslFromChildProcess()
    }
  }
  return musl
}

const isFileMusl = (f: string) => f.includes('libc.musl-') || f.includes('ld-musl-')

const isMuslFromFilesystem = (): boolean | null => {
  try {
    return readFileSync('/usr/bin/ldd', 'utf-8').includes('musl')
  } catch {
    return null
  }
}

const isMuslFromReport = (): boolean | null => {
  let report: Report | null = null
  if (process.report && typeof process.report.getReport === 'function') {
    // Not in @types/node.
    ;(process.report as { excludeNetwork?: boolean }).excludeNetwork = true
    report = process.report.getReport() as Report
  }
  if (!report) {
    return null
  }
  if (report.header && report.header.glibcVersionRuntime) {
    return false
  }
  if (Array.isArray(report.sharedObjects)) {
    if (report.sharedObjects.some(isFileMusl)) {
      return true
    }
  }
  return false
}

const isMuslFromChildProcess = (): boolean => {
  try {
    return execSync('ldd --version', { encoding: 'utf8' }).includes('musl')
  } catch {
    // If we reach this case, we don't know if the system is musl or not, so is better to just fallback to false
    return false
  }
}
