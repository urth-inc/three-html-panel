// A web page shown as an interactive panel in a three.js scene.
//
// The page is loaded into an iframe, which gives it its own document, URL and
// globals: an existing app (a SPA with its own router and CSS) can be placed in
// 3D without clashing with the host. The page loads the agent (agent/entry.ts),
// which captures it and replays input in it; the host only exchanges messages
// with the agent (panel-connection.ts) and never reads the page's document, so
// the page can be on another origin.
//
// With `sandbox: true`, the iframe is sandboxed without allow-same-origin: the
// page runs on an opaque origin and cannot reach the host's cookies, storage or
// document, nor take the keyboard. It is not trusted; everything it sends is
// checked. Without it, the page runs as an ordinary page of its origin (a page
// on the host's origin with the host's privileges): only show pages you trust,
// from URLs you choose, never from user input or synced room state.

import {
  BackSide,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Plane,
  PlaneGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type Camera,
  type Vector4,
  type Object3DEventMap,
  type Ray,
  type WebGLRenderer,
} from "three";
import { parseCssColor, type SrgbColor } from "./css-color";
import { FrameRenderer } from "./frame-renderer";
import { PanelConnection } from "./panel-connection";
import { getSharedKeyboard, type KeyboardTarget, type PanelKeyboard } from "./panel-keyboard";
import { MAX_PAGE_LENGTH, type HostMessage } from "./protocol";
import type { Box, Caret, PointerInput, PointerKind } from "./types";

export interface HtmlPanelOptions {
  /** The page to show. It must load the agent with this page's origin as its host origin. */
  url: string | URL;
  /**
   * Runs the page in a sandboxed iframe (allow-scripts allow-forms allow-popups,
   * never allow-same-origin), for pages that are not trusted. Default false.
   */
  sandbox?: boolean;
  /** The page's layout width in CSS pixels. */
  width?: number;
  /** The page's layout height in CSS pixels. */
  height?: number;
  /** The length of the panel's longer side in world units (metres). */
  size?: number;
  /** Texture pixels per CSS pixel. */
  pixelRatio?: number;
  /** Painted under pages that leave their background transparent. */
  background?: string;
  /** Where the iframe lives in the host document. */
  container?: HTMLElement;
  keyboard?: PanelKeyboard;
  /** How long to wait for the page's agent before giving up, in milliseconds. */
  readyTimeout?: number;
  /**
   * Opens a link the user followed in the page (or a URL the page passed to
   * window.open()): an http(s) URL, only right after the user pressed the
   * panel or a key in it. By default, in a new tab of the host's browser.
   */
  onLink?: (url: URL, panel: HtmlPanel) => void;
  /** Data the page sent with `sendToHost()` (agent/page.ts). Check it before use. */
  onMessage?: (data: unknown) => void;
  onError?: (error: Error) => void;
  /**
   * Stops the page's capture while the panel is not drawn facing the camera
   * (out of view, seen from behind, hidden, out of the scene) for a second, and
   * captures it again the first time it is. Not drawn for REST_AFTER_MS, the
   * panel also rests: the page is not painted, and the canvas and texture let
   * go of their memory. Default true. Turn it off where the panel takes input
   * without being rendered (no WebGL).
   */
  pauseWhenHidden?: boolean;
  /**
   * Skips captures for unpressed pointer moves when hover state is unchanged.
   * Default true. Set false for pages that draw to canvas or change other
   * non-DOM visual state in pointer handlers.
   */
  optimizeHover?: boolean;
}

const CARET_BLINK_MS = 530;
/** Not drawn facing the camera for this long, a panel counts as hidden. */
export const HIDDEN_AFTER_MS = 1000;
/**
 * Hidden for this long, a panel rests: its page is not painted (the iframe is
 * moved off screen and made invisible; the page runs on and keeps its state),
 * and the canvas and the texture let go of their memory (see
 * FrameRenderer.release). Not display: none, which takes the page's layout
 * away: a page loaded meanwhile would start at 0x0, and boxes and scroll
 * offsets would read 0. Longer than a glance away, so that turning back is
 * not a redraw each time.
 */
