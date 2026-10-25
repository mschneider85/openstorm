const DISMISSED_KEY = 'openstorm.installHintDismissed';

/** iPadOS Safari presents itself as a Mac; the touch screen gives it away. */
const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

const isStandalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  matchMedia('(display-mode: standalone)').matches;

const SHARE_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Teilen"><path d="M12 15V3"/><path d="m8 7 4-4 4 4"/><path d="M8 11H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2"/></svg>';
const ADD_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';

/**
 * Safari cannot add a page to the home screen by itself, so on iOS we explain how
 * at every start, until the app runs from the home screen or the hint is dismissed.
 */
export function showInstallHint(): void {
  try {
    if (!isIos() || isStandalone() || localStorage.getItem(DISMISSED_KEY)) return;
  } catch {
    return;
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'install-hint';
  dialog.innerHTML = `
    <img src="/apple-touch-icon-180x180.png" alt="" width="72" height="72">
    <h2>OpenStorm als App</h2>
    <p>Vom Home-Bildschirm startet OpenStorm im Vollbild, ohne Safari-Leisten – wie eine richtige App.</p>
    <ol>
      <li><span class="step-icon">${SHARE_ICON}</span><span>In Safari auf <b>Teilen</b> tippen<small>(steckt es im Menü •••, erst dort tippen)</small></span></li>
      <li><span class="step-icon">${ADD_ICON}</span><span><b>Zum Home-Bildschirm</b> wählen</span></li>
      <li><span class="step-icon"><b>✓</b></span><span>Oben rechts auf <b>Hinzufügen</b> tippen</span></li>
    </ol>
    <div class="install-actions">
      <button class="btn primary" value="later">Verstanden</button>
      <button class="btn ghost" value="never">Nicht mehr zeigen</button>
    </div>`;
  for (const button of dialog.querySelectorAll<HTMLButtonElement>('button')) {
    button.addEventListener('click', () => {
      if (button.value === 'never') {
        try {
          localStorage.setItem(DISMISSED_KEY, '1');
        } catch {
          // only hidden for this visit then
        }
      }
      dialog.close();
      dialog.remove();
    });
  }
  document.body.append(dialog);
  dialog.showModal();
}
