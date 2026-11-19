import * as path from 'path';
import * as vscode from 'vscode';
import { Thumb } from './core/cache';
import { Libraries } from './libraries';
import { isReachable, Photo, PhotoStore } from './photoStore';
import { Limiter, ThumbService } from './thumbs';
import { codecThreads } from './core/codec';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type State = 'idle' | 'running' | 'paused' | 'done' | 'stopped';

/** What one run of the builder covers. */
interface Scope {
  /** Folders to start from; every library when absent. */
  roots?: vscode.Uri[];
  /** Also walk the sub-albums of each root. */
  recursive: boolean;
  /**
   * Started by opening an album: sharp pass only, no status bar until a thumbnail is actually
   * made, no message at the end. An album that is already done finishes unnoticed.
   */
  quiet: boolean;
}

/** One run over a scope, with its own counters and status-bar entry. */
class Run {
  photos: Photo[] = [];
  scanning = true;
  quickDone = 0;
  sharpDone = 0;
  quickMade = 0;
  sharpMade = 0;
  failed = 0;
  cacheFull = false;
  cancelled = false;
  ended = false;
  progress?: vscode.Progress<{ message?: string }>;
  closeProgress?: () => void;

  constructor(readonly scope: Scope) {}

  /** Not stopped, and not stopped by a full cache. */
  get live(): boolean {
    return !this.cancelled && !this.cacheFull;
  }

  /**
   * Thumbnails this run made. Failures don't count: a photo that can't be read here (say a PNG,
   * which only an open grid can decode) would otherwise flash the status bar on every visit.
   */
  get made(): number {
    return this.quickMade + this.sharpMade;
  }

  /** "2026", "2026 and its sub-albums", or "all libraries". */
  get label(): string {
    const root = this.scope.roots?.[0];
    if (!root) {
      return 'all libraries';
    }
    const name = path.basename(root.fsPath) || root.fsPath;
    return this.scope.recursive ? `${name} and its sub-albums` : name;
  }

  end(): void {
    this.ended = true;
    this.closeProgress?.();
    this.progress = undefined;
  }
}

/**
 * Builds thumbnails ahead of time. Lazy by default: opening an album queues a quiet run for that
 * album alone (not its sub-albums), which finishes in a moment when there is nothing to do.
 * "Build Thumbnails Here" does an album, optionally with its sub-albums, and the
 * `polaroica.backgroundThumbnails` setting (off by default) does every library at startup.
 *
 * Each run walks its folders and feeds two workers:
 *  - quick: the small EXIF preview of each photo (one 128 KB read): fast, the album becomes
 *    browsable (skipped for album-open runs: the open grid does that for what's on screen);
 *  - sharp: proper thumbnails from the camera's ~1600 px built-in preview, else the full file.
 * Both read the share gently, wait while an open grid needs the network, and skip what is
 * already cached (so a restart continues where it stopped).
 *
 * Album-open runs go one at a time on their own lane, beside the build runs, so opening an album
 * isn't stuck behind a long build. Both lanes share the same read limits.
 */
export class BackgroundThumbnails implements vscode.Disposable {
  private paused = false;
  private lastState: State = 'idle';
  private lastRun?: Run;
  /** The current build (all libraries, or Build Thumbnails Here), and the ones waiting. */
  private main?: Run;
  private readonly mainQueue: Scope[] = [];
  /** The current album-open run, and the albums waiting. */
  private album?: Run;
  private readonly albumQueue: vscode.Uri[] = [];
  private readonly heads = new Limiter(4);
  // One full read in flight per decoding thread keeps every core busy.
  private readonly fulls = new Limiter(codecThreads());
  private startTimer?: NodeJS.Timeout;
  private lastCapCheck = 0;

  constructor(
    private readonly libraries: Libraries,
    private readonly store: PhotoStore,
    private readonly thumbs: ThumbService,
    private readonly capBytes: () => number,
    private readonly onMade: (photo: Photo, t: Thumb) => void,
  ) {}

