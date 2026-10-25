/**
 * Recorded values ("zeichne … auf") and their line chart below the editor.
 * Each series keeps its colour slot for as long as it exists.
 */

interface Point {
  t: number;
  v: number;
}

/** Categorical colours in fixed order (validated for colour vision deficiencies). */
const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const MAX_SERIES = SERIES_COLORS.length;
const MAX_POINTS = 20000;

const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e6e9ed', axis: '#cdd3da', surface: '#ffffff' };

const series = new Map<string, Point[]>();
/** Range of all values, kept up to date while recording (the chart must not scan 160 000 points per frame). */
let range = { tMax: 0, vMin: Infinity, vMax: -Infinity };
let host: HTMLElement | null = null;
let canvas: HTMLCanvasElement;
let legend: HTMLElement;
let tooltip: HTMLElement;
let empty: HTMLElement;
let hoverX: number | null = null;
let frame = 0;

/** Adds a value; returns false if there are already too many series. */
export function addValue(name: string, t: number, v: number): boolean {
  if (!Number.isFinite(v)) return true;
  let points = series.get(name);
  if (!points) {
    if (series.size >= MAX_SERIES) return false;
    points = [];
    series.set(name, points);
  }
  points.push({ t, v });
  range = { tMax: Math.max(range.tMax, t), vMin: Math.min(range.vMin, v), vMax: Math.max(range.vMax, v) };
  // Drop the oldest tenth at once rather than shifting the whole array for every value.
  if (points.length > MAX_POINTS) {
    points.splice(0, MAX_POINTS / 10);
    recomputeRange();
  }
  schedule();
  return true;
}

export function clearValues(): void {
  series.clear();
  recomputeRange();
  schedule();
}

function recomputeRange(): void {
  range = { tMax: 0, vMin: Infinity, vMax: -Infinity };
  for (const points of series.values()) {
    for (const { t, v } of points) {
      if (t > range.tMax) range.tMax = t;
      if (v < range.vMin) range.vMin = v;
      if (v > range.vMax) range.vMax = v;
    }
  }
}

/** Semicolon-separated with decimal commas, as German spreadsheets expect. One row per point in time. */
export function valuesAsCsv(): string {
  const names = [...series.keys()];
  const rows = new Map<number, (number | undefined)[]>();
  names.forEach((name, k) => {
    for (const { t, v } of series.get(name)!) {
      const row = rows.get(t) ?? Array<number | undefined>(names.length);
      row[k] = v;
      rows.set(t, row);
    }
  });
  const fmt = (n: number | undefined) => (n === undefined ? '' : String(Math.round(n * 1000) / 1000).replace('.', ','));
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = [['Zeit (s)', ...names].map(quote).join(';')];
  for (const t of [...rows.keys()].sort((a, b) => a - b)) lines.push([fmt(t), ...rows.get(t)!.map(fmt)].join(';'));
  return lines.join('\r\n') + '\r\n';
}

/** Shares the table (iPad: "In Dateien sichern", Numbers …), or downloads it where sharing files is not possible. */
export async function downloadCsv(): Promise<void> {
  const name = `Messwerte ${new Date().toLocaleString('de-DE').replace(/[/:]/g, '-')}.csv`;
  const blob = new Blob(['\ufeff' + valuesAsCsv()], { type: 'text/csv;charset=utf-8' });
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch {
      // Cancelled by the user.
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Chart ------------------------------------------------------------------------------

export function initDatalog(container: HTMLElement): void {
  host = container;
  legend = el('div', 'datalog-legend');
  const plot = el('div', 'datalog-plot');
  canvas = document.createElement('canvas');
  tooltip = el('div', 'datalog-tooltip');
  empty = el('div', 'datalog-empty', 'Noch keine Messwerte. Hänge „zeichne … auf“ aus der Kategorie „Messwerte“ in dein Programm und starte es mit ▶ Start.');
  plot.append(canvas, tooltip, empty);
  container.append(legend, plot);

  const move = (e: PointerEvent) => {
    hoverX = e.clientX - canvas.getBoundingClientRect().left;
    schedule();
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerdown', move);
  // A finger leaves the screen after every touch: keep the readout until the next one.
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch') return;
    hoverX = null;
    schedule();
  });
  new ResizeObserver(schedule).observe(plot);
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text) e.textContent = text;
  return e;
}

