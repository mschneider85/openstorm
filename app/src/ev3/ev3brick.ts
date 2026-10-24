import {
  BUTTONS,
  LED_PATTERNS,
  comGet,
  inputDevice,
  op,
  sound,
  uiButton,
  uiDraw,
  uiRead,
  uiWrite,
  type ButtonName,
  type LedPattern,
} from './bytecodes';
import { ALL_PORTS, inputPortNumber, type Brick, type MotorPort, type Port, type PortState } from './brick';
import { Command, portMask } from './command';
import { Ev3Connection } from './connection';
import { Ev3Files } from './files';
import type { Transport } from '../transport/transport';

const LAYER = 0;
const LINE_HEIGHT = 16;
const SCREEN_WIDTH = 178;

/** A real EV3 brick, controlled with direct commands. */
export class Ev3Brick implements Brick {
  private conn: Ev3Connection;
  readonly files: Ev3Files;
  name = 'EV3';

  private constructor(transport: Transport) {
    this.conn = new Ev3Connection(transport);
    this.files = new Ev3Files(this.conn);
  }

  static async connect(transport: Transport, onClose: (reason: string) => void): Promise<Ev3Brick> {
    const brick = new Ev3Brick(transport);
    brick.conn.onClose = onClose;
    brick.name = await brick.readName();
    return brick;
  }

  close(): void {
    this.conn.close();
  }

  private async run(build: (cmd: Command) => void): Promise<DataView> {
    const cmd = new Command();
    build(cmd);
    return this.conn.execute(cmd);
  }

  private async readName(): Promise<string> {
    let offset = 0;
    const reply = await this.run((c) => {
      offset = c.alloc(32);
      c.op(op.COM_GET, comGet.GET_BRICKNAME).lc(32).gv(offset);
    });
    return readString(reply, offset, 32) || 'EV3';
  }

  async motorStart(ports: MotorPort[], speed: number): Promise<void> {
    const nos = portMask(ports);
    await this.run((c) => {
      c.op(op.OUTPUT_SPEED).lc(LAYER).lc(nos).lc(clampSpeed(speed));
      c.op(op.OUTPUT_START).lc(LAYER).lc(nos);
    });
  }

  async motorStop(ports: MotorPort[], brake: boolean): Promise<void> {
    await this.run((c) => c.op(op.OUTPUT_STOP).lc(LAYER).lc(portMask(ports)).lc(brake ? 1 : 0));
  }

  async motorRunDegrees(ports: MotorPort[], speed: number, degrees: number, brake: boolean): Promise<void> {
    // Negative degrees mean "backwards": the firmware wants the sign on the speed.
    const s = clampSpeed(degrees < 0 ? -speed : speed);
    await this.run((c) =>
      c.op(op.OUTPUT_STEP_SPEED).lc(LAYER).lc(portMask(ports)).lc(s).lc(0).lc(Math.abs(degrees)).lc(0).lc(brake ? 1 : 0),
    );
  }

  async motorRunTime(ports: MotorPort[], speed: number, ms: number, brake: boolean): Promise<void> {
    await this.run((c) =>
      c.op(op.OUTPUT_TIME_SPEED).lc(LAYER).lc(portMask(ports)).lc(clampSpeed(speed)).lc(0).lc(ms).lc(0).lc(brake ? 1 : 0),
    );
  }

  async steerDegrees(ports: MotorPort[], speed: number, turn: number, degrees: number, brake: boolean): Promise<void> {
    const s = clampSpeed(degrees < 0 ? -speed : speed);
    await this.run((c) =>
      c.op(op.OUTPUT_STEP_SYNC).lc(LAYER).lc(portMask(ports)).lc(s).lc(clampTurn(turn)).lc(Math.abs(degrees)).lc(brake ? 1 : 0),
    );
  }

  async steerTime(ports: MotorPort[], speed: number, turn: number, ms: number, brake: boolean): Promise<void> {
    await this.run((c) =>
      c.op(op.OUTPUT_TIME_SYNC).lc(LAYER).lc(portMask(ports)).lc(clampSpeed(speed)).lc(clampTurn(turn)).lc(ms).lc(brake ? 1 : 0),
    );
  }

  async motorBusy(ports: MotorPort[]): Promise<boolean> {
    let offset = 0;
    const reply = await this.run((c) => {
      offset = c.alloc(1);
      c.op(op.OUTPUT_TEST).lc(LAYER).lc(portMask(ports)).gv(offset);
    });
    return reply.getUint8(offset) !== 0;
  }

