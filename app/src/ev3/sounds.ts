import type { BrickFiles } from './files';

/**
 * Sounds for "spiele Klang". They are synthesized here, so the app can upload
 * them to the brick as .rsf files and play the very same samples in the simulator.
 */

export const SAMPLE_RATE = 8000;
/** Folder on the brick that holds the sound files (relative to lms2012/sys). */
export const SOUND_FOLDER = '../prjs/OpenStorm';

type Wave = (t: number) => number;

const square: Wave = (t) => (t % 1 < 0.5 ? 1 : -1);
const sine: Wave = (t) => Math.sin(2 * Math.PI * t);

/** One tone segment: frequency (start → end), duration, waveform, volume envelope. */
interface Segment {
  f0: number;
  f1?: number;
  ms: number;
  wave?: Wave;
  decay?: boolean;
  gain?: number;
}

function synth(segments: Segment[]): Float32Array<ArrayBuffer> {
  const total = segments.reduce((n, s) => n + Math.round((s.ms * SAMPLE_RATE) / 1000), 0);
  const out = new Float32Array(total);
  let at = 0;
  let phase = 0;
  for (const s of segments) {
    const n = Math.round((s.ms * SAMPLE_RATE) / 1000);
    const wave = s.wave ?? square;
    for (let k = 0; k < n; k++) {
      const p = k / n;
      const f = s.f0 + ((s.f1 ?? s.f0) - s.f0) * p;
      phase += f / SAMPLE_RATE;
      const env = (s.decay ? Math.exp(-4 * p) : 1) * Math.min(1, (n - k) / 40, k / 40);
      out[at + k] = s.f0 === 0 ? 0 : wave(phase) * env * (s.gain ?? 0.8);
    }
    at += n;
  }
  return out;
}

const note = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export const SOUNDS: Record<string, { label: string; make: () => Float32Array<ArrayBuffer> }> = {
  Hupe: { label: 'Hupe', make: () => synth([{ f0: 392, ms: 250 }, { f0: 0, ms: 60 }, { f0: 392, ms: 450 }]) },
  Sirene: {
    label: 'Sirene',
    make: () => synth([{ f0: 600, f1: 1200, ms: 450, wave: sine }, { f0: 1200, f1: 600, ms: 450, wave: sine }, { f0: 600, f1: 1200, ms: 450, wave: sine }, { f0: 1200, f1: 600, ms: 450, wave: sine }]),
  },
  Laser: { label: 'Laser', make: () => synth([{ f0: 2400, f1: 300, ms: 300 }]) },
  Erfolg: {
    label: 'Erfolg',
    make: () => synth([...[72, 76, 79].map((n): Segment => ({ f0: note(n), ms: 120 })), { f0: note(84), ms: 400, decay: true }]),
  },
  Fehler: { label: 'Fehler', make: () => synth([{ f0: 220, f1: 110, ms: 600, gain: 0.9 }]) },
  Roboter: {
    label: 'Roboter',
    make: () => synth([880, 660, 990, 550, 770, 1100, 440].map((f) => ({ f0: f, ms: 70 }))),
  },
  Klingel: { label: 'Klingel', make: () => synth([{ f0: 1318, ms: 700, wave: sine, decay: true, gain: 1 }]) },
  Pfiff: { label: 'Pfiff', make: () => synth([{ f0: 900, f1: 2200, ms: 350, wave: sine }]) },
  Countdown: {
    label: 'Countdown',
    make: () => synth([{ f0: 880, ms: 150 }, { f0: 0, ms: 350 }, { f0: 880, ms: 150 }, { f0: 0, ms: 350 }, { f0: 880, ms: 150 }, { f0: 0, ms: 350 }, { f0: 1760, ms: 600 }]),
  },
  Tusch: {
    label: 'Tusch',
    make: () => synth([{ f0: note(67), ms: 110 }, { f0: 0, ms: 30 }, { f0: note(67), ms: 110 }, { f0: 0, ms: 30 }, { f0: note(72), ms: 500, decay: true }]),
  },
};

export const SOUND_OPTIONS: [string, string][] = Object.entries(SOUNDS).map(([id, { label }]) => [label, id]);

const cache = new Map<string, Float32Array<ArrayBuffer>>();

export function soundSamples(id: string): Float32Array<ArrayBuffer> {
  let samples = cache.get(id);
  if (!samples) {
    samples = (SOUNDS[id] ?? SOUNDS.Hupe).make();
    cache.set(id, samples);
  }
  return samples;
}

export function soundMs(id: string): number {
  return Math.round((soundSamples(id).length / SAMPLE_RATE) * 1000);
}

/** Path for opSOUND PLAY: without the .rsf extension. */
export function soundPath(id: string): string {
  return `${SOUND_FOLDER}/${id}`;
}

/** The LEGO sound file format: 8 byte header (big endian), then unsigned 8 bit samples. */
export function rsfFile(id: string): Uint8Array {
  const samples = soundSamples(id);
  const out = new Uint8Array(8 + samples.length);
  out.set([0x01, 0x00, samples.length >> 8, samples.length & 0xff, SAMPLE_RATE >> 8, SAMPLE_RATE & 0xff, 0, 0]);
  samples.forEach((v, k) => (out[8 + k] = Math.max(0, Math.min(255, Math.round(128 + v * 127)))));
  return out;
}

/** Uploads the sound files that are not on the brick yet. */
export async function uploadSounds(files: BrickFiles, ids: Iterable<string>): Promise<void> {
  const wanted = [...new Set(ids)].filter((id) => SOUNDS[id]);
  if (wanted.length === 0) return;
  const present = new Set((await files.list(`${SOUND_FOLDER}/`)).files);
  for (const id of wanted) {
    if (!present.has(`${id}.rsf`)) await files.write(`${SOUND_FOLDER}/${id}.rsf`, rsfFile(id));
  }
}
