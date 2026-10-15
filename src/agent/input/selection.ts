// The page's own selection (window.getSelection()) outside <input> and
// <textarea>: text selected by dragging over the page, and the caret and
// selection of contenteditable elements.
//
// Untrusted mousedown does not move it, so presses and drags place it here
// (input.ts). It is the page's real selection: the page reads it with
// getSelection(), and Selection.modify() and execCommand() act on it
// (contenteditable.ts). The image cannot show it, so it is measured here and
// drawn over the copy, like a text field's selection.

import type { Box, FrameWindow } from "../../types";
import { wordAt } from "./editing";
import { topLayerStates } from "./top-layer";

/** A position in the page's text: a node and an offset in it, as in a Range. */
export interface Point {
  node: Node;
  offset: number;
}

/** The most boxes measured for a selection; a selection of a whole long page draws its first ones. */
const MAX_SELECTION_BOXES = 2000;

const windowOf = (node: Node) =>
  (node.ownerDocument ?? (node as Document)).defaultView as FrameWindow;

const elementOf = (node: Node): Element | null =>
  node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;

/** The outermost contenteditable element `node` is in (the editing host), or null. */
export function editingHostOf(node: Node | null): HTMLElement | null {
  const start = node ? elementOf(node) : null;
  if (!start) return null;
  const { HTMLElement } = windowOf(start);
  if (!(start instanceof HTMLElement) || !start.isContentEditable) return null;
  let host: HTMLElement = start;
  while (host.parentElement instanceof HTMLElement && host.parentElement.isContentEditable)
    host = host.parentElement;
  return host;
}

/**
 * Whether text in `element` can be selected: not where user-select is none
 * (unless it is editable, which is always selectable).
 */
function isSelectable(element: Element): boolean {
  const window = windowOf(element);
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node instanceof window.HTMLElement && node.isContentEditable) return true;
    const style = window.getComputedStyle(node) as CSSStyleDeclaration & {
      webkitUserSelect?: string;
    };
    const value = style.userSelect || style.webkitUserSelect || "auto";
    if (value === "none") return false;
    if (value === "text" || value === "all") return true;
  }
  return true;
}

/**
 * The text position at a point (CSS px of the viewport), or null where there is
 * none to select: outside text, in a text field (whose text is its own), or
 * where user-select is none.
 */
export function pointAt(document: Document, x: number, y: number): Point | null {
  const point = caretPoint(document, x, y);
  if (!point) return null;
  const element = elementOf(point.node);
  if (!element || element.closest("input, textarea, select") || !isSelectable(element)) return null;
  return point;
}

/** Where the browser would put a caret for a point (CSS px of the viewport), anywhere; null if nowhere. */
export function caretPoint(document: Document, x: number, y: number): Point | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    return position && { node: position.offsetNode, offset: position.offset };
  }
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    return range && { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

/** -1 if `a` comes before `b` in the document, 1 after, 0 if they are the same position. */
export function comparePoints(a: Point, b: Point): -1 | 0 | 1 {
  const range = (a.node.ownerDocument ?? (a.node as Document)).createRange();
  range.setStart(a.node, a.offset);
  // comparePoint tells where `b` is relative to the collapsed range at `a`.
  return -range.comparePoint(b.node, b.offset) as -1 | 0 | 1;
}

/** The word at a text position, as two positions; just the position where there is no word. */
export function wordAround(point: Point): [Point, Point] {
  if (point.node.nodeType !== Node.TEXT_NODE) return [point, point];
  const [start, end] = wordAt((point.node as Text).data, point.offset);
  return [
    { node: point.node, offset: start },
    { node: point.node, offset: end },
  ];
}

/** The nearest element that is not inline (the block whose lines an element's text is laid out in). */
function blockOf(element: Element): Element {
  const window = windowOf(element);
  let block = element;
  while (block.parentElement && /^(inline|contents)/.test(window.getComputedStyle(block).display))
    block = block.parentElement;
  return block;
}

/** The block (paragraph, list item...) a text position is in, as two positions spanning its content. */
export function blockAround(point: Point): [Point, Point] {
  const element = elementOf(point.node);
  if (!element) return [point, point];
  const block = blockOf(element);
  return [
    { node: block, offset: 0 },
    { node: block, offset: block.childNodes.length },
  ];
}

/** The page's selection, if it is not collapsed (an editable's caret is collapsed). */
export function selectedRange(window: FrameWindow): Range | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  return selection.getRangeAt(0);
}

