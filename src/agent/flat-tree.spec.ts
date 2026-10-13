// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  closestInFlatTree,
  deepElementFromPoint,
  flatChildren,
  flatParent,
  querySelectorAllInFlatTree,
  retarget,
} from "./flat-tree";

afterEach(() => {
  document.body.innerHTML = "";
});

/** A host with a shadow root (a button around a slot), and two children: one assigned, one not. */
function host(): { host: Element; root: ShadowRoot; light: Element; unassigned: Element } {
  document.body.innerHTML = `<a href="#" id="link"><x-host id="host"><span id="light">Label</span><i id="unassigned" slot="none"></i></x-host></a>`;
  const host = document.querySelector("#host")!;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<button id="button"><slot id="slot"></slot></button>`;
  return {
    host,
    root,
    light: document.querySelector("#light")!,
    unassigned: document.querySelector("#unassigned")!,
  };
}

describe("flatParent", () => {
  it("goes from a host's child to its slot, and out of a shadow root to its host", () => {
    const { host: element, root, light, unassigned } = host();
    expect(flatParent(light)).toBe(root.querySelector("#slot"));
    expect(flatParent(root.querySelector("#button")!)).toBe(element);
    // Not drawn.
    expect(flatParent(unassigned)).toBeNull();
    expect(flatParent(element)).toBe(document.querySelector("#link"));
    expect(flatParent(document.documentElement)).toBeNull();
  });
});

describe("flatChildren", () => {
  it("gives a host's shadow root's children, a slot's assigned nodes, or its fallback", () => {
    const { host: element, root, light } = host();
    expect(flatChildren(element)).toEqual([root.querySelector("#button")]);
    expect(flatChildren(root.querySelector("#slot")!)).toEqual([light]);
    root.querySelector("#button")!.innerHTML = `<slot name="icon"><b id="fallback"></b></slot>`;
    expect(flatChildren(root.querySelector("slot")!)).toEqual([root.querySelector("#fallback")]);
  });
});

describe("closestInFlatTree", () => {
  it("finds what a host's child is drawn in, out to the page around the host", () => {
    const { light } = host();
    expect(closestInFlatTree(light, "button")?.id).toBe("button");
    expect(closestInFlatTree(light, ":any-link")?.id).toBe("link");
    expect(light.closest("button")).toBeNull();
  });
});

describe("deepElementFromPoint", () => {
  it("goes into shadow roots, where elementFromPoint() stops at their hosts", () => {
    const { host: element, root } = host();
    const button = root.querySelector("#button")!;
    document.elementFromPoint = () => element;
    root.elementFromPoint = () => button;
    expect(deepElementFromPoint(document, 10, 10)).toBe(button);
    // A host's own box, with nothing of its shadow root there.
    root.elementFromPoint = () => element;
    expect(deepElementFromPoint(document, 10, 10)).toBe(element);
  });
});

describe("querySelectorAllInFlatTree", () => {
  it("finds what is drawn, in the order drawn: a shadow root's, a host's children at their slot", () => {
    const { root } = host();
    root.prepend(Object.assign(document.createElement("b"), { id: "first" }));
    const ids = querySelectorAllInFlatTree(document.documentElement, "[id]").map(
      (element) => element.id,
    );
    expect(ids).toEqual(["link", "host", "first", "button", "slot", "light"]);
  });
});

describe("retarget", () => {
  it("gives an element as a document or a shadow root sees it", () => {
    const { host: element, root } = host();
    const button = root.querySelector("#button")!;
    expect(retarget(button, document)).toBe(element);
    expect(retarget(button, root)).toBe(button);
    expect(retarget(element, root)).toBeNull();
  });
});
