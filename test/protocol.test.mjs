// Protocol tests. Vectors are real-device captures published in pycasperglow's test suite (MIT).
// Run with: npm run build && npm test
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import {
  ACTION_ON, buildActionPacket, buildBrightnessBody, containsReadyMarker, decodeVarint, encodeVarint,
  extractToken, homeKitToLevel, levelToHomeKit, parseStateResponse,
} from '../dist/glow/protocol.js';

const hex = (s) => Buffer.from(s, 'hex');

test('varint round trip, including tokens above 2^32', () => {
  for (const v of [0, 1, 127, 128, 300, 900_000, 2 ** 31 + 5, 2 ** 40 + 3]) {
    assert.deepEqual(decodeVarint(encodeVarint(v)), [v, encodeVarint(v).length]);
  }
  assert.deepEqual(encodeVarint(150), hex('9601'));
  assert.throws(() => decodeVarint(hex('80')));
});

test('ready notification: marker and token', () => {
  const payload = Buffer.concat([hex('08'), encodeVarint(150), hex('100172020800')]);
  assert.ok(containsReadyMarker(payload));
  assert.equal(extractToken(payload), 150);
  assert.ok(!containsReadyMarker(hex('0801100122')));
});

test('action packet layout', () => {
  assert.deepEqual(buildActionPacket(42, ACTION_ON), hex('0801102a22041a020802'));
});

test('brightness body matches iOS app captures (15 min dimming)', () => {
  const expected = {
    60: '920106103c18a0f736',
    70: '920106104618a0f736',
    80: '920106105018a0f736',
    90: '920106105a18a0f736',
    100: '920106106418a0f736',
  };
  for (const [pct, h] of Object.entries(expected)) {
    assert.deepEqual(buildBrightnessBody(Number(pct), 900_000), hex(h));
  }
});

test('real device state notifications', () => {
  const cases = [
    ['08f091b04310011891a0e78c0122179a01140803100018002000280030003a04080010064064',
      { on: false, paused: false, dimmingRemainingMs: 0, charging: false, batteryPercent: 100 }],
    ['08c392b043100118aac89c15221b9a0118080110dbc20418a0f7362000280030003a04080310064064',
      { on: true, dimmingRemainingMs: 74075, dimmingTimeMinutes: 15, paused: false, charging: true, batteryPercent: 100 }],
    ['08f091b0431001189fb7e0cd07221b9a01180801109cba0a18a0f7362001280030003a04080010064064',
      { on: true, paused: true, dimmingTimeMinutes: 15, charging: false, batteryPercent: 100 }],
    ['08f091b043100118ecc8f8980822179a01140803100018002000280030003a04080010034064', { on: false, charging: false, batteryPercent: 25 }],
    ['08f091b043100118baf8ed800622179a01140803100018002000280030003a04080010054064', { on: false, batteryPercent: 75 }],
    ['08c392b0431001189ef1c3e80222179a01140803100018002000280030003a04080310064064', { on: false, charging: true, batteryPercent: 100 }],
  ];
  for (const [h, expected] of cases) {
    const state = parseStateResponse(hex(h));
    assert.ok(state, h);
    for (const [k, v] of Object.entries(expected)) {
      assert.equal(state[k], v, `${k} in ${h}`);
    }
  }
});

test('non-state notifications are ignored', () => {
  assert.equal(parseStateResponse(hex('082a22020803')), undefined);
  assert.equal(parseStateResponse(hex('0801100172020800')), undefined);
  assert.equal(parseStateResponse(Buffer.alloc(0)), undefined);
});

test('HomeKit brightness <-> level mapping', () => {
  assert.deepEqual([1, 20, 21, 40, 41, 60, 61, 80, 81, 100].map(homeKitToLevel), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual([0, 1, 2, 3, 4].map(levelToHomeKit), [20, 40, 60, 80, 100]);
});

test('untrusted strings are made safe to log', async () => {
  const { sanitizeForLog } = await import('../dist/glow/protocol.js');
  assert.equal(sanitizeForLog('Jar_2'), 'Jar_2');
  assert.equal(sanitizeForLog('Jar\n[Homebridge] fake line\u001b[2J'), 'Jar?[Homebridge] fake line?[2J');
  assert.equal(sanitizeForLog('x'.repeat(200)).length, 65);
  assert.equal(sanitizeForLog(undefined), '');
});

test('session tokens that are not safe integers are rejected', () => {
  const huge = Buffer.concat([hex('08'), hex('ffffffffffffff7f'), hex('72020800')]);
  assert.equal(extractToken(huge), undefined);
});
