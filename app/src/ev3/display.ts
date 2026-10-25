import { uiDraw } from './bytecodes';

/** The EV3 screen: 178 × 128 pixels, black on white. */
export const SCREEN_WIDTH = 178;
export const SCREEN_HEIGHT = 128;
/** Height of one text line for "schreibe … in Zeile" (as in EV3 Classroom). */
export const LINE_HEIGHT = 10;
export const LINES = 12;

/** 1 = black (foreground), 0 = white. */
export type Ink = 0 | 1;

/** Firmware fonts: 0 normal, 1 bold (the firmware calls it "small"), 2 large. */
export const FONTS = [
  { width: 8, height: 9 },
  { width: 8, height: 8 },
  { width: 16, height: 19 },
] as const;

export type DrawOp =
  | { op: 'clear' }
  | { op: 'text'; x: number; y: number; text: string; font: number; ink: Ink }
  | { op: 'pixel'; x: number; y: number; ink: Ink }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; ink: Ink }
  | { op: 'circle'; x: number; y: number; r: number; fill: boolean; ink: Ink }
  | { op: 'rect'; x: number; y: number; w: number; h: number; fill: boolean; ink: Ink }
  | { op: 'invert'; x: number; y: number; w: number; h: number };

/** Receives one opUI_DRAW instruction: sub-code and its parameters. */
export type DrawSink = (sub: number, args: (number | string)[]) => void;

const i = (v: number) => Math.round(v);

/** Translates drawing operations into opUI_DRAW instructions (without the final UPDATE). */
export function emitDraw(ops: readonly DrawOp[], sink: DrawSink): void {
  for (const d of ops) {
    switch (d.op) {
      case 'clear':
        sink(uiDraw.FILLWINDOW, [0, 0, 0]);
        break;
      case 'text':
        sink(uiDraw.SELECT_FONT, [d.font]);
        sink(uiDraw.TEXT, [d.ink, i(d.x), i(d.y), d.text]);
        break;
      case 'pixel':
        sink(uiDraw.PIXEL, [d.ink, i(d.x), i(d.y)]);
        break;
      case 'line':
        sink(uiDraw.LINE, [d.ink, i(d.x1), i(d.y1), i(d.x2), i(d.y2)]);
        break;
      case 'circle':
        sink(d.fill ? uiDraw.FILLCIRCLE : uiDraw.CIRCLE, [d.ink, i(d.x), i(d.y), i(d.r)]);
        break;
      case 'rect':
        sink(d.fill ? uiDraw.FILLRECT : uiDraw.RECT, [d.ink, i(d.x), i(d.y), i(d.w), i(d.h)]);
        break;
      case 'invert':
        sink(uiDraw.INVERSERECT, [i(d.x), i(d.y), i(d.w), i(d.h)]);
        break;
    }
  }
}

/** Ops that clear one text line and write into it, as "schreibe … in Zeile" does. */
export function lineOps(text: string, line: number): DrawOp[] {
  const y = (Math.min(LINES, Math.max(1, Math.round(line))) - 1) * LINE_HEIGHT;
  return [
    { op: 'rect', x: 0, y, w: SCREEN_WIDTH, h: LINE_HEIGHT, fill: true, ink: 0 },
    { op: 'text', x: 0, y, text, font: 0, ink: 1 },
  ];
}

// --- Images ---------------------------------------------------------------------------
// Drawn from primitives, so they need no files on the brick and look the same
// live, in the simulator and in programs on the EV3.

const black = 1 as const;
const white = 0 as const;
const fillCircle = (x: number, y: number, r: number, ink: Ink = black): DrawOp => ({ op: 'circle', x, y, r, fill: true, ink });
const fillRect = (x: number, y: number, w: number, h: number, ink: Ink = black): DrawOp => ({ op: 'rect', x, y, w, h, fill: true, ink });

/** A line `width` pixels thick: parallel lines, shifted both ways for slanted lines so no gaps show. */
function thick(x1: number, y1: number, x2: number, y2: number, width = 4, ink: Ink = black): DrawOp[] {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  const slanted = Math.min(dx, dy) > Math.max(dx, dy) / 4;
  const ops: DrawOp[] = [];
  for (let k = 0; k < width; k++) {
    const o = k - Math.floor(width / 2);
    if (dy > dx || slanted) ops.push({ op: 'line', x1: x1 + o, y1, x2: x2 + o, y2, ink });
    if (dy <= dx || slanted) ops.push({ op: 'line', x1, y1: y1 + o, x2, y2: y2 + o, ink });
  }
  return ops;
}

function polyline(points: [number, number][], width = 4): DrawOp[] {
  return points.slice(1).flatMap(([x, y], k) => thick(points[k][0], points[k][1], x, y, width));
}

