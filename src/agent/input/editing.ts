// Keyboard editing in <input> and <textarea>, the way browsers do it.
//
// Synthetic key events have no default action, so moving the caret, extending
// the selection and deleting are worked out here, from the field's value and
// selection. This is pure; input.ts applies the result.
//
// Bindings follow the platform:
// - everywhere: arrows, Home/End, PageUp/PageDown, Shift to extend,
//   Backspace/Delete, Enter
// - macOS/iOS: Option+arrows by word, Cmd+arrows to line/document boundaries,
//   Option/Cmd+Backspace, and the Emacs keys Ctrl+A/E/B/F/P/N/H/D/K; Cmd+A selects
//   all; Cmd+Z undoes, Shift+Cmd+Z redoes
// - elsewhere: Ctrl+arrows by word, Ctrl+Home/End, Ctrl+Backspace/Delete; Ctrl+A
//   selects all; Ctrl+Z undoes, Ctrl+Y and Shift+Ctrl+Z redo
//
// Lines for Up/Down are visual lines (soft wraps included); they come from the
// caller, which can measure the field. Home/End and the line keys use lines
// separated by line breaks.

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface FieldState {
  value: string;
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
  multiline: boolean;
}

export type EditAction =
  /** Move the selection. `anchor` stays, `focus` is where the caret goes. */
  | { type: "select"; anchor: number; focus: number }
  /** Replace [start, end) with `text`. */
  | { type: "edit"; start: number; end: number; text: string; inputType: string }
  | { type: "submit" }
  | { type: "undo" }
  | { type: "redo" };

export interface EditContext {
  apple: boolean;
  /**
   * The index on the visual line above (-1) or below (+1) `index`, or a page
   * (the field's visible height) away; null past the first or last line.
   */
  verticalTarget: (index: number, direction: -1 | 1, page: boolean) => number | null;
}