export const REST_AFTER_MS = 10_000;
/** How often whether a panel is hidden, or far, is decided. */
const VIEW_CHECK_MS = HIDDEN_AFTER_MS / 4;
/**
 * Drawn smaller than this by every view for VIEW_CHECK_MS (screen px per page
 * CSS px, along its larger side), a panel counts as far: its page is captured
 * at most every FAR_PACE_MS. Drawn above NEAR_SCALE by any view, it counts as
 * near again at once. Between the two it stays as it was, so that it does not
 * flip at the edge.
 */
export const FAR_SCALE = 0.25;
export const NEAR_SCALE = 0.3;
export const FAR_PACE_MS = 200;
/**
 * The panel's texture is drawn at its pixelRatio, or at a half or a quarter of
 * it while every view draws the panel at most this much of that resolution
 * (device px per page CSS px, along its larger side, for VIEW_CHECK_MS): fewer
 * pixels to draw and upload, and still at least as many as the screen shows.
 * Drawn denser than the resolution by any view, it goes back up at once.
 */
export const LOWER_RESOLUTION_AT = 0.8;

/**
 * The sandbox of an untrusted panel. Never allow-same-origin: with it, a page on
 * the host's origin could reach into the host and remove its own sandbox. Nor
 * allow-popups-to-escape-sandbox. Not configurable on purpose.
 */
export const PANEL_SANDBOX = "allow-scripts allow-forms allow-popups";

/**
 * How long after the user acts on a panel (presses it, or a key while it has the
 * keyboard) its page may take the keyboard (sandboxed pages: by focusing a text
 * field, which the agent reports as editing) or open a link.
 */
const USER_ACTION_MS = 1000;
/** A press's slop is at most this much of the page's larger side (see slopFor). */
const MAX_SLOP = 0.1;
/** If the page never answers a tap that took the keyboard (it hangs), the keyboard is let go after this. */
const TAP_ANSWER_TIMEOUT_MS = 5000;

/**
 * Texture pixels per CSS pixel. Phones get 1: drawing and uploading a page at
 * 2x costs them about four times as much, and their screens show the panel small.
 */
export function defaultPixelRatio(): number {
  const phone =
    typeof matchMedia === "function" &&
    matchMedia("(pointer: coarse)").matches &&
    Math.min(screen.width, screen.height) < 768;
  return phone ? 1 : 2;
}

/** Opens a link in a new tab, without giving the new page a way back to the host. */
function openInNewTab(url: URL): void {
  window.open(url.href, "_blank", "noopener,noreferrer");
}

/** The caret's color before the page has sent one that can be read: the usual one, opaque black. */
const DEFAULT_CARET_COLOR: SrgbColor = { r: 0, g: 0, b: 0, alpha: 1 };

export interface HtmlPanelEventMap extends Object3DEventMap {
  /** `cursor` changed. */
  cursorchange: {};
}

/** A camera of an ArrayCamera (the eyes in WebXR), which draws into its own viewport of the canvas. */
const hasViewport = (camera: Camera): camera is Camera & { viewport: Vector4 } =>
  (camera as Camera & { viewport?: Vector4 }).viewport !== undefined;

