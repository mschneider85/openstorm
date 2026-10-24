import { describe, expect, it } from 'vitest';
import { FrameSplitter, fromBase64, toBase64 } from '../src/transport/framing';

describe('FrameSplitter', () => {
  it('reassembles frames split across chunks and splits joined frames', () => {
    const frames: number[][] = [];
    const s = new FrameSplitter((f) => frames.push(Array.from(f)));
    s.push(new Uint8Array([3, 0, 1]));
    s.push(new Uint8Array([0, 2]));
    s.push(new Uint8Array([2, 0, 9, 9, 1]));
    expect(frames).toEqual([[3, 0, 1, 0, 2], [2, 0, 9, 9]]);
    s.push(new Uint8Array([0, 7]));
    expect(frames[2]).toEqual([1, 0, 7]);
  });

  it('round-trips base64', () => {
    const bytes = new Uint8Array([0, 1, 254, 255, 128]);
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });
});
