// The page as it is drawn: its flat tree, with each shadow root in place of
// its host's children, and the host's children at the slots they are
// assigned to.
//
// What is on screen, and where a press lands, follows the flat tree, not the
// DOM tree that parentElement, childNodes and closest() walk: those stop at a
// shadow root, and see a host's children where they are not drawn.
//
// Only open shadow roots: a closed one cannot be reached from outside it.

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

const isSlot = (element: Element): element is HTMLSlotElement =>
  element.localName === "slot" && element.namespaceURI === HTML_NAMESPACE;

/** A node's parent in the flat tree; null at the top, and for a host's child assigned to no slot (not drawn). */
export function flatParent(node: Node): Element | null {
  const parent = node.parentNode;
  if (!parent) return null;
  if (isElement(parent)) {
    if (parent.shadowRoot) return (node as Element | Text).assignedSlot ?? null;
    return parent;
  }
  // A shadow root's children are its host's.
  return parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE
    ? ((parent as ShadowRoot).host ?? null)
    : null;
}

/** An element's children in the flat tree: its shadow root's, or a slot's assigned nodes (or its own, its fallback). */
export function flatChildren(element: Element): Node[] {
  if (element.shadowRoot) return Array.from(element.shadowRoot.childNodes);
  if (isSlot(element)) {
    const assigned = element.assignedNodes();
    if (assigned.length > 0) return assigned;
  }
  return Array.from(element.childNodes);
}

/** The innermost element at a point, inside shadow roots: document.elementFromPoint() stops at their hosts. */
export function deepElementFromPoint(document: Document, x: number, y: number): Element | null {
  let element = document.elementFromPoint(x, y);
  while (element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  return element;
}

/** closest(), up the flat tree: through slots and out of shadow roots. */
export function closestInFlatTree(element: Element, selector: string): Element | null {
  for (let node: Element | null = element; node; node = flatParent(node))
    if (node.matches(selector)) return node;
  return null;
}
