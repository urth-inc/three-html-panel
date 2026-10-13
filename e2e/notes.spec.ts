// The sticky notes board (examples/sites/notes): an ordinary page that knows nothing
// of the panel. Typing in a note, dragging a note by its bar, and the caret of
// a note scrolled by part of a line.

import { expect, test } from "@playwright/test";
import { PanelPage } from "./panel";

let panel: PanelPage;

test.beforeEach(async ({ page }) => {
  panel = await PanelPage.open(page, "notes", 960, 640);
});

/** The notes come after the hint in the board: the second note is the board's third child. */
const NOTE = ".board-inner > .note:nth-child(3)";

test("lets a soft keyboard show only while a text field has focus", async ({ page }) => {
  // The host's hidden field (PanelKeyboard): focused, and whether a soft keyboard may show.
  const field = () =>
    page.evaluate(() => {
      const field = document.querySelector("textarea[aria-hidden]")!;
      return {
        focused: document.activeElement === field,
        inputmode: field.getAttribute("inputmode"),
      };
    });
  const dot = await panel.at(`${NOTE} .dot`);
  // A button: its keys go to the page, but no soft keyboard.
  await panel.focus(dot);
  expect(await field()).toEqual({ focused: true, inputmode: "none" });
  await panel.focus(await panel.at(`${NOTE} textarea`, 0.8, 0.8));
  await expect.poll(field).toEqual({ focused: true, inputmode: null });
  // From a button to a text field the hidden field is focused again (to open the
  // soft keyboard): keys still go in after that.
  await page.keyboard.type("typed here");
  await expect
    .poll(() =>
      panel.frame.evaluate(
        (note) => document.querySelector<HTMLTextAreaElement>(`${note} textarea`)!.value,
        NOTE,
      ),
    )
    .toContain("typed here");
  await panel.focus(dot);
  await expect.poll(field).toEqual({ focused: true, inputmode: "none" });
});

test("takes typing in a note", async ({ page }) => {
  await panel.focus(await panel.at(`${NOTE} textarea`, 0.8, 0.8));
  await page.keyboard.type("typed here");
  await expect
    .poll(() =>
      panel.frame.evaluate(
        (note) => document.querySelector<HTMLTextAreaElement>(`${note} textarea`)!.value,
        NOTE,
      ),
    )
    .toContain("typed here");
});

test("moves a note dragged by its bar, which the page captures the pointer for", async () => {
  const before = await panel.box(NOTE);
  const bar = await panel.box(`${NOTE} .note-bar`);
  // Right of the color dots, left of the close button.
  const from = panel.screen(bar.left + bar.width - 40, bar.top + bar.height / 2);
  await panel.drag(from, { x: from.x + 100, y: from.y + 80 });
  // The moves reach the page through a port: wait for the last one.
  await expect
    .poll(async () => {
      const after = await panel.box(NOTE);
      return [Math.round(after.left - before.left), Math.round(after.top - before.top)];
    })
    .toEqual([Math.round(100 / panel.scale), Math.round(80 / panel.scale)]);
});

test("cuts the caret to the note when its line is scrolled half out of view", async ({ page }) => {
  const field = `${NOTE} textarea`;
  await panel.focus(await panel.at(field, 0.5, 0.3));
  const text = "Sticky notes keep a few lines of text. ".repeat(6);
  // Most of it put in at once (typing it all took over 20 s in CI), the caret at
  // its end; the rest typed, which scrolls the field to the caret as typing does.
  const typed = "of text. ";
  await panel.frame.evaluate(
    ({ field, value }) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(field)!;
      textarea.value = value;
      textarea.setSelectionRange(value.length, value.length);
    },
    { field, value: text.slice(0, -typed.length) },
  );
  await page.keyboard.type(typed);
  // All typed before scrolling it back.
  await expect
    .poll(() =>
      panel.frame.evaluate(
        (field) => document.querySelector<HTMLTextAreaElement>(field)!.value,
        field,
      ),
    )
    .toBe(text);
  // Scroll back by half a line (past the bottom padding): the line with the
  // caret (the last) is cut by the bottom, whatever the fonts.
  await panel.frame.evaluate((field) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(field)!;
    const style = getComputedStyle(textarea);
    const back = parseFloat(style.paddingBottom) + parseFloat(style.lineHeight) / 2;
    textarea.scrollTop = textarea.scrollHeight - textarea.clientHeight - back;
  }, field);
  const box = await panel.frame.evaluate((field) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(field)!;
    const rect = textarea.getBoundingClientRect();
    return {
      top: rect.top + textarea.clientTop,
      bottom: rect.top + textarea.clientTop + textarea.clientHeight,
    };
  }, field);
  await expect
    .poll(async () => {
      const caret = await panel.caret();
      return caret && caret.y + caret.height;
    })
    .toBeCloseTo(box.bottom, 0);
  const caret = (await panel.caret())!;
  expect(caret.y).toBeGreaterThanOrEqual(box.top);
  // Cut: shorter than a line.
  expect(caret.height).toBeLessThan(16);
});

