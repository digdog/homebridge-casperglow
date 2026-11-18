// Dimming time: config.json wins over what the light reports, and turning a light on applies it.
// Run with: npm run build && npm test
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import { test } from 'node:test';

import { ACTION_ON, buildActionPacket, buildBrightnessBody } from '../dist/glow/protocol.js';
import { CasperGlowAccessory } from '../dist/platformAccessory.js';

const TOKEN = 7;
const packet = (body) => buildActionPacket(TOKEN, body);

/** An accessory with a fake session that records the packets each flush writes. */
function fakeGlow({ configured, reported, level = 2, failWrites = false } = {}) {
  const glow = Object.create(CasperGlowAccessory.prototype);
  const writes = [];
  const logs = { warn: [], error: [] };
  const attempts = { count: 0 };
  Object.assign(glow, {
    name: 'Glow',
    context: { brightnessLevel: level, dimmingTime: reported },
    pending: new Map(),
    flushing: false,
    dimmingFixSent: false,
    dimmingFixWarned: false,
    writePath: '/char',
    lightbulb: { updateCharacteristic: () => undefined },
    platform: {
      config: configured === undefined ? {} : { dimmingTime: configured },
      log: { debug: () => undefined, warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) },
      Characteristic: { On: 'On' },
      api: { hap: { HapStatusError: Error, HAPStatus: {} }, updatePlatformAccessories: () => undefined },
    },
    bluez: {
      writeValue: async (path, data) => {
        attempts.count++;
        if (failWrites) {
          throw new Error('org.bluez.Error.Failed: Not connected');
        }
        writes.push(Buffer.from(data));
      },
    },
    session: async (work) => work(TOKEN),
  });
  return { glow, writes, logs, attempts };
}

/** Waits until the flush started by enqueue() (or a new one) has finished. */
const flushed = async (glow) => {
  await glow.flush();
  while (glow.flushing) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test('config dimmingTime wins over the value the light reported', () => {
  const { glow } = fakeGlow({ configured: 60, reported: 15 });
  assert.equal(glow.dimmingMinutes, 60);
});

test('without config, the reported value is used, then the 15 min default', () => {
  assert.equal(fakeGlow({ reported: 30 }).glow.dimmingMinutes, 30);
  assert.equal(fakeGlow({}).glow.dimmingMinutes, 15);
  assert.equal(fakeGlow({ configured: 'abc', reported: 45 }).glow.dimmingMinutes, 45, 'invalid config ignored');
  assert.equal(fakeGlow({ configured: 20, reported: 45 }).glow.dimmingMinutes, 45, 'unsupported value ignored');
});

test('turning on a light with a different dimming time also sends brightness with the configured time', async () => {
  const { glow, writes } = fakeGlow({ configured: 60, reported: 15, level: 2 });
  glow.pending.set('power', 1);
  await flushed(glow);
  assert.deepEqual(writes, [packet(ACTION_ON), packet(buildBrightnessBody(80, 60 * 60_000))]);
});

test('turning on a light that already uses the configured time sends only ON', async () => {
  const { glow, writes } = fakeGlow({ configured: 60, reported: 60 });
  glow.pending.set('power', 1);
  await flushed(glow);
  assert.deepEqual(writes, [packet(ACTION_ON)]);
});

test('without config, turning on sends only ON', async () => {
  const { glow, writes } = fakeGlow({ reported: 15 });
  glow.pending.set('power', 1);
  await flushed(glow);
  assert.deepEqual(writes, [packet(ACTION_ON)]);
});

test('a poll reporting a different dimming time sends the configured one once, then warns once', async () => {
  const { glow, writes, logs } = fakeGlow({ configured: 60, reported: 15, level: 4 });
  glow.checkDimmingTime(15);
  await flushed(glow);
  assert.deepEqual(writes, [packet(buildBrightnessBody(100, 60 * 60_000))]);

  // The light ignored it: no retry loop, one warning.
  glow.checkDimmingTime(15);
  glow.checkDimmingTime(15);
  await flushed(glow);
  assert.equal(writes.length, 1);
  assert.equal(logs.warn.length, 1);

  // Once it reports the configured value, a later change (e.g. in the Casper app) is corrected again.
  glow.checkDimmingTime(60);
  glow.context.dimmingTime = 30;
  glow.checkDimmingTime(30);
  await flushed(glow);
  assert.equal(writes.length, 2);
});

test('a failed send is retried on the next mismatch instead of warning', async () => {
  const { glow, logs, attempts } = fakeGlow({ configured: 60, reported: 15, failWrites: true });
  glow.checkDimmingTime(15);
  await flushed(glow);
  assert.equal(attempts.count, 1);
  assert.equal(glow.dimmingFixSent, false);
  glow.checkDimmingTime(15);
  await flushed(glow);
  assert.equal(attempts.count, 2, 'retried');
  assert.equal(logs.warn.length, 0);
});
