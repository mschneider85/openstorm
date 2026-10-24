import { describe, expect, it } from 'vitest';
import { Ev3Brick } from '../src/ev3/ev3brick';
import type { Transport } from '../src/transport/transport';

/** A fake brick: answers every command with a reply whose globals are produced by `answer`. */
class FakeTransport implements Transport {
  onFrame: (frame: Uint8Array) => void = () => {};
  onClose: (reason: string) => void = () => {};
  sent: Uint8Array[] = [];
  constructor(private answer: (frame: Uint8Array, globals: DataView) => void) {}
  send(frame: Uint8Array): void {
    this.sent.push(frame);
    const globalSize = frame[5] | ((frame[6] & 3) << 8);
    const reply = new Uint8Array(5 + globalSize);
    reply[0] = (reply.length - 2) & 0xff;
    reply[2] = frame[2];
    reply[3] = frame[3];
    reply[4] = 0x02;
    this.answer(frame, new DataView(reply.buffer, 5));
    queueMicrotask(() => this.onFrame(reply));
  }
  close(): void {}
}

describe('Ev3Brick', () => {
  it('reads the brick name on connect', async () => {
    const t = new FakeTransport((frame, g) => {
      if (frame[7] === 0xd3) 'Robo'.split('').forEach((ch, i) => g.setUint8(i, ch.charCodeAt(0)));
    });
    const brick = await Ev3Brick.connect(t, () => {});
    expect(brick.name).toBe('Robo');
  });

  it('decodes sensor values and port states', async () => {
    const t = new FakeTransport((frame, g) => {
      if (frame[7] === 0x9d) g.setFloat32(0, 12.5, true);
      if (frame[7] === 0x99) {
        for (let i = 0; i < 8; i++) {
          g.setUint8(i * 2, i === 0 ? 16 : 126);
          g.setInt8(i * 2 + 1, 0);
        }
      }
    });
    const brick = await Ev3Brick.connect(t, () => {});
    expect(await brick.readPort('4', 0)).toBe(12.5);
    const states = await brick.readPortStates();
    expect(states[0]).toEqual({ port: '1', type: 16, mode: 0 });
    expect(states[7]).toEqual({ port: 'D', type: 126, mode: 0 });
    // Motor ports are addressed as 16-19 when read as inputs.
    await brick.readPort('B', 0);
    const last = t.sent[t.sent.length - 1];
    expect(Array.from(last.slice(7, 10))).toEqual([0x9d, 0x00, 17]);
  });

  it('encodes a motor run in degrees with the sign on the speed', async () => {
    const t = new FakeTransport(() => {});
    const brick = await Ev3Brick.connect(t, () => {});
    await brick.motorRunDegrees(['B', 'C'], 50, -720, true);
    const f = t.sent[t.sent.length - 1];
    expect(Array.from(f.slice(7))).toEqual([0xae, 0x00, 0x06, 0x81, 0xce, 0x00, 0x82, 0xd0, 0x02, 0x00, 0x01]);
  });

  it('rejects on error replies', async () => {
    const t = new FakeTransport(() => {});
    const brick = await Ev3Brick.connect(t, () => {});
    t.send = (frame) => {
      const reply = new Uint8Array([3, 0, frame[2], frame[3], 0x04]);
      queueMicrotask(() => t.onFrame(reply));
    };
    await expect(brick.battery()).rejects.toThrow(/Fehler/);
  });
});
