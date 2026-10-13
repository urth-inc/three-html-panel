// The agent's interaction states, as attributes on the page's own elements.
//
// Hover, press and focus are the agent's (see input.ts): the browser never
// matches :hover, :active, :focus, :focus-visible or :focus-within in the panel page. The
// agent marks the elements instead (data-thp-hover, ...), and the page's CSS
// is rewritten to match the marks as well (live-css.ts), so that the page lays
// out as the image shows it, and a press lands on what is drawn there. The
// snapshot copies the marks with the elements, for the image's CSS (css.ts).
//
// The marks are visible to the page: in its DOM, to its selectors, and to its
// MutationObservers (PageCapture's own ignores them, see INTERACTION_ATTRIBUTES).

import {
  ACTIVE_ATTRIBUTE,
  FOCUS_ATTRIBUTE,
  FOCUS_VISIBLE_ATTRIBUTE,
  FOCUS_WITHIN_ATTRIBUTE,
  HOVER_ATTRIBUTE,
} from "../capture/css";
import { flatParent } from "../flat-tree";

export interface InteractionState {
  hovered: Iterable<Element>;
  active: Iterable<Element>;
  focused: Element | null;
  /** The focus is one the browser would show (:focus-visible). */
  focusVisible?: boolean;
}

export class InteractionMarks {
  /** The elements marked, per attribute. */
  readonly #marked = new Map<string, Set<Element>>(
    [
      HOVER_ATTRIBUTE,
      ACTIVE_ATTRIBUTE,
      FOCUS_ATTRIBUTE,
      FOCUS_VISIBLE_ATTRIBUTE,
      FOCUS_WITHIN_ATTRIBUTE,
    ].map((name) => [name, new Set()]),
  );

  /**
   * Marks the elements in these states, and only those. Returns the elements
   * whose marks changed. `beforeChange` is told which, before anything is
   * changed (to see what the page was doing before the marks).
   */
  update(
    { hovered, active, focused, focusVisible = false }: InteractionState,
    beforeChange: (changed: Element[]) => void = () => {},
  ): Element[] {
    const focusWithin: Element[] = [];
    for (let element = focused; element; element = flatParent(element)) focusWithin.push(element);
    const changes: { name: string; add: Element[]; remove: Element[]; next: Set<Element> }[] = [];
    const changed = new Set<Element>();
    for (const [name, elements] of [
      [HOVER_ATTRIBUTE, hovered],
      [ACTIVE_ATTRIBUTE, active],
      [FOCUS_ATTRIBUTE, focused ? [focused] : []],
      [FOCUS_VISIBLE_ATTRIBUTE, focused && focusVisible ? [focused] : []],
      [FOCUS_WITHIN_ATTRIBUTE, focusWithin],
    ] as const) {
      const next = new Set<Element>(elements);
      const remove = Array.from(this.#marked.get(name)!).filter((element) => !next.has(element));
      // Set again if the page took it off (re-rendering an element's attributes, say).
      const add = Array.from(next).filter((element) => !element.hasAttribute(name));
      for (const element of [...remove, ...add]) changed.add(element);
      changes.push({ name, add, remove, next });
    }
    const list = Array.from(changed);
    if (list.length > 0) beforeChange(list);
    for (const { name, add, remove, next } of changes) {
      for (const element of remove) element.removeAttribute(name);
      for (const element of add) element.setAttribute(name, "");
      this.#marked.set(name, next);
    }
    return list;
  }

  /** Removes every mark. */
  dispose(): void {
    this.update({ hovered: [], active: [], focused: null });
  }
}
