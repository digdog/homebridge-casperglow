/**
 * Minimal BlueZ (Linux Bluetooth stack) client over D-Bus.
 *
 * Only the pieces a BLE central needs are implemented: adapter discovery, device connection,
 * GATT characteristic lookup, read / write / notify. BlueZ does all the radio work; this
 * module just talks to bluetoothd through its documented D-Bus API:
 *   https://git.kernel.org/pub/scm/bluetooth/bluez.git/tree/doc
 */
import { EventEmitter } from 'node:events';

import { DBusError, parseDict, SystemBus } from './dbus.js';
import type { DBusSignal } from './dbus.js';

const BLUEZ = 'org.bluez';
const DBUS_DAEMON = 'org.freedesktop.DBus';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
export const ADAPTER_IFACE = 'org.bluez.Adapter1';
export const DEVICE_IFACE = 'org.bluez.Device1';
export const GATT_CHARACTERISTIC_IFACE = 'org.bluez.GattCharacteristic1';

type Props = Record<string, unknown>;

/** D-Bus signatures of the signals we consume (see BlueZ / freedesktop ObjectManager docs). */
const EXPECTED_SIGNATURES: Record<string, string> = {
  [`${OBJECT_MANAGER}.InterfacesAdded`]: 'oa{sa{sv}}',
  [`${OBJECT_MANAGER}.InterfacesRemoved`]: 'oas',
  [`${PROPERTIES}.PropertiesChanged`]: 'sa{sv}as',
};
type ObjectInterfaces = Map<string, Props>;

export interface BlueZLogger {
  debug(message: string, ...parameters: unknown[]): void;
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
}

export interface PropertiesChangedEvent {
  path: string;
  iface: string;
  changed: Props;
  invalidated: string[];
}

/** Normalise a MAC address to upper case, colon separated: AA:BB:CC:DD:EE:FF. */
export function normalizeAddress(address: string): string {
  const hex = address.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) {
    throw new Error(`Invalid Bluetooth address: ${address}`);
  }
  return hex.match(/.{2}/g)!.join(':');
}

/** Expand a 128-bit UUID written without dashes into BlueZ's canonical lower-case dashed form. */
export function normalizeUuid(uuid: string): string {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (hex.length !== 32) {
    return uuid.toLowerCase();
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return Buffer.from(value as number[]);
  }
  return Buffer.alloc(0);
}

export class BlueZ extends EventEmitter {
  private bus?: SystemBus;
  private readonly objects = new Map<string, ObjectInterfaces>();
  private adapter?: string;
  private discoveryUsers = 0;
  private discoveryActive = false;
  /**
   * Unique bus name of the bluetoothd connection that currently owns "org.bluez".
   * Any local process may send signals to us, so only signals from this sender are trusted.
   */
  private bluezOwner?: string;

  constructor(
    private readonly log: BlueZLogger,
    private readonly adapterName?: string,
  ) {
    super();
    this.setMaxListeners(100);
  }

  get adapterPath(): string {
    if (!this.adapter) {
      throw new Error('BlueZ client has not been started');
    }
    return this.adapter;
  }

  /**
   * Connect to the system bus, subscribe to BlueZ signals and pick an adapter.
   */
  async start(): Promise<void> {
    const bus = new SystemBus();
    this.bus = bus;

    bus.on('error', (err: Error) => this.emit('error', err));
    bus.on('warning', (message: string) => this.log.warn(message));
    bus.on('signal', (signal: DBusSignal) => this.onSignal(signal));

    await bus.addMatch(`type='signal',sender='${DBUS_DAEMON}',interface='${DBUS_DAEMON}',member='NameOwnerChanged',arg0='${BLUEZ}'`);
    await bus.addMatch(`type='signal',sender='${BLUEZ}',interface='${OBJECT_MANAGER}'`);
    await bus.addMatch(`type='signal',sender='${BLUEZ}',interface='${PROPERTIES}',member='PropertiesChanged'`);

    this.bluezOwner = await bus.call<string>(DBUS_DAEMON, '/org/freedesktop/DBus', DBUS_DAEMON, 'GetNameOwner', 's', [BLUEZ]);
    await this.refreshObjects();

    const adapters = [...this.objects.entries()]
      .filter(([, ifaces]) => ifaces.has(ADAPTER_IFACE))
      .map(([path]) => path)
      .sort();

    if (adapters.length === 0) {
      throw new Error('No Bluetooth adapter found. Is bluetoothd running and is there a Bluetooth controller?');
    }

    if (this.adapterName) {
      const name = String(this.adapterName);
      const wanted = name.startsWith('/') ? name : `/org/bluez/${name}`;
      if (!adapters.includes(wanted)) {
        throw new Error(`Bluetooth adapter ${this.adapterName} not found (available: ${adapters.join(', ')})`);
      }
      this.adapter = wanted;
    } else {
      this.adapter = adapters[0];
    }

    const props = this.getProperties(this.adapter, ADAPTER_IFACE) ?? {};
    this.log.debug(`Using Bluetooth adapter ${this.adapter} (${props.Address ?? 'unknown address'})`);

    if (props.Powered !== true) {
      this.log.warn(`Bluetooth adapter ${this.adapter} is powered off, trying to power it on...`);
      await this.setProperty(this.adapter, ADAPTER_IFACE, 'Powered', ['b', true]);
    }
  }