/** Code-point-safe step left or right. */
function charStep(value: string, index: number, direction: -1 | 1): number {
  if (direction < 0) {
    if (index <= 0) return 0;
    const low = value.charCodeAt(index - 1);
    return index >= 2 && low >= 0xdc00 && low <= 0xdfff ? index - 2 : index - 1;
  }
  if (index >= value.length) return value.length;
  const high = value.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && index + 1 < value.length ? index + 2 : index + 1;
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/** Word segments of the value: [start, end, isWord]. Falls back to runs of letters/digits. */
function words(value: string): [number, number, boolean][] {
  if (segmenter) {
    return Array.from(segmenter.segment(value), (s) => [
      s.index,
      s.index + s.segment.length,
      s.isWordLike ?? false,
    ]);
  }
  const result: [number, number, boolean][] = [];
  for (const match of value.matchAll(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu)) {
    result.push([match.index, match.index + match[0].length, /[\p{L}\p{N}_]/u.test(match[0])]);
  }
  return result;
}

/** The start of the word before `index` (skipping what is not a word). */
export function wordStart(value: string, index: number): number {
  let result = 0;
  for (const [start, , isWord] of words(value)) {
    if (start >= index) break;
    if (isWord) result = start;
  }
  return result;
}

/**
 * Where a word step to the right from `index` lands: the end of the next word
 * (macOS), or the start of the word after it (elsewhere).
 */
export function wordEnd(value: string, index: number, apple: boolean): number {
  for (const [start, end, isWord] of words(value)) {
    if (!isWord) continue;
    if (apple ? end > index : start > index) return apple ? end : start;
  }
  return value.length;
}

/** The word around `index`, for a double click: [start, end). */
export function wordAt(value: string, index: number): [number, number] {
  for (const [start, end] of words(value)) {
    if (index >= start && index < end) return [start, end];
  }
  return [index, index];
}

export function lineStart(value: string, index: number): number {
  return value.lastIndexOf("\n", index - 1) + 1;
}

export function lineEnd(value: string, index: number): number {
  const next = value.indexOf("\n", index);
  return next === -1 ? value.length : next;
}

/** The shortcut key (Cmd+A, Ctrl+C): Cmd on Apple platforms, Ctrl elsewhere, without the other. */
export const primaryModifier = (input: KeyInput, apple: boolean) =>
  apple ? input.metaKey && !input.ctrlKey : input.ctrlKey && !input.metaKey;
/** The key that moves or deletes by word: Option on Apple platforms, Ctrl elsewhere, alone. */
export const wordModifier = (input: KeyInput, apple: boolean) =>
  apple
    ? input.altKey && !input.metaKey && !input.ctrlKey
    : input.ctrlKey && !input.altKey && !input.metaKey;
/** The key that moves or deletes to the line's end: Cmd alone, on Apple platforms only. */
export const lineModifier = (input: KeyInput, apple: boolean) =>
  apple && input.metaKey && !input.altKey && !input.ctrlKey;

/** What a key does in a text field, or null if it does nothing there. */
export function editAction(
  field: FieldState,
  input: KeyInput,
  context: EditContext,
): EditAction | null {
  const { value, start, end, multiline } = field;
  const { apple } = context;
  const collapsed = start === end;
  const backward = field.direction === "backward";
  const anchor = backward ? end : start;
  const focus = backward ? start : end;

  /** Moves the caret to `target`, or extends the selection there with Shift. */
  const moveTo = (target: number, extend = input.shiftKey): EditAction =>
    extend
      ? { type: "select", anchor, focus: target }
      : { type: "select", anchor: target, focus: target };
  const remove = (from: number, to: number, inputType: string): EditAction | null => {
    if (!collapsed) return { type: "edit", start, end, text: "", inputType };
    const [a, b] = from < to ? [from, to] : [to, from];
    return a === b ? null : { type: "edit", start: a, end: b, text: "", inputType };
  };
  const vertical = (direction: -1 | 1, page = false): EditAction => {
    const target = context.verticalTarget(focus, direction, page);
    return moveTo(target ?? (direction < 0 ? 0 : value.length));
  };

  // The Emacs keys of macOS.
  if (apple && input.ctrlKey && !input.metaKey && !input.altKey) {
    switch (input.key.toLowerCase()) {
      case "a":
        return moveTo(lineStart(value, focus));
      case "e":
        return moveTo(lineEnd(value, focus));
      case "b":
        return moveTo(charStep(value, focus, -1));
      case "f":
        return moveTo(charStep(value, focus, 1));
      case "p":
        return multiline ? vertical(-1) : moveTo(0);
      case "n":
        return multiline ? vertical(1) : moveTo(value.length);
      case "h":
        return remove(charStep(value, start, -1), start, "deleteContentBackward");
      case "d":
        return remove(end, charStep(value, end, 1), "deleteContentForward");
      case "k": {
        // To the end of the line, or the line break itself at the end of a line.
        const to = lineEnd(value, end);
        return collapsed
          ? remove(end, to === end ? charStep(value, end, 1) : to, "deleteContentForward")
          : remove(start, end, "deleteContentForward");
      }
      default:
        return null;
    }
  }

  const word = wordModifier(input, apple);
  const toLine = lineModifier(input, apple);
  const toDocument =
    (!apple && input.ctrlKey && !input.altKey && !input.metaKey) || (apple && input.metaKey);

  switch (input.key) {
    case "ArrowLeft":
      if (toLine) return moveTo(lineStart(value, focus));
      if (word) return moveTo(wordStart(value, focus));
      // Without Shift, a selection collapses to its start.
      if (!collapsed && !input.shiftKey) return moveTo(start);
      return moveTo(charStep(value, focus, -1));
    case "ArrowRight":
      if (toLine) return moveTo(lineEnd(value, focus));
      if (word) return moveTo(wordEnd(value, focus, apple));
      if (!collapsed && !input.shiftKey) return moveTo(end);
      return moveTo(charStep(value, focus, 1));
    case "ArrowUp":
    case "PageUp":
      if ((apple && input.metaKey) || !multiline) return moveTo(0);
      return vertical(-1, input.key === "PageUp");
    case "ArrowDown":
    case "PageDown":
      if ((apple && input.metaKey) || !multiline) return moveTo(value.length);
      return vertical(1, input.key === "PageDown");
    case "Home":
      return moveTo(toDocument || !multiline ? 0 : lineStart(value, focus));
    case "End":
      return moveTo(toDocument || !multiline ? value.length : lineEnd(value, focus));
    case "Backspace":
      if (toLine) return remove(lineStart(value, start), start, "deleteSoftLineBackward");
      if (word) return remove(wordStart(value, start), start, "deleteWordBackward");
      return remove(charStep(value, start, -1), start, "deleteContentBackward");
    case "Delete":
      if (word) return remove(end, wordEnd(value, end, apple), "deleteWordForward");
      return remove(end, charStep(value, end, 1), "deleteContentForward");
    case "Enter":
      return multiline
        ? { type: "edit", start, end, text: "\n", inputType: "insertLineBreak" }
        : { type: "submit" };
  }

  // Select all, undo and redo: with Cmd on macOS, Ctrl elsewhere.
  const command = primaryModifier(input, apple) && !input.altKey;
  if (!command) return null;
  switch (input.key.toLowerCase()) {
    case "a":
      return { type: "select", anchor: 0, focus: value.length };
    case "z":
      return { type: input.shiftKey ? "redo" : "undo" };
    case "y":
      return apple ? null : { type: "redo" };
  }
  return null;
}
