import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Analysis } from './core/analyze';
import { Rgba } from './core/image';
import { analyzeJpeg, codecThreads } from './core/codec';
import { captureTime, embeddedPreviews, isBrowserJpeg, mpfPreviews, readExif } from './core/exif';
import { extensionOf, isRaw } from './core/images';
import { FaceMetric, PeopleSignal, rankAlbum, RankInput, RankOptions } from './core/rank';
import { ensureFaceModel } from './faceModel';
import { emptySidecar, Sidecar } from './core/xmp';
import { EditStore } from './edits';
import { mapLimit, Photo, PhotoStore, readHead, readRange } from './photoStore';

const CHOICES_KEY = 'vsphoto.autoRankChoices';
const ANALYSIS_KEY = 'autorank-analysis-v2';

interface Stored extends Analysis {
  size: number;
  mtime: number;
  time?: number;
  /** Faces found by the face model; absent until a run used it. */
  faces?: FaceMetric[];
}

const PEOPLE: PeopleSignal[] = ['eyes', 'looking', 'smile', 'natural'];
type Choice = 'focus' | 'exposure' | 'similar' | 'people' | PeopleSignal | 'keepMine' | 'reject';

/** Long edge of the image the face model gets (upright RGBA, made from the same decode). */
const FACE_PX = 1600;

/** Measures faces in a photo (upright RGBA pixels). */
export type FaceDetector = (folder: vscode.Uri, pixels: Rgba, modelFile: string) => Promise<{ faces?: FaceMetric[]; error?: string }>;

/**
 * Auto-Rank an album: measure each photo (focus, blown highlights, a look-alike hash, capture
 * time), group bursts, and write star ratings, picks and the explanation into the sidecars.
 * Photos you rated yourself are left alone unless you say otherwise. Undo restores the sidecars
 * as they were before the run.
 */
export class AutoRanker {
  private readonly undo = new Map<string, Array<{ photo: vscode.Uri; before: Sidecar }>>();
  /** Albums with a run that can be undone, most recent last. */
  private readonly undoOrder: string[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: PhotoStore,
    private readonly edits: EditStore,
    private readonly faces: FaceDetector,
    private readonly log: (line: string) => void = () => undefined,
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
      people: PEOPLE.filter((k) => choices.has(k)),
    };
    let model: string | undefined;
    if (opts.people!.length) {
      model = await ensureFaceModel(this.context);
      if (!model) {
        const go = await vscode.window.showWarningMessage('Rank without the people options?', { modal: true, detail: 'Without the face model Auto-Rank can’t judge eyes, gaze or expressions.' }, 'Rank Without');
        if (go !== 'Rank Without') {
          return;
        }
        opts.people = [];
      }
    }
    const keepMine = choices.has('keepMine');
    const fc = await this.store.cache.folder(folder.fsPath);
    const stored = new Map(Object.entries(fc.getExtra<Record<string, Stored>>(ANALYSIS_KEY) ?? {}));

