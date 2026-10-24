import { describe, expect, it } from 'vitest';
import { Command, portMask } from '../src/ev3/command';
import { op, sound } from '../src/ev3/bytecodes';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

describe('Command', () => {
  it('encodes constants in the smallest format', () => {
    const c = new Command().lc(0).lc(-1).lc(31).lc(32).lc(-128).lc(1000).lc(-1000).lc(100000);
    expect(hex(c.frame(0))).toBe(
      '17 00 00 00 00 00 00 00 3f 1f 81 20 81 80 82 e8 03 82 18 fc 83 a0 86 01 00',
    );
  });

  it('builds the tone command from the communication developer kit', () => {
    // Play a 1 kHz tone for 1 s at volume 2, counter 0, no reply.
    const c = new Command().op(op.SOUND, sound.TONE).lc(2).lc(1000).lc(1000);
    expect(hex(c.frame(0, false))).toBe('0e 00 00 00 80 00 00 94 01 02 82 e8 03 82 e8 03');
  });

  it('allocates global variables and references them', () => {
    const c = new Command();
    expect(c.alloc(4)).toBe(0);
    expect(c.alloc(30)).toBe(4);
    c.gv(4).gv(34).gv(300);
    const f = c.frame(0x1234);
    expect(f[2]).toBe(0x34);
    expect(f[3]).toBe(0x12);
    expect(f[5]).toBe(34); // global size low byte
    expect(Array.from(f.slice(7))).toEqual([0x64, 0xe1, 34, 0xe2, 300 & 0xff, 1]);
  });

  it('encodes strings', () => {
    const c = new Command().lcs('Hi');
    expect(Array.from(c.frame(0).slice(7))).toEqual([0x84, 0x48, 0x69, 0]);
  });

  it('builds port masks', () => {
    expect(portMask(['A'])).toBe(1);
    expect(portMask(['B', 'C'])).toBe(6);
    expect(portMask(['A', 'B', 'C', 'D'])).toBe(15);
  });
});
