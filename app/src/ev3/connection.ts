import { DIRECT_REPLY, DIRECT_REPLY_ERROR } from './bytecodes';
import type { Command } from './command';
import type { Transport } from '../transport/transport';

interface Pending {
  resolve: (globals: DataView) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Sends direct commands over a transport and matches replies by message counter. */
export class Ev3Connection {
  private counter = 0;
  private pending = new Map<number, Pending>();
  onClose: (reason: string) => void = () => {};

  constructor(private transport: Transport, private timeoutMs = 3000) {
    transport.onFrame = (frame) => this.handleFrame(frame);
    transport.onClose = (reason) => {
      this.failAll(new Error(reason));
      this.onClose(reason);
    };
  }

  /** Executes a command and resolves with its global variable area. */
  execute(cmd: Command): Promise<DataView> {
    this.counter = (this.counter + 1) & 0xffff;
    const id = this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Keine Antwort vom EV3 (Zeitüberschreitung)'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(cmd.frame(id));
    });
  }

  close(): void {
    this.failAll(new Error('Verbindung getrennt'));
    this.transport.close();
  }

  private handleFrame(frame: Uint8Array): void {
    if (frame.length < 5) return;
    const id = frame[2] | (frame[3] << 8);
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    const type = frame[4];
    if (type === DIRECT_REPLY) {
      entry.resolve(new DataView(frame.buffer, frame.byteOffset + 5, frame.length - 5));
    } else if (type === DIRECT_REPLY_ERROR) {
      entry.reject(new Error('EV3 meldet einen Fehler beim Ausführen des Befehls'));
    } else {
      entry.reject(new Error(`Unerwartete Antwort vom EV3 (Typ 0x${type.toString(16)})`));
    }
  }

  private failAll(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
