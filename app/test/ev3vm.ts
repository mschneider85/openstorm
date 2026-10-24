// A small model of the EV3 virtual machine (LMS2012) for tests: validates an .rbf
// image like the firmware's cValidateProgram and runs it against a fake brick.
// Parameter decoding follows PrimParPointer in lms2012.c; only the opcodes the
// OpenStorm compiler emits are implemented.

type P = '8' | '16' | '32' | 'F';
type Sig = readonly P[];

const UNARY_MATH: Record<number, (x: number) => number> = {
  1: Math.exp, 3: Math.floor, 4: Math.ceil, 5: (x) => (x < 0 ? Math.ceil(x - 0.5) : Math.floor(x + 0.5)),
  6: Math.abs, 7: (x) => 0 - x, 8: Math.sqrt, 9: Math.log10, 10: Math.log,
};

const OPS: Record<number, Sig | Record<number, Sig>> = {
  0x02: ['16'], 0x05: ['16'], 0x0a: [], 0x0b: [],
  0x13: ['F', 'F', 'F'], 0x16: ['32', '32', '32'], 0x17: ['F', 'F', 'F'], 0x1b: ['F', 'F', 'F'], 0x1f: ['F', 'F', 'F'],
  0x20: ['8', '8', '8'], 0x24: ['8', '8', '8'],
  0x30: ['8', '8'], 0x33: ['8', 'F'], 0x37: ['16', 'F'], 0x3b: ['32', 'F'],
  0x3c: ['F', '8'], 0x3d: ['F', '16'], 0x3e: ['F', '32'], 0x3f: ['F', 'F'],
  0x40: ['32'], 0x41: ['8', '32'], 0x42: ['8', '32'],
  0x47: ['F', 'F', '8'], 0x4b: ['F', 'F', '8'], 0x4c: ['8', '8', '8'], 0x4f: ['F', 'F', '8'],
  0x53: ['F', 'F', '8'], 0x57: ['F', 'F', '8'], 0x5b: ['F', 'F', '8'], 0x5f: ['8', 'F', 'F', 'F'],
  0x7d: { 2: ['8', '8', '8'], 3: ['8', '8', '8'], 5: ['8', '8'], 11: ['F', '8', '8', '8'] },
  0x82: { 27: ['8'] },
  0x83: { 9: ['8', '8'] },
  0x84: { 0: [], 5: ['8', '16', '16', '8'], 9: ['8', '16', '16', '16', '16'], 17: ['8'], 19: ['8', '16', '16'] },
  0x85: ['32', '32'], 0x86: ['32'], 0x87: ['32'],
  0x8d: { 1: ['F', 'F'], 2: ['F', 'F', 'F'], 3: ['F', 'F'], 4: ['F', 'F'], 5: ['F', 'F'], 6: ['F', 'F'], 7: ['F', 'F'], 8: ['F', 'F'], 9: ['F', 'F'], 10: ['F', 'F'], 20: ['F', 'F', 'F'] },
  0x8e: ['16', '16', '16'],
  0x94: { 1: ['8', '16', '16'] }, 0x96: [],
  0x9d: ['8', '8', '8', '8', 'F'],
  0xa3: ['8', '8', '8'], 0xa5: ['8', '8', '8'], 0xa6: ['8', '8'], 0xaa: ['8', '8'],
  0xae: ['8', '8', '8', '32', '32', '32', '8'], 0xaf: ['8', '8', '8', '32', '32', '32', '8'],
  0xb0: ['8', '8', '8', '16', '32', '8'], 0xb1: ['8', '8', '8', '16', '32', '8'], 0xb2: ['8', '8'],
};
const RANGE: Record<string, [number, number]> = { '8': [-127, 127], '16': [-32767, 32767], '32': [-2147483647, 2147483647] };

interface Ptr {
  mem: Uint8Array;
  off: number;
  constant: boolean;
}

interface Obj {
  start: number;
  ip: number;
  locals: Uint8Array;
  running: boolean;
}

export interface FakeBrick {
  /** Sensor value for INPUT_READSI (port number as in the firmware: 0-3, motors 16-19). */
  sensor?: (port: number, mode: number) => number;
  button?: (button: number) => boolean;
}

export class Ev3Vm {
  readonly log: string[] = [];
  readonly display: string[] = Array(8).fill('');
  /** Virtual time in ms; advances by one per scheduler round. */
  now = 0;
  private globals: Uint8Array;
  private objects: Obj[] = [];
  private view: DataView;
  private busyUntil = new Map<number, number>();
  private soundUntil = 0;

