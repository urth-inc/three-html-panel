// Copies the live page into an XHTML string that can go inside an SVG
// <foreignObject>.
//
// Serializing the DOM is not enough on its own, because a lot of what is on
// screen is not in the markup:
//
// - form state (value, checked, selected) lives in properties, not attributes
// - scroll positions are not rendered by foreignObject at all, and the real
//   scrollbars would not show them either: they are replaced (scrollbars.ts)
// - interaction states (:hover, :focus) are attributes the agent sets on the
//   page's elements (interaction-marks.ts), copied with them; see css.ts
// - animations are frozen: finite ones as they will end, the others as they are
//   now (see collectAnimatedValues)
// - images and canvases must be embedded as data URLs, and a video as its
//   current frame
//
// The copy is built in an inert document, so <img> elements in it never start
// loading anything.
//
// Type checks on live elements use the page's window (see FrameWindow).

import type { Box, FrameWindow } from "../../types";
import { scrolledText } from "../input/caret";
import { scrollbarsOf, type Scrollbar } from "../input/scrollbars";
import type { PopupView } from "../input/select-popup";
import type { SelectionBox } from "../input/selection";
import { topLayerStates } from "../input/top-layer";
import { MODAL_ATTRIBUTE, POPOVER_OPEN_ATTRIBUTE } from "./css";

/** Elements that do not contribute to what is on screen. <style> is collected separately. */
const SKIPPED_ELEMENTS = new Set([
  "SCRIPT",
  "NOSCRIPT",
  "TEMPLATE",
  "STYLE",
  "LINK",
  "META",
  "TITLE",
  "BASE",
  "IFRAME",
]);

export interface SnapshotOptions {
  /** Elements added to the page only for measuring (e.g. the caret mirror); left out of the copy. */
  ignored?: ReadonlySet<Element>;
  /** Returns a data URL for an image, or null if it is not available yet. */
  inlineImage: (url: string) => string | null;
  /** The selected text in the focused field, as measured by measureSelection(), or the page's (each box with its text). */
  selection?: readonly (Box | SelectionBox)[];
  /** The field the selection is in, if it is a field's: drawn in its layer (see liftToTopLayer). */
  selectionIn?: Element | null;
  /** The page's ::selection background, if any; a default is used when it is transparent. */
  selectionColor?: string;
  /** The selection is not where the keys go (the panel is not active): drawn grey, as browsers do. */
  selectionInactive?: boolean;
  /**
   * Text being composed with an IME in a field: the value it shows while
   * composing, which goes into the copy only (never into the page), and the
   * boxes the composed text covers, underlined.
   */
  composition?: { field: Element; value: string; boxes: readonly Box[]; color: string } | null;
  /**
   * Text being composed with an IME in a contenteditable element: shown, in the
   * copy only, where the selection starts (in place of the selected text when
   * that is within one text node), underlined.
   */
  inlineComposition?: { node: Node; offset: number; endOffset: number; text: string } | null;
  /** The scrollbar being hovered or pressed, drawn darker. */
  scrollbar?: { element: Element; axis: "x" | "y"; state: "hover" | "active" } | null;
  /** The open list of a <select>, drawn over everything. */
  selectPopup?: PopupView | null;
  /**
   * The selected options of a focused list box, drawn over the copy as a
   * focused one's: the copy is never focused, and browsers draw its selection
   * in their inactive grey (WebKit whatever the page's CSS says).
   */
  listBoxSelection?: readonly ListBoxRow[];
  /** The list box listBoxSelection is of. */
  listBox?: Element | null;
  /** When each open popover and dialog was opened (0 if not seen): the top layer is stacked in that order. */
  openedAt?: (element: Element) => number;
}

/** A selected option of a focused list box: where it shows (cut by the box), where it is, and its label. */
export interface ListBoxRow {
  shown: Box;
  box: Box;
  label: string;
  font: string;
  paddingLeft: number;
}

/** Selected options of a focused list box, as browsers draw them. */
const LIST_BOX_SELECTED = "rgb(30 110 220)";

/** The last frame encoded for each video, with what it was taken at (see Snapshotter.videoFrame). */
const videoFrames = new WeakMap<
  HTMLVideoElement,
  { key: string; source: MediaProvider | string; url: string | null }
>();

/** A video's current frame at this size, as a JPEG data URL; null if it cannot be read. */
function encodeFrame(
  document: Document,
  video: HTMLVideoElement,
  width: number,
  height: number,
): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  try {
    context.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    // A video from another origin without CORS taints the canvas.
    return null;
  }
}

/** A video's attributes that mean nothing on the image that stands for it. */
const VIDEO_ATTRIBUTES = new Set([
  "src",
  "poster",
  "controls",
  "autoplay",
  "loop",
  "muted",
  "preload",
  "playsinline",
  "crossorigin",
]);
/** A video frame is drawn at most this many times its size on the page (the panel's pixel ratio is not known here). */
const VIDEO_SCALE = 2;

const toKebabCase = (property: string) =>
  property.startsWith("--")
    ? property
    : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const KEYFRAME_META_KEYS = new Set(["offset", "computedOffset", "easing", "composite"]);

/** Whether `animation` is a CSS transition. Checked by shape: the page is another realm in tests. */
const isTransition = (animation: Animation) => "transitionProperty" in animation;

/**
 * Which end of its keyframes (0 or 1) a finite animation stops at, from its
 * direction and iteration count; null if it does not stop at an end (infinite,
 * or a fractional count such as 1.5).
 */
export function endOffsetOf(timing: EffectTiming): 0 | 1 | null {
  const iterations = timing.iterations ?? 1;
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  const last = iterations - 1;
  const reversed =
    timing.direction === "reverse" ||
    (timing.direction === "alternate" && last % 2 === 1) ||
    (timing.direction === "alternate-reverse" && last % 2 === 0);
  return reversed ? 0 : 1;
}

/** Whether an animation's value is copied as it is now, so the panel must keep sampling it. */
export function isSampledLive(animation: Animation): boolean {
  if (isTransition(animation)) return false;
  const effect = animation.effect as KeyframeEffect | null;
  return animation.playState === "paused" || endOffsetOf(effect?.getTiming?.() ?? {}) === null;
}

/**
 * The animated values to bake into each element's copy: property (kebab-case)
 * to value, where null means the live document's value now.
 *
 * Browsers can hold back rendering in the panel's iframe (to them it is a
 * cross-origin frame the user never touches), for up to a second in Chrome,
 * and animations do not advance meanwhile. Copying their values now would show
 * a fade-in still transparent long after it should have ended. So animations
 * that end are copied as they will be at the end:
 * - transitions, and animations that do not fill forwards, end on the element's
 *   own style, which the image shows anyway: nothing is baked
 * - animations that fill forwards (or both) end on their last keyframe
 * - animations that repeat forever, and paused ones, are copied as they are now
 * Pseudo-element animations cannot go into an inline style and are left out.
 */
function collectAnimatedValues(document: Document): Map<Element, Map<string, string | null>> {
  const result = new Map<Element, Map<string, string | null>>();
  if (typeof document.getAnimations !== "function") return result;
  for (const animation of document.getAnimations()) {
    const effect = animation.effect as KeyframeEffect | null;
    if (!effect?.target || effect.pseudoElement || typeof effect.getKeyframes !== "function")
      continue;
    if (isTransition(animation)) continue;
    let values = result.get(effect.target);
    if (!values) result.set(effect.target, (values = new Map()));
    const keyframes = effect.getKeyframes();

    if (isSampledLive(animation)) {
      for (const keyframe of keyframes) {
        for (const key of Object.keys(keyframe))
          if (!KEYFRAME_META_KEYS.has(key)) values.set(toKebabCase(key), null);
      }
      continue;
    }
    const timing = effect.getTiming();
    if (timing.fill !== "forwards" && timing.fill !== "both") continue;
    // A property missing from the end keyframe ends on the element's own style.
    const endOffset = endOffsetOf(timing);
    for (const keyframe of keyframes) {
      if (keyframe.computedOffset !== endOffset) continue;
      for (const [key, value] of Object.entries(keyframe)) {
        if (!KEYFRAME_META_KEYS.has(key) && typeof value === "string")
          values.set(toKebabCase(key), value);
      }
    }
  }
  return result;
}

/** An absolute or fixed element's copy, and its containing block on the page (see Snapshotter.absoluteContainer). */
interface Positioned {
  copy: Element;
  fixed: boolean;
  container: Element | null;
}

const isStyled = (element: Element): element is HTMLElement | SVGElement =>
  element instanceof HTMLElement || element instanceof SVGElement;

const isSet = (value: string | undefined) => !!value && value !== "none";

/** Whether a box is the containing block of the fixed elements in it (and so of absolute ones). */
function containsFixed(style: CSSStyleDeclaration): boolean {
  return (
    isSet(style.transform) ||
    isSet(style.translate) ||
    isSet(style.rotate) ||
    isSet(style.scale) ||
    isSet(style.perspective) ||
    isSet(style.filter) ||
    isSet(style.backdropFilter) ||
    /paint|layout|strict|content/.test(style.contain ?? "") ||
    /transform|translate|rotate|scale|perspective|filter/.test(style.willChange ?? "") ||
    (isSet(style.containerType) && style.containerType !== "normal") ||
    style.contentVisibility === "auto"
  );
}

