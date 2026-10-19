// The subset of the WebAssembly JS API that we use. TypeScript only declares it in the DOM libraries.

declare namespace WebAssembly {
  class Module {
    constructor(bytes: ArrayBufferView | ArrayBuffer)
  }
  class Memory {
    constructor(descriptor: { initial: number; maximum?: number })
    readonly buffer: ArrayBuffer
  }
  class Instance {
    constructor(module: Module, imports: Record<string, Record<string, unknown>>)
    readonly exports: Record<string, unknown>
  }
  function compile(bytes: ArrayBufferView | ArrayBuffer): Promise<Module>
}
