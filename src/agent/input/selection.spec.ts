import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FrameWindow } from "../../types";
import { InputSynthesizer } from "./input";
import { measureCaret } from "./caret";
import { eventsWithoutView, stubContentEditable, stubRangeRects } from "../../test-helpers";
import { keyInput, pressFarAway, type Modifiers, wheelWithoutView } from "./test-input";
import { caretAtPoint, clipCaret, selectedText, selectionBoxes, visibleBoxOf } from "./selection";

let input: InputSynthesizer;
const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };

beforeAll(() => {
  eventsWithoutView();
  wheelWithoutView();
  input = new InputSynthesizer(document, { measure: (run) => run(), onChange: () => {} });
});

afterEach(() => {
  pressFarAway(input);
  input.handle({ type: "pointer", kind: "leave", x: 0, y: 0 });
  input.handle({ type: "blur" });
  vi.restoreAllMocks();
});

/**
 * jsdom has no layout: the page is one line of text per element given, and x
 * picks the character (10 px each).
 */
function layOut(...lines: Element[]) {
  const textOf = (element: Element) => element.firstChild as Text;
  const lineAt = (y: number) => lines[Math.max(0, Math.min(lines.length - 1, Math.floor(y / 20)))]!;
  document.elementFromPoint = (_x: number, y: number) => lineAt(y);
  doc.caretRangeFromPoint = (x: number, y: number) => {
    const text = textOf(lineAt(y));
    const range = document.createRange();
    range.setStart(text, Math.max(0, Math.min(text.length, Math.round(x / 10))));
    return range;
  };
}

const pointer = (kind: "down" | "move" | "up", x: number, y: number, shiftKey = false) =>
  input.handle({ type: "pointer", kind, x, y, shiftKey });
const click = (x: number, y: number) => {
  pointer("down", x, y);
  pointer("up", x, y);
};
const key = (key: string, modifiers?: Modifiers) =>
  input.handle({ type: "key", ...keyInput(key, modifiers) });

describe("selecting the page's text", () => {
  let first: HTMLParagraphElement;
  let second: HTMLParagraphElement;

  beforeEach(() => {
    document.body.innerHTML = `<p id="first">hello brave world</p><p id="second">second line</p>`;
    first = document.querySelector("#first")!;
    second = document.querySelector("#second")!;
    layOut(first, second);
  });

  it("selects what a drag goes over, backward too, and offers it for copying", () => {
    pointer("down", 60, 5);
    pointer("move", 110, 5);
    expect(getSelection()!.toString()).toBe("brave");
    expect(input.hasSelection).toBe(true);
    expect(input.selectedText).toBe("brave");
    // Back past where it started: the selection turns around the press.
    pointer("move", 0, 5);
    pointer("up", 0, 5);
    expect(getSelection()!.toString()).toBe("hello ");
    expect(getSelection()!.anchorOffset).toBe(6);
  });

  it("selects across elements, with a line break between them in the copied text", () => {
    pointer("down", 120, 5);
    pointer("move", 60, 25);
    pointer("up", 60, 25);
    expect(input.selectedText).toBe("world\nsecond");
  });

  it("selects a word with a double press, and grows by words while dragging", () => {
    click(70, 5);
    pointer("down", 70, 5);
    expect(getSelection()!.toString()).toBe("brave");
    pointer("move", 130, 5);
    pointer("up", 130, 5);
    expect(getSelection()!.toString()).toBe("brave world");
  });

  it("selects the paragraph with a triple press", () => {
    click(70, 25);
    click(70, 25);
    click(70, 25);
    expect(getSelection()!.toString()).toBe("second line");
  });

  it("extends the selection with Shift, and drops it with a press elsewhere", () => {
    click(60, 5);
    pointer("down", 110, 5, true);
    pointer("up", 110, 5, true);
    expect(getSelection()!.toString()).toBe("brave");
    click(30, 25);
    expect(getSelection()!.isCollapsed).toBe(true);
    expect(input.hasSelection).toBe(false);
  });

  it("does not select where the page cancels mousedown", () => {
    first.addEventListener("mousedown", (event) => event.preventDefault());
    pointer("down", 60, 5);
    pointer("move", 110, 5);
    pointer("up", 110, 5);
    expect(input.hasSelection).toBe(false);
  });

  it("does not take a selection the page's script made for the user's", () => {
    // Made while the user acts elsewhere (in the host): it must not ask for the keys.
    getSelection()!.selectAllChildren(first);
    expect(input.hasSelection).toBe(false);
    // The host taking the keys back leaves the page's own selection alone.
    input.handle({ type: "blur" });
    expect(getSelection()!.toString()).toBe("hello brave world");
  });

  it("takes a selection the page makes in its handler for the user's press (selecting a block on a click)", () => {
    second.addEventListener("click", () => getSelection()!.selectAllChildren(second));
    click(30, 25);
    expect(input.hasSelection).toBe(true);
  });

  it("keeps the selection, inactive, when the host takes the keys back, until the user acts on the panel again", () => {
    pointer("down", 60, 5);
    pointer("move", 110, 5);
    pointer("up", 110, 5);
    input.handle({ type: "blur" });
    // Still there (drawn grey), but it no longer asks for the keys.
    expect(getSelection()!.toString()).toBe("brave");
    expect(input.hasSelection).toBe(false);
    // Hovering and scrolling do not make the panel active again.
    input.handle({ type: "pointer", kind: "move", x: 20, y: 5 });
    input.handle({ type: "wheel", x: 20, y: 5, deltaX: 0, deltaY: 10 });
    expect(input.hasSelection).toBe(false);
    // A key the user presses in the panel does.
    key("Shift", { shiftKey: true });
    expect(input.hasSelection).toBe(true);
  });

  it("selects the whole page with the select-all shortcut when nothing is focused", () => {
    key("a", { ctrlKey: true });
    expect(input.selectedText).toBe("hello brave world\nsecond line");
  });

  it("does not take the text of a field for the page's selection", () => {
    document.body.innerHTML = `<p id="text">words</p><input id="field" value="secret">`;
    getSelection()!.selectAllChildren(document.body);
    document.querySelector<HTMLInputElement>("#field")!.focus();
    // The field's own selection is what is copied while it has focus.
    expect(input.hasSelection).toBe(false);
  });
});

