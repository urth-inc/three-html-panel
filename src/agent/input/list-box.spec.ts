import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { eventsWithoutView } from "../../test-helpers";
import { InputSynthesizer } from "./input";
import { isUsable, optionAt, selectRange, stepOption } from "./list-box";
import { keyInput, pressFarAway, type Modifiers } from "./test-input";

let select: HTMLSelectElement;
let changes: number;

/** jsdom has no layout: the options are 20 px rows from y = 100. */
function layOut() {
  Array.from(select.options).forEach((option, index) => {
    option.getBoundingClientRect = () => new DOMRect(10, 100 + index * 20, 100, 20);
  });
  select.getBoundingClientRect = () => new DOMRect(10, 100, 100, 60);
}

beforeEach(() => {
  document.body.innerHTML = `
    <select id="tags" multiple size="3">
      <option>a</option><option>b</option><option disabled>c</option><option>d</option><option>e</option>
    </select>`;
  select = document.querySelector("#tags")!;
  layOut();
  changes = 0;
  select.addEventListener("change", () => changes++);
});

const chosen = () => Array.from(select.selectedOptions, (option) => option.text).join("");

describe("helpers", () => {
  it("finds the option at a height, and the nearest past the ends when dragging", () => {
    expect(optionAt(select, 125)).toBe(1);
    expect(optionAt(select, 90)).toBeNull();
    expect(optionAt(select, 90, true)).toBe(0);
    expect(optionAt(select, 500, true)).toBe(4);
  });

  it("selects a range, leaving out disabled options", () => {
    selectRange(select, 3, 0);
    expect(chosen()).toBe("abd");
    selectRange(select, 4, 4, true);
    expect(chosen()).toBe("abde");
    selectRange(select, 4, 4);
    expect(chosen()).toBe("e");
  });

  it("steps over disabled options", () => {
    const step = (from: number, steps: number) =>
      stepOption(select.options.length, from, steps, (index) => isUsable(select.options[index]!));
    expect(step(1, 1)).toBe(3);
    expect(step(3, -1)).toBe(1);
    expect(step(0, -5)).toBe(0);
    expect(step(0, 100)).toBe(4);
    expect(step(0, Infinity)).toBe(4);
  });
});

describe("choosing options in the panel", () => {
  let input: InputSynthesizer;
  let target: Element;

  beforeAll(() => {
    eventsWithoutView();
    input = new InputSynthesizer(document, { measure: (run) => run(), onChange: () => {} });
  });
  beforeEach(() => {
    target = select;
    document.elementFromPoint = () => target;
  });
  afterEach(() => {
    pressFarAway(input);
    input.handle({ type: "blur" });
  });

  const press = (y: number, modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}) => {
    input.handle({ type: "pointer", kind: "down", x: 50, y, ...modifiers });
    input.handle({ type: "pointer", kind: "up", x: 50, y, ...modifiers });
  };
  const key = (key: string, modifiers?: Modifiers) =>
    input.handle({ type: "key", ...keyInput(key, modifiers) });

  it("selects only the option pressed, and tells the page once", () => {
    press(105);
    expect(input.focused).toBe(select);
    expect(chosen()).toBe("a");
    press(165);
    expect(chosen()).toBe("d");
    expect(changes).toBe(2);
    // The same again: nothing changed, no change event.
    press(165);
    expect(changes).toBe(2);
  });

  it("adds and removes options with Ctrl, and selects a range with Shift", () => {
    press(105);
    press(165, { ctrlKey: true });
    expect(chosen()).toBe("ad");
    press(165, { ctrlKey: true });
    expect(chosen()).toBe("a");
    // Shift extends from the option pressed last (a Ctrl press counts, as in browsers).
    press(185, { shiftKey: true });
    expect(chosen()).toBe("de");
    press(105);
    press(185, { shiftKey: true });
    expect(chosen()).toBe("abde");
  });

  it("selects the options a drag goes over, with one change at the release", () => {
    input.handle({ type: "pointer", kind: "down", x: 50, y: 105 });
    input.handle({ type: "pointer", kind: "move", x: 50, y: 145 });
    input.handle({ type: "pointer", kind: "move", x: 50, y: 170 });
    expect(changes).toBe(0);
    input.handle({ type: "pointer", kind: "up", x: 50, y: 170 });
    expect(chosen()).toBe("abd");
    expect(changes).toBe(1);
  });

  it("ignores a press on a disabled option, or where the page cancels mousedown", () => {
    press(145);
    expect(chosen()).toBe("");
    select.addEventListener("mousedown", (event) => event.preventDefault());
    press(105);
    expect(chosen()).toBe("");
  });

  it("moves the selection with the arrows (Shift extends it), and selects all with Ctrl+A", () => {
    press(105);
    key("ArrowDown");
    expect(chosen()).toBe("b");
    key("ArrowDown", { shiftKey: true });
    expect(chosen()).toBe("bd");
    key("End");
    expect(chosen()).toBe("e");
    key("a", { ctrlKey: true });
    expect(chosen()).toBe("abde");
    expect(changes).toBe(5);
  });

  it("leaves the selection to keys that do not move in the list, whatever their name", () => {
    press(105);
    press(165, { ctrlKey: true });
    expect(chosen()).toBe("ad");
    // Names an object has from its prototype are not keys of the list.
    for (const name of ["toString", "constructor", "valueOf"]) key(name);
    expect(chosen()).toBe("ad");
  });

  it("selects a single list box's option, and lets typing pick one", () => {
    select.multiple = false;
    press(125);
    expect(select.value).toBe("b");
    press(165, { ctrlKey: true });
    expect(select.value).toBe("d");
    input.handle({ type: "text", text: "e" });
    expect(select.value).toBe("e");
  });

  it("adds options with Cmd on macOS, where Ctrl does not", () => {
    const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    try {
      press(105);
      press(165, { ctrlKey: true });
      expect(chosen()).toBe("d");
      input.handle({ type: "pointer", kind: "down", x: 50, y: 105, metaKey: true });
      input.handle({ type: "pointer", kind: "up", x: 50, y: 105, metaKey: true });
      expect(chosen()).toBe("ad");
    } finally {
      platform.mockRestore();
    }
  });
});
