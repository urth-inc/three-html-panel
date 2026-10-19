// The host page the e2e tests drive: one panel, flat, filling the canvas, so
// that a point of the panel page maps to a point on screen by a scale alone.
//
// ?page=<name under examples/sites/>&width=<px>&height=<px> picks the page and its
// size. The tests read the panel's state through window.harness.
//
// Without WebGL (headless Firefox on Linux refuses it on a software renderer),
// the panel is not drawn, but takes input as usual: pressing it only needs the
// geometry. `harness.drawn` tells the tests, which then skip what they would
// read from the drawn image. `&no-webgl` (E2E_NO_WEBGL=1 pnpm e2e) does without
// it on purpose, to try that anywhere.

import { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { HtmlPanel, PanelPointer } from "../../src/index";

/** The canvas is this wide (CSS px); its height follows the page's shape. */
const CANVAS_WIDTH = 800;
const FOV = 50;

const params = new URLSearchParams(location.search);
const page = params.get("page") ?? "reader";
const width = Number(params.get("width") ?? 720);
const height = Number(params.get("height") ?? 720);

const canvasHeight = Math.round((CANVAS_WIDTH * height) / width);
let renderer: WebGLRenderer | null = null;
try {
  if (params.has("no-webgl")) throw new Error("no WebGL, as asked");
  renderer = new WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(CANVAS_WIDTH, canvasHeight);
} catch {
  renderer = null;
}
// Without WebGL, a plain canvas of the same size takes the pointer.
const canvas =
  renderer?.domElement ??
  Object.assign(document.createElement("canvas"), { width: CANVAS_WIDTH, height: canvasHeight });
canvas.style.width = `${CANVAS_WIDTH}px`;
canvas.style.height = `${canvasHeight}px`;
document.body.appendChild(canvas);

const scene = new Scene();
const camera = new PerspectiveCamera(FOV, width / height, 0.01, 10);
// A panel 1 unit high fills the view from this distance.
camera.position.set(0, 0, 0.5 / Math.tan((FOV * Math.PI) / 360));

const panel = new HtmlPanel({
  // &url=<url> shows any page instead (an example site served on its own origin, say).
  url:
    params.get("url") ??
    new URL(`examples/sites/${page}/`, import.meta.env.VITE_PANEL_ORIGIN || location.href),
  width,
  height,
  size: width / height,
  sandbox: true,
  // Without WebGL the panel is never drawn: it would count as hidden.
  pauseWhenHidden: renderer !== null,
  // &ready-timeout=<ms>: give up on a page without the agent sooner.
  readyTimeout: params.has("ready-timeout") ? Number(params.get("ready-timeout")) : undefined,
});
scene.add(panel);
// Rendering would do it; without WebGL, nothing else updates the matrices the pointer's raycast uses.
scene.updateMatrixWorld();
camera.updateMatrixWorld();
new PanelPointer(camera, canvas, () => [panel]);

// Frames the page has sent (the renderer is private; the tests only count its frames).
let frames = 0;
const frameRenderer = (panel as unknown as { renderer: { submit: (frame: unknown) => void } })
  .renderer;
const submit = frameRenderer.submit.bind(frameRenderer);
frameRenderer.submit = (frame) => {
  frames++;
  submit(frame);
};

const harness = {
  panel,
  /** Screen (CSS px of the canvas) per page CSS px. */
  scale: CANVAS_WIDTH / width,
  /** The panel is drawn (WebGL is there): pixel() can read it. */
  drawn: renderer !== null,
  get frames() {
    return frames;
  },
  /** The color drawn at a point of the page (its CSS px): rendered and read at once. */
  pixel(x: number, y: number): [number, number, number] {
    if (!renderer) throw new Error("the panel is not drawn: no WebGL");
    const gl = renderer.getContext();
    renderer.render(scene, camera);
    const data = new Uint8Array(4);
    const canvasX = Math.round(x * harness.scale);
    const canvasY = renderer.domElement.height - 1 - Math.round(y * harness.scale);
    gl.readPixels(canvasX, canvasY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return [data[0]!, data[1]!, data[2]!];
  },
};
(window as unknown as { harness: typeof harness }).harness = harness;

renderer?.setAnimationLoop(() => renderer!.render(scene, camera));
