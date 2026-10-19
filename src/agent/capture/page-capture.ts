// Watches the panel page and turns it into SVG frames whenever it changes.
// Also routes input into the page and reports whether a text field has focus,
// and where its caret is.
//
// This runs inside the page, as part of the agent, and lives as long as the
// document. It installs the page's virtual focus and pointer capture as soon
// as it is created, but only takes snapshots once the agent is connected to
// the host (start()).

import {
  composedValue,
  isTextField,
  measureCaret,
  measureComposition,
  measureSelection,
} from "../input/caret";
import { InputSynthesizer } from "../input/input";
import { isListBox } from "../input/list-box";
import {
  caretAtPoint,
  clipCaret,
  editingHostOf,
  fontOf,
  intersect,
  selectedRange,
  selectionBoxes,
  selectionColorAt,
  type SelectionBox,
  visibleBoxOf,
} from "../input/selection";
import type { Box, Caret, Frame, FrameWindow, PanelInput } from "../../types";
import { DocumentCss, INTERACTION_ATTRIBUTES } from "./css";
import { ImageInliner } from "./images";
import { LiveInteractionCss } from "./live-css";
import { MAX_EDITABLES, MAX_TEXT_LENGTH } from "../../protocol";
import { RenderPacer } from "./pacer";
import { OpenOrder } from "../input/top-layer";
import {
  buildFrameSvg,
  isIndeterminateProgress,
  isSampledLive,
  matchLostDeclarations,
  snapshotDocument,
  type ListBoxRow,
  type LostMatches,
  type ShadowStyles,
} from "./snapshot";
import { rememberShadowRoot } from "../flat-tree";

/** Events after which a form control's state (:checked, :valid…) may have changed, with no attribute. */
const STATE_EVENTS = ["input", "change"];

/** Events after which the page may look different. */
const INVALIDATING_EVENTS = [
  "input",
  "change",
  "scroll",
  "load",
  "error",
  "focusin",
  "focusout",
  "transitionrun",
  "transitionend",
  "animationstart",
  "animationend",
  "animationiteration",
  "resize",
  // A popover opened or closed (which changes no attribute), or a <dialog> or <details>.
  "toggle",
  // The page's selection (dragging, an editable's caret, or the page's own code).
  "selectionchange",
  // A video shows another frame (while it plays, frames keep coming, see render()).
  "loadeddata",
  "play",
  "pause",
  "seeked",
  "ended",
];

/** What the page's observer watches, in the document and in each shadow root. */
const MUTATIONS: MutationObserverInit = {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
};

export interface PageCaptureOptions {
  onFrame: (frame: Frame) => void;
  /**
   * Whether an element has focus (keys should come to the page), a text field's
   * caret, its selected text (for the host to copy), and how many presses and
   * releases have been handled. Also sent after every release, changed or not.
   */
  onEditing: (
    editing: boolean,
    caret: Caret | null,
    selectedText: string,
    pointers: number,
    typing: boolean,
  ) => void;
  /** Where the text fields are now (CSS px, in view), when that changed. */
  onEditables: (boxes: Box[]) => void;
  /** The mouse cursor changed (a CSS keyword, or "" when the pointer is not over the page). */
  onCursor: (cursor: string) => void;
}

