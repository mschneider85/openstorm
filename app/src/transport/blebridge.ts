import { FrameSplitter } from './framing';
import type { Transport } from './transport';

// Must match bridge/openstorm_bridge.py.
const SERVICE = '5e3d0001-8b6f-4c1e-9a3f-0e7d3c2b1a00';
const DATA_IN = '5e3d0002-8b6f-4c1e-9a3f-0e7d3c2b1a00';
const DATA_OUT = '5e3d0003-8b6f-4c1e-9a3f-0e7d3c2b1a00';
const CONTROL = '5e3d0004-8b6f-4c1e-9a3f-0e7d3c2b1a00';
/** Fits into every BLE connection regardless of the negotiated MTU. */
const CHUNK = 20;

// Minimal typings for Web Bluetooth (Chrome, Bluefy on iOS).
interface Characteristic extends EventTarget {
  value: DataView | null;
  properties: { writeWithoutResponse: boolean };
  writeValue(data: BufferSource): Promise<void>;
  writeValueWithoutResponse?(data: BufferSource): Promise<void>;
  startNotifications(): Promise<Characteristic>;
}
interface Device extends EventTarget {
  name?: string;
  gatt?: {
    connected: boolean;
    connect(): Promise<{ getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<Characteristic> }> }>;
    disconnect(): void;
  };
}
interface Bluetooth {
  requestDevice(options: object): Promise<Device>;
}

const bluetooth = (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth;

export const webBluetoothAvailable = () => bluetooth !== undefined;

export interface Ev3Device {
  address: string;
  name: string;
  paired: boolean;
  ev3: boolean;
}

type BridgeEvent =
  | { event: 'status'; connected: boolean; address: string | null; name: string | null }
  | { event: 'devices'; devices: Ev3Device[] }
  | { event: 'connected'; address: string; name: string }
  | { event: 'disconnected'; reason: string }
  | { event: 'error'; message: string };

/**
 * Connection through the OpenStorm bridge (Raspberry Pi): Bluetooth LE to the
 * bridge, which forwards the byte stream to the EV3 over Bluetooth Classic.
 */
export class BleBridge implements Transport {
  onFrame: (frame: Uint8Array) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private splitter = new FrameSplitter((f) => this.onFrame(f));
  private controlText = '';
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private writes: Promise<void> = Promise.resolve();
  private waiters: ((e: BridgeEvent) => boolean)[] = [];
  private closed = false;

  private constructor(
    private device: Device,
    private dataIn: Characteristic,
    private control: Characteristic,
  ) {}

  get bridgeName(): string {
    return this.device.name ?? 'OpenStorm';
  }

  /** Shows the browser's device picker; must be called from a tap/click. */
  static async request(): Promise<BleBridge> {
    if (!bluetooth) throw new Error('Dieser Browser unterstützt kein Web Bluetooth');
    const device = await bluetooth.requestDevice({
      filters: [{ services: [SERVICE] }, { namePrefix: 'OpenStorm' }],
      optionalServices: [SERVICE],
    });
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService(SERVICE);
    const [dataIn, dataOut, control] = await Promise.all(
      [DATA_IN, DATA_OUT, CONTROL].map((uuid) => service.getCharacteristic(uuid)),
    );
    const bridge = new BleBridge(device, dataIn, control);
    dataOut.addEventListener('characteristicvaluechanged', () => bridge.splitter.push(bytesOf(dataOut)));
    control.addEventListener('characteristicvaluechanged', () => bridge.onControl(bytesOf(control)));
    device.addEventListener('gattserverdisconnected', () => bridge.lost('Verbindung zur Brücke verloren'));
    await dataOut.startNotifications();
    await control.startNotifications();
    return bridge;
  }

  status(): Promise<Extract<BridgeEvent, { event: 'status' }>> {
    return this.request({ cmd: 'status' }, 'status', 5000);
  }

  async scan(): Promise<Ev3Device[]> {
    return (await this.request({ cmd: 'scan' }, 'devices', 30000)).devices;
  }

  /** Lets the bridge connect to the EV3 (the last used one if no address is given). */
  async connectEv3(address?: string): Promise<string> {
    // Pairing a new brick waits for the confirmation on the EV3, so allow plenty of time.
    return (await this.request({ cmd: 'connect', address }, 'connected', 60000)).name;
  }

  send(frame: Uint8Array): void {
    for (let i = 0; i < frame.length; i += CHUNK) this.write(this.dataIn, frame.slice(i, i + CHUNK));
  }

  close(): void {
    this.closed = true;
    this.device.gatt?.disconnect();
  }

  private write(characteristic: Characteristic, chunk: Uint8Array<ArrayBuffer>): void {
    // GATT allows only one operation at a time, so writes are queued.
    const fast = characteristic.properties.writeWithoutResponse && characteristic.writeValueWithoutResponse;
    this.writes = this.writes
      .then(() => (fast ? characteristic.writeValueWithoutResponse!(chunk) : characteristic.writeValue(chunk)))
      .catch(() => this.lost('Senden an die Brücke fehlgeschlagen'));
  }

  private request<K extends BridgeEvent['event']>(
    command: object,
    expected: K,
    timeoutMs: number,
  ): Promise<Extract<BridgeEvent, { event: K }>> {
    const result = new Promise<Extract<BridgeEvent, { event: K }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('Die Brücke antwortet nicht'));
      }, timeoutMs);
      const waiter = (e: BridgeEvent) => {
        if (e.event !== expected && e.event !== 'error') return false;
        clearTimeout(timer);
        if (e.event === 'error') reject(new Error(e.message));
        else resolve(e as Extract<BridgeEvent, { event: K }>);
        return true;
      };
      this.waiters.push(waiter);
    });
    const bytes = this.encoder.encode(JSON.stringify(command) + '\n');
    for (let i = 0; i < bytes.length; i += CHUNK) this.write(this.control, bytes.slice(i, i + CHUNK));
    return result;
  }

  private onControl(bytes: Uint8Array): void {
    this.controlText += this.decoder.decode(bytes, { stream: true });
    const lines = this.controlText.split('\n');
    this.controlText = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as BridgeEvent;
      const index = this.waiters.findIndex((w) => w(event));
      if (index >= 0) this.waiters.splice(index, 1);
      else if (event.event === 'disconnected') this.onClose(`EV3 getrennt: ${event.reason}`);
    }
  }

  private lost(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.waiters.forEach((w) => w({ event: 'error', message: reason }));
    this.waiters = [];
    this.onClose(reason);
  }
}

function bytesOf(characteristic: Characteristic): Uint8Array {
  const v = characteristic.value!;
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}
