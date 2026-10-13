// Routes the mouse, touch and wheel input of the scene's canvas to panels.
//
// - Hovering a panel sends `move`; leaving it sends `leave`.
// - Pressing a panel captures the pointer until it is released: moves go to
//   that panel even outside its edges, so a drag inside the page keeps working.
// - Presses and wheel events on a panel are stopped before other listeners on
//   the canvas (camera controls), so dragging inside a page does not also
//   orbit the camera.
//
// Whether a press and release make a click is decided in the page (input.ts), from how
// far the pointer moved in the page. A finger's press says how far that is for
// TAP_SLOP_PX on the canvas (its slop): on a panel drawn small, a finger's
// slight wobble is many px of the page.
//
// While the pointer is over a panel (or dragging in one), the canvas shows the
// mouse cursor the page asks for there.
//
// Touch: a drag in a panel scrolls it (in the page, see agent/input/pan.ts). A
// tap on a text field takes the keyboard while the touchend is handled, which
// is when iOS opens its soft keyboard (HtmlPanel.focusForTyping).

import { Raycaster, Vector2, type Camera, type Ray } from "three";
import type { HtmlPanel } from "./html-panel";
import type { PointerInput } from "./types";

/** A pen acts like a finger: it drags to scroll. */
const inputOf = (event: PointerEvent): PointerInput =>
  event.pointerType === "mouse" ? "mouse" : "touch";
const modifiersOf = (event: PointerEvent) => ({ ctrlKey: event.ctrlKey, metaKey: event.metaKey });

const LINE_HEIGHT_PX = 16;
/** A touch that moves farther (CSS px of the canvas) is a drag (a scroll), not a tap. */
const TAP_SLOP_PX = 10;

export class PanelPointer {
  private readonly raycaster = new Raycaster();
  private hovered: HtmlPanel | null = null;
  /** Where the current single touch started, to tell a tap from a drag. */
  private touchStart: { id: number; x: number; y: number } | null = null;
  private pressed: { panel: HtmlPanel; pointerId: number } | null = null;
  /** The panel whose cursor the canvas shows, and the canvas's own cursor to restore. */
  private cursorPanel: HtmlPanel | null = null;
  private ownCursor = "";

  constructor(
    private readonly camera: Camera,
    private readonly element: HTMLElement,
    private readonly panels: () => readonly HtmlPanel[],
  ) {
    // Capture phase: runs before camera controls listening on the same element.
    element.addEventListener("pointerdown", this.onPointerDown, true);
    element.addEventListener("pointermove", this.onPointerMove, true);
    element.addEventListener("pointerup", this.onPointerUp, true);
    element.addEventListener("pointercancel", this.onPointerUp, true);
    element.addEventListener("pointerleave", this.onPointerLeave);
    element.addEventListener("wheel", this.onWheel, { capture: true, passive: false });
    // Keep keyboard focus where it is (the panel keyboard) when pressing a panel.
    element.addEventListener("mousedown", this.onMouseDown, true);
    element.addEventListener("touchstart", this.onTouchStart, { capture: true, passive: true });
    element.addEventListener("touchend", this.onTouchEnd, { capture: true, passive: false });
  }

  private setRay(event: { clientX: number; clientY: number }): void {
    const rect = this.element.getBoundingClientRect();
    const ndc = new Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  /** The nearest panel under the pointer and the texture coordinate hit. */
  private pick(event: {
    clientX: number;
    clientY: number;
  }): { panel: HtmlPanel; uv: Vector2 } | null {
    this.setRay(event);
    const hit = this.raycaster.intersectObjects(this.panels() as HtmlPanel[], false)[0];
    if (!hit?.uv) return null;
    return { panel: hit.object as HtmlPanel, uv: hit.uv };
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || this.pressed) return;
    const hit = this.pick(event);
    // Pressing anything else in the scene ends typing into the panels.
    for (const panel of this.panels()) if (panel !== hit?.panel) panel.blur();
    if (!hit) return;
    event.stopImmediatePropagation();
    this.element.setPointerCapture(event.pointerId);
    this.pressed = { panel: hit.panel, pointerId: event.pointerId };
    this.hover(hit.panel);
    const input = inputOf(event);
    const slop = input === "touch" ? hit.panel.slopFor(hit.uv, this.slopRays(event)) : undefined;
    hit.panel.pointer("down", hit.uv, event.shiftKey, input, { ...modifiersOf(event), slop });
  };

