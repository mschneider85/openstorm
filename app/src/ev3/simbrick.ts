import type { ButtonName, LedPattern } from './bytecodes';
import { ALL_PORTS, MOTOR_PORTS, type Brick, type MotorPort, type Port, type PortState } from './brick';
import { DEVICES, TYPE_NONE } from './devices';
import { SCREEN_WIDTH, type DrawOp } from './display';
import { SAMPLE_RATE, soundSamples } from './sounds';

/** Degrees per second at 100 % speed (a large motor does roughly 170 rpm). */
const DEG_PER_S_AT_FULL = 1000;
const TICK_MS = 20;

interface SimMotor {
  position: number;
  speed: number;
  /** Remaining degrees (or ms when `byTime`) until the motor stops by itself. */
  remaining: number | null;
  byTime: boolean;
  brake: boolean;
}

/**
 * A virtual EV3 that runs inside the browser. Motors integrate their position
 * over time, sensor values can be set from the UI, tones play via WebAudio.
 */
export class SimBrick implements Brick {
  readonly name = 'Simulator';
  readonly types: Record<Port, number> = {
    '1': 16, '2': 32, '3': 29, '4': 30,
    A: 8, B: 7, C: 7, D: TYPE_NONE,
  };
  readonly modes: Record<Port, number> = { '1': 0, '2': 0, '3': 0, '4': 0, A: 0, B: 0, C: 0, D: 0 };
  /** Simulated sensor value per port and mode, editable from the UI. */
  readonly sensorValues: Record<string, number[]> = {
    '1': [0, 0],
    '2': [0, 0],
    '3': [50, 20, 0],
    '4': [42, 16.5, 0],
  };
  /** Everything drawn since the screen was last cleared. */
  screen: DrawOp[] = [];
  /** Increases with every change of `screen`. */
  screenVersion = 0;
  readonly pressedButtons = new Set<ButtonName>();
  led: LedPattern = 'green';

  private motors = new Map<MotorPort, SimMotor>(
    MOTOR_PORTS.map((p) => [p, { position: 0, speed: 0, remaining: null, byTime: false, brake: true }]),
  );
  private timer = setInterval(() => this.tick(), TICK_MS);
  private audio: AudioContext | null = null;
  private oscillator: AudioScheduledSourceNode | null = null;
  private listeners = new Set<() => void>();

