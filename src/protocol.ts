// Messages between the host (HtmlPanel) and the agent running inside the panel
// page.
//
// 1. The agent starts and posts `ready` to the parent window, addressed to the
//    host's origin only.
// 2. The host checks the sender (the panel's iframe, on the panel URL's origin)
//    and answers with `connect`, transferring one end of a MessageChannel.
// 3. Everything else goes through that port: frames and the editing state from
//    the page, input and app messages from the host.
// 4. After each load of the iframe, the host sends `ping`; only the agent of
//    the document now loaded can answer `pong` (an unloaded document's port is
//    dead). Without an answer or a new `ready`, the host gives up.
//
// Each side checks the shape of what it receives and drops anything else. The
// host checks more strictly: it shows whatever the page sends, so sizes are
// bounded.

import type { Box, Caret, PanelInput, PointerKind } from "./types";

export const PROTOCOL_VERSION = 1;

/** The longest page side the host accepts, in CSS pixels. */
export const MAX_PAGE_LENGTH = 4096;
/** The longest SVG the host accepts, in UTF-16 code units. */
export const MAX_SVG_LENGTH = 16 * 1024 * 1024;
/**
 * The longest caret color. A computed color can be long:
 * `color(prophoto-rgb 0.123457 -0.0123457 1.23457 / 0.87)`, and more digits in some browsers.
 */
const MAX_COLOR_LENGTH = 128;
const MAX_KEY_LENGTH = 64;
/** The longest text sent either way: typed or pasted text, and a selection to copy. */
export const MAX_TEXT_LENGTH = 64 * 1024;
const CURSOR_KEYWORD = /^[a-z][a-z-]{0,31}$/;
const MAX_URL_LENGTH = 8192;
/** The most text fields the page reports; more are not offered a soft keyboard on a tap. */
export const MAX_EDITABLES = 256;

function parseBox(value: unknown): Box | null {
  if (!isObject(value)) return null;
  const { left, top, width, height } = value;
  if (
    ![left, top, width, height].every(isFiniteNumber) ||
    (width as number) < 0 ||
    (height as number) < 0
  )
    return null;
  return {
    left: left as number,
    top: top as number,
    width: width as number,
    height: height as number,
  };
}

/** The protocols of the links a page may hand the host to open: no javascript:, data: or the like. */
export const OPENABLE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** `value` if it is an absolute URL of an OPENABLE_PROTOCOLS protocol, else null. */
export function parseOpenableUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return OPENABLE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Posted by the agent to the parent window when it starts. */
export interface ReadyMessage {
  type: "ready";
  version: number;
}

/** Posted by the host to the iframe's window, with a MessagePort, in answer to `ready`. */
export interface ConnectMessage {
  type: "connect";
  version: number;
  /** Suppress unchanged hover captures. Omitted means true. */
  optimizeHover?: boolean;
}

/** A snapshot of the page. `seq` grows with every frame of one connection. */
export interface FrameMessage {
  type: "frame";
  seq: number;
  width: number;
  height: number;
  svg: string;
}

/**
 * Whether an element in the page has focus, so that keys should go to the page
 * (a text field, but also a button or a checkbox, for Enter, Space and Tab), and
 * where a text field's caret is.
 */
export interface EditingMessage {
  type: "editing";
  editing: boolean;
  /** Only for a text field. */
  caret: Caret | null;
  /** The text selected in the field, for the host to copy when the user asks to. */
  selectedText: string;
  /**
   * How many presses and releases (pointer down and up) the agent has handled
   * for this document. A report follows every release, so the host can tell
   * the page's answer to a tap from an earlier report.
   */
  pointers: number;
  /** The focused element takes text (a text field or a contenteditable element), for an on-screen keyboard. */
  typing: boolean;
}

/**
 * The mouse cursor over the page where the pointer is. Only CSS cursor
 * keywords: a url() cursor would have the host load whatever the page names.
 */
export interface CursorMessage {
  type: "cursor";
  cursor: string;
}

