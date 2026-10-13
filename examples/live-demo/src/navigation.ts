// Moving around the scene: WASD (or the arrow keys) and an on-screen stick in
// the bottom left, in either of two views. Orbit turns around the panel shown
// (OrbitControls: drag to turn around it, wheel to zoom, right drag to pan):
// W and S come closer to it and go back, A and D go round it. First person
// turns the camera itself (drag toward where to look): WASD walk along the
// ground, where the camera faces. Drags and the wheel over a panel go to the
// panel (PanelPointer takes them first), and keys go to a panel while one of
// its text fields has focus.

import { type PerspectiveCamera, Vector2, Vector3 } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export type ViewMode = "orbit" | "first-person";

/** Metres per second; with Shift, twice that. */
const SPEED = 1.6;
/** Radians per CSS pixel dragged, in first person. */
const LOOK_SPEED = 0.004;
const MAX_PITCH = (85 * Math.PI) / 180;
/** How close orbiting comes to the panel it turns around. */
const MIN_ORBIT_DISTANCE = 0.5;

const UP = new Vector3(0, 1, 0);

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

export class Navigation {
  readonly orbit: OrbitControls;
  #mode: ViewMode = "orbit";
  readonly #camera: PerspectiveCamera;
  readonly #element: HTMLElement;
  /** Whether keys belong to something else now (a panel's text field has focus). */
  readonly #keysTaken: () => boolean;
  readonly #held = new Set<string>();
  /** The on-screen stick: x to the right, y forward, each from -1 to 1. */
  readonly #stick = new Vector2();
  /** The panel shown, which orbiting turns around (a right drag can pan away from it). */
  readonly #center = new Vector3();
  #yaw = 0;
  #pitch = 0;
  #look: { id: number; x: number; y: number } | null = null;
  readonly #listeners = new Set<(mode: ViewMode) => void>();

