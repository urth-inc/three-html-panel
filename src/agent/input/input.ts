// Turns the host's pointer, wheel and keyboard input, received by the agent,
// into DOM events in the panel page.
//
// The panel iframe never receives real input (the host keeps it at
// pointer-events: none and does not let it hold focus), so everything here is
// synthesized. Synthesized events are not trusted, which means the browser
// skips some of its usual default actions. Those that matter for typical pages
// are reimplemented:
//
// - hover/enter/leave bookkeeping, and the :hover/:active/:focus state, as
//   attributes on the page's elements (interaction-marks.ts)
// - pointer capture, which throws for a pointer the browser does not know
// - focus (see VirtualFocus), and placing the caret where a field was pressed;
//   selecting text by dragging, double click (word) and triple click (line)
// - click and dblclick, only when the pointer did not move in between
// - wheel scrolling, and text editing in <input>/<textarea> (editing.ts)
// - selecting the page's text by dragging, and editing contenteditable
//   elements (selection.ts, contenteditable.ts)
// - the list of a drop-down <select> (select-popup.ts), and choosing options
//   in a list box (list-box.ts)
// - scrolling by dragging a finger or a VR controller, as touch does (pan.ts)
// - scrollbars: dragging the thumb, paging by pressing (and holding) the
//   track (the scrollbars in the image are the agent's own, see scrollbars.ts)
//
// Events are constructed from the page's own window, so that they belong to
// the page's realm like events the browser would dispatch there.

import {
  caretAt,
  indexFromPoint,
  isTextField,
  revealIndex,
  verticalIndex,
  type Composition,
  type TextField,
} from "./caret";
import { contentAction } from "./contenteditable";
import { editAction, lineEnd, lineStart, wordAt } from "./editing";
import { EditHistory, type FieldState } from "./history";
import { InteractionMarks } from "./interaction-marks";
import { PAN_START_DISTANCE, panAxes, type PanAxes } from "./pan";
import {
  announceChange,
  isListBox,
  isUsable,
  nextMatch,
  OPTION_STEPS,
  optionAt,
  revealOption,
  selectRange,
  selectionOf,
  stepOption,
} from "./list-box";
import {
  contains,
  hitBox,
  maxScroll,
  scrollbarAt,
  scrollbarsOf,
  thumbTravel,
  type Axis,
  type Scrollbar,
} from "./scrollbars";
import { SelectPopup, chooseOption, isDropDown, labelOf, type PopupView } from "./select-popup";
import {
  blockAround,
  caretPoint,
  comparePoints,
  editingHostOf,
  pointAt,
  selectedRange,
  selectedText,
  wordAround,
  type Point,
} from "./selection";
import { MAX_TEXT_LENGTH } from "../../protocol";
import type { FrameWindow, PanelInput, PointerInput } from "../../types";

const POINTER_ID = 1;
/** Movement (CSS px) after which a press is a drag, not a click. */
const CLICK_SLOP = 6;
const DOUBLE_CLICK_MS = 500;
/** Pressing a scrollbar's track scrolls by this share of the visible length, like browsers do. */
const PAGE_SCROLL_RATIO = 0.875;
/** Holding a press on the track keeps paging: after this long, then at this interval. */
const PAGE_REPEAT_DELAY_MS = 400;
const PAGE_REPEAT_INTERVAL_MS = 60;

// macOS and iOS keep Emacs-style keys in text fields: Ctrl+A and Ctrl+E move to
// the start and end of the line. Select all is Cmd+A there.
const APPLE_PLATFORM = /mac|iphone|ipad|ipod/i;

const FOCUSABLE_SELECTOR =
  'input, textarea, select, button, a[href], [tabindex], [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/** Those of `elements` not inside another of them, each once. */
function topmost(elements: Element[]): Element[] {
  const unique = Array.from(new Set(elements));
  return unique.filter(
    (element) => !unique.some((other) => other !== element && other.contains(element)),
  );
}

/**
 * The CSS transitions running on these elements and in them. Brings styles up
 * to date (as the next hit test would anyway): transitions just caused start.
 */
function runningTransitions(roots: Element[]): Animation[] {
  const found: Animation[] = [];
  for (const root of roots) {
    if (typeof root.getAnimations !== "function") continue;
    for (const animation of root.getAnimations({ subtree: true }))
      // A CSS transition, checked by shape (as snapshot.ts does).
      if ("transitionProperty" in animation && animation.playState === "running")
        found.push(animation);
  }
  return found;
}

/** Keys that only modify others: pressed alone, they do not make focus show. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Meta", "Alt", "AltGraph", "CapsLock", "Fn"]);
/** The keys a focused drop-down <select> whose list is closed changes its option with. */
const CLOSED_SELECT_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** A focused element that is a contenteditable element's root (its editing host). */
const isEditingHost = (element: Element | null): element is HTMLElement =>
  element !== null && editingHostOf(element) === element;

/**
 * Scrolls as the user's own wheel, drag or scrollbar does: at once. A page's
 * `scroll-behavior: smooth` applies to scrolls by script, not to the user's,
 * and a smooth scroll would also crawl in the panel's iframe, whose rendering
 * the browser holds back: each wheel step would start again from where the
 * last one had not yet moved, and most of the scroll would be lost.
 */
function scrollByUser(element: Element, left: number, top: number): void {
  element.scrollBy({ left, top, behavior: "instant" });
}

function ancestors(element: Element | null): Element[] {
  const chain: Element[] = [];
  for (let node = element; node; node = node.parentElement) chain.push(node);
  return chain;
}

function commonAncestor(a: Element, b: Element): Element | null {
  const chain = new Set(ancestors(a));
  for (let node: Element | null = b; node; node = node.parentElement)
    if (chain.has(node)) return node;
  return null;
}

/**
 * Focus inside the panel, kept by the agent instead of the browser.
 *
 * Real focus cannot work here. The host keeps keyboard focus for itself, and
 * when focus moves out of an iframe, browsers blur the element focused inside
 * it (Chrome does, at least): a text field would lose focus right after it got
 * it. A page that calls focus() would also pull the window's focus into the
 * iframe, away from the host.
 *
 * So focus(), blur() and document.activeElement are replaced in the page's
 * realm, and focus/blur events are dispatched by hand. Real focus events that
 * still happen (an `autofocus` attribute, the browser's own handling) are
 * swallowed and turned into virtual focus.
 */
export class VirtualFocus {
  #element: Element | null = null;
  readonly #window: FrameWindow;
  readonly #onChange: () => void;
  /** Focus moved: called before the focus events, which the page handles with the new focus in place. */
  readonly #onMove: () => void;

  constructor(document: Document, onChange: () => void, onMove: () => void = () => {}) {
    this.#onChange = onChange;
    this.#onMove = onMove;
    this.#window = document.defaultView as FrameWindow;
    const proto = this.#window.HTMLElement.prototype;
    // The browser's own blur, kept to call on elements that took real focus.
    // oxlint-disable-next-line typescript/unbound-method -- called with .call on an element
    const realBlur = proto.blur;
    // The page's elements call these with themselves as `this`: no arrow functions.
    const focusElement = (element: HTMLElement) => {
      if (this.isFocusable(element)) this.set(element);
    };
    const blurElement = (element: HTMLElement) => {
      if (this.#element === element) this.set(null);
    };
    proto.focus = function (this: HTMLElement) {
      focusElement(this);
    };
    proto.blur = function (this: HTMLElement) {
      blurElement(this);
    };

    // The agent should run before the page's scripts. If it was loaded later,
    // something may have been focused for real already: take it over.
    const realActive = document.activeElement;
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => this.current ?? document.body,
    });
    if (realActive instanceof this.#window.HTMLElement && realActive !== document.body) {
      this.#element = realActive;
      realBlur.call(realActive);
    }

