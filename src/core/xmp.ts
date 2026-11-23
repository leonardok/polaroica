/**
 * Photo edits and their sidecar file. Edits are non-destructive: the photo is never changed; the
 * settings live in `<folder>/.sidecar/<photo file name>.xmp`. The XMP uses Adobe Camera Raw
 * (`crs:`) names where they mean the same thing, so the values are recognisable elsewhere, but no
 * other program is expected to pick these files up. No `vscode` import.
 */

export type CurvePoint = [number, number]; // 0–255 in, 0–255 out

export interface Curves {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

export interface Edits {
  exposure: number; // EV, -5..5
  contrast: number; // -100..100
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temp: number; // -100..100, relative (older edits; the photo tab now sets `kelvin`)
  /** White balance in Kelvin (0 = as shot), relative to `kelvinRef`. */
  kelvin: number;
  /** The photo's own temperature the edit was made against: as shot (RAW) or estimated (JPEG). */
  kelvinRef: number;
  tint: number;
  vibrance: number;
  saturation: number;
  clarity: number; // -100..100, local contrast
  dehaze: number; // -100..100
  sharpness: number; // -100..100 (below 0 softens)
  noise: number; // 0..100, luminance noise reduction
  moire: number; // 0..100, colour moiré / colour noise
  defringe: number; // 0..100, purple / green fringes at edges
  colorHue: number; // 0..359, the Color tint's hue
  colorAmount: number; // 0..100, how strongly the Color tint is laid over the picture
  curves: Curves;
}

export const SLIDERS = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temp',
  'tint',
  'vibrance',
  'saturation',
  'clarity',
  'dehaze',
  'sharpness',
  'noise',
  'moire',
  'defringe',
  'colorHue',
  'colorAmount',
] as const;
export type Slider = (typeof SLIDERS)[number];

/** Each slider's range: most are -100..100. */
export const SLIDER_RANGE: Partial<Record<Slider, [number, number]>> = {
  exposure: [-5, 5],
  noise: [0, 100],
  moire: [0, 100],
  defringe: [0, 100],
  colorHue: [0, 359],
  colorAmount: [0, 100],
};

const IDENTITY: CurvePoint[] = [
  [0, 0],
  [255, 255],
];

export function defaultEdits(): Edits {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temp: 0,
    kelvin: 0,
    kelvinRef: 0,
    tint: 0,
    vibrance: 0,
    saturation: 0,
    clarity: 0,
    dehaze: 0,
    sharpness: 0,
    noise: 0,
    moire: 0,
    defringe: 0,
    colorHue: 0,
    colorAmount: 0,
    curves: { rgb: [...IDENTITY], r: [...IDENTITY], g: [...IDENTITY], b: [...IDENTITY] },
  };
}

function isIdentity(c: CurvePoint[]): boolean {
  return c.length === 2 && c[0][0] === 0 && c[0][1] === 0 && c[1][0] === 255 && c[1][1] === 255;
}

export function isDefault(e: Edits): boolean {
  // The Color tint's hue does nothing while its amount is 0.
  return SLIDERS.every((k) => k === 'colorHue' || e[k] === 0) && !hasKelvin(e) && (['rgb', 'r', 'g', 'b'] as const).every((k) => isIdentity(e.curves[k]));
}

/** A Kelvin white balance that differs from the photo's own. */
export function hasKelvin(e: Pick<Edits, 'kelvin' | 'kelvinRef'>): boolean {
  return e.kelvin > 0 && e.kelvinRef > 0 && e.kelvin !== e.kelvinRef;
}

const kelvinOf = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1000 ? Math.round(Math.min(50000, n) / 10) * 10 : 0;
};

/** Clamps and fills in whatever came from a file or a webview message. */
export function normalizeEdits(raw: unknown): Edits {
  const e = defaultEdits();
  if (!raw || typeof raw !== 'object') {
    return e;
  }
  const r = raw as Record<string, unknown>;
  for (const k of SLIDERS) {
    const v = Number(r[k]);
    if (Number.isFinite(v)) {
      const [lo, hi] = SLIDER_RANGE[k] ?? [-100, 100];
      e[k] = Math.max(lo, Math.min(hi, k === 'exposure' ? Math.round(v * 100) / 100 : Math.round(v)));
    }
  }
  e.kelvin = kelvinOf(r.kelvin);
  e.kelvinRef = kelvinOf(r.kelvinRef);
  if (!e.kelvin || !e.kelvinRef) {
    e.kelvin = 0;
    e.kelvinRef = 0;
  }
  const curves = r.curves as Record<string, unknown> | undefined;
  for (const k of ['rgb', 'r', 'g', 'b'] as const) {
    const pts = curves?.[k];
    if (Array.isArray(pts) && pts.length >= 2) {
      const clean = pts
        .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(Number(n))))
        .map(([x, y]) => [clamp255(x), clamp255(y)] as CurvePoint)
        .sort((a, b) => a[0] - b[0])
        .filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0]);
      if (clean.length >= 2 && clean.length <= 16) {
        e.curves[k] = clean;
      }
    }
  }
  return e;
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(Number(n))));
}