/**
 * Where the page's text fields are, in its CSS pixels. iOS opens the soft
 * keyboard only when focus moves while a touch is handled, long before the
 * agent hears of the tap: the host checks these to focus its field right away.
 */
export interface EditablesMessage {
  type: "editables";
  boxes: Box[];
}

/** A link the user followed in the page, or a URL the page passed to window.open(), for the host to open. */
export interface OpenMessage {
  type: "open";
  url: string;
}

/** Data for the application on the other side; the panel does not look into it. */
export interface AppMessage {
  type: "app";
  data: unknown;
}

/** From the page to the host, through the port. */
export type PageMessage =
  | FrameMessage
  | EditingMessage
  | EditablesMessage
  | CursorMessage
  | OpenMessage
  | AppMessage
  | { type: "pong" };

/**
 * The host draws the panel (visible), or has not for a while (out of view,
 * behind the camera, hidden): the page need not send frames meanwhile.
 */
export interface VisibilityMessage {
  type: "visibility";
  visible: boolean;
}

/**
 * At least this long between captures (0: as often as the page's own budget
 * allows): the host shows the panel too small for every frame to matter.
 */
export interface PaceMessage {
  type: "pace";
  intervalMs: number;
}

/** The longest pace the host may ask for, in milliseconds. */
export const MAX_PACE_MS = 1000;

/** From the host to the page, through the port. */
export type HostMessage =
  | PanelInput
  | AppMessage
  | VisibilityMessage
  | PaceMessage
  | { type: "ping" };

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isShortString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export function parseReady(data: unknown): ReadyMessage | null {
  if (!isObject(data) || data.type !== "ready" || !Number.isSafeInteger(data.version)) return null;
  return { type: "ready", version: data.version as number };
}

export function parseConnect(data: unknown): ConnectMessage | null {
  if (!isObject(data) || data.type !== "connect" || !Number.isSafeInteger(data.version))
    return null;
  if (data.optimizeHover !== undefined && typeof data.optimizeHover !== "boolean") return null;
  return {
    type: "connect",
    version: data.version as number,
    ...(data.optimizeHover === undefined ? {} : { optimizeHover: data.optimizeHover }),
  };
}

export function parseCaret(value: unknown): Caret | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { x, y, height, color } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(height) || height < 0)
    return undefined;
  if (!isShortString(color, MAX_COLOR_LENGTH)) return undefined;
  return { x, y, height, color };
}

export interface PageMessageLimits {
  /** The page size the host laid the iframe out at. Frames must match it. */
  width: number;
  height: number;
  /** The `seq` of the last frame accepted; a frame must have a larger one. */
  lastSeq: number;
}

/** Returns the message if it is well formed and within `limits`, or null. */
export function parsePageMessage(data: unknown, limits: PageMessageLimits): PageMessage | null {
  if (!isObject(data)) return null;
  switch (data.type) {
    case "frame": {
      const { seq, width, height, svg } = data;
      if (!Number.isSafeInteger(seq) || (seq as number) <= limits.lastSeq) return null;
      if (width !== limits.width || height !== limits.height) return null;
      if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
      if ((width as number) <= 0 || (height as number) <= 0) return null;
      if ((width as number) > MAX_PAGE_LENGTH || (height as number) > MAX_PAGE_LENGTH) return null;
      if (typeof svg !== "string" || svg.length > MAX_SVG_LENGTH) return null;
      return {
        type: "frame",
        seq: seq as number,
        width: width as number,
        height: height as number,
        svg,
      };
    }
    case "editing": {
      if (typeof data.editing !== "boolean") return null;
      const caret = parseCaret(data.caret);
      if (caret === undefined) return null;
      const { selectedText, pointers, typing } = data;
      if (typeof selectedText !== "string" || selectedText.length > MAX_TEXT_LENGTH) return null;
      if (!Number.isSafeInteger(pointers) || (pointers as number) < 0) return null;
      if (typeof typing !== "boolean") return null;
      return {
        type: "editing",
        editing: data.editing,
        caret,
        selectedText,
        pointers: pointers as number,
        typing,
      };
    }
    case "pong":
      return { type: "pong" };
    case "editables": {
      if (!Array.isArray(data.boxes) || data.boxes.length > MAX_EDITABLES) return null;
      const boxes = data.boxes.map(parseBox);
      return boxes.every((box) => box !== null)
        ? { type: "editables", boxes: boxes as Box[] }
        : null;
    }
    case "open": {
      const url = parseOpenableUrl(data.url);
      return url ? { type: "open", url } : null;
    }
    case "cursor":
      return typeof data.cursor === "string" && CURSOR_KEYWORD.test(data.cursor)
        ? { type: "cursor", cursor: data.cursor }
        : null;
    case "app":
      return { type: "app", data: data.data };
    default:
      return null;
  }
}

