import { MOTOR_PORTS, type MotorPort, type Port, type PortState } from '../ev3/brick';
import type { ButtonName, LedPattern } from '../ev3/bytecodes';
import { COLOR_CSS, COLOR_NAMES, DEVICES, TYPE_NONE, deviceName, isMotorType } from '../ev3/devices';
import { SimBrick } from '../ev3/simbrick';
import { state } from '../state';
import { log } from './console';

const POLL_MS = 300;

interface Card {
  type: number;
  el: HTMLElement;
  value: HTMLElement;
  mode: HTMLSelectElement | null;
  /** Mode chosen in the card; null = keep what the brick currently uses. */
  selectedMode: number | null;
  update?: (value: number, mode: number) => void;
}

let root: HTMLElement;
let visible = false;
let polling = false;
const cards = new Map<Port, Card>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, label);
  b.addEventListener('click', onClick);
  return b;
}

/** Runs `onPress` while the button is held down (works for touch and mouse). */
function holdButton(label: string, cls: string, onPress: () => void, onRelease: () => void): HTMLButtonElement {
  const b = el('button', cls, label);
  let held = false;
  b.addEventListener('pointerdown', (e) => {
    held = true;
    b.setPointerCapture(e.pointerId);
    b.classList.add('held');
    onPress();
  });
  const release = () => {
    if (!held) return;
    held = false;
    b.classList.remove('held');
    onRelease();
  };
  b.addEventListener('pointerup', release);
  b.addEventListener('pointercancel', release);
  return b;
}

function act(promise: Promise<unknown> | undefined): void {
  promise?.catch((e: Error) => log(e.message, 'error'));
}

function formatValue(type: number, mode: number, value: number): string {
  if (!Number.isFinite(value)) return '–';
  if (type === 29 && mode === 2) return COLOR_NAMES[Math.round(value)] ?? String(value);
  if ((type === 16 || type === 1) && mode === 0) return value > 0.5 ? 'gedrückt' : 'nicht gedrückt';
  const unit = DEVICES[type]?.modes[mode]?.unit ?? '';
  const rounded = Math.abs(value) >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1);
  return `${rounded}${unit ? ' ' + unit : ''}`;
}

function buildCard(port: Port, type: number, mode: number): Card {
  const isMotor = MOTOR_PORTS.includes(port as MotorPort);
  const card = el('div', `port-card ${isMotor ? 'motor' : 'sensor'}${type === TYPE_NONE ? ' empty' : ''}`);
  const head = el('div', 'port-head');
  head.append(el('span', 'port-label', port), el('span', 'port-device', deviceName(type)));
  card.append(head);

  const value = el('div', 'port-value', type === TYPE_NONE ? '' : '…');
  card.append(value);
  const result: Card = { type, el: card, value, mode: null, selectedMode: null };

  const modes = DEVICES[type]?.modes ?? [];
  if (modes.length > 1) {
    const select = el('select', 'port-mode');
    modes.forEach((m, i) => select.add(new Option(`${m.name}${m.unit ? ` (${m.unit})` : ''}`, String(i))));
    select.value = String(Math.max(0, mode));
    select.addEventListener('change', () => (result.selectedMode = Number(select.value)));
    card.append(select);
    result.mode = select;
  }

  if (isMotorType(type)) card.append(motorControls(port as MotorPort));

  const sim = state.brick instanceof SimBrick ? state.brick : null;
  if (sim) card.append(simControls(sim, port, result));
  return result;
}

function motorControls(port: MotorPort): HTMLElement {
  const box = el('div', 'motor-controls');
  const speed = el('input', 'speed');
  speed.type = 'range';
  speed.min = '0';
  speed.max = '100';
  speed.value = '50';
  const speedLabel = el('span', 'speed-label', '50 %');
  speed.addEventListener('input', () => (speedLabel.textContent = `${speed.value} %`));
  const run = (dir: number) => act(state.brick?.motorStart([port], dir * Number(speed.value)));
  const stop = () => act(state.brick?.motorStop([port], true));
  const row = el('div', 'row');
  row.append(
    holdButton('◀ zurück', 'btn', () => run(-1), stop),
    holdButton('vor ▶', 'btn', () => run(1), stop),
    button('0°', 'btn ghost', () => act(state.brick?.motorResetCount([port]))),
  );
  const speedRow = el('label', 'speed-row');
  speedRow.append('Tempo', speed, speedLabel);
  box.append(speedRow, row);
  return box;
}

