import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DocumentCss } from "./css";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
});

describe("DocumentCss", () => {
  it("copies the rules of the @media blocks that match the page, and only those", () => {
    // What the page's window says matches (jsdom has no matchMedia).
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width") }));
    document.head.innerHTML =
      "<style>@media (min-width: 1px) { .wide { color: red } } @media print { .printed { color: blue } }</style>";
    const css = new DocumentCss(document, () => null).get().join("\n");
    expect(css).toContain(".wide");
    expect(css).not.toContain(".printed");
  });

  it("rewrites the selectors of nested rules, not the text of declarations", () => {
    document.head.innerHTML =
      '<style>.tip { content: "use :hover"; &:hover { opacity: 1 } }</style>';
    const css = new DocumentCss(document, () => null).get().join("\n");
    expect(css).toContain("&:is(:hover,[data-thp-hover])");
    expect(css).toContain('"use :hover"');
  });

  it("draws the default focus ring of a field only where focus shows", () => {
    const css = new DocumentCss(document, () => null).get().join("\n");
    expect(css).toContain("select[data-thp-focus-visible]");
    expect(css).not.toContain("select[data-thp-focus]");
  });
});

/**
 * Makes `importing` @import `imported`, after its first `at` rules (jsdom
 * loads no @import): the document has that one sheet.
 */
function importSheet(
  imported: CSSStyleSheet,
  importing: CSSStyleSheet,
  conditions: { layerName?: string | null; supportsText?: string | null } = {},
  at = 0,
): void {
  const importRule = Object.create(window.CSSImportRule.prototype, {
    styleSheet: { value: imported },
    media: { value: { mediaText: "" } },
    layerName: { value: conditions.layerName ?? null },
    supportsText: { value: conditions.supportsText ?? null },
  }) as CSSImportRule;
  const sheet = {
    href: null,
    disabled: false,
    cssRules: [
      ...Array.from(importing.cssRules).slice(0, at),
      importRule,
      ...Array.from(importing.cssRules).slice(at),
    ],
  } as unknown as CSSStyleSheet;
  vi.spyOn(document, "styleSheets", "get").mockReturnValue([sheet] as unknown as StyleSheetList);
}

describe("blocks of rules", () => {
  it("copy @layer and @container blocks with their rules as the top level's", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width") }));
    document.head.innerHTML =
      "<style>@layer utilities { .a:hover { color: red } @media (min-width: 1px) { .wide { color: blue } } " +
      "@media print { .printed { color: green } } } @container (min-width: 1px) { .b:focus { color: red } }</style>";
    const css = new DocumentCss(document, () => null).get()[1];
    expect(css).toBe(
      "@layer utilities {\n.a:is(:hover,[data-thp-hover]){color: red;}\n.wide{color: blue;}\n}\n" +
        "@container (min-width: 1px) {\n.b:is(:focus,[data-thp-focus]){color: red;}\n}",
    );
  });
});

describe("nested rules", () => {
  it("copy the rules in a style rule as the top level's", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("min-width") }));
    document.head.innerHTML =
      "<style>.card { color: black; &:hover { color: red } @media (min-width: 800px) { color: blue; } " +
      "@media print { color: green; } }</style>";
    expect(new DocumentCss(document, () => null).get()[1]).toBe(
      ".card {color: black;\n&:is(:hover,[data-thp-hover]){color: red;}\ncolor: blue;\n}",
    );
  });
});