  /** The rays through the points TAP_SLOP_PX across and down from where a finger pressed (see HtmlPanel.slopFor). */
  private slopRays(event: { clientX: number; clientY: number }): Ray[] {
    return [
      [TAP_SLOP_PX, 0],
      [0, TAP_SLOP_PX],
    ].map(([dx, dy]) => {
      this.setRay({ clientX: event.clientX + dx!, clientY: event.clientY + dy! });
      return this.raycaster.ray.clone();
    });
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.pressed) {
      if (event.pointerId !== this.pressed.pointerId) return;
      this.setRay(event);
      const uv = this.pressed.panel.uvFromRay(this.raycaster.ray);
      if (uv)
        this.pressed.panel.pointer("move", uv, event.shiftKey, inputOf(event), modifiersOf(event));
      return;
    }
    const hit = this.pick(event);
    this.hover(hit?.panel ?? null);
    if (hit) hit.panel.pointer("move", hit.uv, event.shiftKey, inputOf(event));
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    const pressed = this.pressed;
    if (!pressed || event.pointerId !== pressed.pointerId) return;
    this.pressed = null;
    this.setRay(event);
    const uv = pressed.panel.uvFromRay(this.raycaster.ray) ?? new Vector2(-1, -1);
    pressed.panel.pointer("up", uv, false, inputOf(event));
    // A touch has no hover after it lifts.
    if (event.pointerType === "touch") this.hover(null);
    this.updateCursor();
  };

  private readonly onPointerLeave = () => {
    if (!this.pressed) this.hover(null);
  };

  private readonly onTouchStart = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    this.touchStart = touch ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
  };

  private readonly onTouchEnd = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    const start = this.touchStart;
    this.touchStart = null;
    if (!touch || event.touches.length > 0) return;
    // Only a tap: a drag that ends over a text field was a scroll (or a drag in the page).
    if (!start || start.id !== touch.identifier) return;
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TAP_SLOP_PX) return;
    const hit = this.pick(touch);
    if (!hit?.panel.focusForTyping(hit.uv)) return;
    // The browser would follow with compatibility mouse events on the canvas, and
    // its mousedown would take the focus straight back from the keyboard's field.
    event.preventDefault();
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (this.pick(event)) event.preventDefault();
  };

  private readonly onWheel = (event: WheelEvent) => {
    const hit = this.pick(event);
    if (!hit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_HEIGHT_PX : 1;
    hit.panel.wheel(hit.uv, event.deltaX * scale, event.deltaY * scale);
  };

  private hover(panel: HtmlPanel | null): void {
    if (panel === this.hovered) return;
    this.hovered?.pointer("leave");
    this.hovered = panel;
    this.updateCursor();
  }

  /** Shows the cursor of the panel being dragged in, or else hovered, on the canvas. */
  private updateCursor(): void {
    const panel = this.pressed?.panel ?? this.hovered;
    if (panel === this.cursorPanel) return;
    if (this.cursorPanel) this.cursorPanel.removeEventListener("cursorchange", this.onCursorChange);
    else if (panel) this.ownCursor = this.element.style.cursor;
    this.cursorPanel = panel;
    if (panel) {
      panel.addEventListener("cursorchange", this.onCursorChange);
      this.onCursorChange();
    } else {
      this.element.style.cursor = this.ownCursor;
    }
  }

  private readonly onCursorChange = () => {
    if (this.cursorPanel) this.element.style.cursor = this.cursorPanel.cursor;
  };

  dispose(): void {
    // A press still held ends here: the panel would otherwise take every later move for a drag.
    this.pressed?.panel.pointer("up", new Vector2(-1, -1));
    this.hovered = null;
    this.pressed = null;
    this.updateCursor();
    this.element.removeEventListener("pointerdown", this.onPointerDown, true);
    this.element.removeEventListener("pointermove", this.onPointerMove, true);
    this.element.removeEventListener("pointerup", this.onPointerUp, true);
    this.element.removeEventListener("pointercancel", this.onPointerUp, true);
    this.element.removeEventListener("pointerleave", this.onPointerLeave);
    this.element.removeEventListener("wheel", this.onWheel, true);
    this.element.removeEventListener("mousedown", this.onMouseDown, true);
    this.element.removeEventListener("touchstart", this.onTouchStart, true);
    this.element.removeEventListener("touchend", this.onTouchEnd, true);
  }
}