  /** Registers a callback for any visible state change; returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  close(): void {
    clearInterval(this.timer);
    this.oscillator?.stop();
    void this.audio?.close();
  }

  private tick(): void {
    let moved = false;
    for (const m of this.motors.values()) {
      if (m.speed === 0) continue;
      moved = true;
      const delta = (m.speed / 100) * DEG_PER_S_AT_FULL * (TICK_MS / 1000);
      if (m.remaining === null) {
        m.position += delta;
        continue;
      }
      const step = m.byTime ? TICK_MS : Math.abs(delta);
      const fraction = Math.min(1, m.remaining / step);
      m.position += delta * fraction;
      m.remaining -= step;
      if (m.remaining <= 0) {
        m.speed = 0;
        m.remaining = null;
      }
    }
    if (moved) this.changed();
  }

  motorPosition(port: MotorPort): number {
    return this.motors.get(port)!.position;
  }

  motorSpeed(port: MotorPort): number {
    return this.motors.get(port)!.speed;
  }

  private drive(port: MotorPort, speed: number, remaining: number | null, byTime: boolean, brake: boolean): void {
    if (this.types[port] === TYPE_NONE) return;
    const m = this.motors.get(port)!;
    m.speed = Math.max(-100, Math.min(100, speed));
    m.remaining = remaining;
    m.byTime = byTime;
    m.brake = brake;
  }

  async motorStart(ports: MotorPort[], speed: number): Promise<void> {
    for (const p of ports) this.drive(p, speed, null, false, true);
  }

  async motorPower(ports: MotorPort[], power: number): Promise<void> {
    for (const p of ports) this.drive(p, power, null, false, true);
  }

  async motorStop(ports: MotorPort[]): Promise<void> {
    for (const p of ports) this.drive(p, 0, null, false, true);
    this.changed();
  }

  async motorRunDegrees(ports: MotorPort[], speed: number, degrees: number, brake: boolean): Promise<void> {
    const s = degrees < 0 ? -speed : speed;
    for (const p of ports) this.drive(p, s, Math.abs(degrees), false, brake);
  }

  async motorRunTime(ports: MotorPort[], speed: number, ms: number, brake: boolean): Promise<void> {
    for (const p of ports) this.drive(p, speed, ms, true, brake);
  }

  async steerDegrees(ports: MotorPort[], speed: number, turn: number, degrees: number, brake: boolean): Promise<void> {
    const s = degrees < 0 ? -speed : speed;
    const [a, b] = steerSpeeds(s, turn);
    // The faster motor covers `degrees`, the slower one proportionally fewer in the same time.
    const fastest = Math.max(Math.abs(a), Math.abs(b)) || 1;
    const share = (v: number) => (degrees === 0 ? null : (Math.abs(degrees) * Math.abs(v)) / fastest);
    this.drive(ports[0], a, share(a), false, brake);
    this.drive(ports[1], b, share(b), false, brake);
  }

  async steerTime(ports: MotorPort[], speed: number, turn: number, ms: number, brake: boolean): Promise<void> {
    const [a, b] = steerSpeeds(speed, turn);
    this.drive(ports[0], a, ms, true, brake);
    this.drive(ports[1], b, ms, true, brake);
  }

  async motorBusy(ports: MotorPort[]): Promise<boolean> {
    return ports.some((p) => this.motors.get(p)!.speed !== 0);
  }

  async motorResetCount(ports: MotorPort[]): Promise<void> {
    for (const p of ports) this.motors.get(p)!.position = 0;
    this.changed();
  }

  async readPort(port: Port, mode: number): Promise<number> {
    if (this.types[port] === TYPE_NONE) return NaN;
    if (mode >= 0 && mode < (DEVICES[this.types[port]]?.modes.length ?? 0)) this.modes[port] = mode;
    const motor = this.motors.get(port as MotorPort);
    if (motor) {
      if (this.modes[port] === 1) return motor.position / 360;
      if (this.modes[port] === 2) return motor.speed;
      return Math.round(motor.position);
    }
    return this.sensorValues[port]?.[this.modes[port]] ?? 0;
  }

  async readPorts(requests: { port: Port; mode: number }[]): Promise<number[]> {
    return Promise.all(requests.map((r) => this.readPort(r.port, r.mode)));
  }

  async readPortValues(port: Port, mode: number, count: number): Promise<number[]> {
    const values = Array<number>(count).fill(0);
    if (this.types[port] === TYPE_NONE) return values.fill(NaN);
    // Gyro mode 3 delivers angle and rate together (reading it does not reset the angle).
    if (this.types[port] === 32 && mode === 3) return [this.sensorValues[port]?.[0] ?? 0, this.sensorValues[port]?.[1] ?? 0].slice(0, count);
    values[0] = await this.readPort(port, mode);
    return values;
  }

  async readPortStates(): Promise<PortState[]> {
    return ALL_PORTS.map((port) => ({ port, type: this.types[port], mode: this.modes[port] }));
  }

  setSensorValue(port: Port, value: number): void {
    const values = this.sensorValues[port];
    if (values) values[this.modes[port]] = value;
    this.changed();
  }

  async playTone(volume: number, frequency: number, ms: number): Promise<void> {
    try {
      this.audio ??= new AudioContext();
      this.oscillator?.stop();
      const osc = this.audio.createOscillator();
      const gain = this.audio.createGain();
      osc.type = 'square';
      osc.frequency.value = frequency;
      gain.gain.value = (Math.max(0, Math.min(100, volume)) / 100) * 0.15;
      osc.connect(gain).connect(this.audio.destination);
      osc.start();
      osc.stop(this.audio.currentTime + ms / 1000);
      this.oscillator = osc;
    } catch {
      // No audio available (e.g. in tests) – the tone is simply not audible.
    }
  }

  async playSound(id: string, volume: number): Promise<void> {
    try {
      this.audio ??= new AudioContext();
      this.oscillator?.stop();
      const samples = soundSamples(id);
      const buffer = this.audio.createBuffer(1, samples.length, SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const source = this.audio.createBufferSource();
      const gain = this.audio.createGain();
      source.buffer = buffer;
      gain.gain.value = (Math.max(0, Math.min(100, volume)) / 100) * 0.3;
      source.connect(gain).connect(this.audio.destination);
      source.start();
      this.oscillator = source;
    } catch {
      // No audio available.
    }
  }

  async stopSound(): Promise<void> {
    this.oscillator?.stop();
    this.oscillator = null;
  }

  async setLed(pattern: LedPattern): Promise<void> {
    this.led = pattern;
    this.changed();
  }

  async buttonPressed(button: ButtonName): Promise<boolean> {
    return button === 'any' ? this.pressedButtons.size > 0 : this.pressedButtons.has(button);
  }

  /** Old blocks write lines of 16 pixels. */
  async displayText(text: string, line: number): Promise<void> {
    const y = (Math.max(1, Math.min(8, Math.round(line))) - 1) * 16;
    await this.draw([
      { op: 'rect', x: 0, y, w: SCREEN_WIDTH, h: 16, fill: true, ink: 0 },
      { op: 'text', x: 0, y, text: text.slice(0, 22), font: 0, ink: 1 },
    ]);
  }

  async displayClear(): Promise<void> {
    await this.draw([{ op: 'clear' }]);
  }

  async draw(ops: DrawOp[]): Promise<void> {
    const clear = ops.map((d) => d.op).lastIndexOf('clear');
    this.screen = clear >= 0 ? ops.slice(clear) : [...this.screen, ...ops].slice(-3000);
    this.screenVersion++;
    this.changed();
  }

  /** Texts on the screen, top to bottom (for tests). */
  get texts(): string[] {
    return this.screen.flatMap((d) => (d.op === 'text' ? [d.text] : []));
  }

  async battery(): Promise<{ voltage: number; percent: number }> {
    return { voltage: 7.9, percent: 87 };
  }
}

/** Speeds of master and slave motor for a firmware turn ratio (-200..200). */
export function steerSpeeds(speed: number, turn: number): [number, number] {
  const t = Math.max(-200, Math.min(200, turn));
  const factor = 1 - Math.abs(t) / 100;
  return t >= 0 ? [speed, speed * factor] : [speed * factor, speed];
}
