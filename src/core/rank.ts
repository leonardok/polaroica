/**
 * Auto-Rank: turns per-photo measurements into star ratings, picks, groups of similar shots and
 * a short explanation. Pure logic, no I/O. No `vscode` import.
 */
import { Analysis, hamming } from './analyze';
import { compareNames } from './images';

/** One face found by the face model, scored 0–100 (higher is better). */
export interface FaceMetric {
  /** Share of the photo the face covers (0–1); tiny background faces count less. */
  area: number;
  eyes: number; // eyes open
  looking: number; // facing the camera, eyes not looking away
  smile: number;
  natural: number; // not mid-word, not frowning
}

export interface RankInput extends Analysis {
  name: string;
  /** Capture time in ms (EXIF), when known. */
  time?: number;
  /** Faces found ([] = none); undefined when the face model wasn't used. */
  faces?: FaceMetric[];
}

export type PeopleSignal = 'eyes' | 'looking' | 'smile' | 'natural';

export interface RankOptions {
  focus: boolean;
  exposure: boolean;
  similar: boolean;
  /** Also flag the worst photos (and weaker shots of each group) as rejects. */
  reject: boolean;
  /** Max seconds between frames of one burst. */
  burstSeconds: number;
  /** Face expression signals to use (needs `faces` on the inputs). */
  people?: PeopleSignal[];
}

/** Faces smaller than this share of the frame (background people) are ignored. */
const MIN_FACE_AREA = 0.002;

/**
 * One score per signal for a photo's faces, weighted by face size. For "eyes open" the worst face
 * counts most: one person blinking spoils a group shot.
 */
export function peopleScores(faces: FaceMetric[] | undefined, signals: PeopleSignal[]): Record<string, number> | undefined {
  const fs = (faces ?? []).filter((f) => f.area >= MIN_FACE_AREA);
  if (!fs.length || !signals.length) {
    return undefined;
  }
  const total = fs.reduce((a, f) => a + Math.sqrt(f.area), 0);
  const mean = (k: PeopleSignal) => fs.reduce((a, f) => a + f[k] * Math.sqrt(f.area), 0) / total;
  const out: Record<string, number> = {};
  for (const k of signals) {
    out[k] = k === 'eyes' ? 0.7 * Math.min(...fs.map((f) => f.eyes)) + 0.3 * mean('eyes') : mean(k);
  }
  return out;
}

export interface RankResult {
  name: string;
  stars: number;
  flag?: 'pick' | 'reject';
  scores: Record<string, number>;
  groupAvg?: Record<string, number>;
  group?: { id: string; size: number; best: boolean };
  notes: string[];
  reason: string;
}

/** Bits (of 64) two shots may differ by and still count as the same scene. */
const SIMILAR_BITS = 14;

