import { Capacitor } from '@capacitor/core';
import './styles.css';
import { state } from './state';
import { clearLog } from './ui/console';
import { autoConnect, initConnect, openConnectDialog } from './ui/connect';
import { initDevices, setDevicesVisible } from './ui/devices';
import { currentProject, initEditor, resizeEditor, startProgram, stopProgram } from './ui/editor';
import { initProjects, openProjectsDialog } from './ui/projects';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const projectBtn = $('#project-btn');
const FOLDER_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const updateProjectName = () => {
  projectBtn.innerHTML = FOLDER_ICON;
  projectBtn.append(currentProject()?.name ?? 'Projekt');
};

initEditor($('#blockly'), updateProjectName);
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
$('#console-clear').addEventListener('click', clearLog);
$('#console-toggle').addEventListener('click', () => {
  $('#console').classList.toggle('collapsed');
  setTimeout(resizeEditor, 220);
});

const LABELS = { none: 'Nicht verbunden', sim: 'Simulator', ios: '', serial: '', bridge: '' };
state.subscribe(() => {
  const btn = $('#connect-btn');
  btn.dataset.kind = state.kind;
  btn.querySelector('.conn-label')!.textContent = LABELS[state.kind] || state.brick!.name;
  $<HTMLButtonElement>('#run-btn').disabled = state.running;
  $<HTMLButtonElement>('#stop-btn').disabled = !state.running;
  if (!state.brick && state.running) void stopProgram();
});

window.addEventListener('resize', resizeEditor);
void autoConnect();

// Offline support for the browser version; the iOS app ships its files itself.
if (!Capacitor.isNativePlatform() && 'serviceWorker' in navigator && import.meta.env.PROD) {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}
