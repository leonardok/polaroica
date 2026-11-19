# Network shares (SMB)

Polaroica does not speak SMB itself and stores no passwords. Connect to the share the way you
normally do, then add it (`\\nas\photos`, `smb://nas/photos`, or the mounted path):

| OS | Connect with | Polaroica looks in |
| --- | --- | --- |
| Windows | File Explorer (sign in once) | `\\host\share` (UNC path) |
| macOS | Finder › Go › Connect to Server | `/Volumes/share` |
| Linux | Files › Other Locations (gvfs), or `mount -t cifs` | `/run/user/<uid>/gvfs/smb-share:server=host,share=share`, `/mnt/share`, `/media/share` |

If the share isn't found there, choose the mounted folder yourself (the warning offers
*Choose Mounted Folder…*).

**Windows:** VS Code only opens UNC paths on hosts listed in `security.allowedUNCHosts`. When
you add a share, Polaroica offers to add its host there for you.

Libraries that can't be reached show as *offline* in the tree; they come back on their own once
the share is mounted again, or with **Refresh**.

Photos on a share are big and the network is slow, so Polaroica keeps thumbnails and a folder
index in a [local cache](thumbnails.md) on your own computer.
