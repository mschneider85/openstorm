import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import * as De from 'blockly/msg/de';
import { defineBlocks } from '../blocks/definitions';
import { HAT_TYPES, compile } from '../blocks/generator';
import { RbfError, compileRbf } from '../blocks/rbf';
import { ascii } from '../ev3/assembler';
import type { BrickFiles } from '../ev3/files';
import { installToolbox, theme, toolbox } from '../blocks/toolbox';
import { uploadSounds } from '../ev3/sounds';
import { ProgramRun } from '../runtime/runner';
import { state } from '../state';
import { log, showView } from './console';
import { MAX_SERIES, addValue, clearValues } from './datalog';

const PROJECTS_KEY = 'openstorm.projects';
const CURRENT_KEY = 'openstorm.current';
const projectKey = (id: string) => `openstorm.project.${id}`;

interface ProjectMeta {
  id: string;
  name: string;
  updated: number;
}

let workspace: Blockly.WorkspaceSvg;
let currentId = '';
let run: ProgramRun | null = null;
/** Highlighted block per stack, so parallel threads each keep their own highlight. */
const highlighted = new Map<string, string>();

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    log('Speichern nicht möglich (Speicher voll oder gesperrt)', 'error');
  }
}

export function listProjects(): ProjectMeta[] {
  try {
    return (JSON.parse(storageGet(PROJECTS_KEY) ?? '[]') as ProjectMeta[]).sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

function saveProjectList(list: ProjectMeta[]): void {
  storageSet(PROJECTS_KEY, JSON.stringify(list));
}

export function currentProject(): ProjectMeta | undefined {
  return listProjects().find((p) => p.id === currentId);
}

const EMPTY_PROGRAM = {
  blocks: { languageVersion: 0, blocks: [{ type: 'ev3_start', x: 40, y: 40 }] },
};

function save(): void {
  if (!currentId) return;
  storageSet(projectKey(currentId), JSON.stringify(Blockly.serialization.workspaces.save(workspace)));
  const list = listProjects();
  const meta = list.find((p) => p.id === currentId);
  if (meta) meta.updated = Date.now();
  saveProjectList(list);
}

function load(id: string): void {
  let data: object = EMPTY_PROGRAM;
  try {
    data = JSON.parse(storageGet(projectKey(id)) ?? 'null') ?? EMPTY_PROGRAM;
  } catch {
    log('Projekt konnte nicht gelesen werden', 'error');
  }
  currentId = id;
  storageSet(CURRENT_KEY, id);
  Blockly.Events.disable();
  try {
    workspace.clear();
    Blockly.serialization.workspaces.load(data, workspace);
  } finally {
    Blockly.Events.enable();
  }
  scrollToStart();
  workspace.clearUndo();
  refreshUndo();
  onProjectChange();
}

let onProjectChange: () => void = () => {};
/** Updates the undo/redo buttons (clearUndo fires no event). */
let refreshUndo: () => void = () => {};

export function openProject(id: string): void {
  save();
  load(id);
}

export function newProject(name: string, data: object = EMPTY_PROGRAM): void {
  save();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  saveProjectList([...listProjects(), { id, name, updated: Date.now() }]);
  storageSet(projectKey(id), JSON.stringify(data));
  load(id);
}

export function renameProject(id: string, name: string): void {
  const list = listProjects();
  const meta = list.find((p) => p.id === id);
  if (meta) meta.name = name;
  saveProjectList(list);
  onProjectChange();
}

export function deleteProject(id: string): void {
  const list = listProjects().filter((p) => p.id !== id);
  saveProjectList(list);
  try {
    localStorage.removeItem(projectKey(id));
  } catch {
    // ignore
  }
  if (id === currentId) {
    currentId = '';
    if (list.length) load(list[0].id);
    else newProject('Mein Roboter');
  }
}

/** Serialized program for exporting it as a file. */
/** The stored blocks of a project. */
function projectData(id: string): object {
  if (id === currentId) {
    save();
    return Blockly.serialization.workspaces.save(workspace);
  }
  try {
    return JSON.parse(storageGet(projectKey(id)) ?? 'null') ?? EMPTY_PROGRAM;
  } catch {
    return EMPTY_PROGRAM;
  }
}

/** A project as a file for exporting it. */
export function exportProject(id: string): { name: string; json: string } {
  const name = listProjects().find((p) => p.id === id)?.name ?? 'Programm';
  const data = { app: 'openstorm', version: 1, name, workspace: projectData(id) };
  return { name, json: JSON.stringify(data, null, 1) };
}

export function importProject(json: string): void {
  const data = JSON.parse(json) as { app?: string; name?: string; workspace?: object };
  if (data.app !== 'openstorm' || !data.workspace) throw new Error('Keine OpenStorm-Projektdatei');
  newProject(data.name ?? 'Importiert', data.workspace);
}

// --- Programs on the EV3 ------------------------------------------------------------

/** Next to every program the blocks are stored, hidden from the brick's file browser. */
const SOURCE_FILE = '.openstorm';

/**
 * Folder and program name on the brick: ASCII letters, digits, "_" and "-". At most
 * 20 characters, so "../prjs/<name>/<name>.rbf" stays within the 60 characters
 * the firmware accepts for deleting a file.
 */
export function brickName(name: string): string {
  return ascii(name).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20).replace(/_+$/, '') || 'Programm';
}

function brickFiles(): BrickFiles | null {
  if (!state.brick) {
    log('Bitte zuerst einen EV3 verbinden.', 'error');
    return null;
  }
  if (!state.brick.files) {
    log('Der Simulator kann keine Programme speichern. Verbinde dafür einen echten EV3.', 'error');
    return null;
  }
  return state.brick.files;
}

export type TransferResult = { path: string; folder: string } | { error: string; blockId?: string };

/**
 * Translates a project into an EV3 program and stores it on the brick. Its
 * blocks go along, so the program can be opened again from the brick.
 */
export async function transferToEv3(id: string): Promise<TransferResult> {
  const files = brickFiles();
  if (!files) return { error: 'Bitte zuerst einen EV3 verbinden (der Simulator kann keine Programme speichern).' };
  const ws = new Blockly.Workspace();
  let image: Uint8Array;
  let sounds: string[];
  try {
    Blockly.serialization.workspaces.load(projectData(id), ws);
    const result = compileRbf(ws);
    image = result.image;
    sounds = result.sounds;
    for (const warning of result.warnings) log(warning);
  } catch (e) {
    return { error: `Übertragen nicht möglich: ${(e as Error).message}`, blockId: e instanceof RbfError ? e.blockId : undefined };
  } finally {
    ws.dispose();
  }
  const { name, json } = exportProject(id);
  const folder = brickName(name);
  const path = `../prjs/${folder}/${folder}.rbf`;
  log(`Übertrage „${name}“ auf den EV3 …`);
  try {
    await uploadSounds(files, sounds);
    await files.write(path, image);
    await files.write(`../prjs/${folder}/${SOURCE_FILE}`, new TextEncoder().encode(json));
  } catch (e) {
    return { error: `Übertragen fehlgeschlagen: ${(e as Error).message}` };
  }
  log(`Auf dem EV3 gespeichert: Datei-Navigation → ${folder} → ${folder}`);
  return { path, folder };
}

/** Opens a project and shows the block that could not be translated. */
export function showBlock(id: string, blockId: string): void {
  if (id !== currentId) openProject(id);
  const block = workspace.getBlockById(blockId);
  if (!block) return;
  block.select();
  workspace.centerOnBlock(block.id);
}

export async function startOnEv3(path: string): Promise<void> {
  try {
    await brickFiles()?.startProgram(path);
    log('Das Programm läuft jetzt auf dem EV3. Stoppen mit der Zurück-Taste am Stein.');
  } catch (e) {
    log(`Starten fehlgeschlagen: ${(e as Error).message}`, 'error');
  }
}

/** A program on the brick: its folder under ../prjs, the .rbf file, and whether its blocks are there too. */
export interface Ev3Program {
  folder: string;
  program: string;
  hasBlocks: boolean;
}

/** Folders the brick or OpenStorm use for other things. */
const SYSTEM_FOLDERS = new Set(['OpenStorm', 'BrkProg_SAVE', 'BrkDL_SAVE', 'SD_Card']);

/** Programs on the brick, OpenStorm's with their blocks as well as others (e.g. from the LEGO software). */
export async function listOnEv3(): Promise<Ev3Program[]> {
  const files = brickFiles();
  if (!files) return [];
  const { folders } = await files.list('../prjs/');
  const result: Ev3Program[] = [];
  for (const folder of folders) {
    if (SYSTEM_FOLDERS.has(folder)) continue;
    const content = (await files.list(`../prjs/${folder}/`)).files;
    const program = content.find((f) => f.endsWith('.rbf'));
    if (program) result.push({ folder, program, hasBlocks: content.includes(SOURCE_FILE) });
  }
  return result.sort((a, b) => a.folder.localeCompare(b.folder));
}

/** The folder a project gets on the brick. */
export function ev3Folder(projectName: string): string {
  return brickName(projectName);
}

/** Deletes a program folder on the brick with everything in it. */
export async function deleteOnEv3(folder: string): Promise<void> {
  const files = brickFiles();
  if (!files) return;
  const dir = `../prjs/${folder}`;
  for (const f of (await files.list(`${dir}/`)).files) await files.delete(`${dir}/${f}`);
  await files.delete(dir);
}

/** Renames a program on the brick: copies its files into a new folder and deletes the old one. */
export async function renameOnEv3(folder: string, newName: string): Promise<string> {
  const files = brickFiles();
  if (!files) return folder;
  const target = brickName(newName);
  if (target === folder) return folder;
  if ((await files.list('../prjs/')).folders.includes(target)) throw new Error(`Auf dem EV3 gibt es „${target}“ schon.`);
  for (const f of (await files.list(`../prjs/${folder}/`)).files) {
    let data = await files.read(`../prjs/${folder}/${f}`);
    let name = f;
    if (f.endsWith('.rbf')) name = `${target}.rbf`;
    if (f === SOURCE_FILE) {
      const project = JSON.parse(new TextDecoder().decode(data)) as { name?: string };
      project.name = newName;
      data = new TextEncoder().encode(JSON.stringify(project));
    }
    await files.write(`../prjs/${target}/${name}`, data);
  }
  await deleteOnEv3(folder);
  return target;
}

/** Opens the blocks stored on the brick as a project (replacing one of the same name if wanted). */
export async function loadFromEv3(folder: string): Promise<string> {
  const files = brickFiles();
  if (!files) throw new Error('Kein EV3 verbunden');
  const json = new TextDecoder().decode(await files.read(`../prjs/${folder}/${SOURCE_FILE}`));
  const data = JSON.parse(json) as { app?: string; name?: string; workspace?: object };
  if (data.app !== 'openstorm' || !data.workspace) throw new Error('Keine OpenStorm-Daten');
  const name = data.name ?? folder;
  const existing = listProjects().find((p) => p.name === name);
  if (existing && confirm(`„${name}“ gibt es auf diesem Gerät schon. Durch die Fassung vom EV3 ersetzen?`)) {
    save();
    storageSet(projectKey(existing.id), JSON.stringify(data.workspace));
    currentId = '';
    load(existing.id);
  } else {
    newProject(existing ? `${name} (vom EV3)` : name, data.workspace);
  }
  log(`„${name}“ vom EV3 geholt`);
  return name;
}

export function initEditor(container: HTMLElement, onChange: () => void): void {
  Blockly.setLocale(De as unknown as Record<string, string>);
  defineBlocks();
  onProjectChange = onChange;

  // Blockly uses 25 px wide scrollbars on touch screens; the workspace is moved by dragging anyway.
  Blockly.Scrollbar.scrollbarThickness = 10;
  workspace = Blockly.inject(container, {
    toolbox,
    theme,
    renderer: 'zelos',
    // Edit numbers and texts right in the block (with the number keyboard), not in a dialog.
    modalInputs: false,
    trashcan: false,
    zoom: { controls: false, wheel: true, pinch: true, startScale: 0.8, maxScale: 2, minScale: 0.4 },
    move: { scrollbars: true, drag: true, wheel: true },
    grid: { spacing: 24, length: 2, colour: '#dfe3e8', snap: true },
  });

  const projects = listProjects();
  const last = storageGet(CURRENT_KEY);
  if (projects.some((p) => p.id === last)) load(last!);
  else if (projects.length) load(projects[0].id);
  else newProject('Mein Roboter');

  installToolbox(workspace);
  addUndoButtons(container);

  let timer: ReturnType<typeof setTimeout> | undefined;
  workspace.addChangeListener((e) => {
    if (e.isUiEvent) return;
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  });
  window.addEventListener('pagehide', save);
}

/** Shows the program from its top left corner, where the start block usually is. */
function scrollToStart(): void {
  const content = workspace.getMetricsManager().getContentMetrics();
  workspace.scroll(-content.left + 40, -content.top + 40);
}

/** Undo and redo instead of a trashcan; on an iPad there is no keyboard for it. */
function addUndoButtons(container: HTMLElement): void {
  const bar = document.createElement('div');
  bar.className = 'undo-bar';
  const make = (path: string, title: string, redo: boolean) => {
    const b = document.createElement('button');
    b.className = 'undo-btn';
    // Drawn arrows: the ↶ ↷ glyphs sit oddly in the iPad's fonts.
    b.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', () => workspace.undo(redo));
    bar.append(b);
    return b;
  };
  const undo = make('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', 'Rückgängig', false);
  const redo = make('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>', 'Wiederholen', true);
  const update = () => {
    undo.disabled = workspace.getUndoStack().length === 0;
    redo.disabled = workspace.getRedoStack().length === 0;
  };
  workspace.addChangeListener(update);
  refreshUndo = update;
  update();
  container.append(bar);
}

export function resizeEditor(): void {
  Blockly.svgResize(workspace);
}

function clearHighlights(): void {
  workspace.highlightBlock(null);
  highlighted.clear();
}

export async function startProgram(): Promise<void> {
  const brick = state.brick;
  if (!brick) {
    log('Bitte zuerst einen EV3 oder den Simulator verbinden.', 'error');
    return;
  }
  if (run) return;
  const { code, threads } = compile(workspace);
  if (threads === 0) {
    log('Kein Ereignisblock wie „Wenn Programm startet“ gefunden. Hänge deine Blöcke an einen solchen Block.', 'error');
    return;
  }
  const hats = workspace.getTopBlocks(false).filter((b) => HAT_TYPES.includes(b.type));
  if (hats.every((b) => !b.getNextBlock())) {
    log('Unter „Wenn Programm startet“ hängen noch keine Blöcke. Ziehe Blöcke aus der Liste links darunter.', 'error');
    return;
  }
  log(`Programm gestartet${threads > 1 ? ` (${threads} parallele Abläufe)` : ''}`);
  // A program that records values starts a fresh chart and shows it.
  if (workspace.getAllBlocks(false).some((b) => b.type === 'ev3_log' && b.isEnabled())) {
    clearValues();
    showView('datalog');
  }
  let tooManySeries = false;
  clearHighlights();
  state.setRunning(true);
  run = new ProgramRun(brick, code, {
    onStep: (id) => {
      const root = workspace.getBlockById(id)?.getRootBlock().id ?? id;
      const previous = highlighted.get(root);
      if (previous && previous !== id) workspace.highlightBlock(previous, false);
      workspace.highlightBlock(id, true);
      highlighted.set(root, id);
    },
    onLog: (name, t, value) => {
      if (!addValue(name, t, value) && !tooManySeries) {
        tooManySeries = true;
        log(`Höchstens ${MAX_SERIES} Messreihen: „${name}“ wird nicht aufgezeichnet.`, 'error');
      }
    },
    onLogClear: () => {
      clearValues();
      tooManySeries = false;
    },
  });
  const current = run;
  try {
    await current.done;
    log(current.stopped ? 'Programm gestoppt' : 'Programm beendet');
  } catch (e) {
    log(`Fehler: ${(e as Error).message}`, 'error');
  } finally {
    run = null;
    clearHighlights();
    state.setRunning(false);
  }
}

export async function stopProgram(): Promise<void> {
  await run?.stop();
}
