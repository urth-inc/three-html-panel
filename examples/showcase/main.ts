import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  IcosahedronGeometry,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  TorusKnotGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { HtmlPanel, PanelPointer, PanelXRKeyboard, PanelXRPointer } from "../../src/index";
import { SCENE_CLICK, parseSceneControl, type SceneControl } from "./scene-events";

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
// A button to enter VR, only where the browser and a headset can (it would
// otherwise say "VR not supported" over the page).
void navigator.xr?.isSessionSupported("immersive-vr").then((supported) => {
  if (supported) document.body.appendChild(VRButton.createButton(renderer));
});

const scene = new Scene();
scene.background = new Color(0x1d2129);
const sun = new DirectionalLight(0xffffff, 2.5);
sun.position.set(2, 4, 3);
scene.add(new AmbientLight(0xffffff, 1.2), sun);
scene.add(new GridHelper(20, 20, 0x3a4150, 0x2a303b));

// The panels stand in a ring around the viewer, facing in: look around by
// dragging outside them (in VR, by turning); the wheel and a right-button drag
// outside them zoom and pan, freely.
const EYE_HEIGHT = 1.45;
const RING_RADIUS = 2.7;
const camera = new PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, EYE_HEIGHT, 0.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, EYE_HEIGHT, 0);
controls.enableDamping = true;
controls.update();

/** Places a panel on the ring, `degrees` to the right of straight ahead (-z), facing the centre. */
function onRing(panel: HtmlPanel, degrees: number, height = EYE_HEIGHT): HtmlPanel {
  const angle = (degrees * Math.PI) / 180;
  panel.position.set(RING_RADIUS * Math.sin(angle), height, -RING_RADIUS * Math.cos(angle));
  panel.rotation.y = -angle;
  return panel;
}

// The panel pages are served from another origin (VITE_PANEL_ORIGIN, see
// vite.config.ts); without one, next to the scene.
const panelBase: string = import.meta.env.VITE_PANEL_ORIGIN || location.href;
const pageUrl = (path: string) => new URL(path, panelBase);

// All pages run sandboxed (the iframes' sandbox attribute; the server of the
// demo's own panel pages sends the same sandbox too, see vite.panels.config.ts):
// none can reach the scene's cookies, storage or document, nor take its keyboard.
/**
 * A link the user follows in a panel: to another page of the same site, it opens
 * in the panel (the page loads the agent too, and connects again); elsewhere,
 * in a new tab, as HtmlPanel does by default.
 */
function openLink(url: URL, panel: HtmlPanel): void {
  if (url.origin === panel.origin) panel.iframe.src = url.href;
  else window.open(url.href, "_blank", "noopener,noreferrer");
}

interface PanelSpec {
  name: string;
  /** Where on the ring, to the right of straight ahead. */
  degrees: number;
  create: () => HtmlPanel;
}

const specs: PanelSpec[] = [
  {
    name: "notes",
    degrees: 0,
    create: () =>
      new HtmlPanel({
        url: pageUrl("examples/sites/notes/"),
        width: 960,
        height: 640,
        size: 1.6,
        sandbox: true,
        onLink: openLink,
      }),
  },
  {
    name: "controls",
    degrees: 30,
    create: () =>
      new HtmlPanel({
        url: pageUrl("examples/sites/controls/"),
        sandbox: true,
        onLink: openLink,
        width: 480,
        height: 640,
        size: 1.0,
        onMessage: (data) => {
          const control = parseSceneControl(data);
          if (control) applyControl(control);
        },
      }),
  },
  // A page with text to select, drop-down lists, rich text editing and a video.
  {
    name: "reader",
    degrees: -32,
    create: () =>
      new HtmlPanel({
        url: pageUrl("examples/sites/reader/"),
        width: 720,
        height: 720,
        size: 1.1,
        sandbox: true,
        onLink: openLink,
      }),
  },
];

// ?site=<name> shows that page alone, straight ahead (e.g. ?site=reader).
const only = new URLSearchParams(location.search).get("site");
const chosen = specs.filter((spec) => spec.name === only);
if (only && chosen.length === 0) {
  console.warn(`[showcase] no page named "${only}": ${specs.map((spec) => spec.name).join(", ")}`);
}
const shown = chosen.length > 0 ? chosen : specs;
const panels = shown.map((spec) => onRing(spec.create(), chosen.length > 0 ? 0 : spec.degrees));
scene.add(...panels);
if (chosen.length > 0) {
  // One page: the view turns around it and zooms toward it.
  const [panel] = panels;
  controls.target.copy(panel!.position);
  camera.position.set(0, EYE_HEIGHT, panel!.position.z + 2.2);
  controls.update();
  const hud = document.querySelector("#hud strong")?.nextSibling;
  if (hud) {
    hud.textContent = ` — ${only}: a web page from another origin, running in an iframe and drawn as a texture.`;
  }
}
const sceneControls = panels[shown.findIndex((spec) => spec.name === "controls")] ?? null;
new PanelPointer(camera, renderer.domElement, () => panels);

// In VR, each controller points at the panels with a ray; the trigger presses.
const xrPointer = new PanelXRPointer(renderer, () => panels);
// In VR, a keyboard shows under the panel whose text field has focus.
const xrKeyboard = new PanelXRKeyboard();
scene.add(xrKeyboard);
xrPointer.keyboard = xrKeyboard;
for (const index of [0, 1]) {
  const controller = renderer.xr.getController(index);
  const ray = new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, 0, -5)]);
  controller.add(
    new Line(ray, new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })),
  );
  scene.add(controller);
}

// The object the controls panel drives.
const geometries: Record<NonNullable<SceneControl["shape"]>, BufferGeometry> = {
  knot: new TorusKnotGeometry(0.16, 0.05, 160, 24),
  ico: new IcosahedronGeometry(0.22),
  box: new BoxGeometry(0.3, 0.3, 0.3),
};
const object = new Mesh<BufferGeometry, MeshStandardMaterial>(
  geometries.knot,
  new MeshStandardMaterial({ color: "#f59e0b", roughness: 0.35 }),
);
// In front of the controls panel and below it, between it and the viewer.
const objectAngle = (30 * Math.PI) / 180;
object.position.set(1.4 * Math.sin(objectAngle), 0.85, -1.4 * Math.cos(objectAngle));
// Only with the controls panel, which drives it.
if (sceneControls) scene.add(object);
let spin = true;

const caption = document.querySelector<HTMLElement>("#caption")!;

function applyControl(control: SceneControl): void {
  if (control.shape) object.geometry = geometries[control.shape];
  if (control.color) object.material.color.set(control.color);
  if (control.spin !== undefined) spin = control.spin;
  if (control.caption !== undefined) caption.textContent = control.caption;
}

// Clicking the object tells the controls page.
const raycaster = new Raycaster();
renderer.domElement.addEventListener("click", (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  if (sceneControls && raycaster.intersectObject(object).length > 0) {
    sceneControls.postMessage(SCENE_CLICK);
  }
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const captionAnchor = new Vector3();
renderer.setAnimationLoop(() => {
  xrPointer.update();
  if (spin) object.rotation.y += 0.01;
  controls.update();
  renderer.render(scene, camera);
  // Keep the caption under the object (hidden while the object is behind the viewer).
  captionAnchor
    .copy(object.position)
    .setY(object.position.y - 0.3)
    .project(camera);
  caption.hidden = captionAnchor.z > 1;
  caption.style.transform = `translate(${((captionAnchor.x + 1) / 2) * innerWidth}px, ${((1 - captionAnchor.y) / 2) * innerHeight}px) translate(-50%, 0)`;
});