/**
 * The value of a property to move from: the one baked into the copy (an
 * animation's, see copyAnimatedValues), or else the page's.
 */
function baseValue(
  copy: HTMLElement | SVGElement,
  style: CSSStyleDeclaration,
  property: string,
): string {
  return copy.style.getPropertyPriority(property) === "important"
    ? copy.style.getPropertyValue(property)
    : style.getPropertyValue(property);
}

/** A length plus `by` px: in px where it is in px (or auto, as 0), in calc() otherwise (a percentage). */
function plus(value: string, by: number): string {
  if (value === "" || value === "auto" || value === "0") return `${by}px`;
  if (by === 0) return value;
  if (/^-?[\d.]+(e-?\d+)?px$/.test(value)) return `${parseFloat(value) + by}px`;
  return `calc(${value} + ${by}px)`;
}

/** The values of a space-separated list ("x y z"), keeping the spaces in functions (calc(), min()…). */
function splitValues(value: string): string[] {
  const values: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value.trim()) {
    if (character === "(") depth++;
    else if (character === ")") depth--;
    if (depth === 0 && /\s/.test(character)) {
      if (current) values.push(current);
      current = "";
    } else current += character;
  }
  if (current) values.push(current);
  return values;
}

/** A translate (as computed, or none) moved by (dx, dy). */
function movedTranslate(translate: string, dx: number, dy: number): string {
  const [x = "0px", y = "0px", z] = isSet(translate) ? splitValues(translate) : [];
  return [plus(x, dx), plus(y, dy), ...(z ? [z] : [])].join(" ");
}

interface ScrollMoveOptions {
  /** The display of its parent (a z-index applies to flex and grid items unpositioned). */
  parentDisplay: string;
  /** An absolute or fixed one scrolls with the content: what scrolls is its containing block. */
  scrolls: boolean;
  /** An absolute one at its place in the flow (both insets auto) is moved by its margin. */
  byMargin: boolean;
  /** A sticky one is lifted over its siblings (positioned now). */
  lift: boolean;
}

/**
 * The declarations ([property, value]) that move something scrolled (an
 * element's copy, or a generated box) up and left by the scroll (x, y), by
 * its position, from the values `value` gives (see Snapshotter.moveScrolled):
 * - static or relative: positioned relatively, its relative offset kept, the
 *   page's z-index on a static box still ignored
 * - absolute or fixed: by its insets, if it scrolls with the content
 * - sticky: translated (added to its own translate), its insets moved the
 *   other way; lifted with z-index 1 if `lift`
 */
function scrollMoves(
  position: string,
  value: (property: string) => string,
  x: number,
  y: number,
  options: ScrollMoveOptions,
): [string, string][] {
  if (position === "static" || position === "relative") {
    // Relative offsets as laid out (used, in px), or as an animation ends;
    // none for a static box (its insets do not apply).
    const offset = (side: string) => (position === "relative" ? value(side) : "0px");
    const moves: [string, string][] = [
      ["position", "relative"],
      ["top", plus(offset("top"), -y)],
      ["left", plus(offset("left"), -x)],
      ["bottom", "auto"],
      ["right", "auto"],
    ];
    if (position === "static" && !/flex|grid/.test(options.parentDisplay))
      moves.push(["z-index", "auto"]);
    return moves;
  }
  if (position === "absolute" || position === "fixed")
    return options.scrolls ? insetMoves(value, position, -x, -y, options.byMargin) : [];
  // The individual `translate` property composes with any `transform` it has.
  return [
    ...(options.lift ? [["z-index", "1"] as [string, string]] : []),
    ["translate", movedTranslate(value("translate"), -x, -y)],
    ...insetMoves(value, position, x, y, false),
  ];
}

/**
 * The insets that move a positioned box, as [property, value]: by (dx, dy)
 * for an absolute or fixed one, or the other way for a sticky one ((dx, dy)
 * being the scroll). An absolute one with both insets of an axis auto (at its
 * place in the flow) is moved by its margin, if `byMargin`. `value` gives the
 * property values to move from.
 */
function insetMoves(
  value: (property: string) => string,
  position: string,
  dx: number,
  dy: number,
  byMargin: boolean,
): [string, string][] {
  const moves: [string, string][] = [];
  const axes = [
    ["top", "bottom", "margin-top", dy],
    ["left", "right", "margin-left", dx],
  ] as const;
  const auto = (value: string) => value === "" || value === "auto";
  for (const [start, end, margin, by] of axes) {
    if (by === 0) continue;
    const from = value(start);
    const to = value(end);
    if (!auto(from)) moves.push([start, plus(from, by)]);
    if (!auto(to)) moves.push([end, plus(to, -by)]);
    if (auto(from) && auto(to) && byMargin && position !== "sticky")
      moves.push([margin, plus(value(margin), by)]);
  }
  return moves;
}

/** Whether a box is the containing block of the absolute elements in it. */
const containsAbsolute = (style: CSSStyleDeclaration) =>
  style.position !== "static" || containsFixed(style);

/** Whether a generated box (::before, ::after) is empty: margins collapse through it. */
function isEmptyBox(style: CSSStyleDeclaration): boolean {
  return [
    "height",
    "padding-top",
    "padding-bottom",
    "border-top-width",
    "border-bottom-width",
  ].every((property) => (parseFloat(style.getPropertyValue(property)) || 0) === 0);
}

/** Whether a ::before or ::after has a box. */
const isGenerated = (style: CSSStyleDeclaration) =>
  !/^(none|normal)?$/.test(style.content ?? "") && style.display !== "none";

/**
 * The top margin for the first box of a flow that moves the flow up by `y`,
 * given the top margins that collapse together there (the box's first, then
 * those of the first boxes in it): together they must make `y` less. Null
 * where no margin does.
 */
function marginMovingFlow(margins: number[], y: number): number | null {
  const most = (list: number[]) => Math.max(0, ...list);
  const least = (list: number[]) => Math.min(0, ...list);
  const together = most(margins) + least(margins);
  const rest = margins.slice(1);
  const positive = most(rest);
  const negative = least(rest);
  const target = together - y;
  // Negative (the most negative of them), or positive (the most positive).
  if (target - positive <= negative) return target - positive;
  if (target - negative >= positive) return target - negative;
  return null;
}

/** Marks a scrolled container's copy, for the rules that move its generated boxes. */
const SCROLLED_ATTRIBUTE = "data-thp-scrolled";
/**
 * The cascade layer of those rules, declared before the page's CSS: important
 * declarations of the first layer win over all others (unlayered ones too),
 * whatever their specificity.
 */
const SCROLLED_LAYER = "thp-scrolled";

/** Displays of a scroll container that lays out its children as blocks (in a flow of its own). */
const BLOCK_CONTAINER = /^(block|inline-block|flow-root|list-item|table-cell|table-caption)$/;

/** Block-level displays: boxes of a block container's flow, not in lines. */
const BLOCK_LEVEL = /^(block|list-item|table|flex|grid|flow-root|-webkit-box)$/;

/** What a pinned element keeps as the page has it, from its own containing block there. */
const PINNED_SIZES = [
  "width",
  "height",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
];

class Snapshotter {
  // A separate document without a browsing context, so the copies never load anything.
  readonly #inert = globalThis.document.implementation.createHTMLDocument("");
  readonly #window: FrameWindow;
  readonly #animated: Map<Element, Map<string, string | null>>;
  /** The page's element each copy is of. */
  readonly #liveOf = new WeakMap<Element, Element>();
  /** And the other way. */
  readonly #copies = new WeakMap<Element, Element>();
  /** The computed style of each element copied, read once. */
  readonly #styles = new Map<Element, CSSStyleDeclaration>();
  /** The absolute and fixed elements copied, by the page's element. */
  readonly #positioned = new Map<Element, Positioned>();
  /** The elements with fixed ones in them placed from outside them. */
  readonly #holdingFixed = new Set<Element>();
  /** Rules that move the generated boxes of scrolled containers (see shiftFlow). */
  readonly generatedRules: string[] = [];
  /** The elements with something positioned in them that has a z-index of its own. */
  readonly #zOrdered = new Set<Element>();
  /**
   * Copies moved for a scroll, and how: positioned relatively (the containing
   * block of absolute elements in them, now) or translated (of fixed ones too).
   */
  readonly #moved = new Map<Element, "relative" | "translated">();
  /**
   * The page's containing blocks of absolute and fixed elements where the copy
   * is now; null for the initial containing block (absolute) or the viewport (fixed).
   */
  #absoluteContainer: Element | null = null;
  #fixedContainer: Element | null = null;
  /** Scrollbars to draw over the copy. */
  readonly scrollbars: Scrollbar[] = [];
  /** Open popovers and modal dialogs, in the order copied: the page's top layer (see liftToTopLayer). */
  readonly topLayer: { live: Element; copy: HTMLElement }[] = [];

  readonly #document: Document;
  readonly #options: SnapshotOptions;

  constructor(document: Document, options: SnapshotOptions) {
    this.#document = document;
    this.#options = options;
    this.#window = document.defaultView as FrameWindow;
    this.#animated = collectAnimatedValues(document);
  }

