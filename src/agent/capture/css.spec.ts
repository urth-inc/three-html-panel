import { describe, expect, it, vi } from "vite-plus/test";
import {
  inlineCssUrls,
  liveSelector,
  declarationsOf,
  lostProperties,
  nestedSelector,
  parseInto,
  splitSelectorList,
  splitStatements,
  rewriteSelector,
  signatureParts,
  stylesheetsSignature,
  unwrapLiveSelector,
  writtenBlockOf,
} from "./css";

describe("rewriteSelector", () => {
  it("maps :root to html, and rewrites as for the live page", () => {
    expect(rewriteSelector(":root")).toBe("html");
    expect(rewriteSelector(":root:hover")).toBe("html:is(:hover,[data-thp-hover])");
  });
});

describe("liveSelector", () => {
  it("lets each interaction pseudo-class also match its attribute", () => {
    expect(liveSelector(".row:hover .tools, a:active")).toBe(
      ".row:is(:hover,[data-thp-hover]) .tools, a:is(:active,[data-thp-active])",
    );
    expect(liveSelector("form:focus-within .hint, input:focus, input:focus-visible")).toBe(
      "form:is(:focus-within,[data-thp-focus-within]) .hint, input:is(:focus,[data-thp-focus]), input:is(:focus-visible,[data-thp-focus-visible])",
    );
    expect(liveSelector("li:not(:hover)")).toBe("li:not(:is(:hover,[data-thp-hover]))");
  });

  it("lets an open popover and a modal dialog match their attributes (the copy is not in the top layer)", () => {
    expect(liveSelector(".menu:popover-open, dialog:modal")).toBe(
      ".menu:is(:popover-open,[data-thp-popover-open]), dialog:is(:modal,[data-thp-modal])",
    );
  });

  it("leaves other pseudo-classes alone", () => {
    expect(liveSelector("li:hover-like, a:hovered, p:not(:first-child)")).toBeNull();
  });

  it("leaves an interaction after a pseudo-element, which neither :is() nor an attribute may follow", () => {
    expect(liveSelector(".row:hover .tools, .bar::-webkit-scrollbar-thumb:hover")).toBe(
      ".row:is(:hover,[data-thp-hover]) .tools, .bar::-webkit-scrollbar-thumb:hover",
    );
    expect(liveSelector("x-menu::part(item):hover")).toBeNull();
    // Not a pseudo-element: inside an attribute's value, or an argument.
    expect(liveSelector('[title="a::b"]:hover')).toBe('[title="a::b"]:is(:hover,[data-thp-hover])');
  });

  it("rewrites what was added to a selector rewritten already, and only that", () => {
    expect(liveSelector(".row:is(:hover, [data-thp-hover]) .tools, .card:hover .menu")).toBe(
      ".row:is(:hover, [data-thp-hover]) .tools, .card:is(:hover,[data-thp-hover]) .menu",
    );
    expect(liveSelector(liveSelector(".row:hover .tools")!)).toBeNull();
  });

  it("takes its rewrite out again, for the selector as the page wrote it", () => {
    const page = ".row:hover .tools, input:focus-visible, a:not(:active)";
    expect(unwrapLiveSelector(liveSelector(page)!)).toBe(page);
    // As browsers serialize it back, with a space.
    expect(unwrapLiveSelector(".row:is(:hover, [data-thp-hover]) .tools")).toBe(
      ".row:hover .tools",
    );
  });

  it("leaves the text of attribute selectors, strings and escapes, which is not a pseudo-class", () => {
    expect(liveSelector('[data-tip=":hover to see"]')).toBeNull();
    expect(liveSelector("[title=':active']:hover")).toBe(
      "[title=':active']:is(:hover,[data-thp-hover])",
    );
    // Tailwind's escaped class names.
    expect(liveSelector(".md\\:hover\\:underline:hover")).toBe(
      ".md\\:hover\\:underline:is(:hover,[data-thp-hover])",
    );
  });

  it("is null for selectors without them, or rewritten already", () => {
    expect(liveSelector("li:hover-like, p:first-child")).toBeNull();
    expect(liveSelector(".row:is(:hover, [data-thp-hover])")).toBeNull();
  });
});

