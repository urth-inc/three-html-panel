// Routes WebXR controllers to panels, like PanelPointer does the mouse.
//
// - A controller's ray hovers a panel; the trigger (select) presses it.
// - While pressed, moves go to that panel even off its edges, and a drag
//   scrolls it like a finger does (the page gets input "xr", see
//   agent/input/pan.ts). A press says how far the ray turning
//   TAP_SLOP_RADIANS goes in the page (its slop): on a panel far away or drawn
//   small, a hand's tremor is many px of the page.
// - The thumbstick scrolls the panel under the controller, like a wheel.
// - Pressing anything but a panel ends typing into the panels.
//
// - With a `keyboard` (PanelXRKeyboard), it shows under the panel whose text
//   field has focus, and the controllers press its keys: an immersive session
//   shows no system keyboard for the host's hidden field.
//
// Call update() once per frame, in the animation loop.

import { Ray, Raycaster, Vector2, Vector3, type WebGLRenderer, type XRTargetRaySpace } from "three";
import type { HtmlPanel } from "./html-panel";
import type { PanelXRKeyboard } from "./panel-xr-keyboard";

/** Thumbstick deflection below this is ignored (sticks rarely rest exactly at 0). */
const STICK_DEAD_ZONE = 0.15;
/** CSS pixels per second at full deflection. */
const STICK_SCROLL_SPEED = 900;
/** How far (about 1°) a controller's ray may turn during a press that is still a click. */
const TAP_SLOP_RADIANS = 0.017;

interface Controller {
  space: XRTargetRaySpace;
  source: XRInputSource | null;
}

