/**
 * Casper Glow BLE protocol (pure logic, no I/O).
 *
 * Ported from pycasperglow (MIT License, Copyright (c) 2026 pycasperglow contributors),
 * https://github.com/mikeodr/pycasperglow, which documents the protocol from iOS app captures.
 *
 * Messages are protobuf-like: a sequence of (tag varint, value) pairs where tag = field << 3 | wireType,
 * wire type 0 = varint, wire type 2 = length-delimited bytes.
 *
 * Session flow:
 *   1. Subscribe to notifications on READ characteristic (9bb30003).
 *   2. Write RECONNECT_PACKET to WRITE characteristic (9bb30002).
 *   3. The light notifies a payload containing READY_MARKER; field 1 of that payload is a session token.
 *   4. Commands are written as { 1: 1, 2: token, 4: actionBody }.
 */

export const GLOW_SERVICE_UUID = '9bb30001-fee9-4c24-8361-443b5b7c88f6';
export const GLOW_WRITE_UUID = '9bb30002-fee9-4c24-8361-443b5b7c88f6';
export const GLOW_READ_UUID = '9bb30003-fee9-4c24-8361-443b5b7c88f6';

/** Casper Glow lights advertise a local name starting with this prefix (e.g. "Jar", "Jar_2"). */
export const GLOW_NAME_PREFIX = 'Jar';

export const RECONNECT_PACKET = Buffer.from('080122026a00', 'hex');
export const READY_MARKER = Buffer.from('72020800', 'hex');

export const ACTION_ON = Buffer.from('1a020802', 'hex');
export const ACTION_OFF = Buffer.from('1a020804', 'hex');
export const ACTION_PAUSE = Buffer.from('1a020805', 'hex');
export const ACTION_RESUME = Buffer.from('1a020806', 'hex');
export const QUERY_STATE = Buffer.from('52020803', 'hex');

/** Brightness percentages the Casper app offers (levels 1–5). */
export const BRIGHTNESS_LEVELS = [60, 70, 80, 90, 100] as const;

/** Dimming durations (minutes) the Casper app offers. */
export const DIMMING_TIME_MINUTES = [15, 30, 45, 60, 90] as const;

const STATE_RESPONSE_FIELD = 19;
const BRIGHTNESS_FIELD = 18;

export type FieldValue = number | Buffer;
export type Fields = Map<number, FieldValue[]>;

/** Decode a varint at `start`. Returns [value, nextOffset]. Throws on truncation. Safe up to 2^53. */
export function decodeVarint(data: Buffer, start = 0): [number, number] {
  let result = 0;
  let multiplier = 1;
  let pos = start;
  while (pos < data.length) {
    const byte = data[pos++];
    result += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return [result, pos];
    }
    multiplier *= 128;
    if (multiplier > 2 ** 56) {
      throw new Error('Varint too long');
    }
  }
  throw new Error('Truncated varint');
}