    const cancelled = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Auto-ranking ${path.basename(folder.fsPath)}`, cancellable: true },
      async (progress, token) => {
        let doneCount = 0;
        let faceRuns = 0;
        let faceFails = 0;
        let firstError: string | undefined;
        const step = 100 / photos.length;
        await mapLimit(photos, codecThreads(), async (p) => {
          if (token.isCancellationRequested) {
            return;
          }
          const prev = stored.get(p.name);
          const fresh = prev && prev.size === p.size && prev.mtime === p.mtime;
          if (!fresh || (model && !prev.faces)) {
            const a = await this.analyze(p, model ? FACE_PX : 0).catch((err) => {
              this.log(`Auto-Rank: could not read ${p.name}: ${err instanceof Error ? err.message : String(err)}`);
              return undefined;
            });
            if (a) {
              const { pixels, ...m } = a;
              let faces = fresh ? prev.faces : undefined;
              if (model && pixels && !token.isCancellationRequested) {
                faceRuns++;
                const r = await this.faces(folder, pixels, model).catch((err) => ({ faces: undefined, error: String(err) }));
                if (r.faces) {
                  faces = r.faces;
                  this.log(`Auto-Rank: ${p.name}: ${r.faces.length} face(s) ${JSON.stringify(r.faces)}`);
                } else {
                  faceFails++;
                  firstError ??= r.error ?? 'no answer from the grid tab';
                  this.log(`Auto-Rank: face model failed on ${p.name}: ${r.error ?? 'no answer from the grid tab'}`);
                }
              }
              stored.set(p.name, { ...m, faces, size: p.size, mtime: p.mtime });
            }
          }
          doneCount++;
          progress.report({ increment: step, message: `analysing ${doneCount} of ${photos.length}` });
        });
        if (faceFails) {
          const ok = faceRuns - faceFails;
          void vscode.window
            .showWarningMessage(
              `The face model failed on ${faceFails} of ${faceRuns} photos${ok ? '' : ', so People was not used'}: ${firstError}`,
              'Show Log',
            )
            .then((pick) => pick && vscode.commands.executeCommand('vsphoto.showLog'));
        }
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
        return { name: p.name, time: s.time, sharpness: s.sharpness, blown: s.blown, hash: s.hash, faces: s.faces };
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
    this.undoOrder.splice(0, this.undoOrder.length, ...this.undoOrder.filter((f) => f !== folder.fsPath), folder.fsPath);
    void this.updateUndoContext();

    const groups = new Set(results.filter((r) => r.group).map((r) => r.group!.id)).size;
    const blurry = results.filter((r) => r.notes.includes('blurry')).length;
    const washed = results.filter((r) => r.notes.includes('washed out')).length;
    const closed = results.filter((r) => r.notes.includes('eyes closed')).length;
    const withFaces = inputs.filter((i) => i.faces?.length).length;
    const missed = photos.length - inputs.length;
    const parts = [
      `Auto-ranked ${written} photo${written === 1 ? '' : 's'}`,
      opts.similar ? `${groups} group${groups === 1 ? '' : 's'} of similar shots` : '',
      opts.focus ? `${blurry} blurry` : '',
      opts.exposure ? `${washed} washed out` : '',
      opts.people?.length ? `people in ${withFaces}` : '',
      opts.people?.includes('eyes') ? `${closed} with eyes closed` : '',
    ].filter(Boolean);
    const summary =
      parts[0] +
      (parts.length > 1 ? ': ' + parts.slice(1).join(', ') : '') +
      '.' +
      (kept ? ` ${kept} you had already rated were left as they were.` : '') +
      (missed ? ` ${missed} could not be read.` : '');
    // A notification instead of a banner in the grid; Undo is also a command (Undo Auto-Rank).
    void vscode.window.showInformationMessage(summary, 'Undo').then((pick) => {
      if (pick === 'Undo') void this.undoRun(folder);
    });
  }

  /** Albums whose last Auto-Rank can be undone (this session), most recent first. */
  undoable(): vscode.Uri[] {
    return [...this.undoOrder].reverse().map((f) => vscode.Uri.file(f));
  }

  canUndo(folder: vscode.Uri): boolean {
    return this.undo.has(folder.fsPath);
  }

  async undoRun(folder: vscode.Uri): Promise<void> {
    const list = this.undo.get(folder.fsPath);
    if (!list) {
      void vscode.window.showInformationMessage(`There is no Auto-Rank of “${path.basename(folder.fsPath)}” to undo.`);
      return;
    }
    this.undo.delete(folder.fsPath);
    const i = this.undoOrder.indexOf(folder.fsPath);
    if (i >= 0) this.undoOrder.splice(i, 1);
    void this.updateUndoContext();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Restoring the previous ratings' },
      () => mapLimit(list, 6, (u) => this.edits.write(u.photo, u.before)),
    );
    void vscode.window.showInformationMessage(`Auto-Rank of “${path.basename(folder.fsPath)}” undone: ${list.length} photo${list.length === 1 ? '' : 's'} restored.`);
  }

  private updateUndoContext(): Thenable<unknown> {
    return vscode.commands.executeCommand('setContext', 'vsphoto.canUndoAutoRank', this.undoOrder.length > 0);
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
  private async analyze(p: Photo, facePx: number): Promise<(Analysis & { time?: number; pixels?: Rgba }) | undefined> {
    const head = await readHead(p.uri.fsPath, 512 * 1024).catch(() => undefined);
    if (!head) {
      return undefined;
    }
    const exif = readExif(head);
    const time = captureTime(exif);
    const opts = { facePx: facePx || undefined, orientation: exif?.orientation };
    const ranges = isRaw(p.name) ? embeddedPreviews(head) : mpfPreviews(head);
    for (const r of ranges) {
      if (r.length > 8 * 1024 * 1024 || r.offset + r.length > p.size) continue;
      const bytes = r.offset + r.length <= head.length ? head.subarray(r.offset, r.offset + r.length) : await readRange(p.uri.fsPath, r.offset, r.length).catch(() => undefined);
      if (!bytes || bytes.length !== r.length || !isBrowserJpeg(bytes)) continue;
      const a = await analyzeJpeg(bytes, opts).catch(() => undefined);
      if (a && Math.max(a.sourceWidth, a.sourceHeight) >= 900) {
        return { sharpness: a.sharpness, blown: a.blown, hash: a.hash, time, pixels: a.pixels };
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
    const a = await analyzeJpeg(full, opts);
    return { sharpness: a.sharpness, blown: a.blown, hash: a.hash, time, pixels: a.pixels };
  }

  private async pickChoices(album: string, count: number): Promise<Set<Choice> | undefined> {
    const saved = new Set(this.context.globalState.get<Choice[]>(CHOICES_KEY, ['focus', 'exposure', 'similar', 'keepMine']));
    type Item = vscode.QuickPickItem & { id?: Choice };
    const items: Item[] = [
      { label: 'Consider', kind: vscode.QuickPickItemKind.Separator },
      { id: 'focus', label: '$(eye) Focus', detail: 'Blurry or out-of-focus photos rank lower' },
      { id: 'exposure', label: '$(lightbulb) Washed-out highlights', detail: 'Photos with blown-out white areas rank lower' },
      { id: 'similar', label: '$(layers) Similar shots', detail: 'Group bursts and near-duplicates; the best of each group is picked' },
      { id: 'people', label: '$(person) People', detail: 'Judge faces with a face model that runs on this computer (one-time 3.7 MB download)' },
      { id: 'eyes', label: '$(blank)$(blank) Eyes open', description: 'nobody blinking' },
      { id: 'looking', label: '$(blank)$(blank) Looking at the camera', description: 'face and eyes towards the lens' },
      { id: 'smile', label: '$(blank)$(blank) Smiling' },
      { id: 'natural', label: '$(blank)$(blank) Natural expression', description: 'not caught mid-word or frowning' },
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
    // "People" switches its four signals on and off together; picking one signal turns People on.
    let before = new Set(qp.selectedItems.map((i) => i.id));
    qp.onDidChangeSelection((sel) => {
      const now = new Set(sel.map((i) => i.id));
      const isSignal = (id?: Choice) => !!id && (PEOPLE as Choice[]).includes(id);
      if (now.has('people') && !before.has('people')) {
        PEOPLE.forEach((k) => now.add(k));
      } else if (!now.has('people') && before.has('people')) {
        PEOPLE.forEach((k) => now.delete(k));
      } else if ([...now].some(isSignal)) {
        now.add('people');
      } else {
        now.delete('people');
      }
      before = now;
      const same = now.size === sel.length && sel.every((i) => now.has(i.id));
      if (!same) {
        qp.selectedItems = items.filter((i) => i.id && now.has(i.id));
      }
    });
    return new Promise((resolve) => {
      let doneFlag = false;
      qp.onDidAccept(async () => {
        const chosen = new Set(qp.selectedItems.map((i) => i.id).filter((x): x is Choice => !!x));
        if (!['focus', 'exposure', 'similar', ...PEOPLE].some((k) => chosen.has(k as Choice))) {
          qp.placeholder = 'Choose at least one thing to consider';
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
