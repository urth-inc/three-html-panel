// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DocumentCss } from "./css";
import { LiveInteractionCss } from "./live-css";
import { PageCapture } from "./page-capture";
import { RenderPacer } from "./pacer";

let capture: PageCapture;
let hit: Element;
let frames: string[];
let cursors: string[];
let captures: ReturnType<typeof vi.spyOn>;
const move = () => capture.handle({ type: "pointer", kind: "move", x: 5, y: 5 });
const settle = () => vi.advanceTimersByTimeAsync(100);

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "<button>One</button><button>Two</button>";
  hit = document.querySelector("button")!;
  vi.stubGlobal("PointerEvent", class extends MouseEvent {});
  const Mouse = window.MouseEvent;
  vi.spyOn(window, "MouseEvent").mockImplementation(function (type, init) {
    return new Mouse(type, { ...init, view: null });
  });
  vi.spyOn(window, "PointerEvent").mockImplementation(function (type, init) {
    return new Mouse(type, { ...init, view: null }) as PointerEvent;
  });
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
  frames = [];
  cursors = [];
  captures = vi.spyOn(RenderPacer.prototype, "record");
  capture = new PageCapture(document, {
    onFrame: (frame) => frames.push(frame.svg),
    onEditing() {},
    onEditables() {},
    onCursor: (cursor) => cursors.push(cursor),
  });
});

afterEach(() => {
  capture.dispose();
  document.head.innerHTML = "";
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("skips unchanged hover by default, but dispatches events and captures entering and leaving", async () => {
  const listener = vi.fn();
  hit.addEventListener("pointermove", listener);
  capture.start();
  await settle();
  move();
  await settle();
  expect(frames.at(-1)).toContain("data-thp-hover");
  const count = captures.mock.calls.length;
  move();
  move();
  await settle();
  expect(listener).toHaveBeenCalledTimes(3);
  expect(captures).toHaveBeenCalledTimes(count);
  hit = document.querySelectorAll("button")[1]!;
  move();
  await settle();
  expect(captures).toHaveBeenCalledTimes(count + 1);
  capture.handle({ type: "pointer", kind: "leave", x: 0, y: 0 });
  await settle();
  expect(frames.at(-1)).not.toContain("data-thp-hover");
});

describe("an indeterminate <progress>", () => {
  /** A progress the browser draws, at `top` in a 300x150 viewport (jsdom lays nothing out). */
  function progressAt(top: number, visible = true): HTMLProgressElement {
    const progress = document.createElement("progress");
    progress.getBoundingClientRect = () => new DOMRect(0, top, 100, 10);
    progress.checkVisibility = () => visible;
    document.body.append(progress);
    return progress;
  }
  /** How many captures a second of waiting makes. */
  async function capturesInASecond(): Promise<number> {
    await settle();
    const count = captures.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    return captures.mock.calls.length - count;
  }

  it("keeps the panel capturing while one shows, to draw it moving", async () => {
    vi.stubGlobal("innerWidth", 300);
    vi.stubGlobal("innerHeight", 150);
    progressAt(20);
    capture.start();
    expect(await capturesInASecond()).toBeGreaterThan(10);
  });

  it("does not while it is hidden, out of view, or has a value", async () => {
    vi.stubGlobal("innerWidth", 300);
    vi.stubGlobal("innerHeight", 150);
    const hidden = progressAt(20, false);
    const below = progressAt(500);
    const done = progressAt(20);
    done.value = 1;
    capture.start();
    expect(await capturesInASecond()).toBe(0);
    hidden.checkVisibility = () => true;
    below.remove();
    done.remove();
    capture.handle({ type: "blur" });
    expect(await capturesInASecond()).toBeGreaterThan(10);
  });
});

describe("rules whose values the CSSOM lost", () => {
  it("finds their elements again when the DOM or a control's state changes, not on every capture", async () => {
    vi.spyOn(DocumentCss.prototype, "lost", "get").mockReturnValue([
      { selector: ".lost", properties: ["border-top-width"] },
    ]);
    const query = vi.spyOn(document, "querySelectorAll");
    const queries = () => query.mock.calls.filter(([selector]) => selector === ".lost").length;
    capture.start();
    await settle();
    expect(queries()).toBe(1);
    // A scroll captures again, with the same elements.
    window.dispatchEvent(new Event("scroll"));
    await settle();
    expect(captures).toHaveBeenCalled();
    expect(queries()).toBe(1);
    hit.textContent = "Changed";
    await settle();
    expect(queries()).toBe(2);
    // :checked changes with no attribute.
    hit.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(queries()).toBe(3);
  });
});

it("still captures DOM changes from same-target pointer handlers", async () => {
  capture.start();
  move();
  await settle();
  hit.addEventListener("pointermove", () => {
    hit.textContent = "Changed";
  });
  move();
  await settle();
  expect(frames.at(-1)).toContain("Changed");
});

it("captures unchanged moves when disabled and resets to the default on reconnect", async () => {
  capture.start(false);
  move();
  await settle();
  const count = captures.mock.calls.length;
  move();
  await settle();
  expect(captures).toHaveBeenCalledTimes(count + 1);
  capture.start();
  await settle();
  const reconnected = captures.mock.calls.length;
  move();
  await settle();
  expect(captures).toHaveBeenCalledTimes(reconnected);
});

it("keeps invalidating while a button is held for a drag", async () => {
  capture.start();
  capture.handle({ type: "pointer", kind: "down", x: 5, y: 5 });
  await settle();
  const count = captures.mock.calls.length;
  move();
  await settle();
  expect(captures).toHaveBeenCalledTimes(count + 1);
});

it("updates auto cursors over text within the same element without capturing", async () => {
  document.body.innerHTML = '<p style="cursor:auto">Text</p>';
  hit = document.querySelector("p")!;
  // jsdom has no text hit testing. Supply only the browser geometry APIs;
  // the real input cursor getter and PageCapture reporting stay in use.
  const doc = document as unknown as {
    caretPositionFromPoint?: (x: number) => { offsetNode: Node; offset: number } | null;
  };
  doc.caretPositionFromPoint = (x) => (x >= 10 ? { offsetNode: hit.firstChild!, offset: 0 } : null);
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = createRange();
    range.getClientRects = () => [new DOMRect(10, 0, 20, 20)] as unknown as DOMRectList;
    return range;
  });
  try {
    capture.start();
    move();
    await settle();
    const count = captures.mock.calls.length;
    expect(cursors.at(-1)).toBe("default");
    cursors.length = 0;
    capture.handle({ type: "pointer", kind: "move", x: 15, y: 5 });
    await settle();
    expect(cursors).toEqual(["text"]);
    capture.handle({ type: "pointer", kind: "move", x: 16, y: 5 });
    await settle();
    expect(cursors).toEqual(["text"]);
    move();
    await settle();
    expect(cursors).toEqual(["text", "default"]);
    expect(captures).toHaveBeenCalledTimes(count);
  } finally {
    delete doc.caretPositionFromPoint;
  }
});

