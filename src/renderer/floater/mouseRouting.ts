/**
 * Decides whether the floating bar window takes mouse input or passes it through to the app below.
 *
 * The window has a transparent area (400×260) at the bottom of the screen for stacking notifications.
 * Normally it passes input through to the app below, and takes it only while the pointer is over the bar or a notification.
 *
 * It used to switch on mouseenter and mouseleave of each element.
 * With that approach, when an element disappears under the pointer (a notification was closed, the bar changed), no mouseleave arrives
 * and the window stays in the taking state. Then nothing at the bottom of the screen can be clicked or scrolled.
 *
 * Here, instead of counting enters and leaves, it checks each time whether there is an interactive element at the pointer position:
 * - when the pointer moves
 * - when the content of the window changes (recheck)
 * - at a fixed interval (so that it recovers even if an element disappears while the pointer stays still)
 * While taking input, it keeps sending the same value. main goes back to passing input through if these messages stop (a safeguard).
 */

export interface MouseRouterDeps {
  /** Whether there is an interactive element (the bar or a notification) at the position */
  isInteractiveAt: (x: number, y: number) => boolean;
  /** Tells main: true to take input, false to pass it through to the app below */
  send: (interactive: boolean) => void;
  now?: () => number;
  /** Interval for resending the taking state */
  resendMs?: number;
}

export interface MouseRouter {
  /** The pointer moved inside the window */
  move(x: number, y: number): void;
  /** The pointer left the window */
  leave(): void;
  /** Checks again at the current position (when the content changes, and periodically) */
  recheck(): void;
}

export function createMouseRouter(deps: MouseRouterDeps): MouseRouter {
  const now = deps.now ?? (() => performance.now());
  const resendMs = deps.resendMs ?? 400;
  let x = 0;
  let y = 0;
  let inside = false;
  let interactive = false;
  let lastSent = Number.NEGATIVE_INFINITY;

  const evaluate = () => {
    const want = inside && deps.isInteractiveAt(x, y);
    const t = now();
    if (want === interactive && !(want && t - lastSent >= resendMs)) return;
    interactive = want;
    lastSent = t;
    deps.send(want);
  };

  return {
    move(nx, ny) {
      x = nx;
      y = ny;
      inside = true;
      evaluate();
    },
    leave() {
      inside = false;
      evaluate();
    },
    recheck: evaluate,
  };
}
