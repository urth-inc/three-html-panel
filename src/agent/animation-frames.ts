// requestAnimationFrame driven by a timer.
//
// The panel's iframe gets no real input (it is pointer-events: none; input
// arrives as synthetic events), so to the browser it is a cross-origin frame
// the user never touches, and it may hold back its rendering: Chrome drops it
// to one update a second. Pages that update with requestAnimationFrame (charts,
// canvases, animation libraries) would stall with it. This replaces rAF before
// the page's scripts run. The agent does not capture more often than the
// pacer's shortest interval, so running frames more often would not show.

import type { FrameWindow } from "../types";
import { MIN_INTERVAL_MS } from "./capture/pacer";

/** Runs frames at the capture's shortest interval. */
export function emulateAnimationFrames(view: FrameWindow, intervalMs = MIN_INTERVAL_MS): void {
  // Keep what is used, in case the page replaces it later.
  const apply = Reflect.apply;
  const setTimer = view.setTimeout;
  const performance = view.performance;
  // Called with Reflect.apply on performance below.
  // oxlint-disable-next-line typescript/unbound-method -- see above
  const now = performance.now;
  const reportError = (error: unknown) =>
    apply(setTimer, view, [
      () => {
        throw error;
      },
      0,
    ]);

  let nextId = 0;
  let callbacks = new Map<number, FrameRequestCallback>();
  let timer: number | null = null;
  let lastFrameAt = Number.NEGATIVE_INFINITY;

  const runFrame = () => {
    timer = null;
    const time = apply(now, performance, []) as number;
    lastFrameAt = time;
    // Callbacks requested during this frame run in the next one, as in browsers.
    const due = callbacks;
    callbacks = new Map();
    for (const callback of due.values()) {
      try {
        callback(time);
      } catch (error) {
        // One that throws does not stop the others; the error reaches the page's onerror.
        reportError(error);
      }
    }
  };

  view.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    if (typeof callback !== "function")
      throw new TypeError("requestAnimationFrame expects a function");
    const id = ++nextId;
    callbacks.set(id, callback);
    if (timer === null) {
      const elapsed = (apply(now, performance, []) as number) - lastFrameAt;
      timer = apply(setTimer, view, [
        runFrame,
        Math.max(0, intervalMs - elapsed),
      ]) as unknown as number;
    }
    return id;
  };
  view.cancelAnimationFrame = (id: number): void => {
    callbacks.delete(id);
  };
}
