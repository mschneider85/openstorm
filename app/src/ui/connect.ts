import { Ev3Brick } from '../ev3/ev3brick';
import { SimBrick } from '../ev3/simbrick';
import { BleBridge, WsBridge, bridgeUrlFromPage, webBluetoothAvailable, type BridgeConnection, type Ev3Device } from '../transport/bridge';
import { IosTransport, iosBluetoothAvailable, listPairedBricks, pairBrick } from '../transport/ios';
import { SerialTransport, serialAvailable } from '../transport/serial';
import type { Transport } from '../transport/transport';
import { state, type ConnectionKind } from '../state';
import { log } from './console';

let dialog: HTMLDialogElement;
let body: HTMLElement;
/** A bridge connected in the dialog but not (yet) used for a brick. */
let pendingBridge: BridgeConnection | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function section(title: string, ...children: (Node | string)[]): HTMLElement {
  const s = el('section', 'connect-section');
  s.append(el('h3', '', title), ...children);
  return s;
}

function hints(...lines: string[]): HTMLElement {
  const ul = el('ul', 'hints');
  for (const line of lines) ul.append(el('li', '', line));
  return ul;
}

async function connectWith(kind: ConnectionKind, open: () => Promise<Transport>, label: HTMLElement): Promise<void> {
  label.textContent = 'Verbinde …';
  try {
    const transport = await open();
    let brick: Ev3Brick | null = null;
    brick = await Ev3Brick.connect(transport, (reason) => {
      if (state.brick !== brick) return;
      log(`Verbindung getrennt: ${reason}`, 'error');
      state.setBrick(null, 'none');
    });
    state.setBrick(brick, kind);
    log(`Verbunden mit ${brick.name}`);
    dialog.close();
  } catch (e) {
    const message = (e as Error).message;
    label.textContent = message;
    // Choosing no port in the browser dialog is not an error worth logging.
    if (!/No port selected|user cancel/i.test(message)) log(`Verbindung fehlgeschlagen: ${message}`, 'error');
  }
}

