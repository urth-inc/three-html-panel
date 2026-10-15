import { describe, expect, it } from "vite-plus/test";
import { contentAction } from "./contenteditable";
import { keyInput as press } from "./test-input";

describe("contentAction", () => {
  it("moves by character, and extends with Shift", () => {
    expect(contentAction(press("ArrowLeft"), false, true)).toEqual({
      type: "modify",
      alter: "move",
      direction: "backward",
      granularity: "character",
    });
    expect(contentAction(press("ArrowRight", { shiftKey: true }), false, true)).toEqual({
      type: "modify",
      alter: "extend",
      direction: "forward",
      granularity: "character",
    });
  });

  it("goes to the end of the selected text with an arrow, rather than moving from it", () => {
    expect(contentAction(press("ArrowLeft"), false, false)).toEqual({
      type: "collapse",
      toStart: true,
    });
    expect(contentAction(press("ArrowRight"), false, false)).toEqual({
      type: "collapse",
      toStart: false,
    });
    // With Shift it extends, as usual.
    expect(contentAction(press("ArrowRight", { shiftKey: true }), false, false)).toMatchObject({
      type: "modify",
      alter: "extend",
    });
  });

  it("moves by word and to line ends with the platform's modifiers", () => {
    expect(contentAction(press("ArrowLeft", { altKey: true }), true, true)).toMatchObject({
      granularity: "word",
    });
    expect(contentAction(press("ArrowLeft", { ctrlKey: true }), false, true)).toMatchObject({
      granularity: "word",
    });
    expect(contentAction(press("ArrowRight", { metaKey: true }), true, true)).toMatchObject({
      granularity: "lineboundary",
    });
    expect(contentAction(press("ArrowUp", { metaKey: true }), true, true)).toMatchObject({
      granularity: "documentboundary",
    });
    expect(contentAction(press("ArrowDown"), false, true)).toMatchObject({
      direction: "forward",
      granularity: "line",
    });
    expect(contentAction(press("Home"), false, true)).toMatchObject({
      direction: "backward",
      granularity: "lineboundary",
    });
    expect(contentAction(press("End", { ctrlKey: true }), false, true)).toMatchObject({
      granularity: "documentboundary",
    });
  });

  it("deletes, by word or to the line's start with the modifiers", () => {
    expect(contentAction(press("Backspace"), false, true)).toEqual({
      type: "command",
      command: "delete",
      inputType: "deleteContentBackward",
    });
    expect(contentAction(press("Delete"), false, true)).toEqual({
      type: "command",
      command: "forwardDelete",
      inputType: "deleteContentForward",
    });
    expect(contentAction(press("Backspace", { altKey: true }), true, true)).toEqual({
      type: "command",
      command: "delete",
      inputType: "deleteWordBackward",
      extend: { direction: "backward", granularity: "word" },
    });
    expect(contentAction(press("Backspace", { metaKey: true }), true, true)).toMatchObject({
      inputType: "deleteSoftLineBackward",
      extend: { granularity: "lineboundary" },
    });
    expect(contentAction(press("Delete", { ctrlKey: true }), false, true)).toMatchObject({
      inputType: "deleteWordForward",
    });
  });

  it("starts a paragraph with Enter, and breaks the line with Shift+Enter", () => {
    expect(contentAction(press("Enter"), false, true)).toMatchObject({
      command: "insertParagraph",
      inputType: "insertParagraph",
    });
    expect(contentAction(press("Enter", { shiftKey: true }), false, true)).toMatchObject({
      command: "insertLineBreak",
      inputType: "insertLineBreak",
    });
  });

  it("selects all, undoes, redoes and formats with the platform's shortcut key", () => {
    expect(contentAction(press("a", { metaKey: true }), true, true)).toEqual({ type: "selectAll" });
    expect(contentAction(press("a", { ctrlKey: true }), false, true)).toEqual({
      type: "selectAll",
    });
    expect(contentAction(press("z", { metaKey: true }), true, true)).toMatchObject({
      command: "undo",
      inputType: "historyUndo",
    });
    expect(contentAction(press("z", { metaKey: true, shiftKey: true }), true, true)).toMatchObject({
      command: "redo",
    });
    expect(contentAction(press("y", { ctrlKey: true }), false, true)).toMatchObject({
      command: "redo",
    });
    expect(contentAction(press("b", { ctrlKey: true }), false, true)).toMatchObject({
      command: "bold",
      inputType: "formatBold",
    });
    expect(contentAction(press("i", { metaKey: true }), true, true)).toMatchObject({
      command: "italic",
    });
    expect(contentAction(press("u", { ctrlKey: true }), false, true)).toMatchObject({
      command: "underline",
    });
  });

  it("keeps the Emacs keys of macOS: Ctrl+A is the line's start there, not select all", () => {
    expect(contentAction(press("a", { ctrlKey: true }), true, true)).toMatchObject({
      type: "modify",
      granularity: "lineboundary",
    });
    expect(contentAction(press("e", { ctrlKey: true }), true, true)).toMatchObject({
      direction: "forward",
      granularity: "lineboundary",
    });
    expect(contentAction(press("b", { ctrlKey: true }), true, true)).toMatchObject({
      type: "modify",
      direction: "backward",
    });
    expect(contentAction(press("k", { ctrlKey: true }), true, true)).toMatchObject({
      command: "delete",
      extend: { direction: "forward", granularity: "lineboundary" },
    });
  });

  it("leaves other keys alone", () => {
    expect(contentAction(press("x"), false, true)).toBeNull();
    expect(contentAction(press("Tab"), false, true)).toBeNull();
    expect(contentAction(press("Enter", { metaKey: true }), true, true)).toBeNull();
    expect(contentAction(press("a", { metaKey: true }), false, true)).toBeNull();
  });
});