function schedule(): void {
  if (!host || frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

/** 1, 2 or 5 × 10^n steps, about `count` of them across the range. */
function ticks(min: number, max: number, count: number): number[] {
  const span = max - min || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const format = (v: number) => (Math.abs(v) >= 1000 || Number.isInteger(v) ? String(Math.round(v)) : String(Math.round(v * 100) / 100)).replace('.', ',');

function nearest(points: Point[], t: number): Point {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo].t - t) <= Math.abs(points[hi].t - t) ? points[lo] : points[hi];
}

function render(): void {
  if (!host?.isConnected) return;
  const names = [...series.keys()];
  empty.hidden = names.length > 0;
  renderLegend(names);

  const rect = canvas.parentElement!.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  tooltip.hidden = true;
  if (names.length === 0 || rect.width < 80 || rect.height < 60) return;

  let { tMax, vMin, vMax } = range;
  if (tMax <= 0) tMax = 1;
  if (vMin === vMax) [vMin, vMax] = [vMin - 1, vMax + 1];
  const yTicks = ticks(vMin, vMax, Math.max(2, Math.floor(rect.height / 40)));
  vMin = Math.min(vMin, yTicks[0]);
  vMax = Math.max(vMax, yTicks[yTicks.length - 1]);
  const xTicks = ticks(0, tMax, Math.max(2, Math.floor(rect.width / 90)));
  tMax = Math.max(tMax, xTicks[xTicks.length - 1]);

  ctx.font = '12px system-ui, -apple-system, sans-serif';
  const left = 12 + yTicks.reduce((m, v) => Math.max(m, ctx.measureText(format(v)).width), 0);
  const pad = { left, right: 14, top: 10, bottom: 26 };
  const w = rect.width - pad.left - pad.right;
  const h = rect.height - pad.top - pad.bottom;
  const x = (t: number) => pad.left + (t / tMax) * w;
  const y = (v: number) => pad.top + (1 - (v - vMin) / (vMax - vMin)) * h;

  // Recessive grid and axes.
  ctx.lineWidth = 1;
  ctx.fillStyle = INK.muted;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const v of yTicks) {
    ctx.strokeStyle = INK.grid;
    ctx.beginPath();
    ctx.moveTo(pad.left, Math.round(y(v)) + 0.5);
    ctx.lineTo(pad.left + w, Math.round(y(v)) + 0.5);
    ctx.stroke();
    ctx.fillText(format(v), pad.left - 6, y(v));
  }
  ctx.strokeStyle = INK.axis;
  ctx.beginPath();
  ctx.moveTo(pad.left, pad.top + h + 0.5);
  ctx.lineTo(pad.left + w, pad.top + h + 0.5);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of xTicks) ctx.fillText(`${format(t)} s`, x(t), pad.top + h + 6);

  // Lines, 2px; single points as dots.
  names.forEach((name, k) => {
    const points = series.get(name)!;
    ctx.strokeStyle = ctx.fillStyle = SERIES_COLORS[k];
    ctx.lineWidth = 2;
    ctx.lineJoin = ctx.lineCap = 'round';
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(x(points[0].t), y(points[0].v), 4, 0, 2 * Math.PI);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
    ctx.stroke();
  });

  // Crosshair: snaps to the nearest recorded time and lists every series there.
  if (hoverX === null || hoverX < pad.left - 10 || hoverX > pad.left + w + 10) return;
  const tHover = Math.max(0, Math.min(tMax, ((hoverX - pad.left) / w) * tMax));
  // Each series is sorted by time: search each one and take the closest point overall.
  const snapped = names
    .map((n) => nearest(series.get(n)!, tHover).t)
    .reduce((best, t) => (Math.abs(t - tHover) < Math.abs(best - tHover) ? t : best));
  const cx = Math.round(x(snapped)) + 0.5;
  ctx.strokeStyle = INK.secondary;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, pad.top);
  ctx.lineTo(cx, pad.top + h);
  ctx.stroke();

  tooltip.replaceChildren();
  const head = el('div', 'datalog-tip-time', `${format(snapped)} s`);
  tooltip.append(head);
  names.forEach((name, k) => {
    const p = nearest(series.get(name)!, snapped);
    ctx.fillStyle = SERIES_COLORS[k];
    ctx.strokeStyle = INK.surface;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x(p.t), y(p.v), 4, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    const row = el('div', 'datalog-tip-row');
    const key = el('span', 'datalog-key');
    key.style.background = SERIES_COLORS[k];
    row.append(el('strong', '', format(p.v)), key, el('span', '', name));
    tooltip.append(row);
  });
  tooltip.hidden = false;
  const tipWidth = tooltip.offsetWidth;
  tooltip.style.left = `${cx + 12 + tipWidth > rect.width ? cx - 12 - tipWidth : cx + 12}px`;
  tooltip.style.top = `${pad.top}px`;
}

function renderLegend(names: string[]): void {
  legend.replaceChildren(
    ...names.map((name, k) => {
      const points = series.get(name)!;
      const item = el('span', 'datalog-legend-item');
      const key = el('span', 'datalog-key');
      key.style.background = SERIES_COLORS[k];
      item.append(key, el('span', '', name), el('span', 'datalog-latest', format(points[points.length - 1].v)));
      return item;
    }),
  );
}