describe("the caret of text being composed in an editable", () => {
  it("wraps the composed text at the end of its block's line, a character at a time", () => {
    document.body.innerHTML = `<div id="editor" contenteditable="true" style="display: block; line-height: 20px; padding-left: 4px; padding-right: 6px">hello</div>`;
    const editor = document.querySelector<HTMLElement>("#editor")!;
    // The block is 110 px wide at x = 0 (content 4..104); "hello" ends at x = 90.
    editor.getBoundingClientRect = () => new DOMRect(0, 0, 110, 40);
    Object.defineProperties(editor, { clientWidth: { value: 110 }, clientLeft: { value: 0 } });
    const restoreRects = stubRangeRects(
      () => [new DOMRect(82, 0, 8, 20)] as unknown as DOMRectList,
    );
    try {
      const end = { node: editor.firstChild!, offset: 5 };
      // jsdom has no canvas: each character measures 8 px.
      expect(caretAtPoint(end, "a")).toMatchObject({ x: 98, y: 0 });
      // The second one does not fit (98 + 8 > 104): it starts the next line.
      expect(caretAtPoint(end, "ab")).toMatchObject({ x: 12, y: 20 });
      expect(caretAtPoint(end, "abc")).toMatchObject({ x: 20, y: 20 });
    } finally {
      restoreRects();
    }
  });
});

describe("selectedText", () => {
  it("stops once the text is longer than the limit", () => {
    document.body.innerHTML = `<p>one</p><p>two</p><p>three</p>`;
    const range = document.createRange();
    range.selectNodeContents(document.body);
    expect(selectedText(window as unknown as FrameWindow, range, 4)).toBe("one\ntwo");
  });

  it("collapses white space as CSS does, and keeps it where it is preformatted", () => {
    document.body.innerHTML = `<p>  one
      two  </p><pre>a  b\nc</pre><p>x<br>y</p>`;
    const range = document.createRange();
    range.selectNodeContents(document.body);
    expect(selectedText(window as unknown as FrameWindow, range)).toBe("one two\na  b\nc\nx\ny");
  });
});

