import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { DBusError } from './ble/dbus.js';
import { DEVICE_IFACE, GATT_CHARACTERISTIC_IFACE, toBuffer } from './ble/bluez.js';
import type { BlueZ, PropertiesChangedEvent } from './ble/bluez.js';
import {
  ACTION_OFF,
  ACTION_ON,
  BRIGHTNESS_LEVELS,
  buildActionPacket,
  buildBrightnessBody,
  containsReadyMarker,
  DIMMING_TIME_MINUTES,
  extractToken,
  MAX_NOTIFICATION_LENGTH,
  GLOW_READ_UUID,
  GLOW_SERVICE_UUID,
  GLOW_WRITE_UUID,
  homeKitToLevel,
  levelToHomeKit,
  parseStateResponse,
  QUERY_STATE,
  RECONNECT_PACKET,
} from './glow/protocol.js';
import type { GlowState } from './glow/protocol.js';
import type { CasperGlowPlatform, GlowDeviceConfig } from './platform.js';

const DISCOVERY_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 1_500;
const SERVICES_RESOLVED_TIMEOUT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const STATE_RESPONSE_TIMEOUT_MS = 5_000;
/** Drop the BLE connection after this much inactivity, so the light can sleep and the Casper app can connect. */
const IDLE_DISCONNECT_MS = 30_000;
const DEFAULT_POLL_SECONDS = 60;
const MIN_POLL_SECONDS = 15;
const DEFAULT_DIMMING_MINUTES = 15;

type Command = 'power' | 'brightness';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface GlowContext {
  device: GlowDeviceConfig;
  /** Last brightness level index (0–4) we set; the light does not report brightness. */
  brightnessLevel?: number;
  /** Last dimming duration (minutes) the light reported. */
  dimmingTime?: number;
}

/**
 * One Casper Glow light, exposed as a HomeKit Lightbulb plus a Battery service.
 *
 * Every exchange with the light is a short "session": connect (if needed) → subscribe to notifications →
 * handshake to obtain a session token → write commands carrying that token. The connection is kept for
 * IDLE_DISCONNECT_MS after the last session so slider drags and polls reuse it.
 */
export class CasperGlowAccessory {
  private readonly lightbulb: Service;
  private readonly battery: Service;
  private readonly context: GlowContext;
  private readonly name: string;

  private bluez?: BlueZ;
  private devicePath?: string;
  private writePath?: string;
  private readPath?: string;
  private connected = false;
  private connecting?: Promise<void>;
  private stopped = false;
  /** Whether the last exchange with the light succeeded; used to log only changes. */
  private reachable?: boolean;

  /** Sessions run one at a time. */
  private sessionChain: Promise<unknown> = Promise.resolve();
  private readonly notifyListeners = new Set<(data: Buffer) => void>();
  private idleTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;

  /** Commands waiting to be sent, latest value wins. Insertion order is send order. */
  private readonly pending = new Map<Command, number>();
  private flushing = false;

  private state = {
    on: false,
    batteryPercent: 100,
    charging: false,
  };

