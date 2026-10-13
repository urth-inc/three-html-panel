// The page as it is drawn: its flat tree, with each shadow root in place of
// its host's children, and the host's children at the slots they are
// assigned to.
//
// What is on screen, and where a press lands, follows the flat tree, not the
// DOM tree that parentElement, childNodes and closest() walk: those stop at a
// shadow root, and see a host's children where they are not drawn.
//
// A closed shadow root cannot be reached from outside it: only one the agent
// was given (rememberShadowRoot, as the page attached it) is. One declared
// closed in the HTML is never attached by script, and stays out of reach.

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

const isElement = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;

const isSlot = (element: Element): element is HTMLSlotElement =>
  element.localName === "slot" && element.namespaceURI === HTML_NAMESPACE;

/** The shadow roots the agent was given, by host: closed ones are reachable no other way. */
const shadowRoots = new WeakMap<Element, ShadowRoot>();
/** Whether the page has a shadow root the agent knows of: if not, the flat tree is the DOM tree. */
let anyShadowRoot = false;

/** Notes a shadow root of the page (one it attached, or one found open). */
export function rememberShadowRoot(root: ShadowRoot): void {
  shadowRoots.set(root.host, root);
  anyShadowRoot = true;
}

/** An element's shadow root: open, or closed and given to the agent (see rememberShadowRoot). */
export function shadowRootOf(element: Element): ShadowRoot | null {
  return element.shadowRoot ?? shadowRoots.get(element) ?? null;
}

/** The slot a host's child is assigned to: assignedSlot hides one in a closed shadow root. */
function assignedSlotOf(node: Element | Text, root: ShadowRoot): HTMLSlotElement | null {
  if (node.assignedSlot || root.mode !== "closed") return node.assignedSlot;
  for (const slot of Array.from(root.querySelectorAll("slot")))
    if (slot.assignedNodes().includes(node)) return slot;
  return null;
}

/** A node's parent in the flat tree; null at the top, and for a host's child assigned to no slot (not drawn). */
export function flatParent(node: Node): Element | null {
  const parent = node.parentNode;
  if (!parent) return null;
  if (isElement(parent)) {
    const root = shadowRootOf(parent);
    return root ? assignedSlotOf(node as Element | Text, root) : parent;
  }
  // A shadow root's children are its host's.
  return parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE
    ? ((parent as ShadowRoot).host ?? null)
    : null;
}

/** An element's children in the flat tree: its shadow root's, or a slot's assigned nodes (or its own, its fallback). */
export function flatChildren(element: Element): Node[] {
  const root = shadowRootOf(element);
  if (root) return Array.from(root.childNodes);
  if (isSlot(element)) {
    const assigned = element.assignedNodes();
    if (assigned.length > 0) return assigned;
  }
  return Array.from(element.childNodes);
}

/** The innermost element at a point, inside shadow roots: document.elementFromPoint() stops at their hosts. */
export function deepElementFromPoint(document: Document, x: number, y: number): Element | null {
  let element = document.elementFromPoint(x, y);
  for (let root = element && shadowRootOf(element); root; root = shadowRootOf(element!)) {
    const inner = root.elementFromPoint(x, y);
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

/**
 * The elements in an element (and it) that match a selector, in the order of
 * the flat tree. Until the agent knows of a shadow root (see
 * rememberShadowRoot: as the page attaches one, or a snapshot finds it), the
 * page is taken to have none.
 */
export function querySelectorAllInFlatTree(root: Element, selector: string): Element[] {
  // No shadow roots: the browser's own query, in the same order.
  if (!anyShadowRoot)
    return [
      ...(root.matches(selector) ? [root] : []),
      ...Array.from(root.querySelectorAll(selector)),
    ];
  const found: Element[] = [];
  // Depth first, without recursion (a deep page would run out of stack).
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const element = stack.pop()!;
    if (element.matches(selector)) found.push(element);
    const children = flatChildren(element);
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index]!;
      if (isElement(child)) stack.push(child);
    }
  }
  return found;
}

/**
 * An element as a document or shadow root sees it (what its activeElement
 * says, for one): itself if it is in that tree, or else the host it is in,
 * there; null if it is not in that tree at all.
 */
export function retarget(element: Element, scope: Document | ShadowRoot): Element | null {
  for (let node: Element | null = element; node;) {
    const root = node.getRootNode();
    if (root === scope) return node;
    node =
      root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? ((root as ShadowRoot).host ?? null) : null;
  }
  return null;
}