/** Arc through angles a0..a1 (degrees, 0 = right, clockwise because y points down). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number, width = 4): DrawOp[] {
  const points: [number, number][] = [];
  for (let k = 0; k <= 12; k++) {
    const a = ((a0 + ((a1 - a0) * k) / 12) * Math.PI) / 180;
    points.push([Math.round(cx + r * Math.cos(a)), Math.round(cy + r * Math.sin(a))]);
  }
  return polyline(points, width);
}

/** Filled triangle from horizontal lines. */
function triangle(a: [number, number], b: [number, number], c: [number, number]): DrawOp[] {
  const ops: DrawOp[] = [];
  const pts = [a, b, c].sort((p, q) => p[1] - q[1]);
  const x = (p: [number, number], q: [number, number], y: number) => (q[1] === p[1] ? p[0] : p[0] + ((q[0] - p[0]) * (y - p[1])) / (q[1] - p[1]));
  for (let y = pts[0][1]; y <= pts[2][1]; y++) {
    const xa = x(pts[0], pts[2], y);
    const xb = y < pts[1][1] ? x(pts[0], pts[1], y) : x(pts[1], pts[2], y);
    ops.push({ op: 'line', x1: Math.round(Math.min(xa, xb)), y1: y, x2: Math.round(Math.max(xa, xb)), y2: y, ink: black });
  }
  return ops;
}

const EYES: [number, number][] = [[52, 64], [126, 64]];
const EYE_R = 30;

function eyes(dx = 0, dy = 0, pupil = 11): DrawOp[] {
  return EYES.flatMap(([x, y]) => [fillCircle(x, y, EYE_R), fillCircle(x, y, EYE_R - 4, white), fillCircle(x + dx, y + dy, pupil)]);
}

/** Covers the upper part of both eyes down to `y`, with a lid line. */
function lids(y: number): DrawOp[] {
  return [fillRect(18, 30, 142, y - 30, white), ...thick(20, y, 84, y, 4), ...thick(94, y, 158, y, 4)];
}

function heart(cx: number, cy: number, s: number): DrawOp[] {
  const r = 11 * s;
  return [
    fillCircle(cx - r, cy, r),
    fillCircle(cx + r, cy, r),
    ...triangle([cx - 2 * r, cy + 2], [cx + 2 * r, cy + 2], [cx, cy + 2.6 * r].map(Math.round) as [number, number]),
  ];
}

function arrow(dir: 'up' | 'down' | 'left' | 'right'): DrawOp[] {
  const map = (x: number, y: number): [number, number] => {
    const dx = x - 89;
    const dy = y - 64;
    if (dir === 'up') return [x, y];
    if (dir === 'down') return [89 - dx, 64 - dy];
    if (dir === 'left') return [89 + dy, 64 - dx];
    return [89 - dy, 64 + dx];
  };
  // The arrow points up; other directions rotate it around the centre.
  const [a, b] = [map(77, 52), map(101, 112)];
  return [
    fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])),
    ...triangle(map(49, 56), map(129, 56), map(89, 12)),
  ];
}

export const IMAGES: Record<string, { label: string; ops: DrawOp[] }> = {
  eyes_neutral: { label: 'Augen: neutral', ops: eyes() },
  eyes_left: { label: 'Augen: links', ops: eyes(-13, 0) },
  eyes_right: { label: 'Augen: rechts', ops: eyes(13, 0) },
  eyes_up: { label: 'Augen: oben', ops: eyes(0, -13) },
  eyes_down: { label: 'Augen: unten', ops: eyes(0, 13) },
  eyes_tired: { label: 'Augen: müde', ops: [...eyes(0, 10), ...lids(62)] },
  eyes_closed: { label: 'Augen: geschlossen', ops: [...thick(24, 66, 80, 66, 5), ...thick(98, 66, 154, 66, 5)] },
  eyes_wink: {
    label: 'Augen: zwinkern',
    ops: [...EYES.slice(0, 1).flatMap(([x, y]) => [fillCircle(x, y, EYE_R), fillCircle(x, y, EYE_R - 4, white), fillCircle(x, y, 11)]), ...arc(126, 76, 26, 200, 340, 5)],
  },
  eyes_angry: { label: 'Augen: wütend', ops: [...eyes(0, 6), ...thick(20, 22, 80, 42, 6), ...thick(158, 22, 98, 42, 6)] },
  eyes_sad: { label: 'Augen: traurig', ops: [...eyes(0, 10), ...thick(20, 42, 80, 22, 6), ...thick(158, 42, 98, 22, 6)] },
  eyes_surprised: {
    label: 'Augen: überrascht',
    ops: [...eyes(0, 0, 6), ...arc(52, 64, 40, 220, 320, 4), ...arc(126, 64, 40, 220, 320, 4)],
  },
  smiley: {
    label: 'Smiley',
    ops: [fillCircle(89, 64, 58), fillCircle(89, 64, 53, white), fillCircle(70, 46, 7), fillCircle(108, 46, 7), ...arc(89, 62, 32, 25, 155, 5)],
  },
  sad_face: {
    label: 'traurig',
    ops: [fillCircle(89, 64, 58), fillCircle(89, 64, 53, white), fillCircle(70, 46, 7), fillCircle(108, 46, 7), ...arc(89, 112, 30, 220, 320, 5)],
  },
  heart: { label: 'Herz', ops: heart(89, 46, 2) },
  heart_small: { label: 'Herz klein', ops: heart(89, 54, 1.2) },
  check: { label: 'Häkchen', ops: polyline([[40, 66], [74, 100], [140, 26]], 10) },
  cross: { label: 'Kreuz', ops: [...thick(44, 22, 134, 106, 10), ...thick(134, 22, 44, 106, 10)] },
  arrow_up: { label: 'Pfeil hoch', ops: arrow('up') },
  arrow_down: { label: 'Pfeil runter', ops: arrow('down') },
  arrow_left: { label: 'Pfeil links', ops: arrow('left') },
  arrow_right: { label: 'Pfeil rechts', ops: arrow('right') },
  stop: { label: 'Stopp', ops: [fillCircle(89, 64, 56), fillRect(51, 56, 76, 16, white)] },
};