  copy(live: Node): Node | null {
    if (live.nodeType === Node.TEXT_NODE) {
      const composition = this.#options.inlineComposition;
      if (composition?.node === live) return this.#composedText(live as Text, composition);
      return this.#inert.importNode(live, false);
    }
    if (live.nodeType !== Node.ELEMENT_NODE) return null;
    const element = live as Element;
    if (SKIPPED_ELEMENTS.has(element.tagName) || this.#options.ignored?.has(element)) return null;
    const style = this.#window.getComputedStyle(element);
    this.#styles.set(element, style);

    if (element instanceof this.#window.HTMLCanvasElement)
      return this.#remember(element, style, this.#copyCanvas(element));
    if (element instanceof this.#window.HTMLVideoElement)
      return this.#remember(element, style, this.#copyVideo(element));

    const copy = this.#remember(element, style, this.#inert.importNode(element, false) as Element);
    this.#copyFormState(element, copy);
    this.#copyImage(element, copy, style);
    this.#copyAnimatedValues(element, copy);
    this.#markTopLayer(element, copy);

    // <head> carries no visible content, but keep the element so the structure stays valid.
    if (element.tagName === "HEAD") return copy;

    const outer = [this.#absoluteContainer, this.#fixedContainer] as const;
    if (containsFixed(style)) this.#absoluteContainer = this.#fixedContainer = element;
    else if (containsAbsolute(style)) this.#absoluteContainer = element;
    const children = element.tagName === "TEXTAREA" ? [] : Array.from(element.childNodes);
    // Composed text between two children (an empty line of an editable, say).
    const composition = this.#options.inlineComposition;
    const composedAt = composition?.node === element ? composition.offset : -1;
    children.forEach((child, index) => {
      if (index === composedAt) copy.appendChild(this.#composedSpan(composition!.text));
      const childCopy = this.copy(child);
      if (childCopy) copy.appendChild(childCopy);
    });
    if (composedAt === children.length) copy.appendChild(this.#composedSpan(composition!.text));
    [this.#absoluteContainer, this.#fixedContainer] = outer;
    this.#copyScroll(element, copy);
    this.#hideScrollbars(element, copy, style);
    return copy;
  }

  /**
   * An open popover or a modal dialog is in the top layer, which matches
   * :popover-open or :modal: the copy is in none, so it gets their attributes
   * (the page's rules are rewritten to match them too, see css.ts).
   */
  #markTopLayer(element: Element, copy: Element): void {
    const states = topLayerStates(element);
    if (!states) return;
    const { popover, modal } = states;
    if (popover) copy.setAttribute(POPOVER_OPEN_ATTRIBUTE, "");
    if (modal) copy.setAttribute(MODAL_ATTRIBUTE, "");
    this.topLayer.push({ live: element, copy: copy as HTMLElement });
  }

  /** Notes what a copy is of, and where it is positioned from if it is absolute or fixed. */
  #remember<T extends Node | null>(live: Element, style: CSSStyleDeclaration, copy: T): T {
    if (!(copy instanceof Element)) return copy;
    this.#liveOf.set(copy, live);
    this.#copies.set(live, copy);
    // A z-index applies to positioned boxes, and to flex and grid items.
    const parent = live.parentElement && this.#styles.get(live.parentElement);
    const stacked = style.position !== "static" || /flex|grid/.test(parent ? parent.display : "");
    if (stacked && style.zIndex !== "auto" && style.zIndex !== "") {
      for (let box = live.parentElement; box && !this.#zOrdered.has(box); box = box.parentElement)
        this.#zOrdered.add(box);
    }
    const fixed = style.position === "fixed";
    if (fixed || style.position === "absolute") {
      const container = fixed ? this.#fixedContainer : this.#absoluteContainer;
      this.#positioned.set(live, { copy, fixed, container });
      if (fixed) {
        for (let box = live.parentElement; box && box !== container; box = box.parentElement)
          this.#holdingFixed.add(box);
      }
    }
    return copy;
  }

  #copyFormState(element: Element, copy: Element): void {
    const { HTMLInputElement, HTMLTextAreaElement, HTMLOptionElement, HTMLSelectElement } =
      this.#window;
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox" || element.type === "radio") {
        copy.toggleAttribute("checked", element.checked);
      } else if (element.type !== "file") {
        const value = this.#shownValue(element);
        copy.setAttribute("value", value);
        // Only text inputs have a selection, and scroll their text.
        if (element.selectionStart !== null) this.#copyTextScroll(element, copy, value);
      }
    } else if (element instanceof HTMLTextAreaElement) {
      const value = this.#shownValue(element);
      copy.textContent = value;
      this.#copyTextScroll(element, copy, value);
    } else if (element instanceof HTMLOptionElement) {
      copy.toggleAttribute("selected", element.selected);
    } else if (element instanceof HTMLSelectElement && copy instanceof HTMLElement) {
      // A <select> sizes itself to its options (and a list box to its
      // scrollbar, which the copy hides): Firefox draws the copy narrower than
      // the page's, moving what follows it. Keep the page's size: its layout
      // size, before transforms (which the copy applies again).
      const { offsetWidth, offsetHeight } = element;
      if (offsetWidth > 0 && offsetHeight > 0) {
        copy.style.setProperty("box-sizing", "border-box", "important");
        copy.style.setProperty("width", `${offsetWidth}px`, "important");
        copy.style.setProperty("height", `${offsetHeight}px`, "important");
      }
    }
  }

  /**
   * A text field's own scroll is not drawn either. Leave out the text scrolled
   * past and move the rest into place with the padding (measured, see
   * scrolledText). A line only partly scrolled past is left out whole.
   */
  #copyTextScroll(
    field: HTMLInputElement | HTMLTextAreaElement,
    copy: Element,
    value: string,
  ): void {
    const scrolled = scrolledText(field);
    if (!scrolled || !(copy instanceof HTMLElement)) return;
    const isInput = field.tagName === "INPUT";
    const rest = value.slice(scrolled.index);
    if (isInput) copy.setAttribute("value", rest);
    else copy.textContent = rest;
    const side = isInput ? "padding-left" : "padding-top";
    const padding = parseFloat(this.#window.getComputedStyle(field).getPropertyValue(side)) || 0;
    copy.style.setProperty(side, `${padding + scrolled.offset}px`, "important");
  }

  /** A field's value, or what it shows while text is composed in it. */
  #shownValue(field: HTMLInputElement | HTMLTextAreaElement): string {
    const composition = this.#options.composition;
    return composition?.field === field ? composition.value : field.value;
  }

  #copyImage(element: Element, copy: Element, style: CSSStyleDeclaration): void {
    const { HTMLImageElement, HTMLPictureElement, HTMLSourceElement } = this.#window;
    // The frame cannot load the candidates: a <picture> would pick a <source>
    // over the image's data URL. One without srcset is passed over.
    if (element instanceof HTMLSourceElement || element instanceof HTMLImageElement) {
      copy.removeAttribute("srcset");
      copy.removeAttribute("sizes");
    }
    if (!(element instanceof HTMLImageElement)) return;
    copy.removeAttribute("loading");
    const picked =
      element.hasAttribute("srcset") || element.parentElement instanceof HTMLPictureElement;
    // The candidate the browser picked. A lazy image below the host's viewport
    // may never pick one (the frame is in view, but not on screen): src stands
    // in, unless the page has no box for it (nothing to show it in, not worth a fetch).
    const standIn = picked && !element.currentSrc;
    const empty = standIn && (style.width === "0px" || style.height === "0px");
    const source = empty ? "" : element.currentSrc || element.src;
    const dataUrl = source ? this.#options.inlineImage(source) : null;
    if (dataUrl) copy.setAttribute("src", dataUrl);
    else copy.removeAttribute("src");
    // A candidate's size is its pixels over its density (2x, or its width over
    // sizes): as a plain src, it would be drawn at its pixels. Keep the size it is laid out at.
    if (picked && copy instanceof HTMLElement) {
      for (const property of ["width", "height"]) {
        const value = style.getPropertyValue(property);
        if (value.endsWith("px")) copy.style.setProperty(property, value, "important");
      }
      // The fallback stands in for a candidate of another shape, maybe (a
      // <source media> for narrow screens): fit it in the box, not stretched.
      if (standIn && style.objectFit === "fill")
        copy.style.setProperty("object-fit", "contain", "important");
    }
  }

  #copyCanvas(canvas: HTMLCanvasElement): Node | null {
    const image = this.#imageOf(canvas);
    try {
      image.setAttribute("src", canvas.toDataURL());
    } catch {
      // A canvas tainted by cross-origin content cannot be read.
    }
    return image;
  }