  constructor(
    private readonly platform: CasperGlowPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.context = accessory.context as GlowContext;
    this.name = accessory.displayName;
    const { Characteristic, Service } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Casper')
      .setCharacteristic(Characteristic.Model, 'Glow Light')
      .setCharacteristic(Characteristic.SerialNumber, this.context.device.macAddress);

    this.lightbulb = this.accessory.getService(Service.Lightbulb) || this.accessory.addService(Service.Lightbulb);
    this.lightbulb.setCharacteristic(Characteristic.Name, this.context.device.name);

    this.lightbulb.getCharacteristic(Characteristic.On)
      .onGet(() => this.state.on)
      .onSet(this.setOn.bind(this));

    // The light has five brightness levels; show them as 20 / 40 / 60 / 80 / 100 %.
    this.lightbulb.getCharacteristic(Characteristic.Brightness)
      .setProps({ minValue: 0, maxValue: 100, minStep: 20 })
      .onGet(() => levelToHomeKit(this.brightnessLevel))
      .onSet(this.setBrightness.bind(this));

    this.battery = this.accessory.getService(Service.Battery) || this.accessory.addService(Service.Battery);
    this.battery.getCharacteristic(Characteristic.BatteryLevel).onGet(() => this.state.batteryPercent);
    this.battery.getCharacteristic(Characteristic.ChargingState).onGet(() => this.chargingState());
    this.battery.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => this.lowBatteryStatus());
  }

  private get brightnessLevel(): number {
    const level = this.context.brightnessLevel;
    return level !== undefined && level >= 0 && level <= 4 ? level : 4;
  }

  private get pollSeconds(): number {
    const raw = this.platform.config.pollInterval;
    if (raw === undefined || raw === null) {
      return DEFAULT_POLL_SECONDS;
    }
    const configured = Number(raw);
    if (!Number.isFinite(configured)) {
      // A non-numeric value must never turn into setTimeout(NaN), which fires immediately in a tight loop.
      return DEFAULT_POLL_SECONDS;
    }
    if (configured <= 0) {
      return 0;
    }
    return Math.min(24 * 3600, Math.max(MIN_POLL_SECONDS, Math.round(configured)));
  }

  private get dimmingMinutes(): number {
    const candidates = [this.context.dimmingTime, Number(this.platform.config.dimmingTime), DEFAULT_DIMMING_MINUTES];
    for (const value of candidates) {
      if (value !== undefined && (DIMMING_TIME_MINUTES as readonly number[]).includes(value)) {
        return value;
      }
    }
    return DEFAULT_DIMMING_MINUTES;
  }

  /**
   * Called once BlueZ is available.
   */
  attach(bluez: BlueZ): void {
    this.bluez = bluez;
    this.devicePath = bluez.devicePathFor(this.context.device.macAddress);
    bluez.on('propertiesChanged', (event: PropertiesChangedEvent) => this.onPropertiesChanged(event));
    bluez.on('interfacesRemoved', (path: string) => {
      if (path === this.devicePath) {
        this.onDisconnected('device removed from BlueZ');
      }
    });
    void this.poll();
  }

  shutdown(): void {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.pollTimer);
    this.disconnect();
  }

  // ---------------------------------------------------------------------------------------------
  // HomeKit handlers. They answer immediately and send the command in the background, because a BLE
  // connect + handshake can take a few seconds.
  // ---------------------------------------------------------------------------------------------

  private setOn(value: CharacteristicValue): void {
    this.requireBluetooth();
    this.state.on = value as boolean;
    this.platform.log.debug(`[${this.name}] Set On -> ${this.state.on}`);
    this.enqueue('power', this.state.on ? 1 : 0);
  }

  private setBrightness(value: CharacteristicValue): void {
    this.requireBluetooth();
    const requested = value as number;
    if (requested <= 0) {
      // Dragging the slider to 0 means "off".
      this.state.on = false;
      this.enqueue('power', 0);
      setImmediate(() => this.lightbulb.updateCharacteristic(this.platform.Characteristic.On, false));
      return;
    }
    const level = homeKitToLevel(requested);
    this.context.brightnessLevel = level;
    this.platform.api.updatePlatformAccessories([this.accessory]);
    this.platform.log.debug(`[${this.name}] Set Brightness ${requested} -> level ${level + 1} (${BRIGHTNESS_LEVELS[level]}%)`);
    this.enqueue('brightness', level);
    const shown = levelToHomeKit(level);
    if (shown !== requested) {
      setImmediate(() => this.lightbulb.updateCharacteristic(this.platform.Characteristic.Brightness, shown));
    }
  }

  private requireBluetooth(): void {
    if (!this.bluez) {
      this.platform.log.warn(`[${this.name}] Bluetooth is not available, cannot send command.`);
      throw this.communicationFailure();
    }
  }

  private communicationFailure(): Error {
    const { HapStatusError, HAPStatus } = this.platform.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private chargingState(): number {
    const { ChargingState } = this.platform.Characteristic;
    return this.state.charging ? ChargingState.CHARGING : ChargingState.NOT_CHARGING;
  }

  private lowBatteryStatus(): number {
    const { StatusLowBattery } = this.platform.Characteristic;
    return this.state.batteryPercent <= 25 ? StatusLowBattery.BATTERY_LEVEL_LOW : StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  // ---------------------------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------------------------

  private enqueue(command: Command, value: number): void {
    this.pending.delete(command); // re-insert so the newest command goes last
    this.pending.set(command, value);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    try {
      while (this.pending.size > 0) {
        // Send power before brightness so a brightness change always reaches a light that is on.
        const batch = [...this.pending.entries()].sort(([a], [b]) => (a === 'power' ? -1 : b === 'power' ? 1 : 0));
        this.pending.clear();
        const bodies = batch.map(([command, value]) => this.commandBody(command, value));
        try {
          await this.session(async token => {
            for (const body of bodies) {
              await this.bluez!.writeValue(this.writePath!, buildActionPacket(token, body), true);
            }
          });
          this.platform.log.debug(`[${this.name}] Sent ${batch.map(([c, v]) => `${c}=${v}`).join(', ')}`);
        } catch (e) {
          this.platform.log.error(`[${this.name}] Failed to send ${batch.map(([c]) => c).join(' + ')}: ${(e as Error).message}`);
          // Show "No Response" until the next successful poll.
          this.lightbulb.updateCharacteristic(this.platform.Characteristic.On, this.communicationFailure());
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private commandBody(command: Command, value: number): Buffer {
    if (command === 'power') {
      return value ? ACTION_ON : ACTION_OFF;
    }
    return buildBrightnessBody(BRIGHTNESS_LEVELS[value], this.dimmingMinutes * 60_000);
  }

  /**
   * Ask the light for its state, then schedule the next poll.
   */
  private async poll(): Promise<void> {
    clearTimeout(this.pollTimer);
    if (this.stopped) {
      return;
    }
    try {
      await this.session(async token => {
        const response = this.waitForNotification(data => parseStateResponse(data) !== undefined, STATE_RESPONSE_TIMEOUT_MS);
        await this.bluez!.writeValue(this.writePath!, buildActionPacket(token, QUERY_STATE), true);
        await response; // the state itself is applied by onNotification()
      });
    } catch (e) {
      this.platform.log.debug(`[${this.name}] Could not read state: ${(e as Error).message}`);
      this.lightbulb.updateCharacteristic(this.platform.Characteristic.On, this.communicationFailure());
    }
    if (!this.stopped && this.pollSeconds > 0) {
      this.pollTimer = setTimeout(() => void this.poll(), this.pollSeconds * 1000);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Sessions: connect → notify → handshake → work
  // ---------------------------------------------------------------------------------------------

  private session<T>(work: (token: number) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      clearTimeout(this.idleTimer);
      try {
        await this.ensureConnected();
        const token = await this.handshake();
        const result = await work(token);
        this.markReachable(true);
        return result;
      } catch (e) {
        // Leave the light in a clean state so the next attempt starts from scratch.
        this.disconnect();
        this.markReachable(false, (e as Error).message);
        throw e;
      } finally {
        this.scheduleIdleDisconnect();
      }
    };
    const result = this.sessionChain.then(run, run);
    this.sessionChain = result.catch(() => undefined);
    return result;
  }

  private async handshake(): Promise<number> {
    let token: number | undefined;
    const ready = this.waitForNotification(data => {
      if (containsReadyMarker(data)) {
        token = extractToken(data);
        return token !== undefined;
      }
      return false;
    }, HANDSHAKE_TIMEOUT_MS, 'handshake');
    await this.bluez!.writeValue(this.writePath!, RECONNECT_PACKET, true);
    await ready;
    return token!;
  }

  private waitForNotification(match: (data: Buffer) => boolean, timeoutMs: number, what = 'state response'): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wait: { timer?: NodeJS.Timeout } = {};
      const listener = (data: Buffer) => {
        if (match(data)) {
          clearTimeout(wait.timer);
          this.notifyListeners.delete(listener);
          resolve();
        }
      };
      wait.timer = setTimeout(() => {
        this.notifyListeners.delete(listener);
        reject(new Error(`no ${what} from the light within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.notifyListeners.add(listener);
    });
  }

  private ensureConnected(): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }
    if (!this.connecting) {
      this.connecting = this.connect()
        .then(() => {
          this.connected = true;
          this.platform.log.debug(`[${this.name}] Connected.`);
        })
        .finally(() => {
          this.connecting = undefined;
        });
    }
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const bluez = this.bluez!;
    const devicePath = this.devicePath!;
    const address = this.context.device.macAddress;

    if (!bluez.hasObject(devicePath, DEVICE_IFACE)) {
      this.platform.log.info(`[${this.name}] Looking for ${address}...`);
      const release = await bluez.acquireDiscovery();
      try {
        await bluez.waitFor(() => bluez.hasObject(devicePath, DEVICE_IFACE), DISCOVERY_TIMEOUT_MS, `${address} to be discovered`);
      } finally {
        await release();
      }
    }

    for (let attempt = 1; bluez.getProperties(devicePath, DEVICE_IFACE)?.Connected !== true; attempt++) {
      try {
        this.platform.log.debug(`[${this.name}] Connecting to ${address} (attempt ${attempt})...`);
        await bluez.connectDevice(devicePath, CONNECT_TIMEOUT_MS);
        break;
      } catch (e) {
        // The Pi's built-in controller often fails the first LE connection with le-connection-abort-by-local.
        if (attempt >= CONNECT_ATTEMPTS || !(e instanceof DBusError)) {
          throw e;
        }
        this.platform.log.debug(`[${this.name}] Connect attempt ${attempt} failed (${e.message}), retrying...`);
        await sleep(CONNECT_RETRY_DELAY_MS);
      }
    }

    await bluez.waitFor(
      () => bluez.getProperties(devicePath, DEVICE_IFACE)?.ServicesResolved === true,
      SERVICES_RESOLVED_TIMEOUT_MS,
      'GATT services to be resolved',
    );

    const write = bluez.findCharacteristic(devicePath, GLOW_WRITE_UUID);
    const read = bluez.findCharacteristic(devicePath, GLOW_READ_UUID);
    if (!write || !read) {
      throw new Error(`Casper Glow service ${GLOW_SERVICE_UUID} not found on ${address}. Is this really a Casper Glow?`);
    }
    this.writePath = write.path;
    this.readPath = read.path;

    if (bluez.getProperties(read.path, GATT_CHARACTERISTIC_IFACE)?.Notifying !== true) {
      await bluez.startNotify(read.path);
    }
  }

  private markReachable(ok: boolean, reason?: string): void {
    if (ok && this.reachable !== true) {
      this.platform.log.info(`[${this.name}] ${this.reachable === false ? 'Reachable again' : 'Connected'}.`);
    } else if (!ok && this.reachable !== false) {
      this.platform.log.warn(`[${this.name}] Unreachable: ${reason}. Will keep trying.`);
    }
    this.reachable = ok;
  }

  private scheduleIdleDisconnect(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.connected) {
        this.platform.log.debug(`[${this.name}] Idle, disconnecting.`);
        this.disconnect();
      }
    }, IDLE_DISCONNECT_MS);
  }

  private disconnect(): void {
    this.connected = false;
    if (this.bluez && this.devicePath && this.bluez.getProperties(this.devicePath, DEVICE_IFACE)?.Connected === true) {
      this.bluez.disconnectDevice(this.devicePath).catch(() => undefined);
    }
  }

  private onDisconnected(reason: string): void {
    if (this.connected) {
      this.connected = false;
      this.platform.log.debug(`[${this.name}] Disconnected (${reason}).`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // BlueZ events
  // ---------------------------------------------------------------------------------------------

  private onPropertiesChanged(event: PropertiesChangedEvent): void {
    if (event.path === this.devicePath && event.iface === DEVICE_IFACE) {
      if (event.changed.Connected === false) {
        this.onDisconnected('connection closed');
      } else if (event.changed.ServicesResolved === false) {
        this.onDisconnected('services invalidated');
      }
      return;
    }
    if (event.path === this.readPath && event.iface === GATT_CHARACTERISTIC_IFACE && 'Value' in event.changed) {
      this.onNotification(toBuffer(event.changed.Value));
    }
  }

  private onNotification(data: Buffer): void {
    if (data.length > MAX_NOTIFICATION_LENGTH) {
      this.platform.log.debug(`[${this.name}] Ignoring oversized notification (${data.length} bytes)`);
      return;
    }
    this.platform.log.debug(`[${this.name}] Notification ${data.toString('hex')}`);
    const state = parseStateResponse(data);
    if (state) {
      this.applyState(state);
    }
    for (const listener of [...this.notifyListeners]) {
      listener(data);
    }
  }

  private applyState(state: GlowState): void {
    const { Characteristic } = this.platform;
    const parts: string[] = [];

    if (state.on !== undefined && !this.pending.has('power')) {
      this.state.on = state.on;
      this.lightbulb.updateCharacteristic(Characteristic.On, state.on);
      parts.push(state.on ? (state.paused ? 'on (paused)' : 'on') : 'off');
    }
    if (state.dimmingTimeMinutes !== undefined && state.dimmingTimeMinutes !== this.context.dimmingTime) {
      this.context.dimmingTime = state.dimmingTimeMinutes;
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
    if (state.batteryPercent !== undefined) {
      this.state.batteryPercent = state.batteryPercent;
      this.battery.updateCharacteristic(Characteristic.BatteryLevel, state.batteryPercent);
      this.battery.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBatteryStatus());
      parts.push(`battery ~${state.batteryPercent}%`);
    }
    if (state.charging !== undefined) {
      this.state.charging = state.charging;
      this.battery.updateCharacteristic(Characteristic.ChargingState, this.chargingState());
      if (state.charging) {
        parts.push('charging');
      }
    }
    this.platform.log.debug(`[${this.name}] State: ${parts.join(', ')}`);
  }
}