describe("recollecting", () => {
  it("notices rules inserted in a block, not only in a sheet", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.head.innerHTML = "<style>@layer components { .a { color: red } }</style>";
    const css = new DocumentCss(document, () => null);
    expect(css.get()[1]).not.toContain(".b");
    const layer = document.styleSheets[0]!.cssRules[0] as CSSLayerBlockRule;
    layer.insertRule(".b { color: blue }", 1);
    expect(css.get()[1]).toContain(".b{color: blue;}");
  });

  it("notices rules inserted in an @media block that did not match, and in an imported sheet", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query !== "print" }));
    document.head.innerHTML =
      "<style>.a { color: red }</style><style>@media print { .p { color: blue } } .c { color: green }</style>";
    const [imported, importing] = Array.from(document.styleSheets);
    importSheet(imported!, importing!);
    const css = new DocumentCss(document, () => null);
    const first = css.get();
    (importing!.cssRules[0] as CSSMediaRule).insertRule(".q { color: blue }", 1);
    const second = css.get();
    // Collected again (a new array), the same CSS: print still does not match.
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    imported!.insertRule(".b { color: blue }", 1);
    expect(css.get()[1]).toContain(".b{color: blue;}");
  });

  it("does not fetch an imported sheet whose media do not match", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query !== "print" }));
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    document.head.innerHTML = "<style>.a { color: red }</style>";
    // A cross-origin sheet: its rules cannot be read.
    const crossOrigin = Object.create(window.CSSStyleSheet.prototype, {
      href: { value: "https://cdn.test/print.css" },
      disabled: { value: false },
      cssRules: {
        get() {
          throw new DOMException("cross-origin", "SecurityError");
        },
      },
    }) as CSSStyleSheet;
    const importRule = Object.create(window.CSSImportRule.prototype, {
      styleSheet: { value: crossOrigin },
      media: { value: { mediaText: "print" } },
      layerName: { value: null },
      supportsText: { value: null },
    }) as CSSImportRule;
    const sheet = {
      href: null,
      disabled: false,
      cssRules: [importRule],
    } as unknown as CSSStyleSheet;
    vi.spyOn(document, "styleSheets", "get").mockReturnValue([sheet] as unknown as StyleSheetList);
    new DocumentCss(document, () => null).get();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("@import rules", () => {
  it("put the imported sheet in the layer it is imported into, @namespace rules outside it", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.head.innerHTML =
      '<style>@namespace x url("urn:i"); a { color: blue }</style><style>a { color: red }</style>';
    const [imported, importing] = Array.from(document.styleSheets);
    importSheet(imported!, importing!, { layerName: "base" });
    expect(new DocumentCss(document, () => null).get()[1]).toBe(
      '@namespace x url("urn:i");\n@layer base {\na{color: blue;}\n}',
    );
    // An anonymous layer too.
    importSheet(imported!, importing!, { layerName: "" });
    expect(new DocumentCss(document, () => null).get()[1]).toBe(
      '@namespace x url("urn:i");\n@layer {\na{color: blue;}\n}',
    );
  });

  it("keep @layer statements before the imports before the imported sheets", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.head.innerHTML =
      "<style>a { color: blue }</style><style>@layer components, base; a { color: red }</style>";
    const [imported, importing] = Array.from(document.styleSheets);
    importSheet(imported!, importing!, { layerName: "base" }, 1);
    const sheets = new DocumentCss(document, () => null).get();
    // components first, as on the page (not base, imported first in the copy).
    expect(sheets.slice(1, 4)).toEqual([
      "@layer components, base;",
      "@layer base {\na{color: blue;}\n}",
      "a{color: red;}",
    ]);
  });

  it("keep @layer statements between imports in their order", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.head.innerHTML =
      "<style>a { color: blue }</style><style>c { color: green }</style><style>@layer b; d { color: red }</style>";
    const [first, second, importing] = Array.from(document.styleSheets);
    const [statement, ...rest] = Array.from(importing!.cssRules);
    const importOf = (sheet: CSSStyleSheet, layerName: string) =>
      Object.create(window.CSSImportRule.prototype, {
        styleSheet: { value: sheet },
        media: { value: { mediaText: "" } },
        layerName: { value: layerName },
        supportsText: { value: null },
      }) as CSSImportRule;
    // @import (layer a); @layer b; @import (layer c); d { … }
    const sheet = {
      href: null,
      disabled: false,
      cssRules: [importOf(first!, "a"), statement, importOf(second!, "c"), ...rest],
    } as unknown as CSSStyleSheet;
    vi.spyOn(document, "styleSheets", "get").mockReturnValue([sheet] as unknown as StyleSheetList);
    expect(new DocumentCss(document, () => null).get().slice(1, 5)).toEqual([
      "@layer a {\na{color: blue;}\n}",
      "@layer b;",
      "@layer c {\nc{color: green;}\n}",
      "d{color: red;}",
    ]);
  });

  it("nest the layers of a sheet imported by an imported one", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.head.innerHTML =
      "<style>a { color: blue }</style><style>b { color: green }</style><style>c { color: red }</style>";
    const [deepest, middle, top] = Array.from(document.styleSheets);
    // middle imports deepest into layer "reset"; top imports middle into "base".
    const middleImporting = Object.create(window.CSSStyleSheet.prototype, {
      href: { value: null },
      disabled: { value: false },
      cssRules: {
        value: [
          Object.create(window.CSSImportRule.prototype, {
            styleSheet: { value: deepest },
            media: { value: { mediaText: "" } },
            layerName: { value: "reset" },
            supportsText: { value: null },
          }),
          ...Array.from(middle!.cssRules),
        ],
      },
    }) as CSSStyleSheet;
    importSheet(middleImporting, top!, { layerName: "base" });
    const sheets = new DocumentCss(document, () => null).get();
    expect(sheets.slice(1, 4)).toEqual([
      "@layer base {\n@layer reset {\na{color: blue;}\n}\n}",
      "@layer base {\nb{color: green;}\n}",
      "c{color: red;}",
    ]);
  });

  it("leave out a sheet imported under supports() the browser does not meet", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.stubGlobal("CSS", { supports: (condition: string) => condition === "display: grid" });
    document.head.innerHTML = "<style>a { color: blue }</style><style>a { color: red }</style>";
    const [imported, importing] = Array.from(document.styleSheets);
    importSheet(imported!, importing!, { supportsText: "display: frobnicate" });
    expect(new DocumentCss(document, () => null).get().join("\n")).not.toContain("blue");
    importSheet(imported!, importing!, { supportsText: "display: grid" });
    expect(new DocumentCss(document, () => null).get().join("\n")).toContain("blue");
  });
});

