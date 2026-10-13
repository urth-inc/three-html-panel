// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { rememberShadowRoot } from "../flat-tree";
import { InputSynthesizer } from "./input";

let input: InputSynthesizer;
const onChange = vi.fn();

beforeAll(() => {
  // jsdom has no PointerEvent.
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent;
  input = new InputSynthesizer(document, { measure: (run) => run(), onChange });
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  document.body.innerHTML = `<input id="name" value="ab"><button id="go">Go</button>`;
  input.handle({ type: "blur" });
});

const key = (key: string) =>
  input.handle({
    type: "key",
    key,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  });

describe("pointer capture of the synthetic pointer", () => {
  it("is held by the element that took it, until it lets it go", () => {
    const [field, button] = [document.querySelector("#name")!, document.querySelector("#go")!];
    expect(button.hasPointerCapture(1)).toBe(false);
    button.setPointerCapture(1);
    expect(button.hasPointerCapture(1)).toBe(true);
    expect(field.hasPointerCapture(1)).toBe(false);
    // Another element letting go does not release it.
    field.releasePointerCapture(1);
    expect(button.hasPointerCapture(1)).toBe(true);
    button.releasePointerCapture(1);
    expect(button.hasPointerCapture(1)).toBe(false);
  });
});

describe("virtual focus", () => {
  it("focus() from the page moves the virtual focus and dispatches focus events", () => {
    const field = document.querySelector<HTMLInputElement>("#name")!;
    const events: string[] = [];
    field.addEventListener("focus", () => events.push("focus"));
    document.addEventListener("focusin", () => events.push("focusin"));
    field.focus();
    expect(document.activeElement).toBe(field);
    expect(input.focused).toBe(field);
    expect(events).toEqual(["focus", "focusin"]);
  });

  it("blur() and Escape release focus", () => {
    const field = document.querySelector<HTMLInputElement>("#name")!;
    field.focus();
    field.blur();
    expect(document.activeElement).toBe(document.body);
    field.focus();
    key("Escape");
    expect(input.focused).toBeNull();
  });

  it("focus() on an element that cannot take focus leaves the focus where it is", () => {
    document.body.insertAdjacentHTML("beforeend", `<div id="plain">text</div>`);
    const field = document.querySelector<HTMLInputElement>("#name")!;
    field.focus();
    document.querySelector<HTMLElement>("#plain")!.focus();
    expect(input.focused).toBe(field);
  });

  it("shows focus in a shadow root as browsers do: as its host, outside it", () => {
    document.body.insertAdjacentHTML("beforeend", `<x-host id="host"></x-host>`);
    const host = document.querySelector("#host")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="inner">Inner</button>`;
    const inner = root.querySelector<HTMLElement>("#inner")!;
    inner.focus();
    expect(input.focused).toBe(inner);
    expect(document.activeElement).toBe(host);
    expect(root.activeElement).toBe(inner);
    document.querySelector<HTMLElement>("#name")!.focus();
    expect(root.activeElement).toBeNull();
  });

  it("tells the host of focus moving in its shadow root, as the browser's composed events do", () => {
    document.body.insertAdjacentHTML("beforeend", `<x-host id="host"></x-host>`);
    const host = document.querySelector("#host")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="inner">Inner</button>`;
    const events: string[] = [];
    host.addEventListener("focus", () => events.push("focus"));
    host.addEventListener("blur", () => events.push("blur"));
    root.querySelector<HTMLElement>("#inner")!.focus();
    document.querySelector<HTMLElement>("#name")!.focus();
    expect(events).toEqual(["focus", "blur"]);
  });

  it("loses focus when the element is removed", () => {
    const field = document.querySelector<HTMLInputElement>("#name")!;
    field.focus();
    field.remove();
    expect(input.focused).toBeNull();
  });
});

