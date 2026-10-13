// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { InputSynthesizer } from "./input";
import { panAxes } from "./pan";

describe("panAxes", () => {
  it("allows both directions unless touch-action limits them", () => {
    expect(panAxes(["auto", "auto"])).toEqual({ x: true, y: true });
    expect(panAxes(["manipulation"])).toEqual({ x: true, y: true });
    expect(panAxes(["pan-y"])).toEqual({ x: false, y: true });
    expect(panAxes(["auto", "pan-x pan-up"])).toEqual({ x: true, y: true });
    expect(panAxes(["pan-x", "pan-y"])).toEqual({ x: false, y: false });
    expect(panAxes(["auto", "none"])).toEqual({ x: false, y: false });
  });
});

// jsdom rejects the `view` the agent passes (Vitest's window is not jsdom's
// Window); events are made here without it.
beforeAll(() => {
  type EventClass = new (type: string, init?: EventInit) => Event;
  const withoutView = (Base: EventClass) =>
    class extends Base {
      constructor(type: string, init: EventInit & { view?: unknown } = {}) {
        const { view: _view, ...rest } = init;
        super(type, rest);
      }
    };
  globalThis.MouseEvent = withoutView(MouseEvent as EventClass) as unknown as typeof MouseEvent;
  globalThis.PointerEvent = withoutView(
    (globalThis.PointerEvent ?? MouseEvent) as EventClass,
  ) as unknown as typeof PointerEvent;
});