// Camera Raw names where the slider means the same thing; our own otherwise (Camera Raw's
// Sharpness is 0–150 and Moiré / Defringe / Color only exist there as local adjustments).
const SLIDER_TAGS: Record<Slider, string> = {
  exposure: 'crs:Exposure2012',
  contrast: 'crs:Contrast2012',
  highlights: 'crs:Highlights2012',
  shadows: 'crs:Shadows2012',
  whites: 'crs:Whites2012',
  blacks: 'crs:Blacks2012',
  temp: 'crs:IncrementalTemperature',
  tint: 'crs:IncrementalTint',
  vibrance: 'crs:Vibrance',
  saturation: 'crs:Saturation',
  clarity: 'crs:Clarity2012',
  dehaze: 'crs:Dehaze',
  sharpness: 'polaroica:Sharpness',
  noise: 'crs:LuminanceSmoothing',
  moire: 'polaroica:Moire',
  defringe: 'polaroica:Defringe',
  colorHue: 'polaroica:ColorHue',
  colorAmount: 'polaroica:ColorAmount',
};

const CURVE_TAGS: Record<keyof Curves, string> = {
  rgb: 'ToneCurvePV2012',
  r: 'ToneCurvePV2012Red',
  g: 'ToneCurvePV2012Green',
  b: 'ToneCurvePV2012Blue',
};

const signed = (n: number, digits = 0) => (n > 0 ? '+' : '') + n.toFixed(digits);

// ---- culling ----------------------------------------------------------------------------

export type Flag = 'pick' | 'reject';

/** Scores 0–100 behind an Auto-Rank rating, plus how the photo did in its group of similar shots. */
export interface AutoRank {
  scores: Record<string, number>; // e.g. { focus: 86, exposure: 96, similar: 100 }
  groupAvg?: Record<string, number>; // same keys: average of its similar shots
  group?: { id: string; size: number; best: boolean; kept?: boolean };
  notes?: string[]; // "blurry", "washed out"
  reason?: string; // one line for people
  at: string; // ISO time of the run
}

/** Everything the sidecar holds for one photo. */
export interface Sidecar {
  edits: Edits;
  rating: number; // 0–5 stars
  flag?: Flag;
  /** Set when the rating/flag came from Auto-Rank (cleared when you rate yourself). */
  auto?: AutoRank;
  /**
   * Keywords, as `dc:subject` — the standard field, so other photo programs read them. Order is
   * kept as written; comparison is case-insensitive (see `normalizeTags`).
   */
  tags?: string[];
  /**
   * Which of `tags` a scan wrote rather than a person. A later scan may drop these, but never a
   * tag added by hand. The same idea as `auto` for ratings.
   */
  autoTags?: string[];
}

export function emptySidecar(): Sidecar {
  return { edits: defaultEdits(), rating: 0 };
}

export function isEmptySidecar(s: Sidecar): boolean {
  return isDefault(s.edits) && !s.rating && !s.flag && !s.auto && !s.tags?.length;
}

/** Trims, drops blanks, and removes repeats (case-insensitively), keeping the order given. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().replace(/\s+/g, ' ');
    const k = t.toLowerCase();
    if (t && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/** True when the two name the same tag (tags are matched without regard to case). */
