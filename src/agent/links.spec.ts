import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { interceptLinks } from "./links";

let opened: string[];
let stop: () => void;

beforeEach(() => {
  opened = [];
  stop = interceptLinks(window, (url) => opened.push(url));
});

afterEach(() => {
  stop();
  document.body.innerHTML = "";
});

/** A click as the agent synthesizes it. */
const click = (element: Element) =>
  element.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }),
  );

describe("interceptLinks", () => {
  it("hands a followed link to the host, as an absolute URL, instead of following it in the panel", () => {
    document.body.innerHTML = `<a href="/docs?x=1" target="_blank"><span id="inner">Docs</span></a>`;
    const notCancelled = click(document.querySelector("#inner")!);
    expect(opened).toEqual([new URL("/docs?x=1", location.href).href]);
    expect(notCancelled).toBe(false);
  });

  it("leaves links the page handles itself, links within the page, and other schemes", () => {
    document.body.innerHTML = `
      <a id="handled" href="https://example.com/">handled</a>
      <a id="fragment" href="#section">fragment</a>
      <a id="script" href="javascript:void 0">script</a>
      <a id="download" href="https://example.com/file.zip" download>download</a>`;
    document
      .querySelector("#handled")!
      .addEventListener("click", (event) => event.preventDefault());
    for (const id of ["handled", "fragment", "script", "download"])
      click(document.getElementById(id)!);
    expect(opened).toEqual([]);
  });

  it("does not decide on the next click when the page stopped this one before it reached the window", () => {
    document.body.innerHTML = `<a id="stopped" href="https://example.com/a">a</a><a id="next" href="https://example.com/b">b</a>`;
    document
      .querySelector("#stopped")!
      .addEventListener("click", (event) => event.stopPropagation());
    click(document.getElementById("stopped")!);
    click(document.getElementById("next")!);
    expect(opened).toEqual(["https://example.com/b"]);
  });

  it("hands window.open() to the host and gives the page no window", () => {
    expect(window.open("https://example.com/popup", "_blank")).toBeNull();
    expect(window.open("javascript:alert(1)")).toBeNull();
    expect(opened).toEqual(["https://example.com/popup"]);
  });

  it("puts window.open back when stopped", () => {
    const replaced = window.open;
    stop();
    expect(window.open).not.toBe(replaced);
    stop = () => {};
  });
});
