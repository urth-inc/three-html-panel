import { beforeEach, describe, expect, it } from "vite-plus/test";
import { InteractionMarks } from "./interaction-marks";

let marks: InteractionMarks;

beforeEach(() => {
  document.body.innerHTML = `<form><p><input id="a"></p><button id="b">B</button></form>`;
  marks = new InteractionMarks();
});

const marked = (name: string) =>
  Array.from(document.querySelectorAll(`[${name}]`)).map(
    (element) => element.id || element.tagName,
  );

describe("InteractionMarks", () => {
  it("marks the hovered, pressed and focused elements, and the focused one's ancestors", () => {
    const [field, button] = [document.querySelector("#a")!, document.querySelector("#b")!];
    marks.update({ hovered: [button, button.parentElement!], active: [button], focused: field });
    expect(marked("data-thp-hover")).toEqual(["FORM", "b"]);
    expect(marked("data-thp-active")).toEqual(["b"]);
    expect(marked("data-thp-focus")).toEqual(["a"]);
    expect(marked("data-thp-focus-within")).toEqual(["HTML", "BODY", "FORM", "P", "a"]);
    // Not shown unless said so (focus from a press on a button).
    expect(marked("data-thp-focus-visible")).toEqual([]);
    marks.update({ hovered: [], active: [], focused: button, focusVisible: true });
    expect(marked("data-thp-focus-visible")).toEqual(["b"]);
  });

  it("takes the marks off what left those states, and puts back what the page took off", () => {
    const [field, button] = [document.querySelector("#a")!, document.querySelector("#b")!];
    marks.update({ hovered: [button], active: [], focused: null });
    button.removeAttribute("data-thp-hover");
    marks.update({ hovered: [button], active: [], focused: null });
    expect(marked("data-thp-hover")).toEqual(["b"]);
    marks.update({ hovered: [field], active: [], focused: null });
    expect(marked("data-thp-hover")).toEqual(["a"]);
    marks.dispose();
    expect(document.querySelectorAll("[data-thp-hover]")).toHaveLength(0);
  });
});
