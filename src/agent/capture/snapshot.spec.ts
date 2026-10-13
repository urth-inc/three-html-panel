// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildFrameSvg, endOffsetOf, isSampledLive, snapshotDocument } from "./snapshot";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** A fake Web Animation on `target` (jsdom has none). */
function animation(
  target: Element,
  keyframes: Record<string, unknown>[],
  timing: EffectTiming,
  extra: { playState?: AnimationPlayState; transition?: boolean } = {},
): Animation {
  const effect = {
    target,
    pseudoElement: null,
    getKeyframes: () => keyframes,
    getTiming: () => timing,
  };
  return {
    effect,
    playState: extra.playState ?? "running",
    ...(extra.transition ? { transitionProperty: "opacity" } : {}),
  } as unknown as Animation;
}

/** Snapshots the page with these animations running, and returns the copy of #box. */
function snapshotWith(animations: (box: Element) => Animation[]): HTMLElement {
  document.body.innerHTML = `<div id="box" style="opacity: 0.3"></div>`;
  const box = document.querySelector("#box")!;
  document.getAnimations = () => animations(box);
  const xhtml = snapshotDocument(document, {
    inlineImage: () => null,
  });
  const copy = new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
  return copy.getElementById("box") as HTMLElement;
}

describe("animated values in the image", () => {
  it("shows an animation that fills forwards at its last keyframe, not where the stalled clock has it", () => {
    const copy = snapshotWith((box) => [
      animation(
        box,
        [
          { offset: 0, computedOffset: 0, opacity: "0" },
          { offset: 1, computedOffset: 1, opacity: "1" },
        ],
        {
          fill: "forwards",
          iterations: 1,
        },
      ),
    ]);
    expect(copy.style.getPropertyValue("opacity")).toBe("1");
    expect(copy.style.getPropertyPriority("opacity")).toBe("important");
  });

  it("leaves an animation that does not fill forwards, and a transition, to the element's own style", () => {
    const fadeIn = snapshotWith((box) => [
      animation(
        box,
        [
          { computedOffset: 0, opacity: "0" },
          { computedOffset: 1, opacity: "0.9" },
        ],
        { fill: "none", iterations: 1 },
      ),
    ]);
    // Baked values are important; the element's own inline style is not.
    expect(fadeIn.style.getPropertyPriority("opacity")).toBe("");
    const transition = snapshotWith((box) => [
      animation(
        box,
        [
          { computedOffset: 0, opacity: "0" },
          { computedOffset: 1, opacity: "1" },
        ],
        { fill: "both" },
        { transition: true },
      ),
    ]);
    expect(transition.style.getPropertyPriority("opacity")).toBe("");
  });

  it("copies endless and paused animations as they are now", () => {
    const spinning = snapshotWith((box) => [
      animation(
        box,
        [
          { computedOffset: 0, opacity: "0" },
          { computedOffset: 1, opacity: "1" },
        ],
        {
          iterations: Number.POSITIVE_INFINITY,
        },
      ),
    ]);
    // jsdom's computed value is the element's own; in a browser, the animated one.
    expect(spinning.style.getPropertyValue("opacity")).toBe("0.3");
    expect(spinning.style.getPropertyPriority("opacity")).toBe("important");
  });
});

