/**
 * Thin promise-based helpers on top of @homebridge/dbus-native.
 *
 * @homebridge/dbus-native speaks the D-Bus wire protocol in plain JavaScript over the
 * system bus unix socket, so nothing here needs a compiler, node-gyp or a native addon.
 */
import { EventEmitter } from 'node:events';

import dbus from '@homebridge/dbus-native';

/** A value as dbus-native marshals a variant: [signature, value]. */
export type VariantIn = [string, unknown];

/** A dictionary of variants as dbus-native unmarshals `a{sv}`: [[key, [signatureTree, [value]]], ...]. */
export type RawDict = Array<[string, unknown]>;

/** A D-Bus signal delivered on the bus. */
export interface DBusSignal {
  path: string;
  interface: string;
  member: string;
  /** Unique bus name (":1.42") of the connection that sent the signal. Set by the bus daemon, cannot be forged. */
  sender?: string;
  /** D-Bus type signature of `body`, e.g. "sa{sv}as". */
  signature: string;
  body: unknown[];
}

export class DBusError extends Error {
  constructor(public readonly dbusName: string, message: string) {
    super(message ? `${dbusName}: ${message}` : dbusName);
    this.name = 'DBusError';
  }
}

interface RawMessage {
  type: number;
  path?: string;
  interface?: string;
  member?: string;
  sender?: string;
  signature?: string;
  body?: unknown[];
}

const MESSAGE_TYPE_SIGNAL = 4;

/**
 * Convert a raw variant ([signatureTree, [value]]) into a plain JS value.
 */
export function unwrapVariant(raw: unknown): unknown {
  if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[1])) {
    return (raw[1] as unknown[])[0];
  }
  return raw;
}

/**
 * Convert a raw `a{sv}` array into a plain object.
 */
export function parseDict(raw: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!Array.isArray(raw)) {
    return result;
  }
  for (const entry of raw as RawDict) {
    if (Array.isArray(entry) && entry.length === 2) {
      result[String(entry[0])] = unwrapVariant(entry[1]);
    }
  }
  return result;
}

/**
 * A system bus connection with promise-returning method calls and a simple signal stream.
 */
export class SystemBus extends EventEmitter {
  private readonly bus: dbus.MessageBus;
  private closed = false;
  private failure?: Error;
  private readonly pendingRejects = new Set<(e: Error) => void>();

  constructor() {
    super();
    this.bus = dbus.systemBus();

    this.bus.connection.on('message', (msg: RawMessage) => {
      if (msg.type === MESSAGE_TYPE_SIGNAL && msg.path && msg.interface && msg.member) {
        const signal: DBusSignal = {
          path: msg.path,
          interface: msg.interface,
          member: msg.member,
          sender: msg.sender,
          signature: msg.signature ?? '',
          body: msg.body ?? [],
        };
        try {
          this.emit('signal', signal);
        } catch (e) {
          // Never let a bad message (from a buggy or hostile peer) take down the whole Homebridge process.
          this.emit('warning', `Ignoring D-Bus signal ${signal.interface}.${signal.member} from ${signal.sender}: ${(e as Error).message}`);
        }
      }
    });

    this.bus.connection.on('error', (err: Error) => this.fail(err));

    this.bus.connection.on('end', () => {
      if (!this.closed) {
        this.fail(new Error('D-Bus system bus connection closed'));
      }
    });
  }

  /**
   * Call a method and resolve with the first return value (or undefined for void methods).
   */
  call<T = unknown>(
    destination: string,
    path: string,
    iface: string,
    member: string,
    signature = '',
    body: unknown[] = [],
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    return new Promise<T>((resolve, reject) => {
      const call: { timer?: NodeJS.Timeout; onFailure?: (e: Error) => void } = {};
      const finish = (err: Error | undefined, value?: unknown): void => {
        if (!call.onFailure || !this.pendingRejects.delete(call.onFailure)) {
          return; // already settled
        }
        clearTimeout(call.timer);
        if (err) {
          reject(err);
        } else {
          resolve(value as T);
        }
      };
      call.onFailure = (e: Error): void => finish(e);
      this.pendingRejects.add(call.onFailure);
      call.timer = setTimeout(
        () => finish(new Error(`D-Bus call ${iface}.${member} on ${path} timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );

      const message: Record<string, unknown> = { destination, path, interface: iface, member };
      if (signature) {
        message.signature = signature;
        message.body = body;
      }

      try {
        this.bus.invoke(message, (err, value) => {
          if (err) {
            finish(new DBusError(err.name ?? 'org.freedesktop.DBus.Error.Failed', typeof err.message === 'string' ? err.message : ''));
          } else {
            finish(undefined, value);
          }
        });
      } catch (e) {
        finish(e as Error);
      }
    });
  }

  /** The connection is gone: fail every call in flight and every future call. */
  private fail(err: Error): void {
    if (!this.failure) {
      this.failure = err;
      this.emit('error', err);
    }
    for (const onFailure of [...this.pendingRejects]) {
      onFailure(err);
    }
  }

  /**
   * Ask the bus daemon to route signals matching `rule` to this connection.
   */
  addMatch(rule: string): Promise<void> {
    return this.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'AddMatch', 's', [rule]);
  }

  close(): void {
    this.closed = true;
    try {
      this.bus.connection.stream?.end();
    } catch {
      // ignore
    }
  }
}
