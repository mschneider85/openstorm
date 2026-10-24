import * as Blockly from 'blockly/core';
import 'blockly/blocks';
import * as De from 'blockly/msg/de';
import { defineBlocks } from '../blocks/definitions';
import { compile } from '../blocks/generator';
import { theme, toolbox } from '../blocks/toolbox';
import { ProgramRun } from '../runtime/runner';
import { state } from '../state';
import { log } from './console';

const PROJECTS_KEY = 'openstorm.projects';
const CURRENT_KEY = 'openstorm.current';
/** Disabled reason used by Blockly.Events.disableOrphans. */
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
    greyOutOrphans();
  } finally {
    Blockly.Events.enable();
  }
  scrollToStart();
  onProjectChange();
}

let onProjectChange: () => void = () => {};

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

export function initEditor(container: HTMLElement, onChange: () => void): void {
  Blockly.setLocale(De as unknown as Record<string, string>);
  defineBlocks();
  onProjectChange = onChange;

  workspace = Blockly.inject(container, {
    toolbox,
    theme,
    renderer: 'zelos',
    trashcan: true,
    zoom: { controls: true, wheel: true, pinch: true, startScale: 0.8, maxScale: 2, minScale: 0.4 },
    move: { scrollbars: true, drag: true, wheel: true },
    grid: { spacing: 24, length: 2, colour: '#dde2e7', snap: true },
  });

  const projects = listProjects();
  const last = storageGet(CURRENT_KEY);
  if (projects.some((p) => p.id === last)) load(last!);
  else if (projects.length) load(projects[0].id);
  else newProject('Mein Roboter');

  // Blocks not attached to a start block never run; greying them out shows that.
  workspace.addChangeListener(Blockly.Events.disableOrphans);

  let timer: ReturnType<typeof setTimeout> | undefined;
  workspace.addChangeListener((e) => {
    if (e.isUiEvent) return;
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  });
  window.addEventListener('pagehide', save);
}

/** Same as Blockly.Events.disableOrphans, which only reacts to changes, for a loaded program. */
function greyOutOrphans(): void {
  for (const block of workspace.getTopBlocks(false)) {
    if (block.previousConnection || block.outputConnection) block.setDisabledReason(true, ORPHANED);
  }
}

/** Shows the program from its top left corner, where the start block usually is. */
function scrollToStart(): void {
  const content = workspace.getMetricsManager().getContentMetrics();
  workspace.scroll(-content.left + 40, -content.top + 40);
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
    log('Kein „Programmstart“-Block gefunden. Hänge deine Blöcke an einen Startblock.', 'error');
    return;
  }
  const starts = workspace.getTopBlocks(false).filter((b) => b.type === 'ev3_start');
  if (starts.every((b) => !b.getNextBlock())) {
    log('Unter „Programmstart“ hängen noch keine Blöcke. Ziehe Blöcke aus der Liste links darunter.', 'error');
    return;
  }
  log(`Programm gestartet${threads > 1 ? ` (${threads} parallele Abläufe)` : ''}`);
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