  /** The `polaroica.backgroundThumbnails` setting: build every library at startup. */
  get enabled(): boolean {
    return vscode.workspace.getConfiguration('polaroica').get<boolean>('backgroundThumbnails', false);
  }

  /** With the setting on: build every library after a short delay, so opening the window stays snappy. */
  schedule(delayMs = 8000): void {
    clearTimeout(this.startTimer);
    if (!this.enabled) {
      return;
    }
    this.startTimer = setTimeout(() => this.buildAll(), delayMs);
  }

  /** Every photo in every library. Replaces the current build and any waiting ones. */
  buildAll(): void {
    clearTimeout(this.startTimer);
    this.paused = false;
    this.mainQueue.length = 0;
    if (this.main) {
      this.main.cancelled = true;
    }
    this.mainQueue.push({ recursive: true, quiet: false });
    void this.pumpMain();
  }

  /** Build Thumbnails Here: one album, or an album and everything under it. */
  buildHere(folder: vscode.Uri, recursive: boolean): void {
    const same = (s: Scope) => s.roots?.[0]?.fsPath === folder.fsPath && s.recursive === recursive;
    if ((this.main && same(this.main.scope)) || this.mainQueue.some(same)) {
      void vscode.window.showInformationMessage(`Polaroica: already building thumbnails for ${path.basename(folder.fsPath)}.`);
      return;
    }
    if (this.main) {
      void vscode.window.showInformationMessage(
        `Polaroica: thumbnails for ${path.basename(folder.fsPath)} will start when the current build (${this.main.label}) ends.`,
      );
    }
    this.mainQueue.push({ roots: [folder], recursive, quiet: false });
    void this.pumpMain();
  }

  /** An album was opened: fill in its missing thumbnails, quietly. Not its sub-albums. */
  albumOpened(folder: vscode.Uri): void {
    const key = folder.fsPath;
    if (this.album?.scope.roots?.[0]?.fsPath === key || this.albumQueue.some((u) => u.fsPath === key)) {
      return;
    }
    this.albumQueue.push(folder);
    void this.pumpAlbums();
  }

  pause(): void {
    if (this.main && !this.paused) {
      this.paused = true;
      this.report(this.main);
    }
  }

  resume(): void {
    if (this.paused) {
      this.paused = false;
      if (this.main) {
        this.report(this.main);
      }
    } else if (!this.main) {
      this.buildAll();
    }
  }

  /** Stops every run, including album-open ones, and forgets the waiting ones. */
  stop(): void {
    clearTimeout(this.startTimer);
    this.paused = false;
    this.mainQueue.length = 0;
    this.albumQueue.length = 0;
    for (const run of [this.main, this.album]) {
      if (run) {
        run.cancelled = true;
        run.end();
      }
    }
    if (this.main || this.lastState === 'running') {
      this.lastState = 'stopped';
    }
  }

  /** Setting turned off: stop building every library (Build Thumbnails Here runs go on). */
  stopBuildAll(): void {
    clearTimeout(this.startTimer);
    for (let i = this.mainQueue.length - 1; i >= 0; i--) {
      if (!this.mainQueue[i].roots) {
        this.mainQueue.splice(i, 1);
      }
    }
    if (this.main && !this.main.scope.roots) {
      this.main.cancelled = true;
      this.main.end();
    }
  }

  get status(): State {
    if (this.main) {
      return this.paused ? 'paused' : 'running';
    }
    return this.lastState;
  }

