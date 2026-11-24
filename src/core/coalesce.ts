export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Collects the folders that changed and reports them once the burst is over, instead of once per
 * file. It is what keeps a cull honest on a share: a folder listing costs a round trip, so
 * refreshing per deleted photo costs more than the deleting.
 *
 * `undefined` means "everything changed" and outranks any folder collected with it.
 */
export class Coalescer<K> {
  private keys = new Set<K>();
  private all = false;
  private timer: unknown;
  private held = 0;

  constructor(
    private readonly flush: (keys: ReadonlySet<K>, all: boolean) => void,
    private readonly quiet = 120,
    private readonly timers: Timers = realTimers,
  ) {}

  /** A folder changed, or everything did. */
  add(key?: K): void {
    if (key === undefined) {
      this.all = true;
      this.keys.clear(); // "everything" says it all; no need to keep collecting folders
    } else if (!this.all) {
      this.keys.add(key);
    }
    this.arm();
  }

  /**
   * Holds reports while a bulk change runs, so a delete of 300 photos refreshes once, at the end,
   * rather than 300 times while it works. Call the returned function when done.
   */
  hold(): () => void {
    this.held++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        if (--this.held === 0) {
          this.arm();
        }
      }
    };
  }

  /** Reports what has piled up now, if anything. */
  flushNow(): void {
    this.disarm();
    this.emit();
  }

  private arm(): void {
    this.disarm();
    if (this.held > 0 || (!this.all && !this.keys.size)) {
      return;
    }
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      this.emit();
    }, this.quiet);
  }

  private disarm(): void {
    if (this.timer !== undefined) {
      this.timers.clear(this.timer);
      this.timer = undefined;
    }
  }

  private emit(): void {
    const keys = this.keys;
    const all = this.all;
    this.keys = new Set();
    this.all = false;
    if (all || keys.size) {
      this.flush(keys, all);
    }
  }

  dispose(): void {
    this.disarm();
  }
}
