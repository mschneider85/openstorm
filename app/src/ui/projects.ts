import { currentProject, deleteProject, exportProject, importProject, listOnEv3, listProjects, loadFromEv3, newProject, openProject, renameProject } from './editor';
import { log } from './console';

let dialog: HTMLDialogElement;
let list: HTMLElement;

function render(): void {
  list.replaceChildren();
  const current = currentProject()?.id;
  for (const p of listProjects()) {
    const row = document.createElement('div');
    row.className = `project-row${p.id === current ? ' current' : ''}`;
    const name = document.createElement('button');
    name.className = 'project-name';
    name.textContent = p.name;
    name.addEventListener('click', () => {
      openProject(p.id);
      dialog.close();
    });
    const date = document.createElement('span');
    date.className = 'muted';
    date.textContent = new Date(p.updated).toLocaleDateString('de-DE');
    const rename = document.createElement('button');
    rename.className = 'btn ghost small';
    rename.textContent = 'Umbenennen';
    rename.addEventListener('click', () => {
      const name = prompt('Neuer Name:', p.name)?.trim();
      if (name) renameProject(p.id, name);
      render();
    });
    const remove = document.createElement('button');
    remove.className = 'btn ghost small danger';
    remove.textContent = 'Löschen';
    remove.addEventListener('click', () => {
      if (confirm(`„${p.name}“ wirklich löschen?`)) deleteProject(p.id);
      render();
    });
    row.append(name, date, rename, remove);
    list.append(row);
  }
}

async function share(): Promise<void> {
  const { name, json } = exportProject();
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

async function showEv3Projects(target: HTMLElement): Promise<void> {
  target.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Lese den EV3 …' }));
  try {
    const folders = await listOnEv3();
    target.replaceChildren();
    if (folders.length === 0) {
      target.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Noch keine OpenStorm-Programme auf dem EV3.' }));
    }
    for (const folder of folders) {
      const row = document.createElement('div');
      row.className = 'project-row';
      const name = document.createElement('span');
      name.className = 'project-name';
      name.textContent = folder.replace(/_/g, ' ');
      const open = document.createElement('button');
      open.className = 'btn small';
      open.textContent = 'Öffnen';
      open.addEventListener('click', async () => {
        try {
          await loadFromEv3(folder);
          dialog.close();
        } catch (e) {
          log(`Laden vom EV3 fehlgeschlagen: ${(e as Error).message}`, 'error');
        }
      });
      row.append(name, open);
      target.append(row);
    }
  } catch (e) {
    target.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: (e as Error).message }));
  }
}

export function initProjects(d: HTMLDialogElement): void {
  dialog = d;
  list = d.querySelector('.project-list')!;
  d.querySelector('.dialog-close')!.addEventListener('click', () => d.close());
  d.querySelector('#project-new')!.addEventListener('click', () => {
    const name = prompt('Name des neuen Projekts:', 'Neues Projekt')?.trim();
    if (!name) return;
    newProject(name);
    dialog.close();
  });
  d.querySelector('#project-export')!.addEventListener('click', () => void share());
  d.querySelector('#ev3-list')!.addEventListener('click', () => void showEv3Projects(d.querySelector('.ev3-list')!));
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
      log(`Import fehlgeschlagen: ${(e as Error).message}`, 'error');
    }
  });
}

export function openProjectsDialog(): void {
  render();
  dialog.querySelector('.ev3-list')!.replaceChildren();
  dialog.showModal();
}