  stop(): void {
    this.bus?.close();
    this.bus = undefined;
  }

  /** D-Bus object path BlueZ uses for a device with the given address on the active adapter. */
  devicePathFor(address: string): string {
    return `${this.adapterPath}/dev_${normalizeAddress(address).replace(/:/g, '_')}`;
  }

  hasObject(path: string, iface: string): boolean {
    return this.objects.get(path)?.has(iface) ?? false;
  }

  getProperties(path: string, iface: string): Props | undefined {
    return this.objects.get(path)?.get(iface);
  }

  /** All device objects BlueZ currently knows on the active adapter. */
  listDevices(): Array<{ path: string; props: Props }> {
    const prefix = `${this.adapterPath}/`;
    const result: Array<{ path: string; props: Props }> = [];
    for (const [path, ifaces] of this.objects) {
      const props = ifaces.get(DEVICE_IFACE);
      if (props && path.startsWith(prefix)) {
        result.push({ path, props });
      }
    }
    return result;
  }

  /** Find a GATT characteristic object below a device by UUID. */
  findCharacteristic(devicePath: string, uuid: string): { path: string; props: Props } | undefined {
    const wanted = normalizeUuid(uuid);
    const prefix = `${devicePath}/`;
    for (const [path, ifaces] of this.objects) {
      const props = ifaces.get(GATT_CHARACTERISTIC_IFACE);
      if (props && path.startsWith(prefix) && String(props.UUID).toLowerCase() === wanted) {
        return { path, props };
      }
    }
    return undefined;
  }

  /**
   * Wait until `predicate` becomes true. It is evaluated now and after every object or property change.
   */
  waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
    if (predicate()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const pending: { timer?: NodeJS.Timeout } = {};
      const onChange = (): void => {
        if (predicate()) {
          clearTimeout(pending.timer);
          this.off('objectsChanged', onChange);
          resolve();
        }
      };
      pending.timer = setTimeout(() => {
        this.off('objectsChanged', onChange);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      this.on('objectsChanged', onChange);
    });
  }

  /**
   * Start LE discovery (reference counted, shared by every caller). Call the returned function to release it.
   */
  async acquireDiscovery(): Promise<() => Promise<void>> {
    this.discoveryUsers++;
    if (!this.discoveryActive) {
      this.discoveryActive = true;
      try {
        await this.call(this.adapterPath, ADAPTER_IFACE, 'SetDiscoveryFilter', 'a{sv}', [[['Transport', ['s', 'le']]]]);
      } catch (e) {
        this.log.debug('SetDiscoveryFilter failed (continuing):', (e as Error).message);
      }
      try {
        await this.call(this.adapterPath, ADAPTER_IFACE, 'StartDiscovery');
        this.log.debug('Bluetooth LE discovery started');
      } catch (e) {
        // InProgress means another client (or a previous run) is already scanning; that is fine.
        if (!(e instanceof DBusError && e.dbusName === 'org.bluez.Error.InProgress')) {
          this.discoveryActive = false;
          this.discoveryUsers--;
          throw e;
        }
      }
    }

    let released = false;
    return async () => {
      if (released) {
        return;
      }
      released = true;
      this.discoveryUsers--;
      if (this.discoveryUsers <= 0 && this.discoveryActive) {
        this.discoveryUsers = 0;
        this.discoveryActive = false;
        try {
          await this.call(this.adapterPath, ADAPTER_IFACE, 'StopDiscovery');
          this.log.debug('Bluetooth LE discovery stopped');
        } catch (e) {
          this.log.debug('StopDiscovery failed:', (e as Error).message);
        }
      }
    };
  }

  connectDevice(devicePath: string, timeoutMs = 30_000): Promise<void> {
    return this.call(devicePath, DEVICE_IFACE, 'Connect', '', [], timeoutMs);
  }

  disconnectDevice(devicePath: string): Promise<void> {
    return this.call(devicePath, DEVICE_IFACE, 'Disconnect');
  }

  async readValue(charPath: string): Promise<Buffer> {
    const value = await this.call<unknown>(charPath, GATT_CHARACTERISTIC_IFACE, 'ReadValue', 'a{sv}', [[]], 10_000);
    return toBuffer(value);
  }

  writeValue(charPath: string, data: Buffer | number[], withResponse = true): Promise<void> {
    const bytes = Array.from(data);
    const options = [['type', ['s', withResponse ? 'request' : 'command']]];
    return this.call(charPath, GATT_CHARACTERISTIC_IFACE, 'WriteValue', 'aya{sv}', [bytes, options], 10_000);
  }