export function sameTag(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

const escapeAttr = (t: string) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeAttr = (t: string) => t.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeText = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeText = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function toXmp(input: Edits | Sidecar): string {
  const sc: Sidecar = 'edits' in input ? input : { ...emptySidecar(), edits: input };
  const e = sc.edits;
  const attrs = [
    ...SLIDERS.map((k) => `   ${SLIDER_TAGS[k]}="${signed(e[k], k === 'exposure' ? 2 : 0)}"`),
    // Kelvin, as Camera Raw writes it, plus the temperature it was set against.
    ...(hasKelvin(e) ? [`   crs:Temperature="${e.kelvin}"`, `   polaroica:TemperatureRef="${e.kelvinRef}"`] : []),
  ].join('\n');
  const tags = normalizeTags(sc.tags ?? []);
  const autoTags = normalizeTags(sc.autoTags ?? []).filter((t) => tags.some((x) => sameTag(x, t)));
  const culling = [
    `   xmp:Rating="${sc.rating}"`,
    sc.flag ? `   polaroica:Flag="${sc.flag}"` : '',
    sc.auto ? `   polaroica:AutoRank="${escapeAttr(JSON.stringify(sc.auto))}"` : '',
    autoTags.length ? `   polaroica:AutoTags="${escapeAttr(JSON.stringify(autoTags))}"` : '',
  ]
    .filter(Boolean)
    .join('\n');
  // Keywords as an unordered dc:subject bag, the shape every XMP reader expects.
  const subject = tags.length
    ? `   <dc:subject>\n    <rdf:Bag>\n` +
      tags.map((t) => `     <rdf:li>${escapeText(t)}</rdf:li>\n`).join('') +
      `    </rdf:Bag>\n   </dc:subject>\n`
    : '';
  const curves = (['rgb', 'r', 'g', 'b'] as const)
    .map(
      (k) =>
        `   <crs:${CURVE_TAGS[k]}>\n    <rdf:Seq>\n` +
        e.curves[k].map(([x, y]) => `     <rdf:li>${x}, ${y}</rdf:li>\n`).join('') +
        `    </rdf:Seq>\n   </crs:${CURVE_TAGS[k]}>`,
    )
    .join('\n');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="polaroica">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:polaroica="https://github.com/leonardok/polaroica/ns/1.0/"
   polaroica:version="1"
   crs:HasSettings="True"
${culling}
${attrs}>
${subject}${curves}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

/** Edits only (kept for callers that don't care about culling). */
export function fromXmp(text: string): Edits {
  return readSidecar(text).edits;
}

/** Reads a sidecar back (our own files; tolerant of attribute order and spacing). */
export function readSidecar(text: string): Sidecar {
  const raw: Record<string, unknown> = {};
  for (const k of SLIDERS) {
    const m = new RegExp(`${SLIDER_TAGS[k]}\\s*=\\s*"([^"]*)"`).exec(text);
    if (m) {
      raw[k] = parseFloat(m[1]);
    }
  }
  const curves: Record<string, CurvePoint[]> = {};
  for (const k of ['rgb', 'r', 'g', 'b'] as const) {
    const m = new RegExp(`<crs:${CURVE_TAGS[k]}>([\\s\\S]*?)</crs:${CURVE_TAGS[k]}>`).exec(text);
    if (m) {
      curves[k] = [...m[1].matchAll(/<rdf:li>\s*(\d+)\s*,\s*(\d+)\s*<\/rdf:li>/g)].map((x) => [Number(x[1]), Number(x[2])]);
    }
  }
  raw.curves = curves;
  const kelvin = /crs:Temperature\s*=\s*"(\d+)"/.exec(text);
  const ref = /(?:polaroica|vsphoto):TemperatureRef\s*=\s*"(\d+)"/.exec(text);
  if (kelvin && ref) {
    raw.kelvin = Number(kelvin[1]);
    raw.kelvinRef = Number(ref[1]);
  }
  const sc: Sidecar = { edits: normalizeEdits(raw), rating: 0 };
  const rating = /xmp:Rating\s*=\s*"(-?\d+)"/.exec(text);
  if (rating) {
    sc.rating = Math.max(0, Math.min(5, Number(rating[1])));
  }
  const flag = /(?:polaroica|vsphoto):Flag\s*=\s*"(pick|reject)"/.exec(text);
  if (flag) {
    sc.flag = flag[1] as Flag;
  }
  const auto = /(?:polaroica|vsphoto):AutoRank\s*=\s*"([^"]*)"/.exec(text);
  if (auto) {
    try {
      sc.auto = JSON.parse(unescapeAttr(auto[1])) as AutoRank;
    } catch {
      /* ignore a damaged value */
    }
  }
  const tags = readTags(text);
  if (tags.length) {
    sc.tags = tags;
    const autoTags = /(?:polaroica|vsphoto):AutoTags\s*=\s*"([^"]*)"/.exec(text);
    if (autoTags) {
      try {
        const parsed = JSON.parse(unescapeAttr(autoTags[1])) as unknown;
        if (Array.isArray(parsed)) {
          const kept = normalizeTags(parsed.filter((t): t is string => typeof t === 'string')).filter((t) =>
            tags.some((x) => sameTag(x, t)),
          );
          if (kept.length) {
            sc.autoTags = kept;
          }
        }
      } catch {
        /* ignore a damaged value */
      }
    }
  }
  return sc;
}

/**
 * Keywords from a sidecar: the `dc:subject` bag we write, or — for files written elsewhere — a
 * `dc:subject` attribute holding a separated list.
 */
function readTags(text: string): string[] {
  const bag = /<dc:subject>([\s\S]*?)<\/dc:subject>/.exec(text);
  if (bag) {
    return normalizeTags([...bag[1].matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((m) => unescapeText(m[1].trim())));
  }
  const attr = /dc:subject\s*=\s*"([^"]*)"/.exec(text);
  if (attr) {
    return normalizeTags(unescapeAttr(attr[1]).split(/[;,]/));
  }
  return [];
}

/** `<folder>/.sidecar/<name>.xmp` — the sidecar folder keeps them out of the way. */
export const SIDECAR_DIR = '.sidecar';
export function sidecarName(photoName: string): string {
  return photoName + '.xmp';
}
