// An on-screen keyboard for VR.
//
// An immersive session shows no system keyboard, so the host's hidden field
// (PanelKeyboard) cannot take text there. This keyboard is a mesh in the scene:
// PanelXRPointer shows it (showFor) under a panel whose text field (or
// contenteditable element) has focus, and its controllers press its keys. Keys
// go to the panel as text and as the keys the agent edits with (Backspace,
// Enter, the arrows).
//
// Letters, digits and common symbols; no IME (no Japanese input in VR).

import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  type Vector2,
} from "three";
import type { HtmlPanel } from "./html-panel";

export type KeyAction =
  | { type: "text"; text: string }
  | { type: "key"; key: "Backspace" | "Enter" | "ArrowLeft" | "ArrowRight" }
  | { type: "shift" }
  | { type: "layout"; layout: Layout }
  | { type: "done" };

export type Layout = "letters" | "symbols";

interface KeySpec {
  label: string;
  action: KeyAction;
  /** Width in key units (a letter is 1). */
  width?: number;
}

export interface Key extends KeySpec {
  /** Where it is on the keyboard, in key units from the top left. */
  x: number;
  y: number;
  width: number;
}

const char = (text: string): KeySpec => ({ label: text, action: { type: "text", text } });
const row = (characters: string) => Array.from(characters, char);

/** Rows of keys; the widest row is 11 units. */
const LAYOUTS: Record<Layout, KeySpec[][]> = {
  letters: [
    [...row("1234567890"), { label: "⌫", action: { type: "key", key: "Backspace" } }],
    row("qwertyuiop"),
    [...row("asdfghjkl"), { label: "⏎", action: { type: "key", key: "Enter" }, width: 2 }],
    [{ label: "⇧", action: { type: "shift" }, width: 1.5 }, ...row("zxcvbnm,.")],
    bottomRow("?123", "symbols"),
  ],
  symbols: [
    [...row("1234567890"), { label: "⌫", action: { type: "key", key: "Backspace" } }],
    row('-/:;()$&@"'),
    [...row("[]{}#%^*+="), { label: "⏎", action: { type: "key", key: "Enter" } }],
    row("_\\|~<>!?'"),
    bottomRow("ABC", "letters"),
  ],
};

function bottomRow(label: string, layout: Layout): KeySpec[] {
  return [
    { label, action: { type: "layout", layout }, width: 1.5 },
    { label: "←", action: { type: "key", key: "ArrowLeft" } },
    { label: "space", action: { type: "text", text: " " }, width: 5 },
    { label: "→", action: { type: "key", key: "ArrowRight" } },
    { label: "Done", action: { type: "done" }, width: 2.5 },
  ];
}

export const KEYBOARD_COLUMNS = 11;
export const KEYBOARD_ROWS = 5;

/** The keys of a layout, placed: each row centred in the keyboard's width. */
export function keysOf(layout: Layout): Key[] {
  const keys: Key[] = [];
  LAYOUTS[layout].forEach((specs, y) => {
    const total = specs.reduce((sum, spec) => sum + (spec.width ?? 1), 0);
    let x = (KEYBOARD_COLUMNS - total) / 2;
    for (const spec of specs) {
      const width = spec.width ?? 1;
      keys.push({ ...spec, x, y, width });
      x += width;
    }
  });
  return keys;
}

/** The key at a texture coordinate of the keyboard (uv, v up), or null between keys. */
export function keyAt(keys: readonly Key[], uv: { x: number; y: number }): Key | null {
  const x = uv.x * KEYBOARD_COLUMNS;
  const y = (1 - uv.y) * KEYBOARD_ROWS;
  return (
    keys.find((key) => x >= key.x && x < key.x + key.width && y >= key.y && y < key.y + 1) ?? null
  );
}

/** Canvas pixels per key unit. */
const UNIT_PX = 96;
const GAP_PX = 6;

