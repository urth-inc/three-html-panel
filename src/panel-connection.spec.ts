import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";
import { PanelConnection, type PanelConnectionOptions } from "./panel-connection";
import { PROTOCOL_VERSION } from "./protocol";
import { delivered } from "./test-helpers";

const ORIGIN = "https://panel.example";

let iframe: HTMLIFrameElement;
let postToFrame: Mock;
let connection: PanelConnection;
let options: {
  onConnect: Mock;
  onFrame: Mock;
  onEditing: Mock;
  onCursor: Mock;
  onOpen: Mock;
  onEditables: Mock;
  onMessage: Mock;
  onError: Mock;
};

/** A message event as the browser would dispatch it on the host's window. */
function dispatchMessage(data: unknown, origin: string, source: unknown): void {
  const event = new MessageEvent("message", { data, origin });
  Object.defineProperty(event, "source", { value: source });
  window.dispatchEvent(event);
}

const ready = (origin = ORIGIN, source: unknown = iframe.contentWindow) =>
  dispatchMessage({ type: "ready", version: PROTOCOL_VERSION }, origin, source);

/** The port the host handed to the page in its last `connect`. */
function pagePort(call = -1): MessagePort {
  const transfer = postToFrame.mock.calls.at(call)?.[2] as MessagePort[] | undefined;
  if (!transfer?.[0]) throw new Error("no port was sent");
  return transfer[0];
}

/** Replaces the connection with a new one for the iframe, with `extra` options. */
function replaceConnection(extra: Partial<PanelConnectionOptions> = {}): void {
  connection?.dispose();
  connection = new PanelConnection({
    iframe,
    origin: ORIGIN,
    width: 800,
    height: 600,
    ...options,
    ...extra,
  });
}

const frame = (seq: number, fields: Record<string, unknown> = {}) => ({
  type: "frame",
  seq,
  width: 800,
  height: 600,
  svg: "<svg/>",
  ...fields,
});

beforeEach(() => {
  iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  postToFrame = vi.fn();
  iframe.contentWindow!.postMessage = postToFrame as typeof window.postMessage;
  options = {
    onConnect: vi.fn(),
    onFrame: vi.fn(),
    onEditing: vi.fn(),
    onCursor: vi.fn(),
    onOpen: vi.fn(),
    onEditables: vi.fn(),
    onMessage: vi.fn(),
    onError: vi.fn(),
  };
  replaceConnection({ readyTimeout: 1000 });
});

afterEach(() => {
  connection.dispose();
  for (const call of postToFrame.mock.calls) (call[2] as MessagePort[] | undefined)?.[0]?.close();
  iframe.remove();
  vi.useRealTimers();
});

describe("ready", () => {
  it("answers ready from the iframe on the panel origin with a port, addressed to that origin", () => {
    ready();
    expect(postToFrame).toHaveBeenCalledTimes(1);
    const [message, targetOrigin, transfer] = postToFrame.mock.calls[0]!;
    expect(message).toEqual({ type: "connect", version: PROTOCOL_VERSION });
    expect(targetOrigin).toBe(ORIGIN);
    expect(transfer).toHaveLength(1);
    expect(connection.connected).toBe(true);
    expect(options.onConnect).toHaveBeenCalledTimes(1);
  });

  it("ignores ready from another origin", () => {
    ready("https://evil.example");
    ready(location.origin);
    expect(postToFrame).not.toHaveBeenCalled();
    expect(connection.connected).toBe(false);
  });

  it("ignores ready from another window", () => {
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    ready(ORIGIN, other.contentWindow);
    ready(ORIGIN, window);
    ready(ORIGIN, null);
    other.remove();
    expect(postToFrame).not.toHaveBeenCalled();
    expect(connection.connected).toBe(false);
    expect(options.onConnect).not.toHaveBeenCalled();
  });

  it("ignores messages that are not ready, and reports another protocol version", () => {
    dispatchMessage({ type: "frame", seq: 0 }, ORIGIN, iframe.contentWindow);
    dispatchMessage("ready", ORIGIN, iframe.contentWindow);
    expect(postToFrame).not.toHaveBeenCalled();
    dispatchMessage({ type: "ready", version: PROTOCOL_VERSION + 1 }, ORIGIN, iframe.contentWindow);
    expect(postToFrame).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledTimes(1);
  });
});