/**
 * Whether an element hides what overflows its padding box. Overflow does not
 * apply to an inline box (nor to display: contents, which has none), whatever
 * its computed value.
 */
function clipsOverflow(style: CSSStyleDeclaration): boolean {
  return (
    !/^(inline|contents)$/.test(style.display) &&
    (style.overflowX !== "visible" || style.overflowY !== "visible")
  );
}

/** Whether an element is the containing block of its position: fixed descendants (else the viewport is). */
function holdsFixed(style: CSSStyleDeclaration): boolean {
  const s = style as CSSStyleDeclaration & { backdropFilter?: string };
  return (
    (s.transform !== "" && s.transform !== "none") ||
    (s.perspective !== "" && s.perspective !== "none") ||
    (s.filter !== "" && s.filter !== "none") ||
    (s.backdropFilter !== undefined && s.backdropFilter !== "" && s.backdropFilter !== "none") ||
    /\b(paint|layout|strict|content)\b/.test(s.contain ?? "") ||
    /\b(transform|perspective|filter)\b/.test(s.willChange ?? "")
  );
}

/**
 * The ancestor whose content an element's box is part of, for clipping: its
 * containing block's chain. A positioned element skips the boxes in between,
 * whose overflow does not clip it; null for the viewport.
 */
function clippingParentOf(element: Element, style: CSSStyleDeclaration): Element | null {
  // Nothing clips the top layer but the viewport.
  if (topLayerStates(element)) return null;
  const window = windowOf(element);
  const { position } = style;
  let ancestor = element.parentElement;
  if (position !== "fixed" && position !== "absolute") return ancestor;
  for (; ancestor; ancestor = ancestor.parentElement) {
    const ancestorStyle = window.getComputedStyle(ancestor);
    if (holdsFixed(ancestorStyle)) return ancestor;
    if (position === "absolute" && ancestorStyle.position !== "static") return ancestor;
  }
  return null;
}

/** What clips an element's own box: its clipping parents' overflow, up to the viewport. */
function clipAbove(element: Element, viewport: Box, cache: Map<Element, Box>): Box {
  const parent = clippingParentOf(element, windowOf(element).getComputedStyle(element));
  return parent ? clipInside(parent, viewport, cache) : viewport;
}

/**
 * The part of the viewport where an element's in-flow content shows: what
 * clips the element itself, cut by its padding box if it hides overflow.
 */
function clipInside(element: Element, viewport: Box, cache: Map<Element, Box>): Box {
  const cached = cache.get(element);
  if (cached) return cached;
  let clip = clipAbove(element, viewport, cache);
  const document = element.ownerDocument;
  // The document's own overflow is the viewport's.
  if (
    element !== document.documentElement &&
    element !== document.body &&
    clipsOverflow(windowOf(element).getComputedStyle(element))
  ) {
    clip = intersect(clip, paddingBox(element));
  }
  cache.set(element, clip);
  return clip;
}

/**
 * The part of the viewport where an element's content shows: cut by every
 * ancestor that clips what overflows it, and by its own padding box if it
 * clips too (a text field always does). An inline element, or one whose
 * overflow is visible, shows its content past its box.
 */
export function visibleBoxOf(element: Element): Box {
  const outer = clipAbove(element, viewportOf(element.ownerDocument), new Map());
  const style = windowOf(element).getComputedStyle(element);
  if (!element.matches("input, textarea") && !clipsOverflow(style)) return outer;
  return intersect(outer, paddingBox(element));
}

/**
 * A caret cut to what shows of it, as browsers draw it: the part outside the
 * box is not drawn (a line scrolled half out of a field). Null if none shows.
 */
export function clipCaret<T extends { x: number; y: number; height: number }>(
  caret: T,
  box: Box,
): T | null {
  // A caret at the very edge of the box (the end of a full line) still shows.
  if (caret.x < box.left - 1 || caret.x > box.left + box.width + 1) return null;
  const top = Math.max(caret.y, box.top);
  const bottom = Math.min(caret.y + caret.height, box.top + box.height);
  if (bottom - top < 1) return null;
  return { ...caret, y: top, height: bottom - top };
}

/** An element's padding box (where its content shows), in CSS px of the viewport. */
export function paddingBox(element: Element, rect = element.getBoundingClientRect()): Box {
  return {
    left: rect.left + element.clientLeft,
    top: rect.top + element.clientTop,
    width: element.clientWidth,
    height: element.clientHeight,
  };
}

