// Session tests: waits for replies from the light must never outlive a failed request.
// Regression for v1.1.0, where a failed handshake write left a 10 s timer behind whose rejection
// went unhandled and restarted Homebridge ("no handshake from the light within 10s").
// Run with: npm run build && npm test
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { test } from 'node:test';

import { encodeVarint, RECONNECT_PACKET } from '../dist/glow/protocol.js';
import { CasperGlowAccessory } from '../dist/platformAccessory.js';

const { handshake, writeAndWait } = CasperGlowAccessory.prototype;
const hex = (s) => Buffer.from(s, 'hex');
const readyNotification = (token) => Buffer.concat([hex('08'), encodeVarint(token), hex('100172020800')]);

/** Just enough of an accessory for the session methods: a fake BlueZ and the listener set. */
function fakeAccessory(writeValue) {
  const writes = [];
  return {
    writes,
    notifyListeners: new Set(),
    writePath: '/org/bluez/hci0/dev_D3_5D_86_E9_5D_27/service0010/char0011',
    writeAndWait,
    bluez: {
      writeValue: async (path, data) => {
        writes.push(Buffer.from(data));
        return writeValue(data);
      },
    },
  };
}

/** Delivers a notification the way onNotification() does. */
function notify(accessory, data) {
  for (const listener of [...accessory.notifyListeners]) {
    listener(data);
  }
}

/** Records unhandled rejections for the duration of a test. */
function trackUnhandled(t) {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  return seen;
}

// Unhandled rejections are reported after the microtask queue drains; setImmediate is not mocked.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('handshake: a failed write rejects with the write error and leaves no timer behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unhandled = trackUnhandled(t);
  const glow = fakeAccessory(() => {
    throw new Error('org.bluez.Error.Failed: Not connected');
  });

  await assert.rejects(handshake.call(glow), /Not connected/);
  assert.equal(glow.notifyListeners.size, 0, 'listener removed');

  t.mock.timers.tick(60_000); // well past the 10 s handshake timeout
  await settle();
  assert.deepEqual(unhandled, [], 'no unhandled rejection after the timeout would have fired');
});

test('handshake: returns the token from the ready notification', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unhandled = trackUnhandled(t);
  const glow = fakeAccessory(() => {
    void Promise.resolve().then(() => notify(glow, readyNotification(2 ** 40 + 3)));
  });

  assert.equal(await handshake.call(glow), 2 ** 40 + 3);
  assert.deepEqual(glow.writes, [Buffer.from(RECONNECT_PACKET)]);
  assert.equal(glow.notifyListeners.size, 0, 'listener removed');

  t.mock.timers.tick(60_000);
  await settle();
  assert.deepEqual(unhandled, []);
});

test('handshake: no reply rejects with the timeout error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const glow = fakeAccessory(() => undefined);

  const result = handshake.call(glow);
  await settle(); // let the write complete
  t.mock.timers.tick(10_000);
  await assert.rejects(result, /no handshake from the light within 10s/);
  assert.equal(glow.notifyListeners.size, 0, 'listener removed');
});

test('writeAndWait: a reply that arrives before the write returns is not missed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const glow = fakeAccessory(() => notify(glow, hex('aa'))); // reply delivered synchronously during the write

  await writeAndWait.call(glow, hex('01'), (data) => data.equals(hex('aa')), 5_000);
  assert.equal(glow.notifyListeners.size, 0);
});

test('writeAndWait: non-matching notifications are ignored until the matching one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const glow = fakeAccessory(() => undefined);
  let done = false;

  const result = writeAndWait.call(glow, hex('01'), (data) => data.equals(hex('bb')), 5_000).then(() => {
    done = true;
  });
  await settle();
  notify(glow, hex('aa'));
  await settle();
  assert.equal(done, false, 'still waiting after a non-matching notification');
  notify(glow, hex('bb'));
  await result;
  assert.equal(glow.notifyListeners.size, 0);
});

test('writeAndWait: a failed write with a short timeout never becomes an unhandled rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const unhandled = trackUnhandled(t);
  const glow = fakeAccessory(() => {
    throw new Error('org.bluez.Error.Failed: le-connection-abort-by-local');
  });

  await assert.rejects(writeAndWait.call(glow, hex('01'), () => true, 5_000), /le-connection-abort-by-local/);
  t.mock.timers.tick(5_000);
  await settle();
  assert.deepEqual(unhandled, []);
  assert.equal(glow.notifyListeners.size, 0);
});
