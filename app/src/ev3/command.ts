import { gv, lc, lcs } from './assembler';
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
    this.code.push(...lc(value));
    return this;
  }

  /** Appends a zero-terminated string constant (ASCII only). */
  lcs(text: string): this {
    this.code.push(...lcs(text));
    return this;
  }

  /** Appends a reference to the global variable at `offset`. */
  gv(offset: number): this {
    this.code.push(...gv(offset));
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