/** The viewport, without its scrollbars. */
const viewportOf = (document: Document): Box => ({
  left: 0,
  top: 0,
  width: document.documentElement.clientWidth,
  height: document.documentElement.clientHeight,
});

export function intersect(a: Box, b: Box): Box {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * The boxes the selected text covers, in CSS px of the viewport: one per line
 * of each text node, cut to what is shown (a scrolled box hides the rest).
 * Measured per text node: a range's own rectangles would also cover every
 * element it contains whole.
 */
/** A box of the page's selection, and the text it is of (drawn over that text's top layer element, if any). */
export interface SelectionBox extends Box {
  text: Text;
}

export function selectionBoxes(window: FrameWindow, range: Range): SelectionBox[] {
  const document = window.document;
  const viewport = viewportOf(document);
  const clips = new Map<Element, Box>();
  const boxes: SelectionBox[] = [];
  const root = range.commonAncestorContainer;
  const texts: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) texts.push(root as Text);
  else {
    const walker = document.createTreeWalker(root, window.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (range.intersectsNode(node)) texts.push(node as Text);
    }
  }
  const part = document.createRange();
  for (const text of texts) {
    const parent = text.parentElement;
    if (!parent || parent.closest("script, style, textarea, select")) continue;
    part.setStart(text, text === range.startContainer ? range.startOffset : 0);
    part.setEnd(text, text === range.endContainer ? range.endOffset : text.length);
    if (part.collapsed) continue;
    const clip = clipInside(parent, viewport, clips);
    for (const rect of Array.from(part.getClientRects())) {
      const box = intersect(clip, rect);
      if (box.width > 0 && box.height > 0) boxes.push({ ...box, text });
      if (boxes.length === MAX_SELECTION_BOXES) return boxes;
    }
  }
  return boxes;
}

/**
 * The selected text as it reads on screen, for copying: white space collapsed
 * where CSS collapses it, a line break for <br> and between blocks. The
 * selection's own toString() gives the source's white space in some browsers
 * when the page is not painted (the panel's iframe is transparent).
 * Stops once the text is longer than `limit` (the caller then drops it).
 */
export function selectedText(window: FrameWindow, range: Range, limit = Infinity): string {
  const document = window.document;
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(
    root,
    window.NodeFilter.SHOW_TEXT | window.NodeFilter.SHOW_ELEMENT,
  );
  const nodes: Node[] = root.nodeType === Node.TEXT_NODE ? [root] : [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (range.intersectsNode(node)) nodes.push(node);
  // Text nodes share their parents and blocks: look each element up once.
  const blocks = new Map<Element, Element | null>();
  /** Each parent's white-space, or null where its text is not shown. */
  const spaces = new Map<Element, string | null>();
  const blockOf = (element: Element): Element | null => {
    const known = blocks.get(element);
    if (known !== undefined) return known;
    const parent = element.parentElement;
    const block =
      parent && /^(inline|contents)/.test(window.getComputedStyle(element).display)
        ? blockOf(parent)
        : element;
    blocks.set(element, block);
    return block;
  };
  let text = "";
  let lastBlock: Element | null = null;
  const breakLine = () => {
    text = text.replace(/ +$/, "");
    if (text !== "" && !text.endsWith("\n")) text += "\n";
  };
  for (const node of nodes) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if ((node as Element).tagName === "BR") {
        text = text.replace(/ +$/, "") + "\n";
      }
      continue;
    }
    const parent = node.parentElement;
    if (!parent) continue;
    let space = spaces.get(parent);
    if (space === undefined) {
      const style = window.getComputedStyle(parent);
      const hidden =
        parent.closest("script, style, textarea, select, noscript, template") !== null ||
        style.display === "none" ||
        style.visibility === "hidden";
      space = hidden ? null : style.whiteSpace;
      spaces.set(parent, space);
    }
    if (space === null) continue;
    const block = blockOf(parent);
    if (lastBlock && block !== lastBlock) breakLine();
    lastBlock = block;
    const data = (node as Text).data;
    let part = data.slice(
      node === range.startContainer ? range.startOffset : 0,
      node === range.endContainer ? range.endOffset : data.length,
    );
    if (space === "pre-line") part = part.replace(/[ \t]+/g, " ");
    else if (!/^(pre|break-spaces)/.test(space)) {
      part = part.replace(/[ \t\n\r\f]+/g, " ");
      // Collapsed white space at the start of a line is not shown.
      if (text === "" || text.endsWith("\n") || text.endsWith(" ")) part = part.replace(/^ /, "");
    }
    text += part;
    if (text.length > limit) return text;
  }
  return text.replace(/ +$/, "");
}

