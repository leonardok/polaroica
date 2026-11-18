import * as path from 'path';
import * as vscode from 'vscode';
import { Thumb } from './core/cache';
import { Libraries } from './libraries';
import { isReachable, Photo, PhotoStore } from './photoStore';
import { Limiter, ThumbService } from './thumbs';
import { codecThreads } from './core/codec';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type State = 'idle' | 'running' | 'paused' | 'done' | 'stopped';

/**
 * Builds thumbnails for every photo in every library, in the background, as two workers:
 *  - quick: the small EXIF preview of each photo (one 128 KB read): fast, the whole library
 *    becomes browsable;
 *  - sharp: proper thumbnails from the camera's ~1600 px built-in preview, else the full file.
 * Both read the share gently (1–2 reads at a time), wait while an open grid needs the network,
 * skip what is already cached (so a restart continues where it stopped), and show progress in
 * the status bar.
 */
export class BackgroundThumbnails implements vscode.Disposable {
  private state: State = 'idle';
  private generation = 0;
  private photos: Photo[] = [];
  private scanning = false;
  private quickDone = 0;
  private sharpDone = 0;
  private quickMade = 0;
  private sharpMade = 0;
  private failed = 0;
  private cacheFull = false;
  private readonly heads = new Limiter(4);
  // One full read in flight per decoding thread keeps every core busy.
  private readonly fulls = new Limiter(codecThreads());
  private progress?: vscode.Progress<{ message?: string }>;
  private finishProgress?: () => void;
  private startTimer?: NodeJS.Timeout;
  private lastCapCheck = 0;

  constructor(
    private readonly libraries: Libraries,
    private readonly store: PhotoStore,
    private readonly thumbs: ThumbService,
    private readonly capBytes: () => number,
    private readonly onMade: (photo: Photo, t: Thumb) => void,
  ) {}

  get enabled(): boolean {
    return vscode.workspace.getConfiguration('polaroica').get<boolean>('backgroundThumbnails', true);
  }

  /** Start (or restart) after a short delay, so opening the window stays snappy. */
  schedule(delayMs = 8000): void {
    clearTimeout(this.startTimer);
    if (!this.enabled) {
      return;
    }
    this.startTimer = setTimeout(() => void this.start(), delayMs);
  }

  async start(): Promise<void> {
    clearTimeout(this.startTimer);
    const gen = ++this.generation;
    this.state = 'running';
    this.photos = [];
    this.quickDone = this.sharpDone = this.quickMade = this.sharpMade = this.failed = 0;
    this.cacheFull = false;
    this.finishProgress?.();

    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Thumbnails' },
      (progress) =>
        new Promise<void>((resolve) => {
          this.progress = progress;
          this.finishProgress = () => {
            this.progress = undefined;
            resolve();
          };
          this.report();
        }),
    );

