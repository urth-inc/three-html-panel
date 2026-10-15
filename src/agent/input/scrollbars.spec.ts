import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { InputSynthesizer } from "./input";
import { scrollbarAt, scrollbarsOf } from "./scrollbars";

/**
 * A scroll container laid out at (10, 20), 200×100, with 400px of content.
 * jsdom has no layout, so the sizes are set by hand.
 */
function scroller(
  options: { overflow?: string; offsetWidth?: number; scrollHeight?: number } = {},
) {
  // jsdom does not expand the overflow shorthand in computed styles.
  const overflow = options.overflow ?? "auto";
  document.body.innerHTML = `<div id="box" style="overflow-x: ${overflow}; overflow-y: ${overflow}"><p>content</p></div>`;
  const box = document.querySelector<HTMLDivElement>("#box")!;
  let scrollTop = 0;
  const sizes = {
    clientWidth: 200,
    clientHeight: 100,
    scrollWidth: 200,
    scrollHeight: options.scrollHeight ?? 400,
    offsetWidth: options.offsetWidth ?? 200,
    offsetHeight: 100,
  };
  for (const [name, value] of Object.entries(sizes)) Object.defineProperty(box, name, { value });
  Object.defineProperty(box, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) =>
      (scrollTop = Math.max(0, Math.min(value, sizes.scrollHeight - sizes.clientHeight))),
  });
  // As the agent scrolls: with options, at once (see scrollByUser in input.ts).
  const scrolls: ScrollToOptions[] = [];
  box.scrollBy = ((options: ScrollToOptions) => {
    scrolls.push(options);
    box.scrollTop += options.top ?? 0;
  }) as typeof box.scrollBy;
  box.scrollTo = ((options: ScrollToOptions) => {
    scrolls.push(options);
    if (options.top !== undefined) box.scrollTop = options.top;
  }) as typeof box.scrollTo;
  Object.assign(box, { scrolls });
  box.getBoundingClientRect = () => new DOMRect(10, 20, sizes.offsetWidth, 100);
  document.elementFromPoint = () => box.querySelector("p");
  return box;
}

describe("scrollbarsOf", () => {
  it("places an overlay scrollbar inside the box, with the thumb where the scroll is", () => {
    const box = scroller();
    box.scrollTop = 150;
    const [bar] = scrollbarsOf(box);
    expect(bar).toMatchObject({
      axis: "y",
      gutter: false,
      track: { left: 200, top: 20, width: 10, height: 100 },
    });
    // 100 of 400 visible: a quarter of the track; halfway through the scroll range.
    expect(bar!.thumb).toMatchObject({
      left: 200,
      top: 20 + (100 - 25) * 0.5,
      width: 10,
      height: 25,
    });
  });

  it("places a classic scrollbar in the room the browser reserves", () => {
    const [bar] = scrollbarsOf(scroller({ offsetWidth: 215 }));
    expect(bar).toMatchObject({ gutter: true, track: { left: 210, width: 15 } });
  });

  it("shows none when the box does not scroll", () => {
    expect(scrollbarsOf(scroller({ overflow: "hidden" }))).toEqual([]);
    expect(scrollbarsOf(scroller({ scrollHeight: 100 }))).toEqual([]);
  });

  it("finds the scrollbar under a point", () => {
    const box = scroller();
    expect(scrollbarAt(document, 205, 30)?.element).toBe(box);
    expect(scrollbarAt(document, 150, 30)).toBeNull();
  });
});

describe("pressing a scrollbar", () => {
  let input: InputSynthesizer;
  let box: HTMLDivElement;
  const pointer = (kind: "down" | "move" | "up", x: number, y: number) =>
    input.handle({ type: "pointer", kind, x, y });

  beforeEach(() => {
    input ??= new InputSynthesizer(document, { measure: (run) => run(), onChange: () => {} });
    box = scroller();
  });

  it("drags the thumb across the scroll range", () => {
    // The thumb is 25px of a 100px track: 75px of travel for 300px of scroll.
    pointer("down", 205, 30);
    pointer("move", 205, 45);
    expect(box.scrollTop).toBe(60);
    pointer("move", 205, 500);
    expect(box.scrollTop).toBe(300);
    pointer("up", 205, 500);
  });

  it("pages toward a press on the track, and does not drag from there", () => {
    pointer("down", 205, 110);
    pointer("move", 205, 50);
    pointer("up", 205, 50);
    expect(box.scrollTop).toBe(87.5);
  });

  it("scrolls at once, whatever the page's scroll-behavior (a user's scroll is never smooth)", () => {
    box.style.scrollBehavior = "smooth";
    const scrolls = (box as unknown as { scrolls: ScrollToOptions[] }).scrolls;
    // (Wheels go the same way; jsdom cannot make the agent's WheelEvent.)
    pointer("down", 205, 110);
    pointer("up", 205, 110);
    pointer("down", 205, 40);
    pointer("move", 205, 50);
    pointer("up", 205, 50);
    expect(scrolls.length).toBeGreaterThanOrEqual(2);
    expect(scrolls.every((scroll) => scroll.behavior === "instant")).toBe(true);
  });

  it("does not pass the press on to the page", () => {
    const onPress = vi.fn();
    for (const type of ["pointerdown", "mousedown", "pointerup", "click"])
      document.addEventListener(type, onPress);
    pointer("down", 205, 30);
    pointer("up", 205, 30);
    pointer("down", 205, 110);
    pointer("up", 205, 110);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe("list boxes", () => {
  function select(html: string) {
    document.body.innerHTML = html;
    const element = document.querySelector("select")!;
    const sizes = {
      clientWidth: 80,
      clientHeight: 60,
      scrollWidth: 80,
      scrollHeight: 120,
      offsetWidth: 82,
      offsetHeight: 62,
    };
    for (const [name, value] of Object.entries(sizes))
      Object.defineProperty(element, name, { value });
    element.getBoundingClientRect = () => new DOMRect(10, 20, 82, 62);
    return element;
  }

  it("draws a list box's scrollbar, whatever its computed overflow", () => {
    const listBox = select(`<select multiple><option>a</option></select>`);
    expect(scrollbarsOf(listBox).map((bar) => bar.axis)).toEqual(["y"]);
    const sized = select(`<select size="3"><option>a</option></select>`);
    expect(scrollbarsOf(sized)).toHaveLength(1);
  });

  it("leaves a drop-down <select> alone: it draws its own list", () => {
    expect(scrollbarsOf(select(`<select><option>a</option></select>`))).toEqual([]);
  });
});
