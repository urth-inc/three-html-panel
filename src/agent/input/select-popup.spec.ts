import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { InputSynthesizer } from "./input";
import { SelectPopup } from "./select-popup";
import { eventsWithoutView } from "../../test-helpers";
import { keyInput, wheelWithoutView } from "./test-input";

beforeAll(() => {
  eventsWithoutView();
  wheelWithoutView();
  // A 800x600 viewport.
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    configurable: true,
    value: 600,
  });
});

let select: HTMLSelectElement;
let events: string[];

beforeEach(() => {
  document.body.innerHTML = `
    <p id="text">text</p>
    <select id="pick">
      <optgroup label="Fruit">
        <option>Apple</option>
        <option>Banana</option>
      </optgroup>
      <option disabled>Cherry</option>
      <option>Date</option>
      <option hidden>Elder</option>
    </select>`;
  select = document.querySelector("#pick")!;
  // The select is 200x24 at (100, 100); its list opens below it.
  select.getBoundingClientRect = () => new DOMRect(100, 100, 200, 24);
  select.style.fontSize = "16px";
  events = [];
  select.addEventListener("input", () => events.push("input"));
  select.addEventListener("change", () => events.push("change"));
});

describe("SelectPopup", () => {
  it("lists the options under their group labels, without hidden ones", () => {
    const popup = new SelectPopup(select);
    expect(
      popup.items.map((item) => [item.label, item.index, item.disabled, item.grouped]),
    ).toEqual([
      ["Fruit", -1, true, false],
      ["Apple", 0, false, true],
      ["Banana", 1, false, true],
      ["Cherry", 2, true, false],
      ["Date", 3, false, false],
    ]);
  });

  it("opens below the select, at least as wide, with the selected option highlighted", () => {
    select.selectedIndex = 1;
    const popup = new SelectPopup(select);
    expect(popup.box.left).toBe(100);
    expect(popup.box.top).toBe(124);
    expect(popup.box.width).toBeGreaterThanOrEqual(200);
    expect(popup.box.height).toBe(5 * popup.itemHeight + 2);
    expect(popup.items[popup.highlighted]!.label).toBe("Banana");
  });

  it("opens above the select when there is no room below", () => {
    select.getBoundingClientRect = () => new DOMRect(100, 560, 200, 24);
    const popup = new SelectPopup(select);
    expect(popup.box.top + popup.box.height).toBe(560);
  });

  it("steps over group labels and disabled options", () => {
    const popup = new SelectPopup(select);
    expect(popup.items[popup.highlighted]!.label).toBe("Apple");
    popup.step(1);
    popup.step(1);
    expect(popup.items[popup.highlighted]!.label).toBe("Date");
    popup.step(1);
    expect(popup.items[popup.highlighted]!.label).toBe("Date");
    popup.step(-10);
    expect(popup.items[popup.highlighted]!.label).toBe("Apple");
  });

  it("finds the item at a point, and only options can be chosen", () => {
    const popup = new SelectPopup(select);
    const rowY = (row: number) => popup.box.top + 1 + row * popup.itemHeight + 2;
    expect(popup.itemAt(150, rowY(0))).toBe(0);
    expect(popup.choosable(popup.itemAt(150, rowY(0)))).toBe(false);
    expect(popup.itemAt(150, rowY(2))).toBe(2);
    expect(popup.choosable(2)).toBe(true);
    expect(popup.choosable(3)).toBe(false);
    expect(popup.itemAt(50, rowY(2))).toBeNull();
  });

  it("jumps to the next option starting with typed text", () => {
    const popup = new SelectPopup(select);
    popup.typeAhead("d");
    expect(popup.items[popup.highlighted]!.label).toBe("Date");
    popup.typeAhead("c");
    expect(popup.items[popup.highlighted]!.label).toBe("Date");
  });
});