async function iosSection(): Promise<HTMLElement> {
  const status = el('p', 'status');
  const list = el('div', 'device-list');
  const fill = async () => {
    list.replaceChildren();
    const bricks = await listPairedBricks().catch(() => []);
    if (bricks.length === 0) list.append(el('p', 'muted', 'Kein gekoppelter EV3 gefunden.'));
    for (const b of bricks) {
      const row = el('div', 'device-row');
      const btn = el('button', 'btn primary', 'Verbinden');
      btn.addEventListener('click', () => connectWith('ios', () => IosTransport.open(b), status));
      row.append(el('span', '', b.name), btn);
      list.append(row);
    }
  };
  await fill();
  const pair = el('button', 'btn', 'Neuen EV3 koppeln …');
  pair.addEventListener('click', async () => {
    try {
      if (await pairBrick()) await fill();
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  });
  return section(
    'EV3 per Bluetooth',
    list,
    pair,
    status,
    hints(
      'Am EV3: Einstellungen → Bluetooth → „Bluetooth“ und „iPhone/iPad/iPod“ einschalten.',
      'Beim ersten Koppeln zeigt der EV3 eine Bestätigung bzw. den Code 1234.',
    ),
  );
}

/** Uses a bridge that holds an EV3 connection as the current brick. */
async function useBridge(bridge: BridgeConnection, status: HTMLElement): Promise<void> {
  pendingBridge = null;
  await connectWith('bridge', async () => bridge, status);
}

function describe(s: { connected: boolean; name: string | null }): string {
  if (s.connected) return `Brücke ✓ · EV3 „${s.name}“ verbunden ✓`;
  if (s.name) return `Brücke ✓ · EV3 „${s.name}“ nicht verbunden (aus oder außer Reichweite?)`;
  return 'Brücke ✓ · noch kein EV3 gekoppelt';
}

/**
 * Connects through the bridge: if the bridge already holds an EV3 connection it
 * is used, else the last brick is tried, else nearby bricks are listed.
 */
function bridgeSection(title: string, buttonLabel: string, open: () => Promise<BridgeConnection>, tips: string[]): HTMLElement {
  const status = el('p', 'status');
  const list = el('div', 'device-list');
  const button = el('button', 'btn primary', buttonLabel);

  const connectEv3 = async (bridge: BridgeConnection, device?: Ev3Device) => {
    list.replaceChildren();
    status.textContent = device
      ? `Verbinde mit ${device.name} … Beim ersten Mal die Kopplung am EV3 bestätigen (1234).`
      : 'Verbinde mit dem zuletzt benutzten EV3 …';
    await bridge.connectEv3(device?.address);
    await useBridge(bridge, status);
  };

  const showScan = async (bridge: BridgeConnection) => {
    list.replaceChildren();
    status.textContent = 'Suche EV3 in der Nähe (ca. 10 Sekunden) …';
    const devices = await bridge.scan();
    status.textContent = devices.length ? 'EV3 auswählen:' : 'Kein Gerät gefunden. Ist Bluetooth am EV3 eingeschaltet und sichtbar?';
    for (const d of devices) {
      const row = el('div', 'device-row');
      const btn = el('button', `btn ${d.ev3 ? 'primary' : ''}`, 'Verbinden');
      btn.addEventListener('click', () => connectEv3(bridge, d).catch((e: Error) => (status.textContent = e.message)));
      row.append(el('span', '', `${d.name}${d.ev3 ? '' : ' (kein EV3?)'}`), btn);
      list.append(row);
    }
    const again = el('button', 'btn ghost', 'Erneut suchen');
    again.addEventListener('click', () => showScan(bridge).catch((e: Error) => (status.textContent = e.message)));
    list.append(again);
  };

  button.addEventListener('click', async () => {
    try {
      pendingBridge?.close();
      status.textContent = 'Verbinde mit der Brücke …';
      const bridge = await open();
      pendingBridge = bridge;
      const s = await bridge.status();
      status.textContent = describe(s);
      if (s.connected) return await useBridge(bridge, status);
      if (s.address) {
        try {
          return await connectEv3(bridge);
        } catch {
          // The last brick is off or out of range; offer a scan instead.
        }
      }
      await showScan(bridge);
    } catch (e) {
      const message = (e as Error).message;
      status.textContent = /cancel/i.test(message) ? '' : message;
    }
  });

  return section(title, button, status, list, hints(...tips));
}

/** Shows whether the bridge and its EV3 are connected, without changing anything. */
async function showBridgeStatus(url: string, target: HTMLElement): Promise<void> {
  target.textContent = 'Prüfe Brücke …';
  try {
    const bridge = await WsBridge.open(url);
    target.textContent = describe(await bridge.status());
    bridge.close();
  } catch {
    target.textContent = 'Brücke nicht erreichbar';
  }
}

function serialSection(): HTMLElement {
  const status = el('p', 'status');
  const btn = el('button', 'btn primary', 'Seriellen Port wählen …');
  btn.addEventListener('click', () => connectWith('serial', () => SerialTransport.open(), status));
  return section(
    'EV3 am Computer (Chrome/Edge)',
    btn,
    status,
    hints(
      'EV3 vorher in den Bluetooth-Einstellungen des Computers koppeln (Code 1234).',
      'Am EV3 muss „iPhone/iPad/iPod“ dafür ausgeschaltet sein.',
      'Windows: den ausgehenden COM-Port wählen; macOS: „EV3-SerialPort“.',
    ),
  );
}

async function fillDialog(): Promise<void> {
  body.replaceChildren();
  if (state.brick) {
    const disconnect = el('button', 'btn danger', 'Trennen');
    disconnect.addEventListener('click', () => {
      state.setBrick(null, 'none');
      log('Verbindung getrennt');
      dialog.close();
    });
    const via = state.kind === 'bridge' ? ' (über die Brücke)' : '';
    body.append(section(`Verbunden: ${state.brick.name}${via}`, disconnect));
  }

  const bridgeUrl = bridgeUrlFromPage();
  if (bridgeUrl) {
    const wlan = bridgeSection('EV3 über die Brücke (WLAN)', 'Verbinden', () => WsBridge.open(bridgeUrl), [
      'Am EV3: Bluetooth und Sichtbarkeit an, „iPhone/iPad/iPod“ aus.',
      'Beim ersten Verbinden fragt der EV3 nach dem Code 1234 – bestätigen.',
      'Leuchte am Pi: Dauerlicht = mit EV3 verbunden, langsames Blinken = wartet.',
    ]);
    if (state.kind !== 'bridge') void showBridgeStatus(bridgeUrl, wlan.querySelector('.status')!);
    body.append(wlan);
  }
  if (webBluetoothAvailable() && !iosBluetoothAvailable()) {
    body.append(
      bridgeSection('EV3 über die Brücke (Bluetooth)', 'Brücke suchen …', () => BleBridge.request(), [
        'Brücke (Raspberry Pi) einschalten und ca. 40 Sekunden warten.',
        'Am EV3: Bluetooth und Sichtbarkeit an, „iPhone/iPad/iPod“ aus.',
        'Beim ersten Verbinden fragt der EV3 nach dem Code 1234 – bestätigen.',
      ]),
    );
  }
  if (iosBluetoothAvailable()) body.append(await iosSection());
  if (serialAvailable()) body.append(serialSection());
  if (!bridgeUrl && !iosBluetoothAvailable() && !serialAvailable() && !webBluetoothAvailable()) {
    const p = el('p', 'muted');
    p.innerHTML =
      'Dieser Browser kann kein Bluetooth. Mit der OpenStorm-Brücke öffnest du die App im selben WLAN unter ' +
      '<a href="http://openstorm.local/">http://openstorm.local</a> – dann klappt es auch in Safari.';
    body.append(section('Echter EV3', p));
  }

  const sim = el('button', 'btn', 'Simulator starten');
  sim.addEventListener('click', () => {
    state.setBrick(new SimBrick(), 'sim');
    log('Simulator gestartet – Sensorwerte lassen sich unter „Geräte“ einstellen.');
    dialog.close();
  });
  body.append(section('Ohne EV3 ausprobieren', sim));
}

export function initConnect(d: HTMLDialogElement): void {
  dialog = d;
  body = d.querySelector('.dialog-body')!;
  d.querySelector('.dialog-close')!.addEventListener('click', () => d.close());
  d.addEventListener('close', () => {
    pendingBridge?.close();
    pendingBridge = null;
  });
}

/**
 * When the app was loaded from the bridge, connect right away – to the EV3 the
 * bridge holds or used last. Nothing happens if no EV3 is known yet.
 */
export async function autoConnect(): Promise<void> {
  const url = bridgeUrlFromPage();
  if (!url || state.brick) return;
  const quiet = el('p');
  try {
    const bridge = await WsBridge.open(url);
    const s = await bridge.status();
    if (!s.connected && !s.address) {
      bridge.close();
      log('Brücke bereit. Tippe oben rechts auf „Nicht verbunden“, um einen EV3 auszuwählen.');
      return;
    }
    if (!s.connected) {
      log(`Verbinde mit EV3 „${s.name}“ …`);
      await bridge.connectEv3();
    }
    await useBridge(bridge, quiet);
  } catch (e) {
    log(`Automatisches Verbinden fehlgeschlagen: ${(e as Error).message}`, 'error');
  }
}

export function openConnectDialog(): void {
  void fillDialog();
  dialog.showModal();
}
