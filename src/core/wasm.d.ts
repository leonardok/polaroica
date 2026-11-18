// The WebAssembly API exists in Node and Electron; TypeScript only declares it with the DOM lib.
declare namespace WebAssembly {
  class Module {
    private readonly __brand: 'WebAssembly.Module';
  }
  function compile(bytes: ArrayBufferView | ArrayBuffer): Promise<Module>;
}