describe("the list in the panel", () => {
  let input: InputSynthesizer;
  let target: Element;
  const pageEvents: string[] = [];

  beforeAll(() => {
    input = new InputSynthesizer(document, { measure: (run) => run(), onChange: () => {} });
    document.addEventListener("pointerdown", () => pageEvents.push("pointerdown"));
    document.addEventListener("click", () => pageEvents.push("click"));
  });

  beforeEach(() => {
    target = select;
    document.elementFromPoint = () => target;
    pageEvents.length = 0;
  });

  afterEach(() => {
    input.handle({ type: "blur" });
  });

  const pointer = (kind: "down" | "move" | "up", x: number, y: number) =>
    input.handle({ type: "pointer", kind, x, y });
  const key = (key: string, altKey = false) =>
    input.handle({ type: "key", ...keyInput(key, { altKey }) });
  const view = () => input.popupView;
  const rowY = (row: number) => view()!.box.top + 1 + row * view()!.itemHeight + 2;

  const open = () => {
    pointer("down", 150, 110);
    pointer("up", 150, 110);
  };

  it("opens on a press on the select, and chooses the option clicked, with input and change", () => {
    open();
    expect(input.focused).toBe(select);
    expect(view()).not.toBeNull();
    pointer("move", 150, rowY(4));
    expect(view()!.items[4]!.highlighted).toBe(true);
    pageEvents.length = 0;
    pointer("down", 150, rowY(4));
    pointer("up", 150, rowY(4));
    expect(select.value).toBe("Date");
    expect(events).toEqual(["input", "change"]);
    expect(view()).toBeNull();
    // The list is not the page: the page saw neither the press nor a click.
    expect(pageEvents).toEqual([]);
  });

  it("chooses an option dragged to from the select, as browsers do", () => {
    pointer("down", 150, 110);
    pointer("move", 150, rowY(2));
    pointer("up", 150, rowY(2));
    expect(select.value).toBe("Banana");
    expect(view()).toBeNull();
  });

  it("stays open on a click on a group label or a disabled option", () => {
    open();
    pointer("down", 150, rowY(0));
    pointer("up", 150, rowY(0));
    pointer("down", 150, rowY(3));
    pointer("up", 150, rowY(3));
    expect(view()).not.toBeNull();
    expect(events).toEqual([]);
  });

  it("closes on a press elsewhere, which the page does not get", () => {
    open();
    target = document.querySelector("#text")!;
    pageEvents.length = 0;
    pointer("down", 600, 500);
    pointer("up", 600, 500);
    expect(view()).toBeNull();
    expect(pageEvents).toEqual([]);
    expect(select.selectedIndex).toBe(0);
  });

  it("does not open when the page cancels mousedown (a custom list)", () => {
    select.addEventListener("mousedown", (event) => event.preventDefault());
    open();
    expect(view()).toBeNull();
  });

  it("takes the keys while open: arrows move, Enter chooses, Escape closes", () => {
    open();
    key("ArrowDown");
    key("Enter");
    expect(select.value).toBe("Banana");
    expect(view()).toBeNull();
    open();
    key("ArrowDown");
    key("Escape");
    expect(select.value).toBe("Banana");
    expect(view()).toBeNull();
    expect(input.focused).toBe(select);
  });

  it("changes the option with the arrows while closed, and opens with Alt+Down or Space", () => {
    open();
    key("Escape");
    key("ArrowDown");
    expect(select.value).toBe("Banana");
    key("ArrowDown");
    expect(select.value).toBe("Date");
    expect(events).toEqual(["input", "change", "input", "change"]);
    key("ArrowDown", true);
    expect(view()).not.toBeNull();
    key("Escape");
    input.handle({ type: "text", text: " " });
    expect(view()).not.toBeNull();
  });

  it("skips disabled and hidden options with the keys while closed, and stops at the ends", () => {
    select.selectedIndex = 1;
    select.focus();
    key("ArrowDown");
    expect(select.selectedIndex).toBe(3);
    key("ArrowDown");
    expect(select.selectedIndex).toBe(3);
    key("ArrowUp");
    expect(select.selectedIndex).toBe(1);
    key("Home");
    expect(select.selectedIndex).toBe(0);
    key("ArrowUp");
    expect(select.selectedIndex).toBe(0);
    key("End");
    expect(select.selectedIndex).toBe(3);
  });

  it("picks an option by typing its first letters", () => {
    open();
    key("Escape");
    input.handle({ type: "text", text: "d" });
    expect(select.value).toBe("Date");
    open();
    input.handle({ type: "text", text: "b" });
    expect(view()!.items.find((item) => item.highlighted)!.label).toBe("Banana");
  });

  it("scrolls with the wheel over it, and closes when the page scrolls", () => {
    open();
    input.handle({ type: "wheel", x: 150, y: rowY(1), deltaX: 0, deltaY: 40 });
    expect(view()).not.toBeNull();
    input.handle({ type: "wheel", x: 600, y: 500, deltaX: 0, deltaY: 40 });
    expect(view()).toBeNull();
  });

  it("closes when the select loses focus", () => {
    open();
    select.blur();
    input.handle({ type: "pointer", kind: "move", x: 600, y: 500 });
    expect(view()).toBeNull();
  });
});