const SIM_TYPES: Record<string, number[]> = {
  sensor: [TYPE_NONE, 16, 29, 30, 32, 33],
  motor: [TYPE_NONE, 7, 8],
};

function simControls(sim: SimBrick, port: Port, card: Card): HTMLElement {
  const box = el('div', 'sim-controls');
  const isMotor = MOTOR_PORTS.includes(port as MotorPort);
  const typeSelect = el('select');
  for (const t of SIM_TYPES[isMotor ? 'motor' : 'sensor']) typeSelect.add(new Option(deviceName(t), String(t)));
  typeSelect.value = String(sim.types[port]);
  typeSelect.addEventListener('change', () => {
    sim.types[port] = Number(typeSelect.value);
    sim.modes[port] = 0;
    void refresh();
  });
  const typeRow = el('label', 'sim-row');
  typeRow.append('Simuliert:', typeSelect);
  box.append(typeRow);
  if (isMotor || card.type === TYPE_NONE) return box;

  const row = el('div', 'sim-row');
  const type = card.type;
  if (type === 16) {
    row.append(holdButton('Taster drücken', 'btn', () => sim.setSensorValue(port, 1), () => sim.setSensorValue(port, 0)));
  } else {
    const color = el('select');
    COLOR_NAMES.forEach((name, i) => color.add(new Option(name, String(i))));
    color.addEventListener('change', () => sim.setSensorValue(port, Number(color.value)));
    const range = el('input');
    range.type = 'range';
    const limits: Record<number, [number, number]> = { 29: [0, 100], 30: [0, 255], 32: [-360, 360], 33: [0, 100] };
    [range.min, range.max] = (limits[type] ?? [0, 100]).map(String);
    range.addEventListener('input', () => sim.setSensorValue(port, Number(range.value)));
    row.append(color, range);
    card.update = (value, mode) => {
      const isColor = type === 29 && mode === 2;
      color.hidden = !isColor;
      range.hidden = isColor;
      if (document.activeElement !== range) range.value = String(value);
      if (document.activeElement !== color) color.value = String(Math.round(value));
    };
  }
  box.append(row);
  return box;
}

function brickCard(): HTMLElement {
  const brick = state.brick!;
  const card = el('div', 'brick-card');
  const head = el('div', 'brick-head');
  head.append(el('strong', '', brick.name), el('span', 'battery', ''));
  card.append(head);

  const leds: [string, LedPattern][] = [['grün', 'green'], ['orange', 'orange'], ['rot', 'red'], ['blinken', 'green_flash'], ['aus', 'off']];
  const ledRow = el('div', 'row');
  ledRow.append(el('span', 'row-label', 'Leuchte'));
  for (const [label, pattern] of leds) {
    ledRow.append(button(label, `btn led led-${pattern}`, () => act(state.brick?.setLed(pattern))));
  }

  const toneRow = el('div', 'row');
  toneRow.append(el('span', 'row-label', 'Ton'));
  for (const [label, freq] of [['tief', 262], ['mittel', 440], ['hoch', 880]] as const) {
    toneRow.append(button(label, 'btn', () => act(state.brick?.playTone(50, freq, 300))));
  }

  const displayRow = el('div', 'row');
  displayRow.append(
    el('span', 'row-label', 'Anzeige'),
    button('„Hallo!“ zeigen', 'btn', () => act(state.brick?.displayText('Hallo!', 2))),
    button('löschen', 'btn ghost', () => act(state.brick?.displayClear())),
  );
  card.append(ledRow, toneRow, displayRow);

  if (brick instanceof SimBrick) card.append(simBrickPanel(brick));
  return card;
}

