import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vite-plus/test";
import { PROTOCOL_VERSION } from "../protocol";
import {
  parseOrigin,
  parseOrigins,
  readHostOrigin,
  readHostOrigins,
  startAgent,
  type PanelAgent,
} from "./agent";
import { PageCapture } from "./capture/page-capture";
import { RenderPacer } from "./capture/pacer";
import { onHostMessage, sendToHost } from "./page";
import { delivered, eventsWithoutView, stubContentEditable, stubRangeRects } from "../test-helpers";

const HOST = "https://host.example";
const STAGING = "https://staging.example";

let parent: { postMessage: Mock };
let agent: PanelAgent | null = null;
let channel: MessageChannel | null = null;

// jsdom refuses the `view` the agent gives the events it makes.
beforeAll(eventsWithoutView);

beforeEach(() => {
  parent = { postMessage: vi.fn() };
  document.body.innerHTML = `<p>hello</p>`;
});

afterEach(() => {
  agent?.dispose();
  agent = null;
  channel?.port1.close();
  channel?.port2.close();
  channel = null;
});

const start = (hostOrigin: string | readonly string[] | null = HOST) =>
  (agent = startAgent({ hostOrigin, parent: parent as unknown as Window }));

/** Delivers `connect` to the page's window, as if posted by `source` from `origin`. */
function connect(origin = HOST, source: unknown = parent, optimizeHover?: boolean): MessagePort {
  channel = new MessageChannel();
  const event = new MessageEvent("message", {
    data: { type: "connect", version: PROTOCOL_VERSION, optimizeHover },
    origin,
  });
  Object.defineProperty(event, "source", { value: source });
  Object.defineProperty(event, "ports", { value: [channel.port2] });
  window.dispatchEvent(event);
  return channel.port1;
}