  /** Text for the "Thumbnail progress" command. */
  summary(): string {
    const run = this.main ?? this.lastRun;
    const st = { idle: 'not started', running: 'running', paused: 'paused', done: 'done', stopped: 'stopped' }[this.status];
    const albumNote = this.album ? ` Also filling in ${this.album.label}, which you opened.` : '';
    if (!run) {
      return (
        `Thumbnails are built as you open albums.` +
        (this.enabled ? '' : ' Right-click an album › Build Thumbnails Here to build ahead of time.') +
        albumNote
      );
    }
    const total = run.photos.length.toLocaleString() + (run.scanning && !run.ended ? '+' : '');
    const s = this.thumbs.sources;
    return (
      `Thumbnails for ${run.label} (${st}): quick ${run.quickDone.toLocaleString()} / ${total}, sharp ${run.sharpDone.toLocaleString()} / ${total}.` +
      ` Made: ${run.quickMade.toLocaleString()} quick, ${run.sharpMade.toLocaleString()} sharp` +
      ` (this session: ${s.preview.toLocaleString()} from built-in previews, ${s.full.toLocaleString()} from full files)` +
      (run.failed ? `, ${run.failed.toLocaleString()} could not be read` : '') +
      (run.cacheFull ? '. Stopped: cache full.' : '.') +
      albumNote
    );
  }

  private async pumpMain(): Promise<void> {
    if (this.main) {
      return;
    }
    while (this.mainQueue.length) {
      const run = new Run(this.mainQueue.shift()!);
      this.main = run;
      this.lastRun = run;
      try {
        await this.execute(run);
      } finally {
        this.main = undefined;
        this.lastState = run.cancelled || run.cacheFull ? 'stopped' : 'done';
      }
    }
    this.paused = false;
  }

  private async pumpAlbums(): Promise<void> {
    if (this.album) {
      return;
    }
    while (this.albumQueue.length) {
      const run = new Run({ roots: [this.albumQueue.shift()!], recursive: false, quiet: true });
      this.album = run;
      try {
        await this.execute(run);
      } finally {
        this.album = undefined;
      }
    }
  }

  private async execute(run: Run): Promise<void> {
    this.report(run);
    await Promise.all([this.crawl(run), run.scope.quiet ? undefined : this.quickWorker(run), this.sharpWorker(run)]);
    run.end();
    if (run.scope.quiet || run.cancelled) {
      return;
    }
    if (run.cacheFull) {
      void vscode.window.showInformationMessage(
        `Polaroica: thumbnail cache is full (${Math.round(this.capBytes() / 1048576)} MB). Raise "polaroica.cacheSizeMB" to cover ${run.label}.`,
      );
    } else if (run.sharpMade > 0) {
      const s = this.thumbs.sources;
      void vscode.window.showInformationMessage(
        `Polaroica: thumbnails ready for ${run.photos.length.toLocaleString()} photos in ${run.label}` +
          ` (${s.preview.toLocaleString()} from built-in previews, ${s.full.toLocaleString()} from full files this session).`,
      );
    } else if (run.scope.roots) {
      // Asked for by hand: say so even when there was nothing to do.
      void vscode.window.showInformationMessage(
        `Polaroica: thumbnails for ${run.label} are up to date (${run.photos.length.toLocaleString()} photos).`,
      );
    }
  }

