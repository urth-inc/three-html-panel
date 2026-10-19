// Collects the page's CSS so that it can be embedded in the SVG snapshot.
//
// An SVG loaded as an image is rendered in its own, isolated document, so the
// page's stylesheets do not apply to it. They have to be copied in, with a few
// adjustments:
//
// - Interaction states (:hover, :active, :focus) depend on real input, which
//   the image never receives. The agent marks the elements with attributes
//   instead (interaction-marks.ts), and the selectors are rewritten to match
//   those attributes, as for the live page (live-css.ts, which has rewritten
//   most of them in place already).
// - :root would match the <svg>, not the copied <html>.
// - @media is evaluated again inside the image, against the image's own
//   environment. Only the rules that match in the page right now are kept.
// - Animations restart from 0s every time the image is decoded, so they are
//   stopped here. The snapshot bakes their values into inline styles.

import type { FrameWindow } from "../../types";

export const HOVER_ATTRIBUTE = "data-thp-hover";
export const ACTIVE_ATTRIBUTE = "data-thp-active";
export const FOCUS_ATTRIBUTE = "data-thp-focus";
export const FOCUS_WITHIN_ATTRIBUTE = "data-thp-focus-within";
/** Focus the browser would show (from keys, or in a text field), not every focus. */
export const FOCUS_VISIBLE_ATTRIBUTE = "data-thp-focus-visible";
/** An open popover, and a modal dialog: in the top layer, which the copy is not in (snapshot.ts marks them). */
export const POPOVER_OPEN_ATTRIBUTE = "data-thp-popover-open";
export const MODAL_ATTRIBUTE = "data-thp-modal";

const INTERACTION_ATTRIBUTE_OF: Record<string, string> = {
  hover: HOVER_ATTRIBUTE,
  active: ACTIVE_ATTRIBUTE,
  "focus-visible": FOCUS_VISIBLE_ATTRIBUTE,
  "focus-within": FOCUS_WITHIN_ATTRIBUTE,
  focus: FOCUS_ATTRIBUTE,
  "popover-open": POPOVER_OPEN_ATTRIBUTE,
  modal: MODAL_ATTRIBUTE,
};

export const INTERACTION_ATTRIBUTES: ReadonlySet<string> = new Set(
  Object.values(INTERACTION_ATTRIBUTE_OF),
);

// A pseudo-class followed by something other than a name character, so that
// :focus does not also match :focus-visible.
const INTERACTION_PSEUDO_CLASS =
  /:(hover|active|focus-visible|focus-within|focus|popover-open|modal)(?![-\w])/g;
const ROOT_PSEUDO_CLASS = /:root(?![-\w])/g;

/**
 * Whether the compound selector that ends at `end` has a pseudo-element in it
 * (`::-webkit-scrollbar-thumb:hover`, `::part(x):hover`). Only a few
 * pseudo-classes may follow one, not an attribute: those are left alone.
 */
function followsPseudoElement(selector: string, end: number): boolean {
  let depth = 0;
  for (let i = end - 1; i >= 0; i--) {
    const char = selector[i]!;
    if (char === ")" || char === "]") depth++;
    else if (char === "(" || char === "[") {
      if (depth === 0) return false;
      depth--;
    } else if (depth === 0) {
      if (char === ":" && selector[i - 1] === ":") return true;
      if (/[\s>+~,]/.test(char)) return false;
    }
  }
  return false;
}

