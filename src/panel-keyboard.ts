// Keyboard input for panels, and keeping focus away from the panel iframes.
//
// Keys are never typed into the iframe directly. A hidden <textarea> in the
// host page takes them (including IME composition and paste) and forwards them
// to the panel whose text field has focus. This works the same in every
// browser, and the iframe never needs to hold focus: when focus leaves an
// iframe, browsers blur the field focused inside it, so a field could not stay
// focused while the host keeps focus.
//
// Focus can still end up in an iframe (an element the browser focuses on its
// own, before the panel took over the page's focus handling, or a page that
// calls focus() to take the keyboard). Whenever a panel iframe has focus, it is
// put back, so keys keep reaching the host. A page that is not trusted
// (sandboxed) must never keep it: then the iframe is blurred when there is
// nothing to give focus back to.
//
// The hidden field also has focus while a button or a link in a panel has it
// (Enter, Space and Tab act on those), but no text goes in then: inputmode=none
// keeps the soft keyboard of a phone from showing for it.

export interface KeyboardTarget {
  sendKey(event: KeyboardEvent): void;
  /** The text selected in the target, to copy or cut; "" if none. */
  selectedText(): string;
  /** The selected text was cut to the clipboard: delete it in the target. */
  cut(): void;
  sendText(text: string): void;
  /** Text being composed with the IME, and its caret within it; "" when composition ends. */
  sendComposition(text: string, cursor: number): void;
  /** Focus left the panel from the host side (the user clicked elsewhere). */
  blurFromHost(): void;
}

