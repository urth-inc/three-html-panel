// Makes the page's own CSS follow the agent's interaction states.
//
// The panel iframe never gets a real pointer or real focus, so :hover,
// :active, :focus and :focus-within never match in the live page. The image
// shows them (css.ts rewrites them to attributes the agent sets, see
// interaction-marks.ts), but hit testing runs on the live page: a button
// shown only while its row is hovered would be drawn, yet a press there would
// land on what is under it. So the page's rules are rewritten too, in place:
// `.row:hover .tools` becomes `.row:is(:hover,[data-thp-hover]) .tools`. Same
// specificity, same place in the cascade, and still matching for real when the
// browser does match (a page opened on its own), without applying twice.
//
// What the page can see: the selectorText of those rules, as it reads it back.
// The rules themselves, their number and order, stay as they were (CSS-in-JS
// libraries address rules by index). The CSSOM methods that change stylesheets
// are wrapped, to know when to look again.
//
// The stylesheets of shadow roots are not rewritten: the agent's hover and
// focus stop at a shadow root anyway.
//
// The page's selector queries (matches, closest, querySelector(All)) are
// rewritten the same way, for its scripts to see the states its CSS does.
//
// Rules the page's script cannot read (a cross-origin stylesheet without CORS,
// linked or imported) cannot be edited. Their interaction rules, from the copy
// DocumentCss fetches, go into a sheet of the agent's own (adoptedStyleSheets),
// after the page's: there they win ties with the page's rules of the same
// specificity that come later.
//
// That sheet also turns off iOS Safari's text autosizing, from the start (see
// LIVE_PAGE_CSS).
//
// An interaction pseudo-class after a pseudo-element
// (::-webkit-scrollbar-thumb:hover) is left alone, as css.ts does for the image.

import type { FrameWindow } from "../../types";
import {
  absolutizeUrls,
  agentSheets,
  declarationsOf,
  writtenBlockOf,
  liveSelector,
  pageStylesheets,
  ruleCount,
  sheetSignature,
  signatureParts,
  stylesheetsSignature,
  unwrapLiveSelector,
} from "./css";

/** What the page changed through the CSSOM (see watchStylesheets). */
export type CssomChange =
  /** A rule inserted into a stylesheet or a block (@media, ...), at `index`. */
  | { kind: "insert"; parent: CSSStyleSheet | CSSGroupingRule; index: number }
  /** A rule deleted (`rule`, if there was one at the index): nothing to rewrite, but the stylesheets are not what they were. */
  | { kind: "delete"; parent: CSSStyleSheet | CSSGroupingRule; rule: CSSRule | undefined }
  /** A style rule's selector set. */
  | { kind: "selector"; rule: CSSStyleRule }
  /** A stylesheet replaced, disabled or enabled, or rules added the old way (addRule). */
  | { kind: "sheet"; sheet: CSSStyleSheet }
  /** A <style> element disabled or enabled, or a document's adoptedStyleSheets set. */
  | { kind: "owner"; owner: Element | Document };

type CssomListener = (change: CssomChange) => void;

/** Per window: who listens, and what puts the originals back. Wrapped once, however many listen. */
const watchers = new WeakMap<object, { listeners: Set<CssomListener>; unwrap: () => void }>();

/**
 * Calls `listener` after the page's script changes a stylesheet through the
 * CSSOM (insertRule, replace, disabled, adoptedStyleSheets, ...), which no
 * MutationObserver sees. The methods and setters are replaced in the page's
 * realm, once; the originals come back when the last listener stops. Returns
 * what stops it.
 */
function watchStylesheets(window: FrameWindow, listener: CssomListener): () => void {
  let watcher = watchers.get(window);
  if (!watcher) {
    const listeners = new Set<CssomListener>();
    const unwrap = wrapCssom(window, (change) => {
      for (const each of Array.from(listeners)) each(change);
    });
    watcher = { listeners, unwrap };
    watchers.set(window, watcher);
  }
  const { listeners, unwrap } = watcher;
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    unwrap();
    watchers.delete(window);
  };
}

