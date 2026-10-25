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
/** Disabled reason that earlier versions set on loose blocks (they were shown hatched). */
const ORPHANED = 'ORPHANED_BLOCK';
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
    enableOrphans();
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
export function exportProject(): { name: string; json: string } {
  save();
  const data = { app: 'openstorm', version: 1, name: currentProject()?.name ?? 'Programm', workspace: Blockly.serialization.workspaces.save(workspace) };
  return { name: data.name, json: JSON.stringify(data, null, 1) };
}

export function importProject(json: string): void {
  const data = JSON.parse(json) as { app?: string; name?: string; workspace?: object };
  if (data.app !== 'openstorm' || !data.workspace) throw new Error('Keine OpenStorm-Projektdatei');
  newProject(data.name ?? 'Importiert', data.workspace);
}

// --- Programs on the EV3 ------------------------------------------------------------

/** Next to every program the blocks are stored, hidden from the brick's file browser. */
const SOURCE_FILE = '.openstorm';

/** Folder and program name on the brick: ASCII letters, digits, "_" and "-". */
export function brickName(name: string): string {
  return ascii(name).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'Programm';
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

/**
 * Translates the program for the EV3 and stores it there together with its blocks.
 * Returns the program path, or null if that did not work (the reason is logged).
 */
export async function transferToEv3(): Promise<string | null> {
  const files = brickFiles();
  if (!files) return null;
  save();
  let image: Uint8Array;
  let sounds: string[];
  try {
    const result = compileRbf(workspace);
    image = result.image;
    sounds = result.sounds;
    for (const warning of result.warnings) log(warning);
  } catch (e) {
    const block = e instanceof RbfError && e.blockId ? workspace.getBlockById(e.blockId) : null;
    if (block) {
      block.select();
      workspace.centerOnBlock(block.id);
    }
    log(`Übertragen nicht möglich: ${(e as Error).message}`, 'error');
    return null;
  }
  const name = currentProject()?.name ?? 'Programm';
  const folder = brickName(name);
  const path = `../prjs/${folder}/${folder}.rbf`;
  log(`Übertrage „${name}“ auf den EV3 …`);
  try {
    await uploadSounds(files, sounds);
    await files.write(path, image);
    await files.write(`../prjs/${folder}/${SOURCE_FILE}`, new TextEncoder().encode(exportProject().json));
  } catch (e) {
    log(`Übertragen fehlgeschlagen: ${(e as Error).message}`, 'error');
    return null;
  }
  log(`Auf dem EV3 gespeichert: Datei-Navigation → ${folder} → ${folder}`);
  return path;
}

export async function startOnEv3(path: string): Promise<void> {
  try {
    await brickFiles()?.startProgram(path);
    log('Das Programm läuft jetzt auf dem EV3. Stoppen mit der Zurück-Taste am Stein.');
  } catch (e) {
    log(`Starten fehlgeschlagen: ${(e as Error).message}`, 'error');
  }
}

/** Folders on the brick that hold an OpenStorm program with its blocks. */
export async function listOnEv3(): Promise<string[]> {
  const files = brickFiles();
  if (!files) return [];
  const { folders } = await files.list('../prjs/');
  const result: string[] = [];
  for (const folder of folders) {
    if ((await files.list(`../prjs/${folder}/`)).files.includes(SOURCE_FILE)) result.push(folder);
  }
  return result;
}

/** Opens the blocks stored on the brick as a project (replacing one of the same name if wanted). */
export async function loadFromEv3(folder: string): Promise<void> {
  const files = brickFiles();
  if (!files) return;
  const json = new TextDecoder().decode(await files.read(`../prjs/${folder}/${SOURCE_FILE}`));
  const data = JSON.parse(json) as { app?: string; name?: string; workspace?: object };
  if (data.app !== 'openstorm' || !data.workspace) throw new Error('Keine OpenStorm-Daten');
  const name = data.name ?? folder;
  const existing = listProjects().find((p) => p.name === name);
  if (existing && confirm(`„${name}“ gibt es hier schon. Durch die Fassung vom EV3 ersetzen?`)) {
    save();
    storageSet(projectKey(existing.id), JSON.stringify(data.workspace));
    currentId = '';
    load(existing.id);
  } else {
    newProject(existing ? `${name} (vom EV3)` : name, data.workspace);
  }
  log(`„${name}“ vom EV3 geladen`);
}

export function initEditor(container: HTMLElement, onChange: () => void): void {
  Blockly.setLocale(De as unknown as Record<string, string>);
  defineBlocks();
  onProjectChange = onChange;

  workspace = Blockly.inject(container, {
    toolbox,
    theme,
    renderer: 'zelos',
    trashcan: false,
    zoom: { controls: true, wheel: true, pinch: true, startScale: 0.8, maxScale: 2, minScale: 0.4 },
    move: { scrollbars: true, drag: true, wheel: true },
    grid: { spacing: 24, length: 2, colour: '#232823', snap: true },
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

/** Loose blocks simply do not run; they keep their normal look. */
function enableOrphans(): void {
  for (const block of workspace.getAllBlocks(false)) {
    if (block.hasDisabledReason(ORPHANED)) block.setDisabledReason(false, ORPHANED);
  }
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
  const make = (label: string, title: string, redo: boolean) => {
    const b = document.createElement('button');
    b.className = 'undo-btn';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', () => workspace.undo(redo));
    bar.append(b);
    return b;
  };
  const undo = make('↶', 'Rückgängig', false);
  const redo = make('↷', 'Wiederholen', true);
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
    onPrint: (text) => log(text, 'output'),
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