    const crawl = this.crawl(gen);
    await Promise.all([crawl, this.quickWorker(gen), this.sharpWorker(gen)]);
    if (gen !== this.generation) {
      return;
    }
    this.state = this.cacheFull ? 'stopped' : 'done';
    this.finishProgress?.();
    if (this.sharpMade > 0 || this.cacheFull) {
      const s = this.thumbs.sources;
      const msg = this.cacheFull
        ? `Polaroica: thumbnail cache is full (${Math.round(this.capBytes() / 1048576)} MB). Raise "polaroica.cacheSizeMB" to cover the whole library.`
        : `Polaroica: thumbnails ready for ${this.photos.length.toLocaleString()} photos` +
          ` (${s.preview.toLocaleString()} from built-in previews, ${s.full.toLocaleString()} from full files).`;
      void vscode.window.showInformationMessage(msg);
    }
  }

  pause(): void {
    if (this.state === 'running') {
      this.state = 'paused';
      this.report();
    }
  }

  resume(): void {
    if (this.state === 'paused') {
      this.state = 'running';
      this.report();
    } else if (this.state !== 'running') {
      void this.start();
    }
  }

  stop(): void {
    this.generation++;
    this.state = 'stopped';
    this.finishProgress?.();
  }

  /** Still the current run, and not stopped by a full cache. */
  private live(gen: number): boolean {
    return gen === this.generation && !this.cacheFull;
  }

  /** Text for the "Thumbnail progress" command. */
  summary(): string {
    const total = this.photos.length.toLocaleString() + (this.scanning ? '+' : '');
    const s = this.thumbs.sources;
    const st = { idle: 'not started', running: 'running', paused: 'paused', done: 'done', stopped: 'stopped' }[this.state];
    return (
      `Thumbnails (${st}): quick ${this.quickDone.toLocaleString()} / ${total}, sharp ${this.sharpDone.toLocaleString()} / ${total}.` +
      ` Made this session: ${this.quickMade.toLocaleString()} quick, ${this.sharpMade.toLocaleString()} sharp` +
      ` (${s.preview.toLocaleString()} from built-in previews, ${s.full.toLocaleString()} from full files)` +
      (this.failed ? `, ${this.failed.toLocaleString()} could not be read` : '') +
      (this.cacheFull ? '. Stopped: cache full.' : '.')
    );
  }

  get status(): State {
    return this.state;
  }

  private report(): void {
    if (!this.progress) {
      return;
    }
    const total = this.photos.length.toLocaleString() + (this.scanning ? '+' : '');
    const paused = this.state === 'paused' ? ' (paused)' : '';
    this.progress.report({
      message: `quick ${this.quickDone.toLocaleString()}/${total} · sharp ${this.sharpDone.toLocaleString()}/${total}${paused}`,
    });
  }

  /** Walks every library folder by folder (the local index makes repeat walks cheap). */
  private async crawl(gen: number): Promise<void> {
    this.scanning = true;
    try {
      for (const lib of this.libraries.all) {
        if (!(await isReachable(lib.uri.fsPath))) {
          continue;
        }
        const queue: vscode.Uri[] = [lib.uri];
        while (queue.length && this.live(gen)) {
          await this.waitTurn(gen);
          const folder = queue.shift()!;
          try {
            const listing = await this.store.listing(folder);
            this.photos.push(...listing.photos);
            for (const f of listing.folders) {
              queue.push(vscode.Uri.file(path.join(folder.fsPath, f)));
            }
          } catch {
            /* unreadable folder: skip */
          }
          this.report();
        }
      }
    } finally {
      this.scanning = false;
      this.report();
    }
  }

  /** Waits while paused, or while an open grid is using the network. */
  private async waitTurn(gen: number): Promise<void> {
    while (this.live(gen) && (this.state === 'paused' || this.thumbs.foregroundBusy)) {
      await sleep(400);
    }
  }

  /** Next photo for a worker; waits for the crawl to find more. Undefined when all are done. */
  private async next(gen: number, index: number): Promise<Photo | undefined> {
    while (this.live(gen)) {
      if (index < this.photos.length) {
        return this.photos[index];
      }
      if (!this.scanning) {
        return undefined;
      }
      await sleep(200);
    }
    return undefined;
  }

  /**
   * Runs `lanes` copies of `task` over the photo list, each taking the next unclaimed photo, so
   * several photos are read and decoded at once. `done` is called after each photo.
   */
  private async lanes(gen: number, lanes: number, task: (p: Photo) => Promise<void>, done: () => void): Promise<void> {
    let next = 0;
    const lane = async () => {
      for (;;) {
        const i = next++;
        const p = await this.next(gen, i);
        if (!p) {
          return;
        }
        await this.waitTurn(gen);
        if (!this.live(gen)) {
          return;
        }
        await task(p).catch(() => undefined);
        done();
        this.report();
      }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
  }

  private async quickWorker(gen: number): Promise<void> {
    await this.lanes(
      gen,
      2,
      async (p) => {
        if ((await this.thumbs.state(p)) === 'none') {
          const t = await this.thumbs.quick(p, this.heads).catch(() => undefined);
          if (t) {
            this.quickMade++;
            this.onMade(p, t);
          }
        }
      },
      () => this.quickDone++,
    );
  }

  private async sharpWorker(gen: number): Promise<void> {
    const folders = new Set<string>();
    // One photo in flight per decoding thread (Lightroom exports need a full read and decode).
    await this.lanes(
      gen,
      codecThreads(),
      async (p) => {
        const dir = path.dirname(p.uri.fsPath);
        if (!folders.has(dir)) {
          folders.add(dir);
          if (Date.now() - this.lastCapCheck > 20000) {
            this.lastCapCheck = Date.now();
            if ((await this.store.cache.stats()).bytes > this.capBytes() * 0.95) {
              this.cacheFull = true; // stops every lane, the quick pass and the crawl
              return;
            }
          }
        }
        if ((await this.thumbs.state(p)) !== 'sharp') {
          const t = await this.thumbs.sharp(p, this.heads, this.fulls).catch(() => undefined);
          if (t) {
            this.sharpMade++;
            this.onMade(p, t);
          } else {
            this.failed++;
          }
        }
      },
      () => this.sharpDone++,
    );
    // Sharp thumbnails replaced quick ones: reclaim that space.
    for (const dir of folders) {
      await this.thumbs.compact(vscode.Uri.file(dir));
    }
  }

  dispose(): void {
    clearTimeout(this.startTimer);
    this.stop();
  }
}