  constructor(private image: Uint8Array, private brick: FakeBrick = {}) {
    this.view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    this.validate();
    this.globals = new Uint8Array(this.view.getUint32(12, true));
    const count = this.view.getUint16(10, true);
    for (let i = 0; i < count; i++) {
      const head = 16 + 12 * i;
      const start = this.view.getUint32(head, true);
      this.objects.push({ start, ip: start, locals: new Uint8Array(this.view.getUint32(head + 8, true)), running: i === 0 });
    }
  }

  // --- Validation (cValidateProgram) ----------------------------------------------

  private validate(): void {
    const v = this.view;
    if (String.fromCharCode(...this.image.slice(0, 4)) !== 'LEGO') throw new Error('signature');
    if (v.getUint32(4, true) !== this.image.length) throw new Error('image size');
    if (v.getUint16(8, true) < 104) throw new Error('version');
    const count = v.getUint16(10, true);
    if (count === 0) throw new Error('no objects');
    let index = 16 + 12 * count;
    for (let i = 0; i < count; i++) {
      const head = 16 + 12 * i;
      if (v.getUint32(head, true) !== index) throw new Error(`object ${i + 1} does not start where the previous ended`);
      if (v.getUint16(head + 4, true) !== 0 || v.getUint16(head + 6, true) !== 0) throw new Error('not a VMTHREAD');
      for (;;) {
        const code = this.image[index++];
        if (code === 0x0a) break;
        const sig = this.signature(code, index);
        if (!Array.isArray(OPS[code])) index = this.skipParam(index, '8', true); // sub-code
        for (const p of sig) index = this.skipParam(index, p, false);
        if (index >= this.image.length) throw new Error('object without OBJECT_END');
      }
    }
    if (index !== this.image.length) throw new Error('trailing bytes');
  }

  private signature(code: number, at: number): Sig {
    const entry = OPS[code];
    if (!entry) throw new Error(`unknown opcode 0x${code.toString(16)} at ${at - 1}`);
    if (Array.isArray(entry)) return entry;
    const sub = this.image[at] & 0x3f; // sub-codes are short constants
    const sig = (entry as Record<number, Sig>)[sub];
    if (!sig) throw new Error(`unknown sub-code ${sub} of 0x${code.toString(16)}`);
    return sig;
  }

  /** Decodes one parameter at `index` (like the validator) and returns the next index. */
  private skipParam(index: number, type: P, mustBeConst: boolean): number {
    const { next, variable, value } = this.decode(index);
    if (variable) {
      if (mustBeConst) throw new Error('sub-code must be constant');
      const align = type === '16' ? 2 : type === '32' || type === 'F' ? 4 : 1;
      if (value! % align) throw new Error(`misaligned ${type} variable at ${value}`);
    } else if (type !== 'F' && value !== null) {
      const [min, max] = RANGE[type];
      if (value < min || value > max) throw new Error(`constant ${value} out of range for DATA${type}`);
    }
    return next;
  }

  private decode(index: number): { next: number; variable: boolean; global: boolean; value: number | null; str?: number } {
    const b = this.image[index++];
    if (!(b & 0x80)) {
      if (b & 0x40) return { next: index, variable: true, global: !!(b & 0x20), value: b & 0x1f };
      return { next: index, variable: false, global: false, value: b & 0x20 ? (b & 0x3f) - 64 : b & 0x3f };
    }
    const size = b & 0x07;
    if (!(b & 0x40) && (size === 0 || size === 4)) {
      const str = index;
      while (this.image[index]) index++;
      return { next: index + 1, variable: false, global: false, value: null, str };
    }
    const n = size === 1 ? 1 : size === 2 ? 2 : 4;
    let value = 0;
    for (let i = 0; i < n; i++) value |= this.image[index + i] << (8 * i);
    if (!(b & 0x40)) value = n === 1 ? (value << 24) >> 24 : n === 2 ? (value << 16) >> 16 : value | 0;
    else value >>>= 0;
    return { next: index + n, variable: !!(b & 0x40), global: !!(b & 0x20), value };
  }

  // --- Execution ------------------------------------------------------------------

  /** Runs until the program ends; throws if it takes longer than `maxMs` virtual ms. */
  run(maxMs = 60_000): void {
    while (this.objects.some((o) => o.running)) {
      if (this.now > maxMs) throw new Error('program did not end');
      for (const obj of this.objects) {
        for (let n = 0; n < 200 && obj.running; n++) {
          if (!this.step(obj)) break;
        }
      }
      this.now++;
    }
  }

  private param(obj: Obj): Ptr {
    const d = this.decode(obj.ip);
    obj.ip = d.next;
    if (d.str !== undefined) return { mem: this.image, off: d.str, constant: true };
    if (d.variable) return { mem: d.global ? this.globals : obj.locals, off: d.value!, constant: false };
    const mem = new Uint8Array(4);
    new DataView(mem.buffer).setInt32(0, d.value!, true);
    return { mem, off: 0, constant: true };
  }

