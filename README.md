# OpenStorm

Block programming for LEGO MINDSTORMS EV3 on the iPad, without a Mac, without cables and without a paid Apple developer account.

The app itself is in German. Labels in quotes below are the German texts as they appear on screen.

- **Program**: Programming with blocks as in LEGO Education EV3 Classroom (Scratch), with the same categories and colors: motors, movement, display, sound, events, control, sensors, operators, variables and lists, My Blocks. All event blocks („Wenn Programm startet“, „Wenn Berührungssensor gedrückt“, „Wenn ich Nachricht empfange“ …) run at the same time.
- **Devices** („Geräte“): Shows what is plugged into ports 1–4 and A–D, with live values and a switchable mode. Motors move while you tap and hold them. The status light, sound and display can be tried out as well.
- **Simulator**: A virtual EV3 in the browser. Sensor values are set under „Geräte“, sounds are audible, and the display is reproduced.

Programs run in two ways:
- **▶ Start:** The program runs in the app and controls the EV3 live. The blocks currently running light up. The iPad has to stay connected.
- **Export → to the EV3** („Auf den EV3“, in the projects window): The app compiles the program into the EV3's machine code (`.rbf`, like the original LEGO software) and stores it on the brick. It runs there without the iPad.

### Differences from EV3 Classroom

- **Images and sounds:** The images (eyes, smiley, arrows …) and sounds (horn, siren, success …) are OpenStorm's own, since LEGO's may not be redistributed. The app uploads the sounds to the folder `OpenStorm` on the EV3 the first time they are played.
- **Lists on the EV3:** When the program runs on the brick (exported to the EV3), lists can only hold numbers. Texts there are at most 255 characters long; „Zeichen … von“ and „enthält“ only see the first 127.
- **Infrared sensor:** The distance blocks work with the ultrasonic sensor (Education set) and the infrared sensor (Home set). For the infrared sensor the app converts its proximity (0–100 %) into approximate centimeters; 100 % is about 70 cm. Beacon and remote control have their own blocks under „Sensoren“.
- **Measurements:** „zeichne … als … auf“ records values as a line chart under „Messwerte“ (next to „Ausgabe“), at most 8 lines. „Als Tabelle speichern“ downloads them as CSV for Excel/Numbers. This only works while the program runs in the app with ▶ Start.
- **Not reproduced:** the weather and music extensions.

## How it works

```
iPad (Safari)  ──WLAN──▶  Raspberry Pi Zero W  ──Bluetooth──▶  EV3
                          "OpenStorm bridge"
                          also serves the app
```

Safari on the iPad cannot use Bluetooth, and the EV3 only speaks Bluetooth Classic. A Raspberry Pi Zero W sits in between:
- It serves the app at **http://openstorm.local**.
- It forwards the commands to the EV3 over Bluetooth.

**No app needs to be installed** on the iPad.

## Setup

### 1. Prepare the Raspberry Pi (once)

1. Download the ready-made image:
   **https://github.com/mschneider85/openstorm/releases/download/pi-image/openstorm-pi.img.xz**
