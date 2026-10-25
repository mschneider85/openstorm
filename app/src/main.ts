import './styles.css';
import { state } from './state';
import { clearLog, log, showView } from './ui/console';
import { clearValues, downloadCsv, initDatalog } from './ui/datalog';
import { autoConnect, initConnect, openConnectDialog } from './ui/connect';
import { initDevices, setDevicesVisible } from './ui/devices';
import { currentProject, initEditor, resizeEditor, startProgram, stopProgram } from './ui/editor';
import { showInstallHint } from './ui/install-hint';
import { initProjects, openProjectsDialog } from './ui/projects';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// Errors show up in the output, as there are no developer tools on the iPad.
const where = (e: ErrorEvent) => (e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno}:${e.colno})` : '');
window.addEventListener('error', (e) => log(`Fehler: ${e.message}${where(e)}`, 'error'));
window.addEventListener('unhandledrejection', (e) => log(`Fehler: ${(e.reason as Error)?.message ?? e.reason}`, 'error'));

const projectBtn = $('#project-btn');
const updateProjectName = () => {
  projectBtn.replaceChildren();
  const name = document.createElement('span');
  name.className = 'project-name-label';
  name.textContent = currentProject()?.name ?? 'Projekt';
  projectBtn.append(name, ' ▾');
};

initEditor($('#blockly'), updateProjectName);
initDatalog($('#datalog'));
initDevices($('#tab-devices'));
initConnect($<HTMLDialogElement>('#connect-dialog'));
initProjects($<HTMLDialogElement>('#projects-dialog'));
updateProjectName();

// Tabs
for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab!;
    document.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === `tab-${name}`));
    setDevicesVisible(name === 'devices');
    if (name === 'program') resizeEditor();
  });
}

projectBtn.addEventListener('click', openProjectsDialog);
$('#connect-btn').addEventListener('click', openConnectDialog);
$('#run-btn').addEventListener('click', () => void startProgram());
$('#stop-btn').addEventListener('click', () => void stopProgram());
$('#console-clear').addEventListener('click', () => ($('#datalog').hidden ? clearLog() : clearValues()));
$('#datalog-csv').addEventListener('click', () => void downloadCsv());
for (const view of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
  view.addEventListener('click', () => {
    showView(view.dataset.view as 'output' | 'datalog');
    setTimeout(resizeEditor, 220);
  });
}
$('#console-toggle').addEventListener('click', () => {
  $('#console').classList.toggle('collapsed');
  setTimeout(resizeEditor, 220);
});

const LABELS = { none: 'Nicht verbunden', sim: 'Simulator', serial: '', bridge: '' };
state.subscribe(() => {
  const btn = $('#connect-btn');
  btn.dataset.kind = state.kind;
  btn.querySelector('.conn-label')!.textContent = LABELS[state.kind] || state.brick!.name;
  $<HTMLButtonElement>('#run-btn').disabled = state.running;
  $<HTMLButtonElement>('#stop-btn').disabled = !state.running;
  if (!state.brick && state.running) void stopProgram();
});

window.addEventListener('resize', resizeEditor);
showInstallHint($('.topbar'), resizeEditor);
void autoConnect();

// Offline support.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}