describe("editing a contenteditable element", () => {
  let editor: HTMLDivElement;
  let commands: [string, string | undefined][];

  beforeEach(() => {
    document.body.innerHTML = `<div id="editor" contenteditable="true"><p>hello world</p></div>`;
    editor = document.querySelector("#editor")!;
    // jsdom has neither execCommand nor isContentEditable (stubbed until the test ends).
    commands = [];
    document.execCommand = (command: string, _ui?: boolean, value?: string) => {
      commands.push([command, value]);
      return true;
    };
    layOut(editor.querySelector("p")!);
    return stubContentEditable();
  });

  it("focuses the editable on a press, with the caret where it was pressed", () => {
    click(50, 5);
    expect(input.focused).toBe(editor);
    const selection = getSelection()!;
    expect(selection.isCollapsed).toBe(true);
    expect(selection.anchorOffset).toBe(5);
  });

  it("focuses the editable, not a link in it, on a press on the link", () => {
    editor.querySelector("p")!.innerHTML =
      `<a id="link" href="https://example.com/">hello world</a>`;
    const link = editor.querySelector("#link")!;
    document.elementFromPoint = () => link;
    doc.caretRangeFromPoint = () => {
      const range = document.createRange();
      range.setStart(link.firstChild!, 3);
      return range;
    };
    click(30, 5);
    expect(input.focused).toBe(editor);
    expect(getSelection()!.anchorOffset).toBe(3);
  });

  it("puts the caret at the start when the page focuses it", () => {
    getSelection()!.removeAllRanges();
    editor.focus();
    expect(getSelection()!.anchorNode).toBe(editor);
    expect(getSelection()!.anchorOffset).toBe(0);
  });

  it("types with the browser's insertText, after a beforeinput the page could cancel", () => {
    click(50, 5);
    const before: string[] = [];
    editor.addEventListener("beforeinput", (event) => before.push((event as InputEvent).inputType));
    input.handle({ type: "text", text: "X" });
    key("Enter");
    key("Backspace");
    expect(before).toEqual(["insertText", "insertParagraph", "deleteContentBackward"]);
    expect(commands).toEqual([
      ["insertText", "X"],
      ["insertParagraph", undefined],
      ["delete", undefined],
    ]);
  });

  it("does nothing when the page cancels beforeinput", () => {
    click(50, 5);
    editor.addEventListener("beforeinput", (event) => event.preventDefault());
    input.handle({ type: "text", text: "X" });
    key("b", { ctrlKey: true });
    expect(commands).toEqual([]);
  });

  it("lets the page see one beforeinput when the browser sends its own with the command (WebKit)", () => {
    click(50, 5);
    document.execCommand = () => {
      editor.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText" }),
      );
      return true;
    };
    const seen = vi.fn();
    editor.addEventListener("beforeinput", seen);
    input.handle({ type: "text", text: "X" });
    expect(seen).toHaveBeenCalledOnce();
  });

  it("inserts the text by hand where the browser has no command", () => {
    click(50, 5);
    document.execCommand = () => false;
    const inputs: string[] = [];
    editor.addEventListener("input", (event) => inputs.push((event as InputEvent).data ?? ""));
    input.handle({ type: "text", text: "X" });
    expect(editor.textContent).toBe("helloX world");
    expect(inputs).toEqual(["X"]);
  });

  it("formats, undoes and selects all with the shortcuts, inside the editable", () => {
    document.body.insertAdjacentHTML("afterbegin", "<p>outside</p>");
    click(50, 5);
    key("b", { ctrlKey: true });
    key("z", { ctrlKey: true });
    expect(commands).toEqual([
      ["bold", undefined],
      ["undo", undefined],
    ]);
    key("a", { ctrlKey: true });
    expect(getSelection()!.toString()).toBe("hello world");
    expect(input.selectedText).toBe("hello world");
  });

  it("cuts the selected text with the delete command", () => {
    click(50, 5);
    getSelection()!.selectAllChildren(editor);
    input.handle({ type: "cut" });
    expect(commands).toEqual([["delete", undefined]]);
  });

  it("brings the caret back into the editable when the page moved the selection away", () => {
    document.body.insertAdjacentHTML("beforeend", "<p id='away'>away</p>");
    click(50, 5);
    getSelection()!.selectAllChildren(document.querySelector("#away")!);
    input.handle({ type: "text", text: "X" });
    expect(editor.contains(getSelection()!.anchorNode)).toBe(true);
  });

  it("composes with the IME into the editable", () => {
    click(50, 5);
    input.handle({ type: "composition", text: "にほ", cursor: 2 });
    expect(input.composition).toEqual({ text: "にほ", cursor: 2 });
  });
});

