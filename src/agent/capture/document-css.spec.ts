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

  it("leaves out the style rules no element matches when pruning, and only then", () => {
    document.head.innerHTML =
      "<style>.used { color: red } .unused { color: blue } .used:hover::after { content: 'x' } ::selection { color: green }</style>";
    document.body.innerHTML = '<p class="used"></p>';
    const css = new DocumentCss(document, () => null, undefined, { prune: true });
    const pruned = css.get(0).join("\n");
    expect(pruned).toContain(".used{");
    expect(pruned).toContain("::after");
    expect(pruned).toContain("::selection");
    expect(pruned).not.toContain(".unused");
    // Without a version (or without prune), every rule.
    expect(css.get().join("\n")).toContain(".unused");
    document.body.innerHTML = "";
  });

  it("looks for the rules again only for another version", () => {
    document.head.innerHTML = "<style>.later { color: red }</style>";
    const css = new DocumentCss(document, () => null, undefined, { prune: true });
    expect(css.get(1).join("\n")).not.toContain(".later");
    document.body.innerHTML = '<p class="later"></p>';
    expect(css.get(1).join("\n")).not.toContain(".later");
    expect(css.get(2).join("\n")).toContain(".later");
    document.body.innerHTML = "";
  });

  it("leaves out the @font-face rules of faces the page never loaded", () => {
    class FakeFontFace {
      status = "unloaded";
      style: string;
      weight: string;
      stretch: string;
      unicodeRange: string;
      constructor(
        readonly family: string,
        _source: string,
        descriptors: {
          style?: string;
          weight?: string;
          stretch?: string;
          unicodeRange?: string;
        } = {},
      ) {
        this.style = descriptors.style ?? "normal";
        this.weight = descriptors.weight ?? "normal";
        this.stretch = descriptors.stretch ?? "normal";
        this.unicodeRange = descriptors.unicodeRange ?? "U+0-10FFFF";
      }
    }
    vi.stubGlobal("FontFace", FakeFontFace);
    const regular = Object.assign(new FakeFontFace('"Inter"', "", { weight: "400" }), {
      status: "loaded",
    });
    const bold = new FakeFontFace('"Inter"', "", { weight: "700" });
    const fonts = Object.assign([regular, bold], {
      addEventListener() {},
      removeEventListener() {},
    });
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    document.head.innerHTML =
      "<style>@font-face { font-family: Inter; font-weight: 400 }" +
      "@font-face { font-family: Inter; font-weight: 700 }" +
      "@font-face { font-family: Other }</style>";
    const css = new DocumentCss(document, () => null, undefined, { prune: true }).get(0).join("\n");
    // (jsdom leaves src out of an @font-face's text.)
    expect(css).toContain("font-weight: 400");
    expect(css).not.toContain("font-weight: 700");
    // A face the page does not list: kept.
    expect(css).toContain("font-family: Other");
    delete (document as { fonts?: unknown }).fonts;
  });

  it("drops a block all of whose rules went", () => {
    document.head.innerHTML =
      "<style>@layer ui { .unused { color: red } } @layer base { .x:not(:hover) { color: blue } }</style>";
    document.body.innerHTML = '<p class="x"></p>';
    const css = new DocumentCss(document, () => null, undefined, { prune: true }).get(0).join("\n");
    expect(css).not.toContain("@layer ui");
    expect(css).toContain("@layer base");
    document.body.innerHTML = "";
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
      ownerNode: { value: null },
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

describe("rendering again", () => {
  it("keeps the CSS rendered while no other rule is used, and renders it again when one is", () => {
    document.head.innerHTML = "<style>.a { color: red } .b { color: blue }</style>";
    document.body.innerHTML = '<p class="a"></p>';
    const css = new DocumentCss(document, () => null, undefined, { prune: true });
    const first = css.get(1);
    document.body.innerHTML = '<p class="a"></p><p class="a"></p>';
    // Another version, the same rules used: the same CSS, not rendered again.
    expect(css.get(2)).toBe(first);
    document.body.innerHTML = '<p class="b"></p>';
    const later = css.get(3);
    expect(later).not.toBe(first);
    // A rule used once is kept (see matchedTests).
    expect(later.join("\n")).toContain(".a{");
    expect(later.join("\n")).toContain(".b{");
    document.body.innerHTML = "";
  });

  it("inlines a url() again when its image arrives, without collecting the sheets again", () => {
    document.head.innerHTML =
      '<style>.a { background-image: url("https://site.test/a.png") }</style>';
    let image: string | null = null;
    const css = new DocumentCss(document, () => image);
    expect(css.get().join("\n")).not.toContain("data:");
    const generation = css.generation;
    image = "data:image/png;base64,AAAA";
    css.reinline();
    expect(css.get().join("\n")).toContain("data:image/png;base64,AAAA");
    expect(css.generation).toBe(generation);
  });
});

describe("the declarations a <style> wrote", () => {
  it("are taken for its rules that lost values in the CSSOM, rather than the computed style", () => {
    const written = ".a { border: 1px solid var(--a); border-top-color: red }";
    document.head.innerHTML = `<style>${written}</style>`;
    // As browsers have it (jsdom drops the shorthand instead): its longhands
    // are there, without their values. The text is what the browser's parser
    // gives for the statement alone, so the two are matched.
    const lossy = Object.create(window.CSSStyleRule.prototype, {
      selectorText: { value: ".a" },
      cssText: { value: new DocumentCssProbe().cssTextOf(written) },
      cssRules: { value: [] },
      style: {
        value: {
          cssText: "border-top-style: ;",
          length: 1,
          item: () => "border-top-style",
          getPropertyValue: () => "",
        },
      },
    }) as CSSStyleRule;
    const sheet = {
      href: null,
      disabled: false,
      ownerNode: document.head.querySelector("style"),
      cssRules: [lossy],
    } as unknown as CSSStyleSheet;
    vi.spyOn(document, "styleSheets", "get").mockReturnValue([sheet] as unknown as StyleSheetList);
    const css = new DocumentCss(document, () => null);
    expect(css.get()[1]).toBe(".a{ border: 1px solid var(--a); border-top-color: red }");
    expect(css.lost).toEqual([]);
  });
});

/** What this browser's parser makes of a rule's text alone (see keepWrittenBlocks). */
class DocumentCssProbe {
  cssTextOf(text: string): string {
    const sheet = new window.CSSStyleSheet();
    sheet.replaceSync(text);
    return sheet.cssRules[0]!.cssText;
  }
}

describe("relationalCheck", () => {
  const checks = (css: string) => {
    document.head.innerHTML = `<style>${css}</style>`;
    const documentCss = new DocumentCss(document, () => null);
    documentCss.get();
    return documentCss.relationalCheck;
  };

  it("is null without :has()", () => {
    expect(checks(".a { color: red }")).toBeNull();
  });

  it("gives what each :has() is about, in the elements its anchor matches", () => {
    expect(
      checks(
        ".card:has(> .icon) { color: red } .list:has(.item.open) { color: red } li:has(+ li.active) { color: red }",
      ),
    ).toEqual([
      // About its children only.
      { anchor: ".card", check: ":scope > .icon" },
      { anchor: ".list", check: ".item.open" },
      // About siblings only (`+ li.active`): nothing to look for in a box left out whole.
    ]);
  });

  it("looks into a :has() in another, and anywhere for one about a parent's siblings", () => {
    expect(checks(".x:has(.y:has(.z)) { color: red } .p:has(~ .q .r) { color: red }")).toEqual([
      { anchor: ".x", check: ".y:has(.z)" },
      // The one inside is about its own anchor's (.y).
      { anchor: ".y", check: ".z" },
      { anchor: "*", check: ".q .r" },
    ]);
  });
});