/** Wraps the CSSOM's methods and setters that change stylesheets; returns what puts them back. */
function wrapCssom(window: FrameWindow, onChange: CssomListener): () => void {
  const restores: (() => void)[] = [];
  const wrapMethod = (
    proto: Record<string, unknown> | undefined,
    name: string,
    change: (target: never, result: unknown, args: unknown[], before: unknown) => CssomChange,
    /** What to take note of before the call (the rule a deleteRule removes). */
    prepare: (target: never, args: unknown[]) => unknown = () => undefined,
  ) => {
    const original = proto?.[name];
    if (!proto || typeof original !== "function") return;
    // The page's sheets call these with themselves as `this`: no arrow function.
    const wrapped = function (this: never, ...args: unknown[]) {
      const before = prepare(this, args);
      // Throws (a cross-origin sheet, an invalid rule) before anything changed.
      const result: unknown = original.apply(this, args);
      onChange(change(this, result, args, before));
      // replace() applies the rules later.
      if (result && typeof (result as Promise<unknown>).then === "function")
        (result as Promise<unknown>).then(
          () => onChange(change(this, result, args, before)),
          () => {},
        );
      return result;
    };
    proto[name] = wrapped;
    restores.push(() => {
      if (proto[name] === wrapped) proto[name] = original;
    });
  };
  const wrapSetter = (
    proto: object | undefined,
    name: string,
    change: (target: never) => CssomChange,
  ) => {
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, name);
    // oxlint-disable-next-line typescript/unbound-method -- called with .call on the page's object
    const set = descriptor?.set;
    if (!proto || !descriptor?.configurable || !set) return;
    const wrapped = function (this: never, value: unknown) {
      set.call(this, value);
      onChange(change(this));
    };
    Object.defineProperty(proto, name, { ...descriptor, set: wrapped });
    restores.push(() => {
      // Not over a wrapper the page (or a polyfill) put there since.
      if (Object.getOwnPropertyDescriptor(proto, name)?.set === wrapped)
        Object.defineProperty(proto, name, descriptor);
    });
  };
  type Parent = CSSStyleSheet | CSSGroupingRule;
  const insert = (parent: Parent, index: unknown): CssomChange => ({
    kind: "insert",
    parent,
    index: index as number,
  });
  const remove = (
    parent: Parent,
    _result: unknown,
    _args: unknown[],
    rule: unknown,
  ): CssomChange => ({
    kind: "delete",
    parent,
    rule: rule as CSSRule | undefined,
  });
  /** The rule at the index given (removeRule's defaults to 0), before it goes. */
  const ruleAt = (parent: Parent, args: unknown[]): unknown => {
    try {
      return parent.cssRules[Number(args[0] ?? 0)];
    } catch {
      return undefined;
    }
  };
  const sheetChange = (sheet: CSSStyleSheet): CssomChange => ({ kind: "sheet", sheet });
  const sheet = window.CSSStyleSheet?.prototype as unknown as Record<string, unknown> | undefined;
  wrapMethod(sheet, "insertRule", insert);
  wrapMethod(sheet, "deleteRule", remove, ruleAt);
  wrapMethod(sheet, "removeRule", remove, ruleAt);
  for (const name of ["addRule", "replace", "replaceSync"]) wrapMethod(sheet, name, sheetChange);
  const grouping = (
    window as unknown as { CSSGroupingRule?: { prototype: Record<string, unknown> } }
  ).CSSGroupingRule?.prototype;
  wrapMethod(grouping, "insertRule", insert);
  wrapMethod(grouping, "deleteRule", remove, ruleAt);
  wrapSetter(window.CSSStyleRule?.prototype, "selectorText", (rule: CSSStyleRule) => ({
    kind: "selector",
    rule,
  }));
  wrapSetter(window.StyleSheet?.prototype, "disabled", sheetChange);
  // Not reflected in an attribute: no MutationObserver sees it.
  const owner = (element: Element | Document): CssomChange => ({ kind: "owner", owner: element });
  wrapSetter(window.HTMLStyleElement?.prototype, "disabled", owner);
  wrapSetter(window.Document?.prototype, "adoptedStyleSheets", owner);
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

/** Per window: how many use the patched selector queries, and what puts them back. */
const queryPatches = new WeakMap<object, { users: number; unpatch: () => void }>();

