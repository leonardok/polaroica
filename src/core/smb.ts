/**
 * SMB shares are reached through the operating system: the share must already be connected
 * (Windows UNC access, macOS /Volumes mount, Linux gvfs or a mount point). This module turns
 * what the user typed into the local paths where that share can show up. No `vscode` import.
 */

export interface SmbAddress {
  host: string;
  share: string;
  /** Sub-folders inside the share. */
  rest: string[];
}

/** Accepts `\\host\share\sub`, `//host/share/sub` and `smb://[user@]host/share/sub`. */
export function parseSmbAddress(input: string): SmbAddress | undefined {
  let s = input.trim();
  if (!s) {
    return undefined;
  }
  const lower = s.toLowerCase();
  if (lower.startsWith('smb://')) {
    s = s.slice(6);
    const at = s.indexOf('@');
    const slash = s.indexOf('/');
    if (at !== -1 && (slash === -1 || at < slash)) {
      s = s.slice(at + 1);
    }
  } else if (s.startsWith('\\\\') || s.startsWith('//')) {
    s = s.slice(2);
  } else {
    return undefined;
  }
  const parts = s.split(/[\\/]+/).filter((p) => p.length > 0).map(safeDecode);
  if (parts.length < 2) {
    return undefined;
  }
  const [hostPort, share, ...rest] = parts;
  const host = hostPort.replace(/:\d+$/, '');
  if (!host || !share) {
    return undefined;
  }
  return { host, share, rest };
}

function safeDecode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

export function formatUnc(a: SmbAddress): string {
  return '\\\\' + [a.host, a.share, ...a.rest].join('\\');
}

export interface PlatformInfo {
  platform: NodeJS.Platform;
  uid?: number;
}

/**
 * Local paths where the share may be reachable, most likely first. The caller checks which
 * one exists.
 */
export function candidateLocalPaths(a: SmbAddress, info: PlatformInfo): string[] {
  const restPosix = a.rest.length ? '/' + a.rest.join('/') : '';
  switch (info.platform) {
    case 'win32':
      return [formatUnc(a)];
    case 'darwin':
      // Finder mounts smb://host/share at /Volumes/share (or share-1 when the name is taken).
      return [`/Volumes/${a.share}${restPosix}`, `/Volumes/${a.share}-1${restPosix}`];
    default: {
      const out: string[] = [];
      if (info.uid !== undefined) {
        // GNOME / gvfs (Files "Connect to Server"). gvfs lower-cases server and share.
        out.push(
          `/run/user/${info.uid}/gvfs/smb-share:server=${a.host.toLowerCase()},share=${a.share.toLowerCase()}${restPosix}`,
        );
      }
      out.push(
        `/mnt/${a.share}${restPosix}`,
        `/mnt/${a.host}/${a.share}${restPosix}`,
        `/media/${a.share}${restPosix}`,
      );
      return out;
    }
  }
}

/** Best guess whether a local path is a network location (for the tree's icon and label). */
export function looksLikeNetworkPath(fsPath: string, platform: NodeJS.Platform): boolean {
  if (fsPath.startsWith('\\\\') || fsPath.startsWith('//')) {
    return true;
  }
  if (platform === 'darwin') {
    return /^\/Volumes\/[^/]+/.test(fsPath) && !fsPath.startsWith('/Volumes/Macintosh HD');
  }
  if (platform === 'linux') {
    return /\/gvfs\/smb-share:/.test(fsPath);
  }
  return false;
}

/** Library display name for a share: the last sub-folder, else the share name. */
export function defaultLibraryName(a: SmbAddress): string {
  return a.rest.length ? a.rest[a.rest.length - 1] : a.share;
}
