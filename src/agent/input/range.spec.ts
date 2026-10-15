import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { eventsWithoutView } from "../../test-helpers";
import { InputSynthesizer } from "./input";
import { boundsOf, isRange, snap, valueAfterKey, valueAt } from "./range";
import { keyInput, pressFarAway } from "./test-input";

let slider: HTMLInputElement;
let events: string[];

/** jsdom has no layout: the slider is 216 px wide at x = 100, so its thumb's middle goes from 108 to 308. */
function layOut() {
  slider.getBoundingClientRect = () => new DOMRect(100, 50, 216, 20);
}

beforeEach(() => {
  document.body.innerHTML = `<input id="seats" type="range" min="0" max="50" value="5" />`;
  slider = document.querySelector("#seats")!;
  layOut();
  events = [];
  for (const type of ["input", "change"])
    slider.addEventListener(type, () => events.push(`${type} ${slider.value}`));
});

describe("helpers", () => {
  it("is a slider only when it can be used", () => {
    expect(isRange(slider)).toBe(true);
    slider.disabled = true;
    expect(isRange(slider)).toBe(false);
    expect(isRange(document.body)).toBe(false);
  });

  it("reads the bounds with the defaults browsers use", () => {
    slider.removeAttribute("min");
    slider.removeAttribute("max");
    expect(boundsOf(slider)).toEqual({ min: 0, max: 100, step: 1 });
    slider.min = "10";
    slider.max = "5";
    slider.step = "-2";
    // A maximum below the minimum is the minimum; a step that is not positive is the default.
    expect(boundsOf(slider)).toEqual({ min: 10, max: 10, step: 1 });
    slider.step = "any";
    expect(boundsOf(slider).step).toBe(0);
  });

  it("snaps to a step from the minimum, within the range", () => {
    const bounds = { min: 1, max: 50, step: 5 };
    expect(snap(13, bounds)).toBe(11);
    // The last step at most, not the maximum itself.
    expect(snap(49, bounds)).toBe(46);
    expect(snap(-3, bounds)).toBe(1);
    // Tenths stay tenths (0.1 * 3 is 0.30000000000000004).
    expect(snap(0.31, { min: 0, max: 1, step: 0.1 })).toBe(0.3);
    expect(snap(0.317, { min: 0, max: 1, step: 0 })).toBe(0.317);
    // Small steps are written with an exponent (1e-7): still steps, not whole numbers.
    expect(snap(0.00000034, { min: 0, max: 1, step: 1e-7 })).toBe(3e-7);
    expect(snap(0.000000253, { min: 0, max: 1, step: 1.5e-8 })).toBe(2.55e-7);
  });

  it("finds the value at a point: the ends half a thumb in, right to left too", () => {
    expect(valueAt(slider, 108, 60)).toBe(0);
    expect(valueAt(slider, 208, 60)).toBe(25);
    expect(valueAt(slider, 308, 60)).toBe(50);
    expect(valueAt(slider, 0, 60)).toBe(0);
    expect(valueAt(slider, 900, 60)).toBe(50);
    slider.style.direction = "rtl";
    expect(valueAt(slider, 158, 60)).toBe(38);
  });

  it("steps with the keys: arrows by a step, Page Up/Down by a tenth, Home and End to the ends", () => {
    expect(valueAfterKey(slider, "ArrowRight")).toBe(6);
    expect(valueAfterKey(slider, "ArrowUp")).toBe(6);
    expect(valueAfterKey(slider, "ArrowLeft")).toBe(4);
    expect(valueAfterKey(slider, "PageUp")).toBe(10);
    expect(valueAfterKey(slider, "PageDown")).toBe(0);
    expect(valueAfterKey(slider, "Home")).toBe(0);
    expect(valueAfterKey(slider, "End")).toBe(50);
    expect(valueAfterKey(slider, "a")).toBeNull();
    // Right to left, the left arrow goes up.
    slider.style.direction = "rtl";
    expect(valueAfterKey(slider, "ArrowLeft")).toBe(6);
    // A tenth smaller than the step goes a whole step.
    slider.step = "20";
    slider.value = "20";
    expect(valueAfterKey(slider, "PageUp")).toBe(40);
  });
});

