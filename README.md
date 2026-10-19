# three-html-panel

[![npm](https://img.shields.io/npm/v/@urth/three-html-panel)](https://www.npmjs.com/package/@urth/three-html-panel)
[![CI](https://github.com/urth-inc/three-html-panel/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/urth-inc/three-html-panel/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@urth/three-html-panel)](LICENSE)
[![bundle size](https://deno.bundlejs.com/badge?q=@urth/three-html-panel&config=%7B%22esbuild%22%3A%7B%22external%22%3A%5B%22three%22%5D%7D%7D)](https://bundlejs.com/?q=@urth/three-html-panel&config=%7B%22esbuild%22%3A%7B%22external%22%3A%5B%22three%22%5D%7D%7D)

Show existing web pages — scripts included, from any origin — as interactive panels in a three.js scene.

[![Real sites (React, Vue, Svelte and plain HTML, each on its own origin) used as panels in a three.js scene: typing, filtering and scrolling](https://raw.githubusercontent.com/urth-inc/three-html-panel/main/docs/demo.webp)](https://three-html-panel-demo.pages.dev/)

**[Live demo](https://three-html-panel-demo.pages.dev/)**: real sites, each on its own origin, as panels you can use in 3D.

- Mouse, touch and VR controllers: hover, click, drag, wheel and touch scrolling
- Keyboard and IME, text selection, copy and paste, undo
- Form controls (`<select>`, list boxes, checkboxes, sliders, text fields, contenteditable), scrollbars, video
- Untrusted pages run sandboxed, away from the host's cookies, storage and keyboard

```
 host page (three.js)                           panel page (any origin)
┌────────────────────────────────┐             ┌──────────────────────┐
│ HtmlPanel                      │    input    │ agent                │
│   PanelPointer / PanelKeyboard ├────────────>│   replays the input  │
│   texture <── SVG              │<────────────┤   copies the DOM     │
└────────────────────────────────┘    frames   └──────────────────────┘
                                   MessagePort
```

The page runs in an `<iframe>` and loads a small script, the **agent**. The agent copies the page into an SVG `<foreignObject>`, which the host draws into a texture, and replays the host's input in the page as DOM events.

## Install

```bash
npm install @urth/three-html-panel three
```

three r158 or later (with `@types/three` 0.158 or later for TypeScript).

The agent adds about 38 kB (gzip) to each panel page.

## Usage

```ts
import { HtmlPanel, PanelPointer } from "@urth/three-html-panel";

const panel = new HtmlPanel({
  url: "https://panels.example/notes/",
  width: 960,
  height: 640,
  size: 1.6,
  sandbox: true,
});
scene.add(panel);
new PanelPointer(camera, renderer.domElement, () => [panel]);

renderer.setAnimationLoop(() => renderer.render(scene, camera));
```

`renderer` can be a `WebGLRenderer` or a `WebGPURenderer` (`three/webgpu`, tried with r186 on both its WebGPU and WebGL 2 backends).

For VR, add a `PanelXRPointer` (call its `update()` every frame) and give it a `PanelXRKeyboard`: there is no system keyboard in an immersive session. With a `WebGPURenderer`, VR on its WebGPU backend needs what three asks for there (a session with the `webgpu` feature); elsewhere, use its WebGL 2 backend (`forceWebGL: true`). VR with a `WebGPURenderer` has not been tried.

| Option            | Default         | Meaning                                                       |
| ----------------- | --------------- | ------------------------------------------------------------- |
| `url`             |                 | The page. It must load the agent                              |
| `width`, `height` | 800, 600        | The page's size in CSS px                                     |
| `size`            | 1               | The panel's longer side in world units                        |
| `sandbox`         | `false`         | Run the page sandboxed (see Security)                         |
| `pixelRatio`      | 2 (1 on phones) | Texture pixels per CSS pixel, at most                         |
| `background`      | `#ffffff`       | Painted under transparent pages                               |
| `pauseWhenHidden` | `true`          | Pause capturing, then rest, while not drawn (see Performance) |
| `optimizeHover`   | `true`          | Skip captures for unchanged hover (see Performance)           |
| `readyTimeout`    | 15000           | ms to wait for the agent before `onError`                     |
| `onLink`          | see below       | A link the user followed (http(s), right after acting on it)  |
| `onMessage`       |                 | Data the page sent with `sendToHost()`                        |
| `onError`         | `console.warn`  | The agent did not connect, or speaks another protocol         |

By default, a link to the panel's own origin opens in the panel (the page there loads the agent too, and the panel connects to it again), and a link to any other origin in a new tab of the host's browser. A link to another port or subdomain is another origin. A link to the host's own origin also opens in a new tab, so that the host's pages (its scene) do not run again inside the panel. If the page a link opened in the panel does not connect within `readyTimeout` (a PDF, or a page without the agent), the panel goes back to the page it left and reports it to `onError`; it does not open a tab then, which the browser would block that long after the click.

### Adding the agent to a page

The agent must run before the page's own scripts, and names the host's origin. With a tag, first in `<head>` (from a CDN, or from your server out of `node_modules/@urth/three-html-panel/lib/`):

```html
<script
  type="module"
  src="https://cdn.jsdelivr.net/npm/@urth/three-html-panel@0.2/lib/agent-script.js"
  data-host-origin="https://host.example"
></script>
```

Or first in the page's own bundle:

```ts
import { startAgent } from "@urth/three-html-panel/agent";
startAgent({ hostOrigin: "https://host.example" });
```

A page shown by hosts on several origins (production and staging, say) names them all: separated by spaces in `data-host-origin` (`"https://host.example https://staging.example"`), or as a list in `hostOrigin`. The agent talks to whichever of them the page is shown in. If any is not exactly an origin, the agent does not start.

For pages you cannot edit, a server or proxy can insert the tag; `injectPanelAgent()` in `vite.panels.config.ts` does this for the demo.

### Messages between page and host

```ts
// In the page
import { onHostMessage, sendToHost } from "@urth/three-html-panel/page";
sendToHost({ color: "#3b82f6" });
onHostMessage((data) => console.log(data));

// On the host
new HtmlPanel({
  url,
  onMessage: (data) => {
    /* validate, then use */
  },
});
panel.postMessage("scene-click");
```

## Security

Loading the agent is how a page consents to being shown: the agent sends the host what the page shows, much as if the page posted its own DOM to the host, and only to the origins named in `data-host-origin` (`hostOrigin`). Name fixed origins you trust, never one taken from the URL. The host cannot read a page that does not load the agent, and the agent reads only what the page's own scripts can (cross-origin images and stylesheets need CORS, cross-origin frames are left out). A page that is not sandboxed may show the user's own data (with third-party cookies, a logged-in view); the named host receives that too.

**`sandbox: false`** runs the page as an ordinary page of its origin. Use it only for pages you trust: a page on the host's origin can read the host's cookies and storage.

**`sandbox: true`** is for pages you do not trust. The iframe gets `sandbox="allow-scripts allow-forms allow-popups"` (never `allow-same-origin`), so the page runs on an opaque origin and cannot reach the host's cookies, storage or document. It cannot take the keyboard either: the host gives focus back, and lets a text field have the keys only right after the user pressed it.

Either way, treat what comes from the page (`onMessage` data included) as untrusted; the host checks the shape and size of every message (`src/protocol.ts`).

Serve sandboxed pages with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`, and their assets with `Access-Control-Allow-Origin` (they are requested from the origin `null`). Such pages have no cookies or `localStorage`; keep their state on a server. The demo's panel server (`vite.panels.config.ts`) does both.

## Performance

- Only what changed is sent: the agent captures on DOM changes, input and animation, and skips frames that look the same.
- A panel not drawn facing the camera for a second (out of view, behind, hidden) stops capturing; a panel drawn small captures at most 5 times a second.
- A panel not drawn for 10 seconds rests: its iframe is moved off screen and made invisible, so the browser stops painting the page (which keeps running, and keeps its state), and the panel lets go of its canvas and texture. Drawn again, it draws the last frame again, showing its `background` for a moment.
- Images more than a viewport away from the page's viewport are not embedded in frames, nor fetched: a transparent image of their size stands in, so the layout is the same.

These rely on the scene being rendered every frame. Without WebGL (a panel that takes input but is never drawn), pass `pauseWhenHidden: false`.

Each new frame is rasterized into the panel's texture and uploaded, at `width` × `height` × `pixelRatio`² pixels (at most 4096 on a side). Fewer pixels make every update cheaper, and take less memory (with mipmaps, a 1024×720 panel at `pixelRatio` 2 holds about 16 MB; at 1, about 4 MB):

- **Lay the page out at a smaller `width` and `height`**, keeping `size`: the panel is as large in the scene, and its text and controls are larger in it. 512×360 has a quarter of the pixels of 1024×720. Design the page for that viewport, with fewer, larger elements: a smaller DOM is also quicker to capture.
- **Lower `pixelRatio`** where the panel is not seen up close: 1 has a quarter of the pixels of the default 2. It is a ceiling: the texture's resolution follows how large the panel is drawn, down to a quarter of it, so a lower `pixelRatio` saves most while the panel is near. Enough is about the device pixels the panel covers on screen, divided by `width`: on a headset with about 25 pixels per degree, a panel 1 m wide seen from 1.5 m covers about 37°, some 920 pixels, which a 480 px wide page needs `pixelRatio` 2 for; from 2.5 m, about 1.2 is enough.

`optimizeHover: true` skips captures when an unpressed pointer moves within the same element without changing hover or scrollbar state. Pointer events still fire, and DOM mutations still trigger captures. Changes through the CSSOM methods (`insertRule`, `replaceSync`, ...) trigger captures too. Set `optimizeHover: false` for pages that draw to canvas, edit CSS rules' declarations in place (`rule.style`), or update other visual state without DOM mutations in pointer handlers.

## Limitations

- Only what the DOM and CSS describe is drawn: no cross-origin iframes inside the page, no native widgets other than `<select>`'s list (no date pickers or video controls). CSS transitions jump to their end. `backdrop-filter` is not drawn: browsers do not apply it in the SVG images panels are drawn from.
- Open popovers and modal dialogs (the top layer) are drawn over the page, moved out of their parents in the copy. There, rules that look at the `<body>`'s siblings (`body:first-of-type`), or at more than 16 later siblings of the element or of one of its parents (`:nth-last-child`, `:has(~ …)`), may not match as on the page.
- A cross-origin video without CORS shows only its poster.
- A slider (`<input type="range">`) takes its value from where it is pressed as if its thumb were 16 px wide: with a larger thumb styled by the page, a press near the ends is a few px off.
- Scrolled content is drawn by moving it in the copy of the page. A scroll container whose content starts with bare text (or other inline content), floats, multiple columns or vertical writing has its children moved one by one instead: bare text directly in it does not move, absolutely positioned elements placed from outside it are cut off at its edges, and its sticky elements are drawn over the rest of its content (`z-index: 1`). For bare text, wrapping it in an element avoids this.
- contenteditable editing relies on `document.execCommand()`; editors that handle input in other ways may not work.
- The panel page never gets a real pointer or real focus, so the agent keeps hover, press and focus itself: it marks the elements (`data-thp-hover`, `data-thp-active`, `data-thp-focus`, `data-thp-focus-visible`, `data-thp-focus-within`) and rewrites the page's `:hover`, `:active`, `:focus`, `:focus-visible` and `:focus-within` selectors (and `:popover-open` and `:modal`, for the copy) in place to match the marks too (`.row:hover` becomes `.row:is(:hover,[data-thp-hover])`), so that the page lays out as the panel shows it and a press lands on what is drawn. The page's scripts see the marks and the rewritten selectors, in its stylesheets and in its selector queries (`matches`, `closest`, `querySelector(All)`, wrapped to match them), and the wrapped CSSOM methods and setters that change stylesheets (`insertRule`, `replace`, `selectorText`, `disabled`, `adoptedStyleSheets`, ...). The stylesheets of shadow roots are not rewritten. The interaction rules of a cross-origin stylesheet loaded without CORS come after the page's own.
- No IME in VR. Touch and VR were tested in emulation, not on devices.
- A same-site page shares the host's main thread; a heavy one slows the scene. Prefer another site for panel pages.

## Development

```bash
pnpm install
pnpm dev        # the demo: open http://localhost:5173 (its pages are served from :5174, another origin)
pnpm dev:live-demo  # the live demo (http://localhost:5179) and the example sites, with the published package
pnpm test       # unit tests
pnpm e2e        # Chromium, Firefox and WebKit (Playwright); install them once: pnpm exec playwright install
pnpm pack:lib   # the npm package, into lib/
pnpm build      # the demo, into dist/
vp check        # format, lint and types
```

`src/` is the library (`src/agent/` runs in panel pages). `examples/showcase/` is the demo scene; it shows the pages in `examples/sites/` that run `src/`. The sites there with a `package.json` use the published package instead, and only `examples/live-demo/` shows them. Other ports: set `VITE_HOST_ORIGIN` and `VITE_PANEL_ORIGIN` (see `.env.example`).
