# Performance

Beyond [keeping the page small](../README.md#performance-keep-the-page-small).

## CSS the copy writes out longer

The copy takes the page's rules from the CSSOM, which writes some declarations out longer than the page did:

- A shorthand with `var()` (`background`, `border`, `border-color`, `outline`, `font`, ...) has no value until computed: the copy writes the computed values into the style of every element it matches. Use longhands (`background-color`, `outline-color`).
- A longhand after a shorthand in one rule (`font: …; font-variant-numeric: …`) writes the shorthand out as all of its longhands. Put the longhand in another rule.
- `border: 0` with `border-left: 4px solid` becomes every side's width, style and colour. An inset `box-shadow` draws the stripe in one declaration.

## The panel's pixels

Each frame is rasterized and uploaded at `width` × `height` × `pixelRatio`² pixels (at most 4096 on a side). A 1024×720 panel at `pixelRatio` 2 holds about 16 MB with mipmaps; at 1, about 4 MB.

- **A smaller `width` and `height`**, with the same `size`, keep the panel as large in the scene, with larger text: 512×360 has a quarter of the pixels of 1024×720.
- **A lower `pixelRatio`** where the panel is not seen up close. It is a ceiling: the texture follows how large the panel is drawn. Enough is the device pixels the panel covers, divided by `width`: on a headset with about 25 pixels per degree, a panel 1 m wide seen from 1.5 m covers some 920 pixels, which a 480 px wide page needs `pixelRatio` 2 for; from 2.5 m, about 1.2.

## What the panel does by itself

- The agent captures on DOM changes, input and animation, and skips frames that look the same.
- A panel not drawn facing the camera for a second stops capturing; one drawn small captures at most 5 times a second. After 10 seconds it rests: its iframe stops painting (the page keeps running) and it lets go of its texture, showing its `background` for a moment when drawn again. This relies on the scene being rendered every frame; without WebGL, pass `pauseWhenHidden: false`.
- Images more than a viewport away are neither embedded nor fetched; a transparent image of their size stands in.
- `optimizeHover` skips captures when an unpressed pointer moves within one element without changing hover. Pointer events still fire, and DOM and CSSOM changes still trigger captures. Set it to `false` for pages that draw to canvas, edit `rule.style` in place, or change what is shown in pointer handlers without changing the DOM.
