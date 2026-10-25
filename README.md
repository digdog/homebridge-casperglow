# homebridge-casperglow

A Homebridge platform plugin that exposes one or more Casper Glow lights to HomeKit as Lightbulbs over BLE, using BlueZ via a pure-JavaScript D-Bus client.

Each light shows up in the Home app with:

- **On/Off**
- **Brightness**, with the light's five levels mapped to 20 / 40 / 60 / 80 / 100 %
- **Battery** level, charging state, and a low-battery warning

Unlike plugins built on `noble`, this plugin has **no native modules**. It talks to the Linux Bluetooth stack (BlueZ) over D-Bus using [`@homebridge/dbus-native`](https://github.com/homebridge/dbus-native), so:

- you don't need `node-gyp`, compilers, or Bluetooth development headers to install it
- you don't need `setcap cap_net_raw` on the Node binary, or to stop `bluetoothd`
- it shares the Bluetooth adapter with everything else on the system

## Requirements

- **Linux** with BlueZ (`bluetoothd`) running, such as Raspberry Pi OS, Debian, Ubuntu or Fedora. Raspberry Pi 3, 4, 5 and Zero W have Bluetooth built in.
- Node.js 22.10+ or 24.
- The user Homebridge runs as must be allowed to talk to BlueZ. On most distributions, add it to the `bluetooth` group:

  ```bash
  sudo usermod -aG bluetooth homebridge
  sudo hb-service restart
  ```

- **Docker**: mount the host's D-Bus socket (`-v /var/run/dbus:/var/run/dbus`) and use host networking.

macOS and Windows are not supported, because plain JavaScript can't reach CoreBluetooth or WinRT.

## Installation

The plugin is not published to npm yet. Build a package and install it into Homebridge:

```bash
# on your development machine
npm install && npm run build && npm pack          # -> homebridge-casperglow-<version>.tgz
scp homebridge-casperglow-*.tgz pi@raspberrypi.local:/tmp/

# on the Pi
sudo hb-shell
cd /var/lib/homebridge && npm install /tmp/homebridge-casperglow-*.tgz
exit
sudo hb-service restart
```

## Finding your lights

Casper Glow lights advertise a name starting with `Jar` (for example `Jar` or `Jar_2`). They don't advertise a service UUID. Close the Casper app on your phone first; a light that's connected to the app stops advertising.

**With the plugin:** leave `devices` empty (or set `scanOnStartup: true`) and restart Homebridge. For 30 seconds the plugin logs every light it finds:

```
[Casper Glow] Found Casper Glow: D3:5D:86:E9:5D:27 (name "Jar_2", RSSI -55)
```

**With bluetoothctl:**

```bash
bluetoothctl --timeout 20 scan on | grep -i jar
```

## Configuration

```json
{
  "platform": "CasperGlow",
  "name": "Casper Glow",
  "devices": [
    { "name": "Bedroom Glow", "macAddress": "D3:5D:86:E9:5D:27" }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `devices[].name` | — | Name shown in the Home app. |
| `devices[].macAddress` | — | Bluetooth address of the light (`AA:BB:…`, `aa-bb-…` and `aabb…` all work). |
| `pollInterval` | `60` | Seconds between state reads (on/off, battery, charging). `0` turns polling off; the minimum is `15`. |
| `dimmingTime` | `15` | Dimming duration in minutes (15, 30, 45, 60 or 90) sent with brightness changes. Once the light reports its own setting, that's used instead. |
| `adapter` | first adapter | BlueZ adapter to use, e.g. `hci1`. |
| `scanOnStartup` | `false` | Log nearby lights for 30 s at startup even when devices are configured. |

### Brightness

The light has five brightness levels (the Casper app's 60–100 %), and each brightness command also sets the dimming time. HomeKit's slider is divided into five steps:

| HomeKit | 1–20 | 21–40 | 41–60 | 61–80 | 81–100 |
| --- | --- | --- | --- | --- | --- |
| Light | 60 % | 70 % | 80 % | 90 % | 100 % |

The light doesn't report its brightness, so the plugin remembers the last level it set.

## How it works

Each exchange with the light is a short session:

1. Connect with `Device1.Connect`, retried because some controllers (including the Pi's) often fail the first attempt with `le-connection-abort-by-local`. Then wait for `ServicesResolved`.
2. Subscribe to notifications on `9bb30003-fee9-4c24-8361-443b5b7c88f6`.
3. Write the handshake packet `080122026a00` to `9bb30002-…`. The light replies with a ready marker and a **session token**.
4. Write commands that carry the token: on, off, brightness + dimming time, or a state query. The state reply includes on/off, pause, dimming time, battery level and charging state.

The connection stays open for 30 seconds after the last session, so quick slider changes and polls reuse it. After that the plugin disconnects, which lets the light sleep and lets the Casper app connect. HomeKit commands return immediately and are sent in the background, and a rapid series of slider changes is sent as a single command. If the light can't be reached, the Home app shows "No Response" until the next successful exchange.

## Security

**Limits of the light itself.** The Casper Glow protocol has no pairing, encryption or authentication. Anyone within Bluetooth range can control the light with the same commands this plugin sends, and a device pretending to be your light could report false state. A plugin can't fix that.

**What the plugin does about it:**

- It accepts BlueZ signals only from the process that currently owns the `org.bluez` bus name, and only with the type signatures BlueZ documents. On a standard Linux system bus any local process may send signals to any client, so without this check an unprivileged process could inject fake light state or crash Homebridge.
- A malformed D-Bus message or BLE notification is logged and dropped. It can never throw out of the event loop and stop Homebridge.
- Data from the light is parsed with bounds checks. Notifications longer than 512 bytes and session tokens that aren't safe integers are rejected.
- Bluetooth names from nearby devices have non-printable characters removed before they're logged, so they can't fake log lines or send terminal escape codes.
- Config values are validated. A non-numeric `pollInterval` falls back to the default instead of polling in a tight loop.
- The only runtime dependency, `@homebridge/dbus-native`, is pinned to an exact version and has no install scripts or native code.

**For your setup:**

- Adding the Homebridge user to the `bluetooth` group lets every plugin in that Homebridge instance control Bluetooth, not only this one.
- Running this plugin as a child bridge isolates it from other plugins' crashes.

## Development

```bash
npm install
npm run lint
npm test        # builds, then runs protocol tests against real-device captures
npm run watch   # builds, links, and runs Homebridge with ./test/hbConfig
```

You can develop on macOS; the plugin only talks to lights on Linux.

## Credits

The Casper Glow protocol (UUIDs, handshake, packet formats, state fields) comes from [pycasperglow](https://github.com/mikeodr/pycasperglow) (MIT), the library behind Home Assistant's Casper Glow integration. The protocol test vectors come from its test suite.