  async motorResetCount(ports: MotorPort[]): Promise<void> {
    await this.run((c) => c.op(op.OUTPUT_CLR_COUNT).lc(LAYER).lc(portMask(ports)));
  }

  async readPort(port: Port, mode: number): Promise<number> {
    let offset = 0;
    const reply = await this.run((c) => {
      offset = c.alloc(4);
      // Type 0 keeps the detected device type; only the mode is switched.
      c.op(op.INPUT_READSI).lc(LAYER).lc(inputPortNumber(port)).lc(0).lc(mode).gv(offset);
    });
    return reply.getFloat32(offset, true);
  }

  async readPorts(requests: { port: Port; mode: number }[]): Promise<number[]> {
    if (requests.length === 0) return [];
    const offsets: number[] = [];
    const reply = await this.run((c) => {
      for (const { port, mode } of requests) {
        const offset = c.alloc(4);
        offsets.push(offset);
        c.op(op.INPUT_READSI).lc(LAYER).lc(inputPortNumber(port)).lc(0).lc(mode).gv(offset);
      }
    });
    return offsets.map((o) => reply.getFloat32(o, true));
  }

  async readPortStates(): Promise<PortState[]> {
    const offsets: number[] = [];
    const reply = await this.run((c) => {
      for (const port of ALL_PORTS) {
        const offset = c.alloc(2);
        offsets.push(offset);
        c.op(op.INPUT_DEVICE, inputDevice.GET_TYPEMODE).lc(LAYER).lc(inputPortNumber(port)).gv(offset).gv(offset + 1);
      }
    });
    return ALL_PORTS.map((port, i) => ({
      port,
      type: reply.getUint8(offsets[i]),
      mode: reply.getInt8(offsets[i] + 1),
    }));
  }

  async playTone(volume: number, frequency: number, ms: number): Promise<void> {
    await this.run((c) =>
      c.op(op.SOUND, sound.TONE).lc(clamp(volume, 0, 100)).lc(clamp(frequency, 250, 10000)).lc(Math.max(0, ms)),
    );
  }

  async stopSound(): Promise<void> {
    await this.run((c) => c.op(op.SOUND, sound.BREAK));
  }

  async setLed(pattern: LedPattern): Promise<void> {
    await this.run((c) => c.op(op.UI_WRITE, uiWrite.LED).lc(LED_PATTERNS[pattern]));
  }

  async buttonPressed(button: ButtonName): Promise<boolean> {
    let offset = 0;
    const reply = await this.run((c) => {
      offset = c.alloc(1);
      c.op(op.UI_BUTTON, uiButton.PRESSED).lc(BUTTONS[button]).gv(offset);
    });
    return reply.getUint8(offset) !== 0;
  }

  async displayText(text: string, line: number): Promise<void> {
    const y = (clamp(line, 1, 8) - 1) * LINE_HEIGHT;
    await this.run((c) => {
      c.op(op.UI_DRAW, uiDraw.FILLRECT).lc(0).lc(0).lc(y).lc(SCREEN_WIDTH).lc(LINE_HEIGHT);
      c.op(op.UI_DRAW, uiDraw.SELECT_FONT).lc(0);
      c.op(op.UI_DRAW, uiDraw.TEXT).lc(1).lc(0).lc(y).lcs(text.slice(0, 22));
      c.op(op.UI_DRAW, uiDraw.UPDATE);
    });
  }

  async displayClear(): Promise<void> {
    await this.run((c) => {
      c.op(op.UI_DRAW, uiDraw.FILLWINDOW).lc(0).lc(0).lc(0);
      c.op(op.UI_DRAW, uiDraw.UPDATE);
    });
  }

  async battery(): Promise<{ voltage: number; percent: number }> {
    let v = 0;
    let p = 0;
    const reply = await this.run((c) => {
      v = c.alloc(4);
      p = c.alloc(1);
      c.op(op.UI_READ, uiRead.GET_VBATT).gv(v);
      c.op(op.UI_READ, uiRead.GET_LBATT).gv(p);
    });
    return { voltage: reply.getFloat32(v, true), percent: reply.getUint8(p) };
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(v)));
}

const clampSpeed = (s: number) => clamp(s, -100, 100);
const clampTurn = (t: number) => clamp(t, -200, 200);

function readString(view: DataView, offset: number, max: number): string {
  let s = '';
  for (let i = 0; i < max && offset + i < view.byteLength; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
