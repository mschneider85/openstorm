import { DIRECT_COMMAND_NO_REPLY, DIRECT_COMMAND_REPLY } from './bytecodes';

/**
 * Builds the bytecode of one EV3 direct command.
 *
 * Parameters are encoded as LCx constants (smallest fitting size), strings as
 * LCS, and results land in global variables (GVx) that the brick returns in its
 * reply. `alloc()` reserves space in that global area and returns the offset.
 */
export class Command {
  private code: number[] = [];
  private globalSize = 0;

  /** Appends raw bytes (opcodes, sub-codes). */
  op(...bytes: number[]): this {
    this.code.push(...bytes);
    return this;
  }

  /** Appends an integer constant. */
  lc(value: number): this {
    const v = Math.round(value);
    if (v >= -31 && v <= 31) {
      this.code.push(v & 0x3f);
    } else if (v >= -128 && v <= 127) {
      this.code.push(0x81, v & 0xff);
    } else if (v >= -32768 && v <= 32767) {
      this.code.push(0x82, v & 0xff, (v >> 8) & 0xff);
    } else {
      this.code.push(0x83, v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    }
    return this;
  }

  /** Appends a zero-terminated string constant (ASCII only). */
  lcs(text: string): this {
    this.code.push(0x84);
    for (const ch of text) {
      const c = ch.charCodeAt(0);
      this.code.push(c > 0 && c < 128 ? c : 0x3f);
    }
    this.code.push(0);
    return this;
  }

  /** Appends a reference to the global variable at `offset`. */
  gv(offset: number): this {
    if (offset < 32) {
      this.code.push(0x60 | offset);
    } else if (offset < 256) {
      this.code.push(0xe1, offset);
    } else {
      this.code.push(0xe2, offset & 0xff, offset >> 8);
    }
    return this;
  }

  /** Reserves `size` bytes of global memory and returns the offset. */
  alloc(size: number): number {
    const offset = this.globalSize;
    this.globalSize += size;
    if (this.globalSize > 1019) throw new Error('EV3 command uses too much global memory');
    return offset;
  }

  get globals(): number {
    return this.globalSize;
  }

  /** Serializes the command into a complete frame including length prefix. */
  frame(counter: number, reply = true): Uint8Array {
    const body = [
      counter & 0xff,
      (counter >> 8) & 0xff,
      reply ? DIRECT_COMMAND_REPLY : DIRECT_COMMAND_NO_REPLY,
      this.globalSize & 0xff,
      (this.globalSize >> 8) & 0x03, // no local variables
      ...this.code,
    ];
    return new Uint8Array([body.length & 0xff, body.length >> 8, ...body]);
  }
}

/** Bitmask for output ports A-D as used by the opOUTPUT_* opcodes. */
export function portMask(ports: readonly string[]): number {
  return ports.reduce((mask, p) => mask | (1 << ('ABCD'.indexOf(p))), 0);
}
