// Scrollbars of the panel page, drawn and operated by the agent.
//
// The browser's own scrollbars do not work in a panel. The copy of a scroll
// container in the image is never scrolled (snapshot.ts shifts its children
// instead), so its scrollbar would always show the top. And a synthetic press
// cannot grab a real scrollbar. So the snapshot hides the real scrollbars and
// draws these instead, and presses on them are handled in input.ts, both from
// the geometry computed here.

import type { Box } from "../../types";
import { deepElementFromPoint, flatParent } from "../flat-tree";

export type Axis = "x" | "y";

export interface Scrollbar {
  /** The scroll container; `document.scrollingElement` for the viewport. */
  element: Element;
  axis: Axis;
  track: Box;
  thumb: Box;
  /** The browser reserves room for this scrollbar (a classic, not an overlay, scrollbar). */
  gutter: boolean;
}

/** The thickness of a scrollbar where the browser reserves no room for it. */
const OVERLAY_THICKNESS = 10;
const MIN_THUMB_LENGTH = 24;
const SCROLLABLE = new Set(["auto", "scroll", "overlay"]);
/** Single-line inputs scroll without a scrollbar. */
const SKIPPED = new Set(["INPUT"]);

/** A list box (<select multiple>, or with a size above 1) scrolls its options; a drop-down one draws its own list. */
function isListBox(element: Element): boolean {
  const select = element as HTMLSelectElement;
  return element.tagName === "SELECT" && (select.multiple || select.size > 1);
}

export function contains(box: Box, x: number, y: number): boolean {
  return x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;
}

/** The range the thumb can travel along the track, in CSS pixels. */
export function thumbTravel(bar: Scrollbar): number {
  return bar.axis === "y" ? bar.track.height - bar.thumb.height : bar.track.width - bar.thumb.width;
}

/** How far the element can scroll along the scrollbar's axis. */
export function maxScroll(bar: Scrollbar): number {
  const { element } = bar;
  return bar.axis === "y"
    ? element.scrollHeight - element.clientHeight
    : element.scrollWidth - element.clientWidth;
}

interface Overflow {
  x: string;
  y: string;
}

/** The overflow that applies to the element, or null if it is not a scroll container of its own. */
function overflowOf(element: Element, style?: CSSStyleDeclaration): Overflow | null {
  const document = element.ownerDocument;
  const window = document.defaultView!;
  if (element !== document.scrollingElement && element !== document.body) {
    const computed = style ?? window.getComputedStyle(element);
    return { x: computed.overflowX, y: computed.overflowY };
  }
  const html = window.getComputedStyle(document.documentElement);
  if (element === document.scrollingElement) {
    // The viewport takes its overflow from <html>, or from <body> when <html> leaves it visible.
    const body = document.body ? window.getComputedStyle(document.body) : html;
    const pick = (own: string, fromBody: string) => {
      const value = own !== "visible" ? own : fromBody;
      return value === "visible" ? "auto" : value;
    };
    return { x: pick(html.overflowX, body.overflowX), y: pick(html.overflowY, body.overflowY) };
  }
  // <body>'s overflow went to the viewport.
  if (html.overflowX === "visible" && html.overflowY === "visible") return null;
  const computed = window.getComputedStyle(element);
  return { x: computed.overflowX, y: computed.overflowY };
}

/**
 * The scrollbars an element shows right now, if any. `style` is its computed
 * style, when the caller has it already.
 */
