// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PanelKeyboard, type KeyboardTarget } from "./panel-keyboard";

// One keyboard for the file: it listens on the window and the document for good.
const keyboard = new PanelKeyboard();
let frame: HTMLIFrameElement;
let hostInput: HTMLInputElement;

beforeEach(() => {
  frame = document.createElement("iframe");
  frame.tabIndex = -1;
  hostInput = document.createElement("input");
  document.body.append(frame, hostInput);
  vi.useFakeTimers();
});

afterEach(() => {
  keyboard.unregister(frame);
  frame.remove();
  hostInput.remove();
  vi.useRealTimers();
});

/** The page focuses something: focus moves to the iframe, and the host's window gets blur. */
function pageTakesFocus(): void {
  frame.focus();
  window.dispatchEvent(new Event("blur"));
  vi.runAllTimers();
}

describe("a panel iframe that takes focus", () => {
  it("gives it back to where focus was in the host, when sandboxed", () => {
    keyboard.register(frame, { sandboxed: true });
    hostInput.focus();
    pageTakesFocus();
    expect(document.activeElement).toBe(hostInput);
  });

  it("gives it back at once when only focusout tells (Firefox does not blur the host's window)", async () => {
    keyboard.register(frame, { sandboxed: true });
    hostInput.focus();
    vi.useRealTimers();
    frame.focus();
    // No window blur, no timers: the microtask after focusout is enough.
    await Promise.resolve();
    expect(document.activeElement).toBe(hostInput);
  });

  it("loses it when sandboxed and there is nowhere to give it back to", () => {
    keyboard.register(frame, { sandboxed: true });
    hostInput.remove();
    const blur = vi.spyOn(frame, "blur");
    pageTakesFocus();
    // jsdom does not move focus off an iframe on blur(); browsers do.
    expect(blur).toHaveBeenCalled();
  });

  it("gives it to the hidden field while a panel is being typed into", () => {
    keyboard.register(frame, { sandboxed: true });
    const target: KeyboardTarget = {
      sendKey: () => {},
      selectedText: () => "",
      cut: () => {},
      sendText: () => {},
      sendComposition: () => {},
      blurFromHost: () => {},
    };
    keyboard.focus(target);
    pageTakesFocus();
    const active = document.activeElement;
    expect(active).not.toBe(frame);
    expect(active?.tagName).toBe("TEXTAREA");
    keyboard.release(target);
  });
});

describe("IME composition", () => {
  const field = () => document.querySelector<HTMLTextAreaElement>("textarea[aria-hidden]")!;
  let target: KeyboardTarget & { calls: unknown[][] };

  beforeEach(() => {
    vi.useRealTimers();
    const calls: unknown[][] = [];
    target = {
      calls,
      sendKey: () => {},
      selectedText: () => "",
      cut: () => {},
      sendText: (text) => calls.push(["text", text]),
      sendComposition: (text, cursor) => calls.push(["composition", text, cursor]),
      blurFromHost: () => {},
    };
    keyboard.focus(target);
  });

  afterEach(() => keyboard.release(target));

  /** The IME updates the field while composing. */
  function compose(text: string, cursor = text.length): void {
    field().value = text;
    field().setSelectionRange(cursor, cursor);
    field().dispatchEvent(new InputEvent("input", { isComposing: true }));
  }

  it("sends what is being composed, then ends it before sending the committed text", () => {
    compose("に");
    compose("にほ");
    compose("にほ", 1);
    field().value = "日本";
    field().dispatchEvent(new Event("compositionend"));
    expect(target.calls).toEqual([
      ["composition", "に", 1],
      ["composition", "にほ", 2],
      ["composition", "にほ", 1],
      ["composition", "", 0],
      ["text", "日本"],
    ]);
  });

  it("ends the composition when keys stop going to the target", () => {
    compose("に");
    keyboard.release(target);
    expect(target.calls.at(-1)).toEqual(["composition", "", 0]);
  });

  it("places the hidden field at the caret, and back in the corner when released", () => {
    keyboard.placeIme({ x: 120, y: 80, height: 20 });
    expect(field().style.left).toBe("120px");
    expect(field().style.top).toBe("80px");
    expect(field().style.lineHeight).toBe("20px");
    keyboard.release(target);
    expect(field().style.left).toBe("0px");
  });
});