/** Selectors with an interaction pseudo-class in them, rewritten (a page queries the same few again and again). */
const querySelectors = new Map<string, string>();
const MAX_QUERY_SELECTORS = 256;
const MAY_HAVE_INTERACTION = /:(?:hover|active|focus)/;

function liveQuery(selector: unknown): unknown {
  if (typeof selector !== "string" || !MAY_HAVE_INTERACTION.test(selector)) return selector;
  let rewritten = querySelectors.get(selector);
  if (rewritten === undefined) {
    rewritten = liveSelector(selector) ?? selector;
    if (querySelectors.size >= MAX_QUERY_SELECTORS) querySelectors.clear();
    querySelectors.set(selector, rewritten);
  }
  return rewritten;
}

/**
 * Makes the page's selector queries (matches, closest, querySelector,
 * querySelectorAll) see the agent's interaction states as its stylesheets
 * do: `menu.matches(":hover")` is true while the agent hovers the menu.
 * Patched once per window; put back when the last user stops.
 */
function patchSelectorQueries(window: FrameWindow): () => void {
  let patch = queryPatches.get(window);
  if (!patch) {
    const restores: (() => void)[] = [];
    const wrap = (proto: Record<string, unknown> | undefined, name: string) => {
      const original = proto?.[name];
      if (!proto || typeof original !== "function") return;
      // The page's elements call these with themselves as `this`: no arrow function.
      const wrapped = function (this: unknown, selector: unknown, ...rest: unknown[]) {
        return original.call(this, liveQuery(selector), ...rest);
      };
      proto[name] = wrapped;
      restores.push(() => {
        if (proto[name] === wrapped) proto[name] = original;
      });
    };
    const prototypes = [window.Element, window.Document, window.DocumentFragment].map(
      (type) => type?.prototype as unknown as Record<string, unknown> | undefined,
    );
    for (const proto of prototypes) {
      for (const name of ["querySelector", "querySelectorAll"]) wrap(proto, name);
    }
    for (const name of ["matches", "closest", "webkitMatchesSelector"]) wrap(prototypes[0], name);
    patch = { users: 0, unpatch: () => restores.reverse().forEach((restore) => restore()) };
    queryPatches.set(window, patch);
  }
  patch.users++;
  const current = patch;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--current.users > 0) return;
    current.unpatch();
    queryPatches.delete(window);
  };
}

/** Sibling combinators: a rule about one element restyles its later siblings (`+` in an :nth-child() too, which is only cautious). */
const SIBLING_SELECTOR = /[~+]/;
/**
 * Always in the agent's sheet. iOS Safari enlarges the text of the panel
 * iframe (text autosizing), but not in the image, which then shows the page
 * shorter than the live page that hit testing and the caret are measured on.
 * Laid out without the rule, the page has its text enlarged until it is laid
 * out with it again: the sheet is there before the page's scripts run, and put
 * back on the next sync if the page replaces the list (not at once: the page
 * reads back the list it set, and one that keeps setting it does not fight
 * the agent, restyling the whole document each time).
 *
 * On the root only: the property is inherited, and a rule on every element
 * would be matched against all of them on each restyle.
 */
const LIVE_PAGE_CSS =
  ":root{-webkit-text-size-adjust:100%!important;text-size-adjust:100%!important}";