    const swallowRealFocus = (event: Event) => {
      if (!event.isTrusted || !(event.target instanceof this.#window.Element)) return;
      event.stopImmediatePropagation();
      if (event.type === "focusin" && event.target instanceof this.#window.HTMLElement) {
        const target = event.target;
        queueMicrotask(() => {
          this.set(target);
          realBlur.call(target);
        });
      }
    };
    for (const type of ["focus", "blur", "focusin", "focusout"]) {
      this.#window.addEventListener(type, swallowRealFocus, true);
    }
  }

  /** The focused element, or null. An element removed from the page loses focus. */
  get current(): Element | null {
    if (this.#element && !this.#element.isConnected) this.#element = null;
    return this.#element;
  }

  isFocusable(element: Element): boolean {
    if (element.matches(":disabled")) return false;
    return (
      element.matches(FOCUSABLE_SELECTOR) ||
      (element instanceof this.#window.HTMLElement && element.isContentEditable)
    );
  }

  set(element: Element | null): void {
    const previous = this.current;
    if (previous === element) return;
    this.#element = element;
    this.#onMove();
    const { FocusEvent } = this.#window;
    if (previous) {
      previous.dispatchEvent(new FocusEvent("blur", { relatedTarget: element }));
      previous.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: element }),
      );
    }
    // A blur handler may have moved focus somewhere else already.
    if (element && this.#element === element) {
      // An editable that gets focus gets the caret too, at its start, unless it has it already.
      if (isEditingHost(element)) {
        const selection = this.#window.getSelection();
        if (selection && !(selection.rangeCount > 0 && element.contains(selection.anchorNode)))
          selection.collapse(element, 0);
      }
      element.dispatchEvent(new FocusEvent("focus", { relatedTarget: previous }));
      element.dispatchEvent(
        new FocusEvent("focusin", { bubbles: true, composed: true, relatedTarget: previous }),
      );
    }
    this.#onChange();
  }
}

export interface InputSynthesizerOptions {
  /** Runs a measurement that temporarily adds elements to the page (see caret.ts). */
  measure: <T>(run: () => T) => T;
  /** Called after anything that may have changed what the page looks like. */
  onChange: () => void;
  /**
   * Where the marks may start transitions, to end them at once (see
   * syncMarks): nowhere (the page has none), inside the elements whose marks
   * change, also in their later siblings (`.a:hover ~ .b`), or anywhere
   * (`:has()`). Asked only when marks change.
   */
  transitions?: () => "none" | "inside" | "siblings" | "everywhere";
}

/** A finger or controller drag that may scroll, from where it was pressed. */
interface Pan {
  target: Element;
  scroller: Element;
  axes: PanAxes;
  start: { x: number; y: number };
  last: { x: number; y: number };
  /** It has started scrolling (and the page got pointercancel). */
  active: boolean;
  /** How far it moves before it scrolls: PAN_START_DISTANCE, or the host's slop if more. */
  slop: number;
}

interface Press {
  target: Element;
  x: number;
  y: number;
  moved: boolean;
  /** False when the page cancelled pointerdown, which suppresses the mouse events. */
  mouseEvents: boolean;
  /** How far the host says the press may wobble (CSS px of the page), see PanelInput's slop. */
  hostSlop: number;
  /**
   * The mousedown held back while a finger or controller drag may still scroll:
   * like a touch in browsers, the mouse events (and focusing) come only if the
   * press ends without moving.
   */
  deferred: { detail: number; shiftKey: boolean; toggle: boolean } | null;
  /** The press opened a <select>'s list: releasing it over an option after dragging there chooses it. */
  openedPopup?: boolean;
}

/** Whether a list box's selection differs from what it was. */
const changed = (before: readonly boolean[], select: HTMLSelectElement) =>
  selectionOf(select).some((selected, index) => selected !== before[index]);

/**
 * Whether a press moved too far to be a click. A held-back finger or controller
 * press is a tap for as long as it does not scroll: until it moves
 * PAN_START_DISTANCE along an axis. Either is at least what the host says a
 * finger or controller wobbles on screen: on a panel drawn small, a few px of
 * the screen are many of the page.
 */
function movedOff(press: Press, x: number, y: number): boolean {
  const dx = Math.abs(x - press.x);
  const dy = Math.abs(y - press.y);
  return press.deferred
    ? Math.max(dx, dy) >= Math.max(PAN_START_DISTANCE, press.hostSlop)
    : Math.hypot(dx, dy) > Math.max(CLICK_SLOP, press.hostSlop);
}

