// What the input specs share. Not part of the library (only specs import it).
import type { KeyInput } from "./editing";
import type { InputSynthesizer } from "./input";

export type Modifiers = Partial<Omit<KeyInput, "key">>;

/** A key with no modifiers but those given. */
export const keyInput = (key: string, modifiers: Modifiers = {}): KeyInput => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...modifiers,
});

/** A press far away, so that the next test's first press is not a double one. */
export function pressFarAway(input: InputSynthesizer): void {
  input.handle({ type: "pointer", kind: "down", x: 5000, y: 5000 });
  input.handle({ type: "pointer", kind: "up", x: 5000, y: 5000 });
}

/** WheelEvent that drops `view`, as eventsWithoutView() makes the others; for the rest of the spec file. */
export function wheelWithoutView(): void {
  const Base = WheelEvent;
  globalThis.WheelEvent = class extends Base {
    constructor(type: string, { view: _view, ...init }: WheelEventInit = {}) {
      super(type, init);
    }
  };
}