  /** An image in place of a canvas or a video: its attributes (but `skipped`), at its size. */
  #imageOf(element: Element, skipped?: ReadonlySet<string>): HTMLElement {
    const image = this.#inert.createElement("img");
    for (const attribute of Array.from(element.attributes)) {
      if (!skipped?.has(attribute.name)) image.setAttribute(attribute.name, attribute.value);
    }
    const { width, height } = element.getBoundingClientRect();
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    return image;
  }

  #composedSpan(text: string): Element {
    const span = this.#inert.createElement("span");
    span.setAttribute("style", "text-decoration: underline");
    span.textContent = text;
    return span;
  }

  /** A text node with the composed text in it, in place of what the composition replaces. */
  #composedText(text: Text, composition: NonNullable<SnapshotOptions["inlineComposition"]>): Node {
    const fragment = this.#inert.createDocumentFragment();
    fragment.append(
      text.data.slice(0, composition.offset),
      this.#composedSpan(composition.text),
      text.data.slice(composition.endOffset),
    );
    return fragment;
  }

  /** A video, as an image of the frame it shows (its poster before it plays). */
  #copyVideo(video: HTMLVideoElement): Node {
    const showsPoster = video.poster !== "" && video.paused && video.currentTime === 0;
    const poster = video.poster ? this.#options.inlineImage(video.poster) : null;
    const source = showsPoster
      ? (poster ?? this.#videoFrame(video))
      : (this.#videoFrame(video) ?? poster);
    const image = this.#imageOf(video, VIDEO_ATTRIBUTES);
    if (source) image.setAttribute("src", source);
    const computed = this.#window.getComputedStyle(video);
    image.style.setProperty("box-sizing", "border-box");
    // A video letterboxes its frame by default; an image would stretch it.
    image.style.setProperty("object-fit", computed.objectFit);
    image.style.setProperty("object-position", computed.objectPosition);
    return image;
  }

  /** The frame a video shows now, as a data URL; null before it has one, or if it cannot be read (cross-origin). */
  /**
   * The frame a video shows now, as a data URL; null before it has one, or if
   * it cannot be read (cross-origin). Encoding a frame takes milliseconds, so a
   * frame that has not changed (a paused video, at the same time and size, of
   * the same source) is not encoded again.
   */
  #videoFrame(video: HTMLVideoElement): string | null {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
    const { width } = video.getBoundingClientRect();
    const scale = Math.min(1, (VIDEO_SCALE * Math.max(1, width)) / video.videoWidth);
    const frameWidth = Math.max(1, Math.round(video.videoWidth * scale));
    const frameHeight = Math.max(1, Math.round(video.videoHeight * scale));
    const key = `${video.currentTime} ${video.videoWidth}x${video.videoHeight} ${frameWidth}x${frameHeight}`;
    // Another clip or stream at the same time and size (a page swapping src or srcObject) is another frame.
    const source = video.srcObject ?? video.currentSrc;
    const cached = videoFrames.get(video);
    if (cached?.key === key && cached.source === source) return cached.url;
    const url = encodeFrame(this.#document, video, frameWidth, frameHeight);
    videoFrames.set(video, { key, source, url });
    return url;
  }

  #copyAnimatedValues(element: Element, copy: Element): void {
    const values = this.#animated.get(element);
    if (!values?.size || !isStyled(copy)) return;
    const computed = this.#window.getComputedStyle(element);
    for (const [property, value] of values) {
      const baked = value ?? computed.getPropertyValue(property);
      if (baked) copy.style.setProperty(property, baked, "important");
    }
  }

  #copyScroll(element: Element, copy: Element): void {
    // The document's own scroll is applied to <body>; <html> must not move.
    if (element === this.#document.documentElement) return;
    const viewport = this.#document.scrollingElement;
    if (element === this.#document.body && viewport) {
      const { scrollLeft, scrollTop } = viewport;
      if ((scrollLeft !== 0 || scrollTop !== 0) && isStyled(copy))
        this.#moveScrolled(element, copy, scrollLeft, scrollTop, null);
      // In quirks mode, <body> scrolls the viewport; otherwise it may scroll itself too.
      if (element === viewport) return;
    }
    const { scrollLeft, scrollTop } = element;
    if (scrollLeft === 0 && scrollTop === 0) return;
    if (element instanceof this.#window.HTMLSelectElement) {
      this.#copyListBoxScroll(element, copy);
      return;
    }
    // foreignObject renders every scroll container at its origin. Move the
    // content instead: by its flow where it can be (see shiftFlow), otherwise
    // each child. Bare text directly inside a scroll container then does not
    // move (a known limitation).
    const flow = this.#shiftFlow(element, scrollLeft, scrollTop);
    if (!flow) this.#moveGeneratedApart(element, scrollLeft, scrollTop);
    for (const child of Array.from(copy.children)) {
      if (isStyled(child)) {
        const live = this.#liveOf.get(child) ?? null;
        this.#moveScrolled(live, child, scrollLeft, scrollTop, element, flow);
      }
    }
  }

  /**
   * Moves the content of a scroll container (a block, flex or grid one) up and
   * left by the scroll with margins, which move it as scrolling does: its flow
   * up and left, the boxes in it not positioned (or translated). So they paint
   * in the same order, the absolute elements in them keep their containing
   * blocks (and are not clipped by the container when theirs is outside it),
   * and the sticky ones are where the page has them.
   *
   * In a block container, the first box's top margin moves everything after it
   * (as it collapses with those of the first boxes in it, all are counted), and
   * each box's side margins move it sideways, its width kept by the other one.
   * A flex or grid item is moved by its own margins, each side's opposite one
   * keeping its margin box. False, with nothing done, where the content cannot
   * be moved this way: text or inline boxes in a block container (line boxes),
   * floats, `display: contents`, margins that collapse in ways not worked out
   * (through an empty box, or past clearance).
   */
  #shiftFlow(container: Element, x: number, y: number): boolean {
    const style = this.#styles.get(container);
    if (!style || this.#options.inlineComposition?.node === container) return false;
    const items = /^(inline-)?(flex|grid)$/.test(style.display);
    if (!items) {
      if (!BLOCK_CONTAINER.test(style.display)) return false;
      // Columns would share the content out again; in vertical writing, the
      // flow goes sideways (and margins are physical).
      if ((style.columnCount || "auto") !== "auto" || (style.columnWidth || "auto") !== "auto")
        return false;
      if ((style.writingMode || "horizontal-tb") !== "horizontal-tb") return false;
    }
    const boxes = this.#inFlowChildren(container, items);
    if (!boxes) return false;
    // Generated content is a box of the flow too: moved with a rule of its own.
    // (In a block container, ::after comes after the boxes, and moves with them.)
    const before = this.#generatedBox(container, "::before", items);
    const after = items ? this.#generatedBox(container, "::after", items) : null;
    if (before === false || after === false) return false;
    const rules: string[] = [];
    for (const [pseudo, generated] of [
      ["::before", before],
      ["::after", after],
    ] as const) {
      if (!generated) continue;
      const declarations = this.#moveGenerated(
        container,
        generated,
        items,
        x,
        y,
        pseudo === "::before",
      );
      if (declarations === null) return false;
      if (declarations) rules.push(`${pseudo}{${declarations}}`);
    }
    const margins: [HTMLElement | SVGElement, string, string][] = [];
    const moved = (box: HTMLElement | SVGElement, side: string, by: number) =>
      margins.push([
        box,
        side,
        plus(baseValue(box, this.#styles.get(this.#liveOf.get(box)!)!, side), by),
      ]);
    const copies = boxes
      .map((box) => this.#copies.get(box))
      .filter((copy) => copy && isStyled(copy));
    for (const copy of copies as (HTMLElement | SVGElement)[]) {
      if (y !== 0 && items) {
        moved(copy, "margin-top", -y);
        moved(copy, "margin-bottom", y);
      }
      if (x !== 0) {
        moved(copy, "margin-left", -x);
        moved(copy, "margin-right", x);
      }
    }
    // The first box moves the flow: a generated one (moved by its rule) or the first child.
    if (
      y !== 0 &&
      !items &&
      boxes[0] &&
      !(before && before.position !== "absolute" && before.position !== "fixed")
    ) {
      const top = this.#marginToMoveFlow(boxes[0], y);
      const copy = this.#copies.get(boxes[0]);
      if (top === null) return false;
      if (copy && isStyled(copy)) margins.push([copy, "margin-top", `${top}px`]);
    }
    for (const [copy, side, value] of margins) copy.style.setProperty(side, value, "important");
    this.#addGeneratedRules(container, rules);
    return true;
  }

  /** Adds rules (`::before{…}`) for a container's generated boxes, marking its copy for them. */
  #addGeneratedRules(container: Element, rules: string[]): void {
    const copy = this.#copies.get(container);
    if (rules.length === 0 || !copy) return;
    const id = String(this.generatedRules.length);
    copy.setAttribute(SCROLLED_ATTRIBUTE, id);
    for (const rule of rules) this.generatedRules.push(`[${SCROLLED_ATTRIBUTE}="${id}"]${rule}`);
  }

  /**
   * Moves a container's ::before and ::after where its children are moved one
   * by one (its flow is not moved): as moveScrolled moves a child of the same
   * position (see scrollMoves), with a rule.
   */
  #moveGeneratedApart(container: Element, x: number, y: number): void {
    const containerStyle = this.#styles.get(container);
    if (!containerStyle) return;
    const rules: string[] = [];
    for (const pseudo of ["::before", "::after"] as const) {
      const style = this.#window.getComputedStyle(container, pseudo);
      if (!isGenerated(style)) continue;
      const position = style.position;
      const moves = scrollMoves(position, (property) => style.getPropertyValue(property), x, y, {
        parentDisplay: containerStyle.display,
        scrolls:
          position === "fixed" ? containsFixed(containerStyle) : containsAbsolute(containerStyle),
        byMargin: true,
        lift: style.zIndex === "auto",
      });
      const declarations = moves.map(([property, moved]) => `${property}:${moved} !important`);
      if (declarations.length > 0) rules.push(`${pseudo}{${declarations.join(";")}}`);
    }
    this.#addGeneratedRules(container, rules);
  }

  /**
   * The boxes of a container's flow (its in-flow element children), or null
   * if anything else is in it that its flow would not move as it moves them.
   *
   * `first`: only the first box of a block's flow, if it is a block (its top
   * margin can collapse with the block's); null if lines come first. Floats
   * do not separate them, as absolute and fixed elements do not.
   */
  #inFlowChildren(container: Element, items: boolean, first = false): Element[] | null {
    const boxes: Element[] = [];
    for (const node of Array.from(container.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (/\S/.test((node as Text).data)) return null;
        continue;
      }
      const style = node.nodeType === Node.ELEMENT_NODE && this.#styles.get(node as Element);
      if (!style || style.display === "none") continue;
      if (style.position === "absolute" || style.position === "fixed") continue;
      if ((style.cssFloat || "none") !== "none") {
        if (first) continue;
        return null;
      }
      if (style.display === "contents" || (!items && !BLOCK_LEVEL.test(style.display))) return null;
      boxes.push(node as Element);
      if (first) break;
    }
    return boxes;
  }

  /**
   * The first box of a block's flow, if it is a block (its top margin can
   * collapse with the block's); null if lines come first.
   */
  #firstBlock(container: Element): Element | null {
    return this.#inFlowChildren(container, false, true)?.[0] ?? null;
  }

  /** A length of a box (a margin, a padding) in px, as the copy has it (an animation's, baked) or the page. */
  #pxOf(box: Element, property: string): number {
    const style = this.#styles.get(box)!;
    const copy = this.#copies.get(box);
    const value = copy && isStyled(copy) ? baseValue(copy, style, property) : "";
    return value.endsWith("px")
      ? parseFloat(value)
      : parseFloat(style.getPropertyValue(property)) || 0;
  }

  /**
   * The top margin for a block container's first box that moves its flow up
   * by `y`: its margin collapses with those of the first boxes in it (when
   * nothing separates them), and the margin they make together must be `y`
   * less. Null where it cannot be worked out.
   */
  #marginToMoveFlow(first: Element, y: number): number | null {
    const margins: number[] = [];
    for (let box: Element | null = first; box;) {
      const style: CSSStyleDeclaration = this.#styles.get(box)!;
      // An empty box: margins collapse through it, with those after it.
      if ((box as HTMLElement).offsetHeight === 0) return null;
      // Clearance separates a box's margin from those before it.
      if (box !== first && (style.clear || "none") !== "none") return null;
      margins.push(this.#pxOf(box, "margin-top"));
      // Not a new formatting context, and nothing between it and its first box.
      const through: boolean =
        /^(block|list-item)$/.test(style.display) &&
        /^(visible|clip)$/.test(style.overflowY) &&
        /^(visible|clip)$/.test(style.overflowX) &&
        !containsFixed(style) &&
        (style.writingMode || "horizontal-tb") === "horizontal-tb" &&
        (style.columnCount || "auto") === "auto" &&
        (style.columnWidth || "auto") === "auto" &&
        /^(normal)?$/.test(style.alignContent ?? "") &&
        (parseFloat(style.borderTopWidth) || 0) === 0 &&
        (parseFloat(style.paddingTop) || 0) === 0;
      if (!through) break;
      // Its own ::before comes first: a block one's margin is the last that
      // collapses (its boxes are its text); lines stop it.
      const before = this.#window.getComputedStyle(box, "::before");
      if (
        isGenerated(before) &&
        !/^(absolute|fixed)$/.test(before.position) &&
        (before.cssFloat || "none") === "none"
      ) {
        if (!BLOCK_LEVEL.test(before.display)) break;
        if (isEmptyBox(before)) return null;
        margins.push(parseFloat(before.getPropertyValue("margin-top")) || 0);
        break;
      }
      box = this.#firstBlock(box);
    }
    return marginMovingFlow(margins, y);
  }

  /**
   * A container's ::before or ::after box: its computed style if it is one
   * that its flow (or the container, for an absolute one) moves; null if it
   * has none, or one that does not move (fixed); false if it is one that
   * margins cannot move (in a line, floating).
   */
  #generatedBox(
    container: Element,
    pseudo: "::before" | "::after",
    items: boolean,
  ): CSSStyleDeclaration | null | false {
    const style = this.#window.getComputedStyle(container, pseudo);
    if (!isGenerated(style)) return null;
    if (style.position === "absolute" || style.position === "fixed") return style;
    if ((style.cssFloat || "none") !== "none") return false;
    return items || BLOCK_LEVEL.test(style.display) ? style : false;
  }

  /**
   * The declarations that move a container's generated box with its content,
   * as shiftFlow moves its children; null where that cannot be worked out.
   */
  #moveGenerated(
    container: Element,
    style: CSSStyleDeclaration,
    items: boolean,
    x: number,
    y: number,
    first: boolean,
  ): string | null {
    const declarations: string[] = [];
    const set = (property: string, value: string) =>
      declarations.push(`${property}:${value} !important`);
    const value = (property: string) => style.getPropertyValue(property);
    if (style.position === "absolute" || style.position === "fixed") {
      // From the container (its containing block) it scrolls with it; else it stays.
      const containerStyle = this.#styles.get(container)!;
      const scrolls =
        style.position === "fixed"
          ? containsFixed(containerStyle)
          : containsAbsolute(containerStyle);
      if (!scrolls) return "";
      for (const [property, moved] of insetMoves(value, style.position, -x, -y, true))
        set(property, moved);
      return declarations.join(";");
    }
    if (y !== 0 && items) {
      set("margin-top", plus(value("margin-top"), -y));
      set("margin-bottom", plus(value("margin-bottom"), y));
    }
    if (y !== 0 && !items && first) {
      // The first box of the flow: its margin collapses with no other (its own
      // boxes are its text), unless it is empty.
      if (isEmptyBox(style)) return null;
      const top = marginMovingFlow([parseFloat(value("margin-top")) || 0], y);
      if (top === null) return null;
      set("margin-top", `${top}px`);
    }
    if (x !== 0) {
      set("margin-left", plus(value("margin-left"), -x));
      set("margin-right", plus(value("margin-right"), x));
    }
    return declarations.join(";");
  }

  /**
   * Moves the copy of something scrolled up and left by the scroll, by how it
   * is positioned on the page. `container` is what scrolls (null for the
   * document); `live` is null for what the agent added (composed text); `flow`
   * says the container's flow was moved already (shiftFlow), and what is in
   * it with it.
   *
   * In the flow (or relatively positioned), it is positioned relatively, not
   * translated: a transform would make it the containing block of the fixed
   * elements in it, which would then scroll away with it. And browsers place
   * sticky elements from where the boxes are laid out, which takes relative
   * offsets into account but not transforms: moved this way, the copy's sticky
   * elements stick where the page's do, as if it were scrolled. The page's
   * z-index on a static box is ignored, and stays so. The absolute elements in
   * it whose containing block is outside it are placed by pinPositioned().
   *
   * An absolute or fixed one is moved by its insets, if it scrolls with the
   * content: if what scrolls is its containing block. Otherwise it stays.
   *
   * A sticky one cannot be moved by an offset, which its insets are for: it
   * is translated, and its insets moved by the scroll the other way, so that
   * it sticks (to its unscrolled container) where it would scrolled; or, with
   * fixed elements in it, held where it is by its insets (see holdSticky).
   */
  #moveScrolled(
    live: Element | null,
    copy: HTMLElement | SVGElement,
    x: number,
    y: number,
    container: Element | null,
    flow = false,
  ): void {
    const style = live ? this.#styles.get(live) : undefined;
    const position = style?.position ?? "static";
    // Moved with the flow (sticky ones too, sticking as on the page).
    if (flow && position !== "absolute" && position !== "fixed") return;
    const positioned = live && this.#positioned.get(live);
    const parent = live?.parentElement && this.#styles.get(live.parentElement);
    const sticky = position === "sticky";
    const options: ScrollMoveOptions = {
      parentDisplay: parent ? parent.display : "",
      scrolls: container
        ? positioned?.container === container
        : position === "absolute" || positioned?.container != null,
      // Its place in the flow moves with the flow, if moved.
      byMargin: !flow,
      // Its static siblings, positioned now, would paint over it in their order,
      // as the page does not. Not with a z-index in it, which would then only
      // count inside it.
      lift: sticky && !!container && style?.zIndex === "auto" && !this.#zOrdered.has(live!),
    };
    if (sticky && container && this.#holdingFixed.has(live!)) {
      if (options.lift) copy.style.setProperty("z-index", "1", "important");
      if (this.#holdSticky(live!, copy, container, x, y)) return;
    }
    const value = (property: string) => (style ? baseValue(copy, style, property) : "");
    for (const [property, moved] of scrollMoves(position, value, x, y, options))
      copy.style.setProperty(property, moved, "important");
    if (position === "static" || position === "relative") this.#moved.set(copy, "relative");
    else if (sticky) this.#moved.set(copy, "translated");
  }

  /**
   * Holds a sticky element where the page shows it, by insets that make that
   * box its sticky view rectangle (in the scroll container, unscrolled), so
   * that it is not translated: the fixed elements in it would be clipped to
   * the container with it. False (nothing done) where an inset cannot place it:
   * its margin box above the container's content (sticking in its padding or
   * margin, or scrolled past),
   * or with a transform of its own (then it is their containing block anyway).
   */
  #holdSticky(
    live: Element,
    copy: HTMLElement | SVGElement,
    container: Element,
    x: number,
    y: number,
  ): boolean {
    const style = this.#styles.get(live)!;
    const containerStyle = this.#styles.get(container);
    if (containsFixed(style) || !containerStyle) return false;
    const rect = live.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    const port = {
      top: box.top + container.clientTop,
      left: box.left + container.clientLeft,
      bottom: box.top + container.clientTop + container.clientHeight,
      right: box.left + container.clientLeft + container.clientWidth,
    };
    // Its margin box stays in the container's content (its containing block).
    const paddingTop = this.#pxOf(container, "padding-top");
    const paddingLeft = this.#pxOf(container, "padding-left");
    const marginTop = this.#pxOf(live, "margin-top");
    const marginLeft = this.#pxOf(live, "margin-left");
    if (y !== 0 && rect.top - marginTop < port.top + paddingTop - 0.5) return false;
    if (x !== 0 && rect.left - marginLeft < port.left + paddingLeft - 0.5) return false;
    const set = (property: string, value: number) =>
      copy.style.setProperty(property, `${value}px`, "important");
    if (y !== 0) {
      set("top", rect.top - port.top);
      set("bottom", port.bottom - rect.bottom);
    }
    if (x !== 0) {
      set("left", rect.left - port.left);
      set("right", port.right - rect.right);
    }
    return true;
  }

  /**
   * Places absolute and fixed elements whose containing block in the copy is
   * one moved for a scroll (a static box positioned relatively, a sticky one
   * translated), and not the page's: where they are on the page, from that box.
   */
  pinPositioned(): void {
    for (const [live, { copy, fixed, container }] of this.#positioned) {
      let trap: Element | null = null;
      for (let ancestor = copy.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (container && this.#liveOf.get(ancestor) === container) break;
        const moved = this.#moved.get(ancestor);
        if (moved === "translated" || (moved === "relative" && !fixed)) {
          trap = ancestor;
          break;
        }
      }
      const trapLive = trap && this.#liveOf.get(trap);
      if (trapLive && isStyled(copy)) this.#pin(live, copy, fixed, container, trapLive);
    }
  }

  /** Positions an absolute or fixed element's copy from `trap` (its containing block in the copy), as the page has it from `container`. */
  #pin(
    live: Element,
    copy: HTMLElement | SVGElement,
    fixed: boolean,
    container: Element | null,
    trap: Element,
  ): void {
    const style = this.#styles.get(live)!;
    const viewport = this.#document.scrollingElement;
    const origin = (element: Element | null) => {
      if (element) {
        const rect = element.getBoundingClientRect();
        return { x: rect.left + element.clientLeft, y: rect.top + element.clientTop };
      }
      // The viewport, or the initial containing block: the document's start.
      return fixed
        ? { x: 0, y: 0 }
        : { x: -(viewport?.scrollLeft ?? 0), y: -(viewport?.scrollTop ?? 0) };
    };
    const from = origin(container);
    const to = origin(trap);
    // Used values (in px) for a positioned element (or as an animation ends),
    // but for insets that are over-constrained (both, and the size): those are
    // as specified, maybe in percent. Then from where it is (its border box,
    // less its margin).
    const inset = (side: "top" | "left", from: number) => {
      const value = baseValue(copy, style, side);
      if (/^-?[\d.]+px$/.test(value)) return parseFloat(value);
      const rect = live.getBoundingClientRect();
      const margin = parseFloat(style.getPropertyValue(`margin-${side}`)) || 0;
      return (side === "top" ? rect.top : rect.left) - margin - from;
    };
    const top = inset("top", from.y);
    const left = inset("left", from.x);
    if (!Number.isFinite(top) || !Number.isFinite(left)) return;
    const set = (property: string, value: string) =>
      copy.style.setProperty(property, value, "important");
    set("top", `${top - (to.y - from.y)}px`);
    set("left", `${left - (to.x - from.x)}px`);
    set("bottom", "auto");
    set("right", "auto");
    // Sizes and margins in percent, or auto, are from the containing block: as on the page.
    for (const property of PINNED_SIZES) {
      const value = baseValue(copy, style, property);
      if (value) set(property, value);
    }
  }

  /**
   * A scrolled list box: the options scrolled out of view above are left out of
   * the copy (removed: WebKit draws a list box's options whatever their display
   * or hidden), and the rest moved up by what remains of the scroll (less than
   * a row). WebKit does not move options either, so there a row may show up to
   * that much lower than it is; the rows left out are right in every browser.
   * (An <optgroup>'s label stays, even scrolled out with its first options.)
   */
  #copyListBoxScroll(select: HTMLSelectElement, copy: Element): void {
    const style = this.#window.getComputedStyle(select);
    const top =
      select.getBoundingClientRect().top + select.clientTop + (parseFloat(style.paddingTop) || 0);
    const copies = Array.from(copy.querySelectorAll("option"));
    let hidden = 0;
    let removed = 0;
    for (const [index, option] of Array.from(select.options).entries()) {
      const rect = option.getBoundingClientRect();
      const optionCopy = copies[index];
      if (rect.bottom > top + 0.5 || !optionCopy) break;
      optionCopy.remove();
      hidden += rect.height;
      removed++;
    }
    const rest = select.scrollTop - hidden;
    if (rest <= 0) return;
    for (const option of copies.slice(removed)) {
      if (option instanceof HTMLElement) option.style.setProperty("translate", `0 ${-rest}px`);
    }
  }

  /**
   * The copy is not scrolled, so its real scrollbars would show the wrong
   * position: hide them, keeping the room a classic scrollbar takes, and
   * remember them to be drawn by drawScrollbars().
   */
  #hideScrollbars(element: Element, copy: Element, style: CSSStyleDeclaration): void {
    const bars = scrollbarsOf(element, style);
    if (bars.length === 0) return;
    this.scrollbars.push(...bars);
    // The document's scrollbars are the viewport's; the root copy never shows any.
    if (element === this.#document.scrollingElement || !(copy instanceof HTMLElement)) return;
    copy.style.setProperty("overflow", "hidden", "important");
    if (bars.some((bar) => bar.gutter))
      copy.style.setProperty("scrollbar-gutter", "stable", "important");
  }
}

