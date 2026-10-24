import type { Brick } from './ev3/brick';

export type ConnectionKind = 'none' | 'sim' | 'ios' | 'serial' | 'bridge';

type Listener = () => void;

/** The currently connected brick, shared by all views. */
class AppState {
  brick: Brick | null = null;
  kind: ConnectionKind = 'none';
  running = false;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn();
  }

  setBrick(brick: Brick | null, kind: ConnectionKind): void {
    if (this.brick && this.brick !== brick) this.brick.close();
    this.brick = brick;
    this.kind = brick ? kind : 'none';
    this.notify();
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.notify();
  }
}

export const state = new AppState();