function simBrickPanel(sim: SimBrick): HTMLElement {
  const box = el('div', 'sim-brick');
  const screen = el('pre', 'ev3-screen');
  const led = el('div', 'ev3-led');
  const buttons = el('div', 'ev3-buttons');
  const names: [ButtonName, string][] = [['up', '▲'], ['left', '◀'], ['enter', '●'], ['right', '▶'], ['down', '▼']];
  for (const [name, label] of names) {
    buttons.append(holdButton(label, `ev3-btn ev3-btn-${name}`, () => sim.pressedButtons.add(name), () => sim.pressedButtons.delete(name)));
  }
  const render = () => {
    screen.textContent = sim.display.join('\n');
    led.dataset.led = sim.led;
  };
  render();
  const unsubscribe = sim.subscribe(render);
  // Stop listening once the panel is removed (re-render or disconnect).
  const observer = new MutationObserver(() => {
    if (!box.isConnected) {
      unsubscribe();
      observer.disconnect();
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  box.append(screen, led, buttons);
  return box;
}

function render(): void {
  cards.clear();
  root.replaceChildren();
  if (!state.brick) {
    const empty = el('div', 'empty-state');
    empty.append(el('h2', '', 'Kein EV3 verbunden'), el('p', '', 'Verbinde oben rechts einen EV3 oder starte den Simulator, um Motoren und Sensoren zu testen.'));
    root.append(empty);
    return;
  }
  const grid = el('div', 'device-grid');
  grid.id = 'device-grid';
  root.append(brickCard(), grid);
}

async function refresh(): Promise<void> {
  const brick = state.brick;
  const grid = document.getElementById('device-grid');
  if (!brick || !grid) return;
  const states: PortState[] = await brick.readPortStates();
  if (brick !== state.brick) return;

  for (const s of states) {
    let card = cards.get(s.port);
    if (!card || card.type !== s.type) {
      const fresh = buildCard(s.port, s.type, s.mode);
      if (card) card.el.replaceWith(fresh.el);
      else grid.append(fresh.el);
      cards.set(s.port, fresh);
      card = fresh;
    }
    if (card.mode) card.mode.disabled = state.running;
  }

  // While a program runs, read in the mode the program uses instead of switching it.
  const requests = states
    .filter((s) => s.type !== TYPE_NONE && DEVICES[s.type])
    .map((s) => {
      const card = cards.get(s.port)!;
      const mode = !state.running && card.selectedMode !== null ? card.selectedMode : Math.max(0, s.mode);
      return { port: s.port, mode };
    });
  const values = await brick.readPorts(requests);
  if (brick !== state.brick) return;
  requests.forEach(({ port, mode }, i) => {
    const card = cards.get(port)!;
    card.value.textContent = formatValue(card.type, mode, values[i]);
    card.value.style.setProperty('--swatch', card.type === 29 && mode === 2 ? COLOR_CSS[Math.round(values[i])] ?? '' : '');
    card.value.classList.toggle('swatch', card.type === 29 && mode === 2);
    if (card.mode && document.activeElement !== card.mode) card.mode.value = String(mode);
    card.update?.(values[i], mode);
  });
}

async function refreshBattery(): Promise<void> {
  const brick = state.brick;
  const label = root.querySelector('.battery');
  if (!brick || !label) return;
  const { voltage, percent } = await brick.battery();
  label.textContent = `Akku ${percent} % · ${voltage.toFixed(1)} V`;
}

async function pollLoop(): Promise<void> {
  if (polling) return;
  polling = true;
  let ticks = 0;
  while (visible && state.brick) {
    try {
      await refresh();
      if (ticks++ % 20 === 0) await refreshBattery();
    } catch (e) {
      // Single failed polls are normal when Bluetooth hiccups; only report persistent trouble.
      if (ticks % 10 === 0) log(`Geräte lesen: ${(e as Error).message}`, 'error');
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  polling = false;
}

export function initDevices(container: HTMLElement): void {
  root = container;
  let lastBrick = state.brick;
  state.subscribe(() => {
    if (state.brick !== lastBrick) {
      lastBrick = state.brick;
      render();
      if (visible) void pollLoop();
    }
  });
  render();
}

export function setDevicesVisible(v: boolean): void {
  visible = v;
  if (v) void pollLoop();
}
