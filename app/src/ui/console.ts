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

/** Shows the output lines or the chart of recorded values; the chart gets more room. */
export function showView(view: 'output' | 'datalog'): void {
  const panel = document.getElementById('console')!;
  panel.classList.remove('collapsed');
  panel.classList.toggle('wide', view === 'datalog');
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  list().hidden = view !== 'output';
  document.getElementById('datalog')!.hidden = view !== 'datalog';
  document.getElementById('datalog-csv')!.hidden = view !== 'datalog';
}