describe("text editing", () => {
  it("inserts text at the caret and fires input", () => {
    const field = document.querySelector<HTMLInputElement>("#name")!;
    const onInput = vi.fn();
    field.addEventListener("input", onInput);
    field.focus();
    field.setSelectionRange(1, 1);
    input.handle({ type: "text", text: "X" });
    expect(field.value).toBe("aXb");
    expect(field.selectionStart).toBe(2);
    expect(onInput).toHaveBeenCalledOnce();
  });

  it("deletes with Backspace and Delete", () => {
    const field = document.querySelector<HTMLInputElement>("#name")!;
    field.focus();
    field.setSelectionRange(1, 1);
    key("Backspace");
    expect(field.value).toBe("b");
    key("Delete");
    expect(field.value).toBe("");
  });

  it("does nothing when the page cancels beforeinput", () => {
    const field = document.querySelector<HTMLInputElement>("#name")!;
    field.addEventListener("beforeinput", (event) => event.preventDefault());
    field.focus();
    input.handle({ type: "text", text: "X" });
    expect(field.value).toBe("ab");
  });

  it("selects all with Ctrl+A outside Apple platforms", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    const field = document.querySelector<HTMLInputElement>("#name")!;
    field.focus();
    field.setSelectionRange(1, 1);
    input.handle({
      type: "key",
      key: "a",
      shiftKey: false,
      ctrlKey: true,
      altKey: false,
      metaKey: false,
    });
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 2]);
  });

  it("moves to the line start and end with Ctrl+A and Ctrl+E on macOS, and selects all with Cmd+A", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    document.body.innerHTML = "<textarea>ab\ncde\nf</textarea>";
    const textarea = document.querySelector("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(5, 5);
    const press = (key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean }) =>
      input.handle({
        type: "key",
        key,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        ...modifiers,
      });

    press("a", { ctrlKey: true });
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 3]);
    press("e", { ctrlKey: true });
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([6, 6]);
    // Typing after Ctrl+A inserts at the line start instead of replacing everything.
    press("a", { ctrlKey: true });
    input.handle({ type: "text", text: "X" });
    expect(textarea.value).toBe("ab\nXcde\nf");
    press("a", { metaKey: true });
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 9]);
  });

  it("reports the cursor under the pointer", () => {
    document.body.innerHTML = `<button id="go" style="cursor: pointer">Go</button><p id="text">text</p>`;
    const go = document.querySelector("#go")!;
    const text = document.querySelector("#text")!;
    // jsdom rejects the `view` the agent passes (Vitest's window is not jsdom's
    // Window): the pointer events hovering dispatches are made here without it.
    type EventClass = new (type: string, init?: EventInit) => Event;
    const withoutView = (Base: EventClass) =>
      class extends Base {
        constructor(type: string, init: EventInit & { view?: unknown } = {}) {
          const { view: _view, ...rest } = init;
          super(type, rest);
        }
      };
    vi.stubGlobal("MouseEvent", withoutView(MouseEvent as EventClass));
    vi.stubGlobal("PointerEvent", withoutView(PointerEvent as EventClass));
    let hit: Element | null = null;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    const hover = (target: Element | null) => {
      hit = target;
      input.handle({ type: "pointer", kind: "move", x: 1, y: 1 });
    };
    // jsdom has no isContentEditable.
    Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
      configurable: true,
      get(this: HTMLElement) {
        return this.closest("[contenteditable=true]") !== null;
      },
    });
    try {
      hover(go);
      expect(input.cursor).toBe("pointer");
      hover(text);
      expect(input.cursor).toBe("default");
      // A link's cursor is computed as "auto" in WebKit, its hand chosen natively.
      document.body.innerHTML = `<a href="#x" style="cursor: auto"><span id="link">link</span></a><a id="plain" style="cursor: auto">no href</a><div contenteditable="true"><a id="edited" href="#y" style="cursor: auto">edit</a></div>`;
      hover(document.querySelector("#link"));
      expect(input.cursor).toBe("pointer");
      hover(document.querySelector("#plain"));
      expect(input.cursor).toBe("default");
      hover(document.querySelector("#edited"));
      expect(input.cursor).toBe("text");
      document.body.innerHTML = `<textarea></textarea>`;
      hover(document.querySelector("textarea"));
      expect(input.cursor).toBe("text");
      input.handle({ type: "pointer", kind: "leave", x: 0, y: 0 });
      expect(input.cursor).toBe("");
    } finally {
      delete (document as { elementFromPoint?: unknown }).elementFromPoint;
      delete (HTMLElement.prototype as { isContentEditable?: boolean }).isContentEditable;
      vi.unstubAllGlobals();
    }
  });

  it("keeps what is being composed for the focused field until it ends or focus moves", () => {
    const field = document.querySelector<HTMLInputElement>("#name")!;
    field.focus();
    input.handle({ type: "composition", text: "にほ", cursor: 2 });
    expect(input.composition).toEqual({ text: "にほ", cursor: 2 });
    // Composing does not touch the page's value.
    expect(field.value).toBe("ab");
    input.handle({ type: "composition", text: "", cursor: 0 });
    expect(input.composition).toBeNull();
    input.handle({ type: "composition", text: "に", cursor: 1 });
    document.querySelector<HTMLButtonElement>("#go")!.focus();
    expect(input.composition).toBeNull();
  });

  it("undoes and redoes the agent's own edits, typing in a row as one step", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const field = document.querySelector<HTMLInputElement>("#name")!;
    field.focus();
    field.setSelectionRange(2, 2);
    const types: string[] = [];
    field.addEventListener("input", (event) => types.push((event as InputEvent).inputType));
    input.handle({ type: "text", text: "c" });
    input.handle({ type: "text", text: "d" });
    key("Backspace");
    expect(field.value).toBe("abc");
    const command = (k: string, shiftKey = false) =>
      input.handle({ type: "key", key: k, shiftKey, ctrlKey: false, altKey: false, metaKey: true });
    command("z");
    expect(field.value).toBe("abcd");
    command("z");
    expect(field.value).toBe("ab");
    expect(field.selectionStart).toBe(2);
    command("z", true);
    expect(field.value).toBe("abcd");
    expect(types.slice(-3)).toEqual(["historyUndo", "historyUndo", "historyRedo"]);
  });

  it("starts a new undo step when the caret moves between typing", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const field = document.querySelector<HTMLInputElement>("#name")!;
    field.focus();
    field.setSelectionRange(2, 2);
    input.handle({ type: "text", text: "c" });
    key("ArrowLeft");
    input.handle({ type: "text", text: "d" });
    expect(field.value).toBe("abdc");
    input.handle({
      type: "key",
      key: "z",
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: true,
    });
    expect(field.value).toBe("abc");
  });

  it("cuts the selection when the host has cut it to the clipboard, and offers it for copying", () => {
    const field = document.querySelector<HTMLInputElement>("#name")!;
    field.focus();
    field.setSelectionRange(0, 1);
    expect(input.selectedText).toBe("a");
    input.handle({ type: "cut" });
    expect(field.value).toBe("b");
    document.body.innerHTML = `<input id="secret" type="password" value="hunter2">`;
    const secret = document.querySelector<HTMLInputElement>("#secret")!;
    secret.focus();
    secret.setSelectionRange(0, 7);
    // Never a password.
    expect(input.selectedText).toBe("");
  });

  it("moves focus with Tab and Shift+Tab in tab order, selecting a text field's text", () => {
    document.body.innerHTML = `
      <input id="a" value="one"><button id="b">B</button><input id="skip" tabindex="-1">
      <input id="c" disabled><input id="first" tabindex="1" value="x">
      <input type="radio" name="r" id="r1"><input type="radio" name="r" id="r2" checked>`;
    const byId = (id: string) => document.getElementById(id)!;
    const tab = (shiftKey = false) =>
      input.handle({
        type: "key",
        key: "Tab",
        shiftKey,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });
    tab();
    expect(input.focused).toBe(byId("first"));
    tab();
    expect(input.focused).toBe(byId("a"));
    expect([
      (byId("a") as HTMLInputElement).selectionStart,
      (byId("a") as HTMLInputElement).selectionEnd,
    ]).toEqual([0, 3]);
    tab();
    expect(input.focused).toBe(byId("b"));
    // A radio group is one stop, at its checked radio.
    tab();
    expect(input.focused).toBe(byId("r2"));
    tab();
    expect(input.focused).toBe(byId("first"));
    tab(true);
    expect(input.focused).toBe(byId("r2"));
  });

  it("moves with Tab into a shadow root and on, in the order drawn", () => {
    document.body.innerHTML = `<button id="before">Before</button><x-host id="host"></x-host><button id="after">After</button>`;
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="one">One</button><button id="two">Two</button>`;
    // As the page's attachShadow tells the agent.
    rememberShadowRoot(root);
    const tab = () =>
      input.handle({
        type: "key",
        key: "Tab",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });
    root.querySelector<HTMLElement>("#one")!.focus();
    tab();
    expect(input.focused).toBe(root.querySelector("#two"));
    tab();
    expect(input.focused).toBe(document.getElementById("after"));
  });

  it("orders each shadow root on its own, at its host's place, and stops at its radios", () => {
    document.body.innerHTML = `<button id="first" tabindex="2">First</button><button id="plain">Plain</button><x-host id="host"></x-host>`;
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="inner">Inner</button><button id="early" tabindex="1">Early</button>
      <input type="radio" name="size" id="small"><input type="radio" name="size" id="large" checked>`;
    rememberShadowRoot(root);
    const tab = () =>
      input.handle({
        type: "key",
        key: "Tab",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
      });
    const order: string[] = [];
    for (let step = 0; step < 5; step++) {
      tab();
      order.push(input.focused!.id);
    }
    // A tabindex of 1 in the shadow root comes first there, not before the page's 2.
    expect(order).toEqual(["first", "plain", "early", "inner", "large"]);
  });

  it("toggles checkboxes with Space, and moves through a radio group with the arrows", () => {
    document.body.innerHTML = `<input type="checkbox" id="c"><input type="radio" name="r" id="r1" checked><input type="radio" name="r" id="r2">`;
    const checkbox = document.getElementById("c") as HTMLInputElement;
    const changes: string[] = [];
    document.addEventListener("change", (event) => changes.push((event.target as Element).id));
    checkbox.focus();
    key(" ");
    expect(checkbox.checked).toBe(true);
    // The host sends a typed space as text.
    input.handle({ type: "text", text: " " });
    expect(checkbox.checked).toBe(false);
    const r1 = document.getElementById("r1") as HTMLInputElement;
    r1.focus();
    key("ArrowDown");
    expect((document.getElementById("r2") as HTMLInputElement).checked).toBe(true);
    expect(input.focused?.id).toBe("r2");
    expect(changes).toEqual(["c", "c", "r2"]);
  });

  it("ignores text when no field has focus", () => {
    document.querySelector<HTMLButtonElement>("#go")!.focus();
    input.handle({ type: "text", text: "X" });
    expect(document.querySelector<HTMLInputElement>("#name")!.value).toBe("ab");
  });
});
