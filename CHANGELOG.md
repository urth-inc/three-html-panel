# Changelog

Changes to the `@urth/three-html-panel` package. Changes to the demo and example sites are not listed.

Each version's section is also the release notes of its [GitHub Release](https://github.com/urth-inc/three-html-panel/releases), made when its tag is pushed.

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
