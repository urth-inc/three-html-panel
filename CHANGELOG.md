# Changelog

Changes to the `@urth/three-html-panel` package. Changes to the demo and example sites are not listed.

Each version's section is also the release notes of its [GitHub Release](https://github.com/urth-inc/three-html-panel/releases), made when its tag is pushed.

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