// The image cannot show a text field's selection, so it is drawn over the field.
const SELECTION_COLOR = "rgb(51 144 255 / 35%)";
const INACTIVE_SELECTION_COLOR = "rgb(200 200 200)";
const SCROLLBAR_TRACK_COLOR = "rgb(0 0 0 / 5%)";
const SCROLLBAR_THUMB_COLOR = "rgb(0 0 0 / 38%)";
const SCROLLBAR_THUMB_HOVER_COLOR = "rgb(0 0 0 / 52%)";
const SCROLLBAR_THUMB_ACTIVE_COLOR = "rgb(0 0 0 / 64%)";
const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;
const SCROLLBAR_INSET = 2;

/** The top layer's z-index, and the agent's own boxes': drawn in order, a later one over an earlier one. */
const TOP_Z_INDEX = 2147483647;

/** Adds a fixed box on top of everything to the root copy (`css` may override its own). */
function drawBox(
  root: HTMLElement,
  { left, top, width, height }: Box,
  css: string,
  zIndex = TOP_Z_INDEX,
): HTMLElement {
  const element = root.ownerDocument.createElement("div");
  element.setAttribute(
    "style",
    `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;` +
      `margin:0;padding:0;border:0;pointer-events:none;z-index:${zIndex};${css}`,
  );
  return root.appendChild(element);
}

