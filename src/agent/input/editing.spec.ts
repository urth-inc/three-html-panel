import { describe, expect, it } from "vite-plus/test";
import {
  editAction,
  wordAt,
  wordEnd,
  wordStart,
  type EditAction,
  type EditContext,
  type FieldState,
  type KeyInput,
} from "./editing";
import { keyInput as key } from "./test-input";

/** A field from a string with "|" for the caret, or "[" and "]" around the selection ("]" first if backward). */
function field(marked: string, multiline = true): FieldState {
  const caret = marked.indexOf("|");
  if (caret >= 0) {
    return {
      value: marked.replace("|", ""),
      start: caret,
      end: caret,
      direction: "none",
      multiline,
    };
  }
  const open = marked.indexOf("[");
  const close = marked.indexOf("]");
  const value = marked.replace("[", "").replace("]", "");
  const [start, end] = open < close ? [open, close - 1] : [close, open - 1];
  return { value, start, end, direction: open < close ? "forward" : "backward", multiline };
}

/** Applies a select action to the field and marks it like `field()` does. */
function after(state: FieldState, action: EditAction | null): string {
  if (!action) return "(nothing)";
  if (action.type === "edit") {
    const value = state.value.slice(0, action.start) + action.text + state.value.slice(action.end);
    const caret = action.start + action.text.length;
    return value.slice(0, caret) + "|" + value.slice(caret);
  }
  if (action.type === "submit") return "(submit)";
  if (action.type === "undo" || action.type === "redo") return `(${action.type})`;
  const { anchor, focus } = action;
  if (anchor === focus) return state.value.slice(0, focus) + "|" + state.value.slice(focus);
  const [a, b] = [Math.min(anchor, focus), Math.max(anchor, focus)];
  const [l, r] = focus > anchor ? ["[", "]"] : ["]", "["];
  return state.value.slice(0, a) + l + state.value.slice(a, b) + r + state.value.slice(b);
}

const mac: EditContext = { apple: true, verticalTarget: () => null };
const windows: EditContext = { apple: false, verticalTarget: () => null };
const run = (marked: string, input: KeyInput, context = mac, multiline = true) => {
  const state = field(marked, multiline);
  return after(state, editAction(state, input, context));
};