export class PanelXRPointer {
  private readonly raycaster = new Raycaster();
  private readonly controllers: Controller[];
  private hovered: { panel: HtmlPanel; controller: Controller } | null = null;
  private pressed: { panel: HtmlPanel; controller: Controller } | null = null;
  private lastUpdate = 0;
  private readonly cleanups: (() => void)[] = [];
  /** The keyboard to type into panels with, shown while one takes text; none by default. */
  keyboard: PanelXRKeyboard | null = null;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly panels: () => readonly HtmlPanel[],
    controllerCount = 2,
  ) {
    this.controllers = Array.from({ length: controllerCount }, (_, index) => ({
      space: renderer.xr.getController(index),
      source: null,
    }));
    for (const controller of this.controllers) {
      const { space } = controller;
      const onConnected = (event: { data: XRInputSource }) => (controller.source = event.data);
      const onDisconnected = () => {
        controller.source = null;
        this.release(controller);
      };
      const onSelectStart = () => this.press(controller);
      const onSelectEnd = () => this.release(controller);
      space.addEventListener("connected", onConnected);
      space.addEventListener("disconnected", onDisconnected);
      space.addEventListener("selectstart", onSelectStart);
      space.addEventListener("selectend", onSelectEnd);
      this.cleanups.push(() => {
        space.removeEventListener("connected", onConnected);
        space.removeEventListener("disconnected", onDisconnected);
        space.removeEventListener("selectstart", onSelectStart);
        space.removeEventListener("selectend", onSelectEnd);
      });
    }
    const onSessionEnd = () => {
      this.pressed = null;
      this.hover(null);
    };
    renderer.xr.addEventListener("sessionend", onSessionEnd);
    this.cleanups.push(() => renderer.xr.removeEventListener("sessionend", onSessionEnd));
  }

  /** Sends hover and drag moves, and thumbstick scrolling, for this frame. */
  update(now = performance.now()): void {
    const seconds = this.lastUpdate ? Math.min(0.1, (now - this.lastUpdate) / 1000) : 0;
    this.lastUpdate = now;
    // The keyboard follows the panel that takes text, in a session only.
    const typing = this.renderer.xr.isPresenting
      ? (this.panels().find((panel) => panel.isTyping) ?? null)
      : null;
    this.keyboard?.showFor(typing);
    if (!this.renderer.xr.isPresenting) return;

    const pressed = this.pressed;
    if (pressed) {
      this.raycaster.setFromXRController(pressed.controller.space);
      const uv = pressed.panel.uvFromRay(this.raycaster.ray);
      if (uv) pressed.panel.pointer("move", uv, false, "xr");
      return;
    }
    // The first controller that points at the keyboard, or else at a panel, hovers it.
    let hit: { panel: HtmlPanel; uv: Vector2; controller: Controller } | null = null;
    let keyboardUv: Vector2 | null = null;
    for (const controller of this.controllers) {
      if (!controller.source) continue;
      keyboardUv = this.pickKeyboard(controller);
      if (keyboardUv) break;
      const found = this.pick(controller);
      if (found) {
        hit = { ...found, controller };
        break;
      }
    }
    this.keyboard?.hover(keyboardUv);
    this.hover(hit && { panel: hit.panel, controller: hit.controller });
    if (!hit) return;
    hit.panel.pointer("move", hit.uv, false, "xr");
    const axes = hit.controller.source?.gamepad?.axes;
    // xr-standard gamepads put the thumbstick on axes 2 (x) and 3 (y).
    const dx = deadZone(axes?.[2] ?? 0);
    const dy = deadZone(axes?.[3] ?? 0);
    if ((dx || dy) && seconds > 0) {
      hit.panel.wheel(hit.uv, dx * STICK_SCROLL_SPEED * seconds, dy * STICK_SCROLL_SPEED * seconds);
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    // A press still held ends here: the panel would otherwise take every later move for a drag.
    this.pressed?.panel.pointer("up", new Vector2(-1, -1), false, "xr");
    this.pressed = null;
    this.hover(null);
  }

  /** Where a controller points on the keyboard, if it is shown and pointed at. */
  private pickKeyboard(controller: Controller): Vector2 | null {
    const keyboard = this.keyboard;
    if (!keyboard?.visible) return null;
    this.raycaster.setFromXRController(controller.space);
    return this.raycaster.intersectObject(keyboard, false)[0]?.uv ?? null;
  }

  /** The panel a controller points at, where, and its ray (the raycaster's: until the next raycast). */
  private pick(controller: Controller): { panel: HtmlPanel; uv: Vector2; ray: Ray } | null {
    this.raycaster.setFromXRController(controller.space);
    const hit = this.raycaster.intersectObjects(this.panels() as HtmlPanel[], false)[0];
    if (!hit?.uv) return null;
    return { panel: hit.object as HtmlPanel, uv: hit.uv, ray: this.raycaster.ray };
  }

  private press(controller: Controller): void {
    if (this.pressed) return;
    // A key: typed into the panel, which keeps its focus.
    const keyUv = this.pickKeyboard(controller);
    if (keyUv) {
      this.keyboard!.press(keyUv);
      return;
    }
    const hit = this.pick(controller);
    // Pressing anything else ends typing into the panels.
    for (const panel of this.panels()) if (panel !== hit?.panel) panel.blur();
    if (!hit) return;
    this.pressed = { panel: hit.panel, controller };
    this.hover({ panel: hit.panel, controller });
    const slop = hit.panel.slopFor(hit.uv, slopRays(hit.ray));
    hit.panel.pointer("down", hit.uv, false, "xr", { slop });
  }

  private release(controller: Controller): void {
    const pressed = this.pressed;
    if (!pressed || pressed.controller !== controller) return;
    this.pressed = null;
    this.raycaster.setFromXRController(controller.space);
    // Off the panel's plane (pointing away): released outside the page.
    const uv = pressed.panel.uvFromRay(this.raycaster.ray) ?? new Vector2(-1, -1);
    pressed.panel.pointer("up", uv, false, "xr");
  }

  private hover(next: { panel: HtmlPanel; controller: Controller } | null): void {
    if (next?.panel === this.hovered?.panel) {
      this.hovered = next;
      return;
    }
    this.hovered?.panel.pointer("leave");
    this.hovered = next;
  }
}

/** `ray` turned TAP_SLOP_RADIANS two ways across itself (see HtmlPanel.slopFor). */
function slopRays(ray: Ray): Ray[] {
  const { origin, direction } = ray;
  const across = new Vector3(0, 1, 0).cross(direction);
  if (across.lengthSq() < 1e-6) across.set(1, 0, 0).cross(direction);
  across.normalize();
  const other = direction.clone().cross(across).normalize();
  return [across, other].map(
    (axis) => new Ray(origin.clone(), direction.clone().applyAxisAngle(axis, TAP_SLOP_RADIANS)),
  );
}

const deadZone = (value: number) => (Math.abs(value) < STICK_DEAD_ZONE ? 0 : value);
