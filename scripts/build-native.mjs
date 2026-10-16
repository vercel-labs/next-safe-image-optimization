#!/usr/bin/env node
// Builds the native binding (see `napi-build.mjs`).
//
// Usage: node scripts/build-native.mjs [extra napi build args]

import { build, install } from './napi-build.mjs'

install(build(process.argv.slice(2)))
