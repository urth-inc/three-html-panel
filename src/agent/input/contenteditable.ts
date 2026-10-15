// Keyboard editing in contenteditable elements.
//
// Synthetic key events have no default action. In an <input> or a <textarea>
// the agent edits the value itself (editing.ts); rich text is much harder to
// edit by hand, so here the browser does it: Selection.modify() moves the
// caret, and document.execCommand() edits at the selection, as the browser's
// own typing would (paragraphs, line breaks, its undo stack). Both work on the
// page's selection without the iframe having focus.
//
// This works out what a key does; input.ts applies it, with a beforeinput the
// page can cancel first (rich text editors handle that event themselves).
//
// Bindings follow editing.ts: Option (macOS) or Ctrl (elsewhere) by word,
// Cmd (macOS) to line and document boundaries, the macOS Emacs keys, Shift to
// extend; and the formatting shortcuts browsers have in contenteditable.

import { lineModifier, primaryModifier, wordModifier, type KeyInput } from "./editing";

export type ContentAction =
  /** Move or extend the selection, as Selection.modify() does. */
  | {
      type: "modify";
      alter: "move" | "extend";
      direction: "backward" | "forward";
      granularity: Granularity;
    }
  /** Collapse the selection to one of its ends (an arrow with text selected). */
  | { type: "collapse"; toStart: boolean }
  /**
   * Run an editing command. With `extend`, a collapsed selection is first
   * extended by it (deleting a word or to the line's end).
   */
  | {
      type: "command";
      command: string;
      inputType: string;
      extend?: { direction: "backward" | "forward"; granularity: Granularity };
    }
  | { type: "selectAll" };

export type Granularity = "character" | "word" | "line" | "lineboundary" | "documentboundary";

const FORMATS: Record<string, [command: string, inputType: string]> = {
  b: ["bold", "formatBold"],
  i: ["italic", "formatItalic"],
  u: ["underline", "formatUnderline"],
};

/** What a key does in a contenteditable element, or null if nothing. `collapsed`: no text is selected. */
export function contentAction(
  input: KeyInput,
  apple: boolean,
  collapsed: boolean,
): ContentAction | null {
  const { key, shiftKey, ctrlKey, altKey, metaKey } = input;
  const alter = shiftKey ? "extend" : "move";
  const primary = primaryModifier(input, apple);
  const word = wordModifier(input, apple);
  const lineKey = lineModifier(input, apple);
  const modify = (direction: "backward" | "forward", granularity: Granularity): ContentAction => ({
    type: "modify",
    alter,
    direction,
    granularity,
  });

  // The Emacs keys of macOS text views.
  if (apple && ctrlKey && !metaKey && !altKey && key.length === 1) {
    switch (key.toLowerCase()) {
      case "a":
        return modify("backward", "lineboundary");
      case "e":
        return modify("forward", "lineboundary");
      case "b":
        return modify("backward", "character");
      case "f":
        return modify("forward", "character");
      case "p":
        return modify("backward", "line");
      case "n":
        return modify("forward", "line");
      case "h":
        return { type: "command", command: "delete", inputType: "deleteContentBackward" };
      case "d":
        return { type: "command", command: "forwardDelete", inputType: "deleteContentForward" };
      case "k":
        return {
          type: "command",
          command: "delete",
          inputType: "deleteSoftLineForward",
          extend: { direction: "forward", granularity: "lineboundary" },
        };
    }
  }

  switch (key) {
    case "ArrowLeft":
    case "ArrowRight": {
      const direction = key === "ArrowLeft" ? "backward" : "forward";
      const granularity = word ? "word" : lineKey ? "lineboundary" : "character";
      // Like browsers: an arrow with text selected goes to that end of it.
      if (!shiftKey && !collapsed && granularity === "character")
        return { type: "collapse", toStart: direction === "backward" };
      return modify(direction, granularity);
    }
    case "ArrowUp":
    case "ArrowDown":
      return modify(
        key === "ArrowUp" ? "backward" : "forward",
        lineKey ? "documentboundary" : "line",
      );
    case "Home":
    case "End":
      return modify(
        key === "Home" ? "backward" : "forward",
        !apple && ctrlKey ? "documentboundary" : "lineboundary",
      );
    case "Backspace":
    case "Delete": {
      const backward = key === "Backspace";
      const direction = backward ? "backward" : "forward";
      const command = backward ? "delete" : "forwardDelete";
      const side = backward ? "Backward" : "Forward";
      if (word)
        return {
          type: "command",
          command,
          inputType: `deleteWord${side}`,
          extend: { direction, granularity: "word" },
        };
      if (lineKey) {
        return {
          type: "command",
          command,
          inputType: `deleteSoftLine${side}`,
          extend: { direction, granularity: "lineboundary" },
        };
      }
      return { type: "command", command, inputType: `deleteContent${side}` };
    }
    case "Enter":
      if (ctrlKey || metaKey || altKey) return null;
      return shiftKey
        ? { type: "command", command: "insertLineBreak", inputType: "insertLineBreak" }
        : { type: "command", command: "insertParagraph", inputType: "insertParagraph" };
  }

  if (primary && !altKey && key.length === 1) {
    const letter = key.toLowerCase();
    if (letter === "a" && !shiftKey) return { type: "selectAll" };
    if (letter === "z") {
      return shiftKey
        ? { type: "command", command: "redo", inputType: "historyRedo" }
        : { type: "command", command: "undo", inputType: "historyUndo" };
    }
    if (letter === "y" && !apple && !shiftKey)
      return { type: "command", command: "redo", inputType: "historyRedo" };
    const format = FORMATS[letter];
    if (format && !shiftKey) return { type: "command", command: format[0], inputType: format[1] };
  }
  return null;
}
