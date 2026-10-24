/** Splits a byte stream into EV3 frames (2-byte little-endian length prefix). */
export class FrameSplitter {
  private buffer = new Uint8Array(0);

  constructor(private onFrame: (frame: Uint8Array) => void) {}

  push(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    let offset = 0;
    while (joined.length - offset >= 2) {
      const size = joined[offset] | (joined[offset + 1] << 8);
      if (joined.length - offset < size + 2) break;
      this.onFrame(joined.slice(offset, offset + size + 2));
      offset += size + 2;
    }
    this.buffer = joined.slice(offset);
  }
}

export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