describe("stylesheetsSignature", () => {
  /** A stand-in for a CSSStyleSheet: only what the signature reads. */
  const sheet = (rules: object[], disabled = false) =>
    ({ cssRules: rules, disabled }) as unknown as CSSStyleSheet;
  const rule = (cssText: string) => ({ cssText });

  it("changes when a sheet an @import loads gets its rules", () => {
    const importedRules: object[] = [];
    const imported = sheet(importedRules);
    const page = sheet([
      rule("@layer base;"),
      { cssText: "@import url(menu.css);", styleSheet: imported },
      rule(".a { color: red }"),
    ]);
    const before = stylesheetsSignature(signatureParts([page]));
    importedRules.push(rule(".nav:hover .sub { display: block }"));
    expect(stylesheetsSignature(signatureParts([page]))).not.toBe(before);
  });

  it("changes when a sheet is disabled or enabled", () => {
    const page = sheet([rule(".a { color: red }")]);
    const enabled = stylesheetsSignature(signatureParts([page]));
    (page as { disabled: boolean }).disabled = true;
    expect(stylesheetsSignature(signatureParts([page]))).not.toBe(enabled);
  });
});

describe("inlineCssUrls", () => {
  it("replaces resolvable urls and drops the rest", () => {
    const resolve = (url: string) =>
      url === "https://example.test/a.png" ? "data:image/png;base64,AA" : null;
    expect(
      inlineCssUrls(
        "a{background:url(a.png)} b{background:url('b.png')}",
        "https://example.test/",
        resolve,
      ),
    ).toBe('a{background:url("data:image/png;base64,AA")} b{background:none}');
  });

  it("keeps data urls", () => {
    expect(
      inlineCssUrls(
        'a{background:url("data:image/gif;base64,R0")}',
        "https://example.test/",
        () => null,
      ),
    ).toBe('a{background:url("data:image/gif;base64,R0")}');
  });
});

describe("lostProperties", () => {
  it("finds the longhands a var() shorthand left empty, not custom properties set empty", () => {
    // As browsers have `border: 3px solid var(--a); border-top-color: red; --b: ;`.
    const declarations: Record<string, string> = {
      width: "1px",
      "border-top-width": "",
      "border-top-style": "",
      "border-top-color": "red",
      "--b": "",
    };
    const names = Object.keys(declarations);
    const style = {
      length: names.length,
      item: (index: number) => names[index]!,
      getPropertyValue: (name: string) => declarations[name] ?? "",
    } as unknown as CSSStyleDeclaration;
    expect(lostProperties(style)).toEqual(["border-top-width", "border-top-style"]);
  });
});

describe("nestedSelector", () => {
  it("makes a nested rule's selector a top-level one", () => {
    expect(nestedSelector(null, ".a")).toBe(".a");
    expect(nestedSelector(".a, .b", "&:hover > i")).toBe(":is(.a, .b):hover > i");
    expect(nestedSelector(".a", ".c, .d")).toBe(":is(.a) :is(.c, .d)");
  });
});

describe("splitStatements", () => {
  it("splits at the end of each top-level rule, not inside blocks, strings, comments or url()s", () => {
    const css = `@import "a;b.css"; /* } ; */ .a{x:"}";y:url(a;b{.png)} @media all{.b{z:1}} @layer c;`;
    expect(splitStatements(css).map((part) => part.text)).toEqual([
      `@import "a;b.css";`,
      `/* } ; */ .a{x:"}";y:url(a;b{.png)}`,
      "@media all{.b{z:1}}",
      "@layer c;",
    ]);
    expect(splitStatements(" .a {x:1}")[0]!.open).toBe(3);
  });
});

