import {
  currentProject, deleteOnEv3, deleteProject, ev3Folder, exportProject, importProject, listOnEv3, listProjects, loadFromEv3,
  newProject, openProject, renameOnEv3, renameProject, showBlock, startOnEv3, transferToEv3, type Ev3Program,
} from './editor';
import { log } from './console';
import { openConnectDialog } from './connect';
import { state } from '../state';

/**
 * The project window with two places: "Auf diesem Gerät" (switch, transfer, rename,
 * delete) and "Auf dem EV3" (fetch, start, rename, delete).
 */

let dialog: HTMLDialogElement;
let localList: HTMLElement;
let ev3List: HTMLElement;
let ev3Note: HTMLElement;
let statusLine: HTMLElement;
let place: 'local' | 'ev3' = 'local';
/** Programs on the brick, once read (null: not read yet). */
let onEv3: Ev3Program[] | null = null;
let busy = false;

const hasBrick = () => !!state.brick?.files;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function button(text: string, className: string, action: () => void | Promise<void>): HTMLButtonElement {
  const b = el('button', className, text);
  b.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      await action();
    } finally {
      busy = false;
    }
  });
  return b;
}

function status(text: string, kind: 'info' | 'error' = 'info'): void {
  statusLine.textContent = text;
  statusLine.classList.toggle('error', kind === 'error');
}

/** A row with the name on the left, buttons on the right and a "⋯" line with the rarer actions. */
function row(title: string, meta: string, current: boolean, open: (() => void) | null, actions: HTMLElement[], more: HTMLElement[]): HTMLElement[] {
  const line = el('div', `project-row${current ? ' current' : ''}`);
  const label = el(open ? 'button' : 'div', 'project-open');
  label.append(el('span', 'project-name', title), el('span', 'project-meta', meta));
  if (open) label.addEventListener('click', open);
  const extra = el('div', 'row-more');
  extra.hidden = true;
  extra.append(...more);
  const toggle = el('button', 'btn ghost small more', '⋯');
  toggle.setAttribute('aria-label', `Weitere Aktionen für ${title}`);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    extra.hidden = !extra.hidden;
    toggle.setAttribute('aria-expanded', String(!extra.hidden));
  });
  line.append(label, ...actions, toggle);
  return [line, extra];
}

// --- Auf diesem iPad ------------------------------------------------------------------------

function renderLocal(): void {
  const current = currentProject()?.id;
  const folders = new Set(onEv3?.map((p) => p.folder));
  localList.replaceChildren();
  for (const p of listProjects()) {
    const onBrick = folders.has(ev3Folder(p.name));
    const meta = [
      p.id === current ? 'geöffnet' : '',
      `geändert ${new Date(p.updated).toLocaleDateString('de-DE')}`,
      onBrick ? 'auch auf dem EV3' : '',
    ].filter(Boolean).join(' · ');

    const toEv3 = button('⇩ Auf den EV3', 'btn small primary', () => transfer(p.id, p.name));
    toEv3.disabled = !hasBrick() || state.running;
    toEv3.title = !hasBrick() ? 'Erst einen EV3 verbinden' : 'Programm und Blöcke auf den EV3 übertragen';

    const rename = button('Umbenennen', 'btn small', () => {
      const name = prompt('Neuer Name:', p.name)?.trim();
      if (!name || name === p.name) return;
      renameProject(p.id, name);
      status(onBrick ? `Umbenannt. Auf dem EV3 heißt es weiter „${ev3Folder(p.name)}“.` : 'Umbenannt.');
      renderLocal();
    });
    const save = button('Als Datei sichern', 'btn ghost small', () => share(p.id));
    const remove = button('Löschen', 'btn ghost small danger', () => {
      const note = onBrick ? '\n\nNur auf diesem Gerät, die Fassung auf dem EV3 bleibt.' : '';
      if (!confirm(`„${p.name}“ löschen?${note}`)) return;
      deleteProject(p.id);
      status(`„${p.name}“ gelöscht.`);
      renderLocal();
    });

    localList.append(
      ...row(p.name, meta, p.id === current, () => {
        openProject(p.id);
        dialog.close();
      }, [toEv3, rename], [save, remove]),
    );
  }
}

async function transfer(id: string, name: string): Promise<void> {
  status(`Übertrage „${name}“ …`);
  const result = await transferToEv3(id);
  if ('error' in result) {
    status(result.error, 'error');
    if (result.blockId) {
      dialog.close();
      showBlock(id, result.blockId);
      log(result.error, 'error');
    }
    return;
  }
  status(`„${name}“ ist auf dem EV3: Datei-Navigation → ${result.folder}.`);
  await refreshEv3(false);
  if (confirm(`„${name}“ ist jetzt auf dem EV3. Gleich dort starten?`)) {
    dialog.close();
    await startOnEv3(result.path);
  }
}

