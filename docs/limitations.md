# Limitations

## What is drawn

- Only what the DOM and CSS describe: no iframes from other origins, no native widgets but `<select>`'s list (no date pickers, no video controls).
- CSS transitions, and animations that end, jump to their end. Animations that repeat forever, and values a script sets on each frame, are drawn as they go.
- `backdrop-filter` is not drawn: browsers do not apply it in SVG images.
- A cross-origin video without CORS shows only its poster.
- Open popovers and modal dialogs (the top layer) are drawn over the page, moved out of their parents in the copy. There, rules that look at the `<body>`'s siblings, or at more than 16 later siblings of an element or its parents (`:nth-last-child`, `:has(~ …)`), may not match.

## Scrolling

Scrolled content is drawn by moving it in the copy. In a scroll container whose content starts with bare text, floats, multiple columns or vertical writing, the children are moved one by one instead: bare text in it does not move (wrap it in an element), absolutely positioned elements placed from outside it are cut off at its edges, and its sticky elements are drawn over its content.

## Input

- A slider takes its value as if its thumb were 16 px wide: with a larger thumb, a press near the ends is a few px off.
- contenteditable editing relies on `document.execCommand()`; editors that handle input otherwise may not work.
- No IME in VR. Touch and VR were tested in emulation, not on devices.

## Hover, press and focus

The page never gets a real pointer or focus, so the agent marks the elements (`data-thp-hover`, `data-thp-active`, `data-thp-focus`, `data-thp-focus-visible`, `data-thp-focus-within`) and rewrites the page's `:hover`, `:active`, `:focus`, `:focus-visible`, `:focus-within` (and, in the copy, `:popover-open` and `:modal`) to match them: `.row:hover` becomes `.row:is(:hover,[data-thp-hover])`. The page's scripts see the rewritten selectors, in its stylesheets, selector queries and CSSOM methods. Shadow roots' stylesheets are not rewritten; the interaction rules of a cross-origin stylesheet without CORS come after the page's own.

## Same-site pages

A same-site page shares the host's main thread: a heavy one slows the scene.