describe("parseInto and declarationsOf", () => {
  /** Whether declarations lose values in the CSSOM, as browsers have it: a var() shorthand and a longhand over it. */
  const losesValues = (declarations: string) =>
    declarations.includes("var(") && /-(top|right|bottom|left)-color/.test(declarations);

  /**
   * Parses as browsers do here: `selector{…}` a style rule (with the rules
   * nested in it), `@media …{…}` a block of rules, other at-rules left out.
   * Text that is no rule (`color: red;` at the top) swallows the next rule,
   * as the parser takes it into that rule's prelude. A rule's text is lossy
   * as the CSSOM's is: rules that differ only in what they lost have the same.
   */
  function fakeRules(text: string): object[] {
    const rules: object[] = [];
    let swallow = false;
    for (const { text: statement, open } of splitStatements(text)) {
      if (open < 0) {
        if (!statement.startsWith("@")) swallow = true;
        continue;
      }
      if (swallow) {
        swallow = false;
        continue;
      }
      const prelude = statement.slice(0, open).trim();
      const block = statement.slice(open + 1, statement.lastIndexOf("}"));
      if (prelude.startsWith("@media")) {
        const cssRules = fakeRules(block);
        const inner = cssRules.map((rule) => (rule as { cssText: string }).cssText).join(" ");
        rules.push({ cssRules, cssText: `${prelude} { ${inner} }` });
        continue;
      }
      if (prelude.startsWith("@")) continue;
      const parts = splitStatements(block);
      const declarations = parts
        .filter((part) => part.open < 0)
        .map((part) => part.text)
        .join("");
      const cssRules = fakeRules(
        parts
          .filter((part) => part.open >= 0)
          .map((part) => part.text)
          .join(" "),
      );
      const lossy = losesValues(declarations);
      const names = lossy ? ["border-top-style"] : [];
      const own = lossy ? "border-top-style: ;" : declarations;
      const inner = cssRules.map((rule) => (rule as { cssText: string }).cssText).join(" ");
      rules.push({
        selectorText: prelude,
        cssText: `${prelude} { ${own} ${inner} }`,
        cssRules,
        style: {
          cssText: own,
          length: names.length,
          item: (index: number) => names[index],
          getPropertyValue: () => "",
        },
      });
    }
    return rules;
  }
  class FakeSheet {
    cssRules: object[] = [];
    replaceSync(text: string) {
      this.cssRules = fakeRules(text);
    }
  }
  const parse = (css: string) => {
    const sheet = new FakeSheet() as unknown as CSSStyleSheet;
    parseInto(sheet, css);
    return Array.from(sheet.cssRules) as CSSStyleRule[];
  };
  const LOSSY_A = "border: 1px solid var(--a); border-top-color: red";
  const LOSSY_B = "border: 2px solid var(--b); border-top-color: red";

  it("keeps a rule's declarations as written, used where the CSSOM lost some", () => {
    const [lossy, plain] = parse(`@import "x.css"; .a { ${LOSSY_A} } .b{color:red}`);
    expect(declarationsOf(lossy!)).toBe(` ${LOSSY_A} `);
    expect(declarationsOf(plain!)).toBe("color:red");
  });

  it("keeps those in blocks of rules too, where hover rules often are", () => {
    const [media] = parse(`@media (hover: hover) { .b:hover{color:red} .a:hover { ${LOSSY_A} } }`);
    const [plain, lossy] = Array.from(
      (media as unknown as CSSMediaRule).cssRules,
    ) as CSSStyleRule[];
    expect(declarationsOf(lossy!)).toBe(` ${LOSSY_A} `);
    expect(declarationsOf(plain!)).toBe("color:red");
  });

  it("keeps those nested in another style rule (&:hover)", () => {
    const [button] = parse(`.btn { color: red; &:hover { ${LOSSY_A} } }`);
    const [hover] = Array.from(button!.cssRules) as CSSStyleRule[];
    expect(declarationsOf(hover!)).toBe(` ${LOSSY_A} `);
    // It lost nothing itself.
    expect(writtenBlockOf(button!)).toBeNull();
  });

  it("gives each of two rules with the same text its own block, in order", () => {
    const [first, second] = parse(`.a{${LOSSY_A}} .a{${LOSSY_B}}`);
    expect(declarationsOf(first!)).toBe(LOSSY_A);
    expect(declarationsOf(second!)).toBe(LOSSY_B);
  });

  it("takes no text for rules the parser and the statements disagree on (it dropped one)", () => {
    // The parser takes `color: red;` into the first .a's prelude, and drops it.
    const rules = parse(`color: red; .a{${LOSSY_A}} .a{${LOSSY_B}}`);
    expect(rules).toHaveLength(1);
    // Not the dropped rule's text: the CSSOM's (its values come from the computed style).
    expect(declarationsOf(rules[0]!)).toBe("border-top-style: ;");
  });

  it("parses nothing again in a sheet where no rule lost values", () => {
    const replace = vi.spyOn(FakeSheet.prototype, "replaceSync");
    parse(`.a { color: var(--a) } @media all { .b { border: 1px solid var(--b) } }`);
    expect(replace).toHaveBeenCalledTimes(1);
    replace.mockRestore();
  });
});

describe("splitSelectorList", () => {
  it("splits at top-level commas only", () => {
    expect(splitSelectorList(`.a, :is(.b, .c) > d, [e=","]::after`)).toEqual([
      ".a",
      ":is(.b, .c) > d",
      `[e=","]::after`,
    ]);
  });
});
