# Commands and keyboard shortcuts

All commands are under the **Polaroica** category in the Command Palette
(Ctrl/Cmd+Shift+P).

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
| **Find Documents and Screenshots…** | Right-click a library or album, Command Palette | Look through it and its sub-albums and tag the screenshots it finds. |
| **Show Tagged Photos…** | Click a tag under **Tags**, Command Palette | Open a grid of every photo carrying a tag, from every library. |
| **Tag…** | Right-click a photo in the grid | Add a tag to the selected photos, or take it off again. |
| **Remove Tags…** | Right-click a photo in the grid | Pick from the tags the selected photos carry and take them off. |
| **Build Thumbnails Here…** | Album right-click | Build an album's thumbnails ahead of time, with or without its sub-albums. |
| **Build All Thumbnails** | Command Palette | Start building thumbnails for every library. |
| **Thumbnail Progress…** | Command Palette | Details of the thumbnail build; pause, resume or stop it. |
| **Show Cache Info** | Command Palette | Size of the local cache, with an option to clear it. |
| **Show Log** | Command Palette | Polaroica's log (thumbnails, Auto-Rank, face models). |

## Keyboard

| Key | Grid | Photo tab |
| --- | --- | --- |
| Arrows | Move the selection | ← → previous / next photo |
| Enter / double-click | Open the photo in its own tab | Back to the grid (double-click) |
| Ctrl/Cmd-click, Shift-click, Ctrl/Cmd+A | Select | |
| `P` / `X` / `U` | Pick / Reject / clear the flag | same |
| `0`–`5` | Star rating | same |
| `\` (hold) | | Before / After |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | | Undo / redo an adjustment |

## Tags

Tags are keywords on your photos. **Find Documents and Screenshots…** writes them
automatically — today it recognises screenshots from each file's metadata, without
decoding anything, so it gets through a large library in seconds. You can add your own
with **Tag…** on a photo in the grid, and take them off a selection with
**Remove Tags…**.

Tags are stored as `dc:subject` in the photo's sidecar
(`<album>/.sidecar/<photo>.xmp`), the standard XMP field, so other photo programs read
them too. The photo file itself is never written. A tag a scan wrote is marked as
automatic, so a later scan can correct its own guesses — a tag you added by hand is never
removed by a scan.

Every tag in use appears under **Tags** in the Libraries view, with the number of photos
carrying it. Clicking one opens a grid of those photos, gathered from every library, with
the folder each one is in shown under its name. Album-wide actions (Auto-Rank, Export,
Delete Rejected) are hidden there, because the photos come from many albums — open a photo
or its album to use them.