/** Groups consecutive photos taken close together that look alike. */
export function groupSimilar(items: RankInput[], burstSeconds: number): RankInput[][] {
  const sorted = [...items].sort((a, b) => {
    if (a.time !== undefined && b.time !== undefined && a.time !== b.time) {
      return a.time - b.time;
    }
    return compareNames(a.name, b.name);
  });
  const groups: RankInput[][] = [];
  let cur: RankInput[] = [];
  for (const p of sorted) {
    const prev = cur[cur.length - 1];
    const closeInTime =
      prev &&
      (prev.time !== undefined && p.time !== undefined
        ? Math.abs(p.time - prev.time) <= burstSeconds * 1000
        : neighbourNumbers(prev.name, p.name));
    if (prev && closeInTime && hamming(prev.hash, p.hash) <= SIMILAR_BITS) {
      cur.push(p);
    } else {
      if (cur.length) groups.push(cur);
      cur = [p];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** Without capture times: consecutive file numbers (_A733521, _A733522) suggest a burst. */
function neighbourNumbers(a: string, b: string): boolean {
  const na = /(\d+)(?!.*\d)/.exec(a);
  const nb = /(\d+)(?!.*\d)/.exec(b);
  return !!na && !!nb && Math.abs(Number(nb[1]) - Number(na[1])) <= 2;
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

export function rankAlbum(items: RankInput[], opts: RankOptions): RankResult[] {
  if (!items.length) {
    return [];
  }
  // Focus relative to this album: the median photo scores 50, 4× sharper 100, 4× softer 0.
  // That way an album of soft night shots isn't all "blurry".
  const med = median(items.map((p) => p.sharpness)) || 1;
  const focus = (p: RankInput) => clamp(50 + 25 * Math.log2(Math.max(p.sharpness, 1e-6) / med));
  const exposure = (p: RankInput) => clamp(100 - p.blown * 400); // 25% of the frame blown = 0

  const signals = opts.people ?? [];
  const base = new Map<string, Record<string, number>>();
  const faceCount = new Map<string, number>();
  for (const p of items) {
    const s: Record<string, number> = {};
    if (opts.focus) s.focus = focus(p);
    if (opts.exposure) s.exposure = exposure(p);
    const ps = peopleScores(p.faces, signals);
    if (ps) Object.assign(s, ps);
    faceCount.set(p.name, (p.faces ?? []).filter((f) => f.area >= MIN_FACE_AREA).length);
    base.set(p.name, s);
  }
  const quality = (name: string) => {
    const s = base.get(name)!;
    const w = { focus: 0.35, exposure: 0.2, eyes: 0.25, looking: 0.1, smile: 0.1, natural: 0.1 };
    let sum = 0;
    let wt = 0;
    for (const [k, v] of Object.entries(s)) {
      const weight = (w as Record<string, number>)[k] ?? 0.3;
      sum += v * weight;
      wt += weight;
    }
    return wt ? sum / wt : 50;
  };
  const starsFor = (q: number) => (q >= 80 ? 5 : q >= 65 ? 4 : q >= 45 ? 3 : q >= 25 ? 2 : 1);

  const groups = opts.similar ? groupSimilar(items, opts.burstSeconds) : items.map((p) => [p]);
  const out: RankResult[] = [];
  let gid = 0;
  for (const g of groups) {
    gid++;
    // In a burst where faces were found in some frames, a frame without a detectable face (turned
    // away, motion blur) shouldn't win on focus alone: give it a below-average people score.
    if (signals.length && g.some((p) => faceCount.get(p.name))) {
      for (const p of g) {
        if (!faceCount.get(p.name)) {
          const s = base.get(p.name)!;
          for (const k of signals) s[k] = 35;
        }
      }
    }
    const ranked = [...g].sort((a, b) => quality(b.name) - quality(a.name));
    const best = ranked[0];
    const bestQ = quality(best.name);
    const bestStars = starsFor(bestQ);
    const avg: Record<string, number> = {};
    if (g.length > 1) {
      for (const k of Object.keys(base.get(best.name)!)) {
        avg[k] = Math.round(g.reduce((a, p) => a + base.get(p.name)![k], 0) / g.length);
      }
      if (opts.similar) avg.similar = Math.round(g.reduce((a, p) => a + (100 * quality(p.name)) / (bestQ || 1), 0) / g.length);
    }
    for (const p of g) {
      const q = quality(p.name);
      const scores = { ...base.get(p.name)! };
      if (opts.similar) scores.similar = g.length > 1 ? clamp((100 * q) / (bestQ || 1)) : 100;
      for (const k of Object.keys(scores)) scores[k] = Math.round(scores[k]);
      const isBest = p === best;
      const notes: string[] = [];
      if (opts.focus && (scores.focus ?? 100) < 20) notes.push('blurry');
      if (opts.exposure && (scores.exposure ?? 100) < 60) notes.push('washed out');
      if (faceCount.get(p.name) && scores.eyes !== undefined && scores.eyes < 40) notes.push('eyes closed');
      let stars = starsFor(q);
      if (g.length > 1 && !isBest) stars = Math.min(stars, Math.max(1, bestStars - 1));
      if (notes.includes('blurry') || notes.includes('washed out')) stars = Math.min(stars, 2);
      else if (notes.includes('eyes closed')) stars = Math.min(stars, 3);
      let flag: 'pick' | 'reject' | undefined;
      if (g.length > 1 && isBest && !notes.length) flag = 'pick';
      if (opts.reject && (notes.length || (g.length > 1 && !isBest))) flag = 'reject';
      out.push({
        name: p.name,
        stars,
        flag,
        scores,
        groupAvg: g.length > 1 ? avg : undefined,
        group: g.length > 1 ? { id: `g${gid}`, size: g.length, best: isBest } : undefined,
        notes,
        reason: reasonFor(scores, notes, g.length, isBest, faceCount.get(p.name) ?? 0),
      });
    }
  }
  return out;
}

function reasonFor(scores: Record<string, number>, notes: string[], size: number, best: boolean, faces: number): string {
  const bits: string[] = [];
  if (faces) {
    const who = faces === 1 ? 'the person' : faces === 2 ? 'both people' : `all ${faces} people`;
    if (notes.includes('eyes closed')) bits.push(faces === 1 ? 'eyes closed' : 'someone has their eyes closed');
    else if (scores.eyes !== undefined && scores.eyes >= 70) bits.push(faces === 1 ? 'eyes open' : `${who} have their eyes open`);
    if (scores.looking !== undefined && scores.looking >= 70) bits.push(faces === 1 ? 'looking at the camera' : 'looking at the camera');
    if (scores.smile !== undefined && scores.smile >= 60) bits.push(faces === 1 ? 'smiling' : 'smiling');
    if (scores.natural !== undefined && scores.natural < 40) bits.push('caught mid-word or frowning');
  }
  if (notes.includes('blurry')) bits.push('out of focus');
  else if (scores.focus !== undefined && scores.focus >= 70) bits.push('sharp');
  if (notes.includes('washed out')) bits.push('large blown-out areas');
  else if (scores.exposure !== undefined && scores.exposure >= 95) bits.push('no blown highlights');
  const what = bits.length ? bits.join(', ') : 'average focus and exposure';
  if (size > 1) {
    return best
      ? `Best of ${size} similar shots: ${what}.`
      : `One of ${size} similar shots; another one is better. This one: ${what}.`;
  }
  return what.charAt(0).toUpperCase() + what.slice(1) + '.';
}
