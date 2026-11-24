# Third-party notices

Polaroica is free software under the GNU General Public License, version 3 or later (see
[`LICENSE`](LICENSE)). It ships the libraries below inside the packaged extension. Each keeps its
own licence; this file records what they are and where the full texts live in the package.

| Library | What it does here | Licence | Full text |
| --- | --- | --- | --- |
| [libheif](https://github.com/strukturag/libheif), with [libde265](https://github.com/strukturag/libde265) and [dav1d](https://code.videolan.org/videolan/dav1d), via [libheif-js](https://github.com/catdad-experiments/libheif-js) | Decodes HEIC/HEIF photos | LGPL-3.0 (libheif, libde265); BSD-2-Clause (dav1d) | `node_modules/libheif-js/libheif-wasm/LICENSE` |
| [LibRaw](https://www.libraw.org/), via [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) | Develops camera RAW files for export | LGPL-2.1 / CDDL-1.0 (LibRaw); ISC (libraw-wasm) | `node_modules/libraw-wasm/LICENSE` |
| [jSquash](https://github.com/jamsinclair/jSquash) (mozjpeg, libwebp) | Decodes JPEG and encodes WebP thumbnails | Apache-2.0 (jSquash); BSD-3-Clause (mozjpeg, libwebp) | `node_modules/@jsquash/*/LICENSE` |
| [MediaPipe](https://github.com/google-ai-edge/mediapipe) | Face detection for Auto-Rank | Apache-2.0 | `node_modules/@mediapipe/tasks-vision/LICENSE` |

All four are used as separate libraries, loaded at run time and not modified. The LGPL libraries
are shipped as their own WebAssembly builds, so replacing them is a matter of swapping those files
in `node_modules`; their sources are available from the upstream projects linked above.

## HEVC and HEIC

A HEIC photo is an HEVC (H.265) picture in an ISOBMFF container, and HEVC is covered by patents
licensed through several pools (Access Advance, Via LA, and individual holders). There is no
royalty-free grant for distributing an HEVC implementation: operating systems and devices that
ship one pay for it, which is why Windows asks for a paid extension before Photos will open a
HEIC, and why browsers lean on the system codec rather than bundling their own.

Polaroica bundles `libde265`, so it distributes an HEVC **decoder**. The practical exposure for a
free, open-source extension is negligible — the pools pursue volume device manufacturers, their
terms carry volume thresholds, and projects such as ffmpeg, VLC and Darktable have shipped HEVC
decoding for years without incident. It is recorded here so that anyone redistributing Polaroica,
and in particular anyone packaging it commercially, knows the obligation exists and can take their
own advice. Nothing here encodes HEVC: decoded pixels are re-encoded as WebP or JPEG.

AVIF, by contrast, is AV1, which the Alliance for Open Media designed to be royalty-free; Polaroica
draws AVIF files with the editor's own browser engine and needs no bundled decoder for them.