/** Whether the pseudo-class at `start` to `end` is the one in a rewrite already: `:is(:hover,[data-thp-hover])`. */
const isWrapped = (selector: string, start: number, end: number) =>
  /:is\(\s*$/.test(selector.slice(Math.max(0, start - 8), start)) &&
  /^\s*,\s*\[data-thp-/.test(selector.slice(end, end + 16));

/**
 * Where in `selector` the text is not selector syntax: inside an attribute
 * selector (`[title=":hover"]`) or a string, or escaped (Tailwind's
 * `.md\:hover\:underline`). One flag per character.
 */
function quotedText(selector: string): boolean[] {
  const quoted: boolean[] = [];
  let quote = "";
  let brackets = 0;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]!;
    quoted.push(quote !== "" || brackets > 0);
    if (char === "\\") {
      // The character escaped is part of a name (or of the string).
      quoted.push(true);
      i++;
    } else if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[") brackets++;
    else if (char === "]" && brackets > 0) brackets--;
  }
  return quoted;
}

/**
 * Replaces the interaction pseudo-classes, but those inside an attribute
 * selector, a string or an escape (not pseudo-classes), those that follow a
 * pseudo-element, and those rewritten already (a selector the page read back
 * and added to, say).
 */
function replaceInteractionPseudoClasses(
  selector: string,
  replace: (match: string, attribute: string) => string,
): string {
  let quoted: boolean[] | null = null;
  return selector.replace(INTERACTION_PSEUDO_CLASS, (match, name: string, offset: number) => {
    // Only for selectors with a bracket, a quote or an escape at all: most have none.
    if (/["'[\\]/.test(selector)) quoted ??= quotedText(selector);
    return quoted?.[offset] ||
      followsPseudoElement(selector, offset) ||
      isWrapped(selector, offset, offset + match.length)
      ? match
      : replace(match, INTERACTION_ATTRIBUTE_OF[name]!);
  });
}

const LIVE_REWRITE =
  /:is\(\s*(:(?:hover|active|focus-visible|focus-within|focus|popover-open|modal))\s*,\s*\[data-thp-[\w-]+\]\s*\)/g;

/** The selector as the page wrote it: what liveSelector added taken out. */
export function unwrapLiveSelector(selector: string): string {
  return selector.replace(LIVE_REWRITE, "$1");
}

/**
 * The selector for the live page: each interaction pseudo-class also matches
 * its attribute, `:hover` becoming `:is(:hover,[data-thp-hover])`. The
 * specificity stays the same, and so does the rule's place in the cascade.
 * Null if there is nothing (more) to rewrite.
 */
export function liveSelector(selector: string): string | null {
  const rewritten = replaceInteractionPseudoClasses(
    selector,
    (match, attribute) => `:is(${match},[${attribute}])`,
  );
  return rewritten === selector ? null : rewritten;
}

/**
 * The selector for the image: as for the live page
 * (:hover never matches in an image, the attribute does), and :root is html.
 */
export function rewriteSelector(selector: string): string {
  const rooted = selector.replace(ROOT_PSEUDO_CLASS, "html");
  return liveSelector(rooted) ?? rooted;
}

// Browsers draw a focus ring for text fields from their own user agent
// stylesheet, which is not in document.styleSheets. This stands in for it with
// zero specificity, so any rule the page writes about the outline wins. Only
// where the focus shows (:focus-visible): not a <select> pressed with a mouse.
const DEFAULT_FOCUS_RING_CSS =
  `:where(input[${FOCUS_VISIBLE_ATTRIBUTE}], textarea[${FOCUS_VISIBLE_ATTRIBUTE}], select[${FOCUS_VISIBLE_ATTRIBUTE}])` +
  `{outline:2px solid #3b82f6;outline-offset:1px}`;

export const FREEZE_ANIMATIONS_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important}";

const URL_PATTERN = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;

/** Properties a style rule sets that its CSSOM has lost (see lostProperties), and the elements it is for. */
export interface LostDeclarations {
  selector: string;
  properties: string[];
}

/**
 * The properties a rule's declarations set whose values the CSSOM has lost. A
 * shorthand with var() in it is kept whole (to be substituted when computed),
 * and only while each of its longhands still has it: once a later declaration
 * in the rule sets one of them (`border: … var(--a); border-top-color: red`),
 * every browser gives the others as "" (`border-top-style: ;` in cssText). The
 * value is then nowhere but in the computed style of the elements.
 */
export function lostProperties(style: CSSStyleDeclaration): string[] {
  const lost: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const property = style.item(i);
    if (!property.startsWith("--") && style.getPropertyValue(property) === "") lost.push(property);
  }
  return lost;
}

/**
 * The blocks of style rules parsed from a fetched stylesheet's text (see
 * DocumentCss.readable) whose values the CSSOM lost (lostProperties), as
 * written between their braces: lossless where the CSSOM is not.
 */
const sourceBlocks = new WeakMap<CSSRule, string>();

/** Whether a rule lost values in its own declarations, or in those between its nested rules (CSSNestedDeclarations). */
function lostOwn(rule: CSSRule): boolean {
  return (
    ("style" in rule && lostProperties((rule as CSSStyleRule).style).length > 0) ||
    Array.from((rule as Partial<CSSStyleRule>).cssRules ?? []).some(
      (inner) => !("selectorText" in inner) && lostOwn(inner),
    )
  );
}

/** Whether a rule, or any rule in it, lost values. */
const lostAnywhere = (rule: CSSRule): boolean =>
  lostOwn(rule) || Array.from((rule as Partial<CSSGroupingRule>).cssRules ?? []).some(lostAnywhere);

/**
 * A style rule's block as the stylesheet wrote it (its declarations and nested
 * rules), if the CSSOM lost some of its values and the text is known; null otherwise.
 */
export function writtenBlockOf(rule: CSSStyleRule): string | null {
  return sourceBlocks.get(rule) ?? null;
}

/**
 * A style rule's declarations as text: as the CSSOM gives them, or, if it lost
 * some (lostProperties), as the stylesheet wrote them where that is known (a
 * rule without nested rules, whose block is its declarations).
 */
export function declarationsOf(rule: CSSRule & { style: CSSStyleDeclaration }): string {
  if ((rule as Partial<CSSStyleRule>).cssRules?.length) return rule.style.cssText;
  return writtenBlockOf(rule as CSSStyleRule) ?? rule.style.cssText;
}

/**
 * Splits CSS text at the end of each top-level statement (a rule with its
 * block, or an at-rule ending with ";"), skipping comments, strings and
 * unquoted url()s. Each part's block, if any, starts at `open` (its "{").
 * Only to find the text of rules: the browser's parser decides what they are.
 */
export function splitStatements(text: string): { text: string; open: number }[] {
  const out: { text: string; open: number }[] = [];
  let start = 0;
  let depth = 0;
  let open = -1;
  const end = (at: number) => {
    const part = text.slice(start, at);
    const trimmed = part.trimStart();
    if (trimmed)
      out.push({
        text: trimmed,
        open: open < 0 ? -1 : open - start - (part.length - trimmed.length),
      });
    start = at;
    open = -1;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 1;
    } else if (char === '"' || char === "'") {
      for (i++; i < text.length && text[i] !== char && text[i] !== "\n"; i++)
        if (text[i] === "\\") i++;
    } else if (char === "\\") {
      i++;
    } else if (
      (char === "u" || char === "U") &&
      !/[\w-]/.test(text[i - 1] ?? "") &&
      /^url\(\s*[^\s"')]/i.test(text.slice(i, i + 6))
    ) {
      const close = text.indexOf(")", i);
      i = close < 0 ? text.length : close;
    } else if (char === "{") {
      if (depth++ === 0) open = i;
    } else if (char === "}") {
      if (depth > 0 && --depth === 0) end(i + 1);
    } else if (char === ";" && depth === 0) {
      end(i + 1);
    }
  }
  end(text.length);
  return out;
}

/** A style rule, checked by shape (the sheet may be another realm's). */
const isStyleRule = (rule: CSSRule | undefined): rule is CSSStyleRule =>
  !!rule && "selectorText" in rule && "style" in rule;

/**
 * Parses CSS text into `sheet` (replaceSync, which leaves out @import), and
 * keeps the blocks of the style rules whose values the CSSOM lost as written
 * (see writtenBlockOf): at the top level, in blocks of rules (@media,
 * @supports, @layer…, where hover rules often are) and nested in other style
 * rules (`&:hover`).
 */
export function parseInto(sheet: CSSStyleSheet, text: string): void {
  sheet.replaceSync(text);
  keepWrittenBlocks(sheet.cssRules, text, () => new (sheet.constructor as typeof CSSStyleSheet)());
}

/**
 * Keeps the written blocks of those of `rules` (the parse of `text`) that lost
 * values, and looks into those with rules in them that did. A rule's text is
 * found by parsing each statement alone: the rule it makes has the same text
 * as the sheet's. That text is the CSSOM's, lossy itself: rules that differ
 * only in what was lost have the same. So a text is taken only where as many
 * statements make it as the sheet has rules with it. Where they differ, the
 * browser's parser dropped one the statement split kept (after a stray
 * token), and which is which is not known: those rules are left as the CSSOM
 * has them (the copy takes their values from the computed style).
 */
function keepWrittenBlocks(
  rules: CSSRuleList,
  text: string,
  newScratch: () => CSSStyleSheet,
  scratch: { sheet?: CSSStyleSheet } = {},
): void {
  const lossy = Array.from(rules).filter(
    (rule) => (isStyleRule(rule) || "cssRules" in rule) && lostAnywhere(rule),
  );
  // Most sheets: nothing to parse again.
  if (lossy.length === 0) return;
  const wanted = new Map<string, number>();
  for (const rule of lossy) wanted.set(rule.cssText, (wanted.get(rule.cssText) ?? 0) + 1);
  const written = new Map<string, string[]>();
  for (const { text: statement, open } of splitStatements(text)) {
    // A value is lost only with var() in it.
    if (open < 0 || !statement.includes("var(")) continue;
    const sheet = (scratch.sheet ??= newScratch());
    sheet.replaceSync(statement);
    const rule = sheet.cssRules[0];
    if (sheet.cssRules.length !== 1 || !rule || !wanted.has(rule.cssText)) continue;
    const close = statement.lastIndexOf("}");
    const block = statement.slice(open + 1, close > open ? close : undefined);
    const blocks = written.get(rule.cssText);
    if (blocks) blocks.push(block);
    else written.set(rule.cssText, [block]);
  }
  for (const rule of lossy) {
    const blocks = written.get(rule.cssText);
    // Taken in order (the parser keeps the statements' order), and only where the counts agree.
    if (!blocks || blocks.length !== wanted.get(rule.cssText)) continue;
    const block = blocks.shift()!;
    wanted.set(rule.cssText, blocks.length);
    if (isStyleRule(rule) && lostOwn(rule)) sourceBlocks.set(rule, block);
    const inner = (rule as Partial<CSSGroupingRule>).cssRules;
    if (inner?.length) keepWrittenBlocks(inner, block, newScratch, scratch);
  }
}

/** The selectors of a selector list, split at its top-level commas. */
export function splitSelectorList(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]!;
    if (char === "\\") i++;
    else if (char === '"' || char === "'") {
      for (i++; i < selector.length && selector[i] !== char; i++) if (selector[i] === "\\") i++;
    } else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      out.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(selector.slice(start).trim());
  return out.filter(Boolean);
}

/** The selector of a nested style rule (`&` or a descendant of its parent's), as a top-level one. */
export function nestedSelector(parent: string | null, selector: string): string {
  if (parent === null) return selector;
  return selector.includes("&")
    ? selector.replaceAll("&", `:is(${parent})`)
    : `:is(${parent}) :is(${selector})`;
}

/**
 * Replaces url(...) references, made absolute against `baseUrl`, with what
 * `resolve` returns for them (e.g. a data URL), or `none`.
 */
export function inlineCssUrls(
  css: string,
  baseUrl: string,
  resolve: (url: string) => string | null,
): string {
  return css.replace(URL_PATTERN, (_match, _quote: string, raw: string) => {
    if (raw.startsWith("data:")) return `url("${raw}")`;
    let absolute: string;
    try {
      absolute = new URL(raw, baseUrl).href;
    } catch {
      return "none";
    }
    const inlined = resolve(absolute);
    return inlined ? `url("${inlined}")` : "none";
  });
}

/** Makes relative url() in a linked stylesheet absolute (they are relative to the stylesheet). */
export const absolutizeUrls = (css: string, sheetUrl: string) =>
  inlineCssUrls(css, sheetUrl, (url) => url);

/**
 * A rule as collected: kept as it is (a string), or kept only while the page
 * uses it (see DocumentCss's `prune`): a style rule while its `test` selector
 * matches an element, an @font-face while its `face` is not left unloaded. A
 * block (@media's rules are inlined; @layer, @container…) holds pieces too.
 */
type CssPiece =
  | string
  | { css: string; test: string }
  | { css: string; face: string }
  | { open: string; pieces: CssPiece[] };

const isNamespace = (piece: CssPiece) =>
  typeof piece === "string" && piece.startsWith("@namespace");

/** The piece with `map` applied to its CSS text (and to its blocks'). */
function mapCss(piece: CssPiece, map: (css: string) => string): CssPiece {
  if (typeof piece === "string") return map(piece);
  if ("pieces" in piece)
    return { open: map(piece.open), pieces: piece.pieces.map((inner) => mapCss(inner, map)) };
  return { ...piece, css: map(piece.css) };
}

/** The piece's CSS, without the rules `keep` says are not used (null if nothing is left of it). */
function renderPiece(piece: CssPiece, keep: (piece: CssPiece) => boolean): string | null {
  if (typeof piece === "string") return piece;
  if (!("pieces" in piece)) return keep(piece) ? piece.css : null;
  const inner = piece.pieces.map((rule) => renderPiece(rule, keep)).filter((css) => css !== null);
  // A block all of whose rules went: no block either.
  if (piece.pieces.length > 0 && inner.length === 0) return null;
  return `${piece.open}\n${inner.join("\n")}\n}`;
}

/**
 * A sheet's rules in the cascade layers it was imported into (outermost
 * first, "" for an anonymous one), as on the page: its @namespace rules stay
 * first, outside them (they cannot be in one).
 */
function inLayers(rules: CssPiece[], layers: readonly string[]): CssPiece[] {
  if (layers.length === 0) return rules;
  let layered = rules.filter((rule) => !isNamespace(rule));
  for (const layer of [...layers].reverse())
    layered = [{ open: `@layer ${layer ? `${layer} ` : ""}{`, pieces: layered }];
  return [...rules.filter(isNamespace), ...layered];
}

// A :not() (with one level of parentheses inside), and an interaction state in one.
const NOT_PSEUDO_CLASS = /:not\((?:[^()]|\([^()]*\))*\)/g;
const INTERACTION_IN =
  /:(hover|active|focus-visible|focus-within|focus|popover-open|modal)(?![-\w])/;
// Pseudo-elements, and the legacy one-colon forms of the first four.
const PSEUDO_ELEMENT = /::[-\w]+(?:\([^)]*\))?|:(?:before|after|first-line|first-letter)(?![-\w])/g;

