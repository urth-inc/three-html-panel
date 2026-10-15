// What the specs share: stand-ins for what jsdom lacks, and a wait for
// messages. Not part of the library (no entry point imports it).

type EventClass = new (type: string, init?: EventInit) => Event;

/**
 * MouseEvent and PointerEvent that drop `view`: jsdom rejects the window the
 * agent passes (Vitest's window is not jsdom's Window). For the rest of the
 * spec file: each runs on its own.
 */
export function eventsWithoutView(): void {
  const withoutView = (Base: EventClass) =>
    class extends Base {
      constructor(type: string, init: EventInit & { view?: unknown } = {}) {
        const { view: _view, ...rest } = init;
        super(type, rest);
      }
    };
  globalThis.MouseEvent = withoutView(MouseEvent as EventClass) as unknown as typeof MouseEvent;
  globalThis.PointerEvent = withoutView(
    PointerEvent as EventClass,
  ) as unknown as typeof PointerEvent;
}

/** Gives Range a getClientRects (jsdom has none) for a test; returns what undoes it. */
export function stubRangeRects(rects: () => DOMRectList): () => void {
  const before = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  Range.prototype.getClientRects = rects;
  return () => {
    if (before) Object.defineProperty(Range.prototype, "getClientRects", before);
    else delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  };
}

/**
 * Gives elements isContentEditable (jsdom has none): true inside
 * [contenteditable=true]. Returns what undoes it.
 */
export function stubContentEditable(): () => void {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest("[contenteditable=true]") !== null;
    },
  });
  return () => delete (HTMLElement.prototype as { isContentEditable?: boolean }).isContentEditable;
}

/** Waits `ms` for messages posted now (postMessage, MessagePort) to be delivered. */
export const delivered = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
