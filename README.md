# three-html-panel

Show existing web pages — scripts included, from any origin — as interactive panels in a three.js scene.

- Mouse, touch and VR controllers: hover, click, drag, wheel and touch scrolling
- Keyboard and IME, text selection, copy and paste, undo
- Form controls (`<select>`, list boxes, checkboxes, text fields, contenteditable), scrollbars, video
- Untrusted pages run sandboxed, away from the host's cookies, storage and keyboard

```
 host page (three.js)                           panel page (any origin)
┌────────────────────────────────┐   input     ┌───────────────────────┐
│ HtmlPanel  ── MessagePort ──────┼───────────▶ │ agent                 │
│   PanelPointer / PanelKeyboard │   frames    │   replays the input   │
│   texture ◀── SVG ─────────────┼◀─────────── │   copies the DOM      │
└────────────────────────────────┘             └───────────────────────┘
```

The page runs in an `<iframe>` and loads a small script, the **agent**. The agent copies the page into an SVG `<foreignObject>`, which the host draws into a texture, and replays the host's input in the page as DOM events. The host never reads the page's document.

## Install

```bash
npm install @urth/three-html-panel three
```

three r158 or later (with `@types/three` 0.158 or later for TypeScript).

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

For VR, add a `PanelXRPointer` (call its `update()` every frame) and give it a `PanelXRKeyboard`: there is no system keyboard in an immersive session.

| Option            | Default           | Meaning                                                       |
| ----------------- | ----------------- | ------------------------------------------------------------- |
| `url`             |                   | The page. It must load the agent                              |
| `width`, `height` | 800, 600          | The page's size in CSS px                                     |
| `size`            | 1                 | The panel's longer side in world units                        |
| `sandbox`         | `false`           | Run the page sandboxed (see Security)                         |
| `pixelRatio`      | 2 (1 on phones)   | Texture pixels per CSS pixel, at most                         |
| `background`      | `#ffffff`         | Painted under transparent pages                               |
| `pauseWhenHidden` | `true`            | Stop capturing while the panel is not drawn (see Performance) |
| `optimizeHover`   | `true`            | Skip captures for unchanged hover (see Performance)           |
| `readyTimeout`    | 15000             | ms to wait for the agent before `onError`                     |
| `onLink`          | open in a new tab | A link the user followed in the page                          |
| `onMessage`       |                   | Data the page sent with `sendToHost()`                        |
| `onError`         | `console.warn`    | The agent did not connect, or speaks another protocol         |

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

### Links

A link the user follows opens in a new tab of the host (only http(s), only right after the user acted on the panel). Pass `onLink` to handle it yourself.

## Security

**`sandbox: false`** runs the page as an ordinary page of its origin. Use it only for pages you trust: a page on the host's origin can read the host's cookies and storage.

**`sandbox: true`** is for pages you do not trust. The iframe gets `sandbox="allow-scripts allow-forms allow-popups"` (never `allow-same-origin`), so the page runs on an opaque origin and cannot reach the host's cookies, storage or document. It cannot take the keyboard either: the host gives focus back, and lets a text field have the keys only right after the user pressed it.

Either way, treat what comes from the page (`onMessage` data included) as untrusted; the host checks the shape and size of every message (`src/protocol.ts`).

Serve sandboxed pages with `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`, and their assets with `Access-Control-Allow-Origin` (they are requested from the origin `null`). Such pages have no cookies or `localStorage`; keep their state on a server. The demo's panel server (`vite.panels.config.ts`) does both.

## Performance

- Only what changed is sent: the agent captures on DOM changes, input and animation, and skips frames that look the same.
- A panel not drawn facing the camera for a second (out of view, behind, hidden) stops capturing; a panel drawn small captures at most 5 times a second.
- The texture's resolution follows how large the panel is drawn, down to a quarter of `pixelRatio`.

`optimizeHover: true` skips captures when an unpressed pointer moves within the same element without changing hover or scrollbar state. Pointer events still fire, and DOM mutations still trigger captures. Changes through the CSSOM methods (`insertRule`, `replaceSync`, ...) trigger captures too. Set `optimizeHover: false` for pages that draw to canvas, edit CSS rules' declarations in place (`rule.style`), or update other visual state without DOM mutations in pointer handlers. This restores capture invalidation on every pointer move, including after reloads and navigation.