describe("ready with a sandbox", () => {
  /** Replaces the connection with one for a sandboxed iframe (or not). */
  const connectionFor = (sandboxed: boolean) => replaceConnection({ sandboxed });

  it('accepts ready from the sandboxed iframe\'s opaque origin, and addresses connect to it with "*"', () => {
    connectionFor(true);
    ready("null");
    expect(postToFrame).toHaveBeenCalledTimes(1);
    const [message, targetOrigin, transfer] = postToFrame.mock.calls[0]!;
    expect(message).toEqual({ type: "connect", version: PROTOCOL_VERSION });
    expect(targetOrigin).toBe("*");
    expect(transfer).toHaveLength(1);
  });

  it("ignores ready from the panel URL's origin when sandboxed (the page cannot be there)", () => {
    connectionFor(true);
    ready(ORIGIN);
    ready("https://evil.example");
    expect(postToFrame).not.toHaveBeenCalled();
  });

  it("ignores ready from an opaque origin, or another one, when not sandboxed", () => {
    connectionFor(false);
    ready("null");
    ready("https://evil.example");
    expect(postToFrame).not.toHaveBeenCalled();
    ready(ORIGIN);
    expect(postToFrame.mock.calls[0]![1]).toBe(ORIGIN);
  });

  it("ignores ready from another iframe or the host itself, sandboxed or not", () => {
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    for (const sandboxed of [true, false]) {
      connectionFor(sandboxed);
      const origin = sandboxed ? "null" : ORIGIN;
      ready(origin, other.contentWindow);
      ready(origin, window);
      ready(origin, null);
    }
    other.remove();
    expect(postToFrame).not.toHaveBeenCalled();
    expect(options.onConnect).not.toHaveBeenCalled();
  });
});

describe("port messages", () => {
  it("passes on valid messages and drops invalid ones", async () => {
    ready();
    const port = pagePort();
    port.postMessage(frame(0));
    port.postMessage(frame(0)); // seq did not grow
    port.postMessage(frame(1, { width: 801 }));
    port.postMessage(frame(2, { svg: 1 }));
    port.postMessage({
      type: "editing",
      editing: true,
      caret: { x: 1, y: 2, height: Number.NaN, color: "red" },
      selectedText: "",
      pointers: 0,
      typing: false,
    });
    port.postMessage({
      type: "editing",
      editing: true,
      caret: { x: 1, y: 2, height: 16, color: "red" },
      selectedText: "",
      pointers: 0,
      typing: false,
    });
    port.postMessage({ type: "cursor", cursor: "pointer" });
    port.postMessage({ type: "cursor", cursor: "url(https://evil.example/c.png), auto" });
    port.postMessage({ type: "open", url: "https://example.com/page" });
    port.postMessage({ type: "open", url: "javascript:alert(1)" });
    port.postMessage({ type: "app", data: { hello: 1 } });
    port.postMessage({ type: "nonsense" });
    port.postMessage(frame(3));
    // Messages arrive in order: once this last one is in, so is everything before it.
    // (A fixed wait is too short when the whole suite runs at once.)
    port.postMessage({ type: "app", data: "last" });
    await vi.waitFor(() => expect(options.onMessage).toHaveBeenLastCalledWith("last"));

    expect(options.onFrame.mock.calls.map(([f]) => f)).toEqual([
      { svg: "<svg/>", width: 800, height: 600 },
      { svg: "<svg/>", width: 800, height: 600 },
    ]);
    expect(options.onEditing.mock.calls).toEqual([
      [true, { x: 1, y: 2, height: 16, color: "red" }, "", 0, false],
    ]);
    expect(options.onCursor.mock.calls).toEqual([["pointer"]]);
    expect(options.onOpen.mock.calls).toEqual([["https://example.com/page"]]);
    expect(options.onMessage.mock.calls).toEqual([[{ hello: 1 }], ["last"]]);
  });

  it("closes the previous port when a new document's agent says ready", async () => {
    ready();
    const first = pagePort();
    ready();
    const second = pagePort();
    first.postMessage({ type: "app", data: "stale" });
    second.postMessage({ type: "app", data: "fresh" });
    await delivered(10);
    expect(options.onMessage.mock.calls).toEqual([["fresh"]]);
    expect(options.onConnect).toHaveBeenCalledTimes(2);
  });

  it("starts seq over with each connection", async () => {
    ready();
    pagePort().postMessage(frame(7));
    await delivered(10);
    ready();
    pagePort().postMessage(frame(0));
    await delivered(10);
    expect(options.onFrame).toHaveBeenCalledTimes(2);
  });

  it("sends host messages through the port only", async () => {
    connection.send({ type: "blur" });
    ready();
    const port = pagePort();
    const received: unknown[] = [];
    port.onmessage = (event) => received.push(event.data);
    connection.send({ type: "blur" });
    await delivered(10);
    expect(received).toEqual([{ type: "blur" }]);
    expect(postToFrame).toHaveBeenCalledTimes(1);
  });
});

