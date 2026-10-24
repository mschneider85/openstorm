// Encoding of bytecode parameters and assembly of program files (.rbf) for the
// EV3 virtual machine. Formats as in the LMS2012 firmware sources (bytecodes.h,
// lms2012.c PrimParPointer, lmstypes.h IMGHEAD/OBJHEAD).

/** An encoded parameter: one to five bytes (or a zero-terminated string). */
export type Operand = number[];

/** Integer constant in the smallest encoding (LC0/LC1/LC2/LC4). */
export function lc(value: number): Operand {
  const v = Math.round(value);
  if (v >= -31 && v <= 31) return [v & 0x3f];
  if (v >= -128 && v <= 127) return [0x81, v & 0xff];
  if (v >= -32768 && v <= 32767) return [0x82, v & 0xff, (v >> 8) & 0xff];
  return [0x83, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}

/**
 * Float constant for DATAF parameters. The VM does not convert constants, so the
 * IEEE bits are sent as a 4 byte constant (0.0 has the same bits as integer 0).
 */
export function lcf(value: number): Operand {
  if (value === 0) return [0];
  const bytes = new Uint8Array(new Float32Array([value]).buffer);
  return [0x83, ...bytes];
}

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };

/** The EV3 font and file names only know ASCII: umlauts are spelled out, the rest becomes '?'. */
export function ascii(text: string): string {
  return text.replace(/[äöüÄÖÜß]/g, (ch) => UMLAUTS[ch]);
}

/** Zero-terminated string constant (LCS). */
export function lcs(text: string): Operand {
  const out = [0x84];
  for (const ch of ascii(text)) {
    const c = ch.charCodeAt(0);
    out.push(c > 0 && c < 128 ? c : 0x3f);
  }
  out.push(0);
  return out;
}

function variable(offset: number, global: boolean): Operand {
  const scope = global ? 0x20 : 0;
  if (offset < 32) return [0x40 | scope | offset];
  if (offset < 256) return [0xc1 | scope, offset];
  if (offset < 65536) return [0xc2 | scope, offset & 0xff, offset >> 8];
  return [0xc3 | scope, offset & 0xff, (offset >> 8) & 0xff, (offset >> 16) & 0xff, offset >>> 24];
}

/** Local variable of the running object at byte `offset`. */
export const lv = (offset: number): Operand => variable(offset, false);
/** Global variable at byte `offset`. */
export const gv = (offset: number): Operand => variable(offset, true);

export interface Label {
  address: number | null;
}

/**
 * Instructions of one object. Jumps take a label; their 16 bit relative offset
 * is filled in by `finish()`, once all labels are placed.
 */
export class CodeBuffer {
  readonly bytes: number[] = [];
  private fixups: { at: number; end: number; label: Label }[] = [];

  /** Appends an opcode (and sub-code bytes) followed by operands. */
  op(code: number | number[], ...operands: Operand[]): this {
    this.bytes.push(...(Array.isArray(code) ? code : [code]));
    for (const operand of operands) this.bytes.push(...operand);
    return this;
  }

  label(): Label {
    return { address: null };
  }

  place(label: Label): void {
    label.address = this.bytes.length;
  }

  /**
   * Appends a jump whose last parameter is the offset to `label` (opJR,
   * opJR_FALSE, ...). The VM adds the offset after reading the instruction.
   */
  jump(code: number, label: Label, ...operands: Operand[]): this {
    this.op(code, ...operands);
    this.bytes.push(0x82, 0, 0); // LC2 placeholder
    this.fixups.push({ at: this.bytes.length - 2, end: this.bytes.length, label });
    return this;
  }

  finish(): number[] {
    for (const { at, end, label } of this.fixups) {
      if (label.address === null) throw new Error('Sprungziel fehlt');
      const offset = label.address - end;
      if (offset < -32768 || offset > 32767) throw new Error('Programm ist zu groß');
      this.bytes[at] = offset & 0xff;
      this.bytes[at + 1] = (offset >> 8) & 0xff;
    }
    return this.bytes;
  }
}

export interface ProgramObject {
  code: CodeBuffer;
  localBytes: number;
}

/** Firmware bytecode version 1.04, stored as 104. */
const BYTECODE_VERSION = 104;
const IMAGE_HEADER = 16;
const OBJECT_HEADER = 12;

/**
 * Builds an .rbf image. Every object is a VMTHREAD; the VM starts object 1, the
 * others are started with opOBJECT_START. The program ends when all have ended.
 */
export function buildImage(globalBytes: number, objects: ProgramObject[]): Uint8Array {
  const bodies = objects.map((o) => o.code.finish());
  const size = IMAGE_HEADER + OBJECT_HEADER * objects.length + bodies.reduce((n, b) => n + b.length, 0);
  const image = new Uint8Array(size);
  const view = new DataView(image.buffer);
  image.set([0x4c, 0x45, 0x47, 0x4f]); // "LEGO"
  view.setUint32(4, size, true);
  view.setUint16(8, BYTECODE_VERSION, true);
  view.setUint16(10, objects.length, true);
  view.setUint32(12, globalBytes, true);

  let offset = IMAGE_HEADER + OBJECT_HEADER * objects.length;
  objects.forEach((object, i) => {
    const head = IMAGE_HEADER + OBJECT_HEADER * i;
    view.setUint32(head, offset, true); // OffsetToInstructions
    view.setUint16(head + 4, 0, true); // OwnerObjectId: 0 = VMTHREAD
    view.setUint16(head + 6, 0, true); // TriggerCount
    view.setUint32(head + 8, object.localBytes, true);
    image.set(bodies[i], offset);
    offset += bodies[i].length;
  });
  return image;
}