/** Keys whose default action the panel reimplements (see input/input.ts); the rest arrive as text. */
const FORWARDED_KEYS = new Set([
  "Backspace",
  "Delete",
  "Enter",
  "Escape",
  "Tab",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
/** beforeinput edits that soft keyboards make without telling which key it was. */
const SOFT_KEYBOARD_KEYS: Record<string, string> = {
  deleteContentBackward: "Backspace",
  deleteContentForward: "Delete",
  insertLineBreak: "Enter",
  insertParagraph: "Enter",
};

/**
 * Shortcuts left to the browser, acting on the hidden field: they need the
 * clipboard, which only the browser's own copy, cut and paste can use. For copy
 * and cut, the field is given the target's selected text first. Undo goes to
 * the target as a key (its history is the agent's).
 */
const CLIPBOARD_SHORTCUTS = new Set(["c", "v", "x"]);

export class PanelKeyboard {
  private readonly field = document.createElement("textarea");
  /** Panel iframes, and whether each is sandboxed (its page is not trusted). */
  private readonly frames = new Map<HTMLIFrameElement, { sandboxed: boolean }>();
  private target: KeyboardTarget | null = null;
  /** Text goes into the target: a soft keyboard may show (the field has no inputmode=none). */
  private softKeyboard = false;
  /**
   * The field got its focus while a tap was handled (see focus()), and the soft
   * keyboard iOS showed for it is still up. Focus it got otherwise (a page that
   * focuses a field on its own) showed none; nor does it once the keyboard is
   * put away, which leaves the field focused on an iPad.
   */
  private focusedByTap = false;
  /** The target that was last sent composed text, until it is told composition ended. */
  private composingFor: KeyboardTarget | null = null;
  private lastHostFocus: HTMLElement | null = null;

  constructor(container: HTMLElement = document.body) {
    const field = this.field;
    field.setAttribute("aria-hidden", "true");
    field.tabIndex = -1;
    field.autocomplete = "off";
    field.spellcheck = false;
    field.setAttribute("autocapitalize", "off");
    // One line, so that the caret (and the IME's candidate window, which
    // follows it) moves along the line rather than down a 1px-wide column.
    field.setAttribute("wrap", "off");
    // No soft keyboard until a text field in a panel has focus (see focus()).
    field.setAttribute("inputmode", "none");
    Object.assign(field.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "1px",
      height: "1px",
      opacity: "0",
      pointerEvents: "none",
      resize: "none",
      // iOS zooms the page into a field with text under 16px when it gets focus.
      fontSize: "16px",
    });
    container.appendChild(field);

    field.addEventListener("keydown", this.onKeyDown);
    // Soft keyboards often send keydown with no key (Unidentified, keyCode 229)
    // for Backspace and Enter; what they do shows in beforeinput instead.
    field.addEventListener("beforeinput", this.onBeforeInput);
    field.addEventListener("input", (event) => {
      if ((event as InputEvent).isComposing) this.sendComposition();
      else this.flush();
    });
    // After the browser copied (or cut) the field's text to the clipboard. A cut
    // also empties the field, which input above ignores (nothing to send).
    field.addEventListener("copy", () => setTimeout(() => (field.value = ""), 0));
    field.addEventListener("cut", () =>
      setTimeout(() => {
        field.value = "";
        this.target?.cut();
      }, 0),
    );
    field.addEventListener("compositionend", () => {
      this.endComposition();
      this.flush();
    });
    field.addEventListener("blur", () => {
      this.focusedByTap = false;
      setTimeout(this.checkFocus, 0);
    });
    // A soft keyboard shrinks the visual viewport while it is up: back to the
    // window's height, it is gone (or there was none: then a tap only focuses
    // the field again).
    window.visualViewport?.addEventListener("resize", () => {
      const viewport = window.visualViewport!;
      if (viewport.height * viewport.scale >= window.innerHeight - 1) this.focusedByTap = false;
    });

    document.addEventListener(
      "focusin",
      (event) => {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          target !== field &&
          !this.frames.has(target as HTMLIFrameElement)
        ) {
          this.lastHostFocus = target;
        }
      },
      true,
    );
    // Focus leaving for a panel shows as blur on the host's window (Chrome,
    // Safari), or only as focusout of the element that had it (Firefox).
    window.addEventListener("blur", () => setTimeout(this.checkFocus, 0));
    document.addEventListener(
      "focusout",
      () => {
        // A panel that keeps taking focus gets each key typed until focus is
        // back: take it back as soon as possible (Firefox allows it here). Only
        // then; other moves are still in transit now, and are looked at later.
        queueMicrotask(() => {
          if (this.frameFocused()) this.checkFocus();
        });
        setTimeout(this.checkFocus, 0);
      },
      true,
    );
  }

  /** Watches a panel iframe so that it never keeps focus. */
  register(frame: HTMLIFrameElement, options: { sandboxed?: boolean } = {}): void {
    this.frames.set(frame, { sandboxed: options.sandboxed === true });
  }

  unregister(frame: HTMLIFrameElement): void {
    this.frames.delete(frame);
  }

  /**
   * Starts sending keys to `target`. `typing`: text goes in (a text field or an
   * editable has focus), so a soft keyboard shows; false for keys only (a
   * button or a link has focus), and none shows. `tap`: this runs while a tap
   * is handled, the only time iOS opens its soft keyboard for focus moved.
   */
  focus(target: KeyboardTarget, typing = true, tap = false): void {
    if (target !== this.target) this.endComposition();
    this.target = target;
    this.field.value = "";
    this.setSoftKeyboard(typing, tap);
    // Focused already, but not by a tap (the page focused a field on its own,
    // as it loaded): no soft keyboard showed for it. A tap focuses it again,
    // which opens one.
    if (tap && typing && !this.focusedByTap && document.activeElement === this.field)
      this.field.blur();
    if (document.activeElement !== this.field) this.focusField(tap);
  }

  /** Focuses the field; `tap`: while a tap is handled (see focusedByTap). */
  private focusField(tap: boolean): void {
    this.field.focus({ preventScroll: true });
    this.focusedByTap = tap;
  }

  /** Whether text goes into `target` now, if keys go to it (see focus()). */
  setTyping(target: KeyboardTarget, typing: boolean): void {
    if (this.target === target) this.setSoftKeyboard(typing);
  }

  /** Whether keys go to `target` now. */
  isTarget(target: KeyboardTarget): boolean {
    return this.target === target;
  }

  /** Stops sending keys to `target`, if it is the current one. */
  release(target: KeyboardTarget): void {
    if (this.target !== target) return;
    this.endComposition();
    this.target = null;
    this.placeIme(null);
    this.setSoftKeyboard(false);
    if (document.activeElement === this.field) this.field.blur();
  }

  private setSoftKeyboard(shown: boolean, tap = false): void {
    if (shown === this.softKeyboard) return;
    this.softKeyboard = shown;
    const field = this.field;
    if (!shown) {
      // No text goes in any more: what was being composed is not.
      this.endComposition();
      field.setAttribute("inputmode", "none");
      return;
    }
    field.removeAttribute("inputmode");
    // A soft keyboard opens when the field gets focus, not when its inputmode
    // changes: focus it again (from a button to a text field in the page). iOS
    // opens it only for focus moved while a touch is handled, so there only
    // when this runs for a tap (HtmlPanel.focusForTyping).
    if (document.activeElement === field) {
      field.blur();
      this.focusField(tap);
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.target || event.isComposing || event.keyCode === 229) return;
    const shortcut = (event.ctrlKey || event.metaKey) && event.key.length === 1;
    const letter = event.key.toLowerCase();
    if (shortcut && CLIPBOARD_SHORTCUTS.has(letter)) {
      if (letter === "v") return;
      const text = this.target.selectedText();
      // Nothing selected: copy nothing (not whatever the field holds).
      if (!text) {
        event.preventDefault();
        return;
      }
      this.field.value = text;
      this.field.select();
      return;
    }
    if (FORWARDED_KEYS.has(event.key) || shortcut) {
      event.preventDefault();
      this.target.sendKey(event);
    }
  };

  /**
   * Moves the hidden field to where the target's caret is on screen (client
   * pixels), so that the IME shows its candidate window next to it rather than
   * in a corner of the page. Null puts it back in the corner.
   */
  placeIme(caret: { x: number; y: number; height: number } | null): void {
    const style = this.field.style;
    if (!caret) {
      Object.assign(style, {
        left: "0",
        top: "0",
        height: "1px",
        fontSize: "16px",
        lineHeight: "",
      });
      return;
    }
    const height = Math.max(1, caret.height);
    Object.assign(style, {
      left: `${caret.x}px`,
      top: `${caret.y}px`,
      height: `${height}px`,
      // The candidate window goes below the line: make the line as tall as the caret.
      fontSize: `${Math.max(1, height * 0.8)}px`,
      lineHeight: `${height}px`,
    });
  }

  /** Sends what is being composed: the field holds only that (committed text is flushed out). */
  private sendComposition(): void {
    const target = this.target;
    if (!target) return;
    const text = this.field.value;
    const cursor = Math.min(text.length, this.field.selectionEnd ?? text.length);
    this.composingFor = target;
    target.sendComposition(text, cursor);
  }

  private endComposition(): void {
    const target = this.composingFor;
    this.composingFor = null;
    target?.sendComposition("", 0);
  }

  private readonly onBeforeInput = (event: InputEvent) => {
    const key = SOFT_KEYBOARD_KEYS[event.inputType];
    if (!key || !this.target || event.isComposing) return;
    event.preventDefault();
    this.target.sendKey(new KeyboardEvent("keydown", { key }));
  };

  private flush(): void {
    const text = this.field.value;
    this.field.value = "";
    if (text && this.target) this.target.sendText(text);
  }

  private frameFocused(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLIFrameElement && this.frames.has(active);
  }

  private readonly checkFocus = () => {
    const active = document.activeElement;
    const frame = active instanceof HTMLIFrameElement ? this.frames.get(active) : undefined;
    if (frame) {
      // A panel took focus: give it back, to the hidden field while typing into
      // a panel, or else where focus was in the host.
      if (this.target) this.focusField(false);
      else if (this.lastHostFocus?.isConnected) this.lastHostFocus.focus({ preventScroll: true });
      // With nowhere to go, a sandboxed panel loses focus all the same. A
      // trusted one is left the hidden field, as before (the page's focus is
      // virtual anyway, see input/input.ts).
      else if (frame.sandboxed) (active as HTMLIFrameElement).blur();
      else this.focusField(false);
      return;
    }
    if (!this.target || active === this.field) return;
    if (!active || active === document.body) {
      // Focus is in transit (a panel iframe in another process takes it
      // asynchronously), or the user clicked something that cannot be focused.
      // Neither ends editing; pressing outside the panels in the scene does.
      if (document.hasFocus()) this.focusField(false);
      return;
    }
    if (document.hasFocus()) {
      // The user moved focus to something else in the host (a chat box, say).
      const target = this.target;
      this.target = null;
      target.blurFromHost();
    }
  };
}

let shared: PanelKeyboard | null = null;

/** One keyboard is enough for any number of panels. */
export function getSharedKeyboard(): PanelKeyboard {
  return (shared ??= new PanelKeyboard());
}
