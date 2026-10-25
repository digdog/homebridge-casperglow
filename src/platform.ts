import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { BlueZ, normalizeAddress } from './ble/bluez.js';
import { GLOW_NAME_PREFIX, sanitizeForLog } from './glow/protocol.js';
import { CasperGlowAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export interface GlowDeviceConfig {
  name: string;
  macAddress: string;
}

export interface CasperGlowPlatformConfig extends PlatformConfig {
  adapter?: string;
  devices?: GlowDeviceConfig[];
  scanOnStartup?: boolean;
  /** Seconds between state polls (0 disables polling). */
  pollInterval?: number;
  /** Dimming duration in minutes sent with brightness changes when the light has not reported one. */
  dimmingTime?: number;
}

const SCAN_DURATION_MS = 30_000;

/**
 * Casper Glow platform.
 * Registers one Lightbulb accessory per configured light and drives them through BlueZ over D-Bus.
 */
export class CasperGlowPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly handlers: CasperGlowAccessory[] = [];

  public readonly config: CasperGlowPlatformConfig;
  public bluez?: BlueZ;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.config = config as CasperGlowPlatformConfig;

    this.api.on('didFinishLaunching', () => {
      this.start().catch((e: Error) => {
        this.log.error('Failed to start Casper Glow platform:', e.message);
      });
    });

    this.api.on('shutdown', () => {
      for (const handler of this.handlers) {
        handler.shutdown();
      }
      this.bluez?.stop();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.debug('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async start(): Promise<void> {
    const devices = this.validDevices();

    // Register / restore accessories first so HomeKit sees them even when Bluetooth is unavailable.
    this.registerAccessories(devices);

    if (process.platform !== 'linux') {
      this.log.error(`This plugin talks to BlueZ over D-Bus and only runs on Linux (current platform: ${process.platform}).`);
      return;
    }

    const bluez = new BlueZ(this.log, this.config.adapter);
    bluez.on('error', (e: Error) => this.log.error('Bluetooth / D-Bus error:', e.message));

    try {
      await bluez.start();
    } catch (e) {
      const message = (e as Error).message;
      this.log.error('Could not talk to BlueZ:', message);
      if (/AccessDenied|permission|EACCES/i.test(message)) {
        this.log.error('The Homebridge user probably needs to be in the "bluetooth" group: sudo usermod -aG bluetooth homebridge');
      } else if (/ServiceUnknown|org\.bluez was not provided/i.test(message)) {
        this.log.error('bluetoothd is not running. Start it with: sudo systemctl enable --now bluetooth');
      } else if (/ENOENT|ECONNREFUSED/i.test(message)) {
        this.log.error('The D-Bus system bus socket is not reachable. Is dbus/bluetoothd running (or, in Docker, is /var/run/dbus mounted)?');
      }
      return;
    }
    this.bluez = bluez;

    // Scan first: many controllers (including the Raspberry Pi's built-in one) abort LE connection attempts
    // while discovery is running.
    if (devices.length === 0 || this.config.scanOnStartup) {
      try {
        await this.scanForLights(bluez);
      } catch (e) {
        this.log.warn('Scan failed:', (e as Error).message);
      }
    }

    for (const handler of this.handlers) {
      handler.attach(bluez);
    }
  }

  private configuredDevices(): GlowDeviceConfig[] {
    return Array.isArray(this.config.devices) ? this.config.devices : [];
  }

  private validDevices(): GlowDeviceConfig[] {
    const result: GlowDeviceConfig[] = [];
    const seen = new Set<string>();
    if (this.config.devices !== undefined && !Array.isArray(this.config.devices)) {
      this.log.error('"devices" must be a list of { name, macAddress } entries; ignoring it.');
    }
    for (const device of this.configuredDevices()) {
      if (typeof device?.macAddress !== 'string' || !device.macAddress) {
        this.log.warn('Skipping a device without macAddress:', JSON.stringify(device));
        continue;
      }
      let address: string;
      try {
        address = normalizeAddress(device.macAddress);
      } catch (e) {
        this.log.warn((e as Error).message);
        continue;
      }
      if (seen.has(address)) {
        this.log.warn(`Duplicate device ${address} in config, ignoring the second entry.`);
        continue;
      }
      seen.add(address);
      // Control characters would corrupt log lines and are rejected by HomeKit; other Unicode (e.g. CJK names) is fine.
      const cleaned = typeof device.name === 'string' ? device.name.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) : '';
      const name = cleaned || 'Casper Glow';
      result.push({ name, macAddress: address });
    }
    return result;
  }

  private registerAccessories(devices: GlowDeviceConfig[]): void {
    const activeUUIDs = new Set<string>();

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(`casper-glow:${device.macAddress}`);
      activeUUIDs.add(uuid);

      let accessory = this.accessories.get(uuid);
      if (accessory) {
        this.log.info('Restoring existing accessory from cache:', accessory.displayName);
        accessory.context.device = device;
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.log.info('Adding new accessory:', device.name);
        accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }

      this.handlers.push(new CasperGlowAccessory(this, accessory));
    }

    // Remove cached accessories whose light was removed from the config.
    for (const [uuid, accessory] of this.accessories) {
      if (!activeUUIDs.has(uuid)) {
        this.log.info('Removing accessory no longer in config:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  /**
   * Scan for a while and log every Casper Glow in range, so users can find the MAC addresses to configure.
   */
  private async scanForLights(bluez: BlueZ): Promise<void> {
    this.log.info(`Scanning ${SCAN_DURATION_MS / 1000}s for Casper Glow lights...`);
    const reported = new Set<string>();

    const report = () => {
      for (const { props } of bluez.listDevices()) {
        const address = String(props.Address ?? '');
        if (!address || reported.has(address)) {
          continue;
        }
        // Casper Glow lights do not advertise their service UUID; the local name ("Jar", "Jar_2", ...) is the signal.
        // Advertised names come from any device in radio range: never log them raw.
        const name = sanitizeForLog(props.Name ?? props.Alias ?? '');
        if (name.startsWith(GLOW_NAME_PREFIX)) {
          reported.add(address);
          const configured = this.configuredDevices().some(d => {
            try {
              return normalizeAddress(d.macAddress) === address;
            } catch {
              return false;
            }
          });
          const rssi = typeof props.RSSI === 'number' ? props.RSSI : 'n/a';
          this.log.info(`Found Casper Glow: ${sanitizeForLog(address, 17)} (name "${name}", RSSI ${rssi})${configured ? ' [configured]' : ''}`);
        }
      }
    };

    const release = await bluez.acquireDiscovery();
    report();
    bluez.on('objectsChanged', report);
    await new Promise(resolve => setTimeout(resolve, SCAN_DURATION_MS));
    bluez.off('objectsChanged', report);
    await release();

    if (reported.size === 0) {
      this.log.info('No Casper Glow lights found. Make sure they are powered and not connected to the Casper app.');
    } else {
      this.log.info(`Scan finished, ${reported.size} light(s) found. Add their MAC addresses under "devices" in the config.`);
    }
  }
}
