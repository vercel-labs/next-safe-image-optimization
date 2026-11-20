# Benchmark

Throughput of `@next/safe-image-optimization` against [sharp](https://sharp.pixelplumbing.com/), [`@napi-rs/image`](https://github.com/Brooooooklyn/Image), and [`Bun.Image`](https://bun.com/docs/runtime/image), on the pipeline Next.js's image optimizer runs, with its settings: auto-orient with EXIF, resize to a width, encode at Next.js's default quality.

The method comes from [`@napi-rs/image`'s benchmark](https://github.com/Brooooooklyn/Image/blob/main/bench/bench.mjs), which compares itself to sharp on the same pipeline: submit one image repeatedly, with a fixed number in flight at once, and report completed images per second. Two things differ:

- Every image that starts is waited for and counted, and the rate is measured against the average time a slot spent working, rather than against the wall time of the whole run. Otherwise the tail where slots finish their last image, and the machine is only partly busy, counts against the result.
- The input images are generated with sharp at startup, instead of being read from the repository, because this repository doesn't commit images (the tests generate their fixtures the same way). They're fractal (1/f) value noise, which has roughly the frequency content of a photograph, and a fixed seed, so every machine benchmarks the same bytes.

## Running it

```sh
pnpm bench:release        # from the repository root, or from this directory
pnpm bench:bun:release    # the same, under Bun, which adds the Bun.Image entry
```

That builds the release worker and the JS package first, then runs every input and output format, which takes a few minutes. `pnpm bench` and `pnpm bench:bun` use the debug worker, which is much slower and not worth measuring.

Options, from this directory (from the root, turbo needs them after a separator: `pnpm bench:release -- --formats webp`):

```sh
pnpm bench:release --help
pnpm bench:release --inputs small --formats webp          # one suite
pnpm bench:release --libraries sharp,safe-image           # two of the entries
pnpm bench:release --concurrency 8 --duration 30          # longer, with more in flight
pnpm bench:release --json > results.json
```

### Running under Bun

`Bun.Image` ships with [Bun](https://bun.com) (1.4 and later) rather than as a package, so the only way to measure it is to run the benchmark itself under Bun, which `pnpm bench:bun:release` does. Bun runs the same files unchanged — including the worker pool, which talks to its workers over the same IPC channel Node.js uses — and `libraries.ts` adds the `Bun.Image` entry only when `Bun.Image` exists, so a Node.js run measures exactly what it measured before.

**Only compare rows within one run.** Every entry is measured under whichever runtime started the benchmark, and the two runtimes don't give the same library the same number: they run different JavaScript engines, and they schedule native work on different thread pools. The results below have a table per runtime for that reason.

### Threads

sharp and `@napi-rs/image` run each image on libuv's thread pool, which has 4 threads by default, so under Node.js on a machine with more cores than that, raise `UV_THREADPOOL_SIZE` before deciding anything. It does nothing for `@next/safe-image-optimization`, which uses worker processes, and nothing at all under Bun, which doesn't use libuv: `UV_THREADPOOL_SIZE=1` cuts `@napi-rs/image` to about a quarter of its throughput under Node.js and leaves it unchanged under Bun.

## What it measures

| Entry                                                    | Notes                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharp`                                                  | Exactly what Next.js runs: `sharp(input).timeout(...).rotate().resize(width, undefined, { withoutEnlargement: true })`, then the encoder below |
| `@napi-rs/image`                                         | `new Transformer(input).rotate().resize(width)`, then the encoder below                                                                        |
| `Bun.Image`                                              | `new Bun.Image(input).resize(width)`, then the encoder below, under Bun only                                                                   |
| `@next/safe-image-optimization`                          | Default pool: one image per worker process, then the worker is replaced                                                                        |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` | The same, with workers reused for 64 images — the throughput cost of replacing them is the gap between these two rows                          |

`Bun.Image` has no call for auto-orienting, because `autoOrient` is its constructor's default and applies the EXIF orientation before everything else, and its `resize(width)` keeps the aspect ratio like sharp's. On the small input its output has the same dimensions as sharp's and its pixels are within about 2/255 per channel; on the large one it rounds the height down to 426 where sharp rounds it up to 427.

Inputs are a 600x450 JPEG with EXIF orientation 5 resized to 225px (the size and pipeline `@napi-rs/image`'s benchmark uses), and a 3000x2000 JPEG resized to 640px (closer to a photo someone would upload).

Encoder settings follow Next.js's image optimizer (`packages/next/src/server/image-optimizer/sharp.ts`) at its default quality (`images.qualities: [75]`). sharp gets exactly Next.js's options, including halving libvips's thread pool (`sharp.concurrency()`) like Next.js does in production. The other libraries get the closest settings each one has:

| Format | sharp (Next.js)                  | `@napi-rs/image`               | `@next/safe-image-optimization` | `Bun.Image`                |
| ------ | -------------------------------- | ------------------------------ | ------------------------------- | -------------------------- |
| WebP   | `quality: 75`                    | `75`                           | `quality: 75`                   | `quality: 75`              |
| JPEG   | `quality: 75, mozjpeg: true`     | `75` (always mozjpeg)          | `quality: 75, mozjpeg: true`    | `quality: 75` (no mozjpeg) |
| AVIF   | `quality: 47, effort: 3` (4:4:4) | `quality: 47, speed: 6`, 4:4:4 | `quality: 63, effort: 3`        | `quality: 47`              |

Next.js scales AVIF's quality by 50/80 (75 → 47). AVIF quality scales differ between encoders, so the other AVIF settings were chosen to match sharp's output by [SSIMULACRA2](https://github.com/cloudinary/ssimulacra2), on the 24 [Kodak](http://r0k.us/graphics/kodak/) photos (the median of each photo's matching quality). `@napi-rs/image` is libavif with libaom, like sharp, and matched at libaom's speed 6 (the preset sharp's `effort: 3` uses) and quality 48. This library's ravif matched at 63, in files about 23% larger. `Bun.Image`'s AVIF encoder is the operating system's, whose scale is unknown, so it gets sharp's number.

`Bun.Image` can be missing from the AVIF suites: it encodes JPEG, PNG, and WebP with codecs linked into every build, but goes to the operating system for AVIF, which Linux has no encoder for and macOS only has on Apple Silicon M3+; `libraries.ts` finds out by encoding an 8x8 image at startup, so the row appears on a machine that can.

## What the numbers don't say

The settings are as close to Next.js's as each library allows, but the libraries still aren't equivalent:

- **Different encoders.** JPEG is mozjpeg for sharp, `@napi-rs/image`, and this library (which builds it without assembly), and libjpeg-turbo for `Bun.Image`. `@napi-rs/image`'s mozjpeg settings differ from sharp's: its output is about twice the size. AVIF is libaom for sharp (through libheif) and `@napi-rs/image` (through libavif), and rav1e, through ravif, for this library, without assembly. The AVIF settings were matched on photos, not on these noise inputs, so the output sizes in the AVIF tables still differ.
- **Different amounts of work.** libvips decodes a JPEG at a reduced DCT scale when the result is going to be shrunk (shrink-on-load), and `Bun.Image` does the same whenever the target is at most half the source, so both of them decode far fewer pixels than the other two on the large input. That's a real advantage, not a measurement artifact, but it's an advantage at one specific step.
- **Different metadata.** `Bun.Image` copies the input's ICC profile into its output; sharp, `@napi-rs/image`, and this library all drop it. That's about 0.5 kB of every output size `Bun.Image` reports, so the `output` column isn't quite comparable either.
- **Different ways of using the cores.** libvips splits a single image across its own threads (half the cores, as Next.js sets it), and `@napi-rs/image`'s AVIF encoder uses every core, so several images in flight oversubscribe the CPU. `@next/safe-image-optimization` processes each image in one single-threaded worker, so its throughput comes entirely from running several at once. Run `--concurrency 1` as well as the default to see both ends of that; the results below include it.
- **Different isolation.** This library pays for a worker process per image (and for copying the image in and out of it) in exchange for keeping a decoder bug out of the Node.js process. sharp, `@napi-rs/image`, and `Bun.Image` all decode in the same process, so an input that reaches a bug in one of them reaches the whole application. The two `@next/safe-image-optimization` rows bracket what avoiding that costs.
- **One machine, one image.** Throughput depends on the input's content and size, the output size, core count, and how much concurrency the caller actually has. Measure your own workload before choosing.

## Results

One Node.js run, on a 12 vCPU Linux (arm64) VM on Apple Silicon, with the default 4 images in flight, `UV_THREADPOOL_SIZE` unset, Node.js v24.17.0, sharp 0.35.5 (libvips 8.18.7, libaom 3.15.1), `@napi-rs/image` 1.16.0, and a local release build of the worker. It's a shared VM, so treat the ratios as approximate, and rerun on your own hardware.

Completed images per second, with 4 in flight at once:

**600x450 JPEG, EXIF orientation 5 → 225px** (the input and pipeline `@napi-rs/image`'s benchmark uses)

| Library                                                  | WebP | JPEG | AVIF |
| -------------------------------------------------------- | ---: | ---: | ---: |
| sharp                                                    |  306 |  314 |  207 |
| `@napi-rs/image`                                         |  419 |  402 |  107 |
| `@next/safe-image-optimization`                          |  512 |  360 | 32.9 |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` |  606 |  453 | 33.7 |

**3000x2000 JPEG → 640px**

| Library                                                  | WebP | JPEG | AVIF |
| -------------------------------------------------------- | ---: | ---: | ---: |
| sharp                                                    | 96.5 |  103 | 80.3 |
| `@napi-rs/image`                                         | 20.9 | 28.4 | 24.4 |
| `@next/safe-image-optimization`                          | 83.6 | 77.2 | 10.1 |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` | 92.3 | 84.3 |  9.9 |

And with only one image at a time, as latency per image in milliseconds (a shorter run):

| Library                                                  | small WebP | small JPEG | small AVIF | large WebP | large JPEG | large AVIF |
| -------------------------------------------------------- | ---------: | ---------: | ---------: | ---------: | ---------: | ---------: |
| sharp                                                    |       11.8 |       11.7 |       14.8 |       40.6 |       37.7 |       39.2 |
| `@napi-rs/image`                                         |       10.6 |        7.3 |       35.6 |      100.1 |       79.5 |      130.0 |
| `@next/safe-image-optimization`                          |        7.8 |        9.8 |      118.6 |       44.9 |       48.0 |      410.9 |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` |        7.0 |        8.8 |      116.1 |       41.9 |       46.1 |      403.8 |

Output sizes (small, large): WebP was 4.2-4.3 and 11.5-11.6 kB for every library. JPEG was 6.3 and 18.5 kB for sharp and this library, and 12.2 and 39.1 kB for `@napi-rs/image`. AVIF was 3.9 and 11.2 kB for sharp, 2.8 and 7.4 kB for `@napi-rs/image`, and 3.8 and 10.0 kB for this library.

What stands out:

- **AVIF is where this library is slowest: 6-10x slower than sharp**, and 2.4-3.3x slower than `@napi-rs/image`. At Next.js's `effort: 3`, libaom uses a fast preset (speed 6), and rav1e, without assembly, has nothing comparable at the same quality: it's about as fast as libaom's next slower preset (speed 5, sharp's default `effort: 4`), which takes about 8x as long.
- **For WebP and JPEG, the isolation is close to free.** On the small input, this library is faster than sharp for both, and replacing a worker after every image costs 8-20% of throughput (the gap between its two rows). On the large input, sharp is 1.15-1.33x faster, mostly from decoding the JPEG at a reduced DCT scale (shrink-on-load), which neither Rust library does. See [future work](../../docs/future-work.md).
- **Quality numbers are not comparable across encoders**, so the AVIF settings are matched by measurement, not by number (see above), and `@napi-rs/image`'s mozjpeg produces JPEGs about twice the size of the other two at the same `quality`. Encoding speed and file size trade against each other, so the slower encoder in a row may simply be doing more.

### Bun (previous configuration)

This run predates the change to Next.js's settings, and this library's AVIF encoder. It used `quality: 75` for WebP and JPEG without mozjpeg (except `@napi-rs/image`, which always uses it), AVIF at `quality: 70` with 4:2:0 and each library's default effort, and libvips's default thread pool. It's the only run with a `Bun.Image` row. It ran on a 4 vCPU Intel Xeon @ 2.90GHz (Amazon Linux 2023, x64), with Bun 1.4.4, sharp 0.35.5, `@napi-rs/image` 1.16.0, and `@next/safe-image-optimization` 0.0.2 (the prebuilt release worker from npm), so don't compare it to the table above.

Completed images per second, with 4 in flight at once, as the median of three runs. They agreed within about 7%, apart from sharp's small JPEG (17%) and large AVIF (26%) cells, which is this VM rather than anything about sharp.

**600x450 JPEG, EXIF orientation 5 → 225px**

| Library                                                  | WebP q75 | JPEG q75 | AVIF q70 |
| -------------------------------------------------------- | -------: | -------: | -------: |
| sharp                                                    |      165 |      245 |     14.6 |
| `@napi-rs/image`                                         |      256 |      357 |     25.6 |
| `Bun.Image`                                              |      561 |     3007 |        — |
| `@next/safe-image-optimization`                          |      202 |      294 |        — |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` |      251 |      364 |        — |

**3000x2000 JPEG → 640px**

| Library                                                  | WebP q75 | JPEG q75 | AVIF q70 |
| -------------------------------------------------------- | -------: | -------: | -------: |
| sharp                                                    |     56.6 |     84.6 |      4.6 |
| `@napi-rs/image`                                         |     25.8 |     29.0 |      8.1 |
| `Bun.Image`                                              |      107 |      244 |        — |
| `@next/safe-image-optimization`                          |     24.1 |     26.9 |        — |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` |     26.7 |     29.5 |        — |

And with only one image at a time, as latency per image in milliseconds (one run):

| Library                                                  | small WebP | small JPEG | large WebP | large JPEG |
| -------------------------------------------------------- | ---------: | ---------: | ---------: | ---------: |
| sharp                                                    |       19.6 |       13.0 |       75.2 |       46.7 |
| `@napi-rs/image`                                         |       18.0 |       13.9 |      172.3 |      156.4 |
| `Bun.Image`                                              |        7.7 |        1.4 |       41.1 |       18.2 |
| `@next/safe-image-optimization`                          |       19.4 |       12.8 |      169.5 |      151.8 |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` |       16.1 |       10.5 |      151.7 |      132.3 |

`Bun.Image` was the fastest entry in every suite it could run: 1.9x to 3.4x sharp on three of the four WebP and JPEG pipelines, and 12x on the small JPEG one, where a fixed per-image cost is most of what the others are paying. It decodes a JPEG at a reduced DCT scale like libvips, encodes with the same libjpeg-turbo and libwebp as sharp, and does very little around them. It also decodes in the application's own process, which is what `@next/safe-image-optimization` gives up throughput to avoid.
