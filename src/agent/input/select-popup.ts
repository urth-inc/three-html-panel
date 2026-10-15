// The list a drop-down <select> opens.
//
// A browser draws that list itself, outside the page; it is not in the image,
// and a synthetic press does not open it anyway. So the agent keeps its own:
// it opens on a press on the <select> (or on the keys that open it), is drawn
// over the copy like the scrollbars (snapshot.ts), and takes the pointer, the
// wheel and the keys while it is open (input.ts). Choosing an option sets it
// and fires input and change, as the browser's list does.

import type { Box, FrameWindow } from "../../types";
import { announceChange, nextMatch, stepOption } from "./list-box";
import { contains } from "./scrollbars";
import { fontOf, textWidth } from "./selection";

/** Items shown at once; more scroll. */
const MAX_VISIBLE_ITEMS = 12;
const ITEM_PADDING_X = 8;
/** Options in an <optgroup> are indented under its label. */
const GROUP_INDENT = 12;
const BORDER = 1;

export interface PopupItem {
  label: string;
  /** The option's index in select.options; -1 for an <optgroup> label. */
  index: number;
  disabled: boolean;
  /** An option in an <optgroup>, shown indented. */
  grouped: boolean;
}

/** What the snapshot draws. */
export interface PopupView {
  box: Box;
  itemHeight: number;
  font: string;
  items: readonly (PopupItem & { highlighted: boolean; selected: boolean })[];
}

/** A <select> that opens a list (not a list box: no `multiple`, no `size` above 1). */
export function isDropDown(element: Element | null): element is HTMLSelectElement {
  if (!element) return false;
  const { HTMLSelectElement } = element.ownerDocument.defaultView as FrameWindow;
  return (
    element instanceof HTMLSelectElement &&
    !element.multiple &&
    element.size <= 1 &&
    !element.disabled
  );
}

export class SelectPopup {
  readonly items: PopupItem[];
  readonly box: Box;
  readonly itemHeight: number;
  readonly #font: string;
  /** The first item shown. */
  #scroll = 0;
  /** The item under the pointer, or chosen with the keys. */
  highlighted: number;

  constructor(readonly select: HTMLSelectElement) {
    const document = select.ownerDocument;
    const window = document.defaultView as FrameWindow;
    this.items = itemsOf(select);
    this.#font = fontOf(select);
    const fontSize = parseFloat(window.getComputedStyle(select).fontSize) || 13;
    this.itemHeight = Math.max(18, Math.round(fontSize * 1.5));

    const rect = select.getBoundingClientRect();
    const viewWidth = document.documentElement.clientWidth;
    const viewHeight = document.documentElement.clientHeight;
    const widest = Math.max(
      0,
      ...this.items.map(
        (item) => textWidth(document, this.#font, item.label) + (item.grouped ? GROUP_INDENT : 0),
      ),
    );
    const width = Math.min(
      viewWidth,
      Math.max(rect.width, Math.ceil(widest) + 2 * ITEM_PADDING_X + 2 * BORDER),
    );
    // Below the select if the list fits there, else wherever there is more room.
    const below = viewHeight - rect.bottom;
    const above = rect.top;
    const wanted = Math.min(this.items.length, MAX_VISIBLE_ITEMS) * this.itemHeight + 2 * BORDER;
    const downward = below >= wanted || below >= above;
    const room = Math.max(this.itemHeight + 2 * BORDER, downward ? below : above);
    const shown = Math.max(
      1,
      Math.min(
        this.items.length,
        MAX_VISIBLE_ITEMS,
        Math.floor((room - 2 * BORDER) / this.itemHeight),
      ),
    );
    const height = shown * this.itemHeight + 2 * BORDER;
    const left = Math.max(0, Math.min(rect.left, viewWidth - width));
    const top = downward ? rect.bottom : rect.top - height;
    this.box = { left, top, width, height };

    this.highlighted = Math.max(
      0,
      this.items.findIndex((item) => item.index === select.selectedIndex),
    );
    this.#reveal(this.highlighted);
  }

  get #shown(): number {
    return Math.round((this.box.height - 2 * BORDER) / this.itemHeight);
  }