  /** Shows the run in the status bar. A quiet run appears only once it has made something. */
  private report(run: Run): void {
    if (run.ended || (run.scope.quiet && run.made === 0)) {
      return;
    }
    if (!run.closeProgress) {
      run.closeProgress = () => undefined; // opening
      void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Thumbnails' },
        (progress) =>
          new Promise<void>((resolve) => {
            if (run.ended) {
              resolve();
              return;
            }
            run.progress = progress;
            run.closeProgress = resolve;
            this.report(run);
          }),
      );
      return;
    }
    if (!run.progress) {
      return;
    }
    const total = run.photos.length.toLocaleString() + (run.scanning ? '+' : '');
    const paused = this.paused && run === this.main ? ' (paused)' : '';
    const counts = run.scope.quiet
      ? `${run.sharpDone.toLocaleString()}/${total}`
      : `quick ${run.quickDone.toLocaleString()}/${total} · sharp ${run.sharpDone.toLocaleString()}/${total}`;
    run.progress.report({ message: `${run.label}: ${counts}${paused}` });
  }

  /** Walks the run's folders breadth-first (the local index makes repeat walks cheap). */
  private async crawl(run: Run): Promise<void> {
    run.scanning = true;
    try {
      const roots = run.scope.roots ?? this.libraries.all.map((l) => l.uri);
      for (const root of roots) {
        if (!run.live || !(await isReachable(root.fsPath))) {
          continue;
        }
        const queue: vscode.Uri[] = [root];
        while (queue.length && run.live) {
          await this.waitTurn(run);
          const folder = queue.shift()!;
          try {
            const listing = await this.store.listing(folder);
            // A loop, not push(...photos): a folder of a few hundred thousand photos would
            // overflow the call stack as spread arguments.
            for (const p of listing.photos) {
              run.photos.push(p);
            }
            if (run.scope.recursive) {
              for (const f of listing.folders) {
                queue.push(vscode.Uri.file(path.join(folder.fsPath, f)));
              }
            }
          } catch {
            /* unreadable folder: skip */
          }
          this.report(run);
        }
      }
    } finally {
      run.scanning = false;
      this.report(run);
    }
  }

  /** Waits while paused (build runs), or while an open grid is using the network. */
  private async waitTurn(run: Run): Promise<void> {
    while (run.live && ((this.paused && run === this.main) || this.thumbs.foregroundBusy)) {
      await sleep(400);
    }
  }

  /** Next photo for a worker; waits for the crawl to find more. Undefined when all are done. */
  private async next(run: Run, index: number): Promise<Photo | undefined> {
    while (run.live) {
      if (index < run.photos.length) {
        return run.photos[index];
      }
      if (!run.scanning) {
        return undefined;
      }
      await sleep(200);
    }
    return undefined;
  }

  /**
   * Runs `lanes` copies of `task` over the run's photos, each taking the next unclaimed photo, so
   * several photos are read and decoded at once. `done` is called after each photo.
   */
  private async lanes(run: Run, lanes: number, task: (p: Photo) => Promise<void>, done: () => void): Promise<void> {
    let next = 0;
    const lane = async () => {
      for (;;) {
        const i = next++;
        const p = await this.next(run, i);
        if (!p) {
          return;
        }
        await this.waitTurn(run);
        if (!run.live) {
          return;
        }
        await task(p).catch(() => undefined);
        done();
        this.report(run);
      }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
  }

  private async quickWorker(run: Run): Promise<void> {
    await this.lanes(
      run,
      2,
      async (p) => {
        if ((await this.thumbs.state(p)) === 'none') {
          const t = await this.thumbs.quick(p, this.heads).catch(() => undefined);
          if (t) {
            run.quickMade++;
            this.onMade(p, t);
          }
        }
      },
      () => run.quickDone++,
    );
  }

  private async sharpWorker(run: Run): Promise<void> {
    const folders = new Set<string>();
    // Only a walk over many albums stops at the cache cap: it would otherwise evict its own work.
    // A single album just goes in, and the least recently viewed folders make room.
    const capped = run.scope.recursive;
    // One photo in flight per decoding thread (Lightroom exports need a full read and decode).
    await this.lanes(
      run,
      codecThreads(),
      async (p) => {
        const dir = path.dirname(p.uri.fsPath);
        if (!folders.has(dir)) {
          folders.add(dir);
          if (capped && Date.now() - this.lastCapCheck > 20000) {
            this.lastCapCheck = Date.now();
            if ((await this.store.cache.stats()).bytes > this.capBytes() * 0.95) {
              run.cacheFull = true; // stops every lane, the quick pass and the crawl
              return;
            }
          }
        }
        if ((await this.thumbs.state(p)) !== 'sharp') {
          const t = await this.thumbs.sharp(p, this.heads, this.fulls).catch(() => undefined);
          if (t) {
            run.sharpMade++;
            this.onMade(p, t);
          } else {
            run.failed++;
          }
        }
      },
      () => run.sharpDone++,
    );
    // Sharp thumbnails replaced quick ones: reclaim that space.
    for (const dir of folders) {
      await this.thumbs.compact(vscode.Uri.file(dir));
    }
  }

  dispose(): void {
    this.stop();
  }
}
