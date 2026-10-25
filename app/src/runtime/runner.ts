import { MOTOR_PORTS, type Brick, type MotorPort, type Port } from '../ev3/brick';
import type { ButtonName, LedPattern } from '../ev3/bytecodes';
import { SCREEN_HEIGHT, SCREEN_WIDTH, imageOps, lineOps, type DrawOp, type Ink } from '../ev3/display';
import { soundMs } from '../ev3/sounds';

export class StopError extends Error {
  constructor() {
    super('Programm gestoppt');
  }
}

/** Ends only one stack of blocks ("stoppe diesen Ablauf", or stopped from another stack). */
class StackStop extends StopError {}

export type Unit = 'rotations' | 'degrees' | 'seconds';
export type MoveUnit = Unit | 'cm' | 'in';
type Compare = 'LT' | 'EQ' | 'GT' | 'CHANGE';
type Body = (api: ProgramApi) => Promise<void>;

/** A stack of blocks under an event block, as produced by the generator. */
export type Thread =
  | { kind: 'start'; body: Body }
  | { kind: 'when'; cond: (api: ProgramApi) => Promise<boolean>; body: Body }
  | { kind: 'message'; name: string; body: Body };

const POLL_MS = 40;
/** Longest tone the firmware plays (DATA16 milliseconds): "starte Ton" until something else plays. */
export const ENDLESS_TONE_MS = 32767;
const BUTTON_NUMBERS: [ButtonName, number][] = [['left', 1], ['enter', 2], ['right', 3], ['up', 4], ['down', 5]];

export interface RunHooks {
  onStep: (blockId: string) => void;
  onPrint: (text: string) => void;
}

/** One running stack; stopping it ends only this stack. */
interface Run {
  api: ProgramApi;
  done: Promise<void>;
}

/** State of a program that all its stacks share (motor settings, sensor calibration, ...). */
class Program {
  startTime = performance.now();
  motors = Object.fromEntries(MOTOR_PORTS.map((p) => [p, { speed: 75, hold: true }])) as Record<MotorPort, { speed: number; hold: boolean }>;
  move = { left: 'B' as MotorPort, right: 'C' as MotorPort, speed: 50, hold: true, cmPerRotation: 17.6 };
  volume = 100;
  gyroOffset: Partial<Record<Port, number>> = {};
  light: Partial<Record<Port, { min: number; max: number }>> = {};
  /** Reference values for "ändert sich um mehr als" and edge detection, per block. */
  refs = new Map<string, number>();
  runs = new Set<Run>();
  receivers = new Map<string, { body: Body; run: Run | null }[]>();
  error: unknown = null;

  constructor(
    readonly brick: Brick,
    readonly abort: AbortController,
    readonly hooks: RunHooks,
  ) {}

  fail(e: unknown): void {
    this.error ??= e;
    this.abort.abort();
  }
}

/**
 * The functions available to generated block code as `api.*`.
 * Each stack of blocks gets its own instance, so it can be stopped on its own;
 * every call checks for a stop request, so a running program ends promptly.
 */
export class ProgramApi {
  private lastYield = performance.now();
  private own = new AbortController();

  private constructor(private p: Program, parent: AbortSignal) {
    if (parent.aborted) this.own.abort();
    else parent.addEventListener('abort', () => this.own.abort(), { once: true });
  }

  static create(brick: Brick, abort: AbortController, hooks: RunHooks): ProgramApi {
    return new ProgramApi(new Program(brick, abort, hooks), abort.signal);
  }

  private get brick(): Brick {
    return this.p.brick;
  }

  private fork(): ProgramApi {
    return new ProgramApi(this.p, this.p.abort.signal);
  }

  private check(): void {
    if (this.own.signal.aborted) throw this.p.abort.signal.aborted ? new StopError() : new StackStop();
  }

  /** Called before every statement block (highlighting). */
  async step(blockId: string): Promise<void> {
    this.check();
    this.p.hooks.onStep(blockId);
    await this.tick();
  }

