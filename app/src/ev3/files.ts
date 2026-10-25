import { ascii } from './assembler';
import { SYSTEM_END_OF_FILE, SYSTEM_OK, USER_SLOT, file, op, sys } from './bytecodes';
import { Command } from './command';
import type { Ev3Connection, SystemReply } from './connection';

/** Files on the brick and its programs. Paths are relative to /home/root/lms2012/sys. */
export interface BrickFiles {
  write(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  list(folder: string): Promise<{ folders: string[]; files: string[] }>;
  /** Deletes a file or an empty folder. */
  delete(path: string): Promise<void>;
  /** Starts an .rbf program as if chosen on the brick. */
  startProgram(path: string): Promise<void>;
  stopProgram(): Promise<void>;
}

/** Bytes of file data per message; the brick accepts messages up to 1024 bytes. */
const CHUNK = 900;

const STATUS: Record<number, string> = {
  4: 'zu viele offene Dateien',
  5: 'keine Berechtigung',
  6: 'ungültiger Pfad',
  9: 'zu wenig Platz auf dem EV3',
  10: 'Datei oder Ordner nicht gefunden',
  11: 'ungültiger Dateiname',
};

const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const cstr = (s: string) => [...ascii(s)].map((c) => c.charCodeAt(0) & 0x7f).concat(0);
const readU32 = (d: Uint8Array, at: number) => (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;

function check(reply: SystemReply, what: string): SystemReply {
  if (reply.status !== SYSTEM_OK && reply.status !== SYSTEM_END_OF_FILE) {
    throw new Error(`${what}: ${STATUS[reply.status] ?? `Fehler ${reply.status}`}`);
  }
  return reply;
}

export class Ev3Files implements BrickFiles {
  constructor(private conn: Ev3Connection) {}

  async write(path: string, data: Uint8Array): Promise<void> {
    const what = 'Speichern auf dem EV3';
    const begin = check(await this.conn.system(sys.BEGIN_DOWNLOAD, [...u32(data.length), ...cstr(path)]), what);
    const handle = begin.data[0];
    for (let at = 0; at < data.length; at += CHUNK) {
      check(await this.conn.system(sys.CONTINUE_DOWNLOAD, [handle, ...data.subarray(at, at + CHUNK)]), what);
    }
  }

  async read(path: string): Promise<Uint8Array> {
    const what = 'Lesen vom EV3';
    // reply: size (4), handle (1), data
    const begin = check(await this.conn.system(sys.BEGIN_UPLOAD, [...u16(CHUNK), ...cstr(path)]), what);
    const size = readU32(begin.data, 0);
    const handle = begin.data[4];
    const out = new Uint8Array(size);
    let got = begin.data.length - 5;
    out.set(begin.data.subarray(5, 5 + Math.min(got, size)));
    while (got < size) {
      // reply: handle (1), data
      const next = check(await this.conn.system(sys.CONTINUE_UPLOAD, [handle, ...u16(CHUNK)]), what);
      const part = next.data.subarray(1);
      if (part.length === 0) break;
      out.set(part.subarray(0, size - got), got);
      got += part.length;
    }
    return out;
  }

  /** Folders end with "/" in the brick's listing, files are "md5 size name". */
  async list(folder: string): Promise<{ folders: string[]; files: string[] }> {
    // reply: size (4), handle (1), text; longer listings continue in further messages.
    let reply = await this.conn.system(sys.LIST_FILES, [...u16(CHUNK), ...cstr(folder)]);
    if (reply.status !== SYSTEM_OK && reply.status !== SYSTEM_END_OF_FILE) return { folders: [], files: [] };
    const size = readU32(reply.data, 0);
    const handle = reply.data[4];
    const parts = [reply.data.subarray(5)];
    let got = parts[0].length;
    while (got < size && reply.status !== SYSTEM_END_OF_FILE) {
      // reply: handle (1), text
      reply = check(await this.conn.system(sys.CONTINUE_LIST_FILES, [handle, ...u16(CHUNK)]), 'Lesen vom EV3');
      const part = reply.data.subarray(1);
      if (part.length === 0) break;
      parts.push(part);
      got += part.length;
    }
    const all = new Uint8Array(got);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    const text = new TextDecoder().decode(all);
    const folders: string[] = [];
    const files: string[] = [];
    for (const line of text.split('\n')) {
      if (!line || line === './' || line === '../') continue;
      if (line.endsWith('/')) folders.push(line.slice(0, -1));
      else files.push(line.split(' ').slice(2).join(' '));
    }
    return { folders, files };
  }

  async delete(path: string): Promise<void> {
    check(await this.conn.system(sys.DELETE_FILE, cstr(path)), 'Löschen auf dem EV3');
  }

  async startProgram(path: string): Promise<void> {
    await this.stopProgram();
    const cmd = new Command();
    const size = cmd.alloc(4);
    const ip = cmd.alloc(4);
    cmd.op(op.FILE, file.LOAD_IMAGE).lc(USER_SLOT).lcs(path).gv(size).gv(ip);
    cmd.op(op.PROGRAM_START).lc(USER_SLOT).gv(size).gv(ip).lc(0);
    await this.conn.execute(cmd);
  }

  async stopProgram(): Promise<void> {
    await this.conn.execute(new Command().op(op.PROGRAM_STOP).lc(USER_SLOT));
  }
}