describe("text being composed", () => {
  it("shows in the copy, not in the page, and is underlined", () => {
    document.body.innerHTML = `<input id="name" value="ab">`;
    const field = document.querySelector<HTMLInputElement>("#name")!;
    document.getAnimations = () => [];
    const xhtml = snapshotDocument(document, {
      inlineImage: () => null,
      composition: {
        field,
        value: "aにほb",
        boxes: [{ left: 10, top: 5, width: 30, height: 14 }],
        color: "rgb(0, 0, 0)",
      },
    });
    const copy = new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
    expect(copy.getElementById("name")!.getAttribute("value")).toBe("aにほb");
    expect(field.value).toBe("ab");
    // The underline: as wide as the composed text, at the bottom of its line.
    expect(xhtml).toMatch(
      /left:10px;top:18px;width:30px;height:1px;[^"]*background:rgb\(0, 0, 0\)/,
    );
  });
});

describe("endOffsetOf", () => {
  it("finds the end a finite animation stops at", () => {
    expect(endOffsetOf({})).toBe(1);
    expect(endOffsetOf({ direction: "reverse" })).toBe(0);
    expect(endOffsetOf({ direction: "alternate", iterations: 2 })).toBe(0);
    expect(endOffsetOf({ direction: "alternate", iterations: 3 })).toBe(1);
    expect(endOffsetOf({ direction: "alternate-reverse", iterations: 1 })).toBe(0);
    expect(endOffsetOf({ iterations: Number.POSITIVE_INFINITY })).toBeNull();
    expect(endOffsetOf({ iterations: 1.5 })).toBeNull();
  });

  it("samples live only what does not end on a keyframe", () => {
    const box = document.createElement("div");
    expect(isSampledLive(animation(box, [], { iterations: 1 }))).toBe(false);
    expect(isSampledLive(animation(box, [], { iterations: Number.POSITIVE_INFINITY }))).toBe(true);
    expect(isSampledLive(animation(box, [], { iterations: 1 }, { playState: "paused" }))).toBe(
      true,
    );
    expect(isSampledLive(animation(box, [], {}, { transition: true }))).toBe(false);
  });
});

describe("what the browser draws outside the page", () => {
  const snapshot = (options: Partial<Parameters<typeof snapshotDocument>[1]> = {}) => {
    const xhtml = snapshotDocument(document, {
      inlineImage: () => null,
      ...options,
    });
    return new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
  };

  it("shows a video as an image of its frame, sized and fitted like the video", () => {
    document.body.innerHTML = `<video id="clip" class="wide" src="clip.mp4" controls autoplay></video>`;
    const video = document.querySelector<HTMLVideoElement>("#clip")!;
    video.getBoundingClientRect = () => new DOMRect(0, 0, 320, 180);
    Object.defineProperties(video, {
      readyState: { value: 4 },
      videoWidth: { value: 1280 },
      videoHeight: { value: 720 },
      paused: { value: false },
    });
    const drawn: number[][] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: (_source: unknown, ...box: number[]) => drawn.push(box),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/jpeg;base64,FRAME",
    );
    const image = snapshot().getElementById("clip")!;
    expect(image.tagName).toBe("img");
    expect(image.getAttribute("src")).toBe("data:image/jpeg;base64,FRAME");
    expect(image.getAttribute("class")).toBe("wide");
    // Not the video's own attributes, which mean nothing on an image.
    expect(image.hasAttribute("controls")).toBe(false);
    expect(image.getAttribute("style")).toContain("width: 320px");
    // At most twice the size it is shown at.
    expect(drawn).toEqual([[0, 0, 640, 360]]);
  });

  it("shows the poster before the video plays, and nothing from a video it cannot read", () => {
    document.body.innerHTML = `<video id="clip" poster="poster.png"></video><video id="other"></video>`;
    const posterUrl = new URL("poster.png", document.baseURI).href;
    const copy = snapshot({
      inlineImage: (url) => (url === posterUrl ? "data:image/png;base64,POSTER" : null),
    });
    expect(copy.getElementById("clip")!.getAttribute("src")).toBe("data:image/png;base64,POSTER");
    expect(copy.getElementById("other")!.hasAttribute("src")).toBe(false);
  });

  it("shows the source a <picture> picked as the image's data URL, not the sources it cannot load", () => {
    document.body.innerHTML = `<picture id="art">
      <source type="image/avif" srcset="dusk-480.avif 480w" sizes="50vw" />
      <img id="dusk" src="dusk-480.jpg" srcset="dusk-480.jpg 480w" sizes="50vw" alt="" />
    </picture>`;
    const avifUrl = new URL("dusk-480.avif", document.baseURI).href;
    Object.defineProperty(document.querySelector("#dusk"), "currentSrc", { value: avifUrl });
    const copy = snapshot({
      inlineImage: (url) => (url === avifUrl ? "data:image/avif;base64,DUSK" : null),
    });
    const image = copy.getElementById("dusk")!;
    expect(image.getAttribute("src")).toBe("data:image/avif;base64,DUSK");
    expect(image.hasAttribute("srcset")).toBe(false);
    expect(image.hasAttribute("sizes")).toBe(false);
    // Kept, for the page's selectors, but without anything to pick.
    const source = copy.querySelector("#art source")!;
    expect(source.getAttribute("type")).toBe("image/avif");
    expect(source.hasAttribute("srcset")).toBe(false);
    expect(source.hasAttribute("sizes")).toBe(false);
  });

  it("leaves a <picture> empty until it picked a source, not falling back to one it cannot load", () => {
    document.body.innerHTML = `<picture id="art">
      <source type="image/avif" srcset="dusk-480.avif" />
      <img id="dusk" src="dusk-480.jpg" loading="lazy" alt="" />
    </picture>`;
    // A lazy image out of view has picked nothing yet.
    const inlineImage = vi.fn(() => "data:image/jpeg;base64,FALLBACK");
    const copy = snapshot({ inlineImage });
    expect(inlineImage).not.toHaveBeenCalled();
    expect(copy.getElementById("dusk")!.hasAttribute("src")).toBe(false);
    expect(copy.querySelector("#art source")!.hasAttribute("srcset")).toBe(false);
  });

  it("keeps the size a candidate is laid out at, which is not its pixels (2x, or its width over sizes)", () => {
    document.body.innerHTML = `<style>#dusk { width: 240px; height: 150px }</style>
      <img id="dusk" src="dusk-480.jpg" srcset="dusk-480.jpg 2x" alt="" />
      <img id="plain" src="plain.jpg" alt="" />`;
    const copy = snapshot();
    const image = copy.getElementById("dusk") as HTMLElement;
    expect(image.style.getPropertyValue("width")).toBe("240px");
    expect(image.style.getPropertyValue("height")).toBe("150px");
    // An image without candidates is drawn at its own size, as on the page.
    expect(copy.getElementById("plain")!.hasAttribute("style")).toBe(false);
  });

  it("leaves the sources of a video or an audio element to them", () => {
    document.body.innerHTML = `<audio id="chord" controls><source src="chord.opus" type="audio/ogg" /></audio>`;
    const source = snapshot().querySelector("#chord source")!;
    expect(source.getAttribute("src")).toBe("chord.opus");
    expect(source.getAttribute("type")).toBe("audio/ogg");
  });

  it("encodes a video's frame again only when it changed (a paused video is not encoded on every frame)", () => {
    document.body.innerHTML = `<video id="clip"></video>`;
    const video = document.querySelector<HTMLVideoElement>("#clip")!;
    video.getBoundingClientRect = () => new DOMRect(0, 0, 320, 180);
    let time = 1.5;
    Object.defineProperties(video, {
      readyState: { value: 4 },
      videoWidth: { value: 640 },
      videoHeight: { value: 360 },
      currentTime: { get: () => time },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D);
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/jpeg;base64,FRAME");
    snapshot();
    snapshot();
    expect(encode).toHaveBeenCalledTimes(1);
    expect(snapshot().getElementById("clip")!.getAttribute("src")).toBe(
      "data:image/jpeg;base64,FRAME",
    );
    // It played on: another frame.
    time = 1.6;
    snapshot();
    expect(encode).toHaveBeenCalledTimes(2);
    // Shown smaller on the page: drawn again at the new size (twice its width, 200 px).
    video.getBoundingClientRect = () => new DOMRect(0, 0, 100, 56);
    snapshot();
    expect(encode).toHaveBeenCalledTimes(3);
  });

  it("encodes the frame of another clip or stream at the same time and size (a page swapping src or srcObject)", () => {
    document.body.innerHTML = `<video id="clip"></video>`;
    const video = document.querySelector<HTMLVideoElement>("#clip")!;
    let source = "https://example.com/a.mp4";
    let stream: object | null = null;
    Object.defineProperties(video, {
      readyState: { value: 4 },
      videoWidth: { value: 640 },
      videoHeight: { value: 360 },
      currentTime: { value: 0 },
      currentSrc: { get: () => source },
      srcObject: { get: () => stream },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D);
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/jpeg;base64,FRAME");
    snapshot();
    source = "https://example.com/b.mp4";
    snapshot();
    expect(encode).toHaveBeenCalledTimes(2);
    // A stream, then another one (two cameras).
    stream = {};
    snapshot();
    stream = {};
    snapshot();
    expect(encode).toHaveBeenCalledTimes(4);
    snapshot();
    expect(encode).toHaveBeenCalledTimes(4);
  });

  it("does not try again on every frame to read a video it could not read", () => {
    document.body.innerHTML = `<video id="clip"></video>`;
    const video = document.querySelector<HTMLVideoElement>("#clip")!;
    Object.defineProperties(video, {
      readyState: { value: 4 },
      videoWidth: { value: 640 },
      videoHeight: { value: 360 },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D);
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      throw new DOMException("tainted", "SecurityError");
    });
    snapshot();
    snapshot();
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it("leaves out a frame that cannot be read (a video from another origin)", () => {
    document.body.innerHTML = `<video id="clip"></video>`;
    const video = document.querySelector<HTMLVideoElement>("#clip")!;
    Object.defineProperties(video, {
      readyState: { value: 4 },
      videoWidth: { value: 640 },
      videoHeight: { value: 360 },
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      throw new DOMException("tainted", "SecurityError");
    });
    expect(snapshot().getElementById("clip")!.hasAttribute("src")).toBe(false);
  });

  it("shows text composed in an editable in place, underlined, only in the copy", () => {
    document.body.innerHTML = `<div id="editor" contenteditable="true">hello world</div>`;
    const text = document.querySelector("#editor")!.firstChild!;
    const copy = snapshot({
      inlineComposition: { node: text, offset: 6, endOffset: 11, text: "にほん" },
    });
    const editor = copy.getElementById("editor")!;
    expect(editor.textContent).toBe("hello にほん");
    expect(editor.querySelector("span")!.getAttribute("style")).toContain("underline");
    expect(document.querySelector("#editor")!.textContent).toBe("hello world");
  });

  it("shows text composed on an empty line, between the editable's children", () => {
    document.body.innerHTML = `<div id="editor" contenteditable="true"><p>a</p><p id="empty"><br></p></div>`;
    const empty = document.querySelector("#empty")!;
    const copy = snapshot({
      inlineComposition: { node: empty, offset: 0, endOffset: 0, text: "か" },
    });
    expect(copy.getElementById("empty")!.textContent).toBe("か");
    // At the end of an element: after its last child (or in an empty one).
    const editor = document.querySelector("#editor")!;
    const atEnd = snapshot({
      inlineComposition: { node: editor, offset: 2, endOffset: 2, text: "き" },
    });
    expect(atEnd.getElementById("editor")!.lastElementChild!.textContent).toBe("き");
  });

  it("draws the open list of a <select> over the page, with its items", () => {
    document.body.innerHTML = `<p>page</p>`;
    const copy = snapshot({
      selectPopup: {
        box: { left: 10, top: 40, width: 120, height: 42 },
        itemHeight: 20,
        font: "16px serif",
        items: [
          {
            label: "Fruit",
            index: -1,
            disabled: true,
            grouped: false,
            highlighted: false,
            selected: false,
          },
          {
            label: "<Apple>",
            index: 0,
            disabled: false,
            grouped: true,
            highlighted: true,
            selected: true,
          },
        ],
      },
    });
    const list = copy.documentElement.lastElementChild!;
    expect(list.getAttribute("style")).toContain(
      "position:fixed;left:10px;top:40px;width:120px;height:42px",
    );
    expect(Array.from(list.children, (row) => row.textContent)).toEqual(["Fruit", "<Apple>"]);
    expect(list.children[0]!.getAttribute("style")).toContain("font-weight:bold");
    expect(list.children[1]!.getAttribute("style")).toContain("color:#fff");
  });
});

describe("selections in the image", () => {
  const snapshot = (options: Partial<Parameters<typeof snapshotDocument>[1]> = {}) => {
    const xhtml = snapshotDocument(document, {
      inlineImage: () => null,
      ...options,
    });
    return new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
  };

  it("draws a focused list box's selected options over the copy, white on blue, cut to the box", () => {
    document.body.innerHTML = `<p>page</p>`;
    const copy = snapshot({
      listBoxSelection: [
        {
          shown: { left: 10, top: 20, width: 80, height: 10 },
          box: { left: 10, top: 15, width: 80, height: 15 },
          label: "<news>",
          font: "14px serif",
          paddingLeft: 4,
        },
      ],
    });
    const clip = Array.from(copy.documentElement.children).find((child) =>
      child.getAttribute("style")?.includes("left:10px;top:20px"),
    )!;
    expect(clip.getAttribute("style")).toContain("overflow:hidden");
    const row = clip.firstElementChild!;
    expect(row.textContent).toBe("<news>");
    // Placed where the whole option is, inside the cut.
    expect(row.getAttribute("style")).toContain("left:0px;top:-5px;width:80px;height:15px");
    expect(row.getAttribute("style")).toContain("background:rgb(30 110 220);color:#fff");
  });

  it("draws an inactive selection grey, whatever the page's ::selection color", () => {
    document.body.innerHTML = `<p>text</p>`;
    const box = { left: 1, top: 2, width: 30, height: 16 };
    const boxes = (copy: Document) =>
      Array.from(copy.documentElement.children).filter((child) =>
        child.getAttribute("style")?.includes("left:1px"),
      );
    const active = snapshot({ selection: [box], selectionColor: "rgb(255, 0, 0)" });
    expect(boxes(active)[0]!.getAttribute("style")).toContain("background:rgb(255, 0, 0)");
    const inactive = snapshot({
      selection: [box],
      selectionColor: "rgb(255, 0, 0)",
      selectionInactive: true,
    });
    expect(boxes(inactive)[0]!.getAttribute("style")).toContain("background:rgb(200 200 200)");
  });

  it("keeps a <select>'s size in the copy (Firefox draws it narrower), and shows a scrolled list box from its first row in view", () => {
    document.body.innerHTML = `<select id="tags" multiple size="2"><option id="a">a</option><option id="b">b</option><option id="c">c</option><option id="d">d</option></select>`;
    const select = document.querySelector<HTMLSelectElement>("#tags")!;
    select.getBoundingClientRect = () => new DOMRect(10, 100, 80, 42);
    // Its layout size: what the copy keeps (the rect above would include any transform, which the copy applies again).
    Object.defineProperties(select, {
      clientTop: { value: 1 },
      scrollTop: { value: 25 },
      offsetWidth: { value: 100 },
      offsetHeight: { value: 52 },
    });
    // Rows of 20 px; scrolled by 25: "a" is out of view, "b" by 5 px.
    Array.from(select.options).forEach((option, index) => {
      option.getBoundingClientRect = () => new DOMRect(11, 101 + index * 20 - 25, 78, 20);
    });
    const copy = snapshot().getElementById("tags")!;
    expect(copy.getAttribute("style")).toContain("width: 100px");
    expect(copy.getAttribute("style")).toContain("height: 52px");
    expect(Array.from(copy.querySelectorAll("option"), (option) => option.id)).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(copy.querySelector("#b")!.getAttribute("style")).toContain("translate: 0 -5px");
  });
});

describe("buildFrameSvg", () => {
  it("puts each sheet in a <style> of its own, in order, after the agent's layer", () => {
    const svg = buildFrameSvg("<html/>", ["a{}", "b{content:']]>'}"], 10, 20);
    expect(svg).toBe(
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20" viewBox="0 0 10 20">` +
        `<style>@layer thp-scrolled;</style>` +
        `<style><![CDATA[a{}]]></style>` +
        `<style><![CDATA[b{content:']]]]><![CDATA[>'}]]></style>` +
        `<foreignObject x="0" y="0" width="100%" height="100%"><html/></foreignObject></svg>`,
    );
  });
});

describe("the page's background", () => {
  /** The copies of <html> and <body>, from a snapshot with these images loaded. */
  function snapshotRoot(images: Record<string, string> = {}): {
    root: HTMLElement;
    body: HTMLElement;
  } {
    const xhtml = snapshotDocument(document, {
      inlineImage: (url) => images[url] ?? null,
    });
    const root = new DOMParser().parseFromString(xhtml, "application/xhtml+xml").documentElement;
    return { root, body: root.querySelector("body")! };
  }

  afterEach(() => {
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  it("paints a body's background over the whole page, as browsers do, and not on the body", () => {
    document.body.style.backgroundColor = "rgb(37, 99, 235)";
    const { root, body } = snapshotRoot();
    expect(root.style.backgroundColor).toBe("rgb(37, 99, 235)");
    expect(body.style.getPropertyValue("background-color")).toBe("transparent");
    expect(body.style.getPropertyPriority("background-color")).toBe("important");
  });

  it("leaves the body's background on the body when the root has one", () => {
    document.documentElement.style.backgroundColor = "rgb(255, 255, 255)";
    document.body.style.backgroundColor = "rgb(37, 99, 235)";
    const { root, body } = snapshotRoot();
    // Each keeps its own (here, the page's style attributes, copied).
    expect(root.style.backgroundColor).toBe("rgb(255, 255, 255)");
    expect(body.style.backgroundColor).toBe("rgb(37, 99, 235)");
    expect(body.style.getPropertyPriority("background-color")).toBe("");
  });

  it("moves a body's background image as a data URL, and none while it is not loaded", () => {
    document.body.style.backgroundImage = 'url("https://example.test/paper.png")';
    expect(snapshotRoot().root.style.backgroundImage).toBe("none");
    const { root } = snapshotRoot({ "https://example.test/paper.png": "data:image/png;base64,AA" });
    expect(root.style.backgroundImage).toBe('url("data:image/png;base64,AA")');
  });
});

describe("scrolled content", () => {
  /** Scrolls these elements (jsdom has no layout, nor scrolling). */
  function scroll(scrolled: Map<Element, { left?: number; top?: number }>): void {
    Object.defineProperty(document, "scrollingElement", {
      configurable: true,
      get: () => document.documentElement,
    });
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
      return scrolled.get(this)?.top ?? 0;
    });
    vi.spyOn(Element.prototype, "scrollLeft", "get").mockImplementation(function (this: Element) {
      return scrolled.get(this)?.left ?? 0;
    });
  }

  function snapshot(): Document {
    const xhtml = snapshotDocument(document, {
      inlineImage: () => null,
    });
    return new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
  }

  /**
   * Gives elements (by id) generated boxes with these computed values (jsdom
   * has no ::before or ::after styles).
   */
  function generate(
    boxes: Record<string, Partial<Record<"::before" | "::after", Record<string, string>>>>,
  ) {
    const pageStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const own = pseudo ? boxes[(element as Element).id]?.[pseudo as "::before"] : undefined;
      if (!own) return pageStyle(element, pseudo);
      const values: Record<string, string> = {
        content: '""',
        position: "static",
        display: "block",
        ...own,
      };
      return {
        ...values,
        cssFloat: "none",
        getPropertyValue: (property: string) => values[property] ?? "0px",
      } as unknown as CSSStyleDeclaration;
    });
  }

  /** The rules the copy has for generated boxes, without their layer. */
  const generatedRules = (copy: Document) =>
    copy.querySelector("style")!.textContent!.replace(/^@layer thp-scrolled\{(.*)\}$/s, "$1");

  afterEach(() => {
    delete (document as { scrollingElement?: Element }).scrollingElement;
    document.documentElement.removeAttribute("style");
    document.body.removeAttribute("style");
  });

  it("moves a scrolled page's body by relative offsets, not a transform, which would carry its fixed elements away", () => {
    document.body.innerHTML = `<header id="header" style="position: sticky; top: 0">Site</header><div id="bar" style="position: fixed; top: 0"></div>`;
    scroll(new Map([[document.documentElement, { left: 20, top: 300 }]]));
    const copy = snapshot();
    const body = copy.querySelector("body")!;
    expect(body.style.position).toBe("relative");
    expect(body.style.top).toBe("-300px");
    expect(body.style.left).toBe("-20px");
    expect(body.style.getPropertyValue("translate")).toBe("");
    // The browser places them (sticky ones from the layout, which has the offsets).
    expect(copy.getElementById("header")!.getAttribute("style")).toBe("position: sticky; top: 0");
    expect(copy.getElementById("bar")!.getAttribute("style")).toBe("position: fixed; top: 0");
  });

  it("adds the scroll to a relatively positioned body's own offset", () => {
    document.body.style.position = "relative";
    document.body.style.top = "10px";
    scroll(new Map([[document.documentElement, { top: 300 }]]));
    const body = snapshot().querySelector("body")!;
    expect(body.style.top).toBe("-290px");
    expect(body.style.left).toBe("0px");
  });

  it("moves a scroll container's children by how they are positioned where its flow cannot be moved, and a sticky one's insets the other way", () => {
    // Text: lines, which margins do not move.
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">Text` +
      `<table id="table"></table>` +
      `<h3 id="heading" style="position: sticky; top: 4px"></h3>` +
      `<div id="absolute" style="position: absolute"></div>` +
      `<div id="fixed" style="position: fixed"></div>` +
      `</div>`;
    scroll(new Map([[document.querySelector("#box")!, { top: 50 }]]));
    const copy = snapshot();
    const style = (id: string) => copy.getElementById(id)!.style;
    expect(style("table").position).toBe("relative");
    expect(style("table").top).toBe("-50px");
    // It sticks to the unscrolled box where it would to the scrolled one.
    expect(style("heading").getPropertyValue("translate")).toBe("0px -50px");
    expect(style("heading").top).toBe("54px");
    // Over its siblings, positioned now, as the page paints it over them.
    expect(style("heading").zIndex).toBe("1");
    // Not scrolled with the box: their containing blocks are outside it.
    expect(copy.getElementById("absolute")!.getAttribute("style")).toBe("position: absolute");
    expect(copy.getElementById("fixed")!.getAttribute("style")).toBe("position: fixed");
  });

  it("keeps the page's z-index on a static box ignored, but not on a flex item's", () => {
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">Text<p id="block" style="z-index: -1"></p></div>` +
      `<div id="row" style="overflow: auto; display: flex">Text<p id="item" style="z-index: -1"></p></div>`;
    scroll(
      new Map([
        [document.querySelector("#box")!, { top: 50 }],
        [document.querySelector("#row")!, { left: 30 }],
      ]),
    );
    const copy = snapshot();
    expect(copy.getElementById("block")!.style.zIndex).toBe("auto");
    expect(copy.getElementById("item")!.style.zIndex).toBe("-1");
    expect(copy.getElementById("item")!.style.top).toBe("0px");
  });

  it("moves absolute and fixed children by their insets when the box is their containing block", () => {
    document.body.innerHTML =
      `<div id="box" style="overflow: auto; position: relative">` +
      `<div id="badge" style="position: absolute; top: 10px"></div>` +
      `<div id="flow" style="position: absolute"></div>` +
      `</div>` +
      `<div id="layer" style="overflow: auto; transform: translateZ(0px)">` +
      `<div id="fixed" style="position: fixed; bottom: 5px"></div>` +
      `</div>`;
    scroll(
      new Map([
        [document.querySelector("#box")!, { top: 50 }],
        [document.querySelector("#layer")!, { top: 20 }],
      ]),
    );
    const copy = snapshot();
    const style = (id: string) => copy.getElementById(id)!.style;
    expect(style("badge").top).toBe("-40px");
    expect(style("badge").getPropertyValue("translate")).toBe("");
    // At its place in the flow, which moves (nothing else is in it).
    expect(style("flow").marginTop).toBe("");
    expect(style("fixed").bottom).toBe("25px");
  });

  it("holds a sticky element with fixed ones in it by its insets, not translated (they would be clipped to the box)", () => {
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">Text` +
      `<header id="toolbar" style="position: sticky; top: 0"><div id="menu" style="position: fixed; top: 100px"></div></header>` +
      `</div>`;
    const box = document.querySelector("#box")!;
    scroll(new Map([[box, { top: 50 }]]));
    box.getBoundingClientRect = () => new DOMRect(10, 30, 300, 200);
    Object.defineProperty(box, "clientHeight", { value: 200 });
    document.querySelector("#toolbar")!.getBoundingClientRect = () => new DOMRect(10, 30, 300, 40);
    const copy = snapshot();
    const toolbar = copy.getElementById("toolbar")!;
    // Its box in the container's is its sticky view rectangle.
    expect(toolbar.style.top).toBe("0px");
    expect(toolbar.style.bottom).toBe("160px");
    expect(toolbar.style.getPropertyValue("translate")).toBe("");
    expect(copy.getElementById("menu")!.getAttribute("style")).toBe("position: fixed; top: 100px");
  });

  it("moves a block container's flow by its first box's margin, which collapses with those in it", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">` +
      `<section id="first" style="margin-top: 10px"><h2 style="margin-top: 20px">A</h2></section>` +
      `<h2 id="sticky" style="position: sticky; top: 0">B</h2>` +
      `<p id="last" style="margin-left: 5px">C</p>` +
      `</div>`;
    scroll(new Map([[document.querySelector("#box")!, { left: 4, top: 50 }]]));
    const copy = snapshot();
    const style = (id: string) => copy.getElementById(id)!.style;
    // 20px together, 50px less: -30px, with the 20px of the heading in it.
    expect(style("first").marginTop).toBe("-50px");
    expect(style("last").marginTop).toBe("");
    // Sideways, each box; its width kept by the other margin.
    expect(style("last").marginLeft).toBe("1px");
    expect(style("last").marginRight).toBe("4px");
    // Nothing positioned, nor translated: sticky ones stick as on the page.
    expect(style("first").position).toBe("");
    expect(style("sticky").top).toBe("0px");
    expect(style("sticky").getPropertyValue("translate")).toBe("");
  });

  it("counts the margin of a box's first block, whatever comes after it, but not past a new formatting context", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">` +
      `<section id="first" style="margin-top: 10px"><h2 style="margin-top: 20px">A</h2>Some text<span>more</span></section>` +
      `</div>` +
      `<div id="columns-box" style="overflow: auto">` +
      `<section id="columns" style="column-count: 2; margin-top: 10px"><h2 style="margin-top: 20px">A</h2></section>` +
      `</div>`;
    scroll(
      new Map([
        [document.querySelector("#box")!, { top: 50 }],
        [document.querySelector("#columns-box")!, { top: 50 }],
      ]),
    );
    const copy = snapshot();
    // 20px together (the heading's), 50px less: -30px, with the heading's 20px in it.
    expect(copy.getElementById("first")!.style.marginTop).toBe("-50px");
    // Its own margin only: columns are a formatting context of their own.
    expect(copy.getElementById("columns")!.style.marginTop).toBe("-40px");
    expect(copy.getElementById("columns")!.style.position).toBe("");
  });

  it("does not move a flow whose first boxes' margins are separated by clearance", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">` +
      `<section id="first"><h2 id="cleared" style="clear: both; margin-top: 20px">A</h2></section>` +
      `</div>`;
    scroll(new Map([[document.querySelector("#box")!, { top: 50 }]]));
    const first = snapshot().getElementById("first")!;
    // Moved by itself instead.
    expect(first.style.marginTop).toBe("");
    expect(first.style.top).toBe("-50px");
  });

  it("moves the flow of an inline-block scroll container too", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    document.body.innerHTML = `<div id="box" style="overflow: auto; display: inline-block"><p id="a"></p></div>`;
    scroll(new Map([[document.querySelector("#box")!, { top: 30 }]]));
    const a = snapshot().getElementById("a")!;
    expect(a.style.marginTop).toBe("-30px");
    expect(a.style.position).toBe("");
  });

  it("moves a block ::before with the flow by a rule of its own, and an inline one with the children", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    document.body.innerHTML =
      `<div id="block" style="overflow: auto"><p id="a" style="margin-top: 8px"></p></div>` +
      `<div id="inline" style="overflow: auto"><p id="b"></p></div>`;
    generate({
      block: { "::before": { height: "40px", "margin-top": "10px" } },
      inline: { "::before": { display: "inline", height: "auto" } },
    });
    scroll(
      new Map([
        [document.querySelector("#block")!, { top: 30 }],
        [document.querySelector("#inline")!, { top: 30 }],
      ]),
    );
    const copy = snapshot();
    const id = (selector: string) =>
      copy.querySelector(selector)!.getAttribute("data-thp-scrolled");
    // The ::before box moves the flow (its 10px margin, 30px less); the first child goes with it.
    expect(copy.getElementById("a")!.style.getPropertyPriority("margin-top")).toBe("");
    // In a layer of its own, declared first: over the page's important rules.
    expect(copy.querySelector("style")!.textContent).toMatch(/^@layer thp-scrolled\{/);
    // Lines first: the children moved by themselves, and the ::before relatively, as they are.
    expect(copy.getElementById("b")!.style.top).toBe("-30px");
    expect(generatedRules(copy)).toBe(
      `[data-thp-scrolled="${id("#block")}"]::before{margin-top:-20px !important}\n` +
        `[data-thp-scrolled="${id("#inline")}"]::before{position:relative !important;top:-30px !important;` +
        `left:0px !important;bottom:auto !important;right:auto !important;z-index:auto !important}`,
    );
    // Declared in a sheet of its own, before the page's (which may start with @namespace).
    expect(buildFrameSvg("", ["@namespace svg url(x);"], 10, 10)).toContain(
      "<style>@layer thp-scrolled;</style><style><![CDATA[@namespace svg url(x);",
    );
  });

  it("moves a flex container's ::after and an absolute ::before (from its positioned container) with the content", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    document.body.innerHTML =
      `<div id="row" style="overflow: auto; display: flex"><p></p></div>` +
      `<div id="box" style="overflow: auto; position: relative"><p></p></div>`;
    generate({
      row: { "::after": { "margin-top": "2px" } },
      box: { "::before": { position: "absolute", top: "10px", bottom: "auto" } },
    });
    scroll(
      new Map([
        [document.querySelector("#row")!, { top: 30 }],
        [document.querySelector("#box")!, { top: 30 }],
      ]),
    );
    const copy = snapshot();
    const id = (selector: string) =>
      copy.querySelector(selector)!.getAttribute("data-thp-scrolled");
    expect(generatedRules(copy)).toBe(
      `[data-thp-scrolled="${id("#row")}"]::after{margin-top:-28px !important;margin-bottom:30px !important}\n` +
        `[data-thp-scrolled="${id("#box")}"]::before{top:-20px !important}`,
    );
  });

  it("stops the collapse chain at a box's own ::before, and moves a bordered empty one", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">` +
      `<section id="card" style="margin-top: 10px"><h2 style="margin-top: 20px">A</h2></section>` +
      `</div>` +
      `<div id="list" style="overflow: auto"><p id="item"></p></div>`;
    generate({
      card: { "::before": { height: "4px" } },
      list: { "::before": { height: "0px", "border-top-width": "3px" } },
    });
    scroll(
      new Map([
        [document.querySelector("#box")!, { top: 30 }],
        [document.querySelector("#list")!, { top: 30 }],
      ]),
    );
    const copy = snapshot();
    // 10px (the card's, with its ::before's 0px; not the heading's), 30px less.
    expect(copy.getElementById("card")!.style.marginTop).toBe("-20px");
    // Not empty: moved by its rule, not by the fallback.
    expect(copy.getElementById("item")!.style.position).toBe("");
    expect(generatedRules(copy)).toContain("::before{margin-top:-30px !important}");
  });

  it("pins an element from the values an animation ends on", () => {
    document.body.innerHTML = `<div id="toast" style="position: absolute; top: 100px; left: 0px; width: 10%"></div>`;
    const toast = document.querySelector("#toast")!;
    document.getAnimations = () => [
      animation(toast, [{ computedOffset: 1, top: "20px", width: "200px" }], {
        fill: "forwards",
        iterations: 1,
      }),
    ];
    scroll(new Map([[document.documentElement, { top: 300 }]]));
    document.body.getBoundingClientRect = () => new DOMRect(8, 8 - 300, 700, 2000);
    const copy = snapshot().getElementById("toast")!;
    delete (document as { getAnimations?: unknown }).getAnimations;
    // 20px from the document's start; the body's box starts 8px below it.
    expect(copy.style.top).toBe("12px");
    expect(copy.style.width).toBe("200px");
  });

  it("adds to a translate with functions in it", () => {
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">Text` +
      `<h3 id="sticky" style="position: sticky; top: 0; translate: calc(10px + min(5%, 2vw)) 4px"></h3>` +
      `</div>`;
    scroll(new Map([[document.querySelector("#box")!, { top: 50 }]]));
    const sticky = snapshot().getElementById("sticky")!;
    expect(sticky.style.getPropertyValue("translate")).toBe("calc(10px + min(5%, 2vw)) -46px");
  });

  it("does not lift a sticky element with a z-index in a flex item in it", () => {
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">Text` +
      `<h3 id="toolbar" style="position: sticky; top: 0; display: flex"><div style="z-index: 100"></div></h3>` +
      `</div>`;
    scroll(new Map([[document.querySelector("#box")!, { top: 50 }]]));
    expect(snapshot().getElementById("toolbar")!.style.zIndex).toBe("");
  });

  it("holds a sticky element from the margin an animation ends on", () => {
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">Text` +
      `<header id="toolbar" style="position: sticky; top: 0; margin-top: 20px"><div style="position: fixed; top: 100px"></div></header>` +
      `</div>`;
    const box = document.querySelector("#box")!;
    const toolbar = document.querySelector("#toolbar")!;
    document.getAnimations = () => [
      animation(toolbar, [{ computedOffset: 1, marginTop: "0px" }], {
        fill: "forwards",
        iterations: 1,
      }),
    ];
    scroll(new Map([[box, { top: 50 }]]));
    box.getBoundingClientRect = () => new DOMRect(10, 30, 300, 200);
    Object.defineProperty(box, "clientHeight", { value: 200 });
    toolbar.getBoundingClientRect = () => new DOMRect(10, 30, 300, 40);
    const copy = snapshot().getElementById("toolbar")!;
    delete (document as { getAnimations?: unknown }).getAnimations;
    // Its margin box fits as the animation ends (0px), though not now (20px): held, not translated.
    expect(copy.style.top).toBe("0px");
    expect(copy.style.getPropertyValue("translate")).toBe("");
  });

  it("moves the generated boxes of a box moved child by child as such children: sticky lifted, absolute by its insets", () => {
    document.body.innerHTML = `<div id="box" style="overflow: auto; position: relative">Text<p></p></div>`;
    generate({
      box: {
        "::before": {
          position: "sticky",
          top: "0px",
          bottom: "auto",
          zIndex: "auto",
          translate: "none",
        },
        "::after": { position: "absolute", top: "auto", bottom: "10px" },
      },
    });
    scroll(new Map([[document.querySelector("#box")!, { top: 30 }]]));
    const copy = snapshot();
    const id = copy.getElementById("box")!.getAttribute("data-thp-scrolled");
    expect(generatedRules(copy)).toBe(
      `[data-thp-scrolled="${id}"]::before{z-index:1 !important;translate:0px -30px !important;top:30px !important}\n` +
        `[data-thp-scrolled="${id}"]::after{bottom:40px !important}`,
    );
  });

  it("adds no rule for an absolute ::before placed from outside the container", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    document.body.innerHTML = `<div id="box" style="overflow: auto"><p></p></div>`;
    generate({ box: { "::before": { position: "absolute", top: "10px" } } });
    scroll(new Map([[document.querySelector("#box")!, { top: 30 }]]));
    const copy = snapshot();
    expect(copy.querySelector("style")).toBeNull();
    expect(copy.getElementById("box")!.hasAttribute("data-thp-scrolled")).toBe(false);
  });

  it("does not move a flow in columns, or in vertical writing", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    document.body.innerHTML =
      `<div id="columns" style="overflow: auto; column-count: 2"><p id="b"></p></div>` +
      `<div id="vertical" style="overflow: auto; writing-mode: vertical-rl"><p id="c"></p></div>`;
    scroll(
      new Map(["#columns", "#vertical"].map((id) => [document.querySelector(id)!, { top: 30 }])),
    );
    const copy = snapshot();
    // Moved by themselves instead.
    for (const id of ["b", "c"]) {
      expect(copy.getElementById(id)!.style.marginTop).toBe("");
      expect(copy.getElementById(id)!.style.top).toBe("-30px");
    }
  });

  it("moves from the values an animation ends on, and adds to a translate of the page's own", () => {
    document.body.innerHTML =
      `<div id="row" style="overflow: auto; display: flex"><p id="item" style="margin-top: 4px"></p></div>` +
      `<div id="box" style="overflow: auto">Text<h3 id="sticky" style="position: sticky; top: 0; translate: 0px -4px"></h3></div>`;
    const item = document.querySelector("#item")!;
    document.getAnimations = () => [
      animation(item, [{ computedOffset: 1, marginTop: "10px" }], {
        fill: "forwards",
        iterations: 1,
      }),
    ];
    scroll(
      new Map([
        [document.querySelector("#row")!, { top: 30 }],
        [document.querySelector("#box")!, { top: 50 }],
      ]),
    );
    const copy = snapshot();
    delete (document as { getAnimations?: unknown }).getAnimations;
    expect(copy.getElementById("item")!.style.marginTop).toBe("-20px");
    expect(copy.getElementById("sticky")!.style.getPropertyValue("translate")).toBe("0px -54px");
  });

  it("moves each flex or grid item by its margins", () => {
    document.body.innerHTML = `<div id="box" style="overflow: auto; display: flex"><p id="a" style="margin: 2px"></p><p id="b"></p></div>`;
    scroll(new Map([[document.querySelector("#box")!, { top: 30 }]]));
    const copy = snapshot();
    expect(copy.getElementById("a")!.style.marginTop).toBe("-28px");
    expect(copy.getElementById("a")!.style.marginBottom).toBe("32px");
    expect(copy.getElementById("b")!.style.marginTop).toBe("-30px");
    expect(copy.getElementById("b")!.style.position).toBe("");
  });

  it("does not hold a sticky element whose margin would leave the container's content", () => {
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">Text` +
      `<header id="toolbar" style="position: sticky; top: 0; margin-top: 6px"><div style="position: fixed; top: 100px"></div></header>` +
      `</div>`;
    const box = document.querySelector("#box")!;
    scroll(new Map([[box, { top: 50 }]]));
    box.getBoundingClientRect = () => new DOMRect(10, 30, 300, 200);
    Object.defineProperty(box, "clientHeight", { value: 200 });
    document.querySelector("#toolbar")!.getBoundingClientRect = () => new DOMRect(10, 30, 300, 40);
    const toolbar = snapshot().getElementById("toolbar")!;
    // Translated, its insets moved, instead.
    expect(toolbar.style.getPropertyValue("translate")).toBe("0px -50px");
    expect(toolbar.style.bottom).toBe("");
  });

  it("lifts a sticky element over its moved siblings, unless something in it has a z-index", () => {
    document.body.innerHTML =
      `<div id="box" style="overflow: auto">Text` +
      `<h3 id="plain" style="position: sticky; top: 0"></h3>` +
      `<h3 id="menu" style="position: sticky; top: 0"><div style="position: absolute; z-index: 1000"></div></h3>` +
      `</div>`;
    scroll(new Map([[document.querySelector("#box")!, { top: 50 }]]));
    const copy = snapshot();
    expect(copy.getElementById("plain")!.style.zIndex).toBe("1");
    expect(copy.getElementById("menu")!.style.zIndex).toBe("");
  });

  it("places a pinned element from where it is when its insets are in percent (over-constrained)", () => {
    document.body.innerHTML = `<div id="tip" style="position: absolute; top: 50%; left: 10%; bottom: 0; right: 0"></div>`;
    scroll(new Map([[document.documentElement, { top: 300 }]]));
    document.body.getBoundingClientRect = () => new DOMRect(8, 8 - 300, 700, 2000);
    const tip = document.querySelector("#tip")!;
    tip.getBoundingClientRect = () => new DOMRect(70, 100, 100, 40);
    const copy = snapshot().getElementById("tip")!;
    // From the body's box, where the copy places it: (70, 100) less (8, -292).
    expect(copy.style.top).toBe("392px");
    expect(copy.style.left).toBe("62px");
  });

  it("places an absolute element of the document (not in any positioned box) from the moved body", () => {
    document.body.innerHTML = `<div id="tip" style="position: absolute; top: 400px; left: 0px"></div>`;
    scroll(new Map([[document.documentElement, { top: 300 }]]));
    // The body's box, on the page (scrolled), 8px from the document's start.
    document.body.getBoundingClientRect = () => new DOMRect(8, 8 - 300, 700, 2000);
    const tip = snapshot().getElementById("tip")!;
    expect(tip.style.top).toBe("392px");
    expect(tip.style.left).toBe("-8px");
  });

  it("shows a body that scrolls itself, and the document's scroll in quirks mode", () => {
    document.body.innerHTML = `<main id="main"></main>`;
    scroll(new Map([[document.body, { top: 120 }]]));
    expect(snapshot().getElementById("main")!.style.top).toBe("-120px");

    // In quirks mode, <body> is what scrolls the viewport.
    Object.defineProperty(document, "scrollingElement", {
      configurable: true,
      get: () => document.body,
    });
    const body = snapshot().querySelector("body")!;
    expect(body.style.top).toBe("-120px");
    expect(snapshot().getElementById("main")!.style.top).toBe("");
  });

  it("moves composed text in a scrolled box with the rest", () => {
    document.body.innerHTML = `<div id="box" style="overflow: auto" contenteditable=""><p>a</p></div>`;
    const box = document.querySelector("#box")!;
    scroll(new Map([[box, { top: 40 }]]));
    const xhtml = snapshotDocument(document, {
      inlineImage: () => null,
      inlineComposition: { node: box, offset: 1, endOffset: 1, text: "にほん" },
    });
    const copy = new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
    const span = copy.getElementById("box")!.lastElementChild as HTMLElement;
    expect(span.textContent).toBe("にほん");
    expect(span.style.position).toBe("relative");
    expect(span.style.top).toBe("-40px");
  });

  it("leaves the body visible when its overflow is the viewport's, as browsers do", () => {
    document.body.style.overflowX = "hidden";
    expect(snapshot().querySelector("body")!.style.getPropertyValue("overflow")).toBe("visible");
    // <html> has its own: the body's applies to the body.
    document.documentElement.style.overflowX = "hidden";
    expect(snapshot().querySelector("body")!.style.getPropertyValue("overflow")).toBe("");
  });
});