export function scrollbarsOf(element: Element, style?: CSSStyleDeclaration): Scrollbar[] {
  if (SKIPPED.has(element.tagName) || (element.tagName === "SELECT" && !isListBox(element)))
    return [];
  // This runs for every element of every frame. Checking the overflow style
  // first is cheaper than reading sizes, and rules out all but scroll containers.
  // A list box scrolls up and down, whatever its computed overflow.
  const overflow = isListBox(element) ? { x: "hidden", y: "auto" } : overflowOf(element, style);
  if (!overflow || (!SCROLLABLE.has(overflow.x) && !SCROLLABLE.has(overflow.y))) return [];
  const { clientWidth, clientHeight, scrollWidth, scrollHeight } = element;
  const overflowsX = scrollWidth > clientWidth + 1;
  const overflowsY = scrollHeight > clientHeight + 1;
  const showX = overflowsX && SCROLLABLE.has(overflow.x);
  const showY = overflowsY && SCROLLABLE.has(overflow.y);
  if (!showX && !showY) return [];

  const document = element.ownerDocument;
  const window = document.defaultView!;
  // The padding box, where content scrolls, and the room reserved beside it.
  let client: Box;
  let gutterX: number;
  let gutterY: number;
  if (element === document.scrollingElement) {
    client = { left: 0, top: 0, width: clientWidth, height: clientHeight };
    gutterY = window.innerWidth - clientWidth;
    gutterX = window.innerHeight - clientHeight;
  } else {
    const computed = style ?? window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const border = (side: string) =>
      parseFloat(computed.getPropertyValue(`border-${side}-width`)) || 0;
    const html = element as HTMLElement;
    client = {
      left: rect.left + border("left"),
      top: rect.top + border("top"),
      width: clientWidth,
      height: clientHeight,
    };
    gutterY = (html.offsetWidth ?? 0) - clientWidth - border("left") - border("right");
    gutterX = (html.offsetHeight ?? 0) - clientHeight - border("top") - border("bottom");
  }
  const thicknessY = gutterY > 0 ? gutterY : OVERLAY_THICKNESS;
  const thicknessX = gutterX > 0 ? gutterX : OVERLAY_THICKNESS;

  const bars: Scrollbar[] = [];
  if (showY) {
    // A reserved gutter is outside the padding box; an overlay scrollbar is inside it.
    const track: Box = {
      left: gutterY > 0 ? client.left + client.width : client.left + client.width - thicknessY,
      top: client.top,
      width: thicknessY,
      // Leave the corner to the horizontal scrollbar.
      height: client.height - (showX && gutterX <= 0 ? thicknessX : 0),
    };
    const length = Math.min(
      track.height,
      Math.max(MIN_THUMB_LENGTH, (track.height * clientHeight) / scrollHeight),
    );
    const ratio = element.scrollTop / Math.max(1, scrollHeight - clientHeight);
    const thumb: Box = {
      ...track,
      top: track.top + (track.height - length) * ratio,
      height: length,
    };
    bars.push({ element, axis: "y", track, thumb, gutter: gutterY > 0 });
  }
  if (showX) {
    const track: Box = {
      left: client.left,
      top: gutterX > 0 ? client.top + client.height : client.top + client.height - thicknessX,
      width: client.width - (showY && gutterY <= 0 ? thicknessY : 0),
      height: thicknessX,
    };
    const length = Math.min(
      track.width,
      Math.max(MIN_THUMB_LENGTH, (track.width * clientWidth) / scrollWidth),
    );
    const ratio = element.scrollLeft / Math.max(1, scrollWidth - clientWidth);
    const thumb: Box = {
      ...track,
      left: track.left + (track.width - length) * ratio,
      width: length,
    };
    bars.push({ element, axis: "x", track, thumb, gutter: gutterX > 0 });
  }
  return bars;
}

/** How far a scrollbar can be hit beyond its track, toward the content: thin ones are hard to hit. */
const HIT_SLOP = 4;

/** `box` (the track or the thumb) widened toward the content by the hit slop. */
export function hitBox(bar: Scrollbar, box: Box): Box {
  return bar.axis === "y"
    ? { ...box, left: box.left - HIT_SLOP, width: box.width + HIT_SLOP }
    : { ...box, top: box.top - HIT_SLOP, height: box.height + HIT_SLOP };
}

/** The innermost scrollbar under a point, if any. */
export function scrollbarAt(document: Document, x: number, y: number): Scrollbar | null {
  const chain: Element[] = [];
  for (let node = deepElementFromPoint(document, x, y); node; node = flatParent(node))
    chain.push(node);
  const root = document.scrollingElement;
  if (root && !chain.includes(root)) chain.push(root);
  for (const element of chain) {
    for (const bar of scrollbarsOf(element)) if (contains(hitBox(bar, bar.track), x, y)) return bar;
  }
  return null;
}
