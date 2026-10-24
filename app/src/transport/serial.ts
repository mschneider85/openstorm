import { FrameSplitter } from './framing';
import type { Transport } from './transport';

// Minimal typings for the Web Serial API (Chrome/Edge on desktop).
interface SerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface Serial {
  requestPort(): Promise<SerialPort>;
}

const serial = (navigator as Navigator & { serial?: Serial }).serial;

export const serialAvailable = () => serial !== undefined;

/**
 * Connection through a serial port, for Chrome/Edge on a PC or Mac: a paired EV3
 * shows up there as a Bluetooth serial port (COM port / /dev/tty.EV3-SerialPort).
 */
export class SerialTransport implements Transport {
  onFrame: (frame: Uint8Array) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private splitter = new FrameSplitter((f) => this.onFrame(f));
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private closed = false;

  private constructor(private port: SerialPort) {
    this.writer = port.writable!.getWriter();
    void this.readLoop();
  }

  /** Asks the user to pick the port; must be called from a click handler. */
  static async open(): Promise<SerialTransport> {
    if (!serial) throw new Error('Dieser Browser unterstützt keine seriellen Verbindungen');
    const port = await serial.requestPort();
    await port.open({ baudRate: 115200 });
    return new SerialTransport(port);
  }

  private async readLoop(): Promise<void> {
    try {
      this.reader = this.port.readable!.getReader();
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) this.splitter.push(value);
      }
    } catch {
      // Reading fails when the brick is switched off; reported below.
    }
    if (!this.closed) this.onClose('Serielle Verbindung unterbrochen');
  }

  send(frame: Uint8Array): void {
    this.writer.write(frame).catch(() => this.onClose('Senden fehlgeschlagen'));
  }

  close(): void {
    this.closed = true;
    void (async () => {
      await this.reader?.cancel().catch(() => {});
      this.reader?.releaseLock();
      this.writer.releaseLock();
      await this.port.close().catch(() => {});
    })();
  }
}
