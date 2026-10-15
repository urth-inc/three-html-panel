// The scene controls (examples/sites/controls): a slider (<input type="range">),
// which synthetic presses and keys do not move in browsers. The agent does:
// a press sets the value where it lands, a drag follows the pointer, and the
// keys step it.

import { expect, test } from "@playwright/test";
import { PanelPage } from "./panel";

let panel: PanelPage;

test.beforeEach(async ({ page }) => {
  panel = await PanelPage.open(page, "controls", 640, 640);
  // What the page hears: each input, and each committed change.
  await panel.frame.evaluate(() => {
    const slider = document.querySelector<HTMLInputElement>("#size")!;
    const log: string[] = [];
    (window as unknown as { log: string[] }).log = log;
    for (const type of ["input", "change"])
      slider.addEventListener(type, () => log.push(`${type} ${slider.value}`));
  });
});

const value = () => panel.frame.locator("#size").inputValue();
const shown = () => panel.frame.locator("#size-out").textContent();
const log = () => panel.frame.evaluate(() => (window as unknown as { log: string[] }).log);

/** A point on the slider, a fraction of the way along its track (where the thumb's middle goes). */
async function along(fraction: number) {
  const { left, top, width, height } = await panel.box("#size");
  const thumb = 16;
  return panel.screen(left + thumb / 2 + (width - thumb) * fraction, top + height / 2);
}

test("sets the value where the slider is pressed, and commits it on release", async () => {
  await panel.click(await along(0.75));
  // 50 to 150 in steps of 5: three quarters of the way is 125.
  await expect.poll(value).toBe("125");
  await expect.poll(shown).toBe("125%");
  expect(await log()).toEqual(["input 125", "change 125"]);
});

test("follows a drag, with one change at the release, and draws the thumb where it went", async () => {
  const end = await along(1);
  // Without WebGL (headless Firefox on Linux) the panel is not drawn: nothing to read.
  const before = panel.drawn ? await panel.pixel(end.x / panel.scale, end.y / panel.scale) : null;
  await panel.drag(await along(0.25), end);
  await expect.poll(value).toBe("150");
  const changes = (await log()).filter((entry) => entry.startsWith("change"));
  expect(changes).toEqual(["change 150"]);
  await panel.ifDrawn(async () => {
    // The thumb is drawn at the end of the track now: the image there changed.
    await expect
      .poll(() => panel.pixel(end.x / panel.scale, end.y / panel.scale))
      .not.toEqual(before);
  });
});

test("steps with the keys once focused", async ({ page }) => {
  await panel.focus(await along(0.5));
  await expect.poll(value).toBe("100");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(value).toBe("95");
  await page.keyboard.press("End");
  await expect.poll(value).toBe("150");
  await page.keyboard.press("PageDown");
  await expect.poll(value).toBe("140");
  await page.keyboard.press("Home");
  await expect.poll(value).toBe("50");
  await expect.poll(shown).toBe("50%");
});
