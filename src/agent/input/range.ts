// Sliders: <input type="range">.
//
// A synthetic press does not move a slider's thumb (WebKit's does, to where it
// was pressed, but does not follow a drag), and synthetic keys do not step it.
// input.ts does, as browsers do: a press sets the value where it lands, a drag
// follows the pointer, and the arrows, Page Up/Down, Home and End step it. The
// image draws the thumb from the value (see the snapshot's form state).

import type { FrameWindow } from "../../types";

export function isRange(element: Element | null): element is HTMLInputElement {
  if (!element) return false;
  const { HTMLInputElement } = element.ownerDocument.defaultView as FrameWindow;
  return element instanceof HTMLInputElement && element.type === "range" && !element.disabled;
}

/**
 * About how wide browsers draw the thumb (CSS px). Its middle goes from half of
 * it in from one end to half of it in from the other: a press there is the
 * minimum or the maximum. A page that styles a larger thumb is a few px off.
 */
const THUMB_SIZE = 16;

/** Page Up and Page Down step by this share of the range (or by one step, if more). */
const PAGE_SHARE = 0.1;

interface Bounds {
  min: number;
  max: number;
  /** 0 for step="any". */
  step: number;
}

const parse = (value: string, fallback: number) => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
};

/** The slider's minimum, maximum and step, with the defaults browsers use. */
export function boundsOf(slider: HTMLInputElement): Bounds {
  const min = parse(slider.min, 0);
  // A maximum below the minimum is the minimum.
  const max = Math.max(min, parse(slider.max, 100));
  const step = slider.getAttribute("step")?.trim().toLowerCase() ?? "";
  if (step === "any") return { min, max, step: 0 };
  // A missing, zero or negative step is the default one.
  const parsed = parse(step, 1);
  return { min, max, step: parsed > 0 ? parsed : 1 };
}

/**
 * Decimal places of a number, to round sums of steps (0.1 + 0.2) back to them.
 * Small numbers are written with an exponent: 1.5e-7 has 8.
 */
const decimals = (value: number) => {
  const [mantissa = "", exponent = "0"] = String(value).toLowerCase().split("e");
  const fraction = mantissa.split(".")[1] ?? "";
  return Math.min(100, Math.max(0, fraction.length - Number(exponent)));
};

/**
 * The value nearest to `value` that the slider allows, as browsers sanitize it:
 * on a step from the minimum, within the range (the last step at most), the
 * higher one when two are as near.
 */
export function snap(value: number, { min, max, step }: Bounds): number {
  const clamped = Math.min(max, Math.max(min, value));
  if (step === 0) return clamped;
  const places = Math.max(decimals(step), decimals(min));
  const round = (number: number) => Number(number.toFixed(places));
  let snapped = round(min + Math.round((clamped - min) / step) * step);
  if (snapped > max) snapped = round(snapped - step);
  return snapped;
}

/** Whether the slider is drawn upright (a vertical writing mode), and runs from its far end (right to left, or bottom to top). */
function layoutOf(slider: HTMLInputElement): { vertical: boolean; reversed: boolean } {
  const style = (slider.ownerDocument.defaultView as FrameWindow).getComputedStyle(slider);
  const vertical = /^(vertical|sideways)/.test(style.writingMode);
  return { vertical, reversed: style.direction === "rtl" };
}

/** The value at a point of the page (CSS px), as a press there sets it. */
export function valueAt(slider: HTMLInputElement, x: number, y: number): number {
  const bounds = boundsOf(slider);
  const rect = slider.getBoundingClientRect();
  const { vertical, reversed } = layoutOf(slider);
  const start = vertical ? rect.top : rect.left;
  const length = vertical ? rect.height : rect.width;
  const thumb = Math.min(THUMB_SIZE, length / 2);
  const travel = length - thumb;
  let fraction = travel > 0 ? ((vertical ? y : x) - start - thumb / 2) / travel : 0;
  fraction = Math.min(1, Math.max(0, fraction));
  if (reversed) fraction = 1 - fraction;
  return snap(bounds.min + fraction * (bounds.max - bounds.min), bounds);
}

/**
 * The value a key steps the slider to, or null for a key that does not: the
 * arrows by a step (up and right go up, left and down go down, mirrored right
 * to left), Page Up and Down by a tenth of the range, Home and End to the ends.
 */
export function valueAfterKey(slider: HTMLInputElement, key: string): number | null {
  const bounds = boundsOf(slider);
  const { min, max } = bounds;
  const step = bounds.step || (max - min) / 100;
  const page = Math.max(step, (max - min) * PAGE_SHARE);
  const { vertical, reversed } = layoutOf(slider);
  const current = parse(slider.value, min);
  // Right to left, the arrow toward the minimum's end (right) goes down.
  const flip = reversed && !vertical ? -1 : 1;
  const by = new Map([
    ["ArrowUp", step],
    ["ArrowRight", step * flip],
    ["ArrowDown", -step],
    ["ArrowLeft", -step * flip],
    ["PageUp", page],
    ["PageDown", -page],
  ]).get(key);
  if (key === "Home") return min;
  if (key === "End") return snap(max, bounds);
  if (by === undefined) return null;
  const next = snap(current + by, bounds);
  // A page or step smaller than the step snaps back: go on to the next step.
  if (next === current && bounds.step > 0)
    return snap(current + Math.sign(by) * bounds.step, bounds);
  return next;
}

/** Sets the slider's value and tells the page (input), as moving the thumb does. False if it did not change. */
export function setRangeValue(slider: HTMLInputElement, value: number): boolean {
  const text = String(value);
  if (slider.value === text) return false;
  slider.value = text;
  const { Event } = slider.ownerDocument.defaultView as FrameWindow;
  slider.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  return true;
}

/** Tells the page the value was committed (change), as releasing the thumb or a key does. */
export function announceRangeChange(slider: HTMLInputElement): void {
  const { Event } = slider.ownerDocument.defaultView as FrameWindow;
  slider.dispatchEvent(new Event("change", { bubbles: true }));
}
