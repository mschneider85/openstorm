const DISMISSED_KEY = 'openstorm.installHintDismissed';

/** iPadOS Safari presents itself as a Mac; the touch screen gives it away. */
const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

const isStandalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  matchMedia('(display-mode: standalone)').matches;

const SHARE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Teilen"><path d="M12 15V3"/><path d="m8 7 4-4 4 4"/><path d="M8 11H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2"/></svg>';

/**
 * Safari cannot add a page to the home screen by itself, so on iOS we explain how,
 * until the app runs from the home screen or the hint is dismissed.
 */
export function showInstallHint(after: HTMLElement, onChange: () => void): void {
  try {
    if (!isIos() || isStandalone() || localStorage.getItem(DISMISSED_KEY)) return;
  } catch {
    return;
  }
  const bar = document.createElement('div');
  bar.className = 'install-hint';
  const text = document.createElement('p');
  text.innerHTML = `Als App ohne Safari-Leisten: tippe auf ${SHARE_ICON} <b>Teilen</b> und dann <b>Zum Home-Bildschirm</b>.`;
  const close = document.createElement('button');
  close.textContent = 'Nicht mehr zeigen';
  close.addEventListener('click', () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // only hidden for this visit then
    }
    bar.remove();
    onChange();
  });
  bar.append(text, close);
  after.after(bar);
  onChange();
}
