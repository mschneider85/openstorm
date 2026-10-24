import { Ev3Brick } from '../ev3/ev3brick';
import { SimBrick } from '../ev3/simbrick';
import { IosTransport, iosBluetoothAvailable, listPairedBricks, pairBrick } from '../transport/ios';
import { SerialTransport, serialAvailable } from '../transport/serial';
import type { Transport } from '../transport/transport';
import { state, type ConnectionKind } from '../state';
import { log } from './console';

let dialog: HTMLDialogElement;
let body: HTMLElement;

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

  if (iosBluetoothAvailable()) body.append(await iosSection());
  if (serialAvailable()) body.append(serialSection());
  if (!iosBluetoothAvailable() && !serialAvailable()) {
    body.append(
      section(
        'Echter EV3',
        el('p', 'muted', 'Dieser Browser kann nicht direkt mit dem EV3 sprechen. Nutze auf dem iPad die installierte OpenStorm-App oder am Computer Chrome/Edge.'),
      ),
    );
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
}

export function openConnectDialog(): void {
  void fillDialog();
  dialog.showModal();
}