export const IMAGE_OPTIONS: [string, string][] = Object.entries(IMAGES).map(([id, { label }]) => [label, id]);

/** All ops of an image, starting with a cleared screen. */
export function imageOps(id: string): DrawOp[] {
  return [{ op: 'clear' }, ...(IMAGES[id]?.ops ?? [])];
}

// --- Rendering (simulator) ----------------------------------------------------------------

const INK_RGB: Record<Ink, number[]> = { 0: [183, 196, 168, 255], 1: [29, 42, 29, 255] };

/** Draws operations onto a 178 × 128 canvas context, as the brick would. */
export function renderScreen(ctx: CanvasRenderingContext2D, ops: readonly DrawOp[]): void {
  const ink = (v: Ink) => `rgb(${INK_RGB[v].slice(0, 3).join(',')})`;
  ctx.fillStyle = ink(0);
  ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
  ctx.lineWidth = 1;
  for (const d of ops) {
    switch (d.op) {
      case 'clear':
        ctx.fillStyle = ink(0);
        ctx.fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
        break;
      case 'text': {
        const f = FONTS[d.font] ?? FONTS[0];
        ctx.fillStyle = ink(d.ink);
        ctx.font = `${d.font === 0 ? 'normal' : 'bold'} ${f.height + 1}px ui-monospace, monospace`;
        ctx.textBaseline = 'top';
        [...d.text].forEach((ch, k) => ctx.fillText(ch, d.x + k * f.width, d.y));
        break;
      }
      case 'pixel':
        ctx.fillStyle = ink(d.ink);
        ctx.fillRect(d.x, d.y, 1, 1);
        break;
      case 'line':
        ctx.strokeStyle = ink(d.ink);
        ctx.beginPath();
        ctx.moveTo(d.x1 + 0.5, d.y1 + 0.5);
        ctx.lineTo(d.x2 + 0.5, d.y2 + 0.5);
        ctx.stroke();
        break;
      case 'circle':
        ctx.beginPath();
        ctx.arc(d.x + 0.5, d.y + 0.5, Math.max(0, d.r), 0, 2 * Math.PI);
        if (d.fill) {
          ctx.fillStyle = ink(d.ink);
          ctx.fill();
        } else {
          ctx.strokeStyle = ink(d.ink);
          ctx.stroke();
        }
        break;
      case 'rect':
        if (d.fill) {
          ctx.fillStyle = ink(d.ink);
          ctx.fillRect(d.x, d.y, d.w, d.h);
        } else {
          ctx.strokeStyle = ink(d.ink);
          ctx.strokeRect(d.x + 0.5, d.y + 0.5, d.w, d.h);
        }
        break;
      case 'invert': {
        const img = ctx.getImageData(d.x, d.y, Math.max(1, d.w), Math.max(1, d.h));
        const [dark, light] = [INK_RGB[1], INK_RGB[0]];
        for (let k = 0; k < img.data.length; k += 4) {
          const c = img.data[k + 1] < 128 ? light : dark;
          img.data.set(c, k);
        }
        ctx.putImageData(img, d.x, d.y);
        break;
      }
    }
  }
}
