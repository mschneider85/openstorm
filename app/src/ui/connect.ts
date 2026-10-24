import { Ev3Brick } from '../ev3/ev3brick';
import { SimBrick } from '../ev3/simbrick';
import { BleBridge, webBluetoothAvailable, type Ev3Device } from '../transport/blebridge';
import { IosTransport, iosBluetoothAvailable, listPairedBricks, pairBrick } from '../transport/ios';
import { SerialTransport, serialAvailable } from '../transport/serial';
import type { Transport } from '../transport/transport';
import { state, type ConnectionKind } from '../state';
import { log } from './console';

let dialog: HTMLDialogElement;
let body: HTMLElement;
/** A bridge connected in the dialog but not (yet) used for a brick. */
let pendingBridge: BleBridge | null = null;

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

function bridgeSection(): HTMLElement {
  const status = el('p', 'status');
  const list = el('div', 'device-list');
  const find = el('button', 'btn primary', 'Brücke suchen …');

  const useBridge = (bridge: BleBridge) =>
    connectWith('bridge', async () => {
      pendingBridge = null;
      return bridge;
    }, status);

  const connectEv3 = async (bridge: BleBridge, device?: Ev3Device) => {
    list.replaceChildren();
    status.textContent = device
      ? `Verbinde mit ${device.name} … Beim ersten Mal die Kopplung am EV3 bestätigen.`
      : 'Verbinde mit dem zuletzt benutzten EV3 …';
    await bridge.connectEv3(device?.address);
    await useBridge(bridge);
  };

  const showScan = async (bridge: BleBridge) => {
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

  find.addEventListener('click', async () => {
    try {
      pendingBridge?.close();
      status.textContent = 'Wähle die Brücke „OpenStorm“ aus …';
      const bridge = await BleBridge.request();
      pendingBridge = bridge;
      status.textContent = 'Brücke verbunden.';
      const s = await bridge.status();
      if (s.connected) return await useBridge(bridge);
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

  return section(
    'EV3 über die OpenStorm-Brücke',
    find,
    status,
    list,
    hints(
      'Brücke (Raspberry Pi) einschalten und ca. 40 Sekunden warten.',
      'Am EV3: Bluetooth und Sichtbarkeit an, „iPhone/iPad/iPod“ aus.',
      'Beim ersten Verbinden fragt der EV3 nach dem Code 1234 – bestätigen.',
    ),
  );
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
    body.append(section(`Verbunden: ${state.brick.name}`, disconnect));
  }

  if (webBluetoothAvailable() && !iosBluetoothAvailable()) body.append(bridgeSection());
  if (iosBluetoothAvailable()) body.append(await iosSection());
  if (serialAvailable()) body.append(serialSection());
  if (!iosBluetoothAvailable() && !serialAvailable() && !webBluetoothAvailable()) {
    const p = el('p', 'muted');
    p.innerHTML =
      'Dieser Browser kann kein Bluetooth. Öffne OpenStorm auf dem iPad in der kostenlosen App ' +
      '<a href="https://apps.apple.com/app/id1492822055" target="_blank" rel="noopener">Bluefy</a>, ' +
      'am Computer in Chrome oder Edge.';
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

export function openConnectDialog(): void {
  void fillDialog();
  dialog.showModal();
}
