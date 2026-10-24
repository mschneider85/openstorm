import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { FrameSplitter, fromBase64, toBase64 } from './framing';
import type { Transport } from './transport';

export interface PairedBrick {
  id: number;
  name: string;
}

/** The native plugin in ios/App/App/EV3Plugin.swift. */
interface EV3Plugin {
  list(): Promise<{ devices: PairedBrick[] }>;
  showPicker(): Promise<{ cancelled: boolean }>;
  connect(options: { id: number }): Promise<{ name: string }>;
  send(options: { data: string }): Promise<void>;
  disconnect(): Promise<void>;
  addListener(event: 'data', fn: (e: { data: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'disconnected', fn: (e: { reason: string }) => void): Promise<PluginListenerHandle>;
}

const EV3 = registerPlugin<EV3Plugin>('EV3');

export const iosBluetoothAvailable = () => Capacitor.getPlatform() === 'ios';

export async function listPairedBricks(): Promise<PairedBrick[]> {
  return (await EV3.list()).devices;
}

/** Opens the system dialog for pairing a new brick. Returns false if cancelled. */
export async function pairBrick(): Promise<boolean> {
  return !(await EV3.showPicker()).cancelled;
}

/** Bluetooth connection on the iPad through the native External Accessory plugin. */
export class IosTransport implements Transport {
  onFrame: (frame: Uint8Array) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private splitter = new FrameSplitter((f) => this.onFrame(f));
  private listeners: PluginListenerHandle[] = [];

  static async open(brick: PairedBrick): Promise<IosTransport> {
    const t = new IosTransport();
    t.listeners.push(
      await EV3.addListener('data', (e) => t.splitter.push(fromBase64(e.data))),
      await EV3.addListener('disconnected', (e) => {
        t.removeListeners();
        t.onClose(e.reason);
      }),
    );
    try {
      await EV3.connect({ id: brick.id });
    } catch (e) {
      t.removeListeners();
      throw e;
    }
    return t;
  }

  send(frame: Uint8Array): void {
    EV3.send({ data: toBase64(frame) }).catch((e: Error) => this.onClose(e.message));
  }

  close(): void {
    this.removeListeners();
    void EV3.disconnect();
  }

  private removeListeners(): void {
    this.listeners.forEach((l) => void l.remove());
    this.listeners = [];
  }
}
