import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Line,
  LineBasicMaterial,
  PerspectiveCamera,
  Scene,
  Timer,
  Vector3,
  WebGLRenderer,
} from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { HtmlPanel, PanelPointer, PanelXRKeyboard, PanelXRPointer } from "@urth/three-html-panel";
import { Navigation, attachStick, type ViewMode } from "./navigation";
import { SITES, parseSiteMessage, siteNamed, type Site, type SiteMessage } from "./sites";

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
// A button to enter VR, only where the browser and a headset can.
void navigator.xr?.isSessionSupported("immersive-vr").then((supported) => {
  if (supported) document.body.appendChild(VRButton.createButton(renderer));
});

const scene = new Scene();
scene.background = new Color(0x1d2129);
const sun = new DirectionalLight(0xffffff, 2.5);
sun.position.set(2, 4, 3);
scene.add(new AmbientLight(0xffffff, 1.2), sun);
scene.add(new GridHelper(20, 20, 0x3a4150, 0x2a303b));

// The site straight ahead, the switcher to its left turned toward the viewer.
// Moving around: see navigation.ts.
const EYE_HEIGHT = 1.45;
const camera = new PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 100);
camera.position.set(0, EYE_HEIGHT, 0.4);

const SITE_SIZE = 2.3;
const SITE_DISTANCE = 2.4;

/**
 * A link the user follows in a panel: to another page of the same site, it
 * opens in the panel (the page loads the agent too, and connects again);
 * elsewhere, in a new tab.
 */
function openLink(url: URL, panel: HtmlPanel): void {
  if (url.origin === panel.origin) panel.iframe.src = url.href;
  else window.open(url.href, "_blank", "noopener,noreferrer");
}

// Every page runs sandboxed: none can reach the scene's cookies, storage or
// document, nor take its keyboard.

// Each site's panel, made the first time it is chosen and kept (hidden, it
// stops capturing), so that a site chosen again is as it was left.
const sitePanels = new Map<string, HtmlPanel>();
let shown: HtmlPanel | null = null;

function panelFor(site: Site): HtmlPanel {
  let panel = sitePanels.get(site.name);
  if (!panel) {
    panel = new HtmlPanel({
      url: site.url,
      width: 1024,
      height: 720,
      size: SITE_SIZE,
      sandbox: true,
      onLink: openLink,
    });
    panel.position.set(0, EYE_HEIGHT, -SITE_DISTANCE);
    sitePanels.set(site.name, panel);
    scene.add(panel);
  }
  return panel;
}

const params = new URLSearchParams(location.search);
const first = siteNamed(params.get("site")) ?? SITES[0]!;

const switcherUrl = new URL("switcher.html", location.href);
switcherUrl.searchParams.set("current", first.name);
const switcher = new HtmlPanel({
  url: switcherUrl,
  width: 400,
  height: 600,
  size: 1.0,
  sandbox: true,
  onMessage: (data) => {
    const site = parseSiteMessage(data);
    if (site) show(site);
  },
});
// Left of the site, a little in front of it, turned toward the viewer.
switcher.position.set(-SITE_SIZE / 2 - 0.5, EYE_HEIGHT - 0.05, -SITE_DISTANCE + 0.2);
switcher.rotation.y = 0.35;
scene.add(switcher);

function show(site: Site): void {
  if (shown) shown.visible = false;
  shown = panelFor(site);
  shown.visible = true;
  switcher.postMessage({ site: site.name } satisfies SiteMessage);
  // The address names the site, to share or reload.
  const url = new URL(location.href);
  url.searchParams.set("site", site.name);
  history.replaceState(null, "", url);
  document.title = `${site.title} — three-html-panel live demo`;
}
show(first);

const panels = () => (shown ? [switcher, shown] : [switcher]);
new PanelPointer(camera, renderer.domElement, panels);

// Keys move the view unless a panel's text field has them.
const navigation = new Navigation(camera, renderer.domElement, () =>
  panels().some((panel) => panel.isTyping),
);
// Orbiting turns around the site shown (each site's panel is in the same place).
navigation.setCenter(new Vector3(0, EYE_HEIGHT, -SITE_DISTANCE));
attachStick(
  document.querySelector<HTMLElement>("#stick")!,
  document.querySelector<HTMLElement>("#stick > span")!,
  navigation,
);
// The view mode buttons, and V, switch between orbit and first person.
const modeButtons = document.querySelectorAll<HTMLButtonElement>("#view button");
const showMode = (mode: ViewMode) => {
  for (const button of modeButtons)
    button.setAttribute("aria-pressed", String(button.value === mode));
};
for (const button of modeButtons) {
  button.addEventListener("click", () => {
    navigation.mode = button.value as ViewMode;
    // Keys go to the scene again, not to the button.
    button.blur();
  });
}
navigation.onModeChange(showMode);
showMode(navigation.mode);

// In VR, each controller points at the panels with a ray; the trigger presses.
const xrPointer = new PanelXRPointer(renderer, panels);
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

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// The time between frames, for moving; not counting the time the page was hidden.
const timer = new Timer();
timer.connect(document);
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const seconds = Math.min(timer.getDelta(), 0.1);
  xrPointer.update();
  // In VR, the headset moves the view.
  if (!renderer.xr.isPresenting) navigation.update(seconds);
  renderer.render(scene, camera);
});