2. Open the [Raspberry Pi Imager](https://www.raspberrypi.com/software/) and choose "Raspberry Pi Zero" under *Device*.
3. Under *Operating System*, choose **"Use custom"** at the very bottom and select the downloaded file. There is no need to unpack it.
4. Choose the SD card and write. Answer the question about "OS customisation" with *No*; for custom images it is greyed out anyway.
5. Put the SD card into the Pi and connect power, from a power bank or the EV3's USB port.
   The bridge is ready after about 1 minute.
6. **Set up WLAN:**
   - On first start the Pi knows no WLAN yet. So it opens its own open WLAN **"OpenStorm"** (no password; it only serves the setup).
   - Connect the iPad to "OpenStorm" in *Settings → Wi-Fi*. The setup page opens by itself; otherwise open **http://10.42.0.1/wlan** in Safari.
   - Choose your WLAN, enter its password, tap **„Verbinden“**. The Pi switches to your WLAN, and the iPad follows.
   - If it fails (e.g. wrong password), the Pi opens "OpenStorm" again after about a minute, and the page shows the error.
   - From then on the Pi joins any saved WLAN in range when it starts. If none is in range, it opens "OpenStorm" again.
   - More WLANs (e.g. school) and saved WLANs are managed in the app under *Verbindung → WLAN der Brücke* or at **http://openstorm.local/wlan**.
   - It also works without a home WLAN: tap **„Ohne Heim-WLAN weiter“** on the setup page and open the app at **http://10.42.0.1**. The iPad has no internet then.

**The green light on the Pi:**
- **slow blinking:** ready, but no EV3 connected
- **steady:** connected to the EV3

If something does not work:
- **http://openstorm.local/log** shows the log of the bridge, the WLAN and Bluetooth since the last start (the log is kept in memory only, to spare the SD card).
- `openstorm-wlan.log` on the SD card's boot partition ("bootfs", readable on any PC) shows how the WLAN came up.
- Maintenance login via keyboard or SSH (`ssh openstorm@openstorm.local`): user `openstorm`, password `openstorm`.

### 2. Configure the EV3 (once)

*Settings (wrench) → Bluetooth:*
- **Bluetooth** on
- **Visibility** on
- **iPhone/iPad/iPod** off

Do **not** pair the EV3 in the iPad's Bluetooth settings; the Pi does that.

### 3. iPad (once)

1. Open **http://openstorm.local** in **Safari**.
   - On the Pi's own WLAN, **http://10.42.0.1** works too.
2. *Share* (□↑) → **"Add to Home Screen"**. OpenStorm then has its own icon and starts full screen.

### 4. Connect

- **The first time:**
  1. Tap **„Nicht verbunden“** at the top right, then **„Verbinden“**.
  2. The bridge searches for EV3 bricks nearby. Choose your EV3.
  3. The EV3 asks for the code `1234` – confirm it.
- **After that** OpenStorm connects to this EV3 **automatically** when it opens.
- The connection dialog shows whether the bridge is reachable and the EV3 is connected.

### 5. Programs on the EV3

- **Transfer:** projects window (tap the project name at the top) → **„⇩ Auf den EV3“** on the project. „Als Datei sichern“ (under ⋯), in contrast, only saves the blocks on the device.
- **Start on the brick:** *File Navigation* (second tab) → folder with the project name → program. Stop it with the back button.
- **Fetch back:** projects window → **„Auf dem EV3“** → **„⇧ Aufs Gerät“**. This works because OpenStorm stores a copy of the blocks (`blocks.osb`) next to every program, which the brick's menu does not show.
- Programs from the original LEGO software cannot be opened this way. The brick only holds their compiled program, not the blocks.
- Measurements are not recorded on the EV3. Recursive My Blocks (a block calling itself) do not work there. A variable must always hold either text or a number.

**Notes:**
- Projects are saved in the browser, separately for each address. So always use the same address, i.e. `openstorm.local`.
- **Updates:** When a new version is available, the app says so at start. Under *Verbindung → Brücke aktualisieren*, tap **„Jetzt aktualisieren“**. The Pi downloads the update from GitHub and installs it, including new packages, services and WLAN settings. Afterwards only the bridge restarts, not the whole Pi, and the app reloads itself.
  - Duration: If only the bridge and the app change, the Pi swaps just those, which takes a few seconds. If the setup changes (packages, services, WLAN), the install script runs, which can take a few minutes. Do not switch the Pi off meanwhile.
  - The Pi must be on the home WLAN with internet for this.
  - The Pi image is only needed for the first setup. OpenStorm deliberately does not upgrade all system packages (`apt upgrade`), since that takes very long on a Pi Zero.

## Other ways to connect

| Device | Connection |
|---|---|
| iPad with Safari | via the Pi bridge over WLAN (see above) |
| iPad with [Bluefy](https://apps.apple.com/de/app/id1492822055) | via the Pi bridge over Bluetooth LE: https://mschneider85.github.io/openstorm/ |
| PC/Mac with Chrome or Edge | via the Pi bridge (Web Bluetooth) or directly via the Bluetooth COM port of the paired EV3 (Web Serial) |
| Any browser | simulator |

## Development (Linux/WSL/Windows)

```bash
cd app
npm install
npm run dev     # http://localhost:5173, test with the simulator
npm test        # protocol, bridge, simulator and program tests
npm run build   # web app to app/dist

cd ../bridge
python3 -m unittest -v   # tests of the Pi bridge (test_web needs aiohttp)
```

On every push to `main`, GitHub builds automatically:

| Workflow | Result |
|---|---|
| `pages.yml` | web app at https://mschneider85.github.io/openstorm/ |
| `pi-image.yml` | SD card image incl. web app as release `pi-image`, update bundle for running Pis as release `pi-update` |

The bridge can also be installed on an existing Raspberry Pi OS: `sudo sh bridge/install-pi.sh`.
`journalctl -u openstorm-bridge -f` shows its log.

## Structure

```
app/
  src/ev3/          EV3 protocol: bytecode assembler, direct commands, file transfer, simulator
  src/transport/    connections: Pi bridge (WLAN and Web Bluetooth), Web Serial
  src/blocks/       block definitions, toolbox, code generator (app) and rbf.ts (compiler for the EV3)
  src/runtime/      runs the generated code (start/stop, parallel scripts)
  src/ui/           editor, devices page, dialogs
  test/             Vitest tests; ev3vm.ts reproduces the EV3 VM (checks like the firmware + execution)
bridge/
  openstorm_bridge.py      web server + WebSocket (WLAN) and BLE service ⇄ RFCOMM (EV3),
                           pairs the EV3 with PIN 1234, drives the status light
  wlan.html                WLAN setup (/wlan), opens by itself on the Pi's own WLAN
  wlan-setup.sh            at start: a known WLAN, else the own WLAN "OpenStorm"
  OpenStorm-Hotspot.nmconnection   own WLAN, when no known one is in range
  openstorm-captive.conf   on the own WLAN every address leads to the Pi (setup page)
  openstorm-journald.conf  keeps the system log in memory, to spare the SD card
  install-pi.sh            installation on Raspberry Pi OS (also used by the image build)
```

## Ideas for later

- Bridge on an ESP32 (starts in a second, survives hard power-off)
- more blocks: reset gyro, data logging, messages between bricks
