import {
  PerspectiveCamera,
  Ray,
  Scene,
  Vector2,
  Vector4,
  type Mesh,
  type MeshBasicMaterial,
  type WebGLRenderer,
} from "three";
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { parseCssColor } from "./css-color";
import type { FrameRenderer } from "./frame-renderer";
import {
  FAR_PACE_MS,
  HtmlPanel,
  PANEL_SANDBOX,
  REST_AFTER_MS,
  defaultPixelRatio,
  type HtmlPanelOptions,
} from "./html-panel";
import { PanelKeyboard } from "./panel-keyboard";
import { delivered } from "./test-helpers";

// To count how often the panel reads its caret's color.
vi.mock("./css-color", async (importOriginal) => {
  const original = await importOriginal<typeof import("./css-color")>();
  return { ...original, parseCssColor: vi.fn(original.parseCssColor) };
});

/** Connects the panel as its agent would, and returns the agent's end of the port. */
function connect(panel: HtmlPanel): MessagePort {
  const postMessage = vi.fn();
  panel.iframe.contentWindow!.postMessage = postMessage as typeof window.postMessage;
  const event = new MessageEvent("message", {
    data: { type: "ready", version: 1 },
    origin: panel.sandboxed ? "null" : "https://panel.example",
  });
  Object.defineProperty(event, "source", { value: panel.iframe.contentWindow });
  window.dispatchEvent(event);
  return (postMessage.mock.calls[0]![2] as MessagePort[])[0]!;
}

/** The page reporting a focused text field with its caret. */
const editing = {
  type: "editing",
  editing: true,
  caret: { x: 1, y: 1, height: 16, color: "rgb(0, 0, 0)" },
  selectedText: "",
  pointers: 0,
  typing: true,
};

/** A renderer drawing into an 800x600 canvas. */
const rendererWith = (pixelRatio = 1, domElement = document.createElement("canvas")) =>
  ({
    domElement,
    getSize: (size: Vector2) => size.set(800, 600),
    getPixelRatio: () => pixelRatio,
  }) as unknown as WebGLRenderer;

/**
 * A 90° camera over an 800x600 canvas, at `z` in front of the panel (at the
 * origin, facing +z) or behind it, looking at it. An 800x600 page, 1 unit wide,
 * is drawn at 0.375 / z screen px per page px.
 */
const cameraAt = (z: number) => {
  const camera = new PerspectiveCamera(90, 800 / 600, 0.01, 100);
  camera.position.set(0, 0, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
};

describe("defaultPixelRatio", () => {
  it("is 1 on phones (coarse pointer, small screen) and 2 elsewhere", () => {
    const set = (coarse: boolean, shortSide: number) => {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: coarse && query.includes("coarse"),
      }));
      vi.stubGlobal("screen", { width: shortSide, height: shortSide * 2 });
    };
    set(true, 390);
    expect(defaultPixelRatio()).toBe(1);
    set(true, 1024);
    expect(defaultPixelRatio()).toBe(2);
    set(false, 390);
    expect(defaultPixelRatio()).toBe(2);
    vi.unstubAllGlobals();
  });
});