  contains(x: number, y: number): boolean {
    return contains(this.box, x, y);
  }

  /** The item at a point, or null outside the list. */
  itemAt(x: number, y: number): number | null {
    if (!this.contains(x, y)) return null;
    const row = Math.floor((y - this.box.top - BORDER) / this.itemHeight);
    const item = this.#scroll + Math.max(0, Math.min(this.#shown - 1, row));
    return item < this.items.length ? item : null;
  }

  /** Whether an item is an option that can be chosen. */
  choosable(item: number | null): item is number {
    const entry = item === null ? undefined : this.items[item];
    return entry !== undefined && entry.index >= 0 && !entry.disabled;
  }

  /** Highlights the item under the pointer, if it can be chosen. */
  hover(x: number, y: number): void {
    const item = this.itemAt(x, y);
    if (this.choosable(item)) this.highlighted = item;
  }

  /** Moves the highlight by `steps` choosable items (or to the first or last one past the ends). */
  step(steps: number): void {
    if (steps === 0) return;
    this.highlighted = stepOption(this.items.length, this.highlighted, steps, (item) =>
      this.choosable(item),
    );
    this.#reveal(this.highlighted);
  }

  /** Highlights the first choosable item (after the highlighted one) whose label starts with `text`. */
  typeAhead(text: string): void {
    const item = nextMatch(this.items.length, this.highlighted, text, (item) =>
      this.choosable(item) ? this.items[item]!.label : null,
    );
    if (item === null) return;
    this.highlighted = item;
    this.#reveal(item);
  }

  /** Scrolls the list by `deltaY` CSS px (whole items). */
  scrollBy(deltaY: number): void {
    const rows =
      deltaY > 0 ? Math.ceil(deltaY / this.itemHeight) : Math.floor(deltaY / this.itemHeight);
    this.#scroll = Math.max(0, Math.min(this.items.length - this.#shown, this.#scroll + rows));
  }

  #reveal(item: number): void {
    if (item < this.#scroll) this.#scroll = item;
    else if (item >= this.#scroll + this.#shown) this.#scroll = item - this.#shown + 1;
  }

  get view(): PopupView {
    const selected = this.select.selectedIndex;
    return {
      box: this.box,
      itemHeight: this.itemHeight,
      font: this.#font,
      items: this.items.slice(this.#scroll, this.#scroll + this.#shown).map((item, row) => ({
        ...item,
        highlighted: this.#scroll + row === this.highlighted,
        selected: item.index >= 0 && item.index === selected,
      })),
    };
  }
}

function itemsOf(select: HTMLSelectElement): PopupItem[] {
  const window = select.ownerDocument.defaultView as FrameWindow;
  const items: PopupItem[] = [];
  const options = Array.from(select.options);
  for (const child of Array.from(select.children)) {
    if (child instanceof window.HTMLOptGroupElement) {
      items.push({ label: child.label, index: -1, disabled: true, grouped: false });
      for (const option of Array.from(child.children)) {
        if (!(option instanceof window.HTMLOptionElement) || option.hidden) continue;
        items.push({
          label: labelOf(option),
          index: options.indexOf(option),
          disabled: option.disabled || child.disabled,
          grouped: true,
        });
      }
    } else if (child instanceof window.HTMLOptionElement && !child.hidden) {
      items.push({
        label: labelOf(child),
        index: options.indexOf(child),
        disabled: child.disabled,
        grouped: false,
      });
    }
  }
  return items;
}

export const labelOf = (option: HTMLOptionElement) => option.label || option.text;

/** Sets the select to an option, with input and change, as choosing it in the browser's list does. */
export function chooseOption(select: HTMLSelectElement, index: number): void {
  if (select.selectedIndex === index) return;
  select.selectedIndex = index;
  announceChange(select);
}