export class PageCapture {
  readonly #window: FrameWindow;
  readonly #css: DocumentCss;
  readonly #liveCss: LiveInteractionCss;
  /** A transition has run in the page (see the transitions option of InputSynthesizer). */
  #sawTransition = false;
  #inlineTransition: boolean | null = null;
  readonly #images: ImageInliner;
  readonly #input: InputSynthesizer;
  readonly #mutations: MutationObserver;
  /** The shadow roots #mutations watches too (see #watchShadowRoot). */
  readonly #shadowRoots = new WeakSet<ShadowRoot>();
  /** Puts the page's attachShadow back (see #watchShadowRoot). */
  readonly #restoreAttachShadow: () => void;
  /** The shadow roots the last snapshot drew: their animations are not the document's (see hasShadowAnimations). */
  #drawnShadowRoots: ShadowRoot[] = [];
  /** The styles of what is drawn in shadow trees, kept while the page and its layout stay (see ShadowStyles). */
  readonly #shadowStyles: ShadowStyles = { version: "", computed: new WeakMap() };
  readonly #pacer = new RenderPacer();
  #dirty = true;
  #timer = 0;
  #notBefore = 0;
  #lastEditing = "";
  /**
   * The SVG of the frame sent last. A capture that looks the same (the DOM
   * changed, as a framework re-rendering does, but not what it shows) is not
   * sent: the host would load, draw and upload it again for nothing.
   */
  #lastSvg = "";
  #lastCursor = "";
  #lastEditables = "";
  /** Presses and releases handled for this document (see onEditing). */
  #pointers = 0;
  /**
   * Bumped when the page may look different (its layout), and when its text
   * changes: the page's selection is measured again only then, not on every
   * frame an animation or a video asks for.
   */
  #layoutVersion = 0;
  #textVersion = 0;
  #selectionBoxesCache: { key: SelectionKey; boxes: SelectionBox[] } | null = null;
  readonly #openOrder: OpenOrder;
  #selectionTextCache: { key: SelectionKey; text: string } | null = null;
  /**
   * The elements of the rules whose values the CSSOM lost, found again only
   * when the rules or the page changed: not on every frame an animation asks for.
   */
  #lostMatches: {
    lost: DocumentCss["lost"];
    version: number;
    matches: LostMatches;
  } | null = null;
  /**
   * Bumped when which elements a selector matches may have changed: the DOM
   * changed (the agent's interaction marks too), or a form control's state
   * (:checked, :valid), which changes no attribute.
   */
  #matchVersion = 0;
  /**
   * The same, but for the page's own changes only, not the agent's interaction
   * marks: which of the page's rules are used (DocumentCss's prune) does not
   * depend on them, and is not looked for again on every hover.
   */
  #ruleVersion = 0;
  #started = false;
  #disposed = false;
  /**
   * The host does not draw the panel (it said so): no frames are captured, and
   * animations and videos are not sampled, until it does again. The editing
   * state, the editables and the cursor are still reported.
   */
  #hidden = false;
  /** At least this long between captures, as the host asked (it shows the panel small). */
  #paceMs = 0;
  /** When the last capture ended. */
  #renderedAt = 0;
  readonly #document: Document;
  readonly #options: PageCaptureOptions;

  constructor(document: Document, options: PageCaptureOptions) {
    this.#document = document;
    this.#options = options;
    this.#window = document.defaultView as FrameWindow;
    this.#images = new ImageInliner(() => {
      this.#css.invalidate();
      this.#changed();
    });
    this.#css = new DocumentCss(
      document,
      (url) => this.#images.get(url),
      () => {
        // A cross-origin stylesheet's copy arrived: its interaction rules apply to the live page too.
        this.#liveCss.reset();
        this.#changed();
      },
      { prune: true, onFontsLoaded: () => this.#changed() },
    );
    this.#liveCss = new LiveInteractionCss(
      document,
      (sheet) => this.#css.readable(sheet),
      () => {
        // A rule may have changed in place (an adopted sheet replaced with as many rules).
        this.#css.invalidate();
        this.#changed();
      },
    );
    this.#openOrder = new OpenOrder(this.#window);
    this.#mutations = new this.#window.MutationObserver((records) => {
      this.#matchVersion++;
      // The agent's own interaction marks: changing them is input, which says
      // itself whether the page may look different (see optimizeHover).
      const changes = records.filter(
        (record) =>
          record.type !== "attributes" || !INTERACTION_ATTRIBUTES.has(record.attributeName!),
      );
      if (changes.length === 0) return;
      this.#ruleVersion++;
      for (const { attributeName, target } of changes)
        this.#openOrder.attributeChanged(target, attributeName);
      if (changes.some((record) => record.type !== "attributes")) this.#textVersion++;
      this.#changed();
    });
    this.#input = new InputSynthesizer(document, {
      measure: this.#measure,
      onChange: () => this.#changed(),
      transitions: () => {
        // The rules as they are now, before the marks change.
        if (this.#liveCss.sync()) this.#changed();
        if (!this.#liveCss.hasTransitions && !this.#sawTransition && !this.#inlineTransitions())
          return "none";
        return this.#liveCss.reach;
      },
    });
    // A transition ran (one in an inline style, say): the page has some.
    this.#window.addEventListener("transitionrun", this.#transitionRan, true);

    this.#mutations.observe(document, MUTATIONS);
    // A shadow root attached later (a custom element defined after the page
    // loaded, say) changes no node the observer sees, nor does what goes in it.
    const proto = this.#window.Element.prototype;
    // oxlint-disable-next-line typescript/unbound-method -- called with .call on an element
    const attachShadow = proto.attachShadow;
    const attached = (root: ShadowRoot) => {
      // Still wrapped after dispose() if the page wrapped it again since.
      if (this.#disposed) return;
      // A closed one, too: the flat tree is drawn through it.
      rememberShadowRoot(root);
      this.#watchShadowRoot(root);
      this.#changed();
    };
    // The page's elements call it with themselves as `this`: no arrow function.
    const watched = function (this: Element, init: ShadowRootInit): ShadowRoot {
      const root = attachShadow.call(this, init);
      attached(root);
      return root;
    };
    proto.attachShadow = watched;
    this.#restoreAttachShadow = () => {
      if (proto.attachShadow === watched) proto.attachShadow = attachShadow;
    };
    for (const type of INVALIDATING_EVENTS)
      this.#window.addEventListener(type, this.#changed, true);
    for (const type of STATE_EVENTS) this.#window.addEventListener(type, this.#stateChanged, true);
    // A stylesheet loaded (a <link>'s, or one a <style> imports). Load events
    // of elements do not reach the window.
    document.addEventListener("load", this.#stylesheetsChanged, true);
    void document.fonts?.ready.then(() => {
      this.#css.invalidate();
      this.#changed();
    });
  }

  /**
   * Starts sending frames, or sends everything again: a frame and the editing
   * state, as if seen for the first time (after a new connection).
   */
  start(optimizeHover = true): void {
    this.#input.optimizeHover = optimizeHover;
    this.#started = true;
    // A new connection starts shown, at full pace; the host says so if not.
    this.#hidden = false;
    this.#paceMs = 0;
    this.#lastEditing = "";
    // The host waits for the new document's picture: send the next frame, whatever it looks like.
    this.#lastSvg = "";
    this.#lastCursor = "";
    this.#lastEditables = "";
    this.#css.invalidate();
    this.#invalidate();
  }

  /** Whether the host draws the panel. Shown again, the page is captured as it is now. */
  setVisible(visible: boolean): void {
    if (this.#disposed || visible === !this.#hidden) return;
    this.#hidden = !visible;
    if (visible) this.#invalidate();
  }

  /** At least `intervalMs` between captures from now on; a capture already waiting goes by the new pace. */
  setPace(intervalMs: number): void {
    if (this.#disposed || intervalMs === this.#paceMs) return;
    this.#paceMs = intervalMs;
    this.#notBefore = this.#renderedAt + Math.max(this.#pacer.interval, intervalMs);
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = 0;
    this.#schedule();
  }

  handle(input: PanelInput): void {
    if (this.#disposed) return;
    // Rules the page added since apply to the hover before the input is hit tested.
    if (this.#liveCss.sync()) this.#changed();
    this.#input.handle(input);
    // Cursor hit testing depends on pointer coordinates, even when an
    // unchanged hover skips capture. Keep its notification independent.
    if (this.#started && input.type === "pointer") this.#reportCursor();
    if (input.type !== "pointer" || (input.kind !== "down" && input.kind !== "up")) return;
    this.#pointers++;
    // The host waits for the page's answer to a tap (did it focus a text field?).
    // Moves and leaves after it are not counted: they could come before the answer.
    if (input.kind === "up") this.#lastEditing = "";
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#input.dispose();
    this.#liveCss.dispose();
    this.#css.dispose();
    this.#mutations.disconnect();
    this.#restoreAttachShadow();
    for (const type of INVALIDATING_EVENTS)
      this.#window.removeEventListener(type, this.#changed, true);
    for (const type of STATE_EVENTS)
      this.#window.removeEventListener(type, this.#stateChanged, true);
    this.#document.removeEventListener("load", this.#stylesheetsChanged, true);
    this.#window.removeEventListener("transitionrun", this.#transitionRan, true);
    this.#openOrder.dispose();
  }

  /** Runs a measurement that adds elements to the page, without it counting as a change. */
  readonly #measure = <T>(run: () => T): T => {
    try {
      return run();
    } finally {
      this.#mutations.takeRecords();
    }
  };

  readonly #invalidate = () => {
    this.#dirty = true;
    this.#schedule();
  };

  /**
   * The page may look different: capture it again, and measure its selection
   * again. Its stylesheets may have changed too (the DOM did, or input made
   * the page render).
   */
  readonly #changed = () => {
    this.#layoutVersion++;
    this.#liveCss.invalidate();
    this.#inlineTransition = null;
    this.#invalidate();
  };

  readonly #stateChanged = () => {
    this.#matchVersion++;
    this.#ruleVersion++;
  };

  readonly #transitionRan = () => {
    this.#sawTransition = true;
  };

  /** Whether an element has a transition in its inline style (cached until the page changes). */
  #inlineTransitions(): boolean {
    this.#inlineTransition ??= this.#document.querySelector('[style*="transition"]') !== null;
    return this.#inlineTransition;
  }

  readonly #stylesheetsChanged = (event: Event) => {
    const { HTMLLinkElement, HTMLStyleElement } = this.#window;
    if (event.target instanceof HTMLLinkElement || event.target instanceof HTMLStyleElement)
      this.#changed();
  };

  // A plain timer, not requestAnimationFrame: browsers may hold back rAF in an
  // iframe they consider not on screen (this one is transparent and behind the
  // host's canvas). Taking the snapshot forces style and layout anyway.
  #schedule(): void {
    if (!this.#started || this.#disposed || this.#timer) return;
    const wait = Math.max(0, this.#notBefore - performance.now());
    this.#timer = window.setTimeout(() => {
      this.#timer = 0;
      this.#render();
    }, wait);
  }

  /** Animations copied as they are now (see collectAnimatedValues in snapshot.ts); the others end on a fixed value. */
  #hasLiveAnimations(): boolean {
    const document = this.#document;
    return document
      .getAnimations()
      .some((animation) => animation.playState === "running" && isSampledLive(animation));
  }

  #render(): void {
    if (this.#disposed || !this.#dirty) return;
    this.#dirty = false;
    // Before measuring anything: the page may have added rules since the last
    // input, or moved the focused element (its ancestors are :focus-within).
    // Either may lay the page out differently: its selection is measured again.
    const rewritten = this.#liveCss.sync();
    if (this.#input.syncMarks() || rewritten) this.#layoutVersion++;
    const started = performance.now();
    try {
      // The viewport, including any scrollbar: exactly the iframe's size.
      const width = this.#window.innerWidth;
      const height = this.#window.innerHeight;
      if (!this.#hidden) this.#sendFrame(width, height);
      this.#reportEditing();
      this.#reportEditables(width, height);
      this.#reportCursor();
    } finally {
      this.#renderedAt = performance.now();
      this.#notBefore =
        this.#renderedAt + Math.max(this.#pacer.record(this.#renderedAt - started), this.#paceMs);
    }
    // Keep sampling while something is animating or a video plays, so the panel shows it moving.
    if (this.#dirty || (!this.#hidden && this.#isMoving())) this.#invalidate();
  }

  /** Captures the page and sends it, unless it looks as it did in the frame sent last. */
  #sendFrame(width: number, height: number): void {
    const focused = this.#input.focused;
    const composing = this.#input.composition;
    const host = focused && editingHostOf(focused) === focused ? focused : null;
    // While composing, the selection is what the composition replaces: not drawn.
    // Outside text fields, the page's own selection is drawn (its text, or an editable's).
    const range = isTextField(focused) || (host && composing) ? null : selectedRange(this.#window);
    const selection = isTextField(focused)
      ? composing
        ? []
        : this.#measure(() => measureSelection(focused))
      : range
        ? this.#selectionBoxes(range)
        : [];
    const composition =
      isTextField(focused) && composing
        ? {
            field: focused,
            value: composedValue(focused, composing).value,
            boxes: this.#measure(() => measureComposition(focused, composing)),
            color: this.#window.getComputedStyle(focused).color,
          }
        : null;
    // The page's ::selection color, if it sets one.
    const selectionColor = isTextField(focused)
      ? this.#window.getComputedStyle(focused, "::selection").backgroundColor
      : range
        ? selectionColorAt(this.#window, range)
        : undefined;
    // Collected first: the snapshot takes what the CSSOM lost of it from the page (DocumentCss.lost).
    const sheets = this.#css.get(this.#ruleVersion);
    this.#shadowStyles.version = `${this.#layoutVersion}:${this.#matchVersion}`;
    const drawnShadowRoots: ShadowRoot[] = [];
    // The snapshot measures scrolled text fields with a mirror (caret.ts).
    const xhtml = this.#measure(() =>
      snapshotDocument(this.#document, {
        selection,
        selectionIn: isTextField(focused) ? focused : null,
        selectionColor,
        // The page's selection, when the keys do not go to it (the host took them, or the page made it).
        selectionInactive:
          range !== null &&
          !this.#input.hasSelection &&
          !(host && host.contains(range.startContainer)),
        composition,
        inlineComposition: host && composing ? this.#inlineComposition(composing.text) : null,
        scrollbar: this.#input.scrollbarState,
        selectPopup: this.#input.popupView,
        listBoxSelection: isListBox(focused) ? this.#listBoxRows(focused) : [],
        listBox: isListBox(focused) ? focused : null,
        openedAt: (element) => this.#openOrder.at(element),
        inlineImage: (url) => this.#images.get(url),
        lost: this.#lostElements(),
        // One declared in the HTML, or attached before the agent ran.
        shadowRoot: (root) => {
          this.#watchShadowRoot(root);
          drawnShadowRoots.push(root);
        },
        shadowStyles: this.#shadowStyles,
      }),
    );
    this.#drawnShadowRoots = drawnShadowRoots;
    const svg = buildFrameSvg(xhtml, sheets, width, height);
    if (svg !== this.#lastSvg) {
      this.#lastSvg = svg;
      this.#options.onFrame({ svg, width, height });
    }
  }

  /** Watches a shadow root for changes as the page's document is: the document's observer does not see into it. */
  #watchShadowRoot(root: ShadowRoot): void {
    if (this.#disposed || this.#shadowRoots.has(root)) return;
    this.#shadowRoots.add(root);
    this.#mutations.observe(root, MUTATIONS);
  }

  /** The boxes of the page's selection, measured again only when it or the page changed. */
  #selectionBoxes(range: Range): SelectionBox[] {
    const key = selectionKey(range, this.#layoutVersion);
    const cached = this.#selectionBoxesCache;
    if (cached && sameKey(cached.key, key)) return cached.boxes;
    const boxes = selectionBoxes(this.#window, range);
    this.#selectionBoxesCache = { key, boxes };
    return boxes;
  }

  /** The text to copy: a text field's, or the page's selection (built again only when it or the text changed). */
  #selectedText(): string {
    if (isTextField(this.#input.focused)) return this.#input.selectedText;
    const range = selectedRange(this.#window);
    if (!range) return "";
    const key = selectionKey(range, this.#textVersion);
    const cached = this.#selectionTextCache;
    if (cached && sameKey(cached.key, key)) return cached.text;
    const text = this.#input.selectedText;
    this.#selectionTextCache = { key, text };
    return text;
  }

  /** The selected options of the focused list box, where they show. */
  #listBoxRows(select: HTMLSelectElement): ListBoxRow[] {
    const visible = visibleBoxOf(select);
    const rows: ListBoxRow[] = [];
    for (const option of Array.from(select.selectedOptions)) {
      const rect = option.getBoundingClientRect();
      const box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      const shown = intersect(box, visible);
      if (shown.width <= 0 || shown.height <= 0) continue;
      const paddingLeft = parseFloat(this.#window.getComputedStyle(option).paddingLeft) || 0;
      rows.push({
        shown,
        box,
        label: option.label || option.text,
        font: fontOf(option),
        paddingLeft,
      });
    }
    return rows;
  }

  /** The elements of the rules whose values the CSSOM lost (see DocumentCss.lost), once get() collected them. */
  #lostElements(): LostMatches {
    const lost = this.#css.lost;
    const cached = this.#lostMatches;
    const version = this.#matchVersion;
    if (cached?.lost === lost && cached.version === version) return cached.matches;
    const matches = matchLostDeclarations(this.#document, lost);
    this.#lostMatches = { lost, version, matches };
    return matches;
  }

  /** Whether anything on the page moves by itself: an animation, a video, an indeterminate <progress> in view (see snapshot.ts). */
  #isMoving(): boolean {
    return (
      this.#hasLiveAnimations() ||
      this.#hasShadowAnimations() ||
      this.#hasPlayingVideo() ||
      this.#hasIndeterminateInView()
    );
  }

  /** What is drawn in a shadow tree is copied as computed: any animation running there changes it. */
  #hasShadowAnimations(): boolean {
    return this.#drawnShadowRoots.some(
      (root) =>
        // jsdom has none.
        typeof root.getAnimations === "function" &&
        root.getAnimations().some((animation) => animation.playState === "running"),
    );
  }

  #hasIndeterminateInView(): boolean {
    const { innerWidth, innerHeight } = this.#window;
    return Array.from(this.#document.querySelectorAll("progress")).some((progress) => {
      if (!isIndeterminateProgress(this.#window, progress)) return false;
      // Hidden (visibility, opacity), it shows nothing moving. Not in Safari before 17.4.
      if (
        typeof progress.checkVisibility === "function" &&
        !progress.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      )
        return false;
      const box = progress.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        box.right > 0 &&
        box.bottom > 0 &&
        box.left < innerWidth &&
        box.top < innerHeight
      );
    });
  }

  #hasPlayingVideo(): boolean {
    return Array.from(this.#document.querySelectorAll("video")).some(
      (video) => !video.paused && !video.ended && video.readyState >= 2,
    );
  }

  /** Where text composed in an editable shows: where the selection starts, in place of what is selected in that node. */
  #inlineComposition(
    text: string,
  ): { node: Node; offset: number; endOffset: number; text: string } | null {
    const selection = this.#window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    const sameText =
      range.startContainer === range.endContainer &&
      range.startContainer.nodeType === Node.TEXT_NODE;
    return {
      node: range.startContainer,
      offset: range.startOffset,
      endOffset: sameText ? range.endOffset : range.startOffset,
      text,
    };
  }

  /** The caret of a focused editable (its collapsed selection), or null while text is selected or it is elsewhere. */
  #editableCaret(host: HTMLElement): Caret | null {
    const selection = this.#window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const composing = this.#input.composition;
    if (!selection.isCollapsed && !composing) return null;
    const range = selection.getRangeAt(0);
    if (!host.contains(range.startContainer)) return null;
    const caret = caretAtPoint(
      { node: range.startContainer, offset: range.startOffset },
      composing ? composing.text.slice(0, composing.cursor) : "",
    );
    // Cut to what shows of the editable.
    const shown = caret && clipCaret(caret, visibleBoxOf(host));
    if (!shown) return null;
    const computed = this.#window.getComputedStyle(host);
    const color = computed.caretColor === "auto" ? computed.color : computed.caretColor;
    return { ...shown, color };
  }

  /** The text fields and editables in view, for the host to open a soft keyboard on a tap right away. */
  #reportEditables(width: number, height: number): void {
    const boxes: Box[] = [];
    for (const field of Array.from(
      this.#document.querySelectorAll("input, textarea, [contenteditable]"),
    )) {
      if (boxes.length === MAX_EDITABLES) break;
      if (!isTextField(field) && editingHostOf(field) !== field) continue;
      const rect = field.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(width, rect.right);
      const bottom = Math.min(height, rect.bottom);
      if (right > left && bottom > top)
        boxes.push({ left, top, width: right - left, height: bottom - top });
    }
    const key = JSON.stringify(boxes);
    if (key === this.#lastEditables) return;
    this.#lastEditables = key;
    this.#options.onEditables(boxes);
  }

  #reportCursor(): void {
    const cursor = this.#input.cursor;
    if (cursor === this.#lastCursor) return;
    this.#lastCursor = cursor;
    this.#options.onCursor(cursor);
  }

  #reportEditing(): void {
    const focused = this.#input.focused;
    // Any focused element takes keys: Enter and Space on a button, Tab anywhere.
    // So does selected text, to be copied.
    const editing = focused !== null || this.#input.hasSelection;
    const host = focused ? editingHostOf(focused) : null;
    const caret = isTextField(focused)
      ? this.#measure(() => measureCaret(focused, this.#input.composition))
      : host && host === focused
        ? this.#editableCaret(host)
        : null;
    // A selection too long to send is not offered for copying at all, rather than cut short.
    const selected = this.#selectedText();
    const selectedText = selected.length <= MAX_TEXT_LENGTH ? selected : "";
    // Text typed now goes in: a text field or an editable has focus (with or without a caret).
    const typing = isTextField(focused) || (host !== null && host === focused);
    const key = JSON.stringify([editing, caret, selectedText, typing]);
    if (key === this.#lastEditing) return;
    this.#lastEditing = key;
    this.#options.onEditing(editing, caret, selectedText, this.#pointers, typing);
  }
}

/** A selection's ends and the page's version, to tell whether what was measured of it still holds. */
type SelectionKey = [
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
  version: number,
];

const selectionKey = (range: Range, version: number): SelectionKey => [
  range.startContainer,
  range.startOffset,
  range.endContainer,
  range.endOffset,
  version,
];

const sameKey = (a: SelectionKey, b: SelectionKey) => a.every((value, i) => value === b[i]);