  startNotify(charPath: string): Promise<void> {
    return this.call(charPath, GATT_CHARACTERISTIC_IFACE, 'StartNotify', '', [], 10_000);
  }

  private call<T = void>(path: string, iface: string, member: string, signature = '', body: unknown[] = [], timeoutMs?: number): Promise<T> {
    if (!this.bus) {
      return Promise.reject(new Error('BlueZ client is not connected to D-Bus'));
    }
    return this.bus.call<T>(BLUEZ, path, iface, member, signature, body, timeoutMs);
  }

  private setProperty(path: string, iface: string, name: string, variant: [string, unknown]): Promise<void> {
    return this.call(path, PROPERTIES, 'Set', 'ssv', [iface, name, variant]);
  }

  private async refreshObjects(): Promise<void> {
    const managed = await this.call<unknown[]>('/', OBJECT_MANAGER, 'GetManagedObjects');
    this.objects.clear();
    for (const entry of managed ?? []) {
      const [path, ifaces] = entry as [string, unknown[]];
      this.addInterfaces(path, ifaces);
    }
  }

  private addInterfaces(path: string, rawIfaces: unknown): void {
    let ifaces = this.objects.get(path);
    if (!ifaces) {
      ifaces = new Map();
      this.objects.set(path, ifaces);
    }
    for (const entry of (rawIfaces as unknown[]) ?? []) {
      const [name, rawProps] = entry as [string, unknown];
      ifaces.set(name, parseDict(rawProps));
    }
  }

  private onSignal(signal: DBusSignal): void {
    // The bus daemon itself tells us when bluetoothd (re)starts or exits.
    if (signal.sender === DBUS_DAEMON || signal.interface === DBUS_DAEMON) {
      if (signal.sender === DBUS_DAEMON && signal.member === 'NameOwnerChanged' && signal.signature === 'sss' && signal.body[0] === BLUEZ) {
        this.onBluezOwnerChanged(String(signal.body[2]));
      }
      return;
    }

    // Everything else must come from the real bluetoothd, with the signature BlueZ documents.
    if (!this.bluezOwner || signal.sender !== this.bluezOwner) {
      this.log.debug(`Ignoring ${signal.interface}.${signal.member} signal from ${signal.sender} (not bluetoothd)`);
      return;
    }
    const expected = EXPECTED_SIGNATURES[`${signal.interface}.${signal.member}`];
    if (expected === undefined) {
      return;
    }
    if (signal.signature !== expected) {
      this.log.debug(`Ignoring ${signal.interface}.${signal.member} with unexpected signature "${signal.signature}"`);
      return;
    }

    if (signal.interface === OBJECT_MANAGER && signal.member === 'InterfacesAdded') {
      const [path, ifaces] = signal.body as [string, unknown];
      this.addInterfaces(path, ifaces);
      this.emit('interfacesAdded', path);
      this.emit('objectsChanged');
    } else if (signal.interface === OBJECT_MANAGER && signal.member === 'InterfacesRemoved') {
      const [path, names] = signal.body as [string, string[]];
      const ifaces = this.objects.get(path);
      if (ifaces) {
        for (const name of names ?? []) {
          ifaces.delete(name);
        }
        if (ifaces.size === 0) {
          this.objects.delete(path);
        }
      }
      this.emit('interfacesRemoved', path, names);
      this.emit('objectsChanged');
    } else if (signal.interface === PROPERTIES && signal.member === 'PropertiesChanged') {
      const [iface, rawChanged, invalidated] = signal.body as [string, unknown, string[]];
      const changed = parseDict(rawChanged);
      const ifaces = this.objects.get(signal.path);
      const props = ifaces?.get(iface);
      if (props) {
        Object.assign(props, changed);
        for (const name of invalidated ?? []) {
          delete props[name];
        }
      }
      const event: PropertiesChangedEvent = { path: signal.path, iface, changed, invalidated: invalidated ?? [] };
      this.emit('propertiesChanged', event);
      this.emit('objectsChanged');
    }
  }

  /**
   * bluetoothd exited or restarted: every object path we cached is stale.
   */
  private onBluezOwnerChanged(newOwner: string): void {
    this.log.warn(newOwner ? 'bluetoothd restarted, reloading Bluetooth state.' : 'bluetoothd stopped.');
    this.bluezOwner = newOwner || undefined;
    this.discoveryActive = false;
    this.discoveryUsers = 0;
    const stale = [...this.objects.keys()];
    this.objects.clear();
    for (const path of stale) {
      this.emit('interfacesRemoved', path, []);
    }
    this.emit('objectsChanged');
    if (newOwner) {
      this.refreshObjects()
        .then(() => this.emit('objectsChanged'))
        .catch((e: Error) => this.log.warn('Could not reload Bluetooth state:', e.message));
    }
  }
}
