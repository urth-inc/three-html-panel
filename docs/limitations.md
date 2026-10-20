# Limitations

What a panel draws or does differently from the page in a browser tab. The [README](../README.md#limitations) lists the ones most pages meet.

## What is drawn

- Only what the DOM and CSS describe is drawn: no cross-origin iframes inside the page, no native widgets other than `<select>`'s list (no date pickers or video controls).
- CSS transitions, and animations that end, jump to their end. Animations that repeat forever, and values a script sets on each frame, are drawn as they go.
- `backdrop-filter` is not drawn: browsers do not apply it in the SVG images panels are drawn from.
- A cross-origin video without CORS shows only its poster.
- Open popovers and modal dialogs (the top layer) are drawn over the page, moved out of their parents in the copy. There, rules that look at the `<body>`'s siblings (`body:first-of-type`), or at more than 16 later siblings of the element or of one of its parents (`:nth-last-child`, `:has(~ …)`), may not match as on the page.

## Scrolling

Scrolled content is drawn by moving it in the copy of the page. A scroll container whose content starts with bare text (or other inline content), floats, multiple columns or vertical writing has its children moved one by one instead: bare text directly in it does not move, absolutely positioned elements placed from outside it are cut off at its edges, and its sticky elements are drawn over the rest of its content (`z-index: 1`). For bare text, wrapping it in an element avoids this.

## Input

- A slider (`<input type="range">`) takes its value from where it is pressed as if its thumb were 16 px wide: with a larger thumb styled by the page, a press near the ends is a few px off.
- contenteditable editing relies on `document.execCommand()`; editors that handle input in other ways may not work.
- No IME in VR. Touch and VR were tested in emulation, not on devices.

## Hover, press and focus

The panel page never gets a real pointer or real focus, so the agent keeps hover, press and focus itself. It marks the elements (`data-thp-hover`, `data-thp-active`, `data-thp-focus`, `data-thp-focus-visible`, `data-thp-focus-within`) and rewrites the page's `:hover`, `:active`, `:focus`, `:focus-visible` and `:focus-within` selectors (and `:popover-open` and `:modal`, for the copy) in place to match the marks too: `.row:hover` becomes `.row:is(:hover,[data-thp-hover])`. The page then lays out as the panel shows it, and a press lands on what is drawn.

The page's scripts see the marks and the rewritten selectors:

- in its stylesheets, and in its selector queries (`matches`, `closest`, `querySelector(All)`, wrapped to match them)
- through the wrapped CSSOM methods and setters that change stylesheets (`insertRule`, `replace`, `selectorText`, `disabled`, `adoptedStyleSheets`, ...)

The stylesheets of shadow roots are not rewritten. The interaction rules of a cross-origin stylesheet loaded without CORS come after the page's own.

## Same-site pages

A same-site page shares the host's main thread; a heavy one slows the scene. Prefer another site for panel pages.
