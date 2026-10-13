/**
 * The window of a document the agent works on. Type checks and constructors
 * come from this object rather than the globals, so the code would also work
 * on a document from another realm (an iframe's).
 */
export type FrameWindow = Window & typeof globalThis;

export type PointerKind = "down" | "move" | "up" | "leave";

/** What drives a pointer: a mouse, a finger, or a VR controller. */
export type PointerInput = "mouse" | "touch" | "xr";

/** Input for a panel, in CSS pixels of the panel page. */
export type PanelInput =
  | {
      type: "pointer";
      kind: PointerKind;
      x: number;
      y: number;
      shiftKey?: boolean;
      /** Held with a press: Ctrl or Cmd add an option to a list box's selection. */
      ctrlKey?: boolean;
      metaKey?: boolean;
      /** What drives the pointer; a mouse if not given. */
      input?: PointerInput;
      /**
       * With a press: how far (CSS px of the page) it may move and still be a
       * tap, as far as a finger or controller wobbles on screen, which the host
       * knows from how large it draws the page. The page's own slop if not given.
       */
      slop?: number;
    }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | {
      type: "key";
      key: string;
      shiftKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      metaKey: boolean;
    }
  | { type: "text"; text: string }
  /** The host cut the selected text to the clipboard (its own field did): delete it in the page. */
  | { type: "cut" }
  /** Text being composed with an IME (not committed yet), with its caret; "" when composition ends. */
  | { type: "composition"; text: string; cursor: number }
  /** Keyboard focus left the panel from the host side (the user pressed elsewhere). */
  | { type: "blur" };

/** A rectangle in CSS pixels of the panel page (viewport coordinates). */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A text caret in CSS pixels of the panel page. */
export interface Caret {
  x: number;
  y: number;
  height: number;
  color: string;
}

/** A snapshot of the panel page as SVG, sized in CSS pixels. */
export interface Frame {
  svg: string;
  width: number;
  height: number;
}
