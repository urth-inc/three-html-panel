import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { caretAt } from "./caret";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the mirror a text field is measured with", () => {
  /** The box-sizing and width of the mirror a caret measurement adds. */
  function mirrorOf(field: HTMLTextAreaElement): string {
    const widths: string[] = [];
    const append = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      if (node instanceof HTMLDivElement)
        widths.push(`${node.style.boxSizing} ${node.style.width}`);
      return append(node);
    });
    caretAt(field, 0);
    return widths[0]!;
  }

  it("wraps a textarea's lines without the room a classic scrollbar takes, keeping the fractional width", () => {
    document.body.innerHTML = `<textarea id="text" style="width: 199.6px; padding-left: 10px; padding-right: 12px">hello</textarea>`;
    const field = document.querySelector<HTMLTextAreaElement>("#text")!;
    // 221.6 px wide with its padding (rounded to 222), a 15 px scrollbar inside.
    Object.defineProperties(field, { offsetWidth: { value: 222 }, clientWidth: { value: 207 } });
    expect(mirrorOf(field)).toBe("content-box 184.6px");
  });

  it("takes the width as it is where the scrollbar takes no room (an overlay scrollbar, or none)", () => {
    document.body.innerHTML = `<textarea id="text" style="width: 199.6px; padding-left: 10px; padding-right: 12px">hello</textarea>`;
    const field = document.querySelector<HTMLTextAreaElement>("#text")!;
    Object.defineProperties(field, { offsetWidth: { value: 222 }, clientWidth: { value: 222 } });
    expect(mirrorOf(field)).toMatch(/ 199\.6px$/);
  });

  it("works out the content width of a border-box textarea", () => {
    document.body.innerHTML = `<textarea id="text" style="box-sizing: border-box; width: 221.6px; padding-left: 10px; padding-right: 12px">hello</textarea>`;
    const field = document.querySelector<HTMLTextAreaElement>("#text")!;
    Object.defineProperties(field, { offsetWidth: { value: 222 }, clientWidth: { value: 207 } });
    expect(mirrorOf(field)).toBe("content-box 184.6px");
  });
});