describe("@namespace rules", () => {
  it("stay first in their own sheet, which the copy keeps apart from the others", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.head.innerHTML =
      '<style>@namespace x url("urn:a"); x|item, .sep::after { content: "x|y" }</style>' +
      '<style>@namespace url("http://www.w3.org/2000/svg"); a, [lang|=en] { fill: blue }</style>' +
      "<style>x|item { color: green }</style>";
    const sheets = new DocumentCss(document, () => null).get();
    // The focus ring's, the page's three, and the animations' freeze.
    expect(sheets).toHaveLength(5);
    // As written: prefixes and the default namespace count in their own sheet only.
    expect(sheets[1]).toBe('@namespace x url("urn:a");\nx|item, .sep::after{content: "x|y";}');
    expect(sheets[2]).toBe(
      '@namespace url("http://www.w3.org/2000/svg");\na, [lang|=en]{fill: blue;}',
    );
    expect(sheets[3]).toBe("x|item{color: green;}");
  });

  it("put an @import'ed sheet in a sheet of its own, before the one importing it", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.head.innerHTML =
      '<style>x|item { color: red }</style><style>@namespace x url("urn:o"); x|item { color: blue }</style>';
    const [imported, importing] = Array.from(document.styleSheets);
    importSheet(imported!, importing!);
    const sheets = new DocumentCss(document, () => null).get();
    // The importing sheet's prefix does not count in the imported one.
    expect(sheets.slice(1, 3)).toEqual([
      "x|item{color: red;}",
      '@namespace x url("urn:o");\nx|item{color: blue;}',
    ]);
  });

  it("keep a linked sheet's relative namespace as it is", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.head.innerHTML = '<style>@namespace app url("app"); app|widget { color: red }</style>';
    Object.defineProperty(document.styleSheets[0]!, "href", {
      value: "https://site.test/css/main.css",
    });
    const sheets = new DocumentCss(document, () => null).get();
    expect(sheets[1]!.startsWith('@namespace app url("app");')).toBe(true);
  });
});
