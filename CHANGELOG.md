# Changelog

Changes to the `@urth/three-html-panel` package. Changes to the demo and example sites are not listed.

Each version's section is also the release notes of its [GitHub Release](https://github.com/urth-inc/three-html-panel/releases), made when its tag is pushed.

## Unreleased

### Changed

- A link to the panel's own origin opens in the panel by default, as following a link does in a browser (the page there loads the agent too, and the panel connects to it again), rather than in a new tab. Links to other origins still open in a new tab. `onLink` still decides when given.

### Added

- Several host origins for one page: `data-host-origin` takes origins separated by white space, and `startAgent()`'s `hostOrigin` a list too. The agent takes `connect` from any of them, and posts `ready` to the parent's origin when the browser tells it (`location.ancestorOrigins`, in Chromium and WebKit), else to each (only the parent's own origin receives it). If one is not exactly an origin, the agent does not start, so a typo leaves none of them allowed. `readHostOrigins()` reads them from the agent's `<script>`.

### Changed

- `startAgent()` warns, naming it, when the host origin it is given is not exactly an origin, rather than leave the panel blank without a word (the agent's `<script>` warned already).
- A host origin whose host has characters no host name has (`"https://host.example,"`, which URLs take as a host) is not an origin: origins separated by commas or semicolons, by mistake, start nothing (and say so) rather than leave the agent waiting for a host that cannot exist.

### Removed

- `readHostOrigin()`, which read one host origin: use `readHostOrigins()`, which reads one or several.

## 0.2.6 - 2026-10-15

### Added

- `WebGPURenderer` (`three/webgpu`) as the scene's renderer, as well as `WebGLRenderer`. `PanelXRPointer` takes an `XRRenderer` (what it uses of a renderer: its XR manager), now exported, which both fit ([#90](https://github.com/urth-inc/three-html-panel/pull/90)).

### Changed

- Less memory: a panel not drawn for 10 seconds rests. Its iframe is moved off screen and made invisible, so the browser stops painting the page (which keeps running, and keeps its state), and the panel lets go of its canvas and texture; drawn again, it draws its last frame again. Images more than a viewport away from the page's viewport are not embedded in frames, nor fetched: a transparent image of their size stands in, so the layout is the same ([#87](https://github.com/urth-inc/three-html-panel/pull/87)).
- The agent calls `getAnimations()`, `getKeyframes()` and `Intl.Segmenter`, which every supported browser has, without checking for them first ([#90](https://github.com/urth-inc/three-html-panel/pull/90)).

### Fixed

- Sliders (`<input type="range">`) move: a press sets the value where it lands, a drag follows the pointer (a finger or controller drag moves the thumb rather than scrolling), and once focused, the arrows, Page Up/Down, Home and End step it. The page gets `input` as the value changes and `change` when it is committed. Before, synthetic presses and keys left a slider where it was in Chromium and Firefox; in WebKit, a press moved it but a drag did not ([#92](https://github.com/urth-inc/three-html-panel/pull/92)).

## 0.2.5 - 2026-10-13

### Fixed

- iOS: open the soft keyboard when a text field the page focused on its own is tapped. A page that focuses a field outside a tap (an `autofocus`, or a focus after a press elsewhere) took the keyboard's hidden field outside the tap too, for which iOS shows no keyboard; a tap on the field then found it focused already and did nothing. A tap now focuses it again when no soft keyboard is up, judged by the visual viewport's height ([#84](https://github.com/urth-inc/three-html-panel/pull/84)).

## 0.2.4 - 2026-10-13

### Fixed

- Draw Web Components: the content of shadow roots (open ones, and closed ones the page attaches by script) and the light DOM children at the slots they are assigned to. Before, only the light DOM was copied, so a custom element's shadow content was missing and everything after it was drawn higher than it is, away from where presses land. Presses, hover, focus and Tab now reach elements inside shadow roots, `document.activeElement` and `ShadowRoot.activeElement` answer as in browsers, and changes inside shadow roots are captured ([#81](https://github.com/urth-inc/three-html-panel/pull/81)).
- Draw CSS whose values the browser's CSSOM loses: a shorthand with `var()` partly overridden by a longhand in the same rule (a spinner's `border` with `border-top-color`) lost its other values, in every browser ([#80](https://github.com/urth-inc/three-html-panel/pull/80)).
- Show an indeterminate `<progress>` (one with no value) moving, as browsers draw it ([#80](https://github.com/urth-inc/three-html-panel/pull/80)).
- Taps on a panel shown small: a tap's slop is now measured on the screen (10px for touch, about 1° in XR), not as 8px of the page, so a slight shake of the finger no longer turns a tap into a pan. The host sends it with each press (`slop`, optional in the protocol); pages need this version of the agent too ([#80](https://github.com/urth-inc/three-html-panel/pull/80)).

## 0.2.3 - 2026-10-13

### Fixed

- iOS Safari: stop its text autosizing in the panel page, which enlarged text only in the live page (not in the drawn image), so clicks and the caret landed below form fields ([#74](https://github.com/urth-inc/three-html-panel/pull/74)).
- Safari: show the pointer cursor over links. WebKit computes `cursor: auto` for links and picks the hand natively, so the panel showed the text or default cursor ([#76](https://github.com/urth-inc/three-html-panel/pull/76)).

## 0.2.2 - 2026-10-13

### Fixed

- Pressing a button or link in a panel no longer opens the soft keyboard; it opens only for text fields ([#68](https://github.com/urth-inc/three-html-panel/pull/68)).
- Tapping a text field reopens a soft keyboard that was closed.
- Hiding the soft keyboard ends the IME composition in progress.

## 0.2.1 - 2026-10-13

### Fixed

- Draw `<picture>` images: the image the browser picked, at the size the page lays it out, or the fallback `src` (fitted in its box) until one is picked ([#64](https://github.com/urth-inc/three-html-panel/pull/64)).

## 0.2.0 - 2026-10-09

### Added

- Draw open popovers and modal `<dialog>`s above the page, as the browser's top layer does, with their `::backdrop`, in the order they were opened ([#57](https://github.com/urth-inc/three-html-panel/pull/57)).

## 0.1.0 - 2026-10-09

First release.
