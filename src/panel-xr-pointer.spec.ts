import {
  EventDispatcher,
  Group,
  Mesh,
  PlaneGeometry,
  Vector2,
  type Ray,
  type WebGLRenderer,
} from "three";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { HtmlPanel } from "./html-panel";
import { PanelXRPointer } from "./panel-xr-pointer";

/** A 1x1 panel at the origin, facing +z, with its input methods recorded. */
function fakePanel() {
  const mesh = new Mesh(new PlaneGeometry(1, 1)) as unknown as HtmlPanel & Mesh;
  const calls: unknown[][] = [];
  Object.assign(mesh, {
    calls,
    pointer: vi.fn((...args: unknown[]) => calls.push(["pointer", ...args])),
    wheel: vi.fn((...args: unknown[]) => calls.push(["wheel", ...args])),
    blur: vi.fn(() => calls.push(["blur"])),
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
  });
  mesh.updateMatrixWorld();
  return mesh as HtmlPanel & { calls: unknown[][] };
}

let controllers: Group[];
let xr: EventDispatcher & { isPresenting: boolean; getController: (index: number) => Group };
let panel: ReturnType<typeof fakePanel>;
let pointer: PanelXRPointer;

/** Points controller `index` from 2 units in front: at the panel, or past it. */
function aim(index: number, atPanel: boolean): void {
  const controller = controllers[index]!;
  controller.position.set(atPanel ? 0 : 5, 0, 2);
  controller.updateMatrixWorld();
}

function connect(index: number, axes = [0, 0, 0, 0]): void {
  controllers[index]!.dispatchEvent({ type: "connected", data: { gamepad: { axes } } } as never);
}

beforeEach(() => {
  controllers = [new Group(), new Group()];
  xr = Object.assign(new EventDispatcher(), {
    isPresenting: true,
    getController: (index: number) => controllers[index]!,
  });
  panel = fakePanel();
  pointer = new PanelXRPointer({ xr } as unknown as WebGLRenderer, () => [panel]);
});

describe("PanelXRPointer", () => {
  it("hovers the panel a controller points at, as an XR pointer", () => {
    connect(0);
    aim(0, true);
    pointer.update(1000);
    expect(panel.calls).toContainEqual(["pointer", "move", new Vector2(0.5, 0.5), false, "xr"]);
    aim(0, false);
    pointer.update(1016);
    expect(panel.calls.at(-1)).toEqual(["pointer", "leave"]);
  });

  it("presses with the trigger and keeps the panel until it is released", () => {
    connect(0);
    aim(0, true);
    controllers[0]!.dispatchEvent({ type: "selectstart" } as never);
    aim(0, false);
    pointer.update(1000);
    controllers[0]!.dispatchEvent({ type: "selectend" } as never);
    expect(panel.calls.filter((call) => call[0] === "pointer").map((call) => call[1])).toEqual([
      "down",
      "move",
      "up",
    ]);
  });

  it("tells the page how far the ray may tremble, in its px", () => {
    panel.uvFromRay = (ray) => new Vector2(0.5 + ray.direction.x, 0.5 + ray.direction.y);
    panel.pageDistance = (a, b) => a.distanceTo(b) * 1000;
    connect(0);
    aim(0, true);
    controllers[0]!.dispatchEvent({ type: "selectstart" } as never);
    const down = panel.calls.find((call) => call[0] === "pointer" && call[1] === "down")!;
    expect((down[5] as { slop: number }).slop).toBeCloseTo(17, 0);
  });

  it("ends typing into the panels when the trigger presses something else", () => {
    connect(0);
    aim(0, false);
    controllers[0]!.dispatchEvent({ type: "selectstart" } as never);
    expect(panel.calls).toEqual([["blur"]]);
  });

  it("scrolls the hovered panel with the thumbstick, by time", () => {
    connect(0, [0, 0, 0, 1]);
    aim(0, true);
    pointer.update(1000);
    pointer.update(1100);
    const wheel = panel.calls.find((call) => call[0] === "wheel")!;
    expect(wheel[2]).toBe(0);
    expect(wheel[3]).toBeCloseTo(90);
  });

  it("does nothing outside a VR session", () => {
    xr.isPresenting = false;
    connect(0);
    aim(0, true);
    pointer.update(1000);
    expect(panel.calls).toEqual([]);
  });

  it("ends a press still held when it is disposed", () => {
    connect(0);
    aim(0, true);
    controllers[0]!.dispatchEvent({ type: "selectstart" } as never);
    pointer.dispose();
    expect(panel.calls.filter((call) => call[1] === "up")).toEqual([
      ["pointer", "up", new Vector2(-1, -1), false, "xr"],
    ]);
    // Not twice: nothing is held any more.
    pointer.dispose();
    expect(panel.calls.filter((call) => call[1] === "up")).toHaveLength(1);
  });

  describe("with a keyboard", () => {
    /** A keyboard plane in front of the panel, on the controllers' way to it. */
    function fakeKeyboard() {
      const keyboard = Object.assign(new Mesh(new PlaneGeometry(1, 1)), {
        showFor: vi.fn((target: unknown) => (keyboard.visible = target !== null)),
        hover: vi.fn(),
        press: vi.fn(),
      });
      keyboard.position.set(0, 0, 0.5);
      keyboard.visible = false;
      keyboard.updateMatrixWorld();
      return keyboard;
    }

    it("shows it for the panel that takes text, in a session only", () => {
      const keyboard = fakeKeyboard();
      pointer.keyboard = keyboard as never;
      pointer.update(1000);
      expect(keyboard.showFor).toHaveBeenLastCalledWith(null);
      Object.assign(panel, { isTyping: true });
      pointer.update(1016);
      expect(keyboard.showFor).toHaveBeenLastCalledWith(panel);
      xr.isPresenting = false;
      pointer.update(1032);
      expect(keyboard.showFor).toHaveBeenLastCalledWith(null);
    });

    it("presses its keys, leaving the panel focused and unpressed", () => {
      const keyboard = fakeKeyboard();
      pointer.keyboard = keyboard as never;
      Object.assign(panel, { isTyping: true });
      connect(0);
      aim(0, true);
      pointer.update(1000);
      expect(keyboard.hover).toHaveBeenLastCalledWith(expect.any(Vector2));
      controllers[0]!.dispatchEvent({ type: "selectstart" } as never);
      expect(keyboard.press).toHaveBeenCalledWith(expect.any(Vector2));
      expect(panel.calls.filter((call) => call[0] === "blur" || call[1] === "down")).toEqual([]);
    });
  });
});
