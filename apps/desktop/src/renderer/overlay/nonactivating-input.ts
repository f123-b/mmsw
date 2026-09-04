/** Windows may deliver only mouse-up to a WS_EX_NOACTIVATE Chromium window.
 * Recover that one missing press without activating the window, intercepting
 * keyboard clicks, or duplicating a normal down/up/click sequence. */
export function installNonActivatingInput(root: Document): () => void {
  let down = false;
  let enteredPressed = false;
  let neutralTarget: Element | null = null;
  let neutralAt = 0;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let pendingButton: HTMLButtonElement | null = null;
  let recoveredButton: HTMLButtonElement | null = null;
  let recoveredAt = 0;
  const clear = () => { if (pending) clearTimeout(pending); pending = undefined; pendingButton = null; };
  const enter = (event: PointerEvent) => { if (event.target === root.documentElement) enteredPressed = Boolean(event.buttons & 1) && Date.now() - neutralAt > 1200; };
  const press = () => { down = true; recoveredButton = null; clear(); };
  const leave = () => { down = false; enteredPressed = false; clear(); };
  const click = (event: MouseEvent) => {
    if (pendingButton?.contains(event.target as Node)) clear();
    // A late native click belongs to the same already-recovered release.
    // A new press/release clears this marker, so rapid deliberate clicks work.
    if (event.isTrusted && recoveredButton?.contains(event.target as Node) && Date.now() - recoveredAt < 800) {
      event.preventDefault(); event.stopImmediatePropagation(); recoveredButton = null;
    }
  };
  const release = (event: PointerEvent) => {
    const hadDown = down;
    down = false;
    recoveredButton = null;
    if (hadDown || enteredPressed || !event.isTrusted || event.button !== 0 || event.pointerType !== 'mouse') return;
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button');
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    pendingButton = button;
    // Chromium may synthesize its native click in a later task after mouse-up.
    // Give it one frame before falling back, otherwise a recovered click can
    // race the real one and toggle a control twice.
    pending = setTimeout(() => { clear(); if (button.isConnected && !button.disabled) { recoveredButton = button; recoveredAt = Date.now(); button.click(); } }, 40);
  };
  const move = (event: PointerEvent) => {
    if (!(event.buttons & 1)) { enteredPressed = false; neutralTarget = event.target as Element; neutralAt = Date.now(); return; }
    if (down || enteredPressed || !event.isTrusted) return;
    // A drag also needs its initial press; recover it only on dedicated handles.
    const handle = (event.target as Element | null)?.closest('.script-overlay-header, .script-resize-handle');
    if (!handle || (event.target as Element).closest('button,select') || !neutralTarget || !handle.contains(neutralTarget) || Date.now() - neutralAt > 1200) return;
    down = true;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: event.pointerId, pointerType: 'mouse', button: 0, buttons: 1, clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY }));
  };
  root.addEventListener('pointerenter', enter, true);
  root.addEventListener('pointerdown', press, true);
  root.addEventListener('pointerup', release, true);
  root.addEventListener('pointermove', move, true);
  root.addEventListener('click', click, true);
  root.defaultView?.addEventListener('blur', leave);
  return () => { clear(); root.removeEventListener('pointerenter', enter, true); root.removeEventListener('pointerdown', press, true); root.removeEventListener('pointerup', release, true); root.removeEventListener('pointermove', move, true); root.removeEventListener('click', click, true); root.defaultView?.removeEventListener('blur', leave); };
}
