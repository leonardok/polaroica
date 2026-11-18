import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Analysis } from './core/analyze';
import { analyzeJpeg, codecThreads } from './core/codec';
import { captureTime, embeddedPreviews, isBrowserJpeg, mpfPreviews, readExif } from './core/exif';
import { extensionOf, isRaw } from './core/images';
import { rankAlbum, RankInput, RankOptions } from './core/rank';
import { emptySidecar, Sidecar } from './core/xmp';
import { EditStore } from './edits';
import { mapLimit, Photo, PhotoStore, readHead, readRange } from './photoStore';

const CHOICES_KEY = 'vsphoto.autoRankChoices';
const ANALYSIS_KEY = 'autorank-analysis-v2';

interface Stored extends Analysis {
  size: number;
  mtime: number;
  time?: number;
}

type Choice = 'focus' | 'exposure' | 'similar' | 'keepMine' | 'reject';

/**
 * Auto-Rank an album: measure each photo (focus, blown highlights, a look-alike hash, capture
 * time), group bursts, and write star ratings, picks and the explanation into the sidecars.
 * Photos you rated yourself are left alone unless you say otherwise. Undo restores the sidecars
 * as they were before the run.
 */
export class AutoRanker {
  private readonly undo = new Map<string, Array<{ photo: vscode.Uri; before: Sidecar }>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: PhotoStore,
    private readonly edits: EditStore,
    private readonly done: (folder: vscode.Uri, summary: string | undefined) => void,
  ) {}

  async run(folder: vscode.Uri): Promise<void> {
    const photos = await this.store.photos(folder);
    if (!photos.length) {
      void vscode.window.showInformationMessage('This folder has no photos to rank.');
      return;
    }
    const choices = await this.pickChoices(path.basename(folder.fsPath), photos.length);
    if (!choices) {
      return;
    }
    const opts: RankOptions = {
      focus: choices.has('focus'),
      exposure: choices.has('exposure'),
      similar: choices.has('similar'),
      reject: choices.has('reject'),
      burstSeconds: vscode.workspace.getConfiguration('vsphoto').get<number>('autoRank.burstSeconds', 2),
    };
    const keepMine = choices.has('keepMine');
    const fc = await this.store.cache.folder(folder.fsPath);
    const stored = new Map(Object.entries(fc.getExtra<Record<string, Stored>>(ANALYSIS_KEY) ?? {}));

    const cancelled = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Auto-ranking ${path.basename(folder.fsPath)}`, cancellable: true },
      async (progress, token) => {
        let doneCount = 0;
        const step = 100 / photos.length;
        await mapLimit(photos, codecThreads(), async (p) => {
          if (token.isCancellationRequested) {
            return;
          }
          const prev = stored.get(p.name);
          if (!prev || prev.size !== p.size || prev.mtime !== p.mtime) {
            const a = await this.analyze(p).catch(() => undefined);
            if (a) {
              stored.set(p.name, { ...a, size: p.size, mtime: p.mtime });
            }
          }
          doneCount++;
          progress.report({ increment: step, message: `analysing ${doneCount} of ${photos.length}` });
        });
        return token.isCancellationRequested;
      },
    );
    fc.setExtra(ANALYSIS_KEY, Object.fromEntries(stored));
    if (cancelled) {
      return;
    }

    const inputs: RankInput[] = photos
      .filter((p) => stored.has(p.name))
      .map((p) => {
        const s = stored.get(p.name)!;
        return { name: p.name, time: s.time, sharpness: s.sharpness, blown: s.blown, hash: s.hash };
      });
    const results = rankAlbum(inputs, opts);

    // Write ratings, keeping what you rated yourself.
    const cull = await this.edits.cullingIn(folder.fsPath);
    const at = new Date().toISOString();
    const undo: Array<{ photo: vscode.Uri; before: Sidecar }> = [];
    let written = 0;
    let kept = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Saving ratings' },
      async () => {
        await mapLimit(results, 6, async (r) => {
          const photo = vscode.Uri.file(path.join(folder.fsPath, r.name));
          const c = cull.get(r.name);
          const yours = !!c && !c.auto && (c.rating > 0 || !!c.flag);
          if (keepMine && yours) {
            kept++;
            return;
          }
          const before = (await this.edits.loadSidecar(photo)) ?? emptySidecar();
          undo.push({ photo, before });
          await this.edits.write(photo, {
            ...before,
            rating: r.stars,
            flag: r.flag,
            auto: { scores: r.scores, groupAvg: r.groupAvg, group: r.group, notes: r.notes, reason: r.reason, at },
          });
          written++;
        });
      },
    );
    this.undo.set(folder.fsPath, undo);

    const groups = new Set(results.filter((r) => r.group).map((r) => r.group!.id)).size;
    const blurry = results.filter((r) => r.notes.includes('blurry')).length;
    const washed = results.filter((r) => r.notes.includes('washed out')).length;
    const missed = photos.length - inputs.length;
    const parts = [
      `Auto-ranked ${written} photo${written === 1 ? '' : 's'}`,
      opts.similar ? `${groups} group${groups === 1 ? '' : 's'} of similar shots` : '',
      opts.focus ? `${blurry} blurry` : '',
      opts.exposure ? `${washed} washed out` : '',
    ].filter(Boolean);
    const summary =
      parts[0] +
      (parts.length > 1 ? ': ' + parts.slice(1).join(', ') : '') +
      '.' +
      (kept ? ` ${kept} you had already rated were left as they were.` : '') +
      (missed ? ` ${missed} could not be read.` : '');
    this.done(folder, summary);
  }

  async undoRun(folder: vscode.Uri): Promise<void> {
    const list = this.undo.get(folder.fsPath);
    if (!list) {
      return;
    }
    this.undo.delete(folder.fsPath);
    await mapLimit(list, 6, (u) => this.edits.write(u.photo, u.before));
    this.done(folder, undefined);
  }

  /** Make another shot of a similar group its best (pick), instead of the one Auto-Rank chose. */
  async makeBest(folder: vscode.Uri, name: string): Promise<void> {
    const cull = await this.edits.cullingIn(folder.fsPath);
    const chosen = cull.get(name);
    const g = chosen?.auto?.group;
    if (!chosen || !g) {
      return;
    }
    const members = [...cull].filter(([, c]) => c.auto?.group?.id === g.id);
    const oldBest = members.find(([, c]) => c.auto?.group?.best);
    const bestStars = oldBest ? oldBest[1].rating : chosen.rating;
    for (const [n, c] of members) {
      const photo = vscode.Uri.file(path.join(folder.fsPath, n));
      const sc = (await this.edits.loadSidecar(photo)) ?? emptySidecar();
      if (!sc.auto?.group) {
        continue;
      }
      const isBest = n === name;
      sc.auto = { ...sc.auto, group: { ...sc.auto.group, best: isBest } };
      if (isBest) {
        sc.flag = 'pick';
        sc.rating = Math.max(bestStars, c.rating);
        sc.auto.reason = `Best of ${g.size} similar shots: your choice.`;
      } else if (c.flag === 'pick') {
        sc.flag = undefined;
        sc.rating = Math.max(1, Math.min(c.rating, bestStars - 1));
      }
      await this.edits.write(photo, sc);
    }
  }

  /** Bytes good enough to measure: the camera's built-in preview, else the whole file. */
  private async analyze(p: Photo): Promise<(Analysis & { time?: number }) | undefined> {
    const head = await readHead(p.uri.fsPath, 512 * 1024).catch(() => undefined);
    if (!head) {
      return undefined;
    }
    const time = captureTime(readExif(head));
    const ranges = isRaw(p.name) ? embeddedPreviews(head) : mpfPreviews(head);
    for (const r of ranges) {
      if (r.length > 8 * 1024 * 1024 || r.offset + r.length > p.size) continue;
      const bytes = r.offset + r.length <= head.length ? head.subarray(r.offset, r.offset + r.length) : await readRange(p.uri.fsPath, r.offset, r.length).catch(() => undefined);
      if (!bytes || bytes.length !== r.length || !isBrowserJpeg(bytes)) continue;
      const a = await analyzeJpeg(bytes).catch(() => undefined);
      if (a && Math.max(a.sourceWidth, a.sourceHeight) >= 900) {
        return { sharpness: a.sharpness, blown: a.blown, hash: a.hash, time };
      }
    }
    const ext = extensionOf(p.name);
    if (isRaw(p.name) || !['jpg', 'jpeg', 'jpe', 'jfif'].includes(ext) || p.size > 80 * 1024 * 1024) {
      return undefined;
    }
    const full = await fs.promises.readFile(p.uri.fsPath).catch(() => undefined);
    if (!full) {
      return undefined;
    }
    const a = await analyzeJpeg(full);
    return { sharpness: a.sharpness, blown: a.blown, hash: a.hash, time };
  }

  private async pickChoices(album: string, count: number): Promise<Set<Choice> | undefined> {
    const saved = new Set(this.context.globalState.get<Choice[]>(CHOICES_KEY, ['focus', 'exposure', 'similar', 'keepMine']));
    type Item = vscode.QuickPickItem & { id?: Choice };
    const items: Item[] = [
      { label: 'Consider', kind: vscode.QuickPickItemKind.Separator },
      { id: 'focus', label: '$(eye) Focus', detail: 'Blurry or out-of-focus photos rank lower' },
      { id: 'exposure', label: '$(lightbulb) Washed-out highlights', detail: 'Photos with blown-out white areas rank lower' },
      { id: 'similar', label: '$(layers) Similar shots', detail: 'Group bursts and near-duplicates; the best of each group is picked' },
      { label: 'Then', kind: vscode.QuickPickItemKind.Separator },
      { id: 'keepMine', label: '$(lock) Keep my own ratings', detail: 'Photos you already flagged or starred are left as they are' },
      { id: 'reject', label: '$(close) Reject the worst automatically', detail: 'Very blurry or washed-out photos, and the weaker shots of each group, are flagged as rejects' },
    ];
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `Auto-Rank “${album}” (${count} photos)`;
    qp.placeholder = 'What should the ranking consider? (Enter to rank)';
    qp.canSelectMany = true;
    qp.items = items;
    qp.selectedItems = items.filter((i) => i.id && saved.has(i.id));
    return new Promise((resolve) => {
      let doneFlag = false;
      qp.onDidAccept(async () => {
        const chosen = new Set(qp.selectedItems.map((i) => i.id).filter((x): x is Choice => !!x));
        if (!['focus', 'exposure', 'similar'].some((k) => chosen.has(k as Choice))) {
          qp.placeholder = 'Choose at least one of Focus, Washed-out highlights or Similar shots';
          return;
        }
        doneFlag = true;
        await this.context.globalState.update(CHOICES_KEY, [...chosen]);
        qp.hide();
        resolve(chosen);
      });
      qp.onDidHide(() => {
        qp.dispose();
        if (!doneFlag) resolve(undefined);
      });
      qp.show();
    });
  }
}
