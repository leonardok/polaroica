import assert from 'node:assert/strict';
import { test } from 'node:test';
import { whiteBalanceGains } from '../core/develop';
import { asShotKelvin, kelvinGains, kelvinOfRgb, whiteRgb } from '../core/whiteBalance';
import { defaultEdits, fromXmp, isDefault, normalizeEdits, toXmp } from '../core/xmp';

test('6500 K light is about neutral in linear sRGB (the black-body line passes just under D65)', () => {
  const [r, g, b] = whiteRgb(6504);
  assert.ok(Math.abs(r / b - 1) < 0.03 && Math.abs(r / g - 1) < 0.06, `${r} ${g} ${b}`);
});

test('a higher Kelvin setting warms the picture, a lower one cools it', () => {
  const warm = kelvinGains(5000, 6500);
  assert.ok(warm[0] > warm[2], 'more red than blue');
  const cool = kelvinGains(5000, 3500);
  assert.ok(cool[2] > cool[0], 'more blue than red');
  const same = kelvinGains(4200, 4200);
  same.forEach((v) => assert.ok(Math.abs(v - 1) < 1e-9));
});

test('the temperature of a light is found back from its colour', () => {
  for (const k of [2800, 4000, 5500, 7500]) {
    const [r, , b] = whiteRgb(k);
    assert.ok(Math.abs(kelvinOfRgb(r, b) - k) <= 30, `${k} -> ${kelvinOfRgb(r, b)}`);
  }
});

test('as-shot Kelvin from LibRaw colour data (Sony A7 III, indoor)', () => {
  const color = {
    cam_mul: [1712, 1024, 2588, 1024],
    cam_xyz: [
      [0.7374, -0.2389, -0.0551],
      [-0.5435, 1.3162, 0.2519],
      [-0.1006, 0.1795, 0.6552],
      [0, 0, 0],
    ],
  };
  const k = asShotKelvin(color);
  assert.ok(k !== undefined && k > 3000 && k < 3500, String(k));
  assert.equal(asShotKelvin({ cam_mul: [0, 0, 0], cam_xyz: color.cam_xyz }), undefined);
  assert.equal(asShotKelvin(undefined), undefined);
});

test('Kelvin white balance round-trips through the sidecar', () => {
  const e = defaultEdits();
  e.kelvin = 4500;
  e.kelvinRef = 3220;
  const xml = toXmp(e);
  assert.match(xml, /crs:Temperature="4500"/);
  assert.match(xml, /polaroica:TemperatureRef="3220"/);
  assert.deepEqual(fromXmp(xml), e);
  assert.ok(!isDefault(e));
  // As shot (same as the reference) is no edit at all.
  assert.ok(isDefault(normalizeEdits({ kelvin: 3220, kelvinRef: 3220 })));
  assert.doesNotMatch(toXmp(defaultEdits()), /crs:Temperature=/);
});

test('export white balance matches the edit', () => {
  const e = defaultEdits();
  assert.deepEqual(whiteBalanceGains(e), [1, 1, 1]);
  e.kelvin = 6500;
  e.kelvinRef = 5000;
  const g = whiteBalanceGains(e);
  assert.ok(g[0] > 1 && g[2] < 1, String(g));
});