describe("soft keyboards", () => {
  const field = () => document.querySelector<HTMLTextAreaElement>("textarea[aria-hidden]")!;

  it("uses 16px text, so that iOS does not zoom in when the field gets focus", () => {
    new PanelKeyboard();
    const fields = document.querySelectorAll<HTMLTextAreaElement>("textarea[aria-hidden]");
    expect(fields[fields.length - 1]!.style.fontSize).toBe("16px");
    keyboard.placeIme({ x: 1, y: 1, height: 10 });
    keyboard.placeIme(null);
    expect(field().style.fontSize).toBe("16px");
  });

  it("shows only for a target that takes text, not keys alone (a button in the page)", () => {
    const target: KeyboardTarget = {
      sendKey: () => {},
      selectedText: () => "",
      cut: () => {},
      sendText: () => {},
      sendComposition: () => {},
      blurFromHost: () => {},
    };
    expect(field().getAttribute("inputmode")).toBe("none");
    keyboard.focus(target, false);
    expect(document.activeElement).toBe(field());
    expect(field().getAttribute("inputmode")).toBe("none");

    // A text field gets focus: the field is focused again, which opens the soft keyboard.
    const focus = vi.spyOn(field(), "focus");
    keyboard.setTyping(target, true);
    expect(field().hasAttribute("inputmode")).toBe(false);
    expect(focus).toHaveBeenCalled();
    expect(document.activeElement).toBe(field());

    keyboard.setTyping(target, false);
    expect(field().getAttribute("inputmode")).toBe("none");
    keyboard.focus(target);
    expect(field().hasAttribute("inputmode")).toBe(false);
    keyboard.release(target);
    expect(field().getAttribute("inputmode")).toBe("none");
  });

  it("turns Backspace and Enter that only show in beforeinput into keys", () => {
    vi.useRealTimers();
    const keys: string[] = [];
    const target: KeyboardTarget = {
      sendKey: (event) => keys.push(event.key),
      selectedText: () => "",
      cut: () => {},
      sendText: () => {},
      sendComposition: () => {},
      blurFromHost: () => {},
    };
    keyboard.focus(target);
    for (const inputType of ["deleteContentBackward", "insertLineBreak", "insertText"]) {
      field().dispatchEvent(new InputEvent("beforeinput", { inputType, cancelable: true }));
    }
    keyboard.release(target);
    expect(keys).toEqual(["Backspace", "Enter"]);
  });
});

describe("copy, cut and undo", () => {
  const field = () => document.querySelector<HTMLTextAreaElement>("textarea[aria-hidden]")!;
  let selected: string;
  const target: KeyboardTarget & { keys: string[]; cuts: number } = {
    keys: [],
    cuts: 0,
    sendKey: (event) => target.keys.push(event.key),
    selectedText: () => selected,
    cut: () => target.cuts++,
    sendText: () => {},
    sendComposition: () => {},
    blurFromHost: () => {},
  };

  beforeEach(() => {
    vi.useRealTimers();
    selected = "hello";
    target.keys = [];
    target.cuts = 0;
    keyboard.focus(target);
  });

  afterEach(() => keyboard.release(target));

  const press = (key: string) => {
    const event = new KeyboardEvent("keydown", { key, metaKey: true, cancelable: true });
    field().dispatchEvent(event);
    return event;
  };

  it("gives the hidden field the target's selection to copy, and leaves the copy to the browser", async () => {
    const event = press("c");
    expect(event.defaultPrevented).toBe(false);
    expect(field().value).toBe("hello");
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 5]);
    field().dispatchEvent(new Event("copy"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(field().value).toBe("");
    expect(target.keys).toEqual([]);
  });

  it("copies nothing when nothing is selected", () => {
    selected = "";
    const event = press("c");
    expect(event.defaultPrevented).toBe(true);
    expect(field().value).toBe("");
  });

  it("tells the target to delete what the browser cut", async () => {
    press("x");
    expect(field().value).toBe("hello");
    field().dispatchEvent(new Event("cut"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.cuts).toBe(1);
    expect(field().value).toBe("");
  });

  it("sends undo to the target as a key (its history is the agent's)", () => {
    const event = press("z");
    expect(event.defaultPrevented).toBe(true);
    expect(target.keys).toEqual(["z"]);
  });
});