/**
 * The selector to find out whether a style rule is used: one that matches at
 * least the elements the rule styles. Its pseudo-elements go (an element that
 * has one matches without), and so do its interaction states, so that hovering
 * changes no answer (a :not() with one in it goes whole). Null when nothing
 * is left to look for (`::selection`): such a rule is always kept, and so is
 * one whose selector the page's browser does not take (see DocumentCss's prune).
 */
export function usedRuleTest(selector: string): string | null {
  const plain = unwrapLiveSelector(selector)
    .replace(PSEUDO_ELEMENT, "")
    // Taking a state out of a :not() would match fewer elements: the whole :not() goes.
    .replace(NOT_PSEUDO_CLASS, (not) => (INTERACTION_IN.test(not) ? "" : not));
  const test = replaceInteractionPseudoClasses(plain, () => "").trim();
  return test === "" ? null : test;
}

/** The classes and ids a selector's elements must have. */
export interface RequiredNames {
  classes: string[];
  ids: string[];
}

const NAME = /^[-\w\u00a0-\uffff]+/;

/**
 * For each selector of a list, the classes and ids its elements must have:
 * those outside parentheses (`:is()`, `:not()`, `:has()`…) and brackets. A
 * page that has none of an element with one of them has nothing the selector
 * matches, without looking. Null for a selector with an escape (`.md\:flex`),
 * whose names are not read here.
 */