  /** Called in every loop iteration; yields now and then to keep the UI responsive. */
  async tick(): Promise<void> {
    this.check();
    if (performance.now() - this.lastYield > 30) {
      await new Promise((r) => setTimeout(r, 0));
      this.lastYield = performance.now();
      this.check();
    }
  }

  sleep(ms: number): Promise<void> {
    this.check();
    const signal = this.own.signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(this.p.abort.signal.aborted ? new StopError() : new StackStop());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async wait(seconds: number): Promise<void> {
    await this.sleep(Number(seconds) * 1000);
  }

  async waitFor(cond: () => Promise<boolean>): Promise<void> {
    while (!(await cond())) await this.sleep(POLL_MS);
  }

  // --- Stacks, events and messages ---------------------------------------------------

  /** Starts all stacks and returns when the program is over. */
  async runThreads(threads: Thread[]): Promise<void> {
    for (const t of threads) {
      if (t.kind !== 'message') continue;
      const list = this.p.receivers.get(t.name) ?? [];
      list.push({ body: t.body, run: null });
      this.p.receivers.set(t.name, list);
    }
    const tasks = threads.map((t) => {
      if (t.kind === 'start') return this.startRun(t.body).done;
      if (t.kind === 'when') return this.listen(t.cond, t.body);
      return Promise.resolve();
    });
    try {
      await Promise.all(tasks);
      // Stacks started by messages may still be running.
      while (this.p.runs.size) await Promise.all([...this.p.runs].map((r) => r.done));
    } catch (e) {
      if (this.p.error) throw this.p.error;
      throw e;
    }
    if (this.p.error) throw this.p.error;
  }

  private startRun(body: Body): Run {
    const api = this.fork();
    const run: Run = { api, done: Promise.resolve() };
    this.p.runs.add(run);
    run.done = body(api)
      .catch((e: unknown) => {
        if (e instanceof StackStop) return;
        if (e instanceof StopError) throw e;
        this.p.fail(e);
        throw e;
      })
      .finally(() => this.p.runs.delete(run));
    run.done.catch(() => {});
    return run;
  }

  /** "Wenn …": runs the stack each time the condition becomes true. */
  private async listen(cond: (api: ProgramApi) => Promise<boolean>, body: Body): Promise<void> {
    const api = this.fork();
    for (;;) {
      await api.waitFor(() => cond(api));
      await this.startRun(body).done.catch((e: unknown) => {
        if (!(e instanceof StackStop)) throw e;
      });
      while (await cond(api)) await api.sleep(POLL_MS);
    }
  }

  /** "sende": (re)starts every stack waiting for this message. */
  broadcast(name: string): Run[] {
    this.check();
    return (this.p.receivers.get(String(name)) ?? []).map((r) => {
      r.run?.api.own.abort();
      r.run = this.startRun(r.body);
      return r.run;
    });
  }

  async broadcastWait(name: string): Promise<void> {
    const runs = this.broadcast(name);
    await Promise.all(runs.map((r) => r.done.catch((e: unknown) => {
      if (!(e instanceof StackStop)) throw e;
    })));
    this.check();
  }

  /** "stoppe alles / diesen Ablauf / und beende das Programm" */
  stop(what: 'all' | 'this' | 'exit'): never {
    if (what !== 'this') {
      this.p.abort.abort();
      throw new StopError();
    }
    throw new StackStop();
  }

  stopOthers(): void {
    this.check();
    for (const run of this.p.runs) if (run.api !== this) run.api.own.abort();
  }

  // --- Motors ---------------------------------------------------------------------

  private async untilIdle(ports: MotorPort[]): Promise<void> {
    while (await this.brick.motorBusy(ports)) await this.sleep(POLL_MS);
  }

  /** Runs every port at its own speed for an amount, then waits until all are done. */
  private async runEach(ports: MotorPort[], speeds: number[], amount: number, unit: Unit): Promise<void> {
    this.check();
    amount = Number(amount);
    if (unit === 'seconds') {
      const ms = Math.round(amount * 1000);
      if (ms <= 0) return;
      for (const [k, p] of ports.entries()) await this.brick.motorRunTime([p], speeds[k], ms, this.p.motors[p].hold);
      await this.sleep(ms);
    } else {
      const degrees = Math.round(unit === 'rotations' ? amount * 360 : amount);
      if (degrees === 0) return;
      for (const [k, p] of ports.entries()) await this.brick.motorRunDegrees([p], speeds[k], degrees, this.p.motors[p].hold);
    }
    await this.untilIdle(ports);
  }

  async motorRunFor(ports: MotorPort[], dir: number, amount: number, unit: Unit): Promise<void> {
    await this.runEach(ports, ports.map((p) => this.p.motors[p].speed * dir), amount, unit);
  }

  async motorRunForSpeed(ports: MotorPort[], amount: number, unit: Unit, speed: number): Promise<void> {
    await this.runEach(ports, ports.map(() => clamp(Number(speed), -100, 100)), amount, unit);
  }

  async motorStartDir(ports: MotorPort[], dir: number): Promise<void> {
    this.check();
    for (const p of ports) await this.brick.motorStart([p], this.p.motors[p].speed * dir);
  }

  async motorStartPower(ports: MotorPort[], power: number): Promise<void> {
    this.check();
    await this.brick.motorPower(ports, clamp(Number(power), -100, 100));
  }

  async motorStop(ports: MotorPort[]): Promise<void> {
    this.check();
    for (const p of ports) await this.brick.motorStop([p], this.p.motors[p].hold);
  }

  motorSetSpeed(ports: MotorPort[], speed: number): void {
    this.check();
    for (const p of ports) this.p.motors[p].speed = clamp(Number(speed), -100, 100);
  }

  motorSetStop(ports: MotorPort[], action: 'hold' | 'coast'): void {
    this.check();
    for (const p of ports) this.p.motors[p].hold = action === 'hold';
  }

  async motorOn(ports: MotorPort[], speed: number): Promise<void> {
    this.check();
    await this.brick.motorStart(ports, Number(speed));
  }

  async motorOff(ports: MotorPort[], brake: boolean): Promise<void> {
    this.check();
    await this.brick.motorStop(ports, brake);
  }

  /** Older block "Motor … Geschwindigkeit … für …, dann bremsen/ausrollen". */
  async motorFor(ports: MotorPort[], speed: number, amount: number, unit: Unit, brake: boolean): Promise<void> {
    this.check();
    amount = Number(amount);
    if (unit === 'seconds') {
      const ms = Math.round(amount * 1000);
      await this.brick.motorRunTime(ports, Number(speed), ms, brake);
      await this.sleep(ms);
    } else {
      const degrees = Math.round(unit === 'rotations' ? amount * 360 : amount);
      if (degrees === 0) return;
      await this.brick.motorRunDegrees(ports, Number(speed), degrees, brake);
    }
    await this.untilIdle(ports);
  }

  async motorDegrees(port: MotorPort): Promise<number> {
    return this.read(port, 0);
  }

  async motorSpeed(port: MotorPort): Promise<number> {
    return this.read(port, 2);
  }

  async motorReset(port: MotorPort): Promise<void> {
    this.check();
    await this.brick.motorResetCount([port]);
  }

  // --- Movement ---------------------------------------------------------------------

  /** Movement motors ordered by port number, as the firmware synchronizes them, and whether left is the second. */
  private pair(): { ports: MotorPort[]; swapped: boolean } {
    const { left, right } = this.p.move;
    return left < right ? { ports: [left, right], swapped: false } : { ports: [right, left], swapped: true };
  }

  private toDegrees(amount: number, unit: MoveUnit): number {
    const cm = unit === 'in' ? amount * 2.54 : amount;
    if (unit === 'cm' || unit === 'in') return Math.round((cm / this.p.move.cmPerRotation) * 360);
    return Math.round(unit === 'rotations' ? amount * 360 : amount);
  }

  /** Synchronized movement with a firmware turn ratio (-200..200, positive turns right). */
  private async sync(speed: number, turn: number, amount: number | null, unit: MoveUnit): Promise<void> {
    this.check();
    const { ports, swapped } = this.pair();
    const t = clamp(swapped ? -turn : turn, -200, 200);
    const s = clamp(speed, -100, 100);
    const hold = this.p.move.hold;
    if (amount === null) {
      await this.brick.steerDegrees(ports, s, t, 0, hold);
      return;
    }
    if (unit === 'seconds') {
      const ms = Math.round(Number(amount) * 1000);
      if (ms <= 0) return;
      await this.brick.steerTime(ports, s, t, ms, hold);
      await this.sleep(ms);
    } else {
      const degrees = this.toDegrees(Number(amount), unit);
      if (degrees === 0) return;
      await this.brick.steerDegrees(ports, s, t, degrees, hold);
    }
    await this.untilIdle(ports);
  }

  /** Speed and turn ratio for separate left and right speeds ("Panzersteuerung"). */
  private tank(left: number, right: number): [number, number] {
    const l = clamp(Number(left), -100, 100);
    const r = clamp(Number(right), -100, 100);
    if (l === 0 && r === 0) return [0, 0];
    return Math.abs(l) >= Math.abs(r) ? [l, 100 * (1 - r / l)] : [r, -100 * (1 - l / r)];
  }

  private direction(dir: string): [number, number] {
    const speed = this.p.move.speed;
    if (dir === 'back') return [-speed, 0];
    if (dir === 'right') return [speed, 200];
    if (dir === 'left') return [speed, -200];
    return [speed, 0];
  }

  async moveFor(dir: string, amount: number, unit: MoveUnit): Promise<void> {
    const [speed, turn] = this.direction(dir);
    await this.sync(speed, turn, amount, unit);
  }

  async moveStart(dir: string): Promise<void> {
    const [speed, turn] = this.direction(dir);
    await this.sync(speed, turn, null, 'degrees');
  }

  async moveSteerFor(steering: number, amount: number, unit: MoveUnit, speed = this.p.move.speed): Promise<void> {
    await this.sync(Number(speed), Number(steering) * 2, amount, unit);
  }

  async moveSteerStart(steering: number, speed = this.p.move.speed): Promise<void> {
    await this.sync(Number(speed), Number(steering) * 2, null, 'degrees');
  }

  async moveTankFor(amount: number, unit: MoveUnit, left: number, right: number): Promise<void> {
    const [speed, turn] = this.tank(left, right);
    if (speed === 0) return;
    await this.sync(speed, turn, amount, unit);
  }

  async moveTankStart(left: number, right: number): Promise<void> {
    const [speed, turn] = this.tank(left, right);
    if (speed === 0) await this.moveStop();
    else await this.sync(speed, turn, null, 'degrees');
  }

  async moveStop(): Promise<void> {
    this.check();
    await this.brick.motorStop(this.pair().ports, this.p.move.hold);
  }

  moveSetSpeed(speed: number): void {
    this.check();
    this.p.move.speed = clamp(Number(speed), -100, 100);
  }

  moveSetMotors(ports: string): void {
    this.check();
    this.p.move.left = ports[0] as MotorPort;
    this.p.move.right = ports[1] as MotorPort;
  }

  moveSetStop(action: 'hold' | 'coast'): void {
    this.check();
    this.p.move.hold = action === 'hold';
  }

  moveSetRotation(distance: number, unit: 'cm' | 'in'): void {
    this.check();
    const cm = Number(distance) * (unit === 'in' ? 2.54 : 1);
    if (cm > 0) this.p.move.cmPerRotation = cm;
  }

  /** Older blocks "Lenken …": steering -100..100 maps to the firmware turn ratio -200..200. */
  async steerOn(ports: MotorPort[], steering: number, speed: number): Promise<void> {
    this.check();
    await this.brick.steerDegrees(ports, Number(speed), Number(steering) * 2, 0, true);
  }

  async steerFor(ports: MotorPort[], steering: number, speed: number, amount: number, unit: Unit, brake: boolean): Promise<void> {
    this.check();
    amount = Number(amount);
    const turn = Number(steering) * 2;
    if (unit === 'seconds') {
      const ms = Math.round(amount * 1000);
      await this.brick.steerTime(ports, Number(speed), turn, ms, brake);
      await this.sleep(ms);
    } else {
      const degrees = Math.round(unit === 'rotations' ? amount * 360 : amount);
      if (degrees === 0) return;
      await this.brick.steerDegrees(ports, Number(speed), turn, degrees, brake);
    }
    await this.untilIdle(ports);
  }

  // --- Display and light -----------------------------------------------------------

  private async draw(ops: DrawOp[]): Promise<void> {
    this.check();
    await this.brick.draw(ops);
  }

  async image(id: string): Promise<void> {
    await this.draw(imageOps(id));
  }

  async imageFor(id: string, seconds: number): Promise<void> {
    await this.image(id);
    await this.wait(seconds);
    await this.draw([{ op: 'clear' }]);
  }

  async writeLine(text: unknown, line: number): Promise<void> {
    await this.draw(lineOps(formatValue(text), Number(line)));
  }

  /** `font` is "font,ink" from the block's menu. */
  async writeAt(text: unknown, x: number, y: number, font: string): Promise<void> {
    const [f, ink] = font.split(',').map(Number);
    await this.draw([{ op: 'text', x: Number(x), y: Number(y), text: formatValue(text), font: f, ink: ink as Ink }]);
  }

  async drawPixel(x: number, y: number, ink: Ink): Promise<void> {
    await this.draw([{ op: 'pixel', x: Number(x), y: Number(y), ink }]);
  }

  async drawLine(x1: number, y1: number, x2: number, y2: number, ink: Ink): Promise<void> {
    await this.draw([{ op: 'line', x1: Number(x1), y1: Number(y1), x2: Number(x2), y2: Number(y2), ink }]);
  }

  async drawCircle(x: number, y: number, r: number, fill: boolean, ink: Ink): Promise<void> {
    await this.draw([{ op: 'circle', x: Number(x), y: Number(y), r: Math.abs(Number(r)), fill, ink }]);
  }

  async drawRect(x: number, y: number, w: number, h: number, fill: boolean, ink: Ink): Promise<void> {
    await this.draw([{ op: 'rect', x: Number(x), y: Number(y), w: Number(w), h: Number(h), fill, ink }]);
  }

  async invert(): Promise<void> {
    await this.draw([{ op: 'invert', x: 0, y: 0, w: SCREEN_WIDTH, h: SCREEN_HEIGHT }]);
  }

  async displayText(text: unknown, line: number): Promise<void> {
    this.check();
    await this.brick.displayText(formatValue(text), Number(line));
  }

  async displayClear(): Promise<void> {
    await this.draw([{ op: 'clear' }]);
  }

  async led(pattern: LedPattern): Promise<void> {
    this.check();
    await this.brick.setLed(pattern);
  }

  // --- Sound ----------------------------------------------------------------------

  async sound(id: string, untilDone: boolean): Promise<void> {
    this.check();
    await this.brick.playSound(id, this.p.volume);
    if (untilDone) await this.sleep(soundMs(id));
  }

  async beep(note: number, seconds: number | null): Promise<void> {
    this.check();
    const frequency = 440 * Math.pow(2, (Number(note) - 69) / 12);
    const ms = seconds === null ? ENDLESS_TONE_MS : Math.round(Number(seconds) * 1000);
    await this.brick.playTone(this.p.volume, clamp(frequency, 250, 10000), clamp(ms, 0, ENDLESS_TONE_MS));
    if (seconds !== null) await this.sleep(ms);
  }

  async stopSound(): Promise<void> {
    this.check();
    await this.brick.stopSound();
  }

  setVolume(volume: number): void {
    this.check();
    this.p.volume = clamp(Number(volume), 0, 100);
  }

  /** Older block "Ton … Hz". */
  async tone(frequency: number, seconds: number, volume: number, wait: boolean): Promise<void> {
    this.check();
    const ms = Math.round(Number(seconds) * 1000);
    await this.brick.playTone(Number(volume), Number(frequency), ms);
    if (wait) await this.sleep(ms);
  }

  // --- Sensors ----------------------------------------------------------------------

  private async read(port: Port, mode: number): Promise<number> {
    this.check();
    const value = await this.brick.readPort(port, mode);
    return Number.isFinite(value) ? value : 0;
  }

  private async readValues(port: Port, mode: number, count: number): Promise<number[]> {
    this.check();
    return (await this.brick.readPortValues(port, mode, count)).map((v) => (Number.isFinite(v) ? v : 0));
  }

  async sensor(port: Port, mode: number): Promise<number> {
    return this.read(port, mode);
  }

  /** Compares like the "ist …?" blocks; "=" compares whole numbers. */
  compare(value: number, op: Compare, target: number): boolean {
    if (op === 'LT') return value < Number(target);
    if (op === 'GT') return value > Number(target);
    return Math.round(value) === Math.round(Number(target));
  }

  /** True once the value moved more than `delta` away from where it was last time this returned true. */
  changed(key: string, value: number, delta: number): boolean {
    const ref = this.p.refs.get(key);
    if (ref === undefined || Math.abs(value - ref) > Number(delta)) {
      this.p.refs.set(key, value);
      return ref !== undefined;
    }
    return false;
  }

  /** "angestoßen"/"losgelassen" as an event: true once after a press has ended. */
  released(key: string, pressed: boolean): boolean {
    const was = this.p.refs.get(key) === 1;
    this.p.refs.set(key, pressed ? 1 : 0);
    return was && !pressed;
  }

  async reflected(port: Port): Promise<number> {
    const raw = await this.read(port, 0);
    const cal = this.p.light[port];
    if (!cal || cal.max <= cal.min) return raw;
    return clamp(((raw - cal.min) / (cal.max - cal.min)) * 100, 0, 100);
  }

  calibrateLight(which: 'min' | 'max', port: Port, value: number): void {
    this.check();
    const cal = (this.p.light[port] ??= { min: 0, max: 100 });
    cal[which] = Number(value);
  }

  async ambient(port: Port): Promise<number> {
    return this.read(port, 1);
  }

  async color(port: Port): Promise<number> {
    return Math.round(await this.read(port, 2));
  }

  async colorIs(port: Port, color: number): Promise<boolean> {
    return (await this.color(port)) === Number(color);
  }

  async touch(port: Port): Promise<boolean> {
    return (await this.read(port, 0)) > 0.5;
  }

  async waitTouch(port: Port, event: 'pressed' | 'released' | 'bumped'): Promise<void> {
    if (event !== 'released') await this.waitFor(() => this.touch(port));
    if (event !== 'pressed') await this.waitFor(async () => !(await this.touch(port)));
  }

  async distance(port: Port, unit: 'cm' | 'in'): Promise<number> {
    return this.read(port, unit === 'in' ? 1 : 0);
  }

  async angle(port: Port): Promise<number> {
    // Mode 3 delivers angle and rate; switching modes would reset the angle.
    return (await this.readValues(port, 3, 2))[0] - (this.p.gyroOffset[port] ?? 0);
  }

  async rate(port: Port): Promise<number> {
    return (await this.readValues(port, 3, 2))[1];
  }

  async resetAngle(port: Port): Promise<void> {
    this.p.gyroOffset[port] = 0;
    this.p.gyroOffset[port] = await this.angle(port);
  }

  /** "warte bis … < > = / ändert sich um mehr als …" */
  async waitValue(read: () => Promise<number>, op: Compare, target: number): Promise<void> {
    if (op === 'CHANGE') {
      const start = await read();
      await this.waitFor(async () => Math.abs((await read()) - start) > Number(target));
    } else {
      await this.waitFor(async () => this.compare(await read(), op, target));
    }
  }

  async button(name: ButtonName): Promise<boolean> {
    this.check();
    return this.brick.buttonPressed(name);
  }

  async buttonNumber(): Promise<number> {
    for (const [name, n] of BUTTON_NUMBERS) if (await this.button(name)) return n;
    return 0;
  }

  async irBeacon(port: Port, channel: number, what: 'heading' | 'distance'): Promise<number> {
    const values = await this.readValues(port, 1, 8);
    return values[(Number(channel) - 1) * 2 + (what === 'distance' ? 1 : 0)] ?? 0;
  }

  async irRemote(port: Port, channel: number): Promise<number> {
    return (await this.readValues(port, 2, 4))[Number(channel) - 1] ?? 0;
  }

  timer(): number {
    return (performance.now() - this.p.startTime) / 1000;
  }

  resetTimer(): void {
    this.p.startTime = performance.now();
  }

  // --- Text and lists ------------------------------------------------------------------

  letterOf(index: number, text: unknown): string {
    return formatValue(text).charAt(Number(index) - 1);
  }

  lengthOf(text: unknown): number {
    return formatValue(text).length;
  }

  contains(text: unknown, part: unknown): boolean {
    return formatValue(text).toLowerCase().includes(formatValue(part).toLowerCase());
  }

  math(op: string, x: number): number {
    const rad = (Number(x) * Math.PI) / 180;
    const deg = (v: number) => (v * 180) / Math.PI;
    switch (op) {
      case 'abs': return Math.abs(x);
      case 'floor': return Math.floor(x);
      case 'ceiling': return Math.ceil(x);
      case 'sqrt': return Math.sqrt(x);
      case 'sin': return Math.sin(rad);
      case 'cos': return Math.cos(rad);
      case 'tan': return Math.tan(rad);
      case 'asin': return deg(Math.asin(x));
      case 'acos': return deg(Math.acos(x));
      case 'atan': return deg(Math.atan(x));
      case 'ln': return Math.log(x);
      case 'log': return Math.log10(x);
      case 'exp': return Math.exp(x);
      default: return Math.pow(10, x);
    }
  }

  listInsert(list: unknown[], item: unknown, index: number): void {
    const i = Math.round(Number(index));
    if (i >= 1 && i <= list.length + 1) list.splice(i - 1, 0, item);
  }

  listDelete(list: unknown[], index: number): void {
    const i = Math.round(Number(index));
    if (i >= 1 && i <= list.length) list.splice(i - 1, 1);
  }

  listReplace(list: unknown[], index: number, item: unknown): void {
    const i = Math.round(Number(index));
    if (i >= 1 && i <= list.length) list[i - 1] = item;
  }

  listItem(list: unknown[], index: number): unknown {
    return list[Math.round(Number(index)) - 1] ?? '';
  }

  listIndex(list: unknown[], item: unknown): number {
    const wanted = formatValue(item).toLowerCase();
    return list.findIndex((v) => formatValue(v).toLowerCase() === wanted) + 1;
  }

  listText(list: unknown[]): string {
    return list.map(formatValue).join(' ');
  }

  print(value: unknown): void {
    this.check();
    this.p.hooks.onPrint(formatValue(value));
  }
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function formatValue(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value === 'boolean') return value ? 'wahr' : 'falsch';
  if (value === undefined) return '0';
  return String(value);
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (api: ProgramApi) => Promise<void>;

/** Runs generated program code until it ends, fails, or `stop()` is called. */
export class ProgramRun {
  private abort = new AbortController();
  readonly done: Promise<void>;

  constructor(private brick: Brick, code: string, hooks: RunHooks) {
    const fn = new AsyncFunction('api', code);
    const api = ProgramApi.create(brick, this.abort, hooks);
    this.done = fn(api)
      .catch((e: unknown) => {
        // An error in one stack ends the others, too.
        this.abort.abort();
        if (!(e instanceof StopError)) throw e;
      })
      .finally(() => this.cleanup());
  }

  stop(): Promise<void> {
    this.abort.abort();
    return this.done.catch(() => {});
  }

  get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  private async cleanup(): Promise<void> {
    // Like the original software: motors coast and sound stops when a program ends.
    try {
      await this.brick.motorStop(['A', 'B', 'C', 'D'], false);
      await this.brick.stopSound();
    } catch {
      // The connection may already be gone.
    }
  }
}
