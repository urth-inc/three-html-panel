import { afterEach, describe, expect, it } from "vite-plus/test";
import { PageChanges } from "./page-changes";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PageChanges", () => {
  it("notes a change on the element, and as within each of its parents", () => {
    document.body.innerHTML = `<main><ul><li id="item">text</li></ul><p id="other"></p></main>`;
    const changes = new PageChanges();
    const item = document.getElementById("item")!;
    changes.changed(item);
    expect(changes.count).toBe(1);
    expect(changes.own(item)).toBe(1);
    expect(changes.within(item)).toBe(1);
    expect(changes.own(item.parentElement!)).toBe(0);
    expect(changes.within(document.querySelector("main")!)).toBe(1);
    expect(changes.within(document.getElementById("other")!)).toBe(0);
    // A text's change is its parent's.
    changes.changed(item.firstChild!);
    expect(changes.own(item)).toBe(2);
  });

  it("goes out of a shadow root to its host", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<span>in it</span>";
    const changes = new PageChanges();
    changes.changed(root.querySelector("span")!);
    expect(changes.within(host)).toBe(1);
    expect(changes.within(document.body)).toBe(1);
    // A change to the root's children is its host's.
    changes.changed(root);
    expect(changes.own(host)).toBe(2);
  });
});