describe("starting", () => {
  it("does not start without a valid host origin, and posts nothing", () => {
    for (const origin of [
      null,
      "",
      "*",
      "null",
      "https://host.example/",
      "https://host.example/path",
      "host.example",
    ]) {
      expect(start(origin)).toBeNull();
    }
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it("replaces requestAnimationFrame when it starts, so a held-back iframe does not stall the page", () => {
    const original = window.requestAnimationFrame;
    start();
    expect(window.requestAnimationFrame).not.toBe(original);
    window.requestAnimationFrame = original;
  });

  it("does not start outside a frame", () => {
    expect(startAgent({ hostOrigin: HOST, parent: window })).toBeNull();
  });

  it("posts ready to the host origin only", () => {
    start();
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { type: "ready", version: PROTOCOL_VERSION },
      HOST,
    );
  });

  it("reads the host origin from its script tag", () => {
    document.head.innerHTML = `<script type="module" data-host-origin="${HOST}"></script>`;
    expect(readHostOrigin(document)).toBe(HOST);
    document.head.innerHTML = `<script type="module" data-host-origin="*"></script>`;
    expect(readHostOrigin(document)).toBeNull();
    document.head.innerHTML = "";
    expect(readHostOrigin(document)).toBeNull();
    expect(parseOrigin("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("reads several host origins, separated by white space, or from a list", () => {
    expect(parseOrigins(HOST)).toEqual([HOST]);
    expect(parseOrigins(`  ${HOST}\n\t${STAGING}  `)).toEqual([HOST, STAGING]);
    expect(parseOrigins([HOST, STAGING, HOST])).toEqual([HOST, STAGING]);
    // One that is not exactly an origin (a typo) allows none: not the others quietly.
    expect(parseOrigins(`${HOST} https://staging.example/`)).toBeNull();
    expect(parseOrigins([HOST, "*"])).toBeNull();
    for (const none of [null, "", "   ", []]) expect(parseOrigins(none)).toBeNull();

    document.head.innerHTML = `<script type="module" data-host-origin="${HOST} ${STAGING}"></script>`;
    expect(readHostOrigins(document)).toEqual([HOST, STAGING]);
    // The deprecated reader takes one origin only, as before.
    expect(readHostOrigin(document)).toBeNull();
    document.head.innerHTML = "";
  });

  it("posts ready to each host origin it may be on, and to none if one is not an origin", () => {
    start([HOST, STAGING]);
    expect(parent.postMessage.mock.calls).toEqual([
      [{ type: "ready", version: PROTOCOL_VERSION }, HOST],
      [{ type: "ready", version: PROTOCOL_VERSION }, STAGING],
    ]);
    agent?.dispose();
    parent.postMessage.mockClear();
    expect(start(`${HOST} *`)).toBeNull();
    expect(parent.postMessage).not.toHaveBeenCalled();
  });
});

describe("connecting", () => {
  it("takes connect from any of its host origins, and from no other", () => {
    start(`${HOST} ${STAGING}`);
    connect("https://evil.example");
    expect(agent!.connected).toBe(false);
    connect(STAGING);
    expect(agent!.connected).toBe(true);
  });

  it("ignores connect from another origin or window", () => {
    start();
    connect("https://evil.example");
    expect(agent!.connected).toBe(false);
    connect(HOST, window);
    expect(agent!.connected).toBe(false);
    connect(HOST, null);
    expect(agent!.connected).toBe(false);
  });

  it("talks through the port once connected, and nowhere else", async () => {
    start();
    const host = connect();
    expect(agent!.connected).toBe(true);
    const received: { type: string }[] = [];
    host.onmessage = (event) => received.push(event.data);

    sendToHost({ shape: "box" });
    const fromHost: unknown[] = [];
    const stop = onHostMessage((data) => fromHost.push(data));
    host.postMessage({ type: "app", data: "scene-click" });
    await delivered(50);
    stop();

    expect(received).toContainEqual({ type: "app", data: { shape: "box" } });
    expect(received.some((message) => message.type === "frame")).toBe(true);
    expect(fromHost).toEqual(["scene-click"]);
    // Only `ready` ever went through the parent window.
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
  });

  it("answers the host's ping, so the host knows this document has an agent", async () => {
    start();
    const host = connect();
    const received: { type: string }[] = [];
    host.onmessage = (event) => received.push(event.data);
    host.postMessage({ type: "ping" });
    await delivered(50);
    expect(received).toContainEqual({ type: "pong" });
  });

  it("asks for the keys while any element has focus, with a caret only for a text field", async () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    start();
    const host = connect();
    const received: { type: string; editing?: boolean; caret?: unknown }[] = [];
    host.onmessage = (event) => received.push(event.data);
    document.querySelector<HTMLButtonElement>("#go")!.focus();
    host.postMessage({
      type: "key",
      key: "Shift",
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    await vi.waitFor(() =>
      expect(received.filter((message) => message.type === "editing").at(-1)).toMatchObject({
        editing: true,
        caret: null,
        typing: false,
      }),
    );
  });

  it("tells the host when the focused element takes text (for an on-screen keyboard)", async () => {
    document.body.innerHTML = `<input id="name">`;
    start();
    const host = connect();
    const received: { type: string; typing?: boolean }[] = [];
    host.onmessage = (event) => received.push(event.data);
    document.querySelector<HTMLInputElement>("#name")!.focus();
    host.postMessage({
      type: "key",
      key: "Shift",
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    await vi.waitFor(() =>
      expect(received.filter((message) => message.type === "editing").at(-1)).toMatchObject({
        typing: true,
      }),
    );
  });

  it("answers every tap: an editing report, counting the pointer inputs handled, follows each release", async () => {
    document.body.innerHTML = `<p>no field here</p>`;
    // jsdom has no layout.
    document.elementFromPoint = () => document.querySelector("p");
    start();
    const host = connect();
    const received: { type: string; editing?: boolean; pointers?: number }[] = [];
    host.onmessage = (event) => received.push(event.data);
    const editing = () => received.filter((message) => message.type === "editing");
    host.postMessage({ type: "pointer", kind: "down", x: 5, y: 5, input: "touch" });
    host.postMessage({ type: "pointer", kind: "up", x: 5, y: 5, input: "touch" });
    // Nothing is focused, so nothing changed for the host: it is still told.
    await vi.waitFor(() => expect(editing().at(-1)).toMatchObject({ editing: false, pointers: 2 }));
    const before = editing().length;
    host.postMessage({ type: "pointer", kind: "down", x: 5, y: 5, input: "touch" });
    host.postMessage({ type: "pointer", kind: "move", x: 6, y: 6, input: "touch" });
    host.postMessage({ type: "pointer", kind: "up", x: 6, y: 6, input: "touch" });
    // Moves and leaves are not counted: only presses and releases.
    host.postMessage({ type: "pointer", kind: "leave", x: 0, y: 0 });
    await vi.waitFor(() => expect(editing().at(-1)).toMatchObject({ editing: false, pointers: 4 }));
    expect(editing().length).toBeGreaterThan(before);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("offers no selection for copying when it is too long to send, rather than a part of it", async () => {
    document.body.innerHTML = `<textarea id="long"></textarea>`;
    const field = document.querySelector<HTMLTextAreaElement>("#long")!;
    field.value = "x".repeat(64 * 1024 + 1);
    start();
    const host = connect();
    const received: { type: string; selectedText?: string }[] = [];
    host.onmessage = (event) => received.push(event.data);
    field.focus();
    field.setSelectionRange(0, field.value.length);
    const lastEditing = () => received.filter((message) => message.type === "editing").at(-1);
    // A frame of this much text is slow, so the agent spaces the next ones out: wait for them.
    host.postMessage({
      type: "key",
      key: "Shift",
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    await vi.waitFor(
      () => expect(lastEditing()).toMatchObject({ editing: true, selectedText: "" }),
      { timeout: 3000 },
    );

    field.setSelectionRange(0, 3);
    host.postMessage({
      type: "key",
      key: "Shift",
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    await vi.waitFor(() => expect(lastEditing()).toMatchObject({ selectedText: "xxx" }), {
      timeout: 3000,
    });
  });

  it("asks for the keys while the page's text is selected, offering it for copying", async () => {
    document.body.innerHTML = `<p id="text">some   words</p>`;
    // jsdom has no layout.
    const restoreRects = stubRangeRects(() => [] as unknown as DOMRectList);
    onTestFinished(restoreRects);
    start();
    const host = connect();
    const received: { type: string; editing?: boolean; selectedText?: string }[] = [];
    host.onmessage = (event) => received.push(event.data);
    getSelection()!.selectAllChildren(document.querySelector("#text")!);
    host.postMessage({
      type: "key",
      key: "Shift",
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    await vi.waitFor(() =>
      expect(received.filter((message) => message.type === "editing").at(-1)).toMatchObject({
        editing: true,
        selectedText: "some words",
      }),
    );
    getSelection()!.removeAllRanges();
  });

  it("measures the page's selection again only when the page changes, not on every frame an animation asks for", async () => {
    document.body.innerHTML = `<p id="text">some words</p>`;
    const rects = vi.fn(() => [] as unknown as DOMRectList);
    const restoreRects = stubRangeRects(rects);
    // An endless animation keeps frames coming.
    const animation = {
      effect: {
        target: document.body,
        pseudoElement: null,
        getKeyframes: () => [],
        getTiming: () => ({ iterations: Infinity }),
      },
      playState: "running",
    };
    document.getAnimations = () => [animation as unknown as Animation];
    // Every capture is timed, whether or not its frame is sent.
    const captures = vi.spyOn(RenderPacer.prototype, "record");
    try {
      start();
      const host = connect();
      const editing: { selectedText: string }[] = [];
      host.onmessage = (event) => {
        if (event.data.type === "editing") editing.push(event.data);
      };
      // The user's selection (a key press after it makes it theirs).
      getSelection()!.selectAllChildren(document.querySelector("#text")!);
      host.postMessage({
        type: "key",
        key: "Shift",
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });
      await vi.waitFor(() => expect(rects).toHaveBeenCalled());
      const measured = rects.mock.calls.length;
      const seen = captures.mock.calls.length;
      await vi.waitFor(() => expect(captures.mock.calls.length).toBeGreaterThan(seen + 2), {
        timeout: 3000,
      });
      expect(rects.mock.calls.length).toBe(measured);
      // The selected text itself changes (the selection's ends stay): it is built again.
      (document.querySelector("#text")!.firstChild as Text).data = "other words";
      await vi.waitFor(() => expect(rects.mock.calls.length).toBeGreaterThan(measured));
      await vi.waitFor(() => expect(editing.at(-1)?.selectedText).toBe("other words"));
    } finally {
      captures.mockRestore();
      delete (document as { getAnimations?: unknown }).getAnimations;
      restoreRects();
      getSelection()!.removeAllRanges();
    }
  });

  it("reports an editable's caret only where it shows, cut to the editable", async () => {
    // A box that scrolls its text: what overflows it is hidden.
    document.body.innerHTML = `<div id="editor" contenteditable="true" style="overflow-x: auto; overflow-y: auto">hello</div>`;
    const editor = document.querySelector<HTMLElement>("#editor")!;
    editor.getBoundingClientRect = () => new DOMRect(10, 20, 200, 40);
    Object.defineProperties(editor, { clientWidth: { value: 200 }, clientHeight: { value: 40 } });
    Object.defineProperties(document.documentElement, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 600 },
    });
    // Where the character after the caret is: the line, scrolled half out of the bottom.
    let line = new DOMRect(30, 50, 8, 20);
    const restoreRects = stubRangeRects(() => [line] as unknown as DOMRectList);
    const restoreEditable = stubContentEditable();
    try {
      start();
      const host = connect();
      const received: { type: string; caret?: { y: number; height: number } | null }[] = [];
      host.onmessage = (event) => received.push(event.data);
      editor.focus();
      getSelection()!.collapse(editor.firstChild!, 2);
      const lastCaret = () =>
        received.filter((message) => message.type === "editing").at(-1)?.caret;
      const shift = () =>
        host.postMessage({
          type: "key",
          key: "Shift",
          shiftKey: true,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
        });
      shift();
      await vi.waitFor(() => expect(lastCaret()).toMatchObject({ y: 50, height: 10 }));
      // Out of the editable altogether: no caret.
      line = new DOMRect(30, 100, 8, 20);
      shift();
      await vi.waitFor(() => expect(lastCaret()).toBeNull());
    } finally {
      restoreRects();
      restoreEditable();
      getSelection()!.removeAllRanges();
    }
  });

  it("reports a contenteditable element as a text field too", async () => {
    document.body.innerHTML = `<div id="editor" contenteditable="true"><p>text</p></div>`;
    const editor = document.querySelector<HTMLElement>("#editor")!;
    editor.getBoundingClientRect = () => new DOMRect(10, 20, 200, 80);
    const restoreEditable = stubContentEditable();
    try {
      start();
      const host = connect();
      const received: { type: string; boxes?: unknown }[] = [];
      host.onmessage = (event) => received.push(event.data);
      await vi.waitFor(() =>
        expect(received.find((message) => message.type === "editables")).toEqual({
          type: "editables",
          boxes: [{ left: 10, top: 20, width: 200, height: 80 }],
        }),
      );
    } finally {
      restoreEditable();
    }
  });

  it("hands a link the user follows to the host", async () => {
    document.body.innerHTML = `<a id="docs" href="https://example.com/docs">Docs</a>`;
    start();
    const host = connect();
    const received: { type: string; url?: string }[] = [];
    host.onmessage = (event) => received.push(event.data);
    document
      .getElementById("docs")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await delivered(50);
    expect(received).toContainEqual({ type: "open", url: "https://example.com/docs" });
  });

  it("reports where the text fields are, for the host to open a soft keyboard on a tap", async () => {
    document.body.innerHTML = `<input id="name"><input id="below"><button>Go</button>`;
    document.querySelector("#name")!.getBoundingClientRect = () => new DOMRect(10, 20, 100, 30);
    // Scrolled out of view: not reported.
    document.querySelector("#below")!.getBoundingClientRect = () => new DOMRect(10, 5000, 100, 30);
    start();
    const host = connect();
    const received: { type: string; boxes?: unknown }[] = [];
    host.onmessage = (event) => received.push(event.data);
    await vi.waitFor(() =>
      expect(received.find((message) => message.type === "editables")).toEqual({
        type: "editables",
        boxes: [{ left: 10, top: 20, width: 100, height: 30 }],
      }),
    );
  });

  it("does not send anything before it is connected", async () => {
    start();
    sendToHost({ shape: "box" });
    await delivered(50);
    expect(parent.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("frames", () => {
  const framesOn = (port: MessagePort) => {
    const frames: { svg: string }[] = [];
    port.onmessage = (event) => {
      if (event.data.type === "frame") frames.push(event.data);
    };
    return frames;
  };

  it("does not send a frame that looks like the last one, though it still captures the page", async () => {
    document.body.innerHTML = `<p id="text" title="note">hello</p>`;
    const captures = vi.spyOn(RenderPacer.prototype, "record");
    try {
      start();
      const frames = framesOn(connect());
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      // The DOM changes, as a framework re-rendering does, but not what it shows.
      const seen = captures.mock.calls.length;
      document.querySelector("#text")!.setAttribute("title", "note");
      await vi.waitFor(() => expect(captures.mock.calls.length).toBeGreaterThan(seen));
      await delivered(50);
      expect(frames).toHaveLength(1);
      // What it shows changes: that is sent.
      (document.querySelector("#text")!.firstChild as Text).data = "world";
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames[1]!.svg).toContain("world");
    } finally {
      captures.mockRestore();
    }
  });

  it("sends no frames while the host does not draw the panel, still reports, and sends the page as it is once drawn again", async () => {
    document.body.innerHTML = `<p id="text">hello</p><button id="go">Go</button>`;
    start();
    const host = connect();
    const frames: { svg: string }[] = [];
    const editing: { editing: boolean }[] = [];
    host.onmessage = (event) => {
      if (event.data.type === "frame") frames.push(event.data);
      if (event.data.type === "editing") editing.push(event.data);
    };
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    host.postMessage({ type: "visibility", visible: false });
    await delivered(50);
    (document.querySelector("#text")!.firstChild as Text).data = "world";
    // What the host needs for input is still reported: here, an element took focus.
    document.querySelector<HTMLButtonElement>("#go")!.focus();
    host.postMessage({
      type: "key",
      key: "Shift",
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    await vi.waitFor(() => expect(editing.at(-1)).toMatchObject({ editing: true }));
    await delivered(50);
    expect(frames).toHaveLength(1);
    host.postMessage({ type: "visibility", visible: true });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[1]!.svg).toContain("world");
  });

  it("does not sample an animation while the host does not draw the panel", async () => {
    const animation = {
      effect: {
        target: document.body,
        pseudoElement: null,
        getKeyframes: () => [],
        getTiming: () => ({ iterations: Infinity }),
      },
      playState: "running",
    };
    document.getAnimations = () => [animation as unknown as Animation];
    const captures = vi.spyOn(RenderPacer.prototype, "record");
    try {
      start();
      const host = connect();
      await vi.waitFor(() => expect(captures.mock.calls.length).toBeGreaterThan(2), {
        timeout: 3000,
      });
      host.postMessage({ type: "visibility", visible: false });
      await delivered(50);
      // At most the capture under way when the message came.
      const hidden = captures.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(captures.mock.calls.length).toBeLessThanOrEqual(hidden + 1);
      host.postMessage({ type: "visibility", visible: true });
      await vi.waitFor(() => expect(captures.mock.calls.length).toBeGreaterThan(hidden + 2), {
        timeout: 3000,
      });
    } finally {
      captures.mockRestore();
      delete (document as { getAnimations?: unknown }).getAnimations;
    }
  });

  it("captures at most as often as the host's pace, and as before at pace 0", async () => {
    const animation = {
      effect: {
        target: document.body,
        pseudoElement: null,
        getKeyframes: () => [],
        getTiming: () => ({ iterations: Infinity }),
      },
      playState: "running",
    };
    document.getAnimations = () => [animation as unknown as Animation];
    const at: number[] = [];
    const captures = vi.spyOn(RenderPacer.prototype, "record").mockImplementation(function (
      this: RenderPacer,
    ) {
      at.push(performance.now());
      // As if each capture took no time: the pacer's own shortest interval.
      return 16;
    });
    const gaps = (from: number) => at.slice(from + 1).map((time, i) => time - at[from + i]!);
    try {
      start();
      const host = connect();
      await vi.waitFor(() => expect(at.length).toBeGreaterThan(3), { timeout: 3000 });
      host.postMessage({ type: "pace", intervalMs: 150 });
      await delivered(50);
      const paced = at.length;
      await vi.waitFor(() => expect(at.length).toBeGreaterThan(paced + 3), { timeout: 3000 });
      // The first gap may have started before the pace came.
      expect(Math.min(...gaps(paced))).toBeGreaterThanOrEqual(145);
      host.postMessage({ type: "pace", intervalMs: 0 });
      await delivered(50);
      const unpaced = at.length;
      await vi.waitFor(() => expect(at.length).toBeGreaterThan(unpaced + 3), { timeout: 3000 });
      expect(Math.max(...gaps(unpaced + 1))).toBeLessThan(100);
    } finally {
      captures.mockRestore();
      delete (document as { getAnimations?: unknown }).getAnimations;
    }
  });

  it("goes by a shorter pace at once, not after the longer one a capture was waiting for", async () => {
    const animation = {
      effect: {
        target: document.body,
        pseudoElement: null,
        getKeyframes: () => [],
        getTiming: () => ({ iterations: Infinity }),
      },
      playState: "running",
    };
    document.getAnimations = () => [animation as unknown as Animation];
    const at: number[] = [];
    const captures = vi.spyOn(RenderPacer.prototype, "record").mockImplementation(() => {
      at.push(performance.now());
      return 16;
    });
    try {
      start();
      const host = connect();
      host.postMessage({ type: "pace", intervalMs: 800 });
      await delivered(50);
      // A capture under the long pace: the next one waits 800 ms.
      const seen = at.length;
      await vi.waitFor(() => expect(at.length).toBeGreaterThan(seen), { timeout: 3000 });
      const sent = performance.now();
      host.postMessage({ type: "pace", intervalMs: 0 });
      await vi.waitFor(() => expect(at.length).toBeGreaterThan(seen + 1), { timeout: 3000 });
      expect(at[seen + 1]! - sent).toBeLessThan(300);
    } finally {
      captures.mockRestore();
      delete (document as { getAnimations?: unknown }).getAnimations;
    }
  });

  it("sends the first frame of a new connection even when it looks like the last one sent", async () => {
    start();
    const first = framesOn(connect());
    await vi.waitFor(() => expect(first).toHaveLength(1));
    channel!.port1.close();
    const second = framesOn(connect());
    await vi.waitFor(() => expect(second).toHaveLength(1));
    expect(second[0]!.svg).toBe(first[0]!.svg);
  });
});

it("applies the host hover option before starting capture", () => {
  const captureStart = vi.spyOn(PageCapture.prototype, "start");
  try {
    start();
    connect(HOST, parent, false);
    expect(captureStart).toHaveBeenCalledWith(false);
  } finally {
    captureStart.mockRestore();
  }
});
