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
  temp: number; // -100..100 (relative, as for JPEGs)
  tint: number;
  vibrance: number;
  saturation: number;
  curves: Curves;
}

export const SLIDERS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temp', 'tint', 'vibrance', 'saturation'] as const;
export type Slider = (typeof SLIDERS)[number];

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
    tint: 0,
    vibrance: 0,
    saturation: 0,
    curves: { rgb: [...IDENTITY], r: [...IDENTITY], g: [...IDENTITY], b: [...IDENTITY] },
  };
}

function isIdentity(c: CurvePoint[]): boolean {
  return c.length === 2 && c[0][0] === 0 && c[0][1] === 0 && c[1][0] === 255 && c[1][1] === 255;
}

export function isDefault(e: Edits): boolean {
  return SLIDERS.every((k) => e[k] === 0) && (['rgb', 'r', 'g', 'b'] as const).every((k) => isIdentity(e.curves[k]));
}

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
      const lim = k === 'exposure' ? 5 : 100;
      e[k] = Math.max(-lim, Math.min(lim, k === 'exposure' ? Math.round(v * 100) / 100 : Math.round(v)));
    }
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

const SLIDER_TAGS: Record<Slider, string> = {
  exposure: 'Exposure2012',
  contrast: 'Contrast2012',
  highlights: 'Highlights2012',
  shadows: 'Shadows2012',
  whites: 'Whites2012',
  blacks: 'Blacks2012',
  temp: 'IncrementalTemperature',
  tint: 'IncrementalTint',
  vibrance: 'Vibrance',
  saturation: 'Saturation',
};

const CURVE_TAGS: Record<keyof Curves, string> = {
  rgb: 'ToneCurvePV2012',
  r: 'ToneCurvePV2012Red',
  g: 'ToneCurvePV2012Green',
  b: 'ToneCurvePV2012Blue',
};

const signed = (n: number, digits = 0) => (n > 0 ? '+' : '') + n.toFixed(digits);

export function toXmp(e: Edits): string {
  const attrs = SLIDERS.map((k) => `   crs:${SLIDER_TAGS[k]}="${signed(e[k], k === 'exposure' ? 2 : 0)}"`).join('\n');
  const curves = (['rgb', 'r', 'g', 'b'] as const)
    .map(
      (k) =>
        `   <crs:${CURVE_TAGS[k]}>\n    <rdf:Seq>\n` +
        e.curves[k].map(([x, y]) => `     <rdf:li>${x}, ${y}</rdf:li>\n`).join('') +
        `    </rdf:Seq>\n   </crs:${CURVE_TAGS[k]}>`,
    )
    .join('\n');
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="vsphoto">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmlns:vsphoto="https://github.com/leonardok/vsphoto/ns/1.0/"
   vsphoto:version="1"
   crs:HasSettings="True"
${attrs}>
${curves}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

/** Reads the settings back (our own files; tolerant of attribute order and spacing). */
export function fromXmp(text: string): Edits {
  const raw: Record<string, unknown> = {};
  for (const k of SLIDERS) {
    const m = new RegExp(`crs:${SLIDER_TAGS[k]}\\s*=\\s*"([^"]*)"`).exec(text);
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
  return normalizeEdits(raw);
}

/** `<folder>/.sidecar/<name>.xmp` — the sidecar folder keeps them out of the way. */
export const SIDECAR_DIR = '.sidecar';
export function sidecarName(photoName: string): string {
  return photoName + '.xmp';
}
