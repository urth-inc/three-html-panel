import { Mesh, PlaneGeometry, Vector2 } from "three";
import { describe, expect, it, vi } from "vite-plus/test";
import type { HtmlPanel } from "./html-panel";
import {
  KEYBOARD_COLUMNS,
  KEYBOARD_ROWS,
  PanelXRKeyboard,
  keyAt,
  keysOf,
} from "./panel-xr-keyboard";

/** The texture coordinate of the middle of the key labelled `label`. */
function uvOf(layout: "letters" | "symbols", label: string): Vector2 {
  const key = keysOf(layout).find((key) => key.label === label)!;
  return new Vector2((key.x + key.width / 2) / KEYBOARD_COLUMNS, 1 - (key.y + 0.5) / KEYBOARD_ROWS);
}

function fakePanel() {
  const panel = Object.assign(new Mesh(new PlaneGeometry(1, 1)), {
    worldHeight: 1,
    sendText: vi.fn(),
    sendKey: vi.fn(),
    blur: vi.fn(),
  });
  return panel as unknown as HtmlPanel & {
    sendText: ReturnType<typeof vi.fn>;
    sendKey: ReturnType<typeof vi.fn>;
    blur: ReturnType<typeof vi.fn>;
  };
}

describe("keys", () => {
  it("fit the keyboard's width in every row", () => {
    for (const layout of ["letters", "symbols"] as const) {
      for (const key of keysOf(layout)) {
        expect(key.x).toBeGreaterThanOrEqual(0);
        expect(key.x + key.width).toBeLessThanOrEqual(KEYBOARD_COLUMNS);
        expect(key.y).toBeLessThan(KEYBOARD_ROWS);
      }
    }
  });

  it("are found at a texture coordinate, and not between rows' ends", () => {
    const keys = keysOf("letters");
    expect(keyAt(keys, uvOf("letters", "q"))!.label).toBe("q");
    expect(keyAt(keys, uvOf("letters", "space"))!.label).toBe("space");
    // Left of "q" (its row is 10 keys wide, centred): no key.
    expect(keyAt(keys, new Vector2(0.01, 1 - 1.5 / KEYBOARD_ROWS))).toBeNull();
  });
});

describe("PanelXRKeyboard", () => {
  it("is hidden until shown under a panel, facing it", () => {
    const keyboard = new PanelXRKeyboard();
    expect(keyboard.visible).toBe(false);
    const panel = fakePanel();
    keyboard.showFor(panel);
    expect(keyboard.visible).toBe(true);
    expect(keyboard.position.y).toBeLessThan(-0.5);
    keyboard.showFor(null);
    expect(keyboard.visible).toBe(false);
  });

  it("types letters, capitals after Shift (for one letter), and symbols", () => {
    const keyboard = new PanelXRKeyboard();
    const panel = fakePanel();
    keyboard.showFor(panel);
    keyboard.press(uvOf("letters", "h"));
    keyboard.press(uvOf("letters", "⇧"));
    keyboard.press(uvOf("letters", "i"));
    keyboard.press(uvOf("letters", "i"));
    keyboard.press(uvOf("letters", "space"));
    keyboard.press(uvOf("letters", "?123"));
    keyboard.press(uvOf("symbols", "@"));
    expect(panel.sendText.mock.calls.map(([text]) => text)).toEqual(["h", "I", "i", " ", "@"]);
  });

  it("sends the editing keys, and Done ends typing", () => {
    const keyboard = new PanelXRKeyboard();
    const panel = fakePanel();
    keyboard.showFor(panel);
    keyboard.press(uvOf("letters", "⌫"));
    keyboard.press(uvOf("letters", "⏎"));
    keyboard.press(uvOf("letters", "←"));
    expect(panel.sendKey.mock.calls.map(([event]) => (event as KeyboardEvent).key)).toEqual([
      "Backspace",
      "Enter",
      "ArrowLeft",
    ]);
    keyboard.press(uvOf("letters", "Done"));
    expect(panel.blur).toHaveBeenCalled();
    expect(keyboard.visible).toBe(false);
  });

  it("types nothing when it is not shown for a panel", () => {
    const keyboard = new PanelXRKeyboard();
    expect(() => keyboard.press(uvOf("letters", "a"))).not.toThrow();
  });
});