describe("editAction", () => {
  it("moves by character and collapses a selection to its edge", () => {
    expect(run("ab|c", key("ArrowLeft"))).toBe("a|bc");
    expect(run("a[bc]", key("ArrowLeft"))).toBe("a|bc");
    expect(run("a[bc]", key("ArrowRight"))).toBe("abc|");
    // An emoji is one step.
    expect(run("a😀|", key("ArrowLeft"))).toBe("a|😀");
  });

  it("extends the selection with Shift from the anchor", () => {
    expect(run("ab|c", key("ArrowLeft", { shiftKey: true }))).toBe("a]b[c");
    expect(run("a[b]c", key("ArrowRight", { shiftKey: true }))).toBe("a[bc]");
    expect(run("abc\nde|f", key("Home", { shiftKey: true }))).toBe("abc\n]de[f");
  });

  it("goes to the line's start and end with Home/End in a textarea, and the value's in an input", () => {
    expect(run("abc\nde|f\ng", key("Home"))).toBe("abc\n|def\ng");
    expect(run("abc\nd|ef\ng", key("End"))).toBe("abc\ndef|\ng");
    expect(run("ab|c", key("Home"), mac, false)).toBe("|abc");
    expect(run("abc\nd|ef", key("End", { ctrlKey: true }), windows)).toBe("abc\ndef|");
  });

  it("moves by word with Option on macOS and Ctrl elsewhere", () => {
    expect(run("one two| three", key("ArrowLeft", { altKey: true }))).toBe("one |two three");
    expect(run("one |two three", key("ArrowRight", { altKey: true }))).toBe("one two| three");
    expect(run("one |two three", key("ArrowRight", { ctrlKey: true }), windows)).toBe(
      "one two |three",
    );
    expect(run("one two| three", key("ArrowLeft", { ctrlKey: true }), windows)).toBe(
      "one |two three",
    );
  });

  it("moves to the line's edges with Cmd+Left/Right and the start or end with Cmd+Up/Down on macOS", () => {
    expect(run("ab\ncd|e", key("ArrowLeft", { metaKey: true }))).toBe("ab\n|cde");
    expect(run("ab\nc|de", key("ArrowRight", { metaKey: true }))).toBe("ab\ncde|");
    expect(run("ab\nc|de", key("ArrowUp", { metaKey: true }))).toBe("|ab\ncde");
    expect(run("ab\nc|de", key("ArrowDown", { metaKey: true }))).toBe("ab\ncde|");
  });

  it("uses the caller's visual lines for Up/Down, and the field's ends past them", () => {
    const below: EditContext = {
      apple: true,
      verticalTarget: (_i: number, d: -1 | 1) => (d > 0 ? 6 : null),
    };
    expect(run("ab|c\ndef", key("ArrowDown"), below)).toBe("abc\nde|f");
    expect(run("ab|c\ndef", key("ArrowUp"), below)).toBe("|abc\ndef");
    expect(run("ab|c", key("ArrowDown"), mac, false)).toBe("abc|");
  });

  it("supports the macOS Emacs keys", () => {
    expect(run("ab\ncd|e", key("a", { ctrlKey: true }))).toBe("ab\n|cde");
    expect(run("ab\nc|de", key("e", { ctrlKey: true }))).toBe("ab\ncde|");
    expect(run("ab\nc|de", key("a", { ctrlKey: true, shiftKey: true }))).toBe("ab\n]c[de");
    expect(run("ab|c", key("b", { ctrlKey: true }))).toBe("a|bc");
    expect(run("ab|c", key("f", { ctrlKey: true }))).toBe("abc|");
    expect(run("ab|c", key("h", { ctrlKey: true }))).toBe("a|c");
    expect(run("ab|c", key("d", { ctrlKey: true }))).toBe("ab|");
    expect(run("a|bc\nd", key("k", { ctrlKey: true }))).toBe("a|\nd");
    // At the end of a line, Ctrl+K joins the next line.
    expect(run("abc|\nd", key("k", { ctrlKey: true }))).toBe("abc|d");
  });

  it("selects all with Cmd+A on macOS and Ctrl+A elsewhere", () => {
    expect(run("a|bc", key("a", { metaKey: true }))).toBe("[abc]");
    expect(run("a|bc", key("a", { ctrlKey: true }), windows)).toBe("[abc]");
    expect(run("a|bc", key("a", { metaKey: true }), windows)).toBe("(nothing)");
  });

  it("undoes with Cmd+Z on macOS and Ctrl+Z elsewhere, and redoes with Shift or Ctrl+Y", () => {
    expect(run("ab|", key("z", { metaKey: true }))).toBe("(undo)");
    expect(run("ab|", key("z", { metaKey: true, shiftKey: true }))).toBe("(redo)");
    expect(run("ab|", key("z", { ctrlKey: true }), windows)).toBe("(undo)");
    expect(run("ab|", key("z", { ctrlKey: true, shiftKey: true }), windows)).toBe("(redo)");
    expect(run("ab|", key("y", { ctrlKey: true }), windows)).toBe("(redo)");
    // Not the other platform's key.
    expect(run("ab|", key("z", { ctrlKey: true }))).toBe("(nothing)");
    expect(run("ab|", key("y", { metaKey: true }))).toBe("(nothing)");
  });

  it("deletes characters, words and lines", () => {
    expect(run("ab|c", key("Backspace"))).toBe("a|c");
    expect(run("|abc", key("Backspace"))).toBe("(nothing)");
    expect(run("a[b]c", key("Delete"))).toBe("a|c");
    expect(run("one two|", key("Backspace", { altKey: true }))).toBe("one |");
    expect(run("one two|", key("Backspace", { ctrlKey: true }), windows)).toBe("one |");
    expect(run("ab\ncd|e", key("Backspace", { metaKey: true }))).toBe("ab\n|e");
  });

  it("inserts a line break in a textarea and submits an input on Enter", () => {
    expect(run("a|b", key("Enter"))).toBe("a\n|b");
    expect(run("a|b", key("Enter"), mac, false)).toBe("(submit)");
  });
});

describe("words", () => {
  it("finds word boundaries, Japanese included", () => {
    expect(wordStart("hello world", 8)).toBe(6);
    expect(wordEnd("hello world", 2, true)).toBe(5);
    expect(wordAt("hello world", 7)).toEqual([6, 11]);
    const [start, end] = wordAt("日本語の入力", 1);
    expect(start).toBe(0);
    expect(end).toBeGreaterThan(1);
  });
});
