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
- **Move**: *Move to…* from the grid, a photo tab, or a folder's context menu walks your libraries
  folder by folder (with recent destinations and *New folder…*). Folders can also be dragged onto
  other folders in the tree. Moves between libraries copy, verify the size, then delete the
  original. Name clashes ask: Keep Both / Skip.

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
  ever shows thumbnails. The first time a folder is opened, on-screen photos get the small preview
  embedded in their EXIF straight away, then a proper thumbnail (each original is read from the
  share once). After that the folder's thumbnails load from local disk in milliseconds.
- **Folder index**: file names, sizes, dates and EXIF. Folders and the tree's photo counts appear
  instantly from the index; the share is re-checked in the background.
- **Photo tabs** show the cached thumbnail at once, scaled up, while the original streams in, then
  preload the previous and next photos. The filmstrip uses thumbnails.
- **Moves** carry the cached thumbnail along, so it is not generated again.
- Cache size is capped (`vsphoto.cacheSizeMB`, default 512 MB ≈ 100,000 photos); the least recently
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
| `vsphoto.cacheSizeMB` | `512` | Disk space for the local cache. |

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

- Thumbnails are made only for folders you open (on-screen photos first, then the rest of the
  folder while its grid is visible). A "build thumbnails for the whole library" command could come
  later.
- Dragging photos from the grid onto the tree uses the standard `text/uri-list` drag data; if your
  editor doesn't accept drops from webviews, use *Move to…*.
- File-change watching may not fire for every SMB server; use **Refresh** in the view title or
  grid toolbar.
