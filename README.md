# vsphoto: Photo Library for VS Code

Browse and organize photo libraries inside VS Code. A **workspace is your photo collection**;
every **library** is a workspace folder: a local folder or an SMB network share your computer
can already reach.

- **Photo Libraries** view in the activity bar: each library is a root node, sub-folders below,
  with photo counts. Libraries that can't be reached show as *offline*.
- **Add Library** with the **+** in the view title: a local folder, or a network share
  (`\\nas\photos`, `smb://nas/photos`, or a path where the share is mounted).
- **Grid**: click a folder to see its photos. Click, Ctrl/Cmd-click and Shift-click to select;
  arrow keys move; Ctrl/Cmd+A selects all. A size slider and sort order (name, date modified,
  size) sit in the toolbar. The details panel shows EXIF (date taken, camera, lens, exposure).
- **Photo tabs**: double-click a photo (or press Enter) to open it **in its own tab**. Opening a
  photo that is already open focuses its tab. In a photo tab, **← →** go to the previous / next
  photo, the filmstrip jumps to a neighbour, and a double-click goes back to the grid.
- **Adjust** (photo tab, collapsible **ADJUST** section): histogram; Exposure, Contrast,
  Highlights, Shadows, Whites, Blacks; a tone curve (RGB, R, G, B: click to add a point, drag,
  double-click to remove); Temperature, Tint, Vibrance, Saturation. Drawn live with WebGL.
  **Before / After** (or hold `\`), undo / redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z), Reset, Copy
  Settings / Paste. Edits are **non-destructive**: they are saved to
  `.sidecar/<photo name>.xmp` in the photo's folder (hidden from the library) and the photo file is
  never changed. Edited photos show an orange dot in the grid and filmstrip.
- **Culling**: flag photos **Pick** (`P`) or **Reject** (`X`), clear with `U`, and give **0–5 stars**
  (`0`–`5`), in the grid (on the selection) or in the photo tab's rating bar (with optional
  **Auto-advance** to the next photo). The grid's filter bar shows All / Picks / Unflagged /
  Rejects with counts, can **hide rejects** and filter by stars; rejects are washed out. Albums in
  the sidebar show their pick count. Ratings live in the same `.sidecar/<photo>.xmp`
  (`xmp:Rating`); nothing is moved or deleted.
- **Auto-Rank** an album (right-click it in the sidebar, the grid's **Auto-Rank…** button, or the
  Command Palette): measures **focus** (sharpest part of each photo, relative to the album),
  **washed-out highlights** (large blown-out areas) and **similar shots** (bursts: taken within
  `vsphoto.autoRank.burstSeconds` and alike by a look-alike hash), then sets stars, **picks the
  best of each group of similar shots**, and stacks the groups in the grid. Photos you rated yourself
  are left alone; nothing is rejected unless you ask. Ratings it set carry a ✦ until you change them.
  The **AUTO-RANK** section (grid and photo tab) explains each rank with a radar chart and lets you
  choose another shot as a group's best. When it finishes, a notification sums up the run with an
  **Undo** button; the **Undo Auto-Rank** command (Command Palette, or right-click the album)
  restores the previous ratings later too.
- **People** (an Auto-Rank option, with sub-options **Eyes open**, **Looking at the camera**,
  **Smiling** and **Natural expression**): face models (MediaPipe face detector + Face Landmarker,
  Apache-2.0) find every face and score each one's expression, so in a burst the frame where nobody blinks and everyone faces the
  camera wins, and a photo where someone's eyes are closed gets at most 3 stars. Group shots count
  the worst blink most; small background faces are ignored. The models (4.8 MB) ship with the
  extension ([`models/`](models), Apache-2.0); they run on your computer in the grid tab and your
  photos are never uploaded. Problems are logged in **Photo Library: Show Log**.
- **Right-click** a photo (grid or photo tab) for **Move to…** and **Reveal in OS**.
- **Move**: *Move to…* from the grid, a photo tab, or a folder's context menu walks your libraries
  folder by folder (with recent destinations and *New folder…*). Folders can also be dragged onto
  other folders in the tree. Moves between libraries copy, verify the size, then delete the
  original. Name clashes ask: Keep Both / Skip. A photo's edits (`.sidecar/…xmp`) move with it.

Design: see [`docs/design`](docs/design) (design page v1.0.0).

## Network shares (SMB)

The extension does not speak SMB itself and stores no passwords. Connect to the share the way
you normally do, then add it:

| OS | Connect with | The extension looks in |
| --- | --- | --- |
| Windows | File Explorer (sign in once) | `\\host\share` (UNC path) |
| macOS | Finder › Go › Connect to Server | `/Volumes/share` |
| Linux | Files › Other Locations (gvfs), or `mount -t cifs` | `/run/user/<uid>/gvfs/smb-share:server=host,share=share`, `/mnt/share`, `/media/share` |

If the share isn't found there, choose the mounted folder yourself (the warning offers
*Choose Mounted Folder…*).

**Windows:** VS Code only opens UNC paths on hosts listed in `security.allowedUNCHosts`. When you
add a share, the extension offers to add its host there for you.

## Speed: thumbnails and the local index

Photos on a network share are big and the network is slow, so the extension keeps a **local
cache** on this computer (in VS Code's extension storage, never on the share):

- **Thumbnails**: 256 px WebP, about 5 KB each, packed into one file per folder. The grid only
  ever shows thumbnails; after the first visit a folder's thumbnails load from local disk in
  milliseconds.
- **Background build**: two background workers make thumbnails for every photo in every library,
  with progress in the status bar (`Thumbnails: quick 12,345/100,000 · sharp 4,000/100,000`):
  - **quick pass**: the small preview each camera JPEG carries in its EXIF (one ~72 KB read),
    letterbox bars trimmed and rotated upright, so the whole library becomes browsable fast;
  - **sharp pass**: proper thumbnails from the ~1600 px preview many cameras store inside the JPEG
    (MPF), about 0.3 MB read instead of the whole file; photos without one fall back to a full read.

  Decoding uses WebAssembly codecs (mozjpeg, libwebp) on worker threads (all cores but one, 2–6),
  several photos at a time, so the editor stays responsive. JPEGs exported by Lightroom and similar
  apps have no built-in preview, so each needs one full read; **Thumbnail Progress… › Show Log**
  explains the first full reads of a session (which header segments the file has). The workers read the share gently, wait while you browse, skip what is already cached
  (a restart continues where it stopped) and stop if the cache is full. **Photo Library: Thumbnail
  Progress…** shows the details and can pause, resume or stop; **Build All Thumbnails** starts a
  run; `vsphoto.backgroundThumbnails` turns the automatic build off.
- **Folder index**: file names, sizes, dates and EXIF. Folders and the tree's photo counts appear
  instantly from the index; the share is re-checked in the background.
- **Photo tabs** show the cached thumbnail at once, scaled up, while the original streams in, then
  preload the previous and next photos. The filmstrip uses thumbnails.
- **Moves** carry the cached thumbnail along, so it is not generated again.
- Cache size is capped (`vsphoto.cacheSizeMB`, default 1 GB ≈ 200,000 photos); the least recently
  viewed folders are removed first. **Photo Library: Show Cache Info** shows the size and the
  average thumbnail size, and can clear it.

## Formats

The grid and photo tabs draw JPEG, PNG, GIF, WebP, AVIF, BMP and SVG. Camera RAW files (NEF, CR2,
ARW, DNG, ORF, RW2, PEF, RAF, …) show the preview JPEG embedded in the file; CR3, TIFF and HEIC
display as a labelled placeholder for now.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `vsphoto.sortBy` | `name` | Default order: `name`, `modified` or `size`. |
| `vsphoto.showPhotoCounts` | `true` | Photo counts in the tree. |
| `vsphoto.thumbnailSize` | `256` | Thumbnail long edge: 192, 256 or 320 px (≈ 4 / 6 / 9 KB each). |
| `vsphoto.cacheSizeMB` | `1024` | Disk space for the local cache. |
| `vsphoto.backgroundThumbnails` | `true` | Build thumbnails for the whole library in the background. |
| `vsphoto.autoRank.burstSeconds` | `2` | Auto-Rank: max seconds between frames of one burst. |

## Develop

```bash
npm install
```

```bash
npm test
```

Then press **F5** in VS Code (*Run Photo Library extension*) to start an Extension Development
Host. To build a `.vsix`:

```bash
npx @vscode/vsce package
```

## Known limitations / next steps

- Grid thumbnails don't show edits yet, and there is no Export (a JPEG copy with the edits applied) yet.
- Auto-Rank's composition (framing) signal is designed (canvas page v1.2.0) but not built yet.
- Dragging photos from the grid onto the tree uses the standard `text/uri-list` drag data; if your
  editor doesn't accept drops from webviews, use *Move to…*.
- File-change watching may not fire for every SMB server; use **Refresh** in the view title or
  grid toolbar.

## License

Copyright (C) 2026 leonardok

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version. See [`LICENSE`](LICENSE).
