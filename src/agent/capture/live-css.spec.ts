// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { pageStylesheets, parseInto } from "./css";
import { hasTransition, LiveInteractionCss } from "./live-css";

let live: LiveInteractionCss | null = null;

afterEach(() => {
  live?.dispose();
  live = null;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

const ROW = `<div class="row"><span class="tools"><button>Act</button></span></div>`;
const display = () => getComputedStyle(document.querySelector(".tools")!).display;
const selectors = (sheet = 0) =>
  Array.from(document.styleSheets[sheet]!.cssRules).map(
    (rule) => (rule as CSSStyleRule).selectorText,
  );

function setUp(css: string): void {
  document.head.innerHTML = `<style>${css}</style>`;
  document.body.innerHTML = ROW;
  live = new LiveInteractionCss(document);
  live.sync();
}

describe("LiveInteractionCss", () => {
  it("makes the page's :hover rules match the hover mark, in place", () => {
    setUp(".tools { display: none } .row:hover .tools { display: flex } .other { color: red }");
    expect(display()).toBe("none");
    document.querySelector(".row")!.setAttribute("data-thp-hover", "");
    expect(display()).toBe("flex");
    // The same rules, in the same order: only the interaction selector changed.
    expect(selectors()).toEqual([".tools", ".row:is(:hover,[data-thp-hover]) .tools", ".other"]);
  });

  it("takes in a rule the page inserts into an @media block", () => {
    setUp(".tools { display: none } @media all { .x { color: red } }");
    document.querySelector(".row")!.setAttribute("data-thp-hover", "");
    const media = document.styleSheets[0]!.cssRules[1] as CSSMediaRule;
    media.insertRule(".row:hover .tools { display: flex }", 1);
    expect(display()).toBe("flex");
  });

  it("tells when the page changes its stylesheets through the CSSOM, and only its own", () => {
    const changed = vi.fn();
    document.head.innerHTML = "<style>.tools { display: none }</style>";
    document.body.innerHTML = ROW;
    live = new LiveInteractionCss(document, undefined, changed);
    live.sync();
    document.styleSheets[0]!.insertRule(".x { color: red }", 1);
    document.styleSheets[0]!.deleteRule(1);
    expect(changed).toHaveBeenCalledTimes(2);
    // Not the page's: a sheet of its own that is not in the document (a shadow root's, say).
    const elsewhere = new CSSStyleSheet();
    elsewhere.insertRule(".row:hover .tools { display: flex }");
    elsewhere.replaceSync(".y { color: blue }");
    expect(changed).toHaveBeenCalledTimes(2);
    // A <style> disabled, which no attribute shows.
    document.querySelector("style")!.disabled = true;
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("notices a sheet the page pushes onto adoptedStyleSheets in place", () => {
    const adopted: CSSStyleSheet[] = [];
    Object.defineProperty(document, "adoptedStyleSheets", {
      configurable: true,
      get: () => adopted,
      set: (sheets: CSSStyleSheet[]) => adopted.splice(0, adopted.length, ...sheets),
    });
    try {
      document.body.innerHTML = ROW;
      live = new LiveInteractionCss(document);
      live.sync();
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(".row:hover .tools { display: flex }");
      adopted.push(sheet);
      expect(live.sync()).toBe(true);
      // There twice (allowed): a rule inserted into it is still taken care of at once.
      adopted.push(sheet);
      live.sync();
      sheet.insertRule(".row:hover .more { display: block }", 1);
      sheet.insertRule(".x { color: red }", 2);
      expect(live.sync()).toBe(false);
      expect((sheet.cssRules[0] as CSSStyleRule).selectorText).toBe(
        ".row:is(:hover,[data-thp-hover]) .tools",
      );
    } finally {
      delete (document as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
    }
  });

  it("wraps the CSSOM once, however many watch it, and puts it back when the last stops", () => {
    const method = () => Reflect.get(CSSStyleSheet.prototype, "insertRule") as unknown;
    const native = method();
    const first = new LiveInteractionCss(document);
    const wrapped = method();
    const second = new LiveInteractionCss(document);
    expect(method()).toBe(wrapped);
    // Stopped out of order.
    first.dispose();
    expect(method()).toBe(wrapped);
    second.dispose();
    expect(method()).toBe(native);
  });

  it("puts the CSSOM back when disposed, but not over a wrapper put there since", () => {
    // Read as values, compared by identity only (never called unbound).
    const method = () => Reflect.get(CSSStyleSheet.prototype, "insertRule") as unknown;
    const setter = () => Object.getOwnPropertyDescriptor(StyleSheet.prototype, "disabled")!;
    const native = setter();
    live = new LiveInteractionCss(document);
    const wrappedInsert = method();
    // A polyfill wrapping the setter after the agent did.
    const ours = setter();
    // oxlint-disable-next-line typescript/unbound-method -- called with Reflect.apply on the sheet
    const set = ours.set!;
    const theirs: PropertyDescriptor = {
      ...ours,
      set(this: StyleSheet, value: boolean) {
        Reflect.apply(set, this, [value]);
      },
    };
    Object.defineProperty(StyleSheet.prototype, "disabled", theirs);
    try {
      live.dispose();
      live = null;
      expect(method()).not.toBe(wrappedInsert);
      expect(setter()).toEqual(theirs);
    } finally {
      Object.defineProperty(StyleSheet.prototype, "disabled", native);
    }
  });

  it("lets the page's selector queries see the marks, as its stylesheets do", () => {
    setUp(".tools { display: none }");
    const row = document.querySelector(".row")!;
    const button = document.querySelector("button")!;
    expect(row.matches(":hover")).toBe(false);
    row.setAttribute("data-thp-hover", "");
    button.setAttribute("data-thp-focus", "");
    expect(row.matches(":hover")).toBe(true);
    expect(button.closest(".row:hover")).toBe(row);
    expect(document.querySelector(":focus")).toBe(button);
    expect(row.querySelectorAll(":hover, :focus")).toHaveLength(1);
    // An attribute's value is left as it is.
    button.setAttribute("data-tip", ":hover to see");
    expect(document.querySelector('[data-tip=":hover to see"]')).toBe(button);
    // Put back when it stops.
    live!.dispose();
    live = null;
    expect(row.matches(":hover")).toBe(false);
  });

  it("tells how far the page's hover rules reach: inside, later siblings, or anywhere", () => {
    setUp(".row:hover .tools { display: flex }");
    expect(live!.reach).toBe("inside");
    document.styleSheets[0]!.insertRule(".row:hover ~ .other { color: red }", 1);
    expect(live!.reach).toBe("siblings");
    document.styleSheets[0]!.insertRule("body:has(.row:hover) .bar { color: red }", 2);
    expect(live!.reach).toBe("everywhere");
  });

  it("tells whether the page has transitions, from a custom property too", () => {
    setUp(".row:hover .tools { display: flex }");
    expect(live!.hasTransitions).toBe(false);
    document.styleSheets[0]!.insertRule(".tools { transition: opacity var(--duration) }", 0);
    expect(live!.hasTransitions).toBe(true);
    const style = (css: string) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`a { ${css} }`);
      return (sheet.cssRules[0] as CSSStyleRule).style;
    };
    expect(hasTransition(style("transition: transform 0.3s"))).toBe(true);
    expect(hasTransition(style("transition: none"))).toBe(false);
    expect(hasTransition(style("transition-duration: 0s"))).toBe(false);
  });

  it("rewrites a selector the page sets on a rule itself", () => {
    setUp(".tools { display: none } .x { color: red }");
    const rule = document.styleSheets[0]!.cssRules[1] as CSSStyleRule;
    rule.selectorText = ".row:hover .tools";
    expect(rule.selectorText).toBe(".row:is(:hover,[data-thp-hover]) .tools");
    // Put back as the page set it, not as it was first.
    live!.dispose();
    live = null;
    expect(rule.selectorText).toBe(".row:hover .tools");
  });

  it("keeps the page's own selector when it writes back what it read, or adds to it", () => {
    setUp(".row:hover .tools { display: flex }");
    const rule = document.styleSheets[0]!.cssRules[0] as CSSStyleRule;
    // A round trip, as a CSS tool might do: read, then written back.
    const read = rule.selectorText;
    rule.selectorText = read;
    rule.selectorText = `${rule.selectorText}, .card:hover .menu`;
    expect(rule.selectorText).toBe(
      ".row:is(:hover,[data-thp-hover]) .tools, .card:is(:hover,[data-thp-hover]) .menu",
    );
    live!.dispose();
    live = null;
    expect(rule.selectorText).toBe(".row:hover .tools, .card:hover .menu");
  });

  it("forgets a rule the page deletes, without looking at all the rules again", () => {
    setUp(".tools { display: none } .row:hover .tools { display: flex }");
    const sheet = document.styleSheets[0]!;
    const rule = sheet.cssRules[1] as CSSStyleRule;
    sheet.deleteRule(1);
    expect(live!.sync()).toBe(false);
    live!.dispose();
    live = null;
    // Not written back into the rule the page dropped.
    expect(rule.selectorText).toBe(".row:is(:hover,[data-thp-hover]) .tools");
  });

  it("rewrites rules in @media blocks, and each rule only once", () => {
    setUp("@media all { .row:focus-within .tools { display: flex } }");
    live!.sync();
    live!.reset();
    live!.sync();
    const media = document.styleSheets[0]!.cssRules[0] as CSSMediaRule;
    expect((media.cssRules[0] as CSSStyleRule).selectorText).toBe(
      ".row:is(:focus-within,[data-thp-focus-within]) .tools",
    );
  });

  it("takes in rules and stylesheets the page adds later", () => {
    setUp(".tools { display: none }");
    const row = document.querySelector(".row")!;
    row.setAttribute("data-thp-hover", "");
    // Nothing changed: nothing read again.
    expect(live!.sync()).toBe(false);
    // Through the CSSOM, which no MutationObserver sees: that rule is rewritten
    // right away, and the others are not looked at again.
    document.styleSheets[0]!.insertRule(".row:hover .tools { display: flex }", 1);
    expect(display()).toBe("flex");
    expect(live!.sync()).toBe(false);

    const style = document.createElement("style");
    style.textContent = ".row:hover .tools { display: grid }";
    document.head.append(style);
    live!.invalidate();
    live!.sync();
    expect(display()).toBe("grid");
    // The page's <style> replaced by one with as many rules.
    style.textContent = ".row:hover .tools { display: block }";
    live!.invalidate();
    live!.sync();
    expect(display()).toBe("block");
  });

  it("rewrites the other selectors of a list with an interaction after a pseudo-element", () => {
    setUp(
      ".tools { display: none } .row:hover .tools, .bar::-webkit-scrollbar-thumb:hover { display: flex }",
    );
    // (jsdom cannot match a list with that pseudo-element at all.)
    expect(selectors()[1]).toBe(
      ".row:is(:hover,[data-thp-hover]) .tools, .bar::-webkit-scrollbar-thumb:hover",
    );
  });

  it("copies the interaction rules of a sheet the page cannot read into a sheet of its own", () => {
    // jsdom has no adoptedStyleSheets; the browsers do.
    Object.defineProperty(document, "adoptedStyleSheets", {
      configurable: true,
      writable: true,
      value: [],
    });
    try {
      document.head.innerHTML = "<style>.tools { display: none }</style>";
      document.body.innerHTML = ROW;
      // What DocumentCss fetched with CORS, standing in for the unreadable sheet.
      const copy = new CSSStyleSheet();
      copy.replaceSync(
        "@media all { .row:hover .tools { display: flex } } .plain { color: red }" +
          " @layer ui { .menu:focus-within .list { display: block } }" +
          ' .tip { content: "use :hover"; color: gray; &:hover { opacity: 1 } }',
      );
      live = new LiveInteractionCss(document, (sheet) =>
        sheet === document.styleSheets[0] ? copy : null,
      );
      live.sync();
      const adopted = (document as unknown as { adoptedStyleSheets: CSSStyleSheet[] })
        .adoptedStyleSheets;
      expect(adopted).toHaveLength(1);
      // Its rules are not walked: counted as having transitions.
      expect(live.hasTransitions).toBe(true);
      const css = Array.from(adopted[0]!.cssRules, (rule) => rule.cssText).join(" ");
      // Text autosizing stays off along with them.
      expect(css).toContain("text-size-adjust");
      expect(css).toContain(".row:is(:hover,[data-thp-hover]) .tools");
      expect(css).not.toContain(".plain");
      // In the block it is in, whatever block that is.
      expect(css).toMatch(
        /@layer ui\s*\{\s*\.menu:is\(:focus-within,\[data-thp-focus-within\]\) \.list/,
      );
      // A nested rule's selector, not the declarations' text; and not its parent's own declarations.
      expect(css).toContain("&:is(:hover,[data-thp-hover])");
      expect(css).not.toContain("use :is(");
      expect(css).not.toContain("gray");
      // Looked at again with nothing changed: the agent's sheet is not replaced (that restyles everything).
      const replace = vi.spyOn(adopted[0]!, "replaceSync");
      live.reset();
      live.sync();
      expect(replace).not.toHaveBeenCalled();
      // The copy is DocumentCss's, for the image: left as it was.
      const media = copy.cssRules[0] as CSSMediaRule;
      expect((media.cssRules[0] as CSSStyleRule).selectorText).toBe(".row:hover .tools");
      live.dispose();
      live = null;
      expect(
        (document as unknown as { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets,
      ).toHaveLength(0);
    } finally {
      delete (document as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
    }
  });

  it("copies an interaction rule whose values the CSSOM lost as the sheet wrote it", () => {
    Object.defineProperty(document, "adoptedStyleSheets", {
      configurable: true,
      writable: true,
      value: [],
    });
    try {
      document.head.innerHTML = "<style>.tools { display: none }</style>";
      document.body.innerHTML = ROW;
      const text =
        ".row:hover .tools { .icon { color: red } border: 1px solid var(--c); border-top-color: red }" +
        " .tip:hover { border: 2px solid var(--c); .x:focus { color: blue } }";
      const copy = new CSSStyleSheet();
      parseInto(copy, text);
      // As browsers have them: the shorthand's longhands lost (jsdom keeps them).
      for (const rule of Array.from(copy.cssRules) as CSSStyleRule[]) {
        const style = rule.style;
        Object.defineProperty(style, "length", { value: 1 });
        Object.defineProperty(style, "item", { value: () => "border-top-style" });
        Object.defineProperty(style, "getPropertyValue", { value: () => "" });
        Object.defineProperty(style, "cssText", { value: "border-top-style: ;" });
      }
      live = new LiveInteractionCss(document, (sheet) =>
        sheet === document.styleSheets[0] ? copy : null,
      );
      live.sync();
      const adopted = (document as unknown as { adoptedStyleSheets: CSSStyleSheet[] })
        .adoptedStyleSheets;
      const css = Array.from(adopted[0]!.cssRules, (rule) => rule.cssText).join(" ");
      expect(css).toContain(".row:is(:hover,[data-thp-hover]) .tools");
      expect(css).toContain("var(--c)");
      // A nested rule to rewrite: the CSSOM's rules, rewritten one by one (what it lost, lost).
      expect(css).toContain(".x:is(:focus,[data-thp-focus])");
      expect(css).not.toContain("2px");
      live.dispose();
      live = null;
    } finally {
      delete (document as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
    }
  });

  it("turns off text autosizing from the start, and keeps it off if the page replaces its adopted sheets", () => {
    const adopted: CSSStyleSheet[] = [];
    // On the prototype, as in browsers, where the agent hears the page set it.
    Object.defineProperty(Document.prototype, "adoptedStyleSheets", {
      configurable: true,
      get: () => adopted,
      set: (sheets: CSSStyleSheet[]) => adopted.splice(0, adopted.length, ...sheets),
    });
    try {
      document.body.innerHTML = ROW;
      // Before the page is laid out: no sync needed.
      live = new LiveInteractionCss(document);
      expect(adopted).toHaveLength(1);
      const agent = adopted[0]!;
      expect(Array.from(agent.cssRules, (rule) => rule.cssText).join(" ")).toContain(
        "text-size-adjust",
      );
      // Not one of the page's: left out of the image's CSS.
      expect(pageStylesheets(document)).not.toContain(agent);
      const own = new CSSStyleSheet();
      own.replaceSync(".x { color: red }");
      (document as unknown as { adoptedStyleSheets: CSSStyleSheet[] }).adoptedStyleSheets = [own];
      // The page reads back the list it set; the agent's sheet goes back on the next sync.
      expect(adopted).toEqual([own]);
      live.sync();
      expect(adopted).toEqual([own, agent]);
      live.dispose();
      live = null;
      expect(adopted).toEqual([own]);
    } finally {
      delete (Document.prototype as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
    }
  });

  it("rewrites a disabled sheet too, for when the page enables it", () => {
    document.head.innerHTML = `<style>.tools { display: none }</style><style>.row:hover .tools { display: flex }</style>`;
    document.body.innerHTML = ROW;
    document.styleSheets[1]!.disabled = true;
    live = new LiveInteractionCss(document);
    live.sync();
    // (jsdom applies disabled sheets anyway: the selector is checked instead.)
    expect(selectors(1)).toEqual([".row:is(:hover,[data-thp-hover]) .tools"]);
  });

  it("rewrites the page's own adopted stylesheets, and keeps its own sheet out of the page's", () => {
    const adopted: CSSStyleSheet[] = [];
    Object.defineProperty(document, "adoptedStyleSheets", {
      configurable: true,
      get: () => adopted,
      set: (sheets: CSSStyleSheet[]) => adopted.splice(0, adopted.length, ...sheets),
    });
    try {
      const own = new CSSStyleSheet();
      own.replaceSync(".tools { display: none } .row:hover .tools { display: flex }");
      adopted.push(own);
      document.body.innerHTML = ROW;
      live = new LiveInteractionCss(document);
      live.sync();
      expect((own.cssRules[1] as CSSStyleRule).selectorText).toBe(
        ".row:is(:hover,[data-thp-hover]) .tools",
      );
    } finally {
      delete (document as { adoptedStyleSheets?: unknown }).adoptedStyleSheets;
    }
  });

  it("forgets the rules of a <style> the page removed", () => {
    setUp(".row:hover .tools { display: flex }");
    const sheet = document.styleSheets[0]!;
    const rule = sheet.cssRules[0] as CSSStyleRule;
    document.head.innerHTML = "";
    live!.invalidate();
    live!.sync();
    live!.dispose();
    live = null;
    // Not written back into the sheet the page dropped.
    expect(rule.selectorText).toBe(".row:is(:hover,[data-thp-hover]) .tools");
  });

  it("puts the page's selectors back when disposed", () => {
    setUp(".row:hover .tools { display: flex }");
    live!.dispose();
    expect(selectors()).toEqual([".row:hover .tools"]);
  });
});
