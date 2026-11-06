// The subset of `Bun.Image` that the benchmark uses. Declared here rather than with `@types/bun`,
// which also redeclares the Node.js globals this package typechecks against, and which would be an
// odd dependency for a package that is run with Node.js by default.
//
// `Bun` only exists when the benchmark runs under Bun (`pnpm bench:bun`), so every use of it is
// behind a `typeof Bun === 'undefined'` check. See https://bun.com/docs/runtime/image.

/**
 * A `Bun.Image` pipeline. Chainable and mutable, like sharp's: nothing runs until a terminal method
 * (here, `bytes()`) is awaited, and the work happens off the JavaScript thread.
 */
interface BunImagePipeline {
  /** Resizes to a width, keeping the aspect ratio, like sharp's `resize(width)`. */
  resize(width: number): BunImagePipeline
  /** Quality is 1-100. */
  jpeg(options: { quality: number }): BunImagePipeline
  /** Quality is 1-100. */
  webp(options: { quality: number }): BunImagePipeline
  /** Quality is 1-100. Needs an OS encoder, which Linux doesn't have (see `bunEncodesAvif`). */
  avif(options: { quality: number }): BunImagePipeline
  /** Runs the pipeline and resolves with the encoded image. */
  bytes(): Promise<Uint8Array>
}

interface BunImageConstructor {
  new (
    input: Uint8Array,
    options?: {
      /** Rejects an input with more pixels than this. Defaults to about 268 MP, like sharp. */
      maxPixels?: number
      /** Applies the EXIF orientation, before every other operation. Default: `true`. */
      autoOrient?: boolean
    },
  ): BunImagePipeline
}

declare const Bun: {
  readonly version: string
  /** Added in Bun 1.4. `undefined` in older versions. */
  readonly Image?: BunImageConstructor
}