describe("moving a slider in the panel", () => {
  let input: InputSynthesizer;

  beforeAll(() => {
    eventsWithoutView();
    input = new InputSynthesizer(document, { measure: (run) => run(), onChange: () => {} });
  });
  beforeEach(() => {
    document.elementFromPoint = () => slider;
  });
  afterEach(() => {
    pressFarAway(input);
    input.handle({ type: "blur" });
  });

  const pointer = (kind: "down" | "move" | "up", x: number, input_: "mouse" | "touch" = "mouse") =>
    input.handle({ type: "pointer", kind, x, y: 60, input: input_ });
  const key = (name: string) => input.handle({ type: "key", ...keyInput(name) });

  it("sets the value where it is pressed, and commits it on release", () => {
    pointer("down", 208);
    expect(input.focused).toBe(slider);
    expect(events).toEqual(["input 25"]);
    pointer("up", 208);
    expect(events).toEqual(["input 25", "change 25"]);
  });

  it("follows a drag, even past the slider, with one change at the release", () => {
    pointer("down", 108);
    pointer("move", 168);
    pointer("move", 900);
    pointer("up", 900);
    expect(slider.value).toBe("50");
    expect(events).toEqual(["input 0", "input 15", "input 50", "change 50"]);
  });

  it("sends no change when the value ends where it was", () => {
    pointer("down", 128);
    pointer("move", 300);
    pointer("move", 128);
    pointer("up", 128);
    expect(events).toEqual(["input 48", "input 5"]);
  });

  it("moves with a finger or controller drag rather than scrolling", () => {
    // In a box that scrolls (jsdom lays out nothing): elsewhere in it, the drag would scroll it.
    const box = document.createElement("div");
    box.style.overflowX = "auto";
    box.style.overflowY = "auto";
    for (const [name, value] of Object.entries({ clientHeight: 100, scrollHeight: 400 }))
      Object.defineProperty(box, name, { value });
    box.scrollBy = () => {};
    document.body.append(box);
    box.append(slider);
    pointer("down", 108, "touch");
    pointer("move", 208, "touch");
    pointer("up", 208, "touch");
    expect(events).toEqual(["input 0", "input 25", "change 25"]);
  });

  it("leaves the slider alone where the page cancels mousedown", () => {
    slider.addEventListener("mousedown", (event) => event.preventDefault());
    pointer("down", 208);
    pointer("move", 300);
    pointer("up", 300);
    expect(slider.value).toBe("5");
    expect(events).toEqual([]);
  });

  it("leaves the press to a browser that moved the thumb itself (WebKit), then follows the drag", () => {
    // As WebKit does for a synthetic mousedown: the thumb jumps there, with input.
    slider.addEventListener("mousedown", () => {
      slider.value = "24";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    pointer("down", 208);
    expect(events).toEqual(["input 24"]);
    pointer("move", 308);
    pointer("up", 308);
    expect(events).toEqual(["input 24", "input 50", "change 50"]);
  });

  it("sends no change of its own after the browser's (Firefox sends one on a synthetic mouseup)", () => {
    slider.addEventListener("mouseup", () => slider.dispatchEvent(new Event("change")));
    pointer("down", 208);
    pointer("up", 208);
    expect(events).toEqual(["input 25", "change 25"]);
  });

  it("lets go of a slider press that never got its release when the next press comes", () => {
    pointer("down", 208);
    // No release: the next press is on something else, and drags.
    const other = document.createElement("p");
    document.body.append(other);
    document.elementFromPoint = () => other;
    pointer("down", 108);
    pointer("move", 300);
    pointer("up", 300);
    expect(slider.value).toBe("25");
    expect(events).toEqual(["input 25"]);
  });

  it("steps with the keys once focused, each a committed change", () => {
    pointer("down", 108);
    pointer("up", 108);
    events = [];
    key("ArrowRight");
    key("End");
    key("End");
    expect(events).toEqual(["input 1", "change 1", "input 50", "change 50"]);
  });
});
