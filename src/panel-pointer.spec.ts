// @vitest-environment jsdom
import { Mesh, PerspectiveCamera, PlaneGeometry, Vector2, type Ray } from "three";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HtmlPanel } from "./html-panel";
import { PanelPointer } from "./panel-pointer";

let canvas: HTMLCanvasElement;
let pointer: PanelPointer;
let panel: HtmlPanel & {
  focusForTyping: ReturnType<typeof vi.fn>;
  pointer: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  canvas.setPointerCapture = () => {};
  // A 1x1 panel filling the middle of the view of a camera 1 unit away.
  const mesh = new Mesh(new PlaneGeometry(1, 1));
  mesh.updateMatrixWorld();
  panel = Object.assign(mesh, {
    pointer: vi.fn(),
    blur: vi.fn(),
    focusForTyping: vi.fn(() => true),
    uvFromRay: () => new Vector2(0.5, 0.5),
    pageDistance: () => 0,
    // As HtmlPanel's, without its clamp.
    slopFor(this: HtmlPanel, uv: Vector2, rays: readonly Ray[]) {
      let slop: number | undefined;
      for (const ray of rays) {
        const moved = this.uvFromRay(ray);
        if (moved) slop = Math.max(slop ?? 0, this.pageDistance(uv, moved));
      }
      return slop;
    },
    cursor: "default",
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as never;
  const camera = new PerspectiveCamera(60, 800 / 600, 0.01, 10);
  camera.position.set(0, 0, 1);
  camera.updateMatrixWorld();
  pointer = new PanelPointer(camera, canvas, () => [panel]);
});

const at = (type: string, pointerType: string, clientX = 400, clientY = 300) =>
  new PointerEvent(type, {
    clientX,
    clientY,
    button: 0,
    pointerId: 1,
    pointerType,
    bubbles: true,
    cancelable: true,
  });

function touch(type: string, touches: object[], changedTouches: object[]): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "changedTouches", { value: changedTouches });
  canvas.dispatchEvent(event);
  return event;
}

/** A finger put down at the middle of the canvas and lifted at (x, y). Returns the touchend. */
function tap(x = 400, y = 300): Event {
  const down = { identifier: 1, clientX: 400, clientY: 300 };
  touch("touchstart", [down], [down]);
  return touch("touchend", [], [{ identifier: 1, clientX: x, clientY: y }]);
}

describe("PanelPointer", () => {
  it("tells the panel what drives the pointer", () => {
    canvas.dispatchEvent(at("pointerdown", "touch"));
    canvas.dispatchEvent(at("pointerup", "touch"));
    canvas.dispatchEvent(at("pointerdown", "mouse"));
    const inputs = panel.pointer.mock.calls
      .filter((call) => call[0] !== "leave")
      .map((call) => [call[0], call[3]]);
    expect(inputs).toEqual([
      ["down", "touch"],
      ["up", "touch"],
      ["down", "mouse"],
    ]);
  });

  it("takes the keyboard during a tap on a text field, and stops the mouse events after it", () => {
    expect(tap().defaultPrevented).toBe(true);
    expect(panel.focusForTyping).toHaveBeenCalledTimes(1);
    panel.focusForTyping.mockReturnValue(false);
    expect(tap().defaultPrevented).toBe(false);
  });

  it("does not take the keyboard when a finger that moved (a scroll) is lifted over a text field", () => {
    expect(tap(400, 340).defaultPrevented).toBe(false);
    expect(panel.focusForTyping).not.toHaveBeenCalled();
    // Within the slop, it is still a tap.
    tap(405, 305);
    expect(panel.focusForTyping).toHaveBeenCalledTimes(1);
  });

  it("does not take the keyboard for a touchend without its touchstart, or for another finger", () => {
    touch("touchend", [], [{ identifier: 1, clientX: 400, clientY: 300 }]);
    const down = { identifier: 1, clientX: 400, clientY: 300 };
    touch("touchstart", [down], [down]);
    touch("touchend", [], [{ identifier: 2, clientX: 400, clientY: 300 }]);
    expect(panel.focusForTyping).not.toHaveBeenCalled();
  });

  it("tells the page how far a finger may wobble, in its px; not for a mouse", () => {
    // 1/1000 of the panel per unit the ray turns across; the page 1000 px wide.
    panel.uvFromRay = (ray) => new Vector2(0.5 + ray.direction.x, 0.5 + ray.direction.y);
    panel.pageDistance = (a, b) => a.distanceTo(b) * 1000;
    canvas.dispatchEvent(at("pointerdown", "touch"));
    const slop = (
      panel.pointer.mock.calls.find((call) => call[0] === "down")![4] as { slop?: number }
    ).slop;
    expect(slop).toBeGreaterThan(0);
    canvas.dispatchEvent(at("pointerup", "touch"));
    panel.pointer.mockClear();
    canvas.dispatchEvent(at("pointerdown", "mouse"));
    expect(panel.pointer.mock.calls.find((call) => call[0] === "down")![4]).not.toHaveProperty(
      "slop",
      expect.anything(),
    );
  });

  it("sends every move of a finger, for the page to tell a tap from a drag", () => {
    const sent = () => panel.pointer.mock.calls.filter((call) => call[0] !== "leave");
    canvas.dispatchEvent(at("pointerdown", "touch"));
    canvas.dispatchEvent(at("pointermove", "touch", 402, 300));
    canvas.dispatchEvent(at("pointerup", "touch", 402, 300));
    expect(sent().map((call) => call[0])).toEqual(["down", "move", "up"]);
  });

  it("ends a press still held when it is disposed", () => {
    canvas.dispatchEvent(at("pointerdown", "mouse"));
    pointer.dispose();
    expect(panel.pointer).toHaveBeenLastCalledWith("up", new Vector2(-1, -1));
    panel.pointer.mockClear();
    pointer.dispose();
    expect(panel.pointer).not.toHaveBeenCalledWith("up", expect.anything());
  });
});