export function encodeVarint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Cannot encode ${value} as varint`);
  }
  const bytes: number[] = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

/** Parse a protobuf-like payload. Stops (returning what it has) at the first malformed or unsupported field. */
export function parseFields(data: Buffer): Fields {
  const fields: Fields = new Map();
  let pos = 0;
  while (pos < data.length) {
    let tag: number;
    try {
      [tag, pos] = decodeVarint(data, pos);
    } catch {
      return fields;
    }
    const field = Math.floor(tag / 8);
    const wireType = tag % 8;
    let value: FieldValue;
    try {
      if (wireType === 0) {
        [value, pos] = decodeVarint(data, pos);
      } else if (wireType === 2) {
        let length: number;
        [length, pos] = decodeVarint(data, pos);
        if (pos + length > data.length) {
          return fields;
        }
        value = data.subarray(pos, pos + length);
        pos += length;
      } else {
        return fields;
      }
    } catch {
      return fields;
    }
    const list = fields.get(field);
    if (list) {
      list.push(value);
    } else {
      fields.set(field, [value]);
    }
  }
  return fields;
}

function firstInt(fields: Fields, field: number): number | undefined {
  const v = fields.get(field)?.[0];
  return typeof v === 'number' ? v : undefined;
}

function lastBytes(fields: Fields, field: number): Buffer | undefined {
  const list = fields.get(field);
  const v = list?.[list.length - 1];
  return Buffer.isBuffer(v) ? v : undefined;
}

export function containsReadyMarker(payload: Buffer): boolean {
  return payload.includes(READY_MARKER);
}

/** The session token is field 1 (varint) of the ready notification. Tokens that are not safe integers are rejected. */
export function extractToken(payload: Buffer): number | undefined {
  const token = firstInt(parseFields(payload), 1);
  return token !== undefined && Number.isSafeInteger(token) ? token : undefined;
}

/** ATT attribute values are at most 512 bytes; anything larger did not come from a real light. */
export const MAX_NOTIFICATION_LENGTH = 512;

/**
 * Make an untrusted string (e.g. a BLE advertised name) safe to log: printable characters only, bounded length.
 */
export function sanitizeForLog(value: unknown, maxLength = 64): string {
  const cleaned = String(value ?? '').replace(/[^\x20-\x7e]/g, '?');
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

/** Build { 1: 1, 2: token, 4: body }. */
export function buildActionPacket(token: number, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0x08, 0x01, 0x10]),
    encodeVarint(token),
    Buffer.from([0x22]),
    encodeVarint(body.length),
    body,
  ]);
}

/** Build the field-18 body that sets brightness (60–100 %) together with the dimming duration. */
export function buildBrightnessBody(brightnessPct: number, dimmingTimeMs: number): Buffer {
  const inner = Buffer.concat([Buffer.from([0x10]), encodeVarint(brightnessPct), Buffer.from([0x18]), encodeVarint(dimmingTimeMs)]);
  return Buffer.concat([encodeVarint(BRIGHTNESS_FIELD * 8 + 2), encodeVarint(inner.length), inner]);
}

/** Battery levels the light reports (state sub-field 7, inner field 2). */
const BATTERY_PERCENT: Record<number, number> = { 3: 25, 4: 50, 5: 75, 6: 100 };

export interface GlowState {
  on?: boolean;
  /** Remaining dimming time in ms (0 when off). */
  dimmingRemainingMs?: number;
  /** Configured dimming duration in minutes (only reported while on). */
  dimmingTimeMinutes?: number;
  paused?: boolean;
  charging?: boolean;
  /** Approximate battery percentage: 25, 50, 75 or 100. */
  batteryPercent?: number;
}

/**
 * Decode a state response: field 4 (body) → field 19 → sub-fields.
 * Returns undefined when the notification is not a state response.
 */
export function parseStateResponse(notification: Buffer): GlowState | undefined {
  const body = lastBytes(parseFields(notification), 4);
  if (!body) {
    return undefined;
  }
  const stateBytes = lastBytes(parseFields(body), STATE_RESPONSE_FIELD);
  if (!stateBytes) {
    return undefined;
  }
  const sf = parseFields(stateBytes);
  const state: GlowState = {};

  const mode = firstInt(sf, 1); // 1 = on, 3 = off
  if (mode !== undefined) {
    state.on = mode === 1;
    if (!state.on) {
      state.paused = false;
      state.dimmingRemainingMs = 0;
    }
  }

  const remaining = firstInt(sf, 2);
  if (remaining !== undefined && state.on !== false) {
    state.dimmingRemainingMs = remaining;
  }

  const total = firstInt(sf, 3);
  if (total !== undefined && total > 0) {
    state.dimmingTimeMinutes = Math.floor(total / 60_000);
  }

  const paused = firstInt(sf, 4);
  if (paused !== undefined && state.on !== false) {
    state.paused = paused !== 0;
  }

  const battery = lastBytes(sf, 7);
  if (battery) {
    const inner = parseFields(battery);
    const charging = firstInt(inner, 1);
    if (charging !== undefined) {
      state.charging = charging !== 0;
    }
    const level = firstInt(inner, 2);
    if (level !== undefined && BATTERY_PERCENT[level] !== undefined) {
      state.batteryPercent = BATTERY_PERCENT[level];
    }
  }

  return state;
}

/**
 * Map a HomeKit brightness (1–100) onto one of the five levels: 1–20 → 60 %, 21–40 → 70 %, … 81–100 → 100 %.
 * Returns the level index (0–4).
 */
export function homeKitToLevel(value: number): number {
  return Math.min(4, Math.max(0, Math.ceil(value / 20) - 1));
}

/** HomeKit brightness used to display a level: 20, 40, 60, 80, 100. */
export function levelToHomeKit(level: number): number {
  return (level + 1) * 20;
}