/** :has(): a rule about one element restyles any other. */
const HAS_SELECTOR = /:has\(/;

/** How far the page's interaction rules restyle beyond the elements in the state. */
export type InteractionReach = "inside" | "siblings" | "everywhere";

/**
 * Whether declarations make an element transition: some duration other than
 * 0, or one from a custom property (`var(--duration)`), which may be.
 */
export function hasTransition(style: CSSStyleDeclaration): boolean {
  const duration =
    style.getPropertyValue("transition-duration") || style.getPropertyValue("transition");
  return /[1-9]|var\(/.test(duration);
}

/** A document, with adoptedStyleSheets where the browser has them. */
type AdoptingDocument = Document & { adoptedStyleSheets?: CSSStyleSheet[] };

export class LiveInteractionCss {
  /**
   * The parts of the signature as last synced (see signatureParts), and where
   * each stylesheet's is. A sheet changed through the CSSOM and taken care of
   * right away has its own part brought up to date, and only that: what else
   * changed meanwhile (a sheet added, an @import loaded) still shows on the
   * next sync.
   */
  #parts: [CSSStyleSheet | null, string][] = [];
  /** Where each sheet's parts are: a sheet can be there twice (adopted twice, or imported twice). */
  readonly #partIndex = new Map<CSSStyleSheet, number[]>();
  /** The signature as last synced; null when parts changed since (joined only when compared). */
  #signature: string | null = "";
  /**
   * The stylesheets may have changed since the last sync. Reading them all
   * on every pointer move would be wasted work: the page says when (see
   * invalidate()), or the CSSOM does (watchStylesheets: a rule inserted is
   * rewritten right away, other changes are looked at on the next sync).
   */
  #stale = true;
  /** Set while syncing: the agent's own sheet changing is not the page's. */
  #syncing = false;
  /**
   * The page's adoptedStyleSheets when last synced. The list can be changed
   * in place (push, splice), which no setter sees: compared on every sync.
   */
  #adoptedList: readonly CSSStyleSheet[] = [];
  /** The text of the agent's own sheet, not replaced again when the same. */
  #adoptedCss = "";
  /** The selectors rewritten, as the page wrote them (restored on dispose). */
  readonly #originals = new Map<CSSStyleRule, string>();
  /** Rules whose rewritten selector the browser did not take: not tried again. */
  readonly #rejected = new WeakSet<CSSStyleRule>();
  /**
   * How far the page's interaction rules restyle: only inside the elements
   * in the state, also their later siblings (`.a:hover ~ .b`), or anything
   * (`.list:has(.row:hover) .bar`).
   */
  reach: InteractionReach = "inside";
  /** The page's stylesheets have transitions (or may: those read through a copy are counted as having some). */
  hasTransitions = false;
  /** The interaction rules of stylesheets that could not be edited. */
  #adopted: CSSStyleSheet | null = null;
  readonly #window: FrameWindow;
  readonly #unwatch: () => void;
  readonly #unpatchQueries: () => void;
  readonly #document: Document;
  /** The sheet itself if it can be read, or else a readable copy (DocumentCss.readable). */
  readonly #readable: (sheet: CSSStyleSheet) => CSSStyleSheet | null;
  /** The page changed its stylesheets through the CSSOM: it may look different. */
  readonly #onChange: () => void;

  constructor(
    document: Document,
    readable: (sheet: CSSStyleSheet) => CSSStyleSheet | null = (sheet) =>
      ruleCount(sheet) >= 0 ? sheet : null,
    onChange: () => void = () => {},
  ) {
    this.#document = document;
    this.#readable = readable;
    this.#onChange = onChange;
    this.#window = document.defaultView as FrameWindow;
    this.#unwatch = watchStylesheets(this.#window, (change) => this.#cssomChanged(change));
    this.#unpatchQueries = patchSelectorQueries(this.#window);
    this.#adopt("");
  }

  /**
   * The stylesheets may have changed: the DOM did (a <style> or <link> added,
   * or a framework rendering), or a stylesheet loaded.
   */
  invalidate(): void {
    this.#stale = true;
  }

  /** Rewrites everything again on the next sync (a copy of a cross-origin sheet arrived, say). */
  reset(): void {
    this.#stale = true;
    this.#signature = "";
    this.#parts = [];
    this.#partIndex.clear();
  }

  /**
   * Rewrites the rules added since the last call, if the page may have changed
   * its stylesheets: stylesheets added, removed, replaced, disabled or
   * enabled, rules added to or removed from them (or the sheets they import),
   * and whatever the page changes through the CSSOM. Returns whether it
   * rewrote anything (the page may lay out differently).
   */
  sync(): boolean {
    const adopted = this.#adoptedSheets();
    this.#keepAdopted(adopted);
    const pageList = this.#pageAdoptedList(adopted);
    if (!this.#stale && !this.#adoptedListChanged(pageList)) return false;
    this.#stale = false;
    this.#adoptedList = pageList;
    const sheets = pageStylesheets(this.#document);
    const parts = signatureParts(sheets);
    const signature = stylesheetsSignature(parts);
    if (signature === (this.#signature ??= stylesheetsSignature(this.#parts))) return false;
    this.#parts = parts;
    this.#partIndex.clear();
    parts.forEach(([sheet], i) => {
      if (!sheet) return;
      const indices = this.#partIndex.get(sheet);
      if (indices) indices.push(i);
      else this.#partIndex.set(sheet, [i]);
    });
    this.#signature = signature;
    this.#syncing = true;
    try {
      const copied: string[] = [];
      const visited = new Set<CSSStyleSheet>();
      for (const sheet of sheets) this.syncSheet(sheet, sheet.media.mediaText, copied, visited);
      // Rules of sheets the page removed (or rules it deleted) are not restored.
      for (const rule of this.#originals.keys())
        if (!rule.parentStyleSheet || !visited.has(rule.parentStyleSheet))
          this.#originals.delete(rule);
      this.#adopt(copied.join("\n"));
    } finally {
      this.#syncing = false;
    }
    return true;
  }

  /** What the page changed through the CSSOM, if it is in the document's stylesheets. */
  #cssomChanged(change: CssomChange): void {
    if (this.#syncing) return;
    switch (change.kind) {
      case "insert": {
        const sheet = this.#pageSheetOf(change.parent);
        if (!sheet) return;
        const rule = change.parent.cssRules[change.index];
        // Only the rule inserted is rewritten, not all the page's (CSS-in-JS inserts rules all the time).
        // It could be inserted: the sheet is readable.
        if (rule && !(rule instanceof this.#window.CSSImportRule)) {
          this.#syncing = true;
          try {
            this.#rewrite([rule], [], new Set());
          } finally {
            this.#syncing = false;
          }
          this.#sheetChanged(sheet);
        } else {
          this.reset();
        }
        break;
      }
      case "delete": {
        const sheet = this.#pageSheetOf(change.parent);
        if (!sheet) return;
        // Nothing to rewrite; nothing to put back on dispose either.
        if (change.rule) this.#forget(change.rule);
        this.#sheetChanged(sheet);
        break;
      }
      case "selector": {
        const { rule } = change;
        if (!rule.parentStyleSheet || !this.#pageSheetOf(rule)) return;
        // The page's own selector now: rewritten as any other.
        this.#originals.delete(rule);
        this.#rejected.delete(rule);
        this.#syncing = true;
        try {
          this.#rewriteRule(rule);
        } finally {
          this.#syncing = false;
        }
        // Written back as it read it (rewritten): put back without the rewrite on dispose.
        if (!this.#originals.has(rule) && rule.selectorText.includes("[data-thp-"))
          this.#originals.set(rule, unwrapLiveSelector(rule.selectorText));
        break;
      }
      case "sheet":
        if (!this.#pageSheetOf(change.sheet)) return;
        this.reset();
        break;
      case "owner":
        if (change.owner !== this.#document && change.owner.ownerDocument !== this.#document)
          return;
        this.invalidate();
        break;
    }
    this.#onChange();
  }

  /**
   * A sheet changed only in what was taken care of already: its part of the
   * signature is brought up to date, so that the next sync does not look at
   * everything again. A sheet not synced yet is left for the next sync.
   */
  #sheetChanged(sheet: CSSStyleSheet): void {
    const indices = this.#partIndex.get(sheet);
    if (!indices) return;
    const part = sheetSignature(sheet);
    for (const index of indices) this.#parts[index] = [sheet, part];
    this.#signature = null;
  }

  /** A rule the page deleted, and those nested in it: not restored on dispose. */
  #forget(rule: CSSRule): void {
    if (rule instanceof this.#window.CSSStyleRule) this.#originals.delete(rule);
    if ("cssRules" in rule)
      for (const nested of Array.from(rule.cssRules as CSSRuleList)) this.#forget(nested);
  }

  /**
   * The stylesheet `parent` is (or is in), if it is one of the page's, or
   * one they import; null if not (a shadow root's, say).
   */
  #pageSheetOf(parent: CSSStyleSheet | CSSRule): CSSStyleSheet | null {
    const own = parent instanceof this.#window.CSSStyleSheet ? parent : parent.parentStyleSheet;
    if (!own) return null;
    // The sheets synced last, without listing the page's again (CSS-in-JS inserts rules all the time).
    if (this.#partIndex.has(own)) return own;
    let top = own;
    while (top.ownerRule?.parentStyleSheet) top = top.ownerRule.parentStyleSheet;
    return pageStylesheets(this.#document).includes(top) ? own : null;
  }

  /** The document's adoptedStyleSheets; undefined where there are none (jsdom). */
  #adoptedSheets(): CSSStyleSheet[] | undefined {
    return (this.#document as AdoptingDocument).adoptedStyleSheets;
  }

  #setAdoptedSheets(sheets: CSSStyleSheet[]): void {
    (this.#document as AdoptingDocument).adoptedStyleSheets = sheets;
  }

  #pageAdoptedList(adopted: readonly CSSStyleSheet[] | undefined): readonly CSSStyleSheet[] {
    return adopted ? adopted.filter((sheet) => !agentSheets.has(sheet)) : [];
  }

  #adoptedListChanged(list: readonly CSSStyleSheet[]): boolean {
    return (
      list.length !== this.#adoptedList.length ||
      list.some((sheet, i) => sheet !== this.#adoptedList[i])
    );
  }

  /** Puts the page's selectors and the CSSOM back. */
  dispose(): void {
    this.#syncing = true;
    for (const [rule, selector] of this.#originals) rule.selectorText = selector;
    this.#originals.clear();
    this.#unadopt();
    this.#unwatch();
    this.#unpatchQueries();
    this.reset();
  }

  /**
   * Rewrites a sheet in place, or, if the page cannot edit it, copies its
   * interaction rules out. Not #private: a test counts the calls.
   */
  private syncSheet(
    source: CSSStyleSheet,
    media: string,
    copied: string[],
    visited: Set<CSSStyleSheet>,
  ): void {
    // Its copy would not be used: not fetched for nothing.
    if (source.disabled && ruleCount(source) < 0) return;
    // A disabled sheet is rewritten as well, for when the page enables it.
    const sheet = this.#readable(source);
    if (!sheet) return;
    if (sheet === source) {
      visited.add(sheet);
      this.#rewrite(sheet.cssRules, copied, visited);
      return;
    }
    if (source.disabled) return;
    // Its rules are not walked: it may have transitions that the page's hover rules start.
    this.hasTransitions = true;
    let css = this.#interactionRules(sheet.cssRules, false).join("\n");
    if (!css) return;
    this.#widen(css);
    // In the agent's sheet, url() would be relative to the document.
    if (source.href) css = absolutizeUrls(css, source.href);
    copied.push(media && media !== "all" ? `@media ${media}{${css}}` : css);
  }

  #rewrite(rules: ArrayLike<CSSRule>, copied: string[], visited: Set<CSSStyleSheet>): void {
    const { CSSStyleRule, CSSImportRule } = this.#window;
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) this.#rewriteRule(rule);
      if (rule instanceof CSSImportRule) {
        if (rule.styleSheet) this.syncSheet(rule.styleSheet, rule.media.mediaText, copied, visited);
      } else if ("cssRules" in rule) {
        // @media, @supports, @layer, @container blocks, and nested style rules.
        this.#rewrite(rule.cssRules as CSSRuleList, copied, visited);
      }
    }
  }

  #rewriteRule(rule: CSSStyleRule): void {
    if (!this.hasTransitions && hasTransition(rule.style)) this.hasTransitions = true;
    if (this.#rejected.has(rule)) return;
    const original = rule.selectorText;
    const selector = liveSelector(original);
    if (selector === null) return;
    rule.selectorText = selector;
    // An invalid selector is ignored, the rule left as it was.
    if (rule.selectorText === original) {
      this.#rejected.add(rule);
      return;
    }
    // As the page wrote it, without what was rewritten of it before (it may have read it back and added to it).
    if (!this.#originals.has(rule)) this.#originals.set(rule, unwrapLiveSelector(original));
    this.#widen(rule.selectorText);
  }

  /** Takes note of how far an interaction rule restyles. */
  #widen(selector: string): void {
    if (HAS_SELECTOR.test(selector)) this.reach = "everywhere";
    else if (this.reach === "inside" && SIBLING_SELECTOR.test(selector)) this.reach = "siblings";
  }

  /**
   * The interaction rules of a copy (DocumentCss's, left as it is), rewritten,
   * in the blocks they are in (@media, @layer, ...). Only what the
   * interaction applies to is taken: the copy's other rules are the page's
   * already, and would win ties again from here.
   */
  #interactionRules(rules: CSSRuleList, interactive: boolean): string[] {
    const out: string[] = [];
    for (const rule of Array.from(rules)) {
      const text = this.#interactionRule(rule, interactive);
      if (text) out.push(text);
    }
    return out;
  }

  /** Whether any of these rules (or the rules in them) has a selector to rewrite. */
  #hasInteractionRules(rules: CSSRuleList | undefined): boolean {
    return Array.from(rules ?? []).some(
      (rule) =>
        ("selectorText" in rule && liveSelector((rule as CSSStyleRule).selectorText) !== null) ||
        ("cssRules" in rule && this.#hasInteractionRules((rule as CSSGroupingRule).cssRules)),
    );
  }

  /** A rule, or what of it is an interaction rule (`interactive`: inside one already); null if none. */
  #interactionRule(rule: CSSRule, interactive: boolean): string | null {
    const { CSSStyleRule } = this.#window;
    if (rule instanceof CSSStyleRule) {
      const selector = liveSelector(rule.selectorText);
      const inside = interactive || selector !== null;
      // Values the CSSOM lost: the block as written, when nothing in it has to be rewritten.
      const written = inside ? writtenBlockOf(rule) : null;
      if (written !== null && !this.#hasInteractionRules(rule.cssRules))
        return `${selector ?? rule.selectorText}{${written}}`;
      // Nested rules (CSS nesting): selectors rewritten one by one, the declarations left as they are.
      const nested = rule.cssRules ? this.#interactionRules(rule.cssRules, inside) : [];
      if (!inside && nested.length === 0) return null;
      // As written where the CSSOM lost some (declarationsOf): the copy is the page's only one that applies.
      const declarations = inside ? declarationsOf(rule) : "";
      return `${selector ?? rule.selectorText}{${declarations}${nested.join("\n")}}`;
    }
    if ("cssRules" in rule) {
      // @media, @supports, @layer, @container, @scope (not @keyframes: none of its rules is a style rule).
      const nested = this.#interactionRules(rule.cssRules as CSSRuleList, interactive);
      if (nested.length === 0) return null;
      const prelude = rule.cssText.slice(0, rule.cssText.indexOf("{"));
      return `${prelude}{${nested.join("\n")}}`;
    }
    // Declarations between nested rules (CSSNestedDeclarations).
    if (interactive && "style" in rule) return (rule as CSSStyleRule).style.cssText;
    return null;
  }

  /** Sets the agent's sheet to LIVE_PAGE_CSS and `copied` (the interaction rules of sheets the page cannot edit). */
  #adopt(copied: string): void {
    const adopted = this.#adoptedSheets();
    if (!adopted) return;
    const css = copied ? `${LIVE_PAGE_CSS}\n${copied}` : LIVE_PAGE_CSS;
    const current = this.#adopted;
    const sheet = current ?? new this.#window.CSSStyleSheet();
    agentSheets.add(sheet);
    // Replacing a sheet's rules restyles the whole document: only when they changed.
    if (css !== this.#adoptedCss || !current) sheet.replaceSync(css);
    this.#adoptedCss = css;
    this.#adopted = sheet;
    this.#keepAdopted(adopted);
  }

  /** Puts the agent's sheet back in `adopted` (the document's list), if the page replaced the list (adoptedStyleSheets = [...]). */
  #keepAdopted(adopted = this.#adoptedSheets()): void {
    const sheet = this.#adopted;
    if (!sheet || !adopted || adopted.includes(sheet)) return;
    const syncing = this.#syncing;
    this.#syncing = true;
    try {
      this.#setAdoptedSheets([...adopted, sheet]);
    } finally {
      this.#syncing = syncing;
    }
  }

  #unadopt(): void {
    const adopted = this.#adoptedSheets();
    const current = this.#adopted;
    if (current && adopted) this.#setAdoptedSheets(adopted.filter((sheet) => sheet !== current));
    this.#adopted = null;
    this.#adoptedCss = "";
  }
}