/** The page's ::selection background where the selection starts, if it sets one. */
export function selectionColorAt(window: FrameWindow, range: Range): string | undefined {
  const element = elementOf(range.startContainer);
  return element ? window.getComputedStyle(element, "::selection").backgroundColor : undefined;
}

/** A CSS font shorthand for an element's text, for measuring it on a canvas. */
export function fontOf(element: Element): string {
  const style = windowOf(element).getComputedStyle(element);
  return (
    style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  );
}

let measuringContext: CanvasRenderingContext2D | null | undefined;

/** How wide `text` is in `font` (CSS px). */
export function textWidth(document: Document, font: string, text: string): number {
  if (measuringContext === undefined)
    measuringContext = document.createElement("canvas").getContext("2d");
  if (!measuringContext) return text.length * 8;
  measuringContext.font = font;
  return measuringContext.measureText(text).width;
}

/**
 * Where the caret of a collapsed selection in an editable is (CSS px of the
 * viewport). `extra` is text that is not in the page yet but shows before the
 * caret (being composed with an IME): it is laid out from the caret, a
 * character at a time, wrapping at the end of the line of its block, as
 * Japanese text does (it may break between any two characters).
 */
export function caretAtPoint(
  point: Point,
  extra = "",
): { x: number; y: number; height: number } | null {
  const document = point.node.ownerDocument;
  const container = elementOf(point.node);
  if (!document || !container) return null;
  const style = windowOf(container).getComputedStyle(container);
  const fontSize = parseFloat(style.fontSize) || 16;
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.2;
  let x: number;
  let top: number;
  let height: number;
  if (point.node.nodeType === Node.TEXT_NODE) {
    const text = point.node as Text;
    const range = document.createRange();
    // A collapsed range has no box in some browsers: measure the character after, or before.
    let rect: DOMRect | null = null;
    let after = false;
    if (point.offset < text.length) {
      range.setStart(text, point.offset);
      range.setEnd(text, point.offset + 1);
      rect = range.getClientRects()[0] ?? null;
    }
    if (!rect && point.offset > 0) {
      range.setStart(text, point.offset - 1);
      range.setEnd(text, point.offset);
      const rects = range.getClientRects();
      rect = rects[rects.length - 1] ?? null;
      after = true;
    }
    if (!rect) return null;
    x = after ? rect.right : rect.left;
    top = rect.top;
    height = rect.height;
  } else {
    const child = point.node.childNodes[point.offset] ?? null;
    const before = point.node.childNodes[point.offset - 1] ?? null;
    if (child?.nodeType === Node.TEXT_NODE && (child as Text).length > 0) {
      return caretAtPoint({ node: child, offset: 0 }, extra);
    }
    if (before?.nodeType === Node.TEXT_NODE && (before as Text).length > 0) {
      return caretAtPoint({ node: before, offset: (before as Text).length }, extra);
    }
    if (child?.nodeType === Node.ELEMENT_NODE) {
      // A <br> (an empty line) or another element: the caret is at its start.
      const rect = (child as Element).getBoundingClientRect();
      x = rect.left;
      top = rect.top;
      height = rect.height;
    } else {
      // An empty element: inside its padding.
      const rect = container.getBoundingClientRect();
      x = rect.left + container.clientLeft + (parseFloat(style.paddingLeft) || 0);
      top = rect.top + container.clientTop + (parseFloat(style.paddingTop) || 0);
      height = lineHeight;
    }
  }
  if (!(height > 0) || height > lineHeight * 2) height = lineHeight;
  if (extra) {
    const block = blockOf(container);
    const blockStyle = windowOf(block).getComputedStyle(block);
    const box = block.getBoundingClientRect();
    const lineLeft = box.left + block.clientLeft + (parseFloat(blockStyle.paddingLeft) || 0);
    const lineRight =
      box.left + block.clientLeft + block.clientWidth - (parseFloat(blockStyle.paddingRight) || 0);
    const font = fontOf(container);
    for (const character of extra) {
      const width = textWidth(document, font, character);
      // A character that does not fit goes to the next line (unless the line is empty).
      if (x + width > lineRight + 0.5 && x > lineLeft + 0.5) {
        x = lineLeft;
        top += lineHeight;
      }
      x += width;
    }
  }
  return { x, y: top, height };
}