/** Adds the scrollbars on top of everything, as fixed boxes in the root copy. */
function drawScrollbars(
  root: HTMLElement,
  bars: readonly Scrollbar[],
  state: SnapshotOptions["scrollbar"],
): void {
  for (const { element, axis, track, thumb, gutter } of bars) {
    if (gutter) drawBox(root, track, `background:${SCROLLBAR_TRACK_COLOR}`);
    const width = Math.max(0, thumb.width - 2 * SCROLLBAR_INSET);
    const height = Math.max(0, thumb.height - 2 * SCROLLBAR_INSET);
    const current = state?.element === element && state.axis === axis ? state.state : null;
    const color =
      current === "active"
        ? SCROLLBAR_THUMB_ACTIVE_COLOR
        : current === "hover"
          ? SCROLLBAR_THUMB_HOVER_COLOR
          : SCROLLBAR_THUMB_COLOR;
    const style = `background:${color};border-radius:${Math.min(width, height) / 2}px`;
    const left = thumb.left + SCROLLBAR_INSET;
    drawBox(root, { left, top: thumb.top + SCROLLBAR_INSET, width, height }, style);
  }
}

const POPUP_HIGHLIGHT = "rgb(30 110 220)";

/** Draws a selected option of a focused list box over its copy: white on the selection's blue, cut to the box. */
function drawListBoxRow(root: HTMLElement, row: ListBoxRow): void {
  const { shown, box } = row;
  const clip = drawBox(root, shown, "overflow:hidden");
  const option = root.ownerDocument.createElement("div");
  option.setAttribute(
    "style",
    `position:absolute;left:${box.left - shown.left}px;top:${box.top - shown.top}px;width:${box.width}px;height:${box.height}px;` +
      `box-sizing:border-box;margin:0;border:0;padding:0 0 0 ${row.paddingLeft}px;background:${LIST_BOX_SELECTED};color:#fff;` +
      `font:${row.font};line-height:${box.height}px;white-space:pre;overflow:hidden;text-align:left;letter-spacing:normal`,
  );
  option.textContent = row.label;
  clip.appendChild(option);
}

