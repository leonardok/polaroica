# Design snapshot

Snapshot of the design canvas the extension was built from: canvas page **v1.0.0**
(canvas version labelled "Snapshot before implementation").

Versioning: a page on the canvas is a frozen design version. A new design iteration goes on a
new page with a bumped version number (v1.1.0, v2.0.0, …); earlier pages are not edited.

Live canvas: https://claude.ai/artifact/MJryZspHmYk7c3Yfgvjcrr (private — open it from the
owner's account, or share it from the page's Share menu).

| File | Screen |
| --- | --- |
| `Main.dc.html` | Library view: libraries tree on the left, photo grid, details panel. Double-click opens a photo tab; ← → browse. |
| `AddLibrary.dc.html` | Add Library, started from the **+** next to PHOTO LIBRARIES: local folder or SMB share, two steps. |
| `Move.dc.html` | Moving photos: drag onto a folder in the tree, or **Move to…** picker, with a progress notification. |
| `PhotoView.dc.html` | A photo open in its own tab: full view, prev / next, filmstrip, details. |
| `canvas.json` | Canvas layout (artboard positions and titles). |

The `.dc.html` files are Design Component sources; they render inside the design canvas, not as
standalone pages.

## Decisions captured in the designs

- The extension is a VS Code extension; a **workspace is a photo library collection** and every
  library is a workspace folder, shown as a root node in the *Photo Libraries* view.
- Libraries are either local folders or **SMB shares the OS can already reach** (mounted /
  connected). The extension stores no credentials and speaks no network protocol itself.
- Adding a library starts from the **+** in the view title.
- Double-clicking a photo opens it **in its own tab**; opening an already-open photo focuses its tab.
- In a photo tab, **← →** move to the previous / next photo in the same tab.
- Management is **move only** for now: drag to a folder, or *Move to…*. Moving between libraries
  copies, verifies size, then deletes the original.