describe("timeout", () => {
  it("reports an error if no agent says ready in time", () => {
    vi.useFakeTimers();
    replaceConnection({ readyTimeout: 1000 });
    vi.advanceTimersByTime(999);
    expect(options.onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(options.onError).toHaveBeenCalledTimes(1);
  });

  /** Fakes only the timeout's timers, so that ports still deliver. */
  function withTimeoutTimers(): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    replaceConnection({ readyTimeout: 1000 });
  }
  const portDelivery = () => new Promise((resolve) => setImmediate(resolve));

  /** The agent's side of the last port: answers pings like a live agent does. */
  function answerPings(): MessagePort {
    const port = pagePort();
    port.onmessage = (event) => {
      if ((event.data as { type: string }).type === "ping") port.postMessage({ type: "pong" });
    };
    return port;
  }

  it("keeps the connection after a load when the agent answers the ping", async () => {
    withTimeoutTimers();
    ready();
    answerPings();
    iframe.dispatchEvent(new Event("load"));
    for (let i = 0; i < 5; i++) await portDelivery();
    vi.advanceTimersByTime(5000);
    expect(options.onError).not.toHaveBeenCalled();
  });

  it("times out after a load to a page without the agent", async () => {
    withTimeoutTimers();
    ready();
    answerPings();
    iframe.dispatchEvent(new Event("load"));
    for (let i = 0; i < 5; i++) await portDelivery();
    // The iframe navigates to a page without the agent: the old port is dead.
    pagePort().close();
    iframe.dispatchEvent(new Event("load"));
    for (let i = 0; i < 5; i++) await portDelivery();
    vi.advanceTimersByTime(1000);
    expect(options.onError).toHaveBeenCalledTimes(1);
    expect(connection.connected).toBe(false);
  });

  it("is not fooled when a page's ready arrives after its load", async () => {
    withTimeoutTimers();
    ready();
    answerPings();
    // The next page: load first, then its ready.
    pagePort().close();
    iframe.dispatchEvent(new Event("load"));
    ready();
    answerPings();
    for (let i = 0; i < 5; i++) await portDelivery();
    vi.advanceTimersByTime(5000);
    expect(options.onError).not.toHaveBeenCalled();

    // Then a page without the agent must still time out.
    pagePort().close();
    iframe.dispatchEvent(new Event("load"));
    for (let i = 0; i < 5; i++) await portDelivery();
    vi.advanceTimersByTime(1000);
    expect(options.onError).toHaveBeenCalledTimes(1);
  });
});

it("sends the hover opt-out on every connection", () => {
  replaceConnection({ optimizeHover: false });
  ready();
  ready();
  expect(postToFrame).toHaveBeenCalledTimes(2);
  for (const [message] of postToFrame.mock.calls)
    expect(message).toMatchObject({ type: "connect", optimizeHover: false });
});