/** Draws the open list of a <select>, as a fixed box over everything. */
function drawSelectPopup(root: HTMLElement, view: PopupView): void {
  const list = drawBox(
    root,
    view.box,
    "box-sizing:border-box;border:1px solid rgb(118 118 118);background:#fff;color:#000;overflow:hidden;" +
      "box-shadow:0 2px 8px rgb(0 0 0 / 25%);text-align:left;" +
      `font:${view.font};line-height:${view.itemHeight}px;letter-spacing:normal;text-transform:none`,
  );
  for (const item of view.items) {
    const row = root.ownerDocument.createElement("div");
    const indent = item.grouped ? 20 : 8;
    const color = item.highlighted
      ? "#fff"
      : item.disabled && item.index >= 0
        ? "rgb(128 128 128)"
        : "#000";
    const background = item.highlighted
      ? POPUP_HIGHLIGHT
      : item.selected
        ? "rgb(0 0 0 / 8%)"
        : "transparent";
    row.setAttribute(
      "style",
      `height:${view.itemHeight}px;padding:0 8px 0 ${indent}px;margin:0;white-space:pre;overflow:hidden;` +
        `text-overflow:ellipsis;color:${color};background:${background};font-weight:${item.index < 0 ? "bold" : "normal"}`,
    );
    row.textContent = item.label;
    list.appendChild(row);
  }
}

const BACKGROUND_PROPERTIES = [
  "background-color",
  "background-image",
  "background-repeat",
  "background-position",
  "background-size",
  "background-origin",
  "background-clip",
  "background-attachment",
];

/**
 * Browsers paint the root's background over the whole page, and the body's
 * there instead when the root has none, not painting it on the body then (CSS
 * Backgrounds 3, "The Canvas Background"). The copy is not a document's root
 * inside the foreignObject, so a body's background would only cover the body:
 * it is moved to the copy of the root, which fills the page, as browsers do.
 */
function propagateBodyBackground(
  document: Document,
  root: HTMLElement,
  inlineImage: (url: string) => string | null,
): void {
  const view = document.defaultView;
  const body = document.body;
  if (!view || body?.tagName !== "BODY") return;
  const rootStyle = view.getComputedStyle(document.documentElement);
  if (!TRANSPARENT.test(rootStyle.backgroundColor) || rootStyle.backgroundImage !== "none") return;
  const bodyStyle = view.getComputedStyle(body);
  if (TRANSPARENT.test(bodyStyle.backgroundColor) && bodyStyle.backgroundImage === "none") return;
  const bodyCopy = root.querySelector<HTMLElement>(":scope > body");
  if (!bodyCopy) return;
  for (const property of BACKGROUND_PROPERTIES) {
    let value = bodyStyle.getPropertyValue(property);
    // Images the copy can show: data URLs (one not loaded yet comes with a later frame).
    if (property === "background-image") value = inlineBackgroundImages(value, inlineImage);
    if (value) root.style.setProperty(property, value);
  }
  bodyCopy.style.setProperty("background", "none", "important");
}

/**
 * Browsers apply the body's overflow to the viewport, not to the body, when
 * the root leaves its own visible. The copy of the body would clip what it has
 * to its box, and be the box its sticky elements stick in (not the viewport,
 * the copy of the root): it is left visible, the copy of the root clipping.
 */
function propagateBodyOverflow(document: Document, root: HTMLElement): void {
  const view = document.defaultView;
  const body = document.body;
  if (!view || body?.tagName !== "BODY") return;
  const rootStyle = view.getComputedStyle(document.documentElement);
  if (rootStyle.overflowX !== "visible" || rootStyle.overflowY !== "visible") return;
  const bodyStyle = view.getComputedStyle(body);
  if (bodyStyle.overflowX === "visible" && bodyStyle.overflowY === "visible") return;
  root
    .querySelector<HTMLElement>(":scope > body")
    ?.style.setProperty("overflow", "visible", "important");
}

/** A computed background-image with its URLs as data URLs; none while one is not loaded. */
function inlineBackgroundImages(
  value: string,
  inlineImage: (url: string) => string | null,
): string {
  let missing = false;
  const inlined = value.replace(/url\((["']?)(.*?)\1\)/g, (_match, _quote, url: string) => {
    const dataUrl = inlineImage(url);
    if (!dataUrl) missing = true;
    return `url("${dataUrl ?? ""}")`;
  });
  return missing ? "none" : inlined;
}

/**
 * Whether the browser draws an element: none in a `display: none` box, nor
 * in one whose content is hidden (an element of its own `display: contents`
 * is drawn, its children are).
 */
function isRendered(element: Element): boolean {
  const view = element.ownerDocument.defaultView!;
  if (view.getComputedStyle(element).display === "none") return false;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent);
    if (style.display === "none" || style.contentVisibility === "hidden") return false;
  }
  return true;
}

/** Marks the stand-ins liftToTopLayer moves a top layer element with, and the element. */
const STAND_IN_ATTRIBUTE = "data-thp-stand-in";
const LIFTED_ATTRIBUTE = "data-thp-lifted";
/**
 * A parent's stand-in makes no box (`display: contents`, in its style), nor
 * its ::before and ::after, which `display: contents` keeps; its other
 * children's stand-ins make none either.
 */
const STAND_IN_RULES = [
  `[${STAND_IN_ATTRIBUTE}]::before,[${STAND_IN_ATTRIBUTE}]::after{display:none!important}`,
  `[${STAND_IN_ATTRIBUTE}]>:not([${STAND_IN_ATTRIBUTE}],[${LIFTED_ATTRIBUTE}]){display:none!important}`,
];
/**
 * Children after the lifted one (or its parent's stand-in) are copied only
 * this far: rules look back at earlier siblings (`+`, `~`, :nth-child), and
 * forward only with :nth-last-child, :last-child, :only-child and :has(),
 * which a few later ones keep right for all but long lists.
 */
const LATER_SIBLINGS = 16;

/**
 * A stand-in for another child of a parent: its attributes, so that rules
 * match as they did, without its style (which could show it: an inline
 * `display: … !important` beats STAND_IN_RULES).
 */
function siblingStandIn(sibling: Element): Element {
  const clone = sibling.cloneNode(false) as Element;
  clone.removeAttribute("style");
  return clone;
}

/** An element (a stand-in) with this display, over the page's own (in its style attribute too). */
function withDisplay<T extends Element>(element: T, display: "none" | "contents"): T {
  (element as Element as HTMLElement).style.setProperty("display", display, "important");
  return element;
}

/**
 * What a ::backdrop draws, its background, or null if nothing. Not its
 * backdrop-filter: browsers apply none in the SVG images panels are drawn from.
 */
function backdropStyle(
  style: CSSStyleDeclaration,
  inlineImage: (url: string) => string | null,
): string | null {
  const image = inlineBackgroundImages(style.backgroundImage || "none", inlineImage);
  const color = style.backgroundColor;
  if ((!color || TRANSPARENT.test(color)) && image === "none") return null;
  const declarations = BACKGROUND_PROPERTIES.map((property) => {
    const value = property === "background-image" ? image : style.getPropertyValue(property);
    return value ? `${property}:${value}` : "";
  });
  if (style.opacity && style.opacity !== "1") declarations.push(`opacity:${style.opacity}`);
  return declarations.filter(Boolean).join(";");
}

/** An element's border box size as laid out (before its transform), unrounded, or null. */
function layoutSize(element: Element, style: CSSStyleDeclaration): Box | null {
  let width = parseFloat(style.width);
  let height = parseFloat(style.height);
  if (Number.isNaN(width) || Number.isNaN(height)) return null;
  if (style.boxSizing !== "border-box") {
    const sum = (...properties: string[]) =>
      properties.reduce(
        (total, property) => total + (parseFloat(style.getPropertyValue(property)) || 0),
        0,
      );
    width += sum("padding-left", "padding-right", "border-left-width", "border-right-width");
    height += sum("padding-top", "padding-bottom", "border-top-width", "border-bottom-width");
  }
  return { left: 0, top: 0, width, height };
}

/**
 * Where an element's box is laid out, before its transform, which the copy
 * is given as the element has it now (`transform`, set when it has one), so
 * that a rotated or scaled popover shows as it does. Found from where its
 * transformed corners show; where the transform cannot be read as a matrix
 * (a percentage, a 3D rotation axis, no DOMMatrix), where it shows,
 * untransformed.
 */
