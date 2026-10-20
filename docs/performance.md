# Performance

What makes a panel cheap or costly to update, beyond [keeping the page small](../README.md#performance-keep-the-page-small).

## What a frame costs

Whenever the page changes, the agent copies the whole page into an SVG image: its DOM, its CSS (but `@media` rules that do not apply), and the fonts and images it shows, as data URLs. The host decodes the image on its main thread, rasterizes it into the panel's texture and uploads the texture. The first two grow with the page; the last two with the panel's pixels.

### The CSS the copy writes out

The copy takes the page's rules from the CSSOM, which writes some declarations out longer than the page did:

- A shorthand with `var()` in it (`background`, `border`, `border-color`, `outline`, `font`, ...) has no value in the CSSOM until it is computed. The copy then writes the computed values into the style of every element the rule matches. Use longhands (`background-color`, `border-left-color`, `outline-color`), which keep `var()`.
- A longhand after a shorthand in one rule (`font: …; font-variant-numeric: …`) makes the CSSOM write the shorthand out as all of its longhands. Put the longhand in another rule, or before the shorthand.
- `border: 0` with `border-left: 4px solid` becomes `border-width`, `border-style` and each side's colour. An inset `box-shadow` draws the same stripe in one declaration.

## The panel's pixels

Each new frame is rasterized at `width` × `height` × `pixelRatio`² pixels (at most 4096 on a side). With mipmaps, a 1024×720 panel at `pixelRatio` 2 holds about 16 MB; at 1, about 4 MB.

- **Lay the page out at a smaller `width` and `height`**, keeping `size`: the panel is as large in the scene, and its text and controls are larger in it. 512×360 has a quarter of the pixels of 1024×720, and a page designed for it needs fewer elements.
- **Lower `pixelRatio`** where the panel is not seen up close: 1 has a quarter of the pixels of the default 2. It is a ceiling: the texture's resolution follows how large the panel is drawn, down to a quarter of it, so a lower `pixelRatio` saves most while the panel is near. Enough is about the device pixels the panel covers on screen, divided by `width`: on a headset with about 25 pixels per degree, a panel 1 m wide seen from 1.5 m covers about 37°, some 920 pixels, which a 480 px wide page needs `pixelRatio` 2 for; from 2.5 m, about 1.2 is enough.

## What the panel does by itself

- Only what changed is sent: the agent captures on DOM changes, input and animation, and skips frames that look the same.
- A panel not drawn facing the camera for a second (out of view, behind, hidden) stops capturing; a panel drawn small captures at most 5 times a second.
- A panel not drawn for 10 seconds rests: its iframe is moved off screen and made invisible, so the browser stops painting the page (which keeps running, and keeps its state), and the panel lets go of its canvas and texture. Drawn again, it draws the last frame again, showing its `background` for a moment.
- Images more than a viewport away from the page's viewport are not embedded in frames, nor fetched: a transparent image of their size stands in, so the layout is the same.

These rely on the scene being rendered every frame. Without WebGL (a panel that takes input but is never drawn), pass `pauseWhenHidden: false`.

`optimizeHover: true` skips captures when an unpressed pointer moves within the same element without changing hover or scrollbar state. Pointer events still fire, and DOM mutations still trigger captures. Changes through the CSSOM methods (`insertRule`, `replaceSync`, ...) trigger captures too. Set `optimizeHover: false` for pages that draw to canvas, edit CSS rules' declarations in place (`rule.style`), or update other visual state without DOM mutations in pointer handlers.
