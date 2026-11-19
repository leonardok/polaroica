import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { applyEdits, curveTable, matchToPreview } from '../core/develop';
import { embeddedThumbnail, mpfPreviews, readExif } from '../core/exif';
import { exportHere } from '../core/exporter';
import { assembleJpeg, buildExif, rational } from '../core/jpegFile';
import { defaultEdits } from '../core/xmp';

const importEsm = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
const root = path.join(__dirname, '..', '..', 'node_modules', '@jsquash', 'jpeg');

async function codecs() {
  (globalThis as any).ImageData ??= class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
  const enc = await importEsm(pathToFileURL(path.join(root, 'encode.js')).href);
  const dec = await importEsm(pathToFileURL(path.join(root, 'decode.js')).href);
  await enc.init(await WebAssembly.compile(fs.readFileSync(path.join(root, 'codec/enc/mozjpeg_enc.wasm'))));
  await dec.init(await WebAssembly.compile(fs.readFileSync(path.join(root, 'codec/dec/mozjpeg_dec.wasm'))));
  return { enc, dec };
}

/** A grey-ramp test picture: left dark, right bright. */
function ramp(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round((x / (w - 1)) * 255);
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const mean = (d: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += d[i];
  return s / (d.length / 4);
};

test('develop: no adjustments leave pixels alone; exposure and curves act like the photo tab', () => {
  const img = ramp(64, 4);
  const before = Uint8ClampedArray.from(img.data);
  applyEdits(img, defaultEdits());
  assert.deepEqual(img.data, before);

  // +1 EV in linear light: mid-grey 128 -> about 175 (as the shader computes it).
  const grey = { data: new Uint8ClampedArray([128, 128, 128, 255]), width: 1, height: 1 };
  applyEdits(grey, { ...defaultEdits(), exposure: 1 });
  assert.ok(Math.abs(grey.data[0] - 175) <= 1, `got ${grey.data[0]}`);

  // An identity curve is the identity; a raised mid point brightens the middle.
  const id = curveTable([
    [0, 0],
    [255, 255],
  ]);
  assert.ok(Math.abs(id[128] - 128 / 255) < 1e-6);
  const lift = { ...defaultEdits() };
  lift.curves = { ...lift.curves, rgb: [[0, 0], [128, 170], [255, 255]] };
  const g2 = { data: new Uint8ClampedArray([128, 128, 128, 255]), width: 1, height: 1 };
  applyEdits(g2, lift);
  assert.equal(g2.data[0], 170);
});

test('develop: Clarity, Dehaze, detail sliders and Color change pixels the way they should', () => {
  // A soft grey picture with a fine checker in the middle and a haze-like veil.
  const w = 48;
  const h = 48;
  const pic = () => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = 140 + ((x + y) % 2 ? 12 : -12) + Math.round((x / w) * 40);
        data[i] = v + 10;
        data[i + 1] = v;
        data[i + 2] = v + 20;
        data[i + 3] = 255;
      }
    }
    return { data, width: w, height: h };
  };
  const spread = (d: ArrayLike<number>) => {
    let s = 0;
    for (let i = 4; i < d.length; i += 4) s += Math.abs(d[i + 1] - d[i - 3]);
    return s;
  };
  const base = pic();
  const plain = spread(base.data);
  const sharp = applyEdits(pic(), { ...defaultEdits(), sharpness: 80 });
  const soft = applyEdits(pic(), { ...defaultEdits(), noise: 100 });
  assert.ok(spread(sharp.data) > plain * 1.2, 'sharpening adds pixel-to-pixel contrast');
  assert.ok(spread(soft.data) < plain * 0.8, 'noise reduction smooths it');
  const clear = applyEdits(pic(), { ...defaultEdits(), dehaze: 80 });
  assert.ok(mean(clear.data) !== mean(base.data), 'dehaze changes the picture');
  // Color: a strong blue tint makes blue the strongest channel.
  const tinted = applyEdits(pic(), { ...defaultEdits(), colorHue: 240, colorAmount: 100 });
  assert.ok(tinted.data[2] > tinted.data[0] + 20);
  // Clarity on a flat picture does nothing; nothing set leaves it alone.
  const flat = { data: new Uint8ClampedArray(16 * 16 * 4).fill(128), width: 16, height: 16 };
  applyEdits(flat, { ...defaultEdits(), clarity: 100, colorHue: 90 });
  assert.equal(flat.data[0], 128);
});