describe("dragging to scroll", () => {
  let input: InputSynthesizer;
  let box: HTMLDivElement;
  let events: string[];

  beforeEach(() => {
    input ??= new InputSynthesizer(document, { measure: (run) => run(), onChange: () => {} });
    document.body.innerHTML = `<div id="box" style="overflow-x: auto; overflow-y: auto"><p id="text">text</p></div>`;
    box = document.querySelector("#box")!;
    let scrollTop = 0;
    for (const [name, value] of Object.entries({
      clientWidth: 200,
      clientHeight: 100,
      scrollWidth: 200,
      scrollHeight: 400,
    })) {
      Object.defineProperty(box, name, { value });
    }
    Object.defineProperty(box, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => (scrollTop = value),
    });
    box.scrollBy = ((options: ScrollToOptions) => {
      expect(options.behavior).toBe("instant");
      scrollTop += options.top ?? 0;
    }) as typeof box.scrollBy;
    const text = document.querySelector("#text")!;
    document.elementFromPoint = () => text;
    events = [];
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "click"]) {
      document.addEventListener(type, (event) => events.push(event.type));
    }
  });

  afterEach(() => input.handle({ type: "pointer", kind: "leave", x: 0, y: 0 }));

  const pointer = (
    kind: "down" | "move" | "up",
    y: number,
    which: "mouse" | "touch" | "xr" = "touch",
  ) => input.handle({ type: "pointer", kind, x: 50, y, input: which });

  it("scrolls with a finger once it moves past the slop, cancelling the pointer for the page", () => {
    pointer("down", 60);
    pointer("move", 55);
    expect(box.scrollTop).toBe(0);
    // From where it left the 8 px slop, not by it at once.
    pointer("move", 40);
    expect(box.scrollTop).toBe(12);
    pointer("move", 30);
    expect(box.scrollTop).toBe(22);
    pointer("up", 30);
    // The page saw the drag start, then a cancel; no up, no click.
    expect(events.filter((type) => type !== "pointermove")).toEqual([
      "pointerdown",
      "pointercancel",
    ]);
  });

  it("waits for the host's slop, where it is more than its own (a panel drawn small)", () => {
    input.handle({ type: "pointer", kind: "down", x: 50, y: 60, input: "touch", slop: 30 });
    pointer("move", 40);
    expect(box.scrollTop).toBe(0);
    pointer("up", 40);
    // (Each test's listeners stay on the document: each event is there as often.)
    expect(events).toContain("click");
    expect(events).not.toContain("pointercancel");
    // Past it, it scrolls; and the next press has the page's own slop again.
    events.length = 0;
    input.handle({ type: "pointer", kind: "down", x: 50, y: 60, input: "touch", slop: 30 });
    pointer("move", 20);
    expect(box.scrollTop).toBe(10);
    pointer("up", 20);
    box.scrollTop = 0;
    pointer("down", 60);
    pointer("move", 40);
    expect(box.scrollTop).toBe(12);
    pointer("up", 40);
  });

  it("scrolls with a VR controller too, but not with a mouse", () => {
    pointer("down", 60, "xr");
    pointer("move", 30, "xr");
    expect(box.scrollTop).toBe(22);
    pointer("up", 30, "xr");
    box.scrollTop = 0;
    pointer("down", 60, "mouse");
    pointer("move", 30, "mouse");
    pointer("up", 30, "mouse");
    expect(box.scrollTop).toBe(0);
  });

  it("leaves the drag to the page where touch-action forbids it, it cancels the press, or captures the pointer", () => {
    document.querySelector<HTMLElement>("#text")!.style.touchAction = "none";
    pointer("down", 60);
    pointer("move", 30);
    pointer("up", 30);
    expect(box.scrollTop).toBe(0);
    expect(events).toContain("pointerup");

    document.querySelector<HTMLElement>("#text")!.style.touchAction = "";
    const cancel = (event: Event) => event.preventDefault();
    document.addEventListener("pointerdown", cancel);
    pointer("down", 60);
    pointer("move", 30);
    pointer("up", 30);
    document.removeEventListener("pointerdown", cancel);
    expect(box.scrollTop).toBe(0);

    pointer("down", 60);
    document.querySelector("#text")!.setPointerCapture(1);
    pointer("move", 30);
    pointer("up", 30);
    expect(box.scrollTop).toBe(0);
  });

  describe("mouse events, as browsers send them for a touch", () => {
    let log: string[];
    let button: HTMLButtonElement;
    const record = (event: Event) => log.push(event.type);
    const TYPES = [
      "pointerdown",
      "pointerup",
      "pointercancel",
      "mousedown",
      "mousemove",
      "mouseup",
      "click",
    ];

    beforeEach(() => {
      box.innerHTML = `<button id="go">Go</button>`;
      button = box.querySelector("#go")!;
      document.elementFromPoint = () => button;
      log = [];
      for (const type of TYPES) document.addEventListener(type, record);
    });
    afterEach(() => {
      for (const type of TYPES) document.removeEventListener(type, record);
    });

    it("gives a drag that scrolls no mouse events, and focuses nothing", () => {
      pointer("down", 60);
      expect(input.focused).not.toBe(button);
      pointer("move", 30);
      pointer("up", 30);
      expect(box.scrollTop).toBe(22);
      expect(log).toEqual(["pointerdown", "pointercancel"]);
      expect(input.focused).not.toBe(button);
    });

    it("gives a tap its mouse events after the release, and focuses then", () => {
      pointer("down", 60);
      // Within the slop: still a tap.
      pointer("move", 59);
      expect(log).toEqual(["pointerdown"]);
      expect(input.focused).not.toBe(button);
      pointer("up", 59);
      expect(log).toEqual(["pointerdown", "pointerup", "mousedown", "mouseup", "click"]);
      expect(input.focused).toBe(button);
    });

    it("takes a press that moved less than it takes to scroll for a tap", () => {
      // 7px both ways: over the click slop, short of scrolling.
      pointer("down", 60);
      input.handle({ type: "pointer", kind: "move", x: 57, y: 53, input: "touch" });
      input.handle({ type: "pointer", kind: "up", x: 57, y: 53, input: "touch" });
      expect(box.scrollTop).toBe(0);
      expect(log).toEqual(["pointerdown", "pointerup", "mousedown", "mouseup", "click"]);
      expect(input.focused).toBe(button);
    });

    it("tells the page a mouse hovering after a finger is a mouse", () => {
      pointer("down", 60);
      pointer("up", 60);
      const types: string[] = [];
      const record = (event: Event) => types.push((event as PointerEvent).pointerType);
      document.addEventListener("pointermove", record);
      pointer("move", 70, "mouse");
      document.removeEventListener("pointermove", record);
      expect(types).toEqual(["mouse"]);
    });

    it("gives a drag the page captured no mouse events", () => {
      pointer("down", 60);
      button.setPointerCapture(1);
      pointer("move", 30);
      pointer("up", 30);
      expect(log).toEqual(["pointerdown", "pointerup"]);
    });

    it("takes two taps as far apart as the host's slop for a double click", () => {
      const doubles: Event[] = [];
      const record = (event: Event) => doubles.push(event);
      document.addEventListener("dblclick", record);
      const tap = (y: number) => {
        input.handle({ type: "pointer", kind: "down", x: 50, y, input: "touch", slop: 20 });
        input.handle({ type: "pointer", kind: "up", x: 50, y, input: "touch", slop: 20 });
      };
      tap(60);
      tap(45);
      document.removeEventListener("dblclick", record);
      expect(doubles).toHaveLength(1);
    });

    it("gives the page every move where the drag is its own, and a tap within the host's slop a click", () => {
      button.style.touchAction = "none";
      input.handle({ type: "pointer", kind: "down", x: 50, y: 60, input: "touch", slop: 20 });
      pointer("move", 58);
      pointer("up", 48);
      expect(log).toEqual([
        "pointerdown",
        "mousedown",
        "mousemove",
        "pointerup",
        "mouseup",
        "click",
      ]);
    });

    it("sends mousedown at once where the drag is the page's (touch-action: none), with its mouseup", () => {
      button.style.touchAction = "none";
      pointer("down", 60);
      expect(log).toEqual(["pointerdown", "mousedown"]);
      expect(input.focused).toBe(button);
      pointer("move", 30);
      pointer("up", 30);
      expect(log).toEqual(["pointerdown", "mousedown", "mousemove", "pointerup", "mouseup"]);
    });
  });
});