describe("interaction states in the live page", () => {
  const press = () => {
    capture.handle({ type: "pointer", kind: "down", x: 5, y: 5 });
    capture.handle({ type: "pointer", kind: "up", x: 5, y: 5 });
  };

  beforeEach(() => {
    document.head.innerHTML =
      "<style>.tools { display: none } .row:hover .tools { display: flex } .row:focus-within .tools { display: grid }</style>";
    document.body.innerHTML = `<div class="row"><span class="tools"><button>Act</button></span></div>`;
    const [row, tools, button] = ["div", ".tools", "button"].map((s) => document.querySelector(s)!);
    // As a browser hit tests: the button only where it is laid out.
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => (getComputedStyle(tools!).display === "none" ? row : button),
    });
  });

  it("shows a button that appears on its row's :hover, so that a press lands on it", async () => {
    const clicked = vi.fn();
    document.querySelector("button")!.addEventListener("click", clicked);
    capture.start();
    move();
    await settle();
    expect(getComputedStyle(document.querySelector(".tools")!).display).toBe("flex");
    // The image shows what the page lays out: the copy carries the mark.
    expect(frames.at(-1)).toMatch(/class="row" data-thp-hover=""/);
    press();
    expect(clicked).toHaveBeenCalledOnce();
    capture.handle({ type: "pointer", kind: "leave", x: 0, y: 0 });
    expect(document.querySelector("[data-thp-hover]")).toBeNull();
    // Pressed, the button has focus: :focus-within keeps it shown, until the host takes the keys back.
    expect(getComputedStyle(document.querySelector(".tools")!).display).toBe("grid");
    capture.handle({ type: "blur" });
    expect(getComputedStyle(document.querySelector(".tools")!).display).toBe("none");
  });

  it("follows the focus the page moves, with :focus-within", async () => {
    capture.start();
    document.querySelector("button")!.focus();
    expect(getComputedStyle(document.querySelector(".tools")!).display).toBe("grid");
    await settle();
    expect(frames.at(-1)).toMatch(/class="row" data-thp-focus-within=""/);
  });

  it("lets the page's click handler see the press ended, and its focus handler the new focus", () => {
    const button = document.querySelector("button")!;
    const seen: string[] = [];
    button.addEventListener("focus", () =>
      seen.push(`focus: ${getComputedStyle(document.querySelector(".tools")!).display}`),
    );
    button.addEventListener("click", () =>
      seen.push(`click: ${button.hasAttribute("data-thp-active")}`),
    );
    capture.start();
    move();
    press();
    expect(seen).toEqual(["focus: grid", "click: false"]);
  });

  it("shows focus as browsers do: not for a pressed button, but after keys", async () => {
    capture.start();
    move();
    press();
    const button = document.querySelector("button")!;
    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute("data-thp-focus-visible")).toBe(false);
    // A shortcut (copy) or a modifier alone does not make it show.
    for (const [key, metaKey] of [
      ["c", true],
      ["Shift", false],
    ] as const) {
      capture.handle({ type: "key", key, shiftKey: false, ctrlKey: false, altKey: false, metaKey });
      // A capture brings the marks up to date.
      await settle();
      expect(button.hasAttribute("data-thp-focus-visible")).toBe(false);
    }
    capture.handle({ type: "blur" });
    capture.handle({
      type: "key",
      key: "Tab",
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    });
    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute("data-thp-focus-visible")).toBe(true);
  });

  it("makes focus show after typed text, as after keys", async () => {
    capture.start();
    move();
    press();
    const button = document.querySelector("button")!;
    capture.handle({ type: "text", text: "a" });
    await settle();
    expect(button.hasAttribute("data-thp-focus-visible")).toBe(true);
  });

  /**
   * Transitions as the browser lists them (jsdom runs none): each starts when
   * `started` says so (a hover rule's, once the mark is on), and is listed by
   * getAnimations({ subtree: true }) on its target and the elements around it.
   */
  /** Where getAnimations was asked (the elements transitions were looked for in). */
  let lookedIn: Element[] = [];

  function fakeTransitions(...specs: { target: Element; started: () => boolean }[]) {
    lookedIn = [];
    const transitions = specs.map(({ target, started }) => ({
      transitionProperty: "transform",
      playState: "running",
      effect: { target },
      started,
      finish: vi.fn(),
    }));
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value(this: Element) {
        lookedIn.push(this);
        return transitions.filter(
          (transition) => transition.started() && this.contains(transition.effect.target),
        );
      },
    });
    return transitions;
  }

  it("ends at once the transitions a hover starts, as the image shows them", () => {
    const row = document.querySelector(".row")!;
    const tools = document.querySelector(".tools")!;
    const before = document.body.appendChild(document.createElement("p"));
    let hitTarget: Element = before;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => hitTarget,
    });
    document.styleSheets[0]!.insertRule(".tools { transition: transform 0.3s }", 0);
    const [byHover, pageOwn] = fakeTransitions(
      { target: tools, started: () => row.hasAttribute("data-thp-hover") },
      // The page's own, running already (an accordion opening, say).
      { target: tools, started: () => true },
    );
    try {
      capture.start();
      move();
      hitTarget = row;
      move();
      expect(byHover!.finish).toHaveBeenCalled();
      // Pressed and released (every ancestor, <html> too, is :active meanwhile).
      press();
      expect(pageOwn!.finish).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });

  it("does not look for transitions in a page that has none", () => {
    const lookups = vi.fn(() => []);
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: lookups,
    });
    try {
      capture.start();
      move();
      press();
      expect(lookups).not.toHaveBeenCalled();
      // One in an inline style counts.
      document.querySelector(".row")!.setAttribute("style", "transition: opacity 0.2s");
      capture.handle({ type: "pointer", kind: "leave", x: 0, y: 0 });
      expect(lookups).toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });

  it("ends a transition the hover starts on a sibling, outside the row", () => {
    const row = document.querySelector(".row")!;
    const sibling = document.body.appendChild(document.createElement("aside"));
    const style = document.createElement("style");
    style.textContent =
      "aside { transition: transform 0.3s } .row:hover + aside { transform: none }";
    document.head.append(style);
    const [onSibling] = fakeTransitions({
      target: sibling,
      started: () => row.hasAttribute("data-thp-hover"),
    });
    const before = document.body.appendChild(document.createElement("p"));
    let hitTarget: Element = before;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => hitTarget,
    });
    try {
      capture.start();
      move();
      lookedIn = [];
      // From another element onto the row (entering the page changes <html> too).
      hitTarget = row;
      move();
      expect(onSibling!.finish).toHaveBeenCalled();
      // Around the row (its parent), not the whole page.
      expect(lookedIn).not.toContain(document.documentElement);
    } finally {
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });

  it("looks for transitions everywhere when a hover rule uses :has()", () => {
    const row = document.querySelector(".row")!;
    const style = document.createElement("style");
    style.textContent =
      "aside { transition: transform 0.3s } body:has(.row:hover) aside { transform: none }";
    document.head.append(style);
    fakeTransitions({ target: row, started: () => false });
    try {
      capture.start();
      move();
      expect(lookedIn).toContain(document.documentElement);
    } finally {
      delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });

  it("does not check the page for transitions on captures where no mark changes", async () => {
    // Each change forgets what was found, so a check would query the page again,
    // for elements whose style mentions a transition, however it asks.
    const queries = [
      vi.spyOn(document, "querySelector"),
      vi.spyOn(document, "querySelectorAll"),
    ] as const;
    capture.start();
    await settle();
    for (const query of queries) query.mockClear();
    for (let i = 0; i < 3; i++) {
      document.body.append(document.createElement("span"));
      await settle();
    }
    const selectors = queries.flatMap((query) => query.mock.calls.map(([selector]) => selector));
    expect(selectors.filter((selector) => selector.includes("transition"))).toEqual([]);
  });

  it("follows the page moving the focused element elsewhere, on the next capture", async () => {
    capture.start();
    const button = document.querySelector("button")!;
    button.focus();
    const other = document.createElement("div");
    document.body.append(other);
    other.append(button);
    await settle();
    expect(other.hasAttribute("data-thp-focus-within")).toBe(true);
    expect(document.querySelector(".row")!.hasAttribute("data-thp-focus-within")).toBe(false);
  });

  it("captures a change the page makes through the CSSOM only", async () => {
    capture.start();
    await settle();
    const count = captures.mock.calls.length;
    document.styleSheets[0]!.insertRule(".row { color: red }", 0);
    await settle();
    expect(captures).toHaveBeenCalledTimes(count + 1);
    expect(frames.at(-1)).toContain(".row{color: red;}");
  });

  it("rewrites a <style> the page adds in the same task as it inserts a rule elsewhere", async () => {
    capture.start();
    move();
    await settle();
    const later = document.createElement("span");
    later.className = "later";
    document.querySelector(".row")!.append(later);
    const style = document.createElement("style");
    style.textContent = ".later { display: none } .row:hover .later { display: inline }";
    document.head.append(style);
    // Before the MutationObserver has said anything about the <style>.
    document.styleSheets[0]!.insertRule(".x { color: red }", 0);
    await settle();
    // (jsdom matches :hover by itself here: the rule is checked, not the layout.)
    expect((style.sheet!.cssRules[1] as CSSStyleRule).selectorText).toBe(
      ".row:is(:hover,[data-thp-hover]) .later",
    );
  });

  it("does not look at all the rules again after rules inserted through the CSSOM", async () => {
    const walks = vi.spyOn(
      LiveInteractionCss.prototype as unknown as { syncSheet: () => void },
      "syncSheet",
    );
    capture.start();
    move();
    await settle();
    walks.mockClear();
    // Several in a row, as CSS-in-JS does while rendering, then input and a capture.
    for (let i = 0; i < 3; i++) document.styleSheets[0]!.insertRule(`.x${i} { color: red }`, 0);
    move();
    await settle();
    expect(walks).not.toHaveBeenCalled();
  });

  it("does not count its marks as changes of the page", async () => {
    capture.start();
    await settle();
    const count = captures.mock.calls.length;
    document.querySelector("button")!.setAttribute("data-thp-hover", "");
    await settle();
    expect(captures).toHaveBeenCalledTimes(count);
  });
});