export class HtmlPanel
  extends Mesh<PlaneGeometry, MeshBasicMaterial, HtmlPanelEventMap>
  implements KeyboardTarget
{
  readonly iframe = document.createElement("iframe");
  /** The origin the page is expected on; messages from anywhere else are ignored. */
  readonly origin: string;
  readonly sandboxed: boolean;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly worldWidth: number;
  readonly worldHeight: number;
  /** The mouse cursor the page asks for where the pointer is, as a CSS keyword. */
  cursor = "default";

  private readonly renderer: FrameRenderer;
  private readonly keyboard: PanelKeyboard;
  private readonly back: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly caret: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly caretTimer: number;
  private readonly viewTimer: number;
  private readonly pauseWhenHidden: boolean;
  /** When the panel was last drawn facing the camera. */
  private drawnAt = performance.now();
  /** Whether the page was told the panel is drawn (see pauseWhenHidden). */
  private shown = true;
  /** Hidden for REST_AFTER_MS: its iframe is not painted, and its canvas let go of. */
  private resting = false;
  /** Whether the page was told the panel is drawn small (see FAR_SCALE). */
  private far = false;
  /** The largest scale any view drew the panel at since the pace was last decided; -1: none drew it. */
  private largestScale = -1;
  /** The same in device pixels (a view's own pixel ratio applied), for the resolution. */
  private largestDensity = -1;
  /** The texture's resolutions, highest first: the pixelRatio, a half and a quarter of it. */
  private readonly resolutions: readonly number[];
  /** Which of them the texture is drawn at. */
  private resolution = 0;
  private readonly onError: (error: Error) => void;
  private readonly connection: PanelConnection;
  private editing = false;
  /** A text field or editable has focus, as the page reports: text can be typed. */
  private typing = false;
  /** The text selected in the page's field, as the page reported it last. */
  private selected = "";
  /** The caret the page reported last, in its CSS pixels, for placing the IME. */
  private caretBox: Caret | null = null;
  /**
   * The last visible caret color that could be read. A color that cannot be
   * read keeps it, rather than turning black and vanishing on a dark page.
   */
  private caretColor: SrgbColor = DEFAULT_CARET_COLOR;
  /**
   * The caret color string the page sent last, and what it was read as (null:
   * it could not be): it seldom changes, so it is not read again.
   */
  private lastCaretParse: { css: string; color: SrgbColor | null } | null = null;
  /** Where the page's text fields are (CSS px), as it reported last. */
  private editables: Box[] = [];
  /** What drove the pointer last: the IME is placed at the caret only for a mouse. */
  private lastInput: PointerInput = "mouse";
  private keyboardTimer = 0;
  /**
   * Presses and releases sent to the current document, and the count a tap's
   * answer must have reached. Not moves or leaves: the page answers a release.
   */
  private pointersSent = 0;
  private tapAnswerAt: number | null = null;
  /** Where the IME was last placed, to place it again only when it moves. */
  private imePlacement = "";
  private readonly scratch = new Vector3();
  private readonly toCamera = new Vector3();
  private readonly corners = [new Vector3(), new Vector3(), new Vector3()] as const;
  private readonly screenSize = new Vector2();
  private readonly worldPosition = new Vector3();
  /** Until when the page may act on the user's behalf: shortly after the user acted on the panel. */
  private userActionUntil = -Infinity;
  /** A press on the panel is held (between down and up): dragging is acting on it too. */
  private pressing = false;

  constructor(options: HtmlPanelOptions) {
    const url = new URL(options.url, location.href);
    if (url.origin === "null") {
      // data:, blob: and the like have no origin to check messages against.
      throw new Error(`HtmlPanel needs a page with an origin: ${url.href}`);
    }
    const pageWidth = options.width ?? 800;
    const pageHeight = options.height ?? 600;
    for (const length of [pageWidth, pageHeight]) {
      if (!Number.isInteger(length) || length <= 0 || length > MAX_PAGE_LENGTH) {
        throw new Error(`HtmlPanel page sizes must be whole numbers from 1 to ${MAX_PAGE_LENGTH}`);
      }
    }
    const size = options.size ?? 1;
    const scale = size / Math.max(pageWidth, pageHeight);
    const pixelRatio = options.pixelRatio ?? defaultPixelRatio();
    const renderer = new FrameRenderer({
      width: pageWidth,
      height: pageHeight,
      pixelRatio,
      background: options.background ?? "#ffffff",
    });
    super(
      new PlaneGeometry(pageWidth * scale, pageHeight * scale),
      new MeshBasicMaterial({ map: renderer.texture, toneMapped: false }),
    );
    this.renderer = renderer;
    this.resolutions = [pixelRatio, pixelRatio / 2, pixelRatio / 4];
    this.origin = url.origin;
    this.sandboxed = options.sandbox === true;
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    this.worldWidth = pageWidth * scale;
    this.worldHeight = pageHeight * scale;
    this.keyboard = options.keyboard ?? getSharedKeyboard();
    this.onError =
      options.onError ?? ((error) => console.warn("[three-html-panel]", error.message));

    // A plain back, so the page is not seen mirrored from behind.
    this.back = new Mesh(this.geometry, new MeshBasicMaterial({ color: 0x3a3f4b, side: BackSide }));
    this.back.raycast = () => {};
    this.add(this.back);

    // The caret is drawn on top of the texture, so blinking does not re-upload it.
    this.caret = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ side: DoubleSide, depthWrite: false, transparent: true }),
    );
    this.caret.raycast = () => {};
    this.caret.visible = false;
    this.caret.renderOrder = 1;
    this.add(this.caret);
    this.caretTimer = window.setInterval(() => {
      if (this.editing && this.caret.userData.hasCaret) this.caret.visible = !this.caret.visible;
    }, CARET_BLINK_MS);

    this.pauseWhenHidden = options.pauseWhenHidden ?? true;
    this.viewTimer = window.setInterval(() => {
      const hiddenFor = performance.now() - this.drawnAt;
      if (this.pauseWhenHidden && this.shown && hiddenFor > HIDDEN_AFTER_MS) this.setShown(false);
      if (!this.shown && !this.resting && hiddenFor > REST_AFTER_MS) this.setResting(true);
      this.decidePace();
    }, VIEW_CHECK_MS);

    this.connection = new PanelConnection({
      iframe: this.iframe,
      origin: this.origin,
      sandboxed: this.sandboxed,
      width: pageWidth,
      height: pageHeight,
      readyTimeout: options.readyTimeout,
      optimizeHover: options.optimizeHover,
      onConnect: () => {
        this.pressing = false;
        this.editables = [];
        this.pointersSent = 0;
        this.tapAnswerAt = null;
        this.setEditing(false, null, false);
        this.setCursor("default");
        // A new document starts shown.
        if (!this.shown) this.send({ type: "visibility", visible: false });
        if (this.far) this.send({ type: "pace", intervalMs: FAR_PACE_MS });
      },
      onFrame: (frame) => this.renderer.submit(frame),
      onEditing: (editing, caret, selectedText, pointers, typing) => {
        this.selected = editing ? selectedText : "";
        this.answerTap(editing, pointers);
        this.setEditing(editing, caret, typing);
      },
      onCursor: (cursor) => this.setCursor(cursor),
      onEditables: (boxes) => (this.editables = boxes),
      onOpen: (url) => {
        // Not on its own: a page cannot open tabs, sandboxed or not, unless the user just acted on it.
        if (performance.now() > this.userActionUntil) return;
        (options.onLink ?? openInNewTab)(new URL(url), this);
      },
      onMessage: (data) => options.onMessage?.(data),
      onError: (error) => {
        this.renderer.clear();
        this.setEditing(false, null, false);
        this.onError(error);
      },
    });
    this.openFrame(url, options.container ?? document.body);
  }

  private openFrame(url: URL, container: HTMLElement): void {
    const iframe = this.iframe;
    // Before src: a page that starts loading without the sandbox runs without it.
    if (this.sandboxed) iframe.setAttribute("sandbox", PANEL_SANDBOX);
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    iframe.title = "panel";
    // The iframe must stay inside the viewport: browsers throttle rendering and
    // timers of iframes that are off screen, which would freeze the panel. It is
    // transparent, ignores the pointer and sits behind everything instead.
    // (Resting, it is off screen on purpose: see REST_AFTER_MS.)
    Object.assign(iframe.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: `${this.pageWidth}px`,
      height: `${this.pageHeight}px`,
      border: "0",
      opacity: "0",
      pointerEvents: "none",
      zIndex: "-1",
      colorScheme: "light",
    });
    this.keyboard.register(iframe, { sandboxed: this.sandboxed });
    iframe.src = url.href;
    container.appendChild(iframe);
  }

  /** Drawn for `camera`: seen, if from the front (the back is a plain plane). */
  private drawnFor(camera: Camera): void {
    const normal = this.scratch.set(0, 0, 1).transformDirection(this.matrixWorld);
    const toCamera = this.toCamera.setFromMatrixPosition(camera.matrixWorld);
    toCamera.sub(this.worldPosition.setFromMatrixPosition(this.matrixWorld));
    if (normal.dot(toCamera) <= 0) return;
    this.drawnAt = performance.now();
    if (!this.shown) this.setShown(true);
  }

  /**
   * Notes how large a view draws the panel. Several views may draw it each
   * frame (a minimap, a mirror, two eyes): it is near as soon as one draws it
   * large, and far only once none has for a while (decidePace).
   */
  private paceFor(renderer: WebGLRenderer, camera: Camera): void {
    const scale = this.screenScale(renderer, camera);
    this.largestScale = Math.max(this.largestScale, scale);
    if (this.far && scale >= NEAR_SCALE) this.setFar(false);
    // A camera of a stereo pair is measured in its viewport's pixels already.
    const density = hasViewport(camera) ? scale : scale * renderer.getPixelRatio();
    this.largestDensity = Math.max(this.largestDensity, density);
    // Drawn denser than the texture: up at once, to the lowest resolution that is enough.
    if (density > this.resolutions[this.resolution]!) {
      let level = this.resolution;
      while (level > 0 && density > this.resolutions[level]!) level--;
      this.setResolution(level);
    }
  }

  /** Far, if every view since the last check drew the panel small. Not drawn at all, it is left as it was. */
  private decidePace(): void {
    const scale = this.largestScale;
    this.largestScale = -1;
    if (scale >= 0 && !this.far && scale < FAR_SCALE) this.setFar(true);
    const density = this.largestDensity;
    this.largestDensity = -1;
    if (density < 0) return;
    // Down to the lowest resolution every view drew it well under.
    let level = this.resolution;
    while (
      level < this.resolutions.length - 1 &&
      density <= this.resolutions[level + 1]! * LOWER_RESOLUTION_AT
    )
      level++;
    if (level !== this.resolution) this.setResolution(level);
  }

  private setResolution(level: number): void {
    this.resolution = level;
    this.renderer.setResolution(this.resolutions[level]!);
  }

  private setFar(far: boolean): void {
    this.far = far;
    this.send({ type: "pace", intervalMs: far ? FAR_PACE_MS : 0 });
  }

  /**
   * How large the panel is drawn: screen px per page CSS px, along its larger
   * side on screen (seen at an angle, one side shrinks). Infinity when a corner
   * is behind the camera: then it is close.
   */
  private screenScale(renderer: WebGLRenderer, camera: Camera): number {
    // A camera of a stereo pair (WebXR) draws into its own part of the canvas.
    const size = hasViewport(camera)
      ? this.screenSize.set(camera.viewport.z, camera.viewport.w)
      : renderer.getSize(this.screenSize);
    const [topLeft, topRight, bottomLeft] = this.corners;
    if (!this.projectCorner(-0.5, 0.5, topLeft, camera)) return Infinity;
    if (!this.projectCorner(0.5, 0.5, topRight, camera)) return Infinity;
    if (!this.projectCorner(-0.5, -0.5, bottomLeft, camera)) return Infinity;
    const width = Math.hypot(
      ((topRight.x - topLeft.x) * size.x) / 2,
      ((topRight.y - topLeft.y) * size.y) / 2,
    );
    const height = Math.hypot(
      ((bottomLeft.x - topLeft.x) * size.x) / 2,
      ((bottomLeft.y - topLeft.y) * size.y) / 2,
    );
    return Math.max(width / this.pageWidth, height / this.pageHeight);
  }

  /** A corner of the panel (-0.5 to 0.5 across) in the camera's clip space; false if behind it or beyond its range. */
  private projectCorner(x: number, y: number, target: Vector3, camera: Camera): boolean {
    target.set(x * this.worldWidth, y * this.worldHeight, 0);
    this.localToWorld(target).project(camera);
    return target.z >= -1 && target.z <= 1;
  }

  private setShown(shown: boolean): void {
    this.shown = shown;
    // Laid out again before the page is told it is seen (it captures then).
    if (shown && this.resting) this.setResting(false);
    this.renderer.setPaused(!shown);
    this.send({ type: "visibility", visible: shown });
  }

  private setResting(resting: boolean): void {
    this.resting = resting;
    // Off screen, the browser also throttles its rendering and timers (see openFrame).
    this.iframe.style.left = resting ? `${-2 * this.pageWidth}px` : "0";
    this.iframe.style.visibility = resting ? "hidden" : "";
    if (resting) this.renderer.release();
  }

  private setCursor(cursor: string): void {
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.dispatchEvent({ type: "cursorchange" });
  }

  /** `typing`: text goes in (a text field or an editable has focus), not only keys (a button). */
  private setEditing(editing: boolean, caret: Caret | null, typing: boolean): void {
    if (editing && !this.editing && !this.mayTakeKeyboard()) {
      // A sandboxed page focused a field on its own (or says it did: the page
      // runs the agent and can send anything). It must not take the keys the
      // user is typing elsewhere; undo its focus instead.
      this.send({ type: "blur" });
      editing = false;
      caret = null;
    }
    if (editing && !this.editing) {
      this.imePlacement = "";
      this.keyboard.focus(this, typing);
    } else if (editing && typing !== this.typing) {
      this.keyboard.setTyping(this, typing);
    }
    if (!editing && this.editing) this.keyboard.release(this);
    this.editing = editing;
    // isTyping also needs the keys to be the panel's (a sandboxed page may have been refused them).
    this.typing = editing && typing;
    this.updateCaret(caret);
  }

  /**
   * Whether text typed now goes into the page: a text field or a
   * contenteditable element in it has focus. For an on-screen keyboard (VR).
   */
  get isTyping(): boolean {
    // Set only while editing (see setEditing).
    return this.typing;
  }

  private updateCaret(caret: Caret | null): void {
    this.caretBox = caret;
    const color = caret ? (this.readCaretColor(caret.color) ?? this.caretColor) : null;
    // A transparent caret (caret-color: transparent) is how a page hides it.
    if (color?.alpha === 0) caret = null;
    else if (color) this.caretColor = color;
    this.caret.userData.hasCaret = caret !== null;
    this.caret.visible = caret !== null;
    if (!caret) return;
    const unit = this.worldWidth / this.pageWidth;
    const width = Math.max(1.5, caret.height / 14) * unit;
    this.caret.scale.set(width, caret.height * unit, 1);
    this.caret.position.set(
      (caret.x / this.pageWidth - 0.5) * this.worldWidth + width / 2,
      (0.5 - (caret.y + caret.height / 2) / this.pageHeight) * this.worldHeight,
      0.0005,
    );
    this.caret.material.color.setRGB(color!.r, color!.g, color!.b, SRGBColorSpace);
    this.caret.material.opacity = color!.alpha;
  }

  private readCaretColor(css: string): SrgbColor | null {
    if (this.lastCaretParse?.css !== css) this.lastCaretParse = { css, color: parseCssColor(css) };
    return this.lastCaretParse.color;
  }

  private send(message: HostMessage): void {
    this.connection.send(message);
  }

  /**
   * Sends data to the page, which receives it with `onHostMessage()`
   * (agent/page.ts). It must be structured-cloneable. Dropped while no agent
   * is connected.
   */
  postMessage(data: unknown): void {
    this.send({ type: "app", data });
  }

  // --- Input -----------------------------------------------------------------

  /** Converts a texture coordinate into the page's CSS pixels. */
  private toPage(uv: Vector2): { x: number; y: number } {
    return { x: uv.x * this.pageWidth, y: (1 - uv.y) * this.pageHeight };
  }

  /** How far apart two texture coordinates are in the page (CSS px). */
  pageDistance(a: Vector2, b: Vector2): number {
    const from = this.toPage(a);
    const to = this.toPage(b);
    return Math.hypot(to.x - from.x, to.y - from.y);
  }

  /**
   * A press's slop (see PanelInput) at `uv`: how far in the page (CSS px) the
   * pointer goes along `rays`, each as far as it may wobble (a few px on the
   * canvas, a degree for a controller), the farthest of them. At most
   * MAX_SLOP of the page's larger side: seen nearly edge-on, a ray turned a
   * little meets the panel's plane very far away. Undefined if none meets it.
   */
  slopFor(uv: Vector2, rays: readonly Ray[]): number | undefined {
    let slop: number | undefined;
    for (const ray of rays) {
      const moved = this.uvFromRay(ray);
      if (moved) slop = Math.max(slop ?? 0, this.pageDistance(uv, moved));
    }
    return slop === undefined
      ? undefined
      : Math.min(slop, MAX_SLOP * Math.max(this.pageWidth, this.pageHeight));
  }

  /**
   * The texture coordinate where `ray` meets the panel's plane, or null if it
   * runs parallel or points away. Unlike a raycast, this also answers outside
   * the panel, which keeps a drag going when the pointer leaves the edge.
   */
  uvFromRay(ray: Ray): Vector2 | null {
    this.updateWorldMatrix(true, false);
    const normal = new Vector3(0, 0, 1).transformDirection(this.matrixWorld);
    const plane = new Plane().setFromNormalAndCoplanarPoint(
      normal,
      new Vector3().setFromMatrixPosition(this.matrixWorld),
    );
    const point = ray.intersectPlane(plane, new Vector3());
    if (!point) return null;
    const local = this.worldToLocal(point);
    return new Vector2(local.x / this.worldWidth + 0.5, local.y / this.worldHeight + 0.5);
  }

  /**
   * Whether the page may take the keyboard now. A trusted page always may. A
   * sandboxed one only right after the user pressed the panel (focusing the
   * field pressed, or one a button press opens), or while it has the keyboard.
   */
  private mayTakeKeyboard(): boolean {
    return (
      !this.sandboxed || this.keyboard.isTarget(this) || performance.now() <= this.userActionUntil
    );
  }

  pointer(
    kind: PointerKind,
    uv: Vector2 | null = null,
    shiftKey = false,
    input: PointerInput = "mouse",
    /**
     * Ctrl and Cmd held: they add an option to a list box's selection. `slop`,
     * with a press: how far (CSS px of the page) it may move and still be a
     * tap (see PanelInput).
     */
    modifiers: { ctrlKey?: boolean; metaKey?: boolean; slop?: number } = {},
  ): void {
    if (kind === "down") this.lastInput = input;
    if (kind === "down" || kind === "up") this.pointersSent++;
    // Only presses, releases and drags (the user acting on this panel) open the
    // window, not hovering: a slow drag selecting text may take the keys at any point.
    const dragging = kind === "move" && this.pressing;
    if (kind === "down" || kind === "up" || dragging)
      this.userActionUntil = performance.now() + USER_ACTION_MS;
    if (kind === "down") this.pressing = true;
    else if (kind === "up" || kind === "leave") this.pressing = false;
    const { x, y } = uv ? this.toPage(uv) : { x: 0, y: 0 };
    const { ctrlKey = false, metaKey = false, slop } = modifiers;
    this.send({
      type: "pointer",
      kind,
      x,
      y,
      shiftKey,
      ctrlKey,
      metaKey,
      input,
      ...(kind === "down" && slop !== undefined && Number.isFinite(slop) ? { slop } : {}),
    });
  }

  wheel(uv: Vector2, deltaX: number, deltaY: number): void {
    this.send({ type: "wheel", ...this.toPage(uv), deltaX, deltaY });
  }

  sendKey(event: KeyboardEvent): void {
    // Enter on a focused link opens it.
    this.userActionUntil = performance.now() + USER_ACTION_MS;
    const { key, shiftKey, ctrlKey, altKey, metaKey } = event;
    this.send({ type: "key", key, shiftKey, ctrlKey, altKey, metaKey });
  }

  selectedText(): string {
    return this.selected;
  }

  cut(): void {
    this.send({ type: "cut" });
  }

  sendComposition(text: string, cursor: number): void {
    this.send({ type: "composition", text, cursor });
  }

  /**
   * Before the panel is drawn, while the keyboard types into it: moves the
   * keyboard's hidden field to where the caret is on screen, so that the IME's
   * candidate window opens next to it.
   */
  override onBeforeRender(renderer: WebGLRenderer, _scene: unknown, camera: Camera): void {
    if (this.pauseWhenHidden) this.drawnFor(camera);
    this.paceFor(renderer, camera);
    const caret = this.caretBox;
    if (!caret || !this.keyboard.isTarget(this)) return;
    // With a soft keyboard, the field stays in its corner: iOS scrolls the page to
    // show a focused field that the keyboard would cover, and the scene with it.
    if (this.lastInput !== "mouse") return;
    const top = this.toClient(caret.x, caret.y, renderer.domElement, camera);
    const bottom = this.toClient(caret.x, caret.y + caret.height, renderer.domElement, camera);
    // Behind the camera: leave the field where it was.
    if (!top || !bottom) return;
    const placement = {
      x: Math.round(top.x),
      y: Math.round(top.y),
      height: Math.round(Math.abs(bottom.y - top.y)),
    };
    const key = `${placement.x},${placement.y},${placement.height}`;
    if (key === this.imePlacement) return;
    this.imePlacement = key;
    this.keyboard.placeIme(placement);
  }

  /**
   * For a tap on the panel at `uv`, while the touch is still being handled: if it
   * lands on a text field, takes the keyboard now. iOS shows the soft keyboard
   * only for focus moved during a touch's own handling, which is long over when
   * the page hears of the tap. True if it did. If the page's answer to the tap
   * shows no focus (the tap was on something over the field, say), the keyboard
   * is let go then, however long the page took to answer.
   */
  focusForTyping(uv: Vector2): boolean {
    const { x, y } = this.toPage(uv);
    if (
      !this.editables.some(
        (box) =>
          x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height,
      )
    ) {
      return false;
    }
    this.userActionUntil = performance.now() + USER_ACTION_MS;
    this.keyboard.focus(this, true, true);
    // The tap's release went out before this touchend: its answer has counted it.
    this.tapAnswerAt = this.pointersSent;
    window.clearTimeout(this.keyboardTimer);
    this.keyboardTimer = window.setTimeout(() => {
      if (this.tapAnswerAt === null) return;
      this.tapAnswerAt = null;
      if (!this.editing) this.keyboard.release(this);
    }, TAP_ANSWER_TIMEOUT_MS);
    return true;
  }

  /** An editing report: if it answers the tap that took the keyboard, keep the keyboard only if a field has focus. */
  private answerTap(editing: boolean, pointers: number): void {
    if (this.tapAnswerAt === null || pointers < this.tapAnswerAt) return;
    this.tapAnswerAt = null;
    window.clearTimeout(this.keyboardTimer);
    if (!editing && !this.editing) this.keyboard.release(this);
  }

  /** A point of the page (CSS pixels) on screen (client pixels of the canvas's page), or null behind the camera. */
  private toClient(
    x: number,
    y: number,
    canvas: HTMLCanvasElement,
    camera: Camera,
  ): { x: number; y: number } | null {
    const point = this.scratch.set(
      (x / this.pageWidth - 0.5) * this.worldWidth,
      (0.5 - y / this.pageHeight) * this.worldHeight,
      0,
    );
    this.localToWorld(point).project(camera);
    if (point.z < -1 || point.z > 1) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + ((point.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - point.y) / 2) * rect.height,
    };
  }

  sendText(text: string): void {
    this.send({ type: "text", text });
  }

  blurFromHost(): void {
    // The host decides: editing ends now, whatever the page reports later.
    this.editing = false;
    this.typing = false;
    this.updateCaret(null);
    this.send({ type: "blur" });
  }

  /** Takes focus away from whatever has it in the page (e.g. the user pressed elsewhere). */
  blur(): void {
    // Pressing elsewhere: no press on this panel is held.
    this.pressing = false;
    if (!this.editing) return;
    this.keyboard.release(this);
    this.blurFromHost();
  }

  dispose(): void {
    window.clearInterval(this.caretTimer);
    window.clearInterval(this.viewTimer);
    window.clearTimeout(this.keyboardTimer);
    this.connection.dispose();
    this.keyboard.release(this);
    this.keyboard.unregister(this.iframe);
    this.iframe.remove();
    this.renderer.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.back.material.dispose();
    this.caret.geometry.dispose();
    this.caret.material.dispose();
  }
}
