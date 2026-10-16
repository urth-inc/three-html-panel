// The agent: the part of three-html-panel that runs inside the panel page.
//
// It captures the page (PageCapture) and posts the frames to the host, and
// replays the host's input in the page. The host never touches the page's
// document, so the page can be on any origin, as long as it loads the agent.
//
// The agent talks only to the host origins it was given, and only after the
// host answered: `ready` goes to the parent window addressed to the parent's
// origin when the browser tells it (location.ancestorOrigins) and it is one of
// them, else to each of them (never "*", which would show the page to whatever
// embeds it; postMessage drops the copies addressed to an origin the parent is
// not on), and the rest goes through the MessagePort the host hands over.

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

/**
 * A host name as DNS has them (letters, digits, hyphens and dots, and the
 * underscores some internal hosts have; an internationalized one is in
 * punycode in an origin), or an IPv6 address. URLs also take others
 * ("host.example," is a host), which no host is on: there, a typo.
 */
const HOST_NAME = /^([a-z0-9_-]+\.)*[a-z0-9_-]+\.?$|^\[[0-9a-f:.]+\]$/i;

/** Returns `value` if it is exactly an origin ("https://example.com"), or null. */
export function parseOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const origin = url.origin;
    return origin !== "null" && origin === value && HOST_NAME.test(url.hostname) ? origin : null;
  } catch {
    return null;
  }
}

/**
 * The origins `value` names: one, several separated by white space, or a list.
 * Null if there is none, or if any is not exactly an origin: a typo does not
 * quietly leave the others allowed.
 */
export function parseOrigins(
  value: string | readonly string[] | null | undefined,
): string[] | null {
  if (!value) return null;
  const origins = namesOf(value).map(parseOrigin);
  if (origins.length === 0 || origins.some((origin) => origin === null)) return null;
  return [...new Set(origins as string[])];
}

const namesOf = (value: string | readonly string[]) =>
  typeof value === "string" ? value.trim().split(/\s+/) : value;

/** The value of the agent's `<script data-host-origin="...">`, as written. */
export const hostOriginAttribute = (document: Document) =>
  document.querySelector(`script[${HOST_ORIGIN_ATTRIBUTE}]`)?.getAttribute(HOST_ORIGIN_ATTRIBUTE);

/**
 * The host origins from the agent's `<script data-host-origin="...">`, which
 * may name several, separated by white space. A module script has no
 * `document.currentScript`, so the attribute is looked up.
 */
export function readHostOrigins(document: Document): string[] | null {
  return parseOrigins(hostOriginAttribute(document));
}

export interface AgentOptions {
  /**
   * The origin of the host page, or the origins it may be on (one string with
   * several separated by white space, or a list). Messages go nowhere else.
   */
  hostOrigin: string | readonly string[] | null;
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
  readonly #hostOrigins: readonly string[];

  constructor(window: Window, parent: Window, hostOrigins: readonly string[]) {
    this.#window = window;
    this.#parent = parent;
    this.#hostOrigins = hostOrigins;
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
    for (const origin of readyTargets(window, parent, hostOrigins))
      parent.postMessage(ready, origin);
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
    if (event.source !== this.#parent || !this.#hostOrigins.includes(event.origin)) return;
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
 * Where `ready` goes: the parent's origin, when the browser tells it
 * (location.ancestorOrigins, in Chromium and WebKit) and it is a host origin.
 * Else each host origin: postMessage drops those the parent is not on, though
 * Chromium logs an error for each, which knowing the parent's origin avoids.
 */
export function readyTargets(
  window: Window,
  parent: Window,
  hostOrigins: readonly string[],
): readonly string[] {
  const parentOrigin = parent === window.parent ? window.location.ancestorOrigins?.[0] : undefined;
  return parentOrigin && hostOrigins.includes(parentOrigin) ? [parentOrigin] : hostOrigins;
}

/**
 * Starts the agent, unless there is nothing to talk to: no host origin, a host
 * origin that is not exactly an origin (it warns, naming it), or the page is
 * not in a frame.
 */
export function startAgent(options: AgentOptions): PanelAgent | null {
  const window = options.window ?? globalThis.window;
  const parent = options.parent === undefined ? window.parent : options.parent;
  const hostOrigins = parseOrigins(options.hostOrigin);
  if (!hostOrigins) {
    // Given, but wrong: say what, rather than leave the panel blank without a word.
    if (options.hostOrigin && namesOf(options.hostOrigin).some((name) => name !== "")) {
      const wrong = namesOf(options.hostOrigin).filter((name) => !parseOrigin(name));
      console.warn(
        `[three-html-panel] the agent is not started: the host origin has ${wrong
          .map((name) => JSON.stringify(name))
          .join(
            ", ",
          )}, which is not exactly an origin ("https://host.example", several separated by spaces)`,
      );
    }
    return null;
  }
  if (!parent || parent === window) return null;
  return new PanelAgent(window, parent, hostOrigins);
}