export class PanelXRKeyboard extends Mesh<PlaneGeometry, MeshBasicMaterial> {
  /** The panel the keys type into, which the keyboard is shown under; null when hidden. */
  target: HtmlPanel | null = null;
  private keys = keysOf("letters");
  private shifted = false;
  private hovered: Key | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: CanvasTexture;
  readonly width: number;
  readonly height: number;

  constructor(options: { width?: number } = {}) {
    const width = options.width ?? 0.9;
    const height = (width * KEYBOARD_ROWS) / KEYBOARD_COLUMNS;
    const canvas = document.createElement("canvas");
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    super(
      new PlaneGeometry(width, height),
      new MeshBasicMaterial({ map: texture, transparent: true }),
    );
    this.canvas = canvas;
    this.texture = texture;
    this.width = width;
    this.height = height;
    this.visible = false;
    canvas.width = KEYBOARD_COLUMNS * UNIT_PX;
    canvas.height = KEYBOARD_ROWS * UNIT_PX;
    this.draw();
  }

  /**
   * Shows the keyboard under a panel that takes text, facing the same way and
   * tilted toward the user, and types into it; null hides it.
   */
  showFor(panel: HtmlPanel | null): void {
    if (panel === this.target) return;
    this.target = panel;
    this.visible = panel !== null;
    this.hovered = null;
    if (!panel) return;
    panel.updateWorldMatrix(true, false);
    const below = new Vector3(0, -panel.worldHeight / 2 - this.height / 2 - 0.04, 0.06);
    this.position.copy(panel.localToWorld(below));
    panel.getWorldQuaternion(this.quaternion);
    this.rotateX(-0.35);
    this.updateMatrixWorld();
    this.draw();
  }

  /** The pointer is over the keyboard at `uv` (null: not over it). */
  hover(uv: Vector2 | null): void {
    const key = uv ? keyAt(this.keys, uv) : null;
    if (key === this.hovered) return;
    this.hovered = key;
    this.draw();
  }

  /** A press at `uv`: what the key does goes to the target panel. */
  press(uv: Vector2): void {
    const key = keyAt(this.keys, uv);
    const target = this.target;
    if (!key || !target) return;
    const { action } = key;
    switch (action.type) {
      case "text": {
        const text = this.shifted ? action.text.toUpperCase() : action.text;
        target.sendText(text);
        // Shift holds for one letter, as on phones.
        if (this.shifted) this.shifted = false;
        break;
      }
      case "key":
        target.sendKey(new KeyboardEvent("keydown", { key: action.key }));
        break;
      case "shift":
        this.shifted = !this.shifted;
        break;
      case "layout":
        this.keys = keysOf(action.layout);
        this.shifted = false;
        this.hovered = null;
        break;
      case "done":
        target.blur();
        this.showFor(null);
        return;
    }
    this.draw();
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }

  private draw(): void {
    const context = this.canvas.getContext("2d");
    if (!context) return;
    const { width, height } = this.canvas;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgb(24 28 36 / 92%)";
    roundRect(context, 0, 0, width, height, 24);
    context.fill();
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (const key of this.keys) {
      const left = key.x * UNIT_PX + GAP_PX;
      const top = key.y * UNIT_PX + GAP_PX;
      const keyWidth = key.width * UNIT_PX - 2 * GAP_PX;
      const keyHeight = UNIT_PX - 2 * GAP_PX;
      const special = key.action.type !== "text" || key.label === "space";
      const active = key.action.type === "shift" && this.shifted;
      context.fillStyle =
        key === this.hovered ? "#5b8def" : active ? "#3b6fd8" : special ? "#3a4252" : "#4a5263";
      roundRect(context, left, top, keyWidth, keyHeight, 12);
      context.fill();
      context.fillStyle = "#f2f4f8";
      const label =
        key.action.type === "text" && this.shifted ? key.label.toUpperCase() : key.label;
      context.font = `${label.length > 1 ? 30 : 40}px system-ui, sans-serif`;
      context.fillText(label, left + keyWidth / 2, top + keyHeight / 2);
    }
    this.texture.needsUpdate = true;
  }
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}