test('develop: a flat RAW decode takes on the camera preview\'s tones', () => {
  // "RAW": dark, 16-bit; "preview": the same scene, bright.
  const w = 200;
  const h = 10;
  const raw = new Uint16Array(w * h * 3);
  const prev = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      raw.fill(Math.round((x / w) * 16000), i * 3, i * 3 + 3);
      prev.fill(Math.round(60 + (x / w) * 190), i * 4, i * 4 + 3);
      prev[i * 4 + 3] = 255;
    }
  }
  const out = matchToPreview({ data: raw, width: w, height: h }, { data: prev, width: w, height: h });
  assert.ok(Math.abs(mean(out.data) - mean(prev)) < 3, `${mean(out.data)} vs ${mean(prev)}`);
  // Order is kept: brighter in the RAW stays brighter.
  assert.ok(out.data[(w - 1) * 4] > out.data[(w / 2) * 4] && out.data[(w / 2) * 4] > out.data[0]);
});

test('export JPEG: EXIF, IFD1 thumbnail and MPF preview are found by our own readers', async () => {
  const { enc, dec } = await codecs();
  const big = ramp(2400, 1600);
  const main = new Uint8Array(await enc.default(big, { quality: 85 }));
  const thumb = new Uint8Array(await enc.default(ramp(160, 107), { quality: 75 }));
  const preview = new Uint8Array(await enc.default(ramp(1600, 1067), { quality: 80 }));
  const info = { make: 'SONY', model: 'ILCE-7M3', lens: 'FE 24-105mm F4 G OSS', dateTaken: '2023:12:24 23:48:42', exposureTime: 1 / 60, fNumber: 4, iso: 1600, focalLength: 38, orientation: 6 };
  const file = assembleJpeg(main, buildExif(info, 2400, 1600, thumb), preview);

  const exif = readExif(file);
  assert.equal(exif?.make, 'SONY');
  assert.equal(exif?.lens, 'FE 24-105mm F4 G OSS');
  assert.equal(exif?.dateTaken, '2023:12:24 23:48:42');
  assert.ok(Math.abs((exif?.exposureTime ?? 0) - 1 / 60) < 1e-9);
  assert.equal(exif?.iso, 1600);
  assert.equal(exif?.orientation, 1, 'pixels are written upright');
  assert.equal(exif?.width, 2400);

  const t = embeddedThumbnail(file)!;
  assert.deepEqual([...file.subarray(t.offset, t.offset + t.length)], [...thumb]);
  const [p] = mpfPreviews(file.subarray(0, 64 * 1024));
  assert.deepEqual([...file.subarray(p.offset, p.offset + p.length)], [...preview]);
  assert.equal(p.offset + p.length, file.length, 'the preview is stored after the main image');

  // Still a valid JPEG of the full image.
  const back = await dec.default(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  assert.equal(back.width, 2400);
  assert.deepEqual(rational(1 / 60), [1, 60]);
  assert.deepEqual(rational(4), [4, 1]);
  assert.deepEqual(rational(5.6), [28, 5]);
});

test('export: a JPEG is rotated upright, adjusted, resized, and written with its preview', async () => {
  const { enc, dec } = await codecs();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsphoto-export-'));
  try {
    // A 3000×2000 ramp whose EXIF says "rotate 90° clockwise" (orientation 6).
    const main = new Uint8Array(await enc.default(ramp(3000, 2000), { quality: 90 }));
    const src = path.join(dir, 'IMG_1.jpg');
    fs.writeFileSync(src, assembleJpeg(main, buildExif({ make: 'Test' }, 3000, 2000, undefined, 6)));

    const plain = await exportHere(src, path.join(dir, 'plain.jpg'), { quality: 90 });
    assert.equal(plain.width, 2000);
    assert.equal(plain.height, 3000);
    const brighter = await exportHere(src, path.join(dir, 'bright.jpg'), { quality: 90, maxSide: 1500, edits: { ...defaultEdits(), exposure: 1 } });
    assert.equal(Math.max(brighter.width, brighter.height), 1500);

    const read = async (f: string) => {
      const b = fs.readFileSync(path.join(dir, f));
      return dec.default(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    };
    assert.ok(mean((await read('bright.jpg')).data) > mean((await read('plain.jpg')).data) + 20, 'exposure was applied');
    const out = new Uint8Array(fs.readFileSync(path.join(dir, 'plain.jpg')));
    assert.equal(readExif(out)?.make, 'Test');
    assert.equal(mpfPreviews(out.subarray(0, 64 * 1024)).length, 1, 'a preview for quick browsing');
    assert.ok(embeddedThumbnail(out));
    assert.ok(!fs.existsSync(path.join(dir, 'plain.jpg.partial')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