export function requiredNames(selector: string): RequiredNames[] | null {
  if (selector.includes("\\")) return null;
  return splitSelectorList(selector).map((part) => {
    const names: RequiredNames = { classes: [], ids: [] };
    let depth = 0;
    for (let i = 0; i < part.length; i++) {
      const char = part[i]!;
      if (char === "(" || char === "[") depth++;
      else if (char === ")" || char === "]") depth--;
      else if (depth === 0 && (char === "." || char === "#")) {
        const name = NAME.exec(part.slice(i + 1))?.[0];
        if (!name) continue;
        (char === "." ? names.classes : names.ids).push(name);
        i += name.length;
      }
    }
    return names;
  });
}

const unquote = (family: string) =>
  family
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .toLowerCase();

/** What tells a font face from the others, as FontFace has it: the same for an @font-face rule and its FontFace. */
const faceKey = (face: FontFace) =>
  [unquote(face.family), face.style, face.weight, face.stretch, face.unicodeRange].join("|");

/** The faceKey of an @font-face rule (through a FontFace, which writes its descriptors the same way), or null. */
function fontFaceRuleKey(window: FrameWindow, rule: CSSRule & { style: CSSStyleDeclaration }) {
  const descriptor = (name: string) => rule.style.getPropertyValue(name) || undefined;
  const family = rule.style.getPropertyValue("font-family");
  if (!family || typeof window.FontFace !== "function") return null;
  try {
    return faceKey(
      new window.FontFace(unquote(family), "local(none)", {
        style: descriptor("font-style"),
        weight: descriptor("font-weight"),
        stretch: descriptor("font-stretch"),
        unicodeRange: descriptor("unicode-range"),
      }),
    );
  } catch {
    return null;
  }
}