  private dv(p: Ptr): DataView {
    return new DataView(p.mem.buffer, p.mem.byteOffset);
  }
  private i8 = (p: Ptr) => this.dv(p).getInt8(p.off);
  private i16 = (p: Ptr) => this.dv(p).getInt16(p.off, true);
  private i32 = (p: Ptr) => this.dv(p).getInt32(p.off, true);
  private f = (p: Ptr) => this.dv(p).getFloat32(p.off, true);
  private set8 = (p: Ptr, v: number) => this.dv(p).setInt8(p.off, v);
  private set16 = (p: Ptr, v: number) => this.dv(p).setInt16(p.off, v, true);
  private set32 = (p: Ptr, v: number) => this.dv(p).setInt32(p.off, v, true);
  private setF = (p: Ptr, v: number) => this.dv(p).setFloat32(p.off, v, true);
  private str(p: Ptr): string {
    let s = '';
    for (let i = p.off; p.mem[i]; i++) s += String.fromCharCode(p.mem[i]);
    return s;
  }
  private setStr(p: Ptr, s: string): void {
    for (let i = 0; i < s.length; i++) p.mem[p.off + i] = s.charCodeAt(i);
    p.mem[p.off + s.length] = 0;
  }

  /** Executes one instruction; false if the object has to wait (blocking opcode). */
  private step(obj: Obj): boolean {
    const at = obj.ip;
    const code = this.image[obj.ip++];
    const p = () => this.param(obj);
    const sub = () => this.i8(p());
    const ports = (mask: number) => [0, 1, 2, 3].filter((i) => mask & (1 << i)).map((i) => 'ABCD'[i]).join('');
    const busy = (mask: number, ms: number) => [0, 1, 2, 3].forEach((i) => mask & (1 << i) && this.busyUntil.set(i, this.now + ms));
    const wait = () => {
      obj.ip = at;
      return false;
    };
    switch (code) {
      case 0x0a: obj.running = false; obj.ip = obj.start; return false;
      case 0x0b: return false;
      case 0x05: { const id = this.i16(p()); const o = this.objects[id - 1]; o.ip = o.start; o.running = true; return true; }
      case 0x13: { const a = this.f(p()), b = this.f(p()); this.setF(p(), a + b); return true; }
      case 0x17: { const a = this.f(p()), b = this.f(p()); this.setF(p(), a - b); return true; }
      case 0x1b: { const a = this.f(p()), b = this.f(p()); this.setF(p(), a * b); return true; }
      case 0x1f: { const a = this.f(p()), b = this.f(p()); this.setF(p(), a / b); return true; }
      case 0x16: { const a = this.i32(p()), b = this.i32(p()); this.set32(p(), a - b); return true; }
      case 0x20: { const a = this.i8(p()), b = this.i8(p()); this.set8(p(), a | b); return true; }
      case 0x24: { const a = this.i8(p()), b = this.i8(p()); this.set8(p(), a & b); return true; }
      case 0x30: { const a = this.i8(p()); this.set8(p(), a); return true; }
      case 0x33: { const a = this.i8(p()); this.setF(p(), a); return true; }
      case 0x37: { const a = this.i16(p()); this.setF(p(), a); return true; }
      case 0x3b: { const a = this.i32(p()); this.setF(p(), a); return true; }
      case 0x3c: { const a = this.f(p()); this.set8(p(), Math.trunc(a)); return true; }
      case 0x3d: { const a = this.f(p()); this.set16(p(), Math.trunc(a)); return true; }
      case 0x3e: { const a = this.f(p()); this.set32(p(), Math.trunc(a)); return true; }
      case 0x3f: { const a = this.f(p()); this.setF(p(), a); return true; }
      case 0x40: { const off = this.i32(p()); obj.ip += off; return true; }
      case 0x41: case 0x42: {
        const flag = this.i8(p()); const off = this.i32(p());
        if ((flag !== 0) === (code === 0x42)) obj.ip += off;
        return true;
      }
      case 0x47: case 0x4b: case 0x4f: case 0x53: case 0x57: case 0x5b: {
        const a = this.f(p()), b = this.f(p());
        const r = { 0x47: a < b, 0x4b: a > b, 0x4f: a === b, 0x53: a !== b, 0x57: a <= b, 0x5b: a >= b }[code];
        this.set8(p(), r ? 1 : 0);
        return true;
      }
      case 0x4c: { const a = this.i8(p()), b = this.i8(p()); this.set8(p(), a === b ? 1 : 0); return true; }
      case 0x5f: { const flag = this.i8(p()), a = this.f(p()), b = this.f(p()); this.setF(p(), flag ? a : b); return true; }
      case 0x7d: {
        const s = sub();
        if (s === 2) { const a = this.str(p()), b = this.str(p()); this.setStr(p(), a + b); }
        else if (s === 3) { const a = this.str(p()), b = this.str(p()); this.set8(p(), a === b ? 1 : 0); }
        else if (s === 5) { const a = this.str(p()); this.setStr(p(), a); }
        else { const v = this.f(p()); const fmt = this.str(p()); const size = this.i8(p()); this.setStr(p(), formatG(v, fmt).slice(0, size - 1)); }
        return true;
      }
      case 0x82: { sub(); this.log.push(`led ${this.i8(p())}`); return true; }
      case 0x83: { sub(); const b = this.i8(p()); this.set8(p(), this.brick.button?.(b) ? 1 : 0); return true; }
      case 0x84: {
        const s = sub();
        if (s === 5) {
          p(); p(); const y = this.i16(p()); const text = this.str(p());
          this.display[y / 16] = text;
          this.log.push(`text ${y / 16 + 1} ${text}`);
        } else if (s === 9) { p(); p(); const y = this.i16(p()); p(); p(); this.display[y / 16] = ''; }
        else if (s === 17) p();
        else if (s === 19) { p(); p(); p(); this.display.fill(''); this.log.push('clear'); }
        return true;
      }
      case 0x85: { const ms = this.i32(p()); this.set32(p(), this.now + ms); return true; }
      case 0x86: { const until = this.i32(p()); return this.now >= until ? true : wait(); }
      case 0x87: { this.set32(p(), this.now); return true; }
      case 0x8d: {
        const s = sub();
        if (s === 2 || s === 20) { const a = this.f(p()), b = this.f(p()); this.setF(p(), s === 2 ? a % b : Math.pow(a, b)); }
        else { const a = this.f(p()); this.setF(p(), UNARY_MATH[s](a)); }
        return true;
      }
      case 0x8e: { const min = this.i16(p()), max = this.i16(p()); this.set16(p(), Math.round((min + max) / 2)); return true; }
      case 0x94: { sub(); const vol = this.i8(p()), freq = this.i16(p()), ms = this.i16(p()); this.soundUntil = this.now + ms; this.log.push(`tone ${freq} ${ms} ${vol}`); return true; }
      case 0x96: return this.now >= this.soundUntil ? true : wait();
      case 0x9d: { p(); const port = this.i8(p()); p(); const mode = this.i8(p()); this.setF(p(), this.brick.sensor?.(port, mode) ?? 0); return true; }
      case 0xa3: { p(); const m = this.i8(p()); const brake = this.i8(p()); this.log.push(`stop ${ports(m)}${brake ? ' brake' : ''}`); busy(m, 0); return true; }
      case 0xa5: { p(); const m = this.i8(p()); this.log.push(`speed ${ports(m)} ${this.i8(p())}`); return true; }
      case 0xa6: { p(); this.log.push(`start ${ports(this.i8(p()))}`); return true; }
      case 0xaa: {
        p(); const m = this.i8(p());
        const done = [0, 1, 2, 3].every((i) => !(m & (1 << i)) || (this.busyUntil.get(i) ?? 0) <= this.now);
        return done ? true : wait();
      }
      case 0xae: case 0xaf: {
        p(); const m = this.i8(p()); const speed = this.i8(p()); p(); const amount = this.i32(p()); p(); const brake = this.i8(p());
        const kind = code === 0xae ? 'deg' : 'ms';
        this.log.push(`run ${ports(m)} ${speed} ${amount}${kind}${brake ? ' brake' : ''}`);
        busy(m, code === 0xae ? Math.ceil(amount / Math.max(1, Math.abs(speed))) : amount);
        return true;
      }
      case 0xb0: case 0xb1: {
        p(); const m = this.i8(p()); const speed = this.i8(p()); const turn = this.i16(p()); const amount = this.i32(p()); const brake = this.i8(p());
        const kind = code === 0xb0 ? 'deg' : 'ms';
        this.log.push(`sync ${ports(m)} ${speed} turn ${turn} ${amount}${kind}${brake ? ' brake' : ''}`);
        if (amount) busy(m, code === 0xb0 ? Math.ceil(amount / Math.max(1, Math.abs(speed))) : amount);
        return true;
      }
      case 0xb2: { p(); this.log.push(`reset ${ports(this.i8(p()))}`); return true; }
    }
    throw new Error(`opcode 0x${code.toString(16)} not implemented in test VM`);
  }
}

/** printf "%g" as the firmware's snprintf would do it. */
function formatG(v: number, fmt: string): string {
  if (fmt !== '%g') throw new Error(`format ${fmt}`);
  return String(Number(v.toPrecision(6)));
}
