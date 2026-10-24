import type { Brick, MotorPort, Port } from '../ev3/brick';
import type { ButtonName, LedPattern } from '../ev3/bytecodes';

export class StopError extends Error {
  constructor() {
    super('Programm gestoppt');
  }
}

export type Unit = 'rotations' | 'degrees' | 'seconds';

const POLL_MS = 40;

/**
 * The functions available to generated block code as `api.*`.
 * Every call checks for a stop request, so a running program ends promptly.
 */
export class ProgramApi {
  private startTime = performance.now();
  private lastYield = performance.now();

  constructor(
    private brick: Brick,
    private signal: AbortSignal,
    private hooks: { onStep: (blockId: string) => void; onPrint: (text: string) => void },
  ) {}

  private check(): void {
    if (this.signal.aborted) throw new StopError();
  }

  /** Called before every statement block (highlighting). */
  async step(blockId: string): Promise<void> {
    this.check();
    this.hooks.onStep(blockId);
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
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new StopError());
      };
      const timer = setTimeout(() => {
        this.signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async wait(seconds: number): Promise<void> {
    await this.sleep(Number(seconds) * 1000);
  }

  private async untilIdle(ports: MotorPort[]): Promise<void> {
    while (await this.brick.motorBusy(ports)) await this.sleep(POLL_MS);
  }

  // --- Motors ---------------------------------------------------------------

  async motorOn(ports: MotorPort[], speed: number): Promise<void> {
    this.check();
    await this.brick.motorStart(ports, Number(speed));
  }

  async motorOff(ports: MotorPort[], brake: boolean): Promise<void> {
    this.check();
    await this.brick.motorStop(ports, brake);
  }

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

  /** Steering -100..100 as in the EV3 software; maps to the firmware turn ratio -200..200. */
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

  // --- Sensors --------------------------------------------------------------

  private async read(port: Port, mode: number): Promise<number> {
    this.check();
    const value = await this.brick.readPort(port, mode);
    return Number.isFinite(value) ? value : 0;
  }

  async touch(port: Port): Promise<boolean> {
    return (await this.read(port, 0)) > 0.5;
  }

  async sensor(port: Port, mode: number): Promise<number> {
    return this.read(port, mode);
  }

  async colorIs(port: Port, color: number): Promise<boolean> {
    return Math.round(await this.read(port, 2)) === Number(color);
  }

  async button(name: ButtonName): Promise<boolean> {
    this.check();
    return this.brick.buttonPressed(name);
  }

  timer(): number {
    return (performance.now() - this.startTime) / 1000;
  }

  resetTimer(): void {
    this.startTime = performance.now();
  }

  // --- Actions --------------------------------------------------------------

  async tone(frequency: number, seconds: number, volume: number, wait: boolean): Promise<void> {
    this.check();
    const ms = Math.round(Number(seconds) * 1000);
    await this.brick.playTone(Number(volume), Number(frequency), ms);
    if (wait) await this.sleep(ms);
  }

  async led(pattern: LedPattern): Promise<void> {
    this.check();
    await this.brick.setLed(pattern);
  }

  async displayText(text: unknown, line: number): Promise<void> {
    this.check();
    await this.brick.displayText(formatValue(text), Number(line));
  }

  async displayClear(): Promise<void> {
    this.check();
    await this.brick.displayClear();
  }

  print(value: unknown): void {
    this.check();
    this.hooks.onPrint(formatValue(value));
  }
}

export function formatValue(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 100) / 100);
  if (typeof value === 'boolean') return value ? 'wahr' : 'falsch';
  return String(value);
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (api: ProgramApi) => Promise<void>;

export interface RunHooks {
  onStep: (blockId: string) => void;
  onPrint: (text: string) => void;
}

/** Runs generated program code until it ends, fails, or `stop()` is called. */
export class ProgramRun {
  private abort = new AbortController();
  readonly done: Promise<void>;

  constructor(private brick: Brick, code: string, hooks: RunHooks) {
    const fn = new AsyncFunction('api', code);
    const api = new ProgramApi(brick, this.abort.signal, hooks);
    this.done = fn(api)
      .catch((e: unknown) => {
        // An error in one thread ends the other threads, too.
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