/**
 * Stylesheets whose rules the page's script may not read (cross-origin,
 * without CORS). That does not change, and finding out throws: checked once.
 * A sheet still loading throws too (InvalidAccessError), but not for good.
 */
const unreadable = new WeakSet<CSSStyleSheet>();

/** How many rules a stylesheet has, or -1 if they cannot be read. */
export function ruleCount(sheet: CSSStyleSheet): number {
  if (unreadable.has(sheet)) return -1;
  try {
    return sheet.cssRules.length;
  } catch (error) {
    if ((error as Error).name === "SecurityError") unreadable.add(sheet);
    return -1;
  }
}

const sheetIds = new WeakMap<CSSStyleSheet, number>();
let nextSheetId = 0;

/** The agent's own sheets in document.adoptedStyleSheets (live-css.ts): not the page's. */
export const agentSheets = new WeakSet<CSSStyleSheet>();

/** The page's stylesheets, in cascade order: its <style> and <link> sheets, then those it adopted. */
export function pageStylesheets(document: Document): CSSStyleSheet[] {
  const adopted = (document as Document & { adoptedStyleSheets?: CSSStyleSheet[] })
    .adoptedStyleSheets;
  const sheets = Array.from(document.styleSheets);
  return adopted ? [...sheets, ...adopted.filter((sheet) => !agentSheets.has(sheet))] : sheets;
}

/** A stylesheet's own part of the signature: which it is, how many rules it has, whether it is disabled. */
export function sheetSignature(sheet: CSSStyleSheet): string {
  let id = sheetIds.get(sheet);
  if (id === undefined) {
    id = nextSheetId++;
    sheetIds.set(sheet, id);
  }
  return `${id}:${ruleCount(sheet)}${sheet.disabled ? "d" : ""}`;
}

/**
 * The parts of the signature: each stylesheet's own (sheetSignature), each
 * followed by those of the sheets it imports, which load after it ("-" for one
 * not loaded yet). Each sheet has its own part, so that a change to one can be
 * accounted for without hiding what else changed.
 */
export function signatureParts(sheets: CSSStyleSheet[]): [CSSStyleSheet | null, string][] {
  const parts: [CSSStyleSheet | null, string][] = [];
  const add = (sheet: CSSStyleSheet) => {
    parts.push([sheet, sheetSignature(sheet)]);
    const count = ruleCount(sheet);
    // @import comes first in a sheet.
    for (let i = 0; i < count; i++) {
      const rule = sheet.cssRules[i]!;
      if ("styleSheet" in rule) {
        const imported = (rule as CSSImportRule).styleSheet;
        if (imported) add(imported);
        else parts.push([null, "-"]);
      } else if ("cssRules" in rule || !rule.cssText.startsWith("@layer")) {
        // Only @layer statements may come before an @import.
        break;
      }
    }
  };
  for (const sheet of sheets) add(sheet);
  return parts;
}

/**
 * What the page's stylesheets are: which (a <style> whose text is replaced
 * has a new sheet, with as many rules maybe), how many rules each has, whether
 * it is disabled, and the same of the sheets they import. From its parts
 * (signatureParts).
 */
export const stylesheetsSignature = (parts: [CSSStyleSheet | null, string][]) =>
  parts.map(([, part]) => part).join("|");

