# Thumbnails and the local cache

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

**Thumbnail Progress…** shows the details of a build and can pause, resume or stop it;
**Show Cache Info** reports the cache's size and can clear it. Both are in the Command Palette.

The size of each thumbnail (`polaroica.thumbnailSize`), the cache cap
(`polaroica.cacheSizeMB`) and the startup build (`polaroica.backgroundThumbnails`) are
described in [settings.md](settings.md).