export class InputSynthesizer {
  readonly hovered = new Set<Element>();
  readonly active = new Set<Element>();
  readonly #window: FrameWindow;
  readonly #focus: VirtualFocus;
  readonly #marks = new InteractionMarks();
  #hoverTarget: Element | null = null;
  #captureTarget: Element | null = null;
  #press: Press | null = null;
  #lastClick: { time: number; x: number; y: number } | null = null;
  /** The last press, to count double and triple presses. */
  #lastDown: { time: number; x: number; y: number; count: number } | null = null;
  /** Where the pointer is over the page, if it is. */
  #pointer: { x: number; y: number } | null = null;
  /** Text being selected by dragging: the field, and the range the press selected (a word on a double press). */
  #textDrag: {
    field: TextField;
    unit: "char" | "word" | "line";
    start: number;
    end: number;
  } | null = null;
  /** The page's text being selected by dragging: the range the press selected, and by which unit it grows. */
  #documentDrag: { unit: "char" | "word" | "line"; start: Point; end: Point } | null = null;
  /** Text being composed with the host's IME in the focused field or editable (not in it yet). */
  #composing: { field: Element; composition: Composition } | null = null;
  /** The open list of a drop-down <select>, and whether a press began in it. */
  #popup: SelectPopup | null = null;
  #popupPress = false;
  /**
   * The page's selection as the user's last press, drag or key left it. A
   * selection the page's own script makes is not the user's: it does not take
   * the keys, and it stays when the host takes them back.
   */
  #userSelection: {
    anchor: Node | null;
    anchorOffset: number;
    focus: Node | null;
    focusOffset: number;
  } | null = null;
  /**
   * A press choosing options in a list box: where it started (the anchor a drag
   * selects from), whether it adds to the selection (Ctrl/Cmd), and the selection
   * before it (change fires on release if it differs).
   */
  #listPress: {
    select: HTMLSelectElement;
    anchor: number;
    toggle: boolean;
    before: boolean[];
    /** The browser chose the options itself (WebKit does, even for synthetic presses): leave it to it. */
    native?: boolean;
  } | null = null;
  /** Per list box: the option Shift extends from, and the one the arrow keys move from. */
  readonly #listAnchors = new WeakMap<HTMLSelectElement, number>();
  readonly #listCursors = new WeakMap<HTMLSelectElement, number>();
  /** Set while execCommand() runs: its own beforeinput (WebKit sends one) is not the page's to see twice. */
  #runningCommand = false;
  readonly #history = new EditHistory();
  /** The horizontal position Up/Down keep to, while they keep moving the caret. */
  #goal: { field: TextField; index: number; x: number } | null = null;
  /**
   * A press on a scrollbar, until it is released. On the thumb, it drags: where
   * the press was and the scroll offset then. On the track, it pages toward the
   * pointer while held.
   */
  #scrollbarPress: {
    bar: Scrollbar;
    drag: { from: number; scroll: number } | null;
    position: number;
  } | null = null;
  #pageTimer = 0;
  /** What drives the pointer now, and the drag it may be scrolling. */
  #pointerInput: PointerInput = "mouse";
  /** The modifier keys held with the pointer's last input, which its events carry. */
  #pointerModifiers = { shiftKey: false, ctrlKey: false, metaKey: false };
  #pan: Pan | null = null;
  /** The scrollbar the pointer hovers (it is not part of the page). */
  #hoveredScrollbar: Scrollbar | null = null;

  readonly #document: Document;
  readonly #options: InputSynthesizerOptions;

  constructor(document: Document, options: InputSynthesizerOptions) {
    this.#document = document;
    this.#options = options;
    this.#window = document.defaultView as FrameWindow;
    this.#patchPointerCapture();
    this.#focus = new VirtualFocus(document, options.onChange, () => this.syncMarks());
    // Added before the page's scripts run, so it comes before their listeners.
    this.#window.addEventListener(
      "beforeinput",
      (event) => {
        if (this.#runningCommand) event.stopImmediatePropagation();
      },
      true,
    );
  }

  /** Preserve unconditional pointer-move captures when the host opts out. */
  optimizeHover = true;
  /** The last input was keys, not a press: focus moved from now on shows (:focus-visible). */
  #keyboardModality = false;

  handle(input: PanelInput): void {
    // What focus that follows is shown as (:focus-visible): after keys, not after a press.
    // Not after a shortcut (Ctrl, Cmd or Alt held) or a modifier alone, as in browsers.
    if (
      input.type === "text" ||
      (input.type === "key" &&
        !input.ctrlKey &&
        !input.metaKey &&
        !input.altKey &&
        !MODIFIER_KEYS.has(input.key))
    )
      this.#keyboardModality = true;
    else if (input.type === "pointer" && input.kind === "down") this.#keyboardModality = false;
    const quietMove =
      this.optimizeHover &&
      input.type === "pointer" &&
      input.kind === "move" &&
      !this.#press &&
      !this.#popup &&
      !this.#scrollbarPress &&
      !this.#captureTarget;
    const previousHover = this.#hoverTarget;
    const previousScrollbar = this.#hoveredScrollbar;
    switch (input.type) {
      case "pointer":
        if (input.kind !== "leave") {
          this.#pointerModifiers = {
            shiftKey: input.shiftKey === true,
            ctrlKey: input.ctrlKey === true,
            metaKey: input.metaKey === true,
          };
        }
        if (input.kind === "down") {
          // Ctrl adds to a list box's selection; Cmd does on macOS (Ctrl+press is a right click there).
          const toggle = this.#isApple() ? input.metaKey === true : input.ctrlKey === true;
          this.#pointerDown(
            input.x,
            input.y,
            input.shiftKey === true,
            input.input ?? "mouse",
            toggle,
            input.slop ?? 0,
          );
        } else if (input.kind === "move") {
          // Hovering, the pointer may be another one now (a mouse after a finger).
          if (!this.#press && !this.#scrollbarPress) this.#pointerInput = input.input ?? "mouse";
          this.#pointerMove(input.x, input.y);
        } else if (input.kind === "up") this.#pointerUp(input.x, input.y);
        else {
          this.#pointer = null;
          this.#hoveredScrollbar = null;
          this.#updateHover(null, 0, 0);
        }
        break;
      case "wheel":
        this.#wheel(input.x, input.y, input.deltaX, input.deltaY);
        break;
      case "key":
        this.#key(input);
        break;
      case "text":
        this.#composing = null;
        this.#text(input.text);
        break;
      case "cut":
        this.#cut();
        break;
      case "composition": {
        const field = this.focused;
        const editable = isTextField(field) || isEditingHost(field);
        this.#composing =
          input.text !== "" && field && editable
            ? { field, composition: { text: input.text, cursor: input.cursor } }
            : null;
        break;
      }
      case "blur":
        // The host took the keys back: nothing in the page keeps them. A selection
        // stays, inactive (drawn grey, as browsers do), until the user acts on the panel again.
        this.#focus.set(null);
        this.#userSelection = null;
        break;
    }
    // Whatever the selection is right after the user's input is theirs (the page's
    // handlers for it included, such as selecting a code block on a click). Not
    // after hovering or the wheel: they do not make the panel active.
    const acting =
      input.type === "pointer"
        ? input.kind === "down" || input.kind === "up" || this.#press !== null
        : input.type !== "blur" && input.type !== "wheel";
    if (acting) this.#rememberSelection();
    // The list closes when its <select> loses focus (or leaves the page).
    if (this.#popup && (this.focused !== this.#popup.select || !this.#popup.select.isConnected))
      this.#popup = null;
    // Always dispatch the page's events. DOM mutations and capture's event
    // listeners still invalidate; only skip this blanket notification when
    // the pointer stayed over the same element and scrollbar. Canvas/CSSOM
    // changes are not observable here: such pages can disable optimizeHover.
    if (
      !quietMove ||
      previousHover !== this.#hoverTarget ||
      previousScrollbar?.element !== this.#hoveredScrollbar?.element ||
      previousScrollbar?.axis !== this.#hoveredScrollbar?.axis
    )
      this.#options.onChange();
  }

  /** The focused element, if any. */
  get focused(): Element | null {
    return this.#focus.current;
  }

  /**
   * The text selected in the focused field, for the host to copy (it takes the
   * keys, so the browser's copy acts on the host's field). None from a password.
   */
  get selectedText(): string {
    const field = this.focused;
    if (!isTextField(field)) {
      const range = selectedRange(this.#window);
      return range ? selectedText(this.#window, range, MAX_TEXT_LENGTH) : "";
    }
    if (field.tagName === "INPUT" && (field as HTMLInputElement).type === "password") return "";
    const { selectionStart, selectionEnd } = field;
    return selectionStart === null || selectionEnd === null
      ? ""
      : field.value.slice(selectionStart, selectionEnd);
  }

  /**
   * Whether some of the page's text is selected (outside text fields) by the
   * user, the panel active: the keys go to the page, to copy it. Otherwise a
   * selection is inactive, drawn grey.
   */
  get hasSelection(): boolean {
    return (
      !isTextField(this.focused) && selectedRange(this.#window) !== null && this.#isUserSelection()
    );
  }

  #rememberSelection(): void {
    const selection = this.#window.getSelection();
    this.#userSelection = selection
      ? {
          anchor: selection.anchorNode,
          anchorOffset: selection.anchorOffset,
          focus: selection.focusNode,
          focusOffset: selection.focusOffset,
        }
      : null;
  }

  /** Whether the page's selection is still the one the user's input left. */
  #isUserSelection(): boolean {
    const selection = this.#window.getSelection();
    const user = this.#userSelection;
    return (
      selection !== null &&
      user !== null &&
      selection.anchorNode === user.anchor &&
      selection.anchorOffset === user.anchorOffset &&
      selection.focusNode === user.focus &&
      selection.focusOffset === user.focusOffset
    );
  }

  /** The open list of a <select>, to draw. */
  get popupView(): PopupView | null {
    return this.#popup?.view ?? null;
  }

  /** What is being composed in the focused field, if anything. Ends when focus moves on. */
  get composition(): Composition | null {
    const composing = this.#composing;
    if (!composing || composing.field !== this.focused) return null;
    return composing.composition;
  }

  /**
   * The mouse cursor the page asks for where the pointer is, as a CSS keyword,
   * or "" while the pointer is not over the page.
   */
  get cursor(): string {
    if (this.#scrollbarPress || this.#hoveredScrollbar) return "default";
    if (
      this.#popup &&
      this.#pointer &&
      (this.#popupPress || this.#popup.contains(this.#pointer.x, this.#pointer.y))
    )
      return "default";
    // While selecting text, the text cursor stays wherever the pointer goes.
    if (this.#textDrag || this.#documentDrag) return "text";
    const target = this.#captureTarget?.isConnected ? this.#captureTarget : this.#hoverTarget;
    if (!target?.isConnected) return "";
    // The computed value lists url() images before a keyword to fall back on; only the keyword is used.
    const keyword = this.#window.getComputedStyle(target).cursor.split(",").pop()!.trim();
    if (keyword !== "auto" && /^[a-z-]+$/.test(keyword)) return keyword;
    // "auto" is the text cursor over editable text, and over text itself.
    const editable = target instanceof this.#window.HTMLElement && target.isContentEditable;
    if (isTextField(target) || editable) return "text";
    // WebKit leaves links at "auto" and picks the hand cursor natively, where
    // Chromium and Firefox compute "pointer": the hand is picked here the same way.
    if (target.closest(":any-link")) return "pointer";
    return this.#pointer && this.#isOverText(this.#pointer.x, this.#pointer.y) ? "text" : "default";
  }

  /** The scrollbar being pressed or hovered, to be drawn that way. */
  get scrollbarState(): { element: Element; axis: Axis; state: "active" | "hover" } | null {
    const bar = this.#scrollbarPress?.bar ?? this.#hoveredScrollbar;
    if (!bar) return null;
    return {
      element: bar.element,
      axis: bar.axis,
      state: this.#scrollbarPress ? "active" : "hover",
    };
  }

  dispose(): void {
    window.clearTimeout(this.#pageTimer);
    this.#marks.dispose();
  }

  /**
   * Puts the hover, press and focus on the page's elements, for its CSS to
   * match: right when they change, so that the next hit test (and the page's
   * handlers) find what they show, a button shown only while its row is
   * hovered, say. Also before a capture, for what changed without input (the
   * page moving the focused element elsewhere). Returns whether a mark changed.
   */
  syncMarks(): boolean {
    const focused = this.#focus.current;
    let running: Set<Animation> | null = null;
    let roots: Element[] = [];
    const changed = this.#marks.update(
      {
        hovered: this.hovered,
        active: this.active,
        focused,
        // As browsers decide it: a field that takes text always shows its focus, anything else after keys.
        focusVisible:
          focused !== null &&
          (this.#keyboardModality || isTextField(focused) || isEditingHost(focused)),
      },
      (elements) => {
        const scope = this.#options.transitions?.() ?? "inside";
        if (scope === "none") return;
        roots =
          scope === "everywhere"
            ? [this.#document.documentElement]
            : scope === "siblings"
              ? topmost(elements.map((element) => element.parentElement ?? element))
              : topmost(elements);
        // What was already on its way is the page's own doing: left to run.
        running = new Set(runningTransitions(roots));
      },
    );
    if (running) this.#finishTransitions(roots, running);
    return changed.length > 0;
  }

  /**
   * Transitions the marks started (`.row:hover .tools { transform: none }`)
   * end at once in the page, as they are drawn (the image shows transitions
   * at their end): a press lands where the image shows the element, not where
   * it is on its way. Only those: not the page's own, running already.
   */
  #finishTransitions(roots: Element[], running: Set<Animation>): void {
    for (const transition of runningTransitions(roots))
      if (!running.has(transition)) transition.finish();
  }

  /** Not pressed anymore: no longer :active. */
  #clearActive(): void {
    this.active.clear();
    this.syncMarks();
  }

  /** Whether a point is on a character of the page's text (not only inside an element with text). */
  #isOverText(x: number, y: number): boolean {
    const point = caretPoint(this.#document, x, y);
    if (!point || point.node.nodeType !== Node.TEXT_NODE) return false;
    const { node, offset } = point;
    const length = (node as Text).length;
    const range = this.#document.createRange();
    // The caret position is between two characters; the point is on one of them.
    for (const [from, to] of [
      [offset - 1, offset],
      [offset, offset + 1],
    ] as const) {
      if (from < 0 || to > length) continue;
      range.setStart(node, from);
      range.setEnd(node, to);
      for (const rect of Array.from(range.getClientRects())) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
      }
    }
    return false;
  }

  /**
   * setPointerCapture() throws for pointers the browser did not create. Emulate
   * capture for the synthetic pointer, so that drag handlers written the usual
   * way keep receiving moves after the pointer leaves the element.
   */
  #patchPointerCapture(): void {
    const proto = this.#window.Element.prototype;
    // The browser's own, kept for the pointers it created: called with .call on an element.
    // oxlint-disable-next-line typescript/unbound-method -- see above
    const { setPointerCapture, releasePointerCapture, hasPointerCapture } = proto;
    const capturedBy = () => this.#captureTarget;
    const capture = (element: Element | null) => {
      this.#captureTarget = element;
    };
    // The page's elements call these with themselves as `this`: no arrow functions.
    proto.setPointerCapture = function (pointerId: number) {
      if (pointerId !== POINTER_ID) return setPointerCapture.call(this, pointerId);
      capture(this);
    };
    proto.releasePointerCapture = function (pointerId: number) {
      if (pointerId !== POINTER_ID) return releasePointerCapture.call(this, pointerId);
      if (capturedBy() === this) capture(null);
    };
    proto.hasPointerCapture = function (pointerId: number) {
      if (pointerId !== POINTER_ID) return hasPointerCapture.call(this, pointerId);
      return capturedBy() === this;
    };
  }

  // --- Focus -----------------------------------------------------------------

  /** Focuses what a press landed on, the way mousedown does. `count` is 2 for a double press, and so on. */
  #focusAt(target: Element, x: number, y: number, count: number, shiftKey: boolean): void {
    // Anywhere in an editable (a link in it too), the editable is what gets focus.
    const host = editingHostOf(target);
    // Pressing a <label> focuses its control.
    const focusable =
      host ?? target.closest(FOCUSABLE_SELECTOR) ?? target.closest("label")?.control ?? null;
    if (focusable && this.#focus.isFocusable(focusable)) {
      const wasFocused = this.#focus.current === focusable;
      this.#focus.set(focusable);
      // Untrusted mousedown does not move the caret; place it where the press was
      // (unless the press was on a label, which only focuses the field).
      if (isTextField(focusable) && focusable.contains(target)) {
        // The selection moves into the field.
        this.#window.getSelection()?.removeAllRanges();
        this.#pressText(focusable, x, y, count, shiftKey && wasFocused);
      } else if (focusable === host) {
        this.#pressDocument(x, y, count, shiftKey && wasFocused);
      }
    } else {
      this.#focus.set(null);
      this.#pressDocument(x, y, count, shiftKey);
    }
  }

  /**
   * A press on the page's text (or in an editable): places the caret (a
   * collapsed selection), or selects a word (double) or a block (triple), or
   * extends the selection (Shift). Dragging then extends it.
   */
  #pressDocument(x: number, y: number, count: number, extend: boolean): void {
    const selection = this.#window.getSelection();
    if (!selection) return;
    const point = pointAt(this.#document, x, y);
    if (!point) {
      // Nothing to select there (or user-select: none): a press elsewhere still drops the selection.
      if (!extend) selection.removeAllRanges();
      return;
    }
    let start = point;
    let end = point;
    let unit: "char" | "word" | "line" = "char";
    if (extend && selection.anchorNode) {
      start = end = { node: selection.anchorNode, offset: selection.anchorOffset };
    } else if (count === 2) {
      [start, end] = wordAround(point);
      unit = "word";
    } else if (count >= 3) {
      [start, end] = blockAround(point);
      unit = "line";
    }
    this.#documentDrag = { unit, start, end };
    if (extend) this.#dragDocument(x, y);
    else selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  }

  /** Extends the page's selection being dragged to the point, by the unit the press chose. */
  #dragDocument(x: number, y: number): void {
    const { unit, start, end } = this.#documentDrag!;
    const selection = this.#window.getSelection();
    const point = pointAt(this.#document, x, y);
    if (!selection || !point) return;
    // A selection begun in an editable stays in it.
    const host = editingHostOf(start.node);
    if (host && !host.contains(point.node)) return;
    const [from, to] =
      unit === "char" ? [point, point] : unit === "word" ? wordAround(point) : blockAround(point);
    if (comparePoints(from, start) < 0)
      selection.setBaseAndExtent(end.node, end.offset, from.node, from.offset);
    else {
      const focus = comparePoints(to, end) < 0 ? end : to;
      selection.setBaseAndExtent(start.node, start.offset, focus.node, focus.offset);
    }
  }

  /**
   * A press in a text field: places the caret, or selects a word (double) or a
   * line (triple), or extends the selection (Shift). Dragging then extends it.
   */
  #pressText(field: TextField, x: number, y: number, count: number, extend: boolean): void {
    const index = this.#options.measure(() => indexFromPoint(field, x, y));
    const value = field.value;
    const multiline = field.tagName === "TEXTAREA";
    let start = index;
    let end = index;
    let unit: "char" | "word" | "line" = "char";
    if (extend) {
      const anchor =
        field.selectionDirection === "backward"
          ? (field.selectionEnd ?? index)
          : (field.selectionStart ?? index);
      start = end = anchor;
    } else if (count === 2) {
      [start, end] = wordAt(value, index);
      unit = "word";
    } else if (count >= 3) {
      start = multiline ? lineStart(value, index) : 0;
      end = multiline ? lineEnd(value, index) : value.length;
      unit = "line";
    }
    this.#textDrag = { field, unit, start, end };
    if (extend) this.#dragText(x, y);
    else this.#select(field, start, end);
  }

  /** Extends the selection being dragged to the point, by the unit the press chose. */
  #dragText(x: number, y: number): void {
    const { field, unit, start, end } = this.#textDrag!;
    const index = this.#options.measure(() => indexFromPoint(field, x, y));
    const value = field.value;
    if (unit === "char") {
      this.#select(field, start, index);
      return;
    }
    const [from, to] =
      unit === "word"
        ? wordAt(value, index)
        : field.tagName === "TEXTAREA"
          ? [lineStart(value, index), lineEnd(value, index)]
          : [0, value.length];
    if (index < start) this.#select(field, end, from);
    else this.#select(field, start, Math.max(to, end));
  }

  /** Selects from `anchor` to `focus` (the end that moves), and scrolls the field to show `focus`. */
  #select(field: TextField, anchor: number, focus: number): void {
    this.#history.breakTyping(field);
    field.setSelectionRange(
      Math.min(anchor, focus),
      Math.max(anchor, focus),
      focus < anchor ? "backward" : "forward",
    );
    this.#options.measure(() => revealIndex(field, focus));
  }

  // --- Pointer ---------------------------------------------------------------

  #hitTest(x: number, y: number): Element {
    return this.#document.elementFromPoint(x, y) ?? this.#document.documentElement;
  }

  #pointerInit(
    x: number,
    y: number,
    buttons: number,
    relatedTarget: Element | null = null,
  ): PointerEventInit {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: this.#window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons,
      relatedTarget,
      ...this.#pointerModifiers,
      pointerId: POINTER_ID,
      // A VR controller acts as a mouse to the page (it hovers, and has no touch events).
      pointerType: this.#pointerInput === "touch" ? "touch" : "mouse",
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: buttons ? 0.5 : 0,
    };
  }

  #pointerEvent(type: string, init: PointerEventInit): Event {
    // jsdom (tests) has no PointerEvent.
    const PointerEvent = this.#window.PointerEvent ?? this.#window.MouseEvent;
    return new PointerEvent(type, init);
  }

  #mouseEvent(type: string, init: MouseEventInit): Event {
    return new this.#window.MouseEvent(type, init);
  }

  /** Dispatches a pointer event and its compatibility mouse event. */
  #dispatchPair(
    target: Element,
    pointerType: string,
    mouseType: string,
    init: PointerEventInit,
    bubbles = true,
  ) {
    target.dispatchEvent(this.#pointerEvent(pointerType, { ...init, bubbles }));
    target.dispatchEvent(this.#mouseEvent(mouseType, { ...init, bubbles }));
  }

  #updateHover(target: Element | null, x: number, y: number): void {
    const previous = this.#hoverTarget;
    if (previous === target) return;
    const chain = ancestors(target);
    const chainSet = new Set(chain);
    const init = (related: Element | null) => this.#pointerInit(x, y, this.#press ? 1 : 0, related);

    if (previous?.isConnected) this.#dispatchPair(previous, "pointerout", "mouseout", init(target));
    for (const element of Array.from(this.hovered)) {
      if (!chainSet.has(element) && element.isConnected) {
        this.#dispatchPair(element, "pointerleave", "mouseleave", init(target), false);
      }
    }
    if (target) this.#dispatchPair(target, "pointerover", "mouseover", init(previous));
    for (const element of chain.slice().reverse()) {
      if (!this.hovered.has(element))
        this.#dispatchPair(element, "pointerenter", "mouseenter", init(previous), false);
    }

    this.hovered.clear();
    for (const element of chain) this.hovered.add(element);
    this.#hoverTarget = target;
    this.syncMarks();
  }

  #pointerDown(
    x: number,
    y: number,
    shiftKey: boolean,
    input: PointerInput = "mouse",
    toggle = false,
    hostSlop = 0,
  ): void {
    this.#pointer = { x, y };
    this.#pointerInput = input;
    this.#pan = null;
    // The list of a <select> is not the page either. A press elsewhere only closes it.
    if (this.#popup) {
      if (this.#popup.contains(x, y)) {
        this.#popupPress = true;
        this.#popup.hover(x, y);
      } else {
        this.#popup = null;
      }
      return;
    }
    // Like a real scrollbar, pressing one is not a press on the page.
    const bar = scrollbarAt(this.#document, x, y);
    if (bar) {
      this.#pressScrollbar(bar, x, y);
      return;
    }
    const now = performance.now();
    const last = this.#lastDown;
    // As far apart as a tap may wobble (see movedOff): on a panel drawn small, a second tap is many px off.
    const count =
      last &&
      now - last.time < DOUBLE_CLICK_MS &&
      Math.hypot(x - last.x, y - last.y) <= Math.max(CLICK_SLOP, hostSlop)
        ? last.count + 1
        : 1;
    this.#lastDown = { time: now, x, y, count };
    const target = this.#hitTest(x, y);
    this.#updateHover(target, x, y);
    this.#captureTarget = null;
    this.active.clear();
    for (const element of ancestors(target)) this.active.add(element);
    this.syncMarks();

    const init = this.#pointerInit(x, y, 1);
    const pointerOk = target.dispatchEvent(this.#pointerEvent("pointerdown", init));
    this.#press = { target, x, y, moved: false, mouseEvents: pointerOk, deferred: null, hostSlop };
    // A finger or controller drag scrolls, unless the page took the press (cancelled it).
    if (input !== "mouse" && pointerOk) this.#pan = this.#startPan(target, x, y, hostSlop);
    if (this.#pan) {
      this.#press.deferred = { detail: count, shiftKey, toggle };
      return;
    }
    // Cancelling pointerdown suppresses the compatibility mouse events, and with
    // them the default action of mousedown (focusing).
    if (pointerOk) this.#mouseDown(target, x, y, count, shiftKey, toggle);
  }

  #mouseDown(
    target: Element,
    x: number,
    y: number,
    detail: number,
    shiftKey: boolean,
    toggle = false,
  ): void {
    const listBox = target.closest("select");
    const before = isListBox(listBox) ? selectionOf(listBox) : null;
    if (
      !target.dispatchEvent(
        this.#mouseEvent("mousedown", { ...this.#pointerInit(x, y, 1), detail, shiftKey }),
      )
    )
      return;
    this.#focusAt(target, x, y, detail, shiftKey);
    // A press on a drop-down <select> opens its list (the page can prevent it by cancelling mousedown).
    const select = target.closest("select");
    if (isDropDown(select) && this.focused === select) {
      this.#popup = new SelectPopup(select);
      if (this.#press) this.#press.openedPopup = true;
    }
    if (isListBox(select) && this.focused === select) {
      if (before && changed(before, select))
        this.#listPress = { select, anchor: 0, toggle, before, native: true };
      else this.#pressListBox(select, y, shiftKey, toggle);
    }
  }

  // --- List boxes --------------------------------------------------------------

  /** A press on a list box's option: selects it, as browsers do (see list-box.ts). */
  #pressListBox(select: HTMLSelectElement, y: number, shiftKey: boolean, toggle: boolean): void {
    const index = optionAt(select, y);
    const option = index === null ? undefined : select.options[index];
    if (index === null || !option || !isUsable(option)) return;
    const before = selectionOf(select);
    const anchor = this.#listAnchors.get(select) ?? index;
    if (!select.multiple) select.selectedIndex = index;
    else if (shiftKey) selectRange(select, anchor, index, toggle);
    else if (toggle) option.selected = !option.selected;
    else selectRange(select, index, index);
    const start = select.multiple && shiftKey ? anchor : index;
    this.#listAnchors.set(select, start);
    this.#listCursors.set(select, index);
    this.#listPress = { select, anchor: start, toggle, before };
  }

  /** A drag in a list box selects the options from where it started to the pointer. */
  #dragListBox(y: number): void {
    const { select, anchor, toggle, native } = this.#listPress!;
    if (native) return;
    const index = optionAt(select, y, true);
    if (index === null) return;
    if (!select.multiple) {
      if (isUsable(select.options[index]!)) select.selectedIndex = index;
    } else if (!toggle) selectRange(select, anchor, index);
    this.#listCursors.set(select, index);
    revealOption(select, index);
  }

  /** The press ends: the page hears of the change, once. */
  #releaseListBox(): void {
    const press = this.#listPress;
    this.#listPress = null;
    // The browser that chose the options tells the page itself.
    if (!press || press.native) return;
    if (changed(press.before, press.select)) announceChange(press.select);
  }

  /** The keys on a focused list box: arrows, Home and End move the selection (Shift extends it), Ctrl/Cmd+A selects all. */
  #listBoxKey(select: HTMLSelectElement, input: Extract<PanelInput, { type: "key" }>): void {
    const { key, shiftKey, altKey } = input;
    const primary = this.#isApple()
      ? input.metaKey && !input.ctrlKey
      : input.ctrlKey && !input.metaKey;
    const before = selectionOf(select);
    if (primary && !altKey && key.toLowerCase() === "a" && select.multiple) {
      selectRange(select, 0, select.options.length - 1);
    } else {
      const steps = OPTION_STEPS.get(key);
      if (steps === undefined || altKey || primary) return;
      const from = this.#listCursors.get(select) ?? Math.max(0, select.selectedIndex);
      const index = stepOption(select.options.length, from, steps, (index) =>
        isUsable(select.options[index]!),
      );
      if (select.multiple && shiftKey)
        selectRange(select, this.#listAnchors.get(select) ?? from, index);
      else {
        select.selectedIndex = index;
        this.#listAnchors.set(select, index);
      }
      this.#listCursors.set(select, index);
      revealOption(select, index);
    }
    if (changed(before, select)) announceChange(select);
  }

  #pointerMove(x: number, y: number): void {
    this.#pointer = { x, y };
    if (this.#scrollbarPress) {
      this.#dragScrollbar(x, y);
      return;
    }
    // Over the list of a <select> (or dragging in it), the page gets nothing.
    if (this.#popup && (this.#popupPress || this.#popup.contains(x, y))) {
      this.#popup.hover(x, y);
      this.#hoveredScrollbar = null;
      this.#updateHover(null, x, y);
      return;
    }
    // Once the page captures the pointer, the drag is the page's.
    if (this.#captureTarget) this.#pan = null;
    if (this.#pan && this.#updatePan(this.#pan, x, y)) return;
    this.#hoveredScrollbar = this.#press ? null : scrollbarAt(this.#document, x, y);
    const target = this.#hitTest(x, y);
    this.#updateHover(target, x, y);
    const press = this.#press;
    if (press && movedOff(press, x, y)) press.moved = true;

    const destination = this.#captureTarget?.isConnected ? this.#captureTarget : target;
    const init = this.#pointerInit(x, y, press ? 1 : 0);
    destination.dispatchEvent(this.#pointerEvent("pointermove", init));
    if (!press || (press.mouseEvents && !press.deferred))
      destination.dispatchEvent(this.#mouseEvent("mousemove", init));
    if (press && this.#textDrag?.field.isConnected) this.#dragText(x, y);
    else if (press && this.#documentDrag) this.#dragDocument(x, y);
    else if (press && this.#listPress) this.#dragListBox(y);
  }

  #pointerUp(x: number, y: number): void {
    if (this.#scrollbarPress) {
      this.#scrollbarPress = null;
      window.clearTimeout(this.#pageTimer);
      return;
    }
    if (this.#popupPress) {
      this.#popupPress = false;
      this.#chooseAt(x, y);
      return;
    }
    this.#textDrag = null;
    this.#documentDrag = null;
    const pan = this.#pan;
    this.#pan = null;
    // A drag that scrolled already ended for the page (pointercancel): no pointerup, no click.
    if (pan?.active) {
      this.#press = null;
      this.#clearActive();
      this.#updateHover(this.#hitTest(x, y), x, y);
      return;
    }
    const press = this.#press;
    // Pressed on a <select> and released over its list: the release is the list's.
    if (this.#popup && press?.openedPopup && this.#popup.contains(x, y)) {
      this.#press = null;
      this.#clearActive();
      // Dragged from the select to an option: that option is chosen, as in browsers.
      this.#chooseAt(x, y);
      return;
    }
    const target = this.#hitTest(x, y);
    const destination = this.#captureTarget?.isConnected ? this.#captureTarget : target;
    const init = this.#pointerInit(x, y, 0);
    destination.dispatchEvent(this.#pointerEvent("pointerup", init));
    // A held-back press: a tap gets its mouse events now, a drag none.
    const deferred = press?.deferred;
    let mouseEvents = !press || press.mouseEvents;
    if (press && deferred) {
      mouseEvents = !press.moved;
      if (mouseEvents)
        this.#mouseDown(
          press.target,
          press.x,
          press.y,
          deferred.detail,
          deferred.shiftKey,
          deferred.toggle,
        );
      this.#textDrag = null;
      this.#documentDrag = null;
    }
    if (mouseEvents) destination.dispatchEvent(this.#mouseEvent("mouseup", init));
    this.#releaseListBox();
    if (this.#captureTarget) {
      this.#captureTarget.dispatchEvent(this.#pointerEvent("lostpointercapture", init));
      this.#captureTarget = null;
    }
    this.#press = null;
    // Released: no longer :active, before the click.
    this.#clearActive();
    this.#updateHover(target, x, y);

    if (!press || press.moved) return;
    const clickTarget = commonAncestor(press.target, target);
    if (!clickTarget) return;
    const now = performance.now();
    const last = this.#lastClick;
    const isDouble =
      last !== null &&
      now - last.time < DOUBLE_CLICK_MS &&
      Math.hypot(x - last.x, y - last.y) <= Math.max(CLICK_SLOP, press.hostSlop);
    clickTarget.dispatchEvent(this.#pointerEvent("click", { ...init, detail: isDouble ? 2 : 1 }));
    if (isDouble) {
      clickTarget.dispatchEvent(this.#mouseEvent("dblclick", { ...init, detail: 2 }));
      this.#lastClick = null;
    } else {
      this.#lastClick = { time: now, x, y };
    }
  }

  // --- The list of a <select> ------------------------------------------------

  /** Chooses the option at a point of the open list, and closes it; outside an option, it stays open. */
  #chooseAt(x: number, y: number): void {
    const popup = this.#popup;
    const item = popup?.itemAt(x, y) ?? null;
    if (!popup || !popup.choosable(item)) return;
    this.#popup = null;
    chooseOption(popup.select, popup.items[item]!.index);
  }

  /** The keys while the list is open, which go to it rather than the page. False to handle the key as usual. */
  #popupKey(popup: SelectPopup, input: Extract<PanelInput, { type: "key" }>): boolean {
    const steps = OPTION_STEPS.get(input.key);
    if (steps !== undefined) {
      popup.step(steps);
      return true;
    }
    switch (input.key) {
      case "Enter":
      case " ":
        this.#popup = null;
        if (popup.choosable(popup.highlighted))
          chooseOption(popup.select, popup.items[popup.highlighted]!.index);
        return true;
      case "Escape":
        this.#popup = null;
        return true;
      case "Tab":
        // Closes the list, and moves focus as usual.
        this.#popup = null;
        return false;
      default:
        return true;
    }
  }

  /** The keys on a focused drop-down <select> whose list is closed. */
  #selectKey(select: HTMLSelectElement, input: Extract<PanelInput, { type: "key" }>): void {
    const { key, altKey, ctrlKey, metaKey } = input;
    if (key === " " || key === "F4" || (altKey && (key === "ArrowDown" || key === "ArrowUp"))) {
      this.#popup = new SelectPopup(select);
      return;
    }
    // The arrows step from the selected option, Home and End from the ends; not the page keys.
    if (ctrlKey || metaKey || altKey || !CLOSED_SELECT_KEYS.has(key)) return;
    const steps = OPTION_STEPS.get(key)!;
    const options = select.options;
    const from = Number.isFinite(steps) ? select.selectedIndex : steps > 0 ? -1 : options.length;
    const index = stepOption(options.length, from, steps, (index) => isUsable(options[index]!));
    // Nothing to go to (stepOption returns where it started): it stays.
    if (options[index] && isUsable(options[index])) chooseOption(select, index);
  }

  /** Typing on a focused <select> picks the next option that starts with the text. */
  #selectTypeAhead(select: HTMLSelectElement, text: string): void {
    const options = select.options;
    const index = nextMatch(options.length, select.selectedIndex, text, (index) => {
      const option = options[index]!;
      return option.disabled || option.hidden ? null : labelOf(option);
    });
    if (index !== null) chooseOption(select, index);
  }

  // --- Drag scrolling ---------------------------------------------------------

  /** What a drag from `target` would scroll, and in which directions; null if nothing. */
  #startPan(target: Element, x: number, y: number, hostSlop: number): Pan | null {
    const touchActions = ancestors(target).map(
      (element) => this.#window.getComputedStyle(element).touchAction ?? "",
    );
    const axes = panAxes(touchActions);
    if (!axes.x && !axes.y) return null;
    const scroller = this.#panScroller(target, axes);
    if (!scroller) return null;
    const slop = Math.max(PAN_START_DISTANCE, hostSlop);
    return { target, scroller, axes, start: { x, y }, last: { x, y }, active: false, slop };
  }

  /** The nearest element that can scroll in an allowed direction, or the document's scroller. */
  #panScroller(target: Element, axes: PanAxes): Element | null {
    for (const element of ancestors(target)) {
      const style = this.#window.getComputedStyle(element);
      const y =
        axes.y &&
        /(auto|scroll|overlay)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight + 1;
      const x =
        axes.x &&
        /(auto|scroll|overlay)/.test(style.overflowX) &&
        element.scrollWidth > element.clientWidth + 1;
      if (x || y) return element;
    }
    const root = this.#document.scrollingElement;
    if (!root) return null;
    return root.scrollHeight > root.clientHeight + 1 || root.scrollWidth > root.clientWidth + 1
      ? root
      : null;
  }

  /** Follows the drag: true once it scrolls (and the page gets no more pointer events for it). */
  #updatePan(pan: Pan, x: number, y: number): boolean {
    if (!pan.active) {
      const dx = pan.axes.x ? Math.abs(x - pan.start.x) : 0;
      const dy = pan.axes.y ? Math.abs(y - pan.start.y) : 0;
      if (Math.max(dx, dy) < pan.slop) return false;
      // Browsers send pointercancel when a touch turns into a scroll.
      pan.active = true;
      this.#textDrag = null;
      this.#documentDrag = null;
      pan.target.dispatchEvent(this.#pointerEvent("pointercancel", this.#pointerInit(x, y, 0)));
      // It scrolls from where it left the slop, as browsers do: not by the slop at once.
      const within = (moved: number) => Math.sign(moved) * Math.min(Math.abs(moved), pan.slop);
      pan.last = {
        x: pan.start.x + within(x - pan.start.x),
        y: pan.start.y + within(y - pan.start.y),
      };
    }
    scrollByUser(pan.scroller, pan.axes.x ? pan.last.x - x : 0, pan.axes.y ? pan.last.y - y : 0);
    pan.last = { x, y };
    return true;
  }

  // --- Scrollbars ------------------------------------------------------------

  #pressScrollbar(bar: Scrollbar, x: number, y: number): void {
    const position = { x, y }[bar.axis];
    if (contains(hitBox(bar, bar.thumb), x, y)) {
      const scroll = bar.axis === "y" ? bar.element.scrollTop : bar.element.scrollLeft;
      this.#scrollbarPress = { bar, drag: { from: position, scroll }, position };
      return;
    }
    // A press on the track pages toward the press, and keeps paging while held
    // until the thumb reaches the pointer.
    this.#scrollbarPress = { bar, drag: null, position };
    this.#pageToward(bar, position);
    const repeat = () => {
      const press = this.#scrollbarPress;
      if (!press || press.drag) return;
      const current = scrollbarsOf(press.bar.element).find(
        (other) => other.axis === press.bar.axis,
      );
      if (!current || !this.#pageToward(current, press.position)) return;
      this.#options.onChange();
      this.#pageTimer = window.setTimeout(repeat, PAGE_REPEAT_INTERVAL_MS);
    };
    this.#pageTimer = window.setTimeout(repeat, PAGE_REPEAT_DELAY_MS);
  }

  /** Scrolls a page toward `position` on the track. False once the thumb is there. */
  #pageToward(bar: Scrollbar, position: number): boolean {
    const { thumb, element } = bar;
    const vertical = bar.axis === "y";
    const thumbStart = vertical ? thumb.top : thumb.left;
    if (position >= thumbStart && position < thumbStart + (vertical ? thumb.height : thumb.width))
      return false;
    const delta =
      (position < thumbStart ? -1 : 1) *
      (vertical ? element.clientHeight : element.clientWidth) *
      PAGE_SCROLL_RATIO;
    scrollByUser(element, vertical ? 0 : delta, vertical ? delta : 0);
    return true;
  }

  /** Moves the thumb with the pointer: the thumb's travel maps onto the scroll range. */
  #dragScrollbar(x: number, y: number): void {
    const press = this.#scrollbarPress!;
    const { bar, drag } = press;
    press.position = { x, y }[bar.axis];
    if (!drag) return;
    const { from, scroll } = drag;
    const travel = thumbTravel(bar);
    if (travel <= 0) return;
    const offset = scroll + ((press.position - from) * maxScroll(bar)) / travel;
    bar.element.scrollTo({
      [bar.axis === "y" ? "top" : "left"]: offset,
      behavior: "instant",
    });
  }

  #canScroll(element: Element, deltaX: number, deltaY: number): boolean {
    const style = this.#window.getComputedStyle(element);
    const scrollableY = /(auto|scroll|overlay)/.test(style.overflowY);
    const scrollableX = /(auto|scroll|overlay)/.test(style.overflowX);
    if (
      scrollableY &&
      deltaY > 0 &&
      element.scrollTop + element.clientHeight < element.scrollHeight - 1
    )
      return true;
    if (scrollableY && deltaY < 0 && element.scrollTop > 0) return true;
    if (
      scrollableX &&
      deltaX > 0 &&
      element.scrollLeft + element.clientWidth < element.scrollWidth - 1
    )
      return true;
    if (scrollableX && deltaX < 0 && element.scrollLeft > 0) return true;
    return false;
  }

  #wheel(x: number, y: number, deltaX: number, deltaY: number): void {
    if (this.#popup) {
      if (this.#popup.contains(x, y)) {
        this.#popup.scrollBy(deltaY);
        return;
      }
      // Scrolling the page moves the select away from its list: browsers close it.
      this.#popup = null;
    }
    const target = this.#hitTest(x, y);
    const event = new this.#window.WheelEvent("wheel", {
      ...this.#pointerInit(x, y, 0),
      deltaX,
      deltaY,
      deltaMode: 0,
    });
    if (!target.dispatchEvent(event)) return;
    for (const element of ancestors(target)) {
      if (this.#canScroll(element, deltaX, deltaY)) {
        scrollByUser(element, deltaX, deltaY);
        return;
      }
    }
    if (this.#document.scrollingElement)
      scrollByUser(this.#document.scrollingElement, deltaX, deltaY);
  }

  // --- Keyboard --------------------------------------------------------------

  #key(input: Extract<PanelInput, { type: "key" }>): void {
    if (this.#popup && this.#popupKey(this.#popup, input)) return;
    const target = this.focused ?? this.#document.body;
    const init: KeyboardEventInit = {
      key: input.key,
      shiftKey: input.shiftKey,
      ctrlKey: input.ctrlKey,
      altKey: input.altKey,
      metaKey: input.metaKey,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    const { KeyboardEvent } = this.#window;
    const listBefore = isListBox(target) ? selectionOf(target) : null;
    const allowed = target.dispatchEvent(new KeyboardEvent("keydown", init));
    // A list box the browser moved itself (WebKit does, even for synthetic keys) is not moved again.
    if (allowed && !(listBefore && isListBox(target) && changed(listBefore, target)))
      this.#keyDefaultAction(target, input);
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  #keyDefaultAction(target: Element, input: Extract<PanelInput, { type: "key" }>): void {
    if (input.key === "Escape") {
      this.#focus.set(null);
      return;
    }
    const plain = !input.ctrlKey && !input.metaKey && !input.altKey;
    if (input.key === "Tab" && plain) {
      this.#moveFocus(input.shiftKey ? -1 : 1);
      return;
    }
    if (isDropDown(target)) {
      this.#selectKey(target, input);
      return;
    }
    if (isListBox(target)) {
      this.#listBoxKey(target, input);
      return;
    }
    if (isEditingHost(target)) {
      this.#contentKey(target, input);
      return;
    }
    if (!isTextField(target)) {
      if (plain) this.#activate(target, input.key);
      this.#documentKey(input);
      return;
    }

    const field = target;
    const length = field.value.length;
    const action = editAction(
      {
        value: field.value,
        start: field.selectionStart ?? length,
        end: field.selectionEnd ?? length,
        direction: field.selectionDirection ?? "none",
        multiline: field.tagName === "TEXTAREA",
      },
      input,
      {
        apple: this.#isApple(),
        verticalTarget: (index, direction, page) =>
          this.#verticalTarget(field, index, direction, page),
      },
    );
    if (!action) return;
    if (action.type === "select") this.#select(field, action.anchor, action.focus);
    else if (action.type === "edit")
      this.#editText(field, action.text, action.start, action.end, action.inputType);
    else if (action.type === "undo" || action.type === "redo") this.#undo(field, action.type);
    else field.form?.requestSubmit();
  }

  /** A key in a contenteditable element: the browser edits, at the page's selection (see contenteditable.ts). */
  #contentKey(host: HTMLElement, input: Extract<PanelInput, { type: "key" }>): void {
    const selection = this.#window.getSelection();
    if (!selection) return;
    this.#keepSelectionIn(host, selection);
    const action = contentAction(input, this.#isApple(), selection.isCollapsed);
    if (!action) return;
    switch (action.type) {
      case "modify":
        selection.modify(action.alter, action.direction, action.granularity);
        return;
      case "collapse":
        if (action.toStart) selection.collapseToStart();
        else selection.collapseToEnd();
        return;
      case "selectAll":
        selection.selectAllChildren(host);
        return;
      case "command": {
        const { extend } = action;
        // Deleting a word or to the line's end: what goes is selected first.
        const before = selection.getRangeAt(0).cloneRange();
        if (extend && selection.isCollapsed)
          selection.modify("extend", extend.direction, extend.granularity);
        if (!this.#editContent(host, action.inputType, action.command)) {
          selection.removeAllRanges();
          selection.addRange(before);
        }
      }
    }
  }

  /** Keys with no element focused: select all, and Shift with the arrows extends the page's selection. */
  #documentKey(input: Extract<PanelInput, { type: "key" }>): void {
    const selection = this.#window.getSelection();
    if (!selection) return;
    const action = contentAction(input, this.#isApple(), selection.isCollapsed);
    if (action?.type === "selectAll") selection.selectAllChildren(this.#document.body);
    else if (action?.type === "modify" && action.alter === "extend" && selection.rangeCount > 0) {
      selection.modify("extend", action.direction, action.granularity);
    }
  }

  /** Puts the selection at the end of an editable when it is not in it (the page moved it away). */
  #keepSelectionIn(host: HTMLElement, selection: Selection): void {
    if (
      selection.rangeCount > 0 &&
      host.contains(selection.anchorNode) &&
      host.contains(selection.focusNode)
    )
      return;
    selection.selectAllChildren(host);
    selection.collapseToEnd();
  }

  /**
   * Edits an editable at the selection with a browser command, after a
   * beforeinput the page can cancel (the browser itself sends none with a
   * command, except WebKit, whose own is held back). False if nothing was done.
   */
  #editContent(
    host: HTMLElement,
    inputType: string,
    command: string,
    data: string | null = null,
  ): boolean {
    if (!this.#inputEvent(host, "beforeinput", inputType, data)) return false;
    this.#runningCommand = true;
    let done = false;
    try {
      done = this.#document.execCommand(command, false, data ?? undefined);
    } finally {
      this.#runningCommand = false;
    }
    if (done || inputType !== "insertText" || data === null) return done;
    // No command (a browser without it): insert the text by hand.
    const selection = this.#window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const text = this.#document.createTextNode(data);
    range.insertNode(text);
    selection.collapse(text, text.length);
    this.#inputEvent(host, "input", inputType, data);
    return true;
  }

  /** Dispatches beforeinput, which the page can cancel (then false), or input. */
  #inputEvent(
    target: Element,
    type: "beforeinput" | "input",
    inputType: string,
    data: string | null,
  ): boolean {
    return target.dispatchEvent(
      new this.#window.InputEvent(type, {
        bubbles: true,
        cancelable: type === "beforeinput",
        composed: true,
        inputType,
        data,
      }),
    );
  }

  /** The default actions of keys on buttons, links, checkboxes and radio buttons. */
  #activate(target: Element, key: string): void {
    const { HTMLInputElement, HTMLElement } = this.#window;
    const kind = target instanceof HTMLInputElement ? target.type : "";
    if (kind === "checkbox" || kind === "radio") {
      if (key === " ") (target as HTMLInputElement).click();
      else if (kind === "radio" && /^Arrow(Up|Down|Left|Right)$/.test(key)) {
        this.#stepRadio(
          target as HTMLInputElement,
          key === "ArrowUp" || key === "ArrowLeft" ? -1 : 1,
        );
      }
      return;
    }
    if ((key === "Enter" || key === " ") && target.matches("button, a[href], [role=button]")) {
      if (target instanceof HTMLElement) target.click();
    }
  }

  /** Arrows in a radio group check the next (or previous) radio, as browsers do. */
  #stepRadio(radio: HTMLInputElement, direction: -1 | 1): void {
    const group = this.#radioGroup(radio).filter((other) => !other.disabled);
    const index = group.indexOf(radio);
    const next = group[(index + direction + group.length) % group.length];
    if (!next || next === radio) return;
    this.#focus.set(next);
    next.click();
  }

  #radioGroup(radio: HTMLInputElement): HTMLInputElement[] {
    if (!radio.name) return [radio];
    const scope = radio.form ?? radio.ownerDocument;
    return Array.from(scope.querySelectorAll<HTMLInputElement>("input[type=radio]")).filter(
      (other) => other.name === radio.name && other.form === radio.form,
    );
  }

  /**
   * Tab: focus moves to the next element in tab order (a positive tabindex
   * first, by its value, then document order), Shift+Tab to the previous one,
   * wrapping around. A radio group is one stop, at its checked radio. A text
   * field focused this way has its text selected, as in browsers.
   */
  #moveFocus(direction: -1 | 1): void {
    const order = this.#tabOrder();
    if (order.length === 0) return;
    const current = this.focused;
    const index = current ? order.indexOf(current) : -1;
    const next =
      index === -1
        ? order[direction > 0 ? 0 : order.length - 1]!
        : order[(index + direction + order.length) % order.length]!;
    this.#focus.set(next);
    if (isTextField(next)) next.setSelectionRange(0, next.value.length);
    next.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  #tabOrder(): Element[] {
    const { HTMLElement, HTMLInputElement } = this.#window;
    const candidates = Array.from(this.#document.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (element) => {
        if (
          !(element instanceof HTMLElement) ||
          element.tabIndex < 0 ||
          !this.#focus.isFocusable(element)
        )
          return false;
        if (element.closest("[inert]")) return false;
        // jsdom has no checkVisibility; there, everything counts as shown.
        if (
          typeof element.checkVisibility === "function" &&
          !element.checkVisibility({ visibilityProperty: true })
        ) {
          return false;
        }
        if (element instanceof HTMLInputElement && element.type === "radio") {
          // One stop per group: the checked radio, or else the first one.
          const group = this.#radioGroup(element);
          return element === (group.find((radio) => radio.checked) ?? group[0]);
        }
        return true;
      },
    ) as HTMLElement[];
    const positive = candidates
      .filter((element) => element.tabIndex > 0)
      .sort((a, b) => a.tabIndex - b.tabIndex);
    return [...positive, ...candidates.filter((element) => element.tabIndex === 0)];
  }

  #stateOf(field: TextField): FieldState {
    const length = field.value.length;
    return {
      value: field.value,
      start: field.selectionStart ?? length,
      end: field.selectionEnd ?? length,
    };
  }

  /** Puts a field back to a state from its history, the way the browser's undo would. */
  #undo(field: TextField, which: "undo" | "redo"): void {
    const now = this.#stateOf(field);
    const state =
      which === "undo" ? this.#history.undo(field, now) : this.#history.redo(field, now);
    if (!state) return;
    const inputType = which === "undo" ? "historyUndo" : "historyRedo";
    if (!this.#inputEvent(field, "beforeinput", inputType, null)) return;
    field.setRangeText(state.value, 0, field.value.length);
    field.setSelectionRange(state.start, state.end);
    this.#history.edited(field, field.value);
    this.#options.measure(() => revealIndex(field, state.end));
    this.#inputEvent(field, "input", inputType, null);
  }

  /** The host's field cut the selected text to the clipboard: take it out of the page's field too. */
  #cut(): void {
    const field = this.focused;
    if (isEditingHost(field)) {
      if (selectedRange(this.#window)) this.#editContent(field, "deleteByCut", "delete");
      return;
    }
    if (!isTextField(field)) return;
    const { start, end } = this.#stateOf(field);
    if (start !== end) this.#editText(field, "", start, end, "deleteByCut");
  }

  /** Up/Down keep to the horizontal position they started from, like browsers do. */
  #verticalTarget(
    field: TextField,
    index: number,
    direction: -1 | 1,
    page: boolean,
  ): number | null {
    const goal = this.#goal;
    const x =
      goal && goal.field === field && goal.index === index
        ? goal.x
        : this.#options.measure(() => caretAt(field, index).x);
    const target = this.#options.measure(() => verticalIndex(field, index, direction, page, x));
    this.#goal = { field, index: target ?? (direction < 0 ? 0 : field.value.length), x };
    return target;
  }

  #isApple(): boolean {
    const navigator = this.#window.navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    return APPLE_PLATFORM.test(navigator.userAgentData?.platform || navigator.platform || "");
  }

  #text(text: string): void {
    const target = this.focused;
    // A space is typed, not a key, as far as the host can tell. On a checkbox or a
    // button it is the key that toggles or presses it (and opens a <select>'s list).
    if (text === " " && target && !isTextField(target) && !isEditingHost(target)) {
      this.#key({
        type: "key",
        key: " ",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });
      return;
    }
    if (text === "") return;
    if (this.#popup) {
      this.#popup.typeAhead(text);
      return;
    }
    if (isDropDown(target) || isListBox(target)) {
      this.#selectTypeAhead(target, text);
      return;
    }
    if (isEditingHost(target)) {
      const selection = this.#window.getSelection();
      if (selection) this.#keepSelectionIn(target, selection);
      this.#editContent(target, "insertText", "insertText", text);
      return;
    }
    if (!isTextField(target)) return;
    const length = target.value.length;
    this.#editText(
      target,
      text,
      target.selectionStart ?? length,
      target.selectionEnd ?? length,
      "insertText",
    );
  }

  /**
   * Replaces a range of a text field the way typing would, with beforeinput and
   * input events. setRangeText does not go through the `value` setter, so
   * frameworks that track the value (React) still see the change on `input`.
   */
  #editText(field: TextField, text: string, start: number, end: number, inputType: string): void {
    const data = text === "" ? null : text;
    if (!this.#inputEvent(field, "beforeinput", inputType, data)) return;
    this.#history.record(
      field,
      { value: field.value, start, end: field.selectionEnd ?? end },
      inputType,
    );
    if (data !== null && field.maxLength >= 0) {
      const room = field.maxLength - (field.value.length - (end - start));
      text = text.slice(0, Math.max(0, room));
    }
    field.setRangeText(text, start, end, "end");
    this.#history.edited(field, field.value);
    this.#options.measure(() => revealIndex(field, field.selectionEnd ?? field.value.length));
    this.#inputEvent(field, "input", inputType, data);
  }
}