/**
 * Collects a document's CSS, recollecting only when its stylesheets or the
 * number of rules in them (or in the blocks and imported sheets in them)
 * change (see stylesheetsSignature). Editing an existing rule in place
 * (CSSStyleRule.style) is not noticed; call invalidate() for that.
 */
export class DocumentCss {
  /** Null until collected (a page without stylesheets has the signature ""). */
  #signature: string | null = null;
  /** The sheets as collected, their url() inlined: rendered as CSS by get(). */
  #sheets: CssPiece[][] = [];
  /** The CSS get() rendered last, and for what (the version it was given, and #fontsVersion). */
  #rendered: { key: string; css: readonly string[] } | null = null;
  /** Bumped when a font face finished loading: an @font-face may be used now. */
  #fontsVersion = 0;
  /**
   * The test selectors found to match: not looked for again until the sheets
   * change. Kept once an element no longer matches (a rule too many is harmless),
   * so that a change to the page looks only for the rules not used yet.
   */
  #matchedTests = new Set<string>();
  /** requiredNames of each test selector, read once. */
  readonly #names = new Map<string, RequiredNames[] | null>();
  #lost: LostDeclarations[] = [];
  /**
   * The lists of rules inside the sheets (of blocks, nested rules, imported
   * sheets) as they were collected, with how many rules each had: rules
   * inserted there change no sheet's own count.
   */
  #inner: { rules: CSSRuleList; length: number }[] = [];
  /**
   * Cross-origin stylesheets (a web font service, say) hide their rules from
   * script unless they were loaded with CORS. They are fetched again with CORS
   * and parsed here, keyed by URL.
   */
  readonly #fetched = new Map<string, CSSStyleSheet | "loading" | "failed">();
  readonly #window: FrameWindow;
  readonly #document: Document;
  readonly #resolveUrl: (url: string) => string | null;
  readonly #onChange: () => void;
  readonly #prune: boolean;
  readonly #onFontsLoaded: () => void;

  /**
   * With `prune`, get() leaves out the rules the page does not use: the style
   * rules whose selectors match no element, and the @font-face rules of faces
   * the page never loaded (a browser loads a face only for text that uses it).
   * Each frame's image has to parse and match all the CSS it is given, and a
   * framework's stylesheet is mostly rules for elements a page does not have.
   * `onFontsLoaded`: a face finished loading, so an @font-face may be used now.
   */
  constructor(
    document: Document,
    resolveUrl: (url: string) => string | null,
    onChange: () => void = () => {},
    {
      prune = false,
      onFontsLoaded = () => {},
    }: { prune?: boolean; onFontsLoaded?: () => void } = {},
  ) {
    this.#document = document;
    this.#resolveUrl = resolveUrl;
    this.#onChange = onChange;
    this.#prune = prune;
    this.#onFontsLoaded = onFontsLoaded;
    this.#window = document.defaultView as FrameWindow;
    if (prune) document.fonts?.addEventListener("loadingdone", this.#fontsLoaded);
  }

  readonly #fontsLoaded = () => {
    this.#fontsVersion++;
    this.#onFontsLoaded();
  };

  invalidate(): void {
    this.#signature = null;
  }

  dispose(): void {
    this.#document.fonts?.removeEventListener("loadingdone", this.#fontsLoaded);
  }

  /**
   * The CSS, as sheets: one for each of the page's (an @import'ed one before
   * the sheet importing it), as some rules only count in their own sheet
   * (@namespace, which must come first in it).
   *
   * Pruning (see the constructor), `version` says when which elements the
   * page's selectors match may have changed: the rules are looked for again
   * only then. Without it, every rule is kept.
   */
  get(version?: number): readonly string[] {
    const sheets = pageStylesheets(this.#document);
    const signature = stylesheetsSignature(signatureParts(sheets));
    const changedInside = this.#inner.some(({ rules, length }) => rules.length !== length);
    if (signature !== this.#signature || changedInside) {
      this.#inner = [];
      this.#lost = [];
      const out: CssPiece[][] = [[DEFAULT_FOCUS_RING_CSS]];
      for (const sheet of sheets) this.#serializeSheet(sheet, out);
      out.push([FREEZE_ANIMATIONS_CSS]);
      const inline = (css: string) => inlineCssUrls(css, this.#document.baseURI, this.#resolveUrl);
      // A namespace's url() is a name, not a file to inline.
      this.#sheets = out
        .filter((rules) => rules.length > 0)
        .map((rules) => rules.map((rule) => (isNamespace(rule) ? rule : mapCss(rule, inline))));
      this.#rendered = null;
      this.#matchedTests = new Set();
      this.#signature = signature;
    }
    const pruning = this.#prune && version !== undefined;
    const key = pruning ? `${version}:${this.#fontsVersion}` : "all";
    if (this.#rendered?.key !== key)
      this.#rendered = { key, css: this.#render(pruning ? this.#usedRules() : () => true) };
    return this.#rendered.css;
  }

  #render(keep: (piece: CssPiece) => boolean): readonly string[] {
    return this.#sheets.map((rules) => {
      const rest = rules
        .filter((rule) => !isNamespace(rule))
        .map((rule) => renderPiece(rule, keep))
        .filter((css) => css !== null);
      return [...(rules.filter(isNamespace) as string[]), rest.join("\n")].join("\n");
    });
  }