const POINTER_KINDS = new Set<PointerKind>(["down", "move", "up", "leave"]);

/** Returns the message if it is well formed, or null. */
export function parseHostMessage(data: unknown): HostMessage | null {
  if (!isObject(data)) return null;
  switch (data.type) {
    case "pointer": {
      const { kind, x, y, shiftKey, ctrlKey, metaKey, input, slop } = data;
      if (!POINTER_KINDS.has(kind as PointerKind) || !isFiniteNumber(x) || !isFiniteNumber(y))
        return null;
      if (
        ![shiftKey, ctrlKey, metaKey].every((key) => key === undefined || typeof key === "boolean")
      )
        return null;
      if (input !== undefined && input !== "mouse" && input !== "touch" && input !== "xr")
        return null;
      if (slop !== undefined && !(isFiniteNumber(slop) && slop >= 0)) return null;
      return {
        type: "pointer",
        kind: kind as PointerKind,
        x,
        y,
        shiftKey: shiftKey === true,
        ctrlKey: ctrlKey === true,
        metaKey: metaKey === true,
        input: input ?? "mouse",
        ...(slop === undefined ? {} : { slop }),
      };
    }
    case "wheel": {
      const { x, y, deltaX, deltaY } = data;
      if (![x, y, deltaX, deltaY].every(isFiniteNumber)) return null;
      return {
        type: "wheel",
        x: x as number,
        y: y as number,
        deltaX: deltaX as number,
        deltaY: deltaY as number,
      };
    }
    case "key": {
      const { key, shiftKey, ctrlKey, altKey, metaKey } = data;
      if (!isShortString(key, MAX_KEY_LENGTH)) return null;
      if (![shiftKey, ctrlKey, altKey, metaKey].every((flag) => typeof flag === "boolean"))
        return null;
      return {
        type: "key",
        key,
        shiftKey: shiftKey as boolean,
        ctrlKey: ctrlKey as boolean,
        altKey: altKey as boolean,
        metaKey: metaKey as boolean,
      };
    }
    case "text":
      return isShortString(data.text, MAX_TEXT_LENGTH) ? { type: "text", text: data.text } : null;
    case "composition": {
      const { text, cursor } = data;
      if (typeof text !== "string" || text.length > MAX_TEXT_LENGTH) return null;
      if (
        !Number.isSafeInteger(cursor) ||
        (cursor as number) < 0 ||
        (cursor as number) > text.length
      )
        return null;
      return { type: "composition", text, cursor: cursor as number };
    }
    case "blur":
      return { type: "blur" };
    case "cut":
      return { type: "cut" };
    case "ping":
      return { type: "ping" };
    case "visibility":
      return typeof data.visible === "boolean"
        ? { type: "visibility", visible: data.visible }
        : null;
    case "pace": {
      const { intervalMs } = data;
      if (!isFiniteNumber(intervalMs) || intervalMs < 0 || intervalMs > MAX_PACE_MS) return null;
      return { type: "pace", intervalMs };
    }
    case "app":
      return { type: "app", data: data.data };
    default:
      return null;
  }
}
