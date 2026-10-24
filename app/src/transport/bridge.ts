import { FrameSplitter } from './framing';
import type { Transport } from './transport';

// Must match bridge/openstorm_bridge.py.
const SERVICE = '5e3d0001-8b6f-4c1e-9a3f-0e7d3c2b1a00';
const DATA_IN = '5e3d0002-8b6f-4c1e-9a3f-0e7d3c2b1a00';
const DATA_OUT = '5e3d0003-8b6f-4c1e-9a3f-0e7d3c2b1a00';
const CONTROL = '5e3d0004-8b6f-4c1e-9a3f-0e7d3c2b1a00';
/** Fits into every BLE connection regardless of the negotiated MTU. */
const CHUNK = 20;

export interface Ev3Device {
  address: string;
  name: string;
  paired: boolean;
  ev3: boolean;
}

export type BridgeEvent =
  | {
      event: 'status';
      connected: boolean;
      address: string | null;
      name: string | null;
      /** Missing on older bridges. */
      bluetooth?: boolean;
      error?: string | null;
      version?: string;
    }
  | { event: 'devices'; devices: Ev3Device[] }
  | { event: 'connected'; address: string; name: string }
  | { event: 'disconnected'; reason: string }
  | { event: 'update_info'; current: string; latest: string; available: boolean }
  | { event: 'updating'; version: string }
  | { event: 'error'; message: string };

export type BridgeStatus = Extract<BridgeEvent, { event: 'status' }>;
export type UpdateInfo = Extract<BridgeEvent, { event: 'update_info' }>;

/**
 * Connection to the OpenStorm bridge (Raspberry Pi), which forwards the byte
 * stream to the EV3 over Bluetooth Classic. JSON commands control the bridge.
 */
export abstract class BridgeConnection implements Transport {
  onFrame: (frame: Uint8Array) => void = () => {};
  onClose: (reason: string) => void = () => {};
  protected splitter = new FrameSplitter((f) => this.onFrame(f));
  protected closed = false;
  private waiters: ((e: BridgeEvent) => boolean)[] = [];

  abstract send(frame: Uint8Array): void;
  abstract close(): void;
  protected abstract sendCommand(json: string): void;

  status(): Promise<BridgeStatus> {
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

  /** Asks the bridge whether GitHub has a newer version (needs internet on the Pi). */
  checkUpdate(): Promise<UpdateInfo> {
    return this.request({ cmd: 'update_check' }, 'update_info', 30000);
  }

  /** Installs the newest version; the bridge restarts itself afterwards. */
  async update(): Promise<string> {
    return (await this.request({ cmd: 'update' }, 'updating', 180000)).version;
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
    this.sendCommand(JSON.stringify(command));
    return result;
  }

  protected handleEvent(event: BridgeEvent): void {
    const index = this.waiters.findIndex((w) => w(event));
    if (index >= 0) this.waiters.splice(index, 1);
    else if (event.event === 'disconnected') this.onClose(`EV3 getrennt: ${event.reason}`);
  }

  protected lost(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.waiters.forEach((w) => w({ event: 'error', message: reason }));
    this.waiters = [];
    this.onClose(reason);
  }
}

// --- WLAN (WebSocket) -----------------------------------------------------------

/** WebSocket address of the bridge if this page was loaded from it (http://openstorm.local/). */
export function bridgeUrlFromPage(): string | null {
  const { protocol, hostname, host } = location;
  if (protocol !== 'http:' || hostname === 'localhost' || hostname === '127.0.0.1') return null;
  return `ws://${host}/ws`;
}

export class WsBridge extends BridgeConnection {
  private constructor(private ws: WebSocket) {
    super();
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (msg) => {
      if (typeof msg.data === 'string') this.handleEvent(JSON.parse(msg.data) as BridgeEvent);
      else this.splitter.push(new Uint8Array(msg.data as ArrayBuffer));
    };
    ws.onclose = () => this.lost('Verbindung zur Brücke verloren (WLAN)');
  }

  static open(url: string): Promise<WsBridge> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Brücke nicht erreichbar'));
      }, 5000);
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Brücke nicht erreichbar'));
      };
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new WsBridge(ws));
      };
    });
  }

  send(frame: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame as Uint8Array<ArrayBuffer>);
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }

  protected sendCommand(json: string): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(json);
  }
}

// --- Bluetooth LE (Web Bluetooth: Bluefy, Chrome) -------------------------------

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

export class BleBridge extends BridgeConnection {
  private controlText = '';
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private device: Device,
    private dataIn: Characteristic,
    private control: Characteristic,
  ) {
    super();
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

  send(frame: Uint8Array): void {
    this.writeChunked(this.dataIn, frame);
  }

  close(): void {
    this.closed = true;
    this.device.gatt?.disconnect();
  }

  protected sendCommand(json: string): void {
    this.writeChunked(this.control, this.encoder.encode(json + '\n'));
  }

  private writeChunked(characteristic: Characteristic, bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const chunk = bytes.slice(i, i + CHUNK);
      // GATT allows only one operation at a time, so writes are queued.
      const fast = characteristic.properties.writeWithoutResponse && characteristic.writeValueWithoutResponse;
      this.writes = this.writes
        .then(() => (fast ? characteristic.writeValueWithoutResponse!(chunk) : characteristic.writeValue(chunk)))
        .catch(() => this.lost('Senden an die Brücke fehlgeschlagen'));
    }
  }

  private onControl(bytes: Uint8Array): void {
    this.controlText += this.decoder.decode(bytes, { stream: true });
    const lines = this.controlText.split('\n');
    this.controlText = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) this.handleEvent(JSON.parse(line) as BridgeEvent);
    }
  }
}

function bytesOf(characteristic: Characteristic): Uint8Array {
  const v = characteristic.value!;
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}
