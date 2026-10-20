// Where the page changed, as a count of changes: for a snapshot to tell which
// parts of the page are as an earlier one copied them (see LeaveOut in
// snapshot.ts). A change is noted on the node it is to (an element whose
// attributes or children changed, the parent of text that changed, an
// element whose state changed) and on each of its parents.

export class PageChanges {
  #count = 0;
  /** The last change to each element itself. */
  readonly #own = new WeakMap<Node, number>();
  /** The last change to each element or to anything in it. */
  readonly #within = new WeakMap<Node, number>();

  /** How many changes were noted so far: what an element's changes are compared with. */
  get count(): number {
    return this.#count;
  }

  /** Notes a change to `node` (text: to its parent; a shadow root: to its host). */
  changed(node: Node): void {
    const count = ++this.#count;
    let element: Node | null =
      node.nodeType === Node.ELEMENT_NODE
        ? node
        : node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
          ? ((node as ShadowRoot).host ?? null)
          : parentOf(node);
    if (!element) return;
    this.#own.set(element, count);
    for (; element; element = parentOf(element)) this.#within.set(element, count);
  }

  /** The last change to an element itself (0 if none was noted). */
  own(element: Element): number {
    return this.#own.get(element) ?? 0;
  }

  /** The last change to an element or to anything in it (0 if none was noted). */
  within(element: Element): number {
    return this.#within.get(element) ?? 0;
  }
}

/** A node's parent, out of a shadow root to its host. */
function parentOf(node: Node): Node | null {
  const parent = node.parentNode;
  if (parent?.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return (parent as ShadowRoot).host ?? null;
  return parent?.nodeType === Node.ELEMENT_NODE ? parent : null;
}
