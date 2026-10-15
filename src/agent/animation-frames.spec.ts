import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FrameWindow } from "../types";
import { emulateAnimationFrames } from "./animation-frames";

let view: FrameWindow;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  // Only the timers and performance are used: give it the fake ones.
  view = {
    setTimeout: globalThis.setTimeout,
    performance: globalThis.performance,
  } as unknown as FrameWindow;
  emulateAnimationFrames(view, 50);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("emulateAnimationFrames", () => {
  it("calls the callbacks requested so far together, with the same time", () => {
    const times: number[] = [];
    view.requestAnimationFrame((time) => times.push(time));
    view.requestAnimationFrame((time) => times.push(time));

    vi.advanceTimersByTime(0);
    expect(times).toHaveLength(2);
    expect(times[0]).toBe(times[1]);
  });

  it("runs callbacks requested during a frame in the next frame, an interval later", () => {
    const calls: string[] = [];
    const loop = () => {
      calls.push("frame");
      if (calls.length < 3) view.requestAnimationFrame(loop);
    };
    view.requestAnimationFrame(loop);

    vi.advanceTimersByTime(0);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(49);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(50);
    expect(calls).toHaveLength(3);
  });

  it("does not call a cancelled callback", () => {
    const callback = vi.fn();
    const id = view.requestAnimationFrame(callback);
    view.cancelAnimationFrame(id);

    vi.advanceTimersByTime(100);
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps calling the others when one throws, and reports the error", () => {
    const after = vi.fn();
    view.requestAnimationFrame(() => {
      throw new Error("page bug");
    });
    view.requestAnimationFrame(after);

    vi.advanceTimersByTime(0);
    expect(after).toHaveBeenCalledTimes(1);
    expect(() => vi.runOnlyPendingTimers()).toThrow("page bug");
  });
});