  /** Whether a rule is used now: its selector matches an element, its font face is not left unloaded. */
  #usedRules(): (piece: CssPiece) => boolean {
    const unmatched = new Set<string>();
    let present: { classes: Set<string>; ids: Set<string> } | null = null;
    // In quirks mode, classes and ids match whatever their case.
    const readNames = this.#document.compatMode !== "BackCompat";
    let loadedFaces: Map<string, boolean> | null = null;
    return (piece) => {
      if (typeof piece === "string" || "pieces" in piece) return true;
      if ("test" in piece) {
        const { test } = piece;
        if (this.#matchedTests.has(test)) return true;
        if (unmatched.has(test)) return false;
        let names = this.#names.get(test);
        if (names === undefined) this.#names.set(test, (names = requiredNames(test)));
        if (names && readNames) {
          present ??= this.#presentNames();
          const { classes, ids } = present;
          const impossible = names.every(
            (part) =>
              part.classes.some((name) => !classes.has(name)) ||
              part.ids.some((name) => !ids.has(name)),
          );
          if (impossible) {
            unmatched.add(test);
            return false;
          }
        }
        let used: boolean;
        try {
          used = this.#document.querySelector(test) !== null;
        } catch {
          // Not a selector this browser takes as it is: kept, to be safe.
          used = true;
        }
        if (used) this.#matchedTests.add(test);
        else unmatched.add(test);
        return used;
      }
      if (!loadedFaces) {
        loadedFaces = new Map();
        for (const face of this.#document.fonts ?? []) {
          const faceUsed = face.status !== "unloaded";
          loadedFaces.set(faceKey(face), (loadedFaces.get(faceKey(face)) ?? false) || faceUsed);
        }
      }
      // A face the page does not list (not loaded yet, say) is kept.
      return loadedFaces.get(piece.face) ?? true;
    };
  }

  /** The classes and ids of the page's elements (those document selectors match: not in shadow trees). */
  #presentNames(): { classes: Set<string>; ids: Set<string> } {
    const classes = new Set<string>();
    const ids = new Set<string>();
    for (const element of Array.from(this.#document.getElementsByTagName("*"))) {
      for (const name of Array.from(element.classList)) classes.add(name);
      if (element.id) ids.add(element.id);
    }
    return { classes, ids };
  }

  /**
   * The rules among those get() collected whose values the CSSOM lost (see
   * lostProperties): the copy takes them from the computed style.
   */
  get lost(): readonly LostDeclarations[] {
    return this.#lost;
  }