describe("the panel's iframe", () => {
  /** The iframe's sandbox attribute at the moment its src was set, for each iframe. */
  let sandboxAtSrc: (string | null)[];
  const panels: HtmlPanel[] = [];

  beforeAll(() => {
    // jsdom has no canvas; the renderer only needs a context to paint into.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillRect: () => {},
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D);
    const src = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src")!;
    Object.defineProperty(HTMLIFrameElement.prototype, "src", {
      configurable: true,
      get(this: HTMLIFrameElement) {
        return src.get!.call(this) as string;
      },
      set(this: HTMLIFrameElement, value: string) {
        sandboxAtSrc.push(this.getAttribute("sandbox"));
        // jsdom would try to load the page; the attribute is what matters here.
        this.setAttribute("data-src", value);
      },
    });
  });

  afterEach(() => {
    for (const panel of panels.splice(0)) panel.dispose();
  });

  const open = (
    sandbox?: boolean,
    keyboard?: PanelKeyboard,
    options?: Partial<HtmlPanelOptions>,
  ) => {
    sandboxAtSrc = [];
    const panel = new HtmlPanel({
      url: "https://panel.example/page/",
      sandbox,
      keyboard,
      readyTimeout: 60_000,
      ...options,
    });
    panels.push(panel);
    return panel;
  };

  it("is sandboxed before its src is set, without allow-same-origin, when asked", () => {
    const panel = open(true);
    expect(sandboxAtSrc).toEqual([PANEL_SANDBOX]);
    const tokens = panel.iframe.getAttribute("sandbox")!.split(/\s+/);
    expect(tokens).toEqual(["allow-scripts", "allow-forms", "allow-popups"]);
  });

  it("draws at 1x on phones, by default", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("coarse") }));
    vi.stubGlobal("screen", { width: 390, height: 844 });
    const panel = open();
    vi.unstubAllGlobals();
    // The default page is 800 CSS px wide.
    expect((panel.material.map!.image as HTMLCanvasElement).width).toBe(800);
  });

  it("is not sandboxed by default", () => {
    const panel = open();
    expect(sandboxAtSrc).toEqual([null]);
    expect(panel.iframe.hasAttribute("sandbox")).toBe(false);
    open(false);
    expect(sandboxAtSrc).toEqual([null]);
  });

  it("has the keyboard guard its focus as an untrusted panel's when sandboxed", () => {
    const keyboard = new PanelKeyboard();
    const register = vi.spyOn(keyboard, "register");
    const sandboxed = open(true, keyboard);
    const trusted = open(false, keyboard);
    expect(register).toHaveBeenCalledWith(sandboxed.iframe, { sandboxed: true });
    expect(register).toHaveBeenCalledWith(trusted.iframe, { sandboxed: false });
  });

  it("tells how far a press may wobble in the page, at most a tenth of its larger side", () => {
    const panel = open();
    const at = new Vector2(0.5, 0.5);
    // 0.01 of the panel across: 8 px of an 800 px wide page.
    panel.uvFromRay = () => new Vector2(0.51, 0.5);
    expect(panel.slopFor(at, [new Ray()])).toBeCloseTo(8);
    // Seen nearly edge-on, the ray meets the plane far away: no more than 80 px.
    panel.uvFromRay = () => new Vector2(40, 0.5);
    expect(panel.slopFor(at, [new Ray()])).toBeCloseTo(80);
    panel.uvFromRay = () => null;
    expect(panel.slopFor(at, [new Ray()])).toBeUndefined();
  });

  describe("a page that focuses a text field on its own", () => {
    it("draws the caret in the page's color and alpha, whatever syntax the page wrote it in", async () => {
      const panel = open(false);
      const port = connect(panel);
      const caret = (panel as unknown as { caret: Mesh<never, MeshBasicMaterial> }).caret;
      const show = async (color: string) => {
        port.postMessage({ ...editing, caret: { ...editing.caret, color } });
        await delivered();
      };
      const rgb = () => {
        const { r, g, b } = caret.material.color.getRGB({ r: 0, g: 0, b: 0 }, "srgb");
        return [r, g, b].map((c) => Math.round(c * 255));
      };

      await show("color(srgb 0 0 0 / 0.87)");
      expect(caret.userData.hasCaret).toBe(true);
      expect(rgb()).toEqual([0, 0, 0]);
      expect(caret.material.opacity).toBe(0.87);

      await show("oklch(0.627955 0.257683 29.2339 / 0.5)");
      expect(rgb()).toEqual([255, 0, 0]);
      expect(caret.material.opacity).toBe(0.5);

      // A color it cannot read keeps the last one it could, without a warning.
      const warn = vi.spyOn(console, "warn");
      await show("color(future-space 0.1 0.2 0.3)");
      expect(caret.userData.hasCaret).toBe(true);
      expect(rgb()).toEqual([255, 0, 0]);
      expect(caret.material.opacity).toBe(0.5);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();

      // caret-color: transparent hides it, and is not kept for colors it cannot read.
      await show("rgba(0, 0, 0, 0)");
      expect(caret.userData.hasCaret).toBe(false);
      expect(caret.visible).toBe(false);
      await show("color(srgb 0 0 1 / 0)");
      expect(caret.userData.hasCaret).toBe(false);
      await show("not a color");
      expect(caret.userData.hasCaret).toBe(true);
      expect(rgb()).toEqual([255, 0, 0]);
      port.close();
    });

    it("reads the caret's color again only when the page sends another", async () => {
      const panel = open(false);
      const port = connect(panel);
      const parse = vi.mocked(parseCssColor);
      const show = async (color: string) => {
        port.postMessage({ ...editing, caret: { ...editing.caret, color } });
        await delivered();
      };
      parse.mockClear();
      await show("oklch(0.7 0.1 150)");
      await show("oklch(0.7 0.1 150)");
      await show("not a color");
      await show("not a color");
      await show("oklch(0.7 0.1 150)");
      expect(parse.mock.calls).toEqual([
        ["oklch(0.7 0.1 150)"],
        ["not a color"],
        ["oklch(0.7 0.1 150)"],
      ]);
      port.close();
    });

    it("does not take the keyboard when sandboxed and the user did not press the panel", async () => {
      const keyboard = new PanelKeyboard();
      const focus = vi.spyOn(keyboard, "focus");
      const panel = open(true, keyboard);
      const port = connect(panel);
      const received: unknown[] = [];
      port.onmessage = (event) => received.push(event.data);

      port.postMessage(editing);
      await delivered();
      expect(focus).not.toHaveBeenCalled();
      // The page is told to let go of its focus.
      expect(received).toContainEqual({ type: "blur" });

      // Right after the user pressed the panel, it may.
      panel.pointer("down", new Vector2(0.5, 0.5));
      port.postMessage(editing);
      await delivered();
      expect(focus).toHaveBeenCalledWith(panel, true);
      port.close();
    });

    it("counts dragging in the panel as acting on it, however long the press, but not hovering", async () => {
      const keyboard = new PanelKeyboard();
      const focus = vi.spyOn(keyboard, "focus");
      const panel = open(true, keyboard);
      const port = connect(panel);
      const received: unknown[] = [];
      port.onmessage = (event) => received.push(event.data);
      const now = vi.spyOn(performance, "now");
      const at = (time: number) => now.mockReturnValue(time);
      const selecting = { ...editing, caret: null, selectedText: "some text" };

      // Pressed, held still for a while, then dragged: selecting text only now.
      at(10_000);
      panel.pointer("down", new Vector2(0.2, 0.5));
      at(12_000);
      panel.pointer("move", new Vector2(0.4, 0.5));
      port.postMessage(selecting);
      await delivered();
      expect(focus).toHaveBeenCalledWith(panel, true);
      expect(received).not.toContainEqual({ type: "blur" });

      // Released: moving over the panel afterwards is hovering, not acting on it.
      panel.pointer("up", new Vector2(0.4, 0.5));
      panel.blur();
      focus.mockClear();
      received.length = 0;
      at(20_000);
      panel.pointer("move", new Vector2(0.6, 0.5));
      port.postMessage(selecting);
      await delivered();
      expect(focus).not.toHaveBeenCalled();
      expect(received).toContainEqual({ type: "blur" });

      // A press that ended without an up (pressing another panel, the pointer leaving):
      // moving afterwards is hovering, not dragging.
      for (const end of [() => panel.blur(), () => panel.pointer("leave")]) {
        panel.pointer("down", new Vector2(0.2, 0.5));
        end();
        focus.mockClear();
        received.length = 0;
        at(now() + 5000);
        panel.pointer("move", new Vector2(0.6, 0.5));
        port.postMessage(selecting);
        await delivered();
        expect(focus).not.toHaveBeenCalled();
        expect(received).toContainEqual({ type: "blur" });
      }

      // A new document (the press began in the one before).
      panel.pointer("down", new Vector2(0.2, 0.5));
      const next = connect(panel);
      const nextReceived: unknown[] = [];
      next.onmessage = (event) => nextReceived.push(event.data);
      focus.mockClear();
      at(now() + 5000);
      panel.pointer("move", new Vector2(0.6, 0.5));
      next.postMessage(selecting);
      await delivered();
      expect(focus).not.toHaveBeenCalled();
      expect(nextReceived).toContainEqual({ type: "blur" });
      next.close();
      port.close();
    });

    it("shows no soft keyboard for a button or a link with focus, until a text field has it", async () => {
      const keyboard = new PanelKeyboard();
      const focus = vi.spyOn(keyboard, "focus");
      const setTyping = vi.spyOn(keyboard, "setTyping");
      const panel = open(false, keyboard);
      const port = connect(panel);
      // A button has focus: its keys (Enter, Space, Tab) go to the page, no text.
      port.postMessage({ ...editing, caret: null, typing: false });
      await delivered();
      expect(focus).toHaveBeenCalledWith(panel, false);
      // Then a text field.
      port.postMessage(editing);
      await delivered();
      expect(setTyping).toHaveBeenLastCalledWith(panel, true);
      // And a button again.
      port.postMessage({ ...editing, caret: null, typing: false });
      await delivered();
      expect(setTyping).toHaveBeenLastCalledWith(panel, false);
      expect(focus).toHaveBeenCalledTimes(1);
      keyboard.release(panel);
      port.close();
    });

    it("tells whether text typed now goes into the page (for an on-screen keyboard)", async () => {
      const panel = open(false);
      const port = connect(panel);
      expect(panel.isTyping).toBe(false);
      // A button has focus: keys, but no text.
      port.postMessage({ ...editing, caret: null, typing: false });
      await delivered();
      expect(panel.isTyping).toBe(false);
      port.postMessage(editing);
      await delivered();
      expect(panel.isTyping).toBe(true);
      // Text selected in the field: no caret drawn, still typing.
      port.postMessage({ ...editing, caret: null, selectedText: "abc" });
      await delivered();
      expect(panel.isTyping).toBe(true);
      // Focus went straight from the field to a button: no text to type.
      port.postMessage({ ...editing, caret: null, typing: false });
      await delivered();
      expect(panel.isTyping).toBe(false);
      port.postMessage(editing);
      await delivered();
      panel.blur();
      expect(panel.isTyping).toBe(false);
      port.close();
    });

    it("is not typing in a sandboxed panel whose page took focus on its own", async () => {
      const panel = open(true);
      const port = connect(panel);
      port.postMessage(editing);
      await delivered();
      expect(panel.isTyping).toBe(false);
      port.close();
    });

    it("keeps the page's selected text for copying while editing, and forgets it after", async () => {
      const panel = open(false, new PanelKeyboard());
      const port = connect(panel);
      port.postMessage({ ...editing, selectedText: "copy me" });
      await delivered();
      expect(panel.selectedText()).toBe("copy me");
      port.postMessage({
        type: "editing",
        editing: false,
        caret: null,
        selectedText: "stale",
        pointers: 0,
        typing: false,
      });
      await delivered();
      expect(panel.selectedText()).toBe("");
      port.close();
    });

    it("opens a link the page hands over only right after the user acted on the panel, and only http(s)", async () => {
      const onLink = vi.fn();
      const panel = open(false, undefined, { onLink });
      const port = connect(panel);
      // On its own: ignored.
      port.postMessage({ type: "open", url: "https://example.com/" });
      await delivered();
      expect(onLink).not.toHaveBeenCalled();

      panel.pointer("down", new Vector2(0.5, 0.5));
      port.postMessage({ type: "open", url: "javascript:alert(1)" });
      port.postMessage({ type: "open", url: "https://example.com/" });
      await delivered();
      expect(onLink).toHaveBeenCalledTimes(1);
      expect((onLink.mock.calls[0]![0] as URL).href).toBe("https://example.com/");
      port.close();
    });

    it("counts a key the user pressed in the panel (Enter on a focused link) as acting on it", async () => {
      const onLink = vi.fn();
      const panel = open(undefined, undefined, { onLink });
      const port = connect(panel);
      panel.sendKey(new KeyboardEvent("keydown", { key: "Enter" }));
      port.postMessage({ type: "open", url: "https://example.com/" });
      await delivered();
      expect(onLink).toHaveBeenCalledTimes(1);
      port.close();
    });

    it("opens links to other origins in a new tab, without a way back to the host, by default", async () => {
      const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
      onTestFinished(() => windowOpen.mockRestore());
      const panel = open(false);
      const port = connect(panel);
      panel.pointer("up", new Vector2(0.5, 0.5));
      port.postMessage({ type: "open", url: "https://example.com/" });
      await delivered();
      expect(windowOpen).toHaveBeenCalledWith(
        "https://example.com/",
        "_blank",
        "noopener,noreferrer",
      );
      expect(panel.iframe.getAttribute("data-src")).toBe("https://panel.example/page/");
      port.close();
    });

    it("opens links to the panel's own origin in the panel, by default", async () => {
      const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
      onTestFinished(() => windowOpen.mockRestore());
      const panel = open(true);
      const port = connect(panel);
      panel.pointer("up", new Vector2(0.5, 0.5));
      port.postMessage({ type: "open", url: "https://panel.example/other/?q=1" });
      await delivered();
      expect(windowOpen).not.toHaveBeenCalled();
      expect(panel.iframe.getAttribute("data-src")).toBe("https://panel.example/other/?q=1");
      // The page it opens is loaded sandboxed too, as the first.
      expect(sandboxAtSrc.at(-1)).toBe(PANEL_SANDBOX);
      // Another port of the same host is another origin: a new tab.
      port.postMessage({ type: "open", url: "https://panel.example:8443/" });
      await delivered();
      expect(windowOpen).toHaveBeenCalledTimes(1);
      port.close();
    });

    describe("a tap on a text field", () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      /** A sandboxed panel whose page has a 200x40 field at its top left, tapped there (down and up sent). */
      async function tapped() {
        const keyboard = new PanelKeyboard();
        const focus = vi.spyOn(keyboard, "focus");
        const release = vi.spyOn(keyboard, "release");
        const panel = open(true, keyboard);
        const port = connect(panel);
        const received: unknown[] = [];
        port.onmessage = (event) => received.push(event.data);
        port.postMessage({
          type: "editables",
          boxes: [{ left: 0, top: 0, width: 200, height: 40 }],
        });
        await delivered();
        const field = new Vector2(0.05, 0.98);
        panel.pointer("down", field, false, "touch");
        panel.pointer("up", field, false, "touch");
        return { panel, port, focus, release, received, field };
      }
      const answer = (editing: boolean, pointers: number) => ({
        type: "editing",
        editing,
        caret: editing ? { x: 5, y: 5, height: 16, color: "rgb(0, 0, 0)" } : null,
        selectedText: "",
        pointers,
        typing: editing,
      });

      it("takes the keyboard only over a text field", async () => {
        const { panel, port, focus } = await tapped();
        expect(panel.focusForTyping(new Vector2(0.9, 0.1))).toBe(false);
        expect(focus).not.toHaveBeenCalled();
        expect(panel.focusForTyping(new Vector2(0.05, 0.98))).toBe(true);
        // As a tap's: the keyboard's field is focused again if it has focus already (see PanelKeyboard.focus).
        expect(focus).toHaveBeenCalledWith(panel, true, true);
        port.close();
      });

      it("opens the soft keyboard for a tap on a field the page focused on its own after a press", async () => {
        const { panel, port, focus, field } = await tapped();
        const keys = document.querySelectorAll<HTMLTextAreaElement>("textarea[aria-hidden]");
        const hidden = keys[keys.length - 1]!;
        const focuses = vi.fn();
        hidden.addEventListener("focus", focuses);
        // The press (a channel, say) made the page focus its composer: no tap moved the focus.
        port.postMessage(answer(true, 2));
        await delivered();
        expect(focus).toHaveBeenLastCalledWith(panel, true);
        expect(document.activeElement).toBe(hidden);
        expect(focuses).toHaveBeenCalledTimes(1);
        // A tap on the composer focuses the keyboard's field again, while the touch is handled.
        expect(panel.focusForTyping(field)).toBe(true);
        expect(focuses).toHaveBeenCalledTimes(2);
        expect(document.activeElement).toBe(hidden);
        hidden.removeEventListener("focus", focuses);
        port.close();
      });

      it("lets it go when the page's answer to the tap shows no focus", async () => {
        const { panel, port, release, field } = await tapped();
        panel.focusForTyping(field);
        port.postMessage(answer(false, 2));
        await delivered();
        expect(release).toHaveBeenCalledWith(panel);
        port.close();
      });

      it("keeps it when the page answers late, even sandboxed (a slow page)", async () => {
        const { panel, port, release, received, field } = await tapped();
        panel.focusForTyping(field);
        // Past the second in which a sandboxed page may take the keyboard on its own.
        vi.spyOn(performance, "now").mockReturnValue(performance.now() + 3000);
        port.postMessage(answer(true, 2));
        await delivered();
        expect(release).not.toHaveBeenCalled();
        expect(received).not.toContainEqual({ type: "blur" });
        port.close();
      });

      it("takes the answer to the release, whatever moves and leaves came after it", async () => {
        const { panel, port, release, field } = await tapped();
        // PanelPointer ends a touch's hover right after its release.
        panel.pointer("leave");
        panel.pointer("move", field, false, "touch");
        panel.focusForTyping(field);
        port.postMessage(answer(false, 2));
        await delivered();
        expect(release).toHaveBeenCalledWith(panel);
        port.close();
      });

      it("does not take an earlier report for the answer", async () => {
        const { panel, port, release, field } = await tapped();
        panel.focusForTyping(field);
        // Sent before the page handled the tap's release.
        port.postMessage(answer(false, 1));
        await delivered();
        expect(release).not.toHaveBeenCalled();
        port.close();
      });

      it("lets it go if the page never answers", async () => {
        const { panel, port, release, field } = await tapped();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        panel.focusForTyping(field);
        vi.advanceTimersByTime(4999);
        expect(release).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(release).toHaveBeenCalledWith(panel);
        port.close();
      });
    });

    it("takes the keyboard when not sandboxed, as before", async () => {
      const keyboard = new PanelKeyboard();
      const focus = vi.spyOn(keyboard, "focus");
      const panel = open(false, keyboard);
      const port = connect(panel);
      port.postMessage(editing);
      await delivered();
      expect(focus).toHaveBeenCalledWith(panel, true);
      port.close();
    });
  });

  it("places the IME at the caret on screen while the keyboard types into the panel", async () => {
    const keyboard = new PanelKeyboard();
    const placeIme = vi.spyOn(keyboard, "placeIme");
    const panel = open(false, keyboard);
    // A 1x1 panel facing a camera 1 unit in front of it.
    panel.updateMatrixWorld();
    const camera = cameraAt(1);
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    const renderer = rendererWith(1, canvas);

    const port = connect(panel);
    // The page's default size is 800x600: a caret at its centre.
    port.postMessage({ ...editing, caret: { ...editing.caret, x: 400, y: 290, height: 20 } });
    await delivered();

    panel.onBeforeRender(renderer, new Scene(), camera);
    expect(placeIme).toHaveBeenCalledTimes(1);
    const placement = placeIme.mock.calls[0]![0]!;
    expect(placement.x).toBe(400);
    expect(placement.y).toBeLessThan(300);
    expect(placement.y + placement.height).toBeGreaterThan(300);
    // Unchanged: not placed again.
    panel.onBeforeRender(renderer, new Scene(), camera);
    expect(placeIme).toHaveBeenCalledTimes(1);

    // With a finger, the field stays in its corner (iOS would scroll to it).
    placeIme.mockClear();
    panel.pointer("down", new Vector2(0.5, 0.5), false, "touch");
    camera.position.x = 0.1;
    camera.updateMatrixWorld();
    panel.onBeforeRender(renderer, new Scene(), camera);
    expect(placeIme).not.toHaveBeenCalled();
    panel.pointer("down", new Vector2(0.5, 0.5), false, "mouse");

    // Once keys no longer go to the panel, its caret does not move the IME.
    keyboard.release(panel);
    placeIme.mockClear();
    camera.position.x = 0.2;
    camera.updateMatrixWorld();
    panel.onBeforeRender(renderer, new Scene(), camera);
    expect(placeIme).not.toHaveBeenCalled();
    port.close();
  });

  describe("while it is not drawn", () => {
    const renderer = rendererWith();
    const front = cameraAt(1);
    const behind = cameraAt(-1);

    /** Connects the panel as its page would; returns the page's port and what the host sends it. */
    const connectWatching = (panel: HtmlPanel) => {
      const port = connect(panel);
      const visibility: unknown[] = [];
      port.onmessage = (event) => {
        if (event.data.type === "visibility") visibility.push(event.data.visible);
      };
      return { port, visibility };
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("tells the page when it has not been drawn facing the camera for a second, and when it is again", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
      const panel = open();
      panel.updateMatrixWorld();
      const { port, visibility } = connectWatching(panel);
      const draw = (camera: PerspectiveCamera, times: number) => {
        for (let i = 0; i < times; i++) {
          panel.onBeforeRender(renderer, new Scene(), camera);
          vi.advanceTimersByTime(100);
        }
      };
      // Drawn all along: nothing to say.
      draw(front, 20);
      // Drawn, but seen from behind (its back is a plain plane): not for a second yet.
      draw(behind, 9);
      await delivered();
      expect(visibility).toEqual([]);
      draw(behind, 4);
      await delivered();
      expect(visibility).toEqual([false]);
      // Drawn facing the camera again: at once.
      panel.onBeforeRender(renderer, new Scene(), front);
      await delivered();
      expect(visibility).toEqual([false, true]);
      port.close();
    });

    it("rests after REST_AFTER_MS hidden: its iframe is not painted and its canvas let go of, until it is drawn again", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
      const panel = open();
      panel.updateMatrixWorld();
      const { port } = connectWatching(panel);
      const release = vi.spyOn(
        (panel as unknown as { renderer: FrameRenderer }).renderer,
        "release",
      );
      vi.advanceTimersByTime(REST_AFTER_MS - 500);
      expect(panel.iframe.style.visibility).toBe("");
      vi.advanceTimersByTime(1000);
      // Off screen and invisible, still laid out at its size (a page loaded meanwhile is not 0x0).
      expect(panel.iframe.style.visibility).toBe("hidden");
      expect(parseFloat(panel.iframe.style.left)).toBeLessThan(-1000);
      expect(panel.iframe.style.display).toBe("");
      expect(release).toHaveBeenCalledTimes(1);
      panel.onBeforeRender(renderer, new Scene(), front);
      expect([panel.iframe.style.left, panel.iframe.style.visibility]).toEqual(["0px", ""]);
      port.close();
    });

    it("tells a page that connects while it is not drawn", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
      const panel = open();
      connectWatching(panel).port.close();
      vi.advanceTimersByTime(1500);
      // The page navigated: a new document connects.
      const { port, visibility } = connectWatching(panel);
      await delivered();
      expect(visibility).toEqual([false]);
      port.close();
    });

    it("leaves the page alone with pauseWhenHidden off", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
      const panel = open(undefined, undefined, { pauseWhenHidden: false });
      const { port, visibility } = connectWatching(panel);
      vi.advanceTimersByTime(5000);
      await delivered();
      expect(visibility).toEqual([]);
      port.close();
    });
  });

  describe("drawn small", () => {
    // At a distance d, the panel is drawn at 0.375 / d screen px per page px (see cameraAt).
    const renderer = rendererWith();
    const connectWatching = (panel: HtmlPanel) => {
      const port = connect(panel);
      const paces: number[] = [];
      port.onmessage = (event) => {
        if (event.data.type === "pace") paces.push(event.data.intervalMs);
      };
      return { port, paces };
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("asks the page for fewer frames once drawn small for a while, and for all at once when drawn larger", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
      const panel = open();
      panel.updateMatrixWorld();
      const { port, paces } = connectWatching(panel);
      /** Draws the panel from these distances, then lets the panel decide. */
      const frame = async (...distances: number[]) => {
        for (const z of distances) panel.onBeforeRender(renderer, new Scene(), cameraAt(z));
        vi.advanceTimersByTime(250);
        await delivered();
      };
      await frame(1); // 0.375: near
      expect(paces).toEqual([]);
      panel.onBeforeRender(renderer, new Scene(), cameraAt(2)); // 0.19
      await delivered();
      // Not at once: another view may still draw it large.
      expect(paces).toEqual([]);
      await frame(2);
      expect(paces).toEqual([FAR_PACE_MS]);
      // Between the two scales it stays as it was, either way: no flipping at the edge.
      await frame(1.4); // 0.27
      expect(paces).toEqual([FAR_PACE_MS]);
      panel.onBeforeRender(renderer, new Scene(), cameraAt(1));
      await delivered();
      // Near: at once.
      expect(paces).toEqual([FAR_PACE_MS, 0]);
      vi.advanceTimersByTime(250);
      await frame(1.4);
      expect(paces).toEqual([FAR_PACE_MS, 0]);
      port.close();
    });

    it("stays near while any view draws it large, as a minimap or a mirror drawing it small too", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
      const panel = open();
      panel.updateMatrixWorld();
      const { port, paces } = connectWatching(panel);
      for (let i = 0; i < 8; i++) {
        panel.onBeforeRender(renderer, new Scene(), cameraAt(1));
        panel.onBeforeRender(renderer, new Scene(), cameraAt(4));
        vi.advanceTimersByTime(250);
      }
      await delivered();
      expect(paces).toEqual([]);
      port.close();
    });

    it("measures a camera of a stereo pair by its own viewport, not the whole canvas", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
      const panel = open();
      panel.updateMatrixWorld();
      const { port, paces } = connectWatching(panel);
      // Near over the whole 800x600 canvas (0.375), but this eye draws into 400x300 of it: 0.19.
      const eye = Object.assign(cameraAt(1), { viewport: new Vector4(0, 0, 400, 300) });
      panel.onBeforeRender(renderer, new Scene(), eye);
      vi.advanceTimersByTime(250);
      await delivered();
      expect(paces).toEqual([FAR_PACE_MS]);
      port.close();
    });

    it("tells a page that connects while the panel is drawn small", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
      const panel = open();
      panel.updateMatrixWorld();
      connectWatching(panel).port.close();
      panel.onBeforeRender(renderer, new Scene(), cameraAt(3));
      vi.advanceTimersByTime(250);
      const { port, paces } = connectWatching(panel);
      await delivered();
      expect(paces).toEqual([FAR_PACE_MS]);
      port.close();
    });
  });

  describe("the texture's resolution", () => {
    // At a distance d, drawn at 0.375 / d screen px per page px (see cameraAt).
    /** The panel's texture width (the page is 800 CSS px wide, drawn at pixelRatio 2 at most). */
    const textureWidth = (panel: HtmlPanel) =>
      (panel as unknown as { renderer: { canvas: HTMLCanvasElement } }).renderer.canvas.width;

    afterEach(() => {
      vi.useRealTimers();
    });

    it("goes down once every view draws the panel well under it, and back up at once when one draws it denser", () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
      const panel = open();
      panel.updateMatrixWorld();
      const renderer = rendererWith(1);
      const draw = (z: number) => panel.onBeforeRender(renderer, new Scene(), cameraAt(z));
      expect(textureWidth(panel)).toBe(1600);
      // 0.75 screen px per page px: well under 1 (the half), not under 0.5 (the quarter) by enough.
      draw(0.5);
      expect(textureWidth(panel)).toBe(1600);
      vi.advanceTimersByTime(250);
      expect(textureWidth(panel)).toBe(800);
      // 0.45: under the quarter's 0.5, but not well under it: stays.
      draw(0.83);
      vi.advanceTimersByTime(250);
      expect(textureWidth(panel)).toBe(800);
      // 0.375: well under the quarter's 0.5 too.
      draw(1);
      vi.advanceTimersByTime(250);
      expect(textureWidth(panel)).toBe(400);
      // 0.47: drawn at no more than the quarter: stays.
      draw(0.8);
      vi.advanceTimersByTime(250);
      expect(textureWidth(panel)).toBe(400);
      // 1.25: denser than the half too: the full resolution, at once.
      draw(0.3);
      expect(textureWidth(panel)).toBe(1600);
    });

    it("keeps the resolution any view needs, and counts the screen's pixel ratio but not an eye's", () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
      const panel = open();
      panel.updateMatrixWorld();
      // A minimap drawing it small does not lower it while the main view draws it large.
      for (let i = 0; i < 4; i++) {
        panel.onBeforeRender(rendererWith(1), new Scene(), cameraAt(0.3));
        panel.onBeforeRender(rendererWith(1), new Scene(), cameraAt(4));
        vi.advanceTimersByTime(250);
      }
      expect(textureWidth(panel)).toBe(1600);
      // On a 2x screen, 0.75 CSS px is 1.5 device px: too dense for the half.
      for (let i = 0; i < 4; i++) {
        panel.onBeforeRender(rendererWith(2), new Scene(), cameraAt(0.5));
        vi.advanceTimersByTime(250);
      }
      expect(textureWidth(panel)).toBe(1600);
      // An eye's viewport is in device pixels already: 0.75, the half.
      const eye = Object.assign(cameraAt(0.5), { viewport: new Vector4(0, 0, 800, 600) });
      panel.onBeforeRender(rendererWith(2), new Scene(), eye);
      vi.advanceTimersByTime(250);
      expect(textureWidth(panel)).toBe(800);
    });
  });
});