describe("the caret, cut to what shows", () => {
  /** Gives an element a box: its border box and its padding box (clientLeft/Top/Width/Height). */
  function box(
    element: Element,
    left: number,
    top: number,
    width: number,
    height: number,
    border = 0,
  ) {
    element.getBoundingClientRect = () => new DOMRect(left, top, width, height);
    Object.defineProperties(element, {
      clientLeft: { configurable: true, value: border },
      clientTop: { configurable: true, value: border },
      clientWidth: { configurable: true, value: width - 2 * border },
      clientHeight: { configurable: true, value: height - 2 * border },
    });
  }

  beforeEach(() => {
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      configurable: true,
      value: 600,
    });
  });

  it("keeps a caret that shows whole, and trims one partly out of the box", () => {
    const shown = { left: 10, top: 100, width: 200, height: 50 };
    expect(clipCaret({ x: 20, y: 110, height: 18 }, shown)).toEqual({ x: 20, y: 110, height: 18 });
    // A line scrolled half out at the bottom.
    expect(clipCaret({ x: 20, y: 140, height: 18 }, shown)).toEqual({ x: 20, y: 140, height: 10 });
    // And at the top.
    expect(clipCaret({ x: 20, y: 92, height: 18 }, shown)).toEqual({ x: 20, y: 100, height: 10 });
    // Out of it: none.
    expect(clipCaret({ x: 20, y: 150, height: 18 }, shown)).toBeNull();
    expect(clipCaret({ x: 300, y: 110, height: 18 }, shown)).toBeNull();
    // At the right edge (the end of a full line), it still shows.
    expect(clipCaret({ x: 210.5, y: 110, height: 18 }, shown)).not.toBeNull();
  });

  it("finds what shows of a field: its padding box, cut by an ancestor that hides what overflows", () => {
    document.body.innerHTML = `<div id="note" style="overflow-x: hidden; overflow-y: hidden"><textarea id="text"></textarea></div>`;
    const note = document.querySelector("#note")!;
    const text = document.querySelector("#text")!;
    box(note, 0, 0, 220, 160);
    box(text, 0, 30, 244, 150, 2);
    expect(visibleBoxOf(text)).toEqual({ left: 2, top: 32, width: 218, height: 128 });
  });

  it("cuts an editable's caret by its own box only where it clips: not an inline one (overflow does not apply), nor one that lets text overflow", () => {
    document.body.innerHTML = `
      <div id="page" style="overflow-x: hidden; overflow-y: hidden">
        <span id="inline" contenteditable="true" style="display: inline; overflow-x: hidden; overflow-y: hidden">Untitled</span>
        <div id="spills" contenteditable="true" style="display: block; height: 20px">long text</div>
        <div id="scrolls" contenteditable="true" style="display: block; overflow-x: auto; overflow-y: auto">long text</div>
      </div>`;
    box(document.querySelector("#page")!, 0, 0, 400, 300);
    for (const id of ["inline", "spills", "scrolls"])
      box(
        document.querySelector(`#${id}`)!,
        10,
        10,
        id === "inline" ? 0 : 100,
        id === "inline" ? 0 : 20,
      );
    const page = { left: 0, top: 0, width: 400, height: 300 };
    expect(visibleBoxOf(document.querySelector("#inline")!)).toEqual(page);
    expect(visibleBoxOf(document.querySelector("#spills")!)).toEqual(page);
    expect(visibleBoxOf(document.querySelector("#scrolls")!)).toEqual({
      left: 10,
      top: 10,
      width: 100,
      height: 20,
    });
  });

  it("is not cut by an inline ancestor, whatever its overflow says", () => {
    document.body.innerHTML = `
      <div id="page" style="overflow-x: hidden; overflow-y: hidden">
        <span id="truncate" style="display: inline; overflow-x: hidden; overflow-y: hidden"><input id="field"></span>
      </div>`;
    box(document.querySelector("#page")!, 0, 0, 400, 300);
    box(document.querySelector("#truncate")!, 10, 10, 0, 0);
    box(document.querySelector("#field")!, 10, 10, 100, 20);
    expect(visibleBoxOf(document.querySelector("#field")!)).toEqual({
      left: 10,
      top: 10,
      width: 100,
      height: 20,
    });
  });

  it("highlights selected text in an inline element whatever its overflow says", () => {
    document.body.innerHTML = `<p id="para"><a id="link" style="display: inline; overflow-x: hidden; overflow-y: hidden">linked text</a></p>`;
    box(document.querySelector("#link")!, 10, 10, 0, 0);
    const restoreRects = stubRangeRects(
      () => [new DOMRect(10, 10, 60, 18)] as unknown as DOMRectList,
    );
    try {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector("#link")!);
      expect(selectionBoxes(window as unknown as FrameWindow, range)).toEqual([
        {
          left: 10,
          top: 10,
          width: 60,
          height: 18,
          text: document.querySelector("#link")!.firstChild,
        },
      ]);
    } finally {
      restoreRects();
    }
  });

  it("is not cut by boxes outside its containing block's chain (a positioned popup), but is by those in it", () => {
    document.body.innerHTML = `
      <div id="positioned" style="position: relative; overflow-x: hidden; overflow-y: hidden">
        <div id="toolbar" style="overflow-x: hidden; overflow-y: hidden">
          <div id="dropdown" style="position: absolute"><input id="search"></div>
        </div>
      </div>
      <div id="shell" style="overflow-x: hidden; overflow-y: hidden">
        <div id="dialog" style="position: fixed"><input id="name"></div>
        <div id="moved" style="transform: translateX(0px); overflow-x: hidden; overflow-y: hidden">
          <div style="position: fixed"><input id="inside"></div>
        </div>
      </div>`;
    const $ = (id: string) => document.querySelector(`#${id}`)!;
    box($("positioned"), 0, 0, 400, 300);
    box($("toolbar"), 0, 0, 400, 40);
    box($("search"), 10, 50, 100, 20);
    // Below the toolbar, which does not clip it; inside the positioned box, which does.
    expect(visibleBoxOf($("search"))).toEqual({ left: 10, top: 50, width: 100, height: 20 });
    box($("search"), 10, 290, 100, 20);
    expect(visibleBoxOf($("search"))).toEqual({ left: 10, top: 290, width: 100, height: 10 });

    box($("shell"), 0, 0, 200, 100);
    box($("name"), 300, 300, 100, 20);
    expect(visibleBoxOf($("name"))).toEqual({ left: 300, top: 300, width: 100, height: 20 });
    // A transform makes a box the containing block of fixed elements in it: it clips them.
    box($("moved"), 0, 0, 200, 100);
    box($("inside"), 150, 90, 100, 20);
    expect(visibleBoxOf($("inside"))).toEqual({ left: 150, top: 90, width: 50, height: 10 });
  });

  it("is cut by nothing but the viewport in the top layer (an open popover), whatever its parents", () => {
    document.body.innerHTML = `
      <div id="moved" style="transform: translateX(0px); overflow-x: hidden; overflow-y: hidden">
        <div id="menu" popover style="position: fixed"><input id="search"></div>
      </div>`;
    const menu = document.querySelector("#menu")!;
    box(document.querySelector("#moved")!, 0, 0, 200, 100);
    box(document.querySelector("#search")!, 150, 90, 100, 20);
    // Closed (or not in the top layer), the transformed box clips it.
    expect(visibleBoxOf(document.querySelector("#search")!)).toEqual({
      left: 150,
      top: 90,
      width: 50,
      height: 10,
    });
    const matches = menu.matches.bind(menu);
    vi.spyOn(menu, "matches").mockImplementation(
      (selector: string) => selector === ":popover-open" || matches(selector),
    );
    expect(visibleBoxOf(document.querySelector("#search")!)).toEqual({
      left: 150,
      top: 90,
      width: 100,
      height: 20,
    });
  });

  it("hides the caret of a field whose line a box above it hides", () => {
    document.body.innerHTML = `<div id="note" style="overflow-x: hidden; overflow-y: hidden"><input id="name" value="hello"></div>`;
    const note = document.querySelector("#note")!;
    const field = document.querySelector<HTMLInputElement>("#name")!;
    box(note, 0, 0, 200, 20);
    // The field sits below what the note shows.
    box(field, 0, 40, 200, 30);
    field.setSelectionRange(5, 5);
    expect(measureCaret(field)).toBeNull();
    box(field, 0, 0, 200, 30);
    // Its line (centred in the field) is cut by the note's bottom.
    expect(measureCaret(field)).toMatchObject({
      y: expect.any(Number),
      height: expect.any(Number),
    });
    expect(measureCaret(field)!.y + measureCaret(field)!.height).toBeLessThanOrEqual(20);
  });
});