async function share(id: string): Promise<void> {
  const { name, json } = exportProject(id);
  const file = new File([json], `${name.replace(/[^\wäöüÄÖÜß -]/g, '_')}.openstorm.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
    } catch {
      // Cancelled by the user.
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- Auf dem EV3 ------------------------------------------------------------------------------

async function refreshEv3(show = true): Promise<void> {
  if (!hasBrick()) {
    onEv3 = null;
    renderEv3();
    return;
  }
  if (show) {
    ev3List.replaceChildren(el('p', 'muted', 'Lese den EV3 …'));
  }
  try {
    onEv3 = await listOnEv3();
  } catch (e) {
    onEv3 = null;
    status(`EV3 lesen fehlgeschlagen: ${(e as Error).message}`, 'error');
  }
  renderEv3();
  renderLocal();
}

function renderEv3(): void {
  ev3List.replaceChildren();
  ev3Note.replaceChildren();
  if (!hasBrick()) {
    ev3Note.append(
      el('span', 'muted', state.brick ? 'Der Simulator hat keine gespeicherten Programme. ' : 'Kein EV3 verbunden. '),
      button('Verbinden …', 'btn small', () => {
        dialog.close();
        openConnectDialog();
      }),
    );
    return;
  }
  ev3Note.append(
    el('span', 'muted', 'Programme in der Datei-Navigation des EV3.'),
    button('↻ Neu lesen', 'btn ghost small', () => refreshEv3()),
  );
  if (!onEv3) return;
  if (onEv3.length === 0) {
    ev3List.append(el('p', 'muted', 'Auf dem EV3 sind noch keine Programme.'));
    return;
  }
  const local = new Set(listProjects().map((p) => ev3Folder(p.name)));
  for (const prog of onEv3) {
    const title = prog.folder.replace(/_/g, ' ');
    const meta = prog.hasBlocks
      ? local.has(prog.folder) ? 'mit Blöcken · auch auf diesem Gerät' : 'mit Blöcken'
      : 'nur das Programm, ohne Blöcke (z. B. aus der LEGO-Software)';
    const actions: HTMLElement[] = [];
    if (prog.hasBlocks) {
      actions.push(
        button('⇧ Aufs Gerät', 'btn small primary', async () => {
          try {
            const name = await loadFromEv3(prog.folder);
            status(`„${name}“ ist jetzt auf diesem Gerät geöffnet.`);
            dialog.close();
          } catch (e) {
            status(`Holen fehlgeschlagen: ${(e as Error).message}`, 'error');
          }
        }),
      );
    }
    const start = button('▶ Starten', 'btn small', async () => {
      dialog.close();
      await startOnEv3(`../prjs/${prog.folder}/${prog.program}`);
    });
    start.disabled = state.running;
    actions.push(start);

    const rename = button('Umbenennen', 'btn small', async () => {
      const name = prompt('Neuer Name auf dem EV3:', title)?.trim();
      if (!name || ev3Folder(name) === prog.folder) return;
      status('Benenne um …');
      try {
        const folder = await renameOnEv3(prog.folder, name);
        status(`Auf dem EV3 heißt es jetzt „${folder}“.`);
      } catch (e) {
        status(`Umbenennen fehlgeschlagen: ${(e as Error).message}`, 'error');
      }
      await refreshEv3(false);
    });
    const remove = button('Löschen', 'btn ghost small danger', async () => {
      const note = local.has(prog.folder) ? '\n\nNur auf dem EV3, das Projekt auf diesem Gerät bleibt.' : '';
      if (!confirm(`„${title}“ vom EV3 löschen?${note}`)) return;
      status('Lösche …');
      try {
        await deleteOnEv3(prog.folder);
        status(`„${title}“ ist vom EV3 gelöscht.`);
      } catch (e) {
        status(`Löschen fehlgeschlagen: ${(e as Error).message}`, 'error');
      }
      await refreshEv3(false);
    });
    rename.disabled = remove.disabled = state.running;
    actions.push(rename);
    ev3List.append(...row(title, meta, false, null, actions, [remove]));
  }
}

// --- Window -------------------------------------------------------------------------------------

function showPlace(p: 'local' | 'ev3'): void {
  place = p;
  dialog.querySelectorAll<HTMLElement>('[data-place]').forEach((e) => {
    if (e.tagName === 'BUTTON') e.classList.toggle('active', e.dataset.place === p);
    else e.hidden = e.dataset.place !== p;
  });
  if (p === 'ev3' && onEv3 === null) void refreshEv3();
}

export function initProjects(d: HTMLDialogElement): void {
  dialog = d;
  localList = d.querySelector('.local-list')!;
  ev3List = d.querySelector('.ev3-list')!;
  ev3Note = d.querySelector('.ev3-note')!;
  statusLine = d.querySelector('.dialog-status')!;
  d.querySelector('.dialog-close')!.addEventListener('click', () => d.close());
  d.querySelectorAll<HTMLButtonElement>('button[data-place]').forEach((b) =>
    b.addEventListener('click', () => showPlace(b.dataset.place as 'local' | 'ev3')),
  );
  d.querySelector('#project-new')!.addEventListener('click', () => {
    const name = prompt('Name des neuen Projekts:', 'Neues Projekt')?.trim();
    if (!name) return;
    newProject(name);
    dialog.close();
  });
  const input = d.querySelector<HTMLInputElement>('#project-import-file')!;
  d.querySelector('#project-import')!.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      importProject(await file.text());
      log(`Projekt „${file.name}“ importiert`);
      dialog.close();
    } catch (e) {
      status(`Import fehlgeschlagen: ${(e as Error).message}`, 'error');
    }
  });
}

export function openProjectsDialog(): void {
  onEv3 = null;
  status('');
  renderLocal();
  renderEv3();
  showPlace(place);
  dialog.showModal();
  // Read the brick in the background, so the list can show what is already on it.
  if (hasBrick()) void refreshEv3(place === 'ev3');
}
