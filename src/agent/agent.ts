// The agent: the part of three-html-panel that runs inside the panel page.
//
// It captures the page (PageCapture) and posts the frames to the host, and
// replays the host's input in the page. The host never touches the page's
// document, so the page can be on any origin, as long as it loads the agent.
//
// The agent talks only to the host origin it was given, and only after the
// host answered: `ready` goes to the parent window addressed to that origin
// (never "*", which would show the page to whatever embeds it), and the rest
// goes through the MessagePort the host hands over.

import {
  PROTOCOL_VERSION,
  parseConnect,
  parseHostMessage,
  type PageMessage,
  type ReadyMessage,
} from "../protocol";
import { emulateAnimationFrames } from "./animation-frames";
import { PageCapture } from "./capture/page-capture";
import { interceptLinks } from "./links";
import { HOST_MESSAGE_EVENT, PAGE_MESSAGE_EVENT } from "./page";
import type { FrameWindow } from "../types";

export const HOST_ORIGIN_ATTRIBUTE = "data-host-origin";

/** Returns `value` if it is exactly an origin ("https://example.com"), or null. */
export function parseOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const origin = new URL(value).origin;
    return origin !== "null" && origin === value ? origin : null;
  } catch {
    return null;
  }
}

/**
 * The host origin from the agent's `<script data-host-origin="...">`. A module
 * script has no `document.currentScript`, so the attribute is looked up.
 */
export function readHostOrigin(document: Document): string | null {
  return parseOrigin(
    document.querySelector(`script[${HOST_ORIGIN_ATTRIBUTE}]`)?.getAttribute(HOST_ORIGIN_ATTRIBUTE),
  );
}

export interface AgentOptions {
  /** The origin of the host page. Messages go nowhere else. */
  hostOrigin: string | null;
  /** The page's window. */
  window?: Window;
  /** Where `ready` is posted; the page's parent window. */
  parent?: Window | null;
}

export class PanelAgent {
  readonly #capture: PageCapture;
  readonly #stopLinks: () => void;
  #port: MessagePort | null = null;
  #seq = 0;
  #disposed = false;
  readonly #window: Window;
  readonly #parent: Window;
  readonly #hostOrigin: string;

  constructor(window: Window, parent: Window, hostOrigin: string) {
    this.#window = window;
    this.#parent = parent;
    this.#hostOrigin = hostOrigin;
    // Before the page's scripts, like the capture's focus and pointer capture.
    emulateAnimationFrames(window as FrameWindow);
    this.#stopLinks = interceptLinks(window as FrameWindow, (url) =>
      this.#post({ type: "open", url }),
    );
    this.#capture = new PageCapture(window.document, {
      onFrame: (frame) => this.#post({ type: "frame", seq: this.#seq++, ...frame }),
      onEditing: (editing, caret, selectedText, pointers, typing) =>
        this.#post({ type: "editing", editing, caret, selectedText, pointers, typing }),
      onEditables: (boxes) => this.#post({ type: "editables", boxes }),
      // "" (not over the page) goes as "default"; the host stops using it when the pointer leaves anyway.
      onCursor: (cursor) => this.#post({ type: "cursor", cursor: cursor || "default" }),
    });
    window.addEventListener("message", this.#onWindowMessage);
    window.addEventListener(PAGE_MESSAGE_EVENT, this.#onPageMessage);
    const ready: ReadyMessage = { type: "ready", version: PROTOCOL_VERSION };
    parent.postMessage(ready, hostOrigin);
  }

  get connected(): boolean {
    return this.#port !== null;
  }

  dispose(): void {
    this.#disposed = true;
    this.#window.removeEventListener("message", this.#onWindowMessage);
    this.#window.removeEventListener(PAGE_MESSAGE_EVENT, this.#onPageMessage);
    this.#capture.dispose();
    this.#stopLinks();
    this.#closePort();
  }

  readonly #onWindowMessage = (event: MessageEvent) => {
    if (event.source !== this.#parent || event.origin !== this.#hostOrigin) return;
    const connect = parseConnect(event.data);
    const port = event.ports[0];
    if (!connect || !port) return;
    // The port is for the agent only; the page's own message handlers do not see it.
    event.stopImmediatePropagation();
    if (connect.version !== PROTOCOL_VERSION) {
      port.close();
      return;
    }
    this.#closePort();
    this.#port = port;
    port.onmessage = this.#onPortMessage;
    this.#capture.start(connect.optimizeHover);
  };

  readonly #onPortMessage = (event: MessageEvent) => {
    if (this.#disposed) return;
    const message = parseHostMessage(event.data);
    if (!message) return;
    if (message.type === "app") {
      this.#window.dispatchEvent(new CustomEvent(HOST_MESSAGE_EVENT, { detail: message.data }));
    } else if (message.type === "ping") {
      this.#post({ type: "pong" });
    } else if (message.type === "visibility") {
      this.#capture.setVisible(message.visible);
    } else if (message.type === "pace") {
      this.#capture.setPace(message.intervalMs);
    } else {
      this.#capture.handle(message);
    }
  };

  readonly #onPageMessage = (event: Event) => {
    this.#post({ type: "app", data: (event as CustomEvent).detail });
  };

  #post(message: PageMessage): void {
    if (!this.#port) return;
    try {
      this.#port.postMessage(message);
    } catch (error) {
      // App data that cannot be cloned (a function, a DOM node).
      console.warn("[three-html-panel] could not send a message to the host:", error);
    }
  }

  #closePort(): void {
    if (!this.#port) return;
    this.#port.onmessage = null;
    this.#port.close();
    this.#port = null;
  }
}

/**
 * Starts the agent, unless there is nothing to talk to: no valid host origin,
 * or the page is not in a frame.
 */
export function startAgent(options: AgentOptions): PanelAgent | null {
  const window = options.window ?? globalThis.window;
  const parent = options.parent === undefined ? window.parent : options.parent;
  const hostOrigin = parseOrigin(options.hostOrigin);
  if (!hostOrigin || !parent || parent === window) return null;
  return new PanelAgent(window, parent, hostOrigin);
}
