# Polaroica: Photo Library for VS Code

Browse, cull, edit and export photo libraries inside VS Code. A **library** is a local folder or
an SMB network share your computer can already reach; it shows up in the **Polaroica** view in
the activity bar.

**[Website](https://leok.me/polaroica)** ·
[Download](https://github.com/leonardok/polaroica/releases/latest) ·
[Source](https://github.com/leonardok/polaroica) ·
[Report an issue](https://github.com/leonardok/polaroica/issues) ·
[Release notes](docs/release-notes) ·
[Commands](docs/commands.md) ·
[Settings](docs/settings.md)

## Install

Download the `.vsix` from the [GitHub releases](https://github.com/leonardok/polaroica/releases),
then in VS Code: **Extensions** view → `…` → **Install from VSIX…** Requires VS Code 1.85 or
later. The extension is published as `ChimarraoTech.polaroica`; if you have the older
`leonardok.polaroica` installed, uninstall it first (your ratings and edits are kept, they live
next to your photos).

## What it does

- **Libraries and albums**: each library is a root in the tree, with its folders (albums) below.
  Albums show their photo count; hover one for picks, rejects, photos still to cull, stars, edits
  and RAW/JPEG counts.
- **Grid**: justified rows of thumbnails with a size slider, sort order (name, date, size), a
  filter bar (All / Picks / Unflagged / Rejects, by stars, hide rejects) and a details panel with
  EXIF.
- **Photo tabs**: each photo opens in its own tab with a filmstrip, Fit / 100% zoom and a rating
  bar (with optional auto-advance).
- **Culling**: Pick, Reject and 0–5 stars. Ratings are saved in `.sidecar/<photo>.xmp` next to the
  photo; flagging never moves or deletes anything.
- **Adjust**: histogram, Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Temp, Tint,
  Vibrance, Saturation, a Color tint, Clarity, Dehaze, Sharpness, Noise, Moiré and Defringe, drawn
  live with WebGL.
  **Auto** (the wand) sets the Light and Color sliders for a balanced picture: it meters on faces
  found by Auto-Rank's People option (otherwise the middle of the frame), keeps night and snow
  scenes dark or bright, and corrects colour casts part of the way. You can fine-tune or undo it,
  and add your own correction on top of every Auto under **Settings › Polaroica › Auto Adjust**.
  Before / After, undo / redo, Reset, Copy / Paste settings. Edits are **non-destructive**: they
  are saved in the same `.sidecar` file and the photo is never changed. Edited photos show an
  orange dot.
- **Auto-Rank**: rates an album by **focus on the subject** (on faces when there are people),
  **blown highlights** and, with the **People** option, **eyes open, looking at the camera,
  smiling and natural expression**. It stacks bursts and repeated shots of the same pose, picks
  the best of each group and keeps near-ties. Photos you rated yourself are left alone and nothing
  is rejected unless you ask; ratings it set carry a ✦. The **AUTO-RANK** panel explains each rank
  and lets you choose another best shot. It runs on all CPU cores, caches its measurements, and
  everything stays on your computer: the face models (MediaPipe, Apache-2.0, in [`models/`](models))
  ship with the extension and no photo is uploaded.
- **Export to JPEG**: export the selection, picks, by stars, everything but rejects or all, at full
  size, 3840 or 2048 px, to an `Export` folder in the album or any folder. Edits are baked in and
  photos are turned upright. **RAW files are developed at full sensor resolution** with LibRaw,
  with the camera's own tones and colours. Exports keep EXIF and carry an embedded thumbnail and a
  1600 px preview.
- **Delete rejects**: deletes an album's rejected photos and their sidecars, after asking. They go
  to the Trash; on shares without one it asks again before deleting permanently.
- **Move**: move photos and folders between albums and libraries (or drag folders in the tree).
  Moves between libraries copy, verify, then delete the original; name clashes ask Keep Both /
  Skip. Edits and cached thumbnails move with the photo.
- **Network shares**: add an SMB share you are already connected to and browse it like a local
  folder, with thumbnails and a folder index kept in a local cache so it stays quick.

## Formats

The grid and photo tabs show JPEG, PNG, GIF, WebP, AVIF, BMP and SVG. Camera RAW files (NEF, CR2,
ARW, DNG, ORF, RW2, PEF, RAF, …) show the preview JPEG embedded in the file. CR3, TIFF and HEIC
display as a labelled placeholder.

## Documentation

- [Commands and keyboard shortcuts](docs/commands.md)
- [Settings](docs/settings.md) — every setting, with what it does and an example
- [Network shares (SMB)](docs/network-shares.md) — how to connect on Windows, macOS and Linux
- [Thumbnails and the local cache](docs/thumbnails.md)
- [Release notes](docs/release-notes)
- [Developing Polaroica](docs/development.md)

## Known limitations

- Grid thumbnails don't show edits.
- RAW export doesn't apply the camera's lens corrections, so it frames slightly wider than the
  camera's own JPEG.
- If your editor doesn't accept drops from webviews, dragging photos from the grid onto the tree
  won't work; use *Move to…*.
- File-change watching may not fire on every SMB server; use **Refresh**.

## License

Copyright (C) 2026 leonardok

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. See [`LICENSE`](LICENSE).

RAW export uses [LibRaw](https://www.libraw.org/) (LGPL 2.1 / CDDL 1.0) through
[libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) (ISC). The face models are
[MediaPipe](https://github.com/google-ai-edge/mediapipe) (Apache-2.0).