function layoutBox(
  element: Element,
  style: CSSStyleDeclaration,
): Box & { transform?: Record<string, string> } {
  const { left, top, width, height } = element.getBoundingClientRect();
  const shown = { left, top, width, height };
  const { transform, translate, rotate, scale } = style;
  const none = (value: string) => !value || value === "none";
  if (none(transform) && none(translate) && none(rotate) && none(scale)) return shown;
  const Matrix = element.ownerDocument.defaultView?.DOMMatrix;
  const size = layoutSize(element, style);
  if (!Matrix || !size) return shown;
  // The individual properties apply before the transform property, in this
  // order; a missing translation is 0px, a missing scale on y is the one on x.
  // A translation in % (`translate: -50% -50%`, to centre) is of the box's size.
  const percent = (value: string, of: number) =>
    value.endsWith("%") ? `${(parseFloat(value) / 100) * of}px` : value;
  const [x = "0px", y = "0px", tz = "0px"] = translate.split(/\s+/);
  const tx = percent(x, size.width);
  const ty = percent(y, size.height);
  const [sx, sy = sx, sz = "1"] = scale.split(/\s+/);
  const parts = [
    none(translate) ? "" : `translate3d(${tx},${ty},${tz})`,
    none(rotate) ? "" : `rotate(${rotate})`,
    none(scale) ? "" : `scale3d(${sx},${sy},${sz})`,
    none(transform) ? "" : transform,
  ];
  let matrix: DOMMatrix;
  try {
    matrix = new Matrix(parts.filter(Boolean).join(" "));
  } catch {
    return shown;
  }
  const [originX = 0, originY = 0] = style.transformOrigin.split(/\s+/).map(parseFloat);
  let cornerLeft = Infinity;
  let cornerTop = Infinity;
  for (const [x, y] of [
    [0, 0],
    [size.width, 0],
    [0, size.height],
    [size.width, size.height],
  ] as const) {
    const point = matrix.transformPoint({ x: x - originX, y: y - originY });
    cornerLeft = Math.min(cornerLeft, point.x + originX);
    cornerTop = Math.min(cornerTop, point.y + originY);
  }
  return {
    left: left - cornerLeft,
    top: top - cornerTop,
    width: size.width,
    height: size.height,
    transform: {
      transform,
      translate,
      rotate,
      scale,
      "transform-origin": style.transformOrigin,
    },
  };
}

/**
 * Browsers draw the top layer over the whole page, each element where it is
 * on screen whatever its parents (a transform, a filter or a clip in them
 * would otherwise place or cut it). The copy is moved to the end of the root,
 * after the rest of the page, placed where the page has it, over its
 * ::backdrop.
 *
 * The page's rules that reach it through its parents and their siblings
 * (`.header .menu a`, `button[aria-expanded=true] + [popover]`) match it as
 * they did, and it inherits as it did: it is moved with stand-ins for its
 * parents and for their other children, which make no box (STAND_IN_RULES).
 * The stand-in for <body> is a second <body>, after the first: rules such as
 * `body:first-of-type` miss it (its computed style would not do, as what
 * getComputedStyle resolves, such as line-height in px or currentColor as a
 * color, would be inherited as such).
 */
function liftToTopLayer(
  document: Document,
  root: HTMLElement,
  { live, copy }: { live: Element; copy: HTMLElement },
  inlineImage: (url: string) => string | null,
): void {
  const view = document.defaultView!;
  const style = view.getComputedStyle(live);
  const backdrop = backdropStyle(view.getComputedStyle(live, "::backdrop"), inlineImage);
  if (backdrop) {
    const cover = root.ownerDocument.createElement("div");
    cover.setAttribute(
      "style",
      `position:fixed;inset:0;margin:0;z-index:${TOP_Z_INDEX};${backdrop}`,
    );
    root.appendChild(cover);
  }
  // A hidden stand-in takes its place (as the page has it); its parents' stand-ins are made from there.
  const placeholder = withDisplay(copy.cloneNode(false) as Element, "none");
  const box = layoutBox(live, style);
  const place: Record<string, string> = {
    display: style.display,
    position: "fixed",
    inset: "auto",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    "min-width": "0",
    "min-height": "0",
    "max-width": "none",
    "max-height": "none",
    margin: "0",
    "box-sizing": "border-box",
    // Placed already: not again by the page's anchor positioning.
    "position-area": "none",
    "z-index": `${TOP_Z_INDEX}`,
  };
  // Transformed as the element is now (not as an animation in the copy has
  // it), or, where its transform could not be undone, placed where it shows.
  Object.assign(
    place,
    box.transform ?? { transform: "none", translate: "none", rotate: "none", scale: "none" },
  );
  for (const [name, value] of Object.entries(place))
    copy.style.setProperty(name, value, "important");
  copy.setAttribute(LIFTED_ATTRIBUTE, "");

  copy.replaceWith(placeholder);
  let lifted: Element = copy;
  let original: Element = placeholder;
  while (original.parentElement && original.parentElement !== root) {
    const parent = original.parentElement;
    const shell = parent.cloneNode(false) as HTMLElement;
    withDisplay(shell, "contents").setAttribute(STAND_IN_ATTRIBUTE, "");
    const children = Array.from(parent.children);
    const at = children.indexOf(original);
    for (const child of children.slice(0, at + 1 + LATER_SIBLINGS))
      shell.appendChild(child === original ? lifted : siblingStandIn(child));
    lifted = shell;
    original = parent;
  }
  root.appendChild(lifted);
}

/** Serializes the page as XHTML (an <html> element with the XHTML namespace). */
export function snapshotDocument(document: Document, options: SnapshotOptions): string {
  const snapshotter = new Snapshotter(document, options);
  const root = snapshotter.copy(document.documentElement) as HTMLElement;
  snapshotter.pinPositioned();
  if (snapshotter.topLayer.length > 0) snapshotter.generatedRules.push(...STAND_IN_RULES);
  if (snapshotter.generatedRules.length > 0) {
    const rules = root.ownerDocument.createElement("style");
    rules.textContent = `@layer ${SCROLLED_LAYER}{${snapshotter.generatedRules.join("\n")}}`;
    root.appendChild(rules);
  }
  root.style.setProperty("width", `${document.documentElement.clientWidth}px`);
  root.style.setProperty("height", `${document.documentElement.clientHeight}px`);
  root.style.setProperty("overflow", "hidden");
  propagateBodyBackground(document, root, options.inlineImage);
  propagateBodyOverflow(document, root);
  // In the root, not <body>: a scrolled <body> is moved (or translated), which could move fixed boxes with it.
  // The highlight is drawn over the text, not under it: the page's color (often
  // opaque) is multiplied in, which keeps dark text on a light field readable.
  const pageColor =
    options.selectionColor && !TRANSPARENT.test(options.selectionColor)
      ? options.selectionColor
      : null;
  const css = options.selectionInactive
    ? `background:${INACTIVE_SELECTION_COLOR};mix-blend-mode:multiply`
    : pageColor
      ? `background:${pageColor};mix-blend-mode:multiply`
      : `background:${SELECTION_COLOR}`;
  // What the agent draws over the page goes over the page, or over the top
  // layer element it is in: drawn after it, at the same z-index.
  // In the order they were opened (those not seen opening first, in the
  // page's order); none the browser does not draw (one in a display: none box).
  const openedAt = options.openedAt ?? (() => 0);
  const layers = snapshotter.topLayer
    .filter(({ live }) => isRendered(live))
    .map((entry, index) => ({ entry, index, at: openedAt(entry.live) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map(({ entry }) => entry);
  // The innermost top layer element a node is in (a submenu's, not its menu's).
  const layerOf = (node: Node | null | undefined): number => {
    let found = -1;
    if (!node) return found;
    layers.forEach(({ live }, index) => {
      if (live.contains(node) && (found < 0 || layers[found]!.live.contains(live))) found = index;
    });
    return found;
  };
  // A field's selection is in the field's layer; the page's, each box in its text's.
  const selectionLayers = (options.selection ?? []).map((box) =>
    layerOf("text" in box ? box.text : options.selectionIn),
  );
  const compositionLayer = layerOf(options.composition?.field);
  const listBoxLayer = layerOf(options.listBox);
  const scrollbarLayers = snapshotter.scrollbars.map((bar) => layerOf(bar.element));
  for (let layer = -1; layer < layers.length; layer++) {
    if (layer >= 0) liftToTopLayer(document, root, layers[layer]!, options.inlineImage);
    options.selection?.forEach((box, index) => {
      if (selectionLayers[index] === layer) drawBox(root, box, css);
    });
    // Composed text is underlined, as IMEs do.
    if (options.composition && compositionLayer === layer) {
      const { boxes, color } = options.composition;
      for (const box of boxes) {
        const thickness = Math.max(1, Math.round(box.height / 14));
        const top = box.top + box.height - thickness;
        drawBox(root, { ...box, top, height: thickness }, `background:${color}`);
      }
    }
    // A list box's selected rows, under its scrollbar.
    if (listBoxLayer === layer)
      for (const row of options.listBoxSelection ?? []) drawListBoxRow(root, row);
    const bars = snapshotter.scrollbars.filter((_, index) => scrollbarLayers[index] === layer);
    drawScrollbars(root, bars, options.scrollbar);
  }
  // The agent's own <select> list goes over everything.
  if (options.selectPopup) drawSelectPopup(root, options.selectPopup);
  return new XMLSerializer().serializeToString(root);
}

/** Wraps the page's XHTML and CSS (its sheets, see DocumentCss) in an SVG document of the given size. */
export function buildFrameSvg(
  xhtml: string,
  sheets: readonly string[],
  width: number,
  height: number,
): string {
  // "]]>" inside CSS would end the CDATA section early.
  const styles = sheets
    .map((css) => `<style><![CDATA[${css.replace(/]]>/g, "]]]]><![CDATA[>")}]]></style>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    // The agent's layer first (see SCROLLED_LAYER), before the page's sheets.
    `<style>@layer ${SCROLLED_LAYER};</style>` +
    styles +
    `<foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject>` +
    `</svg>`
  );
}