  constructor(camera: PerspectiveCamera, element: HTMLElement, keysTaken: () => boolean) {
    this.#camera = camera;
    this.#element = element;
    this.#keysTaken = keysTaken;
    this.orbit = new OrbitControls(camera, element);
    this.orbit.enableDamping = true;
    this.orbit.minDistance = MIN_ORBIT_DISTANCE;
    // Gently: a drag across the view turns a quarter round the panel, not most of the way.
    this.orbit.rotateSpeed = 0.35;
    // Not below the floor.
    this.orbit.maxPolarAngle = Math.PI / 2 + 0.1;
    addEventListener("keydown", this.#onKeyDown);
    addEventListener("keyup", this.#onKeyUp);
    addEventListener("blur", () => this.#held.clear());
    element.addEventListener("pointerdown", this.#onPointerDown);
    element.addEventListener("pointermove", this.#onPointerMove);
    element.addEventListener("pointerup", this.#onPointerUp);
    element.addEventListener("pointercancel", this.#onPointerUp);
    element.addEventListener("wheel", this.#onWheel, { passive: false });
  }

  get mode(): ViewMode {
    return this.#mode;
  }

  set mode(mode: ViewMode) {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#look = null;
    const camera = this.#camera;
    if (mode === "first-person") {
      // Looking where the orbit looked.
      const direction = camera.getWorldDirection(new Vector3());
      this.#yaw = Math.atan2(-direction.x, -direction.z);
      this.#pitch = Math.asin(Math.max(-1, Math.min(1, direction.y)));
      this.orbit.enabled = false;
      this.#applyLook();
    } else {
      // Turning around the panel again, from where the camera is.
      this.orbit.target.copy(this.#center);
      this.orbit.enabled = true;
      this.orbit.update();
    }
    for (const listener of this.#listeners) listener(mode);
  }

  /** Calls `listener` with each view mode it changes to. */
  onModeChange(listener: (mode: ViewMode) => void): void {
    this.#listeners.add(listener);
  }

  /** What orbiting turns around and looks at: the panel shown. */
  setCenter(center: Vector3): void {
    this.#center.copy(center);
    this.orbit.target.copy(center);
    if (this.#mode === "orbit") this.orbit.update();
  }

  /** The stick's position: x to the right, y forward, each from -1 to 1 (0, 0 when let go). */
  setStick(x: number, y: number): void {
    this.#stick.set(x, y);
  }

  /** Moves by the keys and the stick held, for `seconds` since the last frame. */
  update(seconds: number): void {
    const input = new Vector2();
    if (!this.#keysTaken()) {
      for (const code of this.#held) {
        const move = MOVE_KEYS[code];
        if (move) input.add(new Vector2(...move));
      }
    }
    if (input.lengthSq() > 1) input.normalize();
    input.add(this.#stick);
    if (input.lengthSq() > 1) input.normalize();
    if (input.lengthSq() > 0) {
      const fast = this.#held.has("ShiftLeft") || this.#held.has("ShiftRight");
      const step = SPEED * (fast ? 2 : 1) * seconds;
      if (this.#mode === "orbit") this.#orbitBy(input, step);
      else this.#walk(input, step);
    }
    if (this.#mode === "orbit") this.orbit.update();
  }

  /** Round the panel (x) and toward it (y), `step` metres along the ground. */
  #orbitBy(input: Vector2, step: number): void {
    const target = this.orbit.target;
    const offset = this.#camera.position.clone().sub(target);
    const distance = Math.hypot(offset.x, offset.z);
    // As far round as `step` along the circle the camera is on.
    offset.applyAxisAngle(UP, (input.x * step) / Math.max(distance, 1));
    const closer =
      Math.max(distance - input.y * step, MIN_ORBIT_DISTANCE) / Math.max(distance, 1e-6);
    offset.x *= closer;
    offset.z *= closer;
    this.#camera.position.copy(target).add(offset);
  }

  /** Along the ground, where the camera faces: forward (y) and to the right (x). */
  #walk(input: Vector2, step: number): void {
    const forward = this.#camera.getWorldDirection(new Vector3()).setY(0);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new Vector3(-forward.z, 0, forward.x);
    this.#camera.position
      .addScaledVector(forward, input.y * step)
      .addScaledVector(right, input.x * step);
  }

  readonly #onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (this.#keysTaken() || isEditable(event.target)) return;
    if (event.code === "KeyV" && !event.repeat) {
      this.mode = this.#mode === "orbit" ? "first-person" : "orbit";
      return;
    }
    this.#held.add(event.code);
    if (event.code in MOVE_KEYS) event.preventDefault();
  };

  readonly #onKeyUp = (event: KeyboardEvent) => {
    this.#held.delete(event.code);
  };

  // First person: a drag outside the panels turns the camera toward it (right to look right).
  readonly #onPointerDown = (event: PointerEvent) => {
    if (this.#mode !== "first-person" || this.#look) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    this.#look = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.#element.setPointerCapture(event.pointerId);
  };

  readonly #onPointerMove = (event: PointerEvent) => {
    const look = this.#look;
    if (!look || event.pointerId !== look.id) return;
    this.#yaw -= (event.clientX - look.x) * LOOK_SPEED;
    this.#pitch -= (event.clientY - look.y) * LOOK_SPEED;
    this.#pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.#pitch));
    look.x = event.clientX;
    look.y = event.clientY;
    this.#applyLook();
  };

  readonly #onPointerUp = (event: PointerEvent) => {
    if (this.#look?.id === event.pointerId) this.#look = null;
  };

  // First person: the wheel outside the panels walks forward and back.
  readonly #onWheel = (event: WheelEvent) => {
    if (this.#mode !== "first-person") return;
    event.preventDefault();
    const forward = this.#camera.getWorldDirection(new Vector3());
    this.#camera.position.addScaledVector(forward, -event.deltaY * 0.002);
  };

  #applyLook(): void {
    this.#camera.rotation.set(this.#pitch, this.#yaw, 0, "YXZ");
  }
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

/**
 * The on-screen stick in `element` (a ring with a knob in it): dragging the
 * knob moves, as far as the ring's edge for full speed; letting go stops.
 */
export function attachStick(element: HTMLElement, knob: HTMLElement, navigation: Navigation): void {
  let active: number | null = null;
  const move = (event: PointerEvent) => {
    const rect = element.getBoundingClientRect();
    const radius = rect.width / 2;
    let x = (event.clientX - rect.left - radius) / radius;
    let y = (event.clientY - rect.top - radius) / radius;
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    knob.style.transform = `translate(${x * radius * 0.6}px, ${y * radius * 0.6}px)`;
    navigation.setStick(x, -y);
  };
  const release = (event: PointerEvent) => {
    if (event.pointerId !== active) return;
    active = null;
    knob.style.transform = "";
    navigation.setStick(0, 0);
  };
  element.addEventListener("pointerdown", (event) => {
    if (active !== null) return;
    active = event.pointerId;
    element.setPointerCapture(event.pointerId);
    move(event);
  });
  element.addEventListener("pointermove", (event) => {
    if (event.pointerId === active) move(event);
  });
  element.addEventListener("pointerup", release);
  element.addEventListener("pointercancel", release);
}