describe("the top layer", () => {
  /**
   * The snapshot's root, with these elements in the top layer (jsdom has none)
   * and these ::backdrop colors or styles (jsdom gives the element's own for ::backdrop).
   */
  function snapshotWithTopLayer(
    open: Record<string, string>,
    options: Partial<Parameters<typeof snapshotDocument>[1]> = {},
    backdrops: Record<string, string> = {},
  ): HTMLElement {
    const getComputedStyle = window.getComputedStyle.bind(window);
    // A ::backdrop's style: a color, or declarations.
    const backdrop = (value = "rgba(0, 0, 0, 0)") => {
      const style = document.createElement("div").style;
      if (value.includes(":")) style.cssText = value;
      else style.backgroundColor = value;
      return style;
    };
    vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) =>
      pseudo === "::backdrop" ? backdrop(backdrops[element.id]) : getComputedStyle(element, pseudo),
    );
    for (const [id, pseudoClass] of Object.entries(open)) {
      const element = document.getElementById(id)!;
      const matches = element.matches.bind(element);
      vi.spyOn(element, "matches").mockImplementation(
        (selector: string) => selector === pseudoClass || matches(selector),
      );
      // jsdom's own style for a popover, or a dialog, not open.
      if (!element.style.display) element.style.display = "block";
    }
    const xhtml = snapshotDocument(document, { inlineImage: () => null, ...options });
    return new DOMParser().parseFromString(xhtml, "application/xhtml+xml").documentElement;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("draws an open popover over the page where the page has it, out of its parents", () => {
    document.body.innerHTML = `<header class="bar" style="backdrop-filter: blur(4px)">
        <button>Theme</button><div id="menu" popover style="display: flex">Light</div>
        <div id="closed" popover>Dark</div>
      </header><main>Page</main>`;
    document.getElementById("menu")!.getBoundingClientRect = () => new DOMRect(500, 40, 152, 120);
    const root = snapshotWithTopLayer({ menu: ":popover-open" });
    const menu = root.lastElementChild!.querySelector<HTMLElement>("#menu")!;
    // Out of the header, over the page: with stand-ins for its parents, which
    // make no box, so that the page's rules (.bar #menu, button + #menu) match
    // it and it inherits as it did.
    const header = menu.parentElement!;
    expect(header.className).toBe("bar");
    expect(header.style.getPropertyValue("display")).toBe("contents");
    expect(header.style.getPropertyPriority("display")).toBe("important");
    expect(header.parentElement!.localName).toBe("body");
    expect(header.parentElement!.style.getPropertyValue("display")).toBe("contents");
    expect(root.lastElementChild).toBe(header.parentElement);
    const button = menu.previousElementSibling as HTMLElement;
    expect(button.localName).toBe("button");
    // Hidden by the stand-ins' rules (STAND_IN_RULES).
    expect(button.hasAttribute("style")).toBe(false);
    expect(header.nextElementSibling!.localName).toBe("main");
    expect(header.nextElementSibling!.hasAttribute("style")).toBe(false);
    // Where it was, a hidden stand-in (the header's children are counted as they were).
    const body = root.querySelector("body")!;
    const place = body.querySelector<HTMLElement>("header > button + #menu")!;
    expect(place.style.getPropertyValue("display")).toBe("none");
    expect(place.childNodes).toHaveLength(0);
    expect(menu.hasAttribute("data-thp-popover-open")).toBe(true);
    for (const [name, value] of <[string, string][]>[
      ["position", "fixed"],
      ["left", "500px"],
      ["top", "40px"],
      ["width", "152px"],
      ["height", "120px"],
      ["display", "flex"],
    ]) {
      expect(menu.style.getPropertyValue(name)).toBe(value);
      expect(menu.style.getPropertyPriority(name)).toBe("important");
    }
    // A closed popover stays where it is, hidden by the page's rules.
    const closed = body.querySelector("#closed")!;
    expect(closed.parentElement!.localName).toBe("header");
    expect(closed.hasAttribute("data-thp-popover-open")).toBe(false);
  });

  it("draws a modal dialog over its ::backdrop, over the page", () => {
    document.body.innerHTML = `<main><dialog id="ask" open>Sure?</dialog></main>`;
    const dialog = document.getElementById("ask")!;
    dialog.getBoundingClientRect = () => new DOMRect(100, 80, 300, 160);
    const root = snapshotWithTopLayer({ ask: ":modal" }, {}, { ask: "rgba(0, 0, 0, 0.5)" });
    const copy = root.lastElementChild!.querySelector<HTMLElement>("#ask")!;
    expect(copy.hasAttribute("data-thp-modal")).toBe(true);
    const backdrop = root.lastElementChild!.previousElementSibling as HTMLElement;
    expect(backdrop.style.backgroundColor).toBe("rgba(0, 0, 0, 0.5)");
    expect(backdrop.style.position).toBe("fixed");
    expect(copy.style.top).toBe("80px");
  });

  it("draws the page's selection under a popover, and the selection and scrollbars in it over it", () => {
    document.body.innerHTML = `<p id="text">Page</p><div id="menu" popover><p id="inside">Menu</p></div>`;
    const menu = document.getElementById("menu")!;
    menu.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
    const boxes = (root: HTMLElement) =>
      Array.from(root.children).filter((child) => child.localName === "div");
    const at = (id: string) => ({
      left: 10,
      top: 10,
      width: 30,
      height: 10,
      text: document.getElementById(id)!.firstChild as Text,
    });
    const under = snapshotWithTopLayer({ menu: ":popover-open" }, { selection: [at("text")] });
    expect(boxes(under)).toHaveLength(1);
    expect(boxes(under)[0]!.nextElementSibling!.localName).toBe("body");
    expect(under.lastElementChild!.querySelector("#menu")).not.toBeNull();
    vi.restoreAllMocks();
    const over = snapshotWithTopLayer({ menu: ":popover-open" }, { selection: [at("inside")] });
    expect(over.lastElementChild!.localName).toBe("div");
    expect(over.lastElementChild!.previousElementSibling!.querySelector("#menu")).not.toBeNull();
  });

  /** The root's children after the lifted element's chain (the agent's boxes drawn over it). */
  const after = (root: HTMLElement, id: string) => {
    const chain = Array.from(root.children).find(
      (child) => child.localName === "body" && child.querySelector(`#${id}[data-thp-lifted]`),
    )!;
    const children = Array.from(root.children);
    return children.slice(children.indexOf(chain) + 1);
  };

  it("hides the stand-ins' ::before and ::after, keeps the earlier siblings and a few later ones", () => {
    const items = (from: number, count: number) =>
      Array.from(
        { length: count },
        (_, index) => `<li class="item" style="display: block !important">${from + index}</li>`,
      ).join("");
    document.body.innerHTML = `<ul class="list">${items(0, 30)}<li><div id="menu" popover>Menu</div></li>${items(31, 40)}</ul>`;
    const root = snapshotWithTopLayer({ menu: ":popover-open" });
    expect(root.querySelector("style")!.textContent).toContain(
      "[data-thp-stand-in]::before,[data-thp-stand-in]::after{display:none!important}",
    );
    const list = root.lastElementChild!.querySelector<HTMLElement>("ul")!;
    expect(list.hasAttribute("data-thp-stand-in")).toBe(true);
    const children = Array.from(list.children);
    // All 30 earlier ones (for `~` and :nth-child), the menu's item, 16 later ones.
    expect(children).toHaveLength(30 + 1 + 16);
    expect(children[30]!.querySelector("#menu")).not.toBeNull();
    expect(children[0]!.className).toBe("item");
    // Without their style, whose !important would show them over the rule that hides them.
    expect(children[0]!.hasAttribute("style")).toBe(false);
    expect(children[46]!.className).toBe("item");
  });

  it("lifts a popover opened in an open popover over it, through its stand-in", () => {
    document.body.innerHTML = `<nav class="bar"><div id="menu" popover><div id="sub" popover>Sub</div></div></nav>`;
    document.getElementById("menu")!.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
    document.getElementById("sub")!.getBoundingClientRect = () => new DOMRect(100, 0, 80, 60);
    const root = snapshotWithTopLayer({ menu: ":popover-open", sub: ":popover-open" });
    const chains = Array.from(root.children).filter((child) =>
      child.hasAttribute("data-thp-stand-in"),
    );
    expect(chains).toHaveLength(2);
    const [menuChain, subChain] = chains;
    // The menu, with a hidden stand-in for the submenu where it was.
    const menu = menuChain!.querySelector<HTMLElement>("#menu[data-thp-lifted]")!;
    expect(menu.querySelector<HTMLElement>("#sub")!.style.getPropertyValue("display")).toBe("none");
    // The submenu after it, in stand-ins for the nav and the menu (which makes no box there).
    const sub = subChain!.querySelector<HTMLElement>("#sub[data-thp-lifted]")!;
    const menuStandIn = sub.parentElement!;
    expect(menuStandIn.id).toBe("menu");
    expect(menuStandIn.hasAttribute("data-thp-stand-in")).toBe(true);
    expect(menuStandIn.style.getPropertyValue("display")).toBe("contents");
    expect(menuStandIn.parentElement!.className).toBe("bar");
    expect(sub.style.left).toBe("100px");
  });

  it("draws a popover's ::backdrop too", () => {
    document.body.innerHTML = `<div id="menu" popover>Menu</div>`;
    const root = snapshotWithTopLayer(
      { menu: ":popover-open" },
      {},
      { menu: "rgba(0, 0, 0, 0.3)" },
    );
    const cover = root.lastElementChild!.previousElementSibling as HTMLElement;
    expect(cover.style.backgroundColor).toBe("rgba(0, 0, 0, 0.3)");
  });

  it("draws each box of a selection running into a popover under it or over it, by the text it is of", () => {
    document.body.innerHTML = `<p id="text">Page</p><div id="menu" popover><p id="inside">Menu</p></div>`;
    document.getElementById("menu")!.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
    const text = (id: string) => document.getElementById(id)!.firstChild as Text;
    // Page text the popover covers, and popover text spilling out of it.
    const page = { left: 10, top: 10, width: 30, height: 10, text: text("text") };
    const spilled = { left: 10, top: 120, width: 30, height: 10, text: text("inside") };
    const root = snapshotWithTopLayer({ menu: ":popover-open" }, { selection: [page, spilled] });
    const drawn = after(root, "menu") as HTMLElement[];
    expect(drawn.map((box) => box.style.top)).toEqual(["120px"]);
  });

  it("draws an IME's underline, a list box's rows and the scrollbars in a popover over it", () => {
    document.body.innerHTML = `<div id="menu" popover><input id="field" /><select id="list" size="3"><option>a</option></select><div id="scroller" style="overflow-x: hidden; overflow-y: auto">Long</div></div>`;
    document.getElementById("menu")!.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
    const scroller = document.getElementById("scroller")!;
    scroller.getBoundingClientRect = () => new DOMRect(10, 100, 100, 100);
    Object.defineProperty(scroller, "clientHeight", { value: 100 });
    Object.defineProperty(scroller, "clientWidth", { value: 100 });
    Object.defineProperty(scroller, "scrollHeight", { value: 400 });
    Object.defineProperty(scroller, "scrollWidth", { value: 100 });
    const box = new DOMRect(10, 10, 50, 20);
    const root = snapshotWithTopLayer(
      { menu: ":popover-open" },
      {
        composition: {
          field: document.getElementById("field")!,
          value: "x",
          boxes: [box],
          color: "red",
        },
        listBox: document.getElementById("list"),
        listBoxSelection: [
          { shown: box, box, label: "a", font: "13px sans-serif", paddingLeft: 4 },
        ],
      },
    );
    const drawn = after(root, "menu") as HTMLElement[];
    expect(drawn.some((element) => element.style.backgroundColor === "red")).toBe(true);
    expect(drawn.some((element) => element.textContent === "a")).toBe(true);
    // The scroller's track or thumb, at its right edge.
    expect(drawn.some((element) => parseFloat(element.style.left) >= 100)).toBe(true);
  });

  it("stacks the top layer in the order it was opened, not the page's", () => {
    document.body.innerHTML = `<div id="toast" popover>Saved</div><dialog id="ask">Sure?</dialog>`;
    const opened: Record<string, number> = { ask: 1, toast: 2 };
    const root = snapshotWithTopLayer(
      { toast: ":popover-open", ask: ":modal" },
      { openedAt: (element) => opened[element.id] ?? 0 },
    );
    const lifted = Array.from(root.querySelectorAll("[data-thp-lifted]")).map(
      (element) => element.id,
    );
    expect(lifted).toEqual(["ask", "toast"]);
  });

  it("draws in the innermost one what is in a popover opened in another, whatever the order", () => {
    document.body.innerHTML = `<div id="menu" popover><div id="sub" popover><p id="item">Item</p></div></div>`;
    const opened: Record<string, number> = { sub: 1, menu: 2 };
    const text = document.getElementById("item")!.firstChild as Text;
    const root = snapshotWithTopLayer(
      { menu: ":popover-open", sub: ":popover-open" },
      {
        openedAt: (element) => opened[element.id] ?? 0,
        selection: [{ left: 1, top: 2, width: 3, height: 4, text }],
      },
    );
    const children = Array.from(root.children);
    const chainOf = (id: string) =>
      children.findIndex((child) => child.querySelector(`#${id}[data-thp-lifted]`));
    const box = children.findIndex((child) => (child as HTMLElement).style?.top === "2px");
    expect(box).toBe(chainOf("sub") + 1);
    expect(chainOf("menu")).toBeGreaterThan(box);
  });

  it("leaves one the browser does not draw (in a display: none box) where it is", () => {
    document.body.innerHTML = `<section style="display: none"><div id="menu" popover>Menu</div></section>`;
    const root = snapshotWithTopLayer({ menu: ":popover-open" });
    expect(root.querySelector("#menu")!.parentElement!.localName).toBe("section");
    expect(root.querySelector("[data-thp-lifted]")).toBeNull();
  });

  it("lifts one of its own display: contents (the browser draws its children over the page)", () => {
    document.body.innerHTML = `<section style="overflow: hidden"><div id="menu" popover style="display: contents"><p>Card</p></div></section>`;
    const root = snapshotWithTopLayer({ menu: ":popover-open" });
    expect(root.querySelector("[data-thp-lifted]")!.id).toBe("menu");
  });

  it("draws a ::backdrop's image as well as its color", () => {
    document.body.innerHTML = `<dialog id="ask">Sure?</dialog>`;
    const root = snapshotWithTopLayer(
      { ask: ":modal" },
      {},
      { ask: "background-image: linear-gradient(red, blue)" },
    );
    const cover = root.lastElementChild!.previousElementSibling as HTMLElement;
    expect(cover.style.backgroundImage).toBe("linear-gradient(red, blue)");
  });

  /** Stands in for DOMMatrix (jsdom has none): leaves points where they are, and keeps what it was made from. */
  function stubMatrix(): string[] {
    const made: string[] = [];
    vi.stubGlobal(
      "DOMMatrix",
      class {
        constructor(transform: string) {
          made.push(transform);
        }
        transformPoint(point: { x: number; y: number }) {
          return point;
        }
      },
    );
    return made;
  }

  it("gives a transformed one its unrounded size and its transform as it is now", () => {
    stubMatrix();
    document.body.innerHTML = `<div id="menu" popover style="width: 151.4px; height: 20px; padding: 4px; border: 0; transform: translateX(0px)">Menu</div>`;
    const root = snapshotWithTopLayer({ menu: ":popover-open" });
    const menu = root.querySelector<HTMLElement>("[data-thp-lifted]")!;
    expect(menu.style.width).toBe("159.4px");
    expect(menu.style.height).toBe("28px");
    expect(menu.style.transform).toBe("translateX(0px)");
    expect(menu.style.getPropertyPriority("transform")).toBe("important");
  });

  it("reads a translation in % as of the box's size (DOMMatrix takes none)", () => {
    const made = stubMatrix();
    document.body.innerHTML = `<dialog id="ask" style="width: 200px; height: 100px; padding: 0; border: 0; box-sizing: border-box; translate: -50% -25%; scale: 0.5">Sure?</dialog>`;
    snapshotWithTopLayer({ ask: ":modal" });
    expect(made).toEqual(["translate3d(-100px,-25px,0px) scale3d(0.5,0.5,1)"]);
  });
});
