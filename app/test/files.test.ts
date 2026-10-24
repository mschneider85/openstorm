import { describe, expect, it } from 'vitest';
import { Ev3Connection } from '../src/ev3/connection';
import { Ev3Files } from '../src/ev3/files';
import type { Transport } from '../src/transport/transport';

/** A brick with an in-memory file system, answering system commands as described in c_com.h. */
class FakeFileBrick implements Transport {
  onFrame: (frame: Uint8Array) => void = () => {};
  onClose: (reason: string) => void = () => {};
  files = new Map<string, Uint8Array>();
  direct: Uint8Array[] = [];
  private writing: { path: string; data: number[]; size: number } | null = null;
  private reading: { data: Uint8Array; at: number } | null = null;

  send(frame: Uint8Array): void {
    const type = frame[4];
    const reply = (status: number, ...data: number[]) => {
      const body = [frame[2], frame[3], status === 0 || status === 8 ? 0x03 : 0x05, frame[5], status, ...data];
      queueMicrotask(() => this.onFrame(new Uint8Array([body.length & 0xff, body.length >> 8, ...body])));
    };
    if (type === 0x00) {
      this.direct.push(frame);
      const globals = frame[5] | ((frame[6] & 3) << 8);
      const body = [frame[2], frame[3], 0x02, ...new Array(globals).fill(0)];
      queueMicrotask(() => this.onFrame(new Uint8Array([body.length & 0xff, body.length >> 8, ...body])));
      return;
    }
    const cmd = frame[5];
    const p = frame.subarray(6);
    const text = (from: number) => String.fromCharCode(...p.subarray(from, p.indexOf(0, from)));
    const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
    if (cmd === 0x92) {
      this.writing = { path: text(4), data: [], size: p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24) };
      reply(0, 1);
    } else if (cmd === 0x93) {
      const w = this.writing!;
      w.data.push(...p.subarray(1));
      if (w.data.length >= w.size) this.files.set(w.path, new Uint8Array(w.data));
      reply(w.data.length >= w.size ? 8 : 0, 1);
    } else if (cmd === 0x94) {
      const max = p[0] | (p[1] << 8);
      const data = this.files.get(text(2));
      if (!data) return reply(10, 0, 0, 0, 0, 0);
      this.reading = { data, at: Math.min(max, data.length) };
      reply(data.length <= max ? 8 : 0, ...u32(data.length), 2, ...data.subarray(0, max));
    } else if (cmd === 0x95) {
      const r = this.reading!;
      const max = p[1] | (p[2] << 8);
      const part = r.data.subarray(r.at, r.at + max);
      r.at += part.length;
      reply(r.at >= r.data.length ? 8 : 0, 2, ...part);
    } else if (cmd === 0x99) {
      const folder = text(2);
      const entries = new Set<string>(['./', '../']);
      for (const [path, data] of this.files) {
        if (!path.startsWith(folder)) continue;
        const rest = path.slice(folder.length);
        entries.add(rest.includes('/') ? rest.split('/')[0] + '/' : `${'0'.repeat(32)} ${data.length.toString(16).padStart(8, '0')} ${rest}`);
      }
      const list = [...entries].map((e) => e + '\n').join('');
      reply(8, ...u32(list.length), 3, ...new TextEncoder().encode(list));
    }
  }
  close(): void {}
}

describe('files on the EV3', () => {
  it('writes, lists and reads back files larger than one message', async () => {
    const brick = new FakeFileBrick();
    const files = new Ev3Files(new Ev3Connection(brick));
    const data = Uint8Array.from({ length: 2500 }, (_, i) => i & 0xff);
    await files.write('../prjs/Mein_Roboter/Mein_Roboter.rbf', data);
    await files.write('../prjs/Mein_Roboter/.openstorm', new TextEncoder().encode('{}'));
    expect(brick.files.get('../prjs/Mein_Roboter/Mein_Roboter.rbf')).toEqual(data);

    expect(await files.list('../prjs/')).toEqual({ folders: ['Mein_Roboter'], files: [] });
    expect((await files.list('../prjs/Mein_Roboter/')).files.sort()).toEqual(['.openstorm', 'Mein_Roboter.rbf']);
    expect(await files.read('../prjs/Mein_Roboter/Mein_Roboter.rbf')).toEqual(data);
    await expect(files.read('../prjs/fehlt')).rejects.toThrow(/nicht gefunden/);
  });

  it('starts a program like the brick menu does', async () => {
    const brick = new FakeFileBrick();
    const files = new Ev3Files(new Ev3Connection(brick));
    await files.startProgram('../prjs/A/A.rbf');
    const start = brick.direct[1];
    // opFILE LOAD_IMAGE, user slot 1, path, then opPROGRAM_START
    expect([...start.subarray(7, 10)]).toEqual([0xc0, 0x08, 0x01]);
    expect(String.fromCharCode(...start.subarray(11, 26))).toBe('../prjs/A/A.rbf');
    expect([...start.subarray(-5)]).toEqual([0x03, 0x01, 0x60, 0x64, 0x00]); // PROGRAM_START slot 1, size, ip, no debug
  });
});
