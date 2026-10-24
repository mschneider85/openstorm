/**
 * A byte pipe to an EV3 brick. Frames are complete EV3 messages including
 * their 2-byte length prefix, in both directions.
 */
export interface Transport {
  send(frame: Uint8Array): void;
  onFrame: (frame: Uint8Array) => void;
  onClose: (reason: string) => void;
  close(): void;
}
