# Polaroica: Photo Library for VS Code

Browse, cull, edit and export photo libraries inside VS Code. A **library** is a local folder or
an SMB network share your computer can already reach; it shows up in the **Polaroica** view in
the activity bar.

## Commands

| Command | Where to find it | What it does |
| --- | --- | --- |
| **Add Library…** | **+** in the Libraries view, Command Palette | Add a local folder or a network share as a library. |
| **Refresh** | Libraries view title, grid toolbar, Command Palette | Re-read the libraries from disk. |
| **Remove Library** | Right-click a library | Remove it from the workspace (nothing is deleted). |
| **Open Photos** | Click / right-click an album | Show the album's photos in the grid. |
| **New Folder…** | Right-click a library or album | Create a sub-folder. |
| **Move to…** | Right-click an album or photo (grid, photo tab) | Move photos or folders to another album or library. |
| **Reveal in OS** | Right-click an album or photo | Show it in Finder / File Explorer. |
| **Auto-Rank Album…** | Right-click an album, grid toolbar, Command Palette | Rate and group an album's photos automatically. |
| **Undo Auto-Rank** | Right-click an album, Command Palette | Restore the ratings from before the last Auto-Rank. |
| **Export to JPEG…** | Right-click an album or photo, grid toolbar, Command Palette | Export photos with your edits baked in. |
| **Delete Rejected Photos…** | Right-click an album, grid toolbar, Command Palette | Send an album's rejected photos to the Trash. |
| **Build Thumbnails Here…** | Album right-click | Build an album's thumbnails ahead of time, with or without its sub-albums. |
| **Build All Thumbnails** | Command Palette | Start building thumbnails for every library. |
| **Thumbnail Progress…** | Command Palette | Details of the thumbnail build; pause, resume or stop it. |
| **Show Cache Info** | Command Palette | Size of the local cache, with an option to clear it. |
| **Show Log** | Command Palette | Polaroica's log (thumbnails, Auto-Rank, face models). |

All commands are under the **Polaroica** category in the Command Palette.

### Keyboard

| Key | Grid | Photo tab |
| --- | --- | --- |
| Arrows | Move the selection | ← → previous / next photo |
| Enter / double-click | Open the photo in its own tab | Back to the grid (double-click) |
| Ctrl/Cmd-click, Shift-click, Ctrl/Cmd+A | Select | |
| `P` / `X` / `U` | Pick / Reject / clear the flag | same |
| `0`–`5` | Star rating | same |
| `\` (hold) | | Before / After |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | | Undo / redo an adjustment |

## Install

Download the `.vsix` from the [GitHub releases](https://github.com/leonardok/polaroica/releases),
then in VS Code: **Extensions** view → `…` → **Install from VSIX…** Requires VS Code 1.85 or
later. The extension is published as `ChimarraoTech.polaroica`; if you have the older
`leonardok.polaroica` installed, uninstall it first (your ratings and edits are kept, they live
next to your photos).

## Overview

- **Libraries and albums**: each library is a root in the tree, with its folders (albums) below.
  Albums show their photo count; hover one for picks, rejects, photos still to cull, stars, edits
  and RAW/JPEG counts. Libraries that can't be reached show as *offline*.
- **Grid**: justified rows of thumbnails with a size slider, sort order (name, date, size), a
  filter bar (All / Picks / Unflagged / Rejects, by stars, hide rejects) and a details panel with
  EXIF.
- **Photo tabs**: each photo opens in its own tab with a filmstrip, Fit / 100% zoom and a rating
  bar (with optional auto-advance).
- **Culling**: Pick, Reject and 0–5 stars. Ratings are saved in `.sidecar/<photo>.xmp` next to the
  photo; flagging never moves or deletes anything.
- **Adjust**: histogram, Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Temperature (in
  Kelvin, starting from the photo's own), Tint, Vibrance and Saturation, drawn live with WebGL.
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

Design: see [`docs/design`](docs/design).

## Network shares (SMB)

The extension does not speak SMB itself and stores no passwords. Connect to the share the way
you normally do, then add it (`\\nas\photos`, `smb://nas/photos`, or the mounted path):

