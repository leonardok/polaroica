/**
 * Auto-Rank: turns per-photo measurements into star ratings, picks, groups of similar shots and
 * a short explanation. Pure logic, no I/O. No `vscode` import.
 */
import { Analysis, hamming } from './analyze';
import { compareNames } from './images';

export interface RankInput extends Analysis {
  name: string;
  /** Capture time in ms (EXIF), when known. */
  time?: number;
}

export interface RankOptions {
  focus: boolean;
  exposure: boolean;
  similar: boolean;
  /** Also flag the worst photos (and weaker shots of each group) as rejects. */
  reject: boolean;
  /** Max seconds between frames of one burst. */
  burstSeconds: number;
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

  const base = new Map<string, Record<string, number>>();
  for (const p of items) {
    const s: Record<string, number> = {};
    if (opts.focus) s.focus = focus(p);
    if (opts.exposure) s.exposure = exposure(p);
    base.set(p.name, s);
  }
  const quality = (name: string) => {
    const s = base.get(name)!;
    const w = { focus: 0.6, exposure: 0.4 };
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
      let stars = starsFor(q);
      if (g.length > 1 && !isBest) stars = Math.min(stars, Math.max(1, bestStars - 1));
      if (notes.length) stars = Math.min(stars, 2);
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
        reason: reasonFor(scores, notes, g.length, isBest),
      });
    }
  }
  return out;
}

function reasonFor(scores: Record<string, number>, notes: string[], size: number, best: boolean): string {
  const bits: string[] = [];
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
