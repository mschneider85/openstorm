import { beforeAll, describe, expect, it } from 'vitest';
import type { BleBridge as BleBridgeType } from '../src/transport/bridge';
import type { Ev3Brick as Ev3BrickType } from '../src/ev3/ev3brick';

const SERVICE = '5e3d0001-8b6f-4c1e-9a3f-0e7d3c2b1a00';
const UUIDS = {
  in: '5e3d0002-8b6f-4c1e-9a3f-0e7d3c2b1a00',
  out: '5e3d0003-8b6f-4c1e-9a3f-0e7d3c2b1a00',
  control: '5e3d0004-8b6f-4c1e-9a3f-0e7d3c2b1a00',
};

class FakeCharacteristic extends EventTarget {
  value: DataView | null = null;
  properties = { writeWithoutResponse: true };
  written: Uint8Array[] = [];
  onWrite: (data: Uint8Array) => void = () => {};
  async writeValueWithoutResponse(data: Uint8Array) {
    expect(data.length).toBeLessThanOrEqual(20);
    this.written.push(data);
    this.onWrite(data);
  }
  async writeValue(data: Uint8Array) {
    return this.writeValueWithoutResponse(data);
  }
  async startNotifications() {
    return this;
  }
  /** Sends a notification in 20-byte pieces, like the Python bridge. */
  notify(bytes: Uint8Array) {
    for (let i = 0; i < bytes.length; i += 20) {
      const piece = bytes.slice(i, i + 20);
      this.value = new DataView(piece.buffer);
      this.dispatchEvent(new Event('characteristicvaluechanged'));
    }
  }
}

/** Emulates the Pi bridge plus an EV3 that answers every command with zeroed globals. */
function fakeBridge() {
  const chars = { in: new FakeCharacteristic(), out: new FakeCharacteristic(), control: new FakeCharacteristic() };
  const device = Object.assign(new EventTarget(), {
    name: 'OpenStorm',
    gatt: {
      connected: true,
      connect: async () => ({
        getPrimaryService: async (uuid: string) => {
          expect(uuid).toBe(SERVICE);
          return {
            getCharacteristic: async (u: string) =>
              u === UUIDS.in ? chars.in : u === UUIDS.out ? chars.out : chars.control,
          };
        },
      }),
      disconnect: () => device.dispatchEvent(new Event('gattserverdisconnected')),
    },
  });
  const commands: Record<string, unknown>[] = [];
  let controlText = '';
  const send = (event: object) => chars.control.notify(new TextEncoder().encode(JSON.stringify(event) + '\n'));
  chars.control.onWrite = (data) => {
    controlText += new TextDecoder().decode(data);
    const lines = controlText.split('\n');
    controlText = lines.pop()!;
    for (const line of lines) {
      const cmd = JSON.parse(line);
      commands.push(cmd);
      queueMicrotask(() => {
        if (cmd.cmd === 'status') send({ event: 'status', connected: false, address: null, name: null });
        if (cmd.cmd === 'scan')
          send({ event: 'devices', devices: [{ address: '00:16:53:01:02:03', name: 'Robo Größe', paired: false, ev3: true }] });
        if (cmd.cmd === 'connect') send({ event: 'connected', address: cmd.address, name: 'Robo' });
      });
    }
  };
  let stream: number[] = [];
  chars.in.onWrite = (data) => {
    stream.push(...data);
    while (stream.length >= 2 && stream.length >= (stream[0] | (stream[1] << 8)) + 2) {
      const frame = stream.slice(0, (stream[0] | (stream[1] << 8)) + 2);
      stream = stream.slice(frame.length);
      const globals = frame[5] | ((frame[6] & 3) << 8);
      const reply = new Uint8Array(5 + globals);
      reply[0] = (reply.length - 2) & 0xff;
      reply[1] = (reply.length - 2) >> 8;
      reply[2] = frame[2];
      reply[3] = frame[3];
      reply[4] = 0x02;
      if (frame[7] === 0xd3) new TextEncoder().encode('Robo').forEach((c, i) => (reply[5 + i] = c));
      queueMicrotask(() => chars.out.notify(reply));
    }
  };
  return { device, chars, commands };
}

let BleBridge: typeof BleBridgeType;
let Ev3Brick: typeof Ev3BrickType;
let fake: ReturnType<typeof fakeBridge>;

beforeAll(async () => {
  fake = fakeBridge();
  Object.defineProperty(globalThis.navigator, 'bluetooth', {
    value: { requestDevice: async () => fake.device },
    configurable: true,
  });
  ({ BleBridge } = await import('../src/transport/bridge'));
  ({ Ev3Brick } = await import('../src/ev3/ev3brick'));
});

describe('BleBridge', () => {
  it('scans, connects and talks to the EV3 through 20-byte chunks', async () => {
    const bridge = await BleBridge.request();
    expect((await bridge.status()).connected).toBe(false);
    const devices = await bridge.scan();
    expect(devices[0].name).toBe('Robo Größe');
    expect(await bridge.connectEv3(devices[0].address)).toBe('Robo');
    expect(fake.commands.map((c) => c.cmd)).toEqual(['status', 'scan', 'connect']);

    const brick = await Ev3Brick.connect(bridge, () => {});
    expect(brick.name).toBe('Robo');
    // 8 port reads need a 37-byte reply, which arrives in two notifications.
    const values = await brick.readPorts(['1', '2', '3', '4', 'A', 'B', 'C', 'D'].map((port) => ({ port: port as '1', mode: 0 })));
    expect(values).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('reports a lost bridge', async () => {
    const bridge = await BleBridge.request();
    const reasons: string[] = [];
    bridge.onClose = (r) => reasons.push(r);
    fake.device.dispatchEvent(new Event('gattserverdisconnected'));
    expect(reasons).toEqual(['Verbindung zur Brücke verloren']);
  });
});