These rely on the scene being rendered every frame. Without WebGL (a panel that takes input but is never drawn), pass `pauseWhenHidden: false`.

## Limitations

- The page has to load the agent.
- Only what the DOM and CSS describe is drawn: no cross-origin iframes inside the page, no native widgets other than `<select>`'s list (no date pickers or video controls). CSS transitions jump to their end. `backdrop-filter` is not drawn: browsers do not apply it in the SVG images panels are drawn from.
- Open popovers and modal dialogs (the top layer) are drawn over the page, moved out of their parents in the copy. There, rules that look at the `<body>`'s siblings (`body:first-of-type`), or at more than 16 later siblings of the element or of one of its parents (`:nth-last-child`, `:has(~ …)`), may not match as on the page.
- A cross-origin video without CORS shows only its poster.
- Scrolled content is drawn by moving it in the copy of the page. A scroll container whose content starts with bare text (or other inline content), floats, multiple columns or vertical writing has its children moved one by one instead: bare text directly in it does not move, absolutely positioned elements placed from outside it are cut off at its edges, and its sticky elements are drawn over the rest of its content (`z-index: 1`). For bare text, wrapping it in an element avoids this.
- contenteditable editing relies on `document.execCommand()`; editors that handle input in other ways may not work.
- The panel page never gets a real pointer or real focus, so the agent keeps hover, press and focus itself. It marks the elements (`data-thp-hover`, `data-thp-active`, `data-thp-focus`, `data-thp-focus-visible`, `data-thp-focus-within`) and rewrites the page's `:hover`, `:active`, `:focus`, `:focus-visible` and `:focus-within` selectors (and `:popover-open` and `:modal`, for the copy) in place to match the marks too (`.row:hover` becomes `.row:is(:hover,[data-thp-hover])`), so that the page lays out as the panel shows it and a press lands on what is drawn. Its selector queries (`matches`, `closest`, `querySelector(All)`) are rewritten the same way, so its scripts see the states too, and the transitions these states start end at once, as the panel draws them. The page's script can see the marks and the rewritten selectors, and the wrapped methods: the selector queries, and the CSSOM methods and setters that change stylesheets (`insertRule`, `replace`, `selectorText`, `disabled`, `adoptedStyleSheets`, ...). The stylesheets of shadow roots are not rewritten. The interaction rules of a cross-origin stylesheet loaded without CORS come after the page's own.
- No IME in VR. Touch and VR were tested in emulation, not on devices.
- A same-site page shares the host's main thread; a heavy one slows the scene. Prefer another site for panel pages.

## Development

```bash
pnpm install
pnpm dev        # the demo: open http://localhost:5173 (its pages are served from :5174, another origin)
pnpm dev:all    # the demo and the example sites it also shows (each on its own origin, :5175-5178)
pnpm dev:live-demo  # the live demo (http://localhost:5179) and the example sites, with the published package
pnpm test       # unit tests
pnpm e2e        # Chromium, Firefox and WebKit (Playwright); install them once: pnpm exec playwright install
pnpm pack:lib   # the npm package, into lib/
pnpm build      # the demo, into dist/
vp check        # format, lint and types
```

`pnpm e2e` starts `pnpm dev`, or uses one already running at its origins. For other ports, set `VITE_HOST_ORIGIN` and `VITE_PANEL_ORIGIN` (see `.env.example`) in the environment: the tests do not read `.env` files. `E2E_NO_WEBGL=1 pnpm e2e` runs the end-to-end tests without WebGL, as headless Firefox on Linux does.

The library is `src/` (the agent, which runs in panel pages, is `src/agent/`). The demo is in `examples/`: `examples/showcase/` is the 3D scene (`index.html` loads it), and `examples/sites/` holds the pages it shows as panels: `notes`, `controls` and `reader`, served from the other origin (with a few pages only the end-to-end tests use, such as `article`, a long page with sticky and fixed elements, and `boxes`), and four sites that are packages of their own (`web-standards`, `hn-reader` with Vue, `chat` with React, `gallery` with Svelte), each built and deployed on its own and served from its own origin (see `examples/sites/vite.site.ts`; set `VITE_SITE_*_ORIGIN` where they are deployed, see `.env.example`). These four sites and `examples/live-demo/`, the live demo that shows them one at a time, use the published package from npm, not `src/`. The end-to-end tests drive those pages in `e2e/harness/`, a scene with one flat panel.

## License

MIT
