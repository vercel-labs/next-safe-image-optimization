# Benchmark

Throughput of `@next/safe-image-optimization` against [sharp](https://sharp.pixelplumbing.com/) and [`@napi-rs/image`](https://github.com/Brooooooklyn/Image), on the pipeline Next.js's image optimizer runs: auto-orient with EXIF, resize to a width, encode.

The method comes from [`@napi-rs/image`'s benchmark](https://github.com/Brooooooklyn/Image/blob/main/bench/bench.mjs), which compares itself to sharp on the same pipeline: submit one image repeatedly, with a fixed number in flight at once, and report completed images per second. Two things differ:

- Every image that starts is waited for and counted, and the rate is measured against the average time a slot spent working, rather than against the wall time of the whole run. Otherwise the tail where slots finish their last image, and the machine is only partly busy, counts against the result.
- The input images are generated with sharp at startup, instead of being read from the repository, because this repository doesn't commit images (the tests generate their fixtures the same way). They're fractal (1/f) value noise, which has roughly the frequency content of a photograph, and a fixed seed, so every machine benchmarks the same bytes.

## Running it

```sh
pnpm bench:release        # from the repository root, or from this directory
```

That builds the release worker and the JS package first, then runs every input and output format, which takes a few minutes. `pnpm bench` uses the debug worker, which is much slower and not worth measuring.

Options, from this directory (from the root, turbo needs them after a separator: `pnpm bench:release -- --formats webp`):

```sh
pnpm bench:release --help
pnpm bench:release --inputs small --formats webp          # one suite
pnpm bench:release --libraries sharp,safe-image           # two of the four entries
pnpm bench:release --concurrency 8 --duration 30          # longer, with more in flight
pnpm bench:release --json > results.json
```

sharp and `@napi-rs/image` run each image on libuv's thread pool, which has 4 threads by default, so on a machine with more cores than that, raise `UV_THREADPOOL_SIZE` before deciding anything. Raising it does nothing for `@next/safe-image-optimization`, which uses worker processes.

## What it measures

| Entry                                                    | Notes                                                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `sharp`                                                  | `sharp(input).rotate().resize(width).<format>({ quality }).toBuffer()`                                                |
| `@napi-rs/image`                                         | `new Transformer(input).rotate().resize(width).<format>(quality)`                                                     |
| `@next/safe-image-optimization`                          | Default pool: one image per worker process, then the worker is replaced                                               |
| `@next/safe-image-optimization (maxImagesPerWorker: 64)` | The same, with workers reused for 64 images — the throughput cost of replacing them is the gap between these two rows |

Inputs are a 600x450 JPEG with EXIF orientation 5 resized to 225px (the size and pipeline `@napi-rs/image`'s benchmark uses), and a 3000x2000 JPEG resized to 640px (closer to a photo someone would upload). Output formats are WebP (quality 75), JPEG (quality 75), and AVIF (quality 70, 4:2:0). `@next/safe-image-optimization` has no AVIF encoder, so it doesn't appear in the AVIF suites.

## What the numbers don't say

Each library runs with its own defaults, because that's what a caller gets. The defaults are not equivalent:

- **Different encoders.** sharp's JPEG encoder is libjpeg-turbo, `@napi-rs/image`'s is mozjpeg, and this library's default is the pure-Rust `jpeg-encoder` (mozjpeg, without assembly, behind `mozjpeg: true`). The AVIF encoders differ too. Equal `quality` numbers are not equal visual quality, and the output sizes in the table differ by much more than the quality setting suggests.
- **Different amounts of work.** libvips decodes a JPEG at a reduced DCT scale when the result is going to be shrunk (shrink-on-load), so sharp decodes far fewer pixels than the other two on the large input. That's a real advantage, not a measurement artifact, but it's an advantage at one specific step.
- **Different ways of using the cores.** libvips splits a single image across its own threads (`VIPS_CONCURRENCY`, which defaults to the core count), so several images in flight on a small machine oversubscribe the CPU. `@next/safe-image-optimization` processes each image in one single-threaded worker, so its throughput comes entirely from running several at once. Run `--concurrency 1` as well as the default to see both ends of that; the results below include it.
- **Different isolation.** This library pays for a worker process per image (and for copying the image in and out of it) in exchange for keeping a decoder bug out of the Node.js process. sharp and `@napi-rs/image` decode in-process. The two `@next/safe-image-optimization` rows bracket what that costs.
- **One machine, one image.** Throughput depends on the input's content and size, the output size, core count, and how much concurrency the caller actually has. Measure your own workload before choosing.

## Results

Measured on a 4 vCPU Intel Xeon @ 2.90GHz (Amazon Linux 2023, x64), Node.js v22.23.4, with the default 4 images in flight and `UV_THREADPOOL_SIZE` unset. sharp 0.35.5 (libvips 8.18.7), `@napi-rs/image` 1.16.0, `@next/safe-image-optimization` 0.0.1 (the prebuilt release worker from npm, because the machine that ran this had no Rust toolchain; the only changes to the worker and to the wrapper's image path since `v0.0.1` are comments and where the worker binary is looked up).

This is a shared cloud VM, so treat the ratios as approximate and rerun on your own hardware.

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

What stands out:

- **On the small image, the isolation is close to free.** `@next/safe-image-optimization` is faster than sharp (1.17x for WebP, 1.18x for JPEG) and within 20% of `@napi-rs/image`, which decodes and encodes in the Node.js process. Reusing workers closes the rest of that gap and makes it the fastest of the four for JPEG.
- **Replacing a worker after every image costs 12-28% of throughput here** (the gap between the two `@next/safe-image-optimization` rows). With one image at a time it shows up as about 1.5-2.5 ms of extra latency per image, which is a fixed cost, so it matters less the larger the image is.
- **On the large JPEG input, sharp is 2.1-3.1x faster than both Rust libraries**, and `@next/safe-image-optimization` tracks `@napi-rs/image` within a few percent. That points at decoding rather than at the worker protocol: libvips decodes a JPEG at a reduced DCT scale when the output is going to be much smaller, so it never decodes the full 6 megapixels. See [future work](../../docs/future-work.md).
- **Quality numbers are not comparable across encoders.** At `quality: 70`, `@napi-rs/image` produced a 13.0 kB AVIF and sharp a 22.2 kB one from the same input, and at `quality: 75`, `@napi-rs/image`'s mozjpeg produced 39.1 kB against 24.0 kB for both sharp and this library. Encoding speed and file size trade against each other, so the slower encoder in a row may simply be doing more.
- **AVIF, which this library can't produce, is the slowest output by a wide margin** — 15-25 images per second on the small input against 179-263 for WebP.