| OS | Connect with | The extension looks in |
| --- | --- | --- |
| Windows | File Explorer (sign in once) | `\\host\share` (UNC path) |
| macOS | Finder › Go › Connect to Server | `/Volumes/share` |
| Linux | Files › Other Locations (gvfs), or `mount -t cifs` | `/run/user/<uid>/gvfs/smb-share:server=host,share=share`, `/mnt/share`, `/media/share` |

If the share isn't found there, choose the mounted folder yourself (the warning offers
*Choose Mounted Folder…*).

**Windows:** VS Code only opens UNC paths on hosts listed in `security.allowedUNCHosts`. When you
add a share, the extension offers to add its host there for you.

## Thumbnails and the local cache

Photos on a share are big and the network is slow, so Polaroica keeps a **local cache** on this
computer (in VS Code's extension storage, never on the share):

- **Thumbnails**: small WebP files packed one file per folder; after the first visit a folder
  loads from local disk in milliseconds.
- **Built as you go**: opening an album makes the thumbnails it is missing, in the background,
  for that album only (not its sub-albums). An album that is already done costs a moment of
  local reads and shows nothing. Nothing is crawled up front, so a library of a million photos
  is as quick to add as a small one.
- **Building ahead**: **Build Thumbnails Here…** on an album (optionally with its sub-albums),
  **Build All Thumbnails**, or the `polaroica.backgroundThumbnails` setting for every library at
  startup. A **quick pass** uses the tiny EXIF preview in each photo so the albums are browsable
  fast; a **sharp pass** uses the camera's larger built-in preview (or the full file when there
  is none). They read the share gently, pause while you browse and resume after a restart.
- **Folder index**: file names, sizes, dates and EXIF, so folders and photo counts appear
  instantly while the share is re-checked in the background.
- **Photo tabs** show the cached thumbnail at once while the original loads, and preload the
  neighbours.
- The cache is capped (`polaroica.cacheSizeMB`); the least recently viewed folders go first.

## Formats

The grid and photo tabs show JPEG, PNG, GIF, WebP, AVIF, BMP and SVG. Camera RAW files (NEF, CR2,
ARW, DNG, ORF, RW2, PEF, RAF, …) show the preview JPEG embedded in the file. CR3, TIFF and HEIC
display as a labelled placeholder.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `polaroica.sortBy` | `name` | Default order: `name`, `modified` or `size`. |
| `polaroica.showPhotoCounts` | `true` | Photo counts in the tree. |
| `polaroica.thumbnailSize` | `256` | Thumbnail long edge: 192, 256 or 320 px (≈ 4 / 6 / 9 KB each). |
| `polaroica.cacheSizeMB` | `1024` | Disk space for the local cache (≈ 200,000 photos). |
| `polaroica.backgroundThumbnails` | `false` | Build thumbnails for every library in the background at startup. Off: they are built as you open albums. |
| `polaroica.autoRank.burstSeconds` | `2` | Auto-Rank: max seconds between frames of one burst. |
| `polaroica.autoRank.sceneSeconds` | `60` | Auto-Rank: max seconds between shots of the same scene and framing that still stack (0 = bursts only). |
| `polaroica.export.quality` | `90` | JPEG quality of exports (50–100). |

## Known limitations

- Grid thumbnails don't show edits.
- RAW export doesn't apply the camera's lens corrections, so it frames slightly wider than the
  camera's own JPEG.
- If your editor doesn't accept drops from webviews, dragging photos from the grid onto the tree
  won't work; use *Move to…*.
- File-change watching may not fire on every SMB server; use **Refresh**.

## Develop

```bash
npm install
```

```bash
npm test
```

Then press **F5** in VS Code (*Run Polaroica extension*) to start an Extension Development
Host. To build a `.vsix`:

```bash
npx @vscode/vsce package
```

## License

Copyright (C) 2026 leonardok

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. See [`LICENSE`](LICENSE).

RAW export uses [LibRaw](https://www.libraw.org/) (LGPL 2.1 / CDDL 1.0) through
[libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) (ISC). The face models are
[MediaPipe](https://github.com/google-ai-edge/mediapipe) (Apache-2.0).
