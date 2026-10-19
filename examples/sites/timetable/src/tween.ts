// Motion driven by script, frame by frame.
//
// In a panel, CSS transitions and animations that end jump to their end: the
// panel is drawn from copies of the page, and those copy the end values. A
// value the script sets on each frame is copied as it is, so the page moves
// with these instead. The agent runs requestAnimationFrame on a timer, which
// the panel's iframe gets even when the browser would hold back its frames.

const easeOut = (t: number) => 1 - (1 - t) ** 3;

const running = new WeakMap<object, number>();

/**
 * Calls `apply` with a value from `from` to `to` over `duration` ms, then
 * `done`. A new tween with the same `key` stops the one before it.
 */
export function tween(
  key: object,
  from: number,
  to: number,
  duration: number,
  apply: (value: number) => void,
  done?: () => void,
): void {
  const previous = running.get(key);
  if (previous !== undefined) cancelAnimationFrame(previous);
  const start = performance.now();
  const step = (time: number) => {
    const t = Math.min(1, (time - start) / duration);
    apply(from + (to - from) * easeOut(t));
    if (t < 1) running.set(key, requestAnimationFrame(step));
    else {
      running.delete(key);
      done?.();
    }
  };
  apply(from);
  running.set(key, requestAnimationFrame(step));
}