test("keeps the caret after a space that ends a wrapped line on that line", async ({ page }) => {
  const field = `${NOTE} textarea`;
  const text = "Sticky notes keep a few lines of text. ".repeat(3);
  // A width at which the last space ends a line, hanging past the edge: the
  // caret after it stays on that line (Chromium, WebKit), though a marker put
  // after it there wraps to the next. Found by trying, whatever the fonts.
  const found = await panel.frame.evaluate(
    ({ field, text }) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(field)!;
      textarea.value = text;
      textarea.style.overflow = "hidden";
      textarea.style.boxSizing = "border-box";
      const style = getComputedStyle(textarea);
      const probe = document.createElement("div");
      for (const property of ["font", "letter-spacing", "word-spacing", "tab-size"]) {
        probe.style.setProperty(property, style.getPropertyValue(property));
      }
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        whiteSpace: "pre-wrap",
      });
      probe.append(text.slice(0, -1));
      const space = probe.appendChild(document.createElement("span"));
      space.textContent = " ";
      const end = probe.appendChild(document.createElement("span"));
      end.textContent = "\u200b";
      document.body.appendChild(probe);
      const sides = ["padding-left", "padding-right", "border-left-width", "border-right-width"];
      const frame = sides.reduce((sum, side) => sum + parseFloat(style.getPropertyValue(side)), 0);
      try {
        for (let width = 120; width <= 400; width++) {
          probe.style.width = `${width - frame}px`;
          if (end.offsetTop !== space.offsetTop) {
            textarea.style.width = `${width}px`;
            textarea.setSelectionRange(text.length - 1, text.length - 1);
            return true;
          }
        }
        return false;
      } finally {
        probe.remove();
      }
    },
    { field, text },
  );
  // Firefox puts a marker after a hanging space on its line too: nothing to check.
  test.skip(!found, "no width wraps after the last space here");
  await panel.focus(await panel.at(field, 0.5, 0.2));
  // Setting the selection does not scroll the field; a key press later would,
  // moving the line between the two carets compared. Scrolled to the end at once.
  await panel.frame.evaluate(
    ({ field, at }) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(field)!;
      textarea.setSelectionRange(at, at);
      textarea.scrollTop = textarea.scrollHeight;
    },
    {
      field,
      at: text.length - 1,
    },
  );
  // Before the space, then after it: the same line.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      panel.frame.evaluate(
        (field) => document.querySelector<HTMLTextAreaElement>(field)!.selectionEnd,
        field,
      ),
    )
    .toBe(text.length - 1);
  // The caret reported once the field shows its whole line (not cut by an edge).
  await expect.poll(async () => (await panel.caret())?.height ?? 0).toBeGreaterThan(10);
  const before = (await panel.caret())!;
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      panel.frame.evaluate(
        (field) => document.querySelector<HTMLTextAreaElement>(field)!.selectionEnd,
        field,
      ),
    )
    .toBe(text.length);
  await expect.poll(async () => (await panel.caret())?.x ?? null).toBeGreaterThan(before.x);
  expect((await panel.caret())!.y).toBeCloseTo(before.y, 0);
});