  /**
   * Adds a sheet's rules to `sheets`, as a sheet (after those it imports).
   * `layers` are the cascade layers it was imported into (`@import … layer()`,
   * "" for an anonymous one), outermost first: its rules go in them, as on the
   * page.
   */
  #serializeSheet(
    source: CSSStyleSheet,
    sheets: CssPiece[][],
    layers: string[] = [],
    imported = false,
  ): void {
    if (source.disabled) return;
    const sheet = this.readable(source);
    if (!sheet) return;
    // An imported sheet's rules count in no document sheet's (see get()).
    if (imported) this.#watch(sheet.cssRules);
    const all = Array.from(sheet.cssRules);
    // Its @import rules, and the @layer statements among them (which declare
    // layers in turn with the imported ones), come first: each becomes a sheet
    // of its own, before this one, in their order.
    const { CSSImportRule, CSSLayerStatementRule } = this.#window;
    let leading = 0;
    all.forEach((rule, index) => {
      if (rule instanceof CSSImportRule) leading = index + 1;
    });
    const rules: CssPiece[] = [];
    for (const rule of all.slice(0, leading)) {
      if (CSSLayerStatementRule && rule instanceof CSSLayerStatementRule)
        sheets.push(inLayers([rule.cssText], layers));
      else this.#serializeRules([rule], rules, sheets, layers);
    }
    this.#serializeRules(all.slice(leading), rules, sheets, layers);
    if (source.href) {
      const href = source.href;
      // A namespace's url() is a name, not a file.
      for (let i = 0; i < rules.length; i++)
        if (!isNamespace(rules[i]!))
          rules[i] = mapCss(rules[i]!, (css) => absolutizeUrls(css, href));
    }
    sheets.push(inLayers(rules, layers));
  }

  /** `parent`: the selector of the style rule these are nested in (as a top-level one), if any. */
  #serializeRules(
    rules: ArrayLike<CSSRule>,
    out: CssPiece[],
    sheets: CssPiece[][],
    layers: string[],
    parent: string | null = null,
  ): void {
    const {
      CSSStyleRule,
      CSSMediaRule,
      CSSSupportsRule,
      CSSImportRule,
      CSSKeyframesRule,
      CSSGroupingRule,
      CSSPageRule,
      CSSFontFaceRule,
      CSS,
    } = this.#window;
    for (const rule of Array.from(rules)) {
      // Rules inserted in a block later are noticed (see get()); not in every
      // style rule (each has a list, empty but for nested rules: too many).
      const block = (rule as Partial<CSSGroupingRule>).cssRules;
      if (block && (block.length > 0 || !(rule instanceof CSSStyleRule))) this.#watch(block);
      if (rule instanceof CSSStyleRule) {
        const selector = nestedSelector(parent, rule.selectorText);
        this.#noteLost(rule, selector);
        if (rule.cssRules.length === 0) {
          const css = `${rewriteSelector(rule.selectorText)}{${declarationsOf(rule)}}`;
          // A nested rule's selector is relative to its parent's: kept.
          const test = parent === null ? usedRuleTest(rule.selectorText) : null;
          out.push(test === null ? css : { css, test });
          continue;
        }
        // Nested rules (CSS nesting) are copied as the top level's, inside it.
        const inner: CssPiece[] = [];
        this.#serializeRules(rule.cssRules, inner, sheets, layers, selector);
        out.push({
          open: `${rewriteSelector(rule.selectorText)} {${rule.style.cssText}`,
          pieces: inner,
        });
      } else if (rule instanceof CSSMediaRule) {
        if (this.#window.matchMedia(rule.conditionText).matches)
          this.#serializeRules(rule.cssRules, out, sheets, layers, parent);
      } else if (rule instanceof CSSSupportsRule) {
        if (CSS.supports(rule.conditionText))
          this.#serializeRules(rule.cssRules, out, sheets, layers, parent);
      } else if (rule instanceof CSSImportRule) {
        const sheet = rule.styleSheet;
        // Its conditions: media, and supports() (newer browsers).
        const supports = (rule as { supportsText?: string | null }).supportsText;
        const layer = (rule as { layerName?: string | null }).layerName;
        if (
          sheet &&
          this.#window.matchMedia(rule.media.mediaText || "all").matches &&
          (!supports || CSS.supports(supports))
        )
          this.#serializeSheet(sheet, sheets, layer == null ? layers : [...layers, layer], true);
      } else if (rule instanceof CSSKeyframesRule) {
        // Animations are frozen, so keyframes are never used.
      } else if (
        CSSGroupingRule &&
        rule instanceof CSSGroupingRule &&
        // @page has declarations of its own (and no effect on screen).
        !(CSSPageRule && rule instanceof CSSPageRule)
      ) {
        // Other blocks of rules (@layer, @container, @scope…): their rules as
        // the top level's (interaction states, @media checked here), in them.
        const inner: CssPiece[] = [];
        this.#serializeRules(rule.cssRules, inner, sheets, layers, parent);
        const prelude = rule.cssText.slice(0, rule.cssText.indexOf("{")).trim();
        out.push({ open: `${rewriteSelector(prelude)} {`, pieces: inner });
      } else if (CSSFontFaceRule && rule instanceof CSSFontFaceRule) {
        const face = fontFaceRuleKey(this.#window, rule);
        out.push(face === null ? rule.cssText : { css: rule.cssText, face });
      } else {
        // Declarations between nested rules (CSSNestedDeclarations) are its parent's.
        if (parent !== null && "style" in rule) this.#noteLost(rule as CSSStyleRule, parent);
        out.push(rule.cssText);
      }
    }
  }

  /** Takes note of a rule whose values the CSSOM lost (unless its declarations are known as written). */
  #noteLost(rule: CSSRule & { style: CSSStyleDeclaration }, selector: string): void {
    // Copied as written (declarationsOf).
    if (declarationsOf(rule) !== rule.style.cssText) return;
    const properties = lostProperties(rule.style);
    if (properties.length > 0) this.#lost.push({ selector, properties });
  }

  #watch(rules: CSSRuleList): void {
    this.#inner.push({ rules, length: rules.length });
  }

  /**
   * The sheet itself if its rules can be read, or else a copy fetched with
   * CORS once it has loaded (null until then, or if it cannot be fetched).
   */
  readable(sheet: CSSStyleSheet): CSSStyleSheet | null {
    if (ruleCount(sheet) >= 0) return sheet;
    if (!sheet.href) return null;
    const href = sheet.href;
    const fetched = this.#fetched.get(href);
    if (fetched instanceof this.#window.CSSStyleSheet) return fetched;
    if (!fetched) {
      this.#fetched.set(href, "loading");
      fetch(href, { mode: "cors", credentials: "omit", headers: { Accept: "text/css,*/*;q=0.1" } })
        .then((response) =>
          response.ok ? response.text() : Promise.reject(new Error(String(response.status))),
        )
        .then((text) => {
          // Parse in the page's realm, so the rules pass the type checks above.
          const parsed = new this.#window.CSSStyleSheet();
          // Without @import, as replaceSync; enough for this purpose.
          parseInto(parsed, text);
          this.#fetched.set(href, parsed);
          this.invalidate();
          this.#onChange();
        })
        .catch(() => this.#fetched.set(href, "failed"));
    }
    return null;
  }
}
