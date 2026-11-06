# Benchmark

Throughput of `@next/safe-image-optimization` against [sharp](https://sharp.pixelplumbing.com/), [`@napi-rs/image`](https://github.com/Brooooooklyn/Image), and [`Bun.Image`](https://bun.com/docs/runtime/image), on the pipeline Next.js's image optimizer runs: auto-orient with EXIF, resize to a width, encode.

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

| Entry                                                    | Notes                                                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `sharp`                                                  | `sharp(input).rotate().resize(width).<format>({ quality }).toBuffer()`                                                |
| `@napi-rs/image`                                         | `new Transformer(input).rotate().resize(width).<format>(quality)`                                                     |
| `Bun.Image`                                              | `new Bun.Image(input).resize(width).<format>({ quality }).bytes()`, under Bun only                                    |
| `@next/safe-image-optimization`                          | Default pool: one image per worker process, then the worker is replaced                                               |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` | The same, with workers reused for 64 images — the throughput cost of replacing them is the gap between these two rows |

`Bun.Image` has no call for auto-orienting, because `autoOrient` is its constructor's default and applies the EXIF orientation before everything else, and its `resize(width)` keeps the aspect ratio like sharp's. On the small input its output has the same dimensions as sharp's and its pixels are within about 2/255 per channel; on the large one it rounds the height down to 426 where sharp rounds it up to 427.

Inputs are a 600x450 JPEG with EXIF orientation 5 resized to 225px (the size and pipeline `@napi-rs/image`'s benchmark uses), and a 3000x2000 JPEG resized to 640px (closer to a photo someone would upload). Output formats are WebP (quality 75), JPEG (quality 75), and AVIF (quality 70, 4:2:0).

Two entries can be missing from the AVIF suites. `@next/safe-image-optimization` has no AVIF encoder at all. `Bun.Image` encodes JPEG, PNG, and WebP with codecs linked into every build, but goes to the operating system for AVIF, which Linux has no encoder for and macOS only has on Apple Silicon M3+; `libraries.ts` finds out by encoding an 8x8 image at startup, so the row appears on a machine that can.

## What the numbers don't say

Each library runs with its own defaults, because that's what a caller gets. The defaults are not equivalent:

- **Different encoders.** sharp's and `Bun.Image`'s JPEG encoder is libjpeg-turbo, `@napi-rs/image`'s is mozjpeg, and this library's default is the pure-Rust `jpeg-encoder` (mozjpeg, without assembly, behind `mozjpeg: true`). The AVIF encoders differ too. Equal `quality` numbers are not equal visual quality, and the output sizes in the table differ by much more than the quality setting suggests.
- **Different amounts of work.** libvips decodes a JPEG at a reduced DCT scale when the result is going to be shrunk (shrink-on-load), and `Bun.Image` does the same whenever the target is at most half the source, so both of them decode far fewer pixels than the other two on the large input. That's a real advantage, not a measurement artifact, but it's an advantage at one specific step.
- **Different metadata.** `Bun.Image` copies the input's ICC profile into its output; sharp, `@napi-rs/image`, and this library all drop it. That's about 0.5 kB of every output size `Bun.Image` reports, so the `output` column isn't quite comparable either.
- **Different ways of using the cores.** libvips splits a single image across its own threads (`VIPS_CONCURRENCY`, which defaults to the core count), so several images in flight on a small machine oversubscribe the CPU. `@next/safe-image-optimization` processes each image in one single-threaded worker, so its throughput comes entirely from running several at once. Run `--concurrency 1` as well as the default to see both ends of that; the results below include it.
- **Different isolation.** This library pays for a worker process per image (and for copying the image in and out of it) in exchange for keeping a decoder bug out of the Node.js process. sharp, `@napi-rs/image`, and `Bun.Image` all decode in the same process, so an input that reaches a bug in one of them reaches the whole application. The two `@next/safe-image-optimization` rows bracket what avoiding that costs.
- **One machine, one image.** Throughput depends on the input's content and size, the output size, core count, and how much concurrency the caller actually has. Measure your own workload before choosing.

## Results

One run per runtime, each on a 4 vCPU Intel Xeon @ 2.90GHz (Amazon Linux 2023, x64), with the default 4 images in flight, `UV_THREADPOOL_SIZE` unset, sharp 0.35.5 (libvips 8.18.7), and `@napi-rs/image` 1.16.0.

These are shared cloud VMs, and the two runs are on different ones, so compare rows within a table rather than across the two, treat the ratios as approximate, and rerun on your own hardware.

### Node.js

Node.js v22.23.4, `@next/safe-image-optimization` 0.0.1 (the prebuilt release worker from npm, because the machine that ran this had no Rust toolchain; the only changes to the worker and to the wrapper's image path since `v0.0.1` are comments and where the worker binary is looked up).

Completed images per second, with 4 in flight at once. Repeat runs agreed within about 6%.

**600x450 JPEG, EXIF orientation 5 → 225px** (the input and pipeline `@napi-rs/image`'s benchmark uses)

| Library                                                  | WebP q75 | JPEG q75 | AVIF q70 |
| -------------------------------------------------------- | -------: | -------: | -------: |
| sharp                                                    |      179 |      251 |     14.9 |
| `@napi-rs/image`                                         |      263 |      337 |     25.3 |
| `@next/safe-image-optimization`                          |      210 |      298 |        — |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` |      254 |      382 |        — |

**3000x2000 JPEG → 640px**

| Library                                                  | WebP q75 | JPEG q75 | AVIF q70 |
| -------------------------------------------------------- | -------: | -------: | -------: |
| sharp                                                    |     54.2 |     83.6 |      4.6 |
| `@napi-rs/image`                                         |     25.7 |     28.4 |      8.2 |
| `@next/safe-image-optimization`                          |     23.7 |     26.8 |        — |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` |     26.6 |     30.3 |        — |

And the same pipelines with only one image at a time, as latency per image in milliseconds (a shorter run, so the sample is smaller):

| Library                                                  | small WebP | small JPEG | large WebP | large JPEG |
| -------------------------------------------------------- | ---------: | ---------: | ---------: | ---------: |
| sharp                                                    |       18.0 |       10.7 |       65.0 |       41.5 |
| `@napi-rs/image`                                         |       15.9 |       11.6 |      154.2 |      142.4 |
| `@next/safe-image-optimization`                          |       17.8 |       11.5 |      160.2 |      142.7 |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` |       15.5 |       10.0 |      147.1 |      135.8 |

### Bun

Bun 1.4.4, `@next/safe-image-optimization` 0.0.2 (again the prebuilt release worker from npm). This is the only run with a `Bun.Image` row, and because the machine is Linux, its AVIF cells are empty like `@next/safe-image-optimization`'s.

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

What stands out:

- **On the small image, the isolation is close to free.** `@next/safe-image-optimization` is faster than sharp (1.17x for WebP, 1.18x for JPEG) and within 20% of `@napi-rs/image`, which decodes and encodes in the Node.js process. Reusing workers closes the rest of that gap and makes it the fastest of the four Node.js entries for JPEG.
- **Replacing a worker after every image costs 12-28% of throughput here** (the gap between the two `@next/safe-image-optimization` rows; 10-24% in the Bun run). With one image at a time it shows up as about 1.5-2.5 ms of extra latency per image, which is a fixed cost, so it matters less the larger the image is.
- **On the large JPEG input, sharp is 2.1-3.1x faster than both Rust libraries**, and `@next/safe-image-optimization` tracks `@napi-rs/image` within a few percent. That points at decoding rather than at the worker protocol: libvips decodes a JPEG at a reduced DCT scale when the output is going to be much smaller, so it never decodes the full 6 megapixels. See [future work](../../docs/future-work.md).
- **`Bun.Image` is the fastest entry in every suite it can run** — 1.9x to 3.4x sharp on three of the four WebP and JPEG pipelines, and 12x on the small JPEG one, where a fixed per-image cost is most of what the others are paying (1.4 ms an image against sharp's 13.0 ms with one in flight). It decodes a JPEG at a reduced DCT scale like libvips, encodes with the same libjpeg-turbo and libwebp as sharp, and does very little around them. It also decodes in the application's own process, which is what `@next/safe-image-optimization` gives up throughput to avoid.
- **Quality numbers are not comparable across encoders.** At `quality: 70`, `@napi-rs/image` produced a 13.0 kB AVIF and sharp a 22.2 kB one from the same input, and at `quality: 75`, `@napi-rs/image`'s mozjpeg produced 39.1 kB against 24.0 kB for both sharp and this library. Encoding speed and file size trade against each other, so the slower encoder in a row may simply be doing more.
- **AVIF, which neither this library nor `Bun.Image` on Linux can produce, is the slowest output by a wide margin** — 15-25 images per second on the small input against 179-263 for WebP.