test("stops the page's frames while the panel is out of view, and shows it as it is now once back", async ({
  page,
}) => {
  test.skip(!panel.drawn, "without WebGL the panel is never drawn, so it is never paused");
  // Waits of up to 15 s below (see there): more than the usual 30 s in all.
  test.slow();
  // The host tells by its render loop and its own timer. A browser that holds
  // both back, in a page it takes as not shown (headless WebKit on Linux), never
  // gets to tell: there is nothing to check.
  const rendering = await page.evaluate(
    () =>
      new Promise<{ frames: number; visibility: string }>((resolve) => {
        let frames = 0;
        const tick = () => {
          frames++;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(() => resolve({ frames, visibility: document.visibilityState }), 500);
      }),
  );
  test.skip(
    rendering.frames < 5,
    `the host page is not rendering: ${rendering.frames} animation frames in 500 ms, ${rendering.visibility}`,
  );
  // Something that keeps changing: frames keep coming while the panel is seen.
  await panel.frame.evaluate(() => {
    const style = document.createElement("style");
    style.textContent =
      "@keyframes e2e-spin { to { transform: rotate(360deg) } } .e2e-spin { position: fixed; right: 40px; bottom: 40px; width: 40px; height: 40px; background: #3b82f6; animation: e2e-spin 1s linear infinite }";
    document.head.appendChild(style);
    const spinner = document.createElement("div");
    spinner.className = "e2e-spin";
    document.body.appendChild(spinner);
  });
  const framesIn = async (ms: number) => {
    const before = await page.evaluate(() => window.harness.frames);
    await page.waitForTimeout(ms);
    return (await page.evaluate(() => window.harness.frames)) - before;
  };
  await expect.poll(() => framesIn(400)).toBeGreaterThan(0);
  // Out of view: after a second without being drawn, no more frames. The host
  // tells by its own timer, which a browser drawing in software can hold up for
  // seconds (headless WebKit on Linux in CI stalled the page for about 5 s): the
  // waits allow for that.
  await page.evaluate(
    () => ((window.harness.panel as { position: { x: number } }).position.x = 100),
  );
  await expect.poll(() => framesIn(400), { timeout: 15_000 }).toBe(0);
  const hidden = await page.evaluate(() => window.harness.frames);
  // The page changes meanwhile: its text.
  const field = `${NOTE} textarea`;
  await panel.frame.evaluate(
    (field) => (document.querySelector<HTMLTextAreaElement>(field)!.value = "changed out of view"),
    field,
  );
  expect(await framesIn(400)).toBe(0);
  // Back in view: frames come again, the first one at once.
  await page.evaluate(() => ((window.harness.panel as { position: { x: number } }).position.x = 0));
  await expect
    .poll(() => page.evaluate(() => window.harness.frames), { timeout: 15_000 })
    .toBeGreaterThan(hidden);
});

test("paints a page's body background over the whole panel, as browsers do", async () => {
  // A short page whose background is the body's (the root's is transparent).
  await panel.frame.evaluate(() => {
    document.body.innerHTML = "<p>short</p>";
    document.documentElement.style.background = "transparent";
    document.body.style.height = "auto";
    document.body.style.background = "rgb(37, 99, 235)";
  });
  await panel.ifDrawn(() =>
    expect
      .poll(async () => {
        // Far below the body's content: only a propagated background reaches here.
        const [red, green, blue] = await panel.pixel(900, 600);
        return red < 80 && green > 70 && green < 130 && blue > 200;
      })
      .toBe(true),
  );
});

test("draws an open popover over the page, where the page shows it, and not once it is closed", async () => {
  // In a clipped, transformed box: the popover is in the top layer, out of it.
  // Its color comes from a rule through the box, which must still match it;
  // the box's ::after, cut to the box, must not be drawn again over the page.
  await panel.frame.evaluate(() => {
    const box = document.createElement("div");
    box.className = "clip";
    box.style.cssText =
      "position: absolute; left: 0; top: 0; width: 10px; height: 10px; overflow: hidden; transform: translateX(1px)";
    box.innerHTML = `<style>.clip > button + #pop { background: rgb(220, 20, 20) } .clip::after { content: ""; position: absolute; inset: 0; background: rgb(20, 20, 220) }</style><button>Open</button><div id="pop" popover style="margin: 0; inset: auto; left: 600px; top: 400px; width: 200px; height: 100px; border: 0"></div>`;
    document.body.append(box);
  });
  const red = async () => {
    const [r, g, b] = await panel.pixel(700, 450);
    return r > 180 && g < 60 && b < 60;
  };
  await panel.ifDrawn(async () => {
    // Drawn with the box, then opened (which changes nothing in the DOM).
    await expect.poll(red).toBe(false);
    await panel.frame.page().waitForTimeout(300);
    await panel.frame.evaluate(() => document.querySelector<HTMLElement>("#pop")!.showPopover());
    await expect.poll(red).toBe(true);
    const [r, g, b] = await panel.pixel(100, 600);
    expect(b > 180 && r < 60 && g < 60).toBe(false);
    await panel.frame.evaluate(() => document.querySelector<HTMLElement>("#pop")!.hidePopover());
    await expect.poll(red).toBe(false);
  });
});

test("draws a modal dialog over its ::backdrop, and a popover opened after it over both", async () => {
  // The toast comes first in the page, but is opened last: it is on top.
  await panel.frame.evaluate(() => {
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<style>#ask::backdrop { background: rgb(0 160 0 / 60%) }</style>
      <div id="toast" popover style="margin: 0; inset: auto; left: 40px; top: 40px; width: 120px; height: 60px; border: 0; background: rgb(20, 20, 220)"></div>
      <dialog id="ask" style="margin: 0; inset: auto; left: 600px; top: 400px; width: 200px; height: 100px; padding: 0; border: 0; background: rgb(220, 20, 20)"></dialog>`,
    );
    document.querySelector<HTMLDialogElement>("#ask")!.showModal();
  });
  const color = async (x: number, y: number) => {
    const [r, g, b] = await panel.pixel(x, y);
    return r > 180 && g < 60 && b < 60
      ? "red"
      : b > 180 && r < 60 && g < 60
        ? "blue"
        : g > r + 40 && g > b + 40
          ? "green"
          : "other";
  };
  await panel.ifDrawn(async () => {
    await expect.poll(() => color(700, 450)).toBe("red");
    await expect.poll(() => color(300, 300)).toBe("green");
    await panel.frame.evaluate(() => document.querySelector<HTMLElement>("#toast")!.showPopover());
    await expect.poll(() => color(100, 70)).toBe("blue");
  });
});

test("draws a rotated popover, centred with a translation in %, as the page does", async () => {
  // Red on its left half, blue on its right: turned a quarter, red on top.
  await panel.frame.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="turned" popover style="margin: 0; inset: auto; left: 700px; top: 450px; width: 200px; height: 100px; border: 0; padding: 0; translate: -50% -50%; rotate: 90deg; background: linear-gradient(to right, rgb(220, 20, 20) 50%, rgb(20, 20, 220) 50%)"></div>`,
    );
    document.querySelector<HTMLElement>("#turned")!.showPopover();
  });
  await panel.ifDrawn(async () => {
    await expect
      .poll(async () => {
        const [r, , b] = await panel.pixel(725, 380);
        return r > 180 && b < 60;
      })
      .toBe(true);
    const [r, , b] = await panel.pixel(725, 520);
    expect(b > 180 && r < 60).toBe(true);
  });
});

test("draws the selection of text in a popover over it, though the box the popover is in clips", async () => {
  await panel.frame.evaluate(() => {
    const box = document.createElement("div");
    box.style.cssText =
      "position: absolute; left: 0; top: 0; width: 10px; height: 10px; overflow: hidden; transform: translateX(1px)";
    box.innerHTML = `<div id="pop" popover style="margin: 0; inset: auto; left: 500px; top: 400px; width: 400px; height: 120px; border: 0; padding: 0; background: white"><p id="words" style="margin: 0; font: 80px/1 monospace; color: white">MMMMMM</p></div>`;
    document.body.append(box);
    document.querySelector<HTMLElement>("#pop")!.showPopover();
    getSelection()!.selectAllChildren(document.querySelector("#words")!);
  });
  await panel.ifDrawn(() =>
    expect
      .poll(async () => {
        const [r, g, b] = await panel.pixel(560, 440);
        return r < 235 && g < 235 && b < 245;
      })
      .toBe(true),
  );
});
