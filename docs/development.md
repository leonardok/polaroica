# Developing Polaroica

```bash
npm install
```

```bash
npm test
```

Then press **F5** in VS Code (*Run Polaroica extension*) to start an Extension Development
Host.

To build a `.vsix`:

```bash
npx @vscode/vsce package
```

Releases are built by the `polaroica-build-release` workflow and named
`polaroica-extension-<version>`.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution licence terms.

## Third-party components

RAW export uses [LibRaw](https://www.libraw.org/) (LGPL 2.1 / CDDL 1.0) through
[libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) (ISC). The face models used by Auto-Rank
and Auto adjust are [MediaPipe](https://github.com/google-ai-edge/mediapipe) (Apache-2.0) and
ship with the extension in [`models/`](../models).
