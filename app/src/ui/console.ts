const list = () => document.getElementById('console-lines')!;

export type LogKind = 'info' | 'output' | 'error';

/** Appends a line to the output panel below the editor. */
export function log(text: string, kind: LogKind = 'info'): void {
  const el = list();
  const line = document.createElement('div');
  line.className = `line ${kind}`;
  const time = new Date().toLocaleTimeString('de-DE');
  line.innerHTML = `<span class="time">${time}</span>`;
  line.append(text);
  el.append(line);
  while (el.childElementCount > 200) el.firstElementChild!.remove();
  el.scrollTop = el.scrollHeight;
}

export function clearLog(): void {
  list().replaceChildren();
}
