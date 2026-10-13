// The components page (examples/sites/components): custom elements with
// shadow roots, drawn as the browser shows them, with what follows them where
// the page has it, and pressed where they are drawn.

import { expect, test } from "@playwright/test";
import { PanelPage, type Box } from "./panel";

let panel: PanelPage;

test.beforeEach(async ({ page }) => {
  panel = await PanelPage.open(page, "components", 720, 720);
});

const STAR_ON = [245, 160, 10];
const STAR_OFF = [200, 200, 205];
const BADGE = [40, 120, 220];
const BADGE_DOT = [250, 220, 60];
const AFTER = [30, 160, 90];
const LATE = [220, 40, 160];

/** The box of the nth star (from 1), in the rating's shadow root. */
const star = (n: number): Promise<Box> =>
  panel.frame.evaluate((n) => {
    const rect = document
      .querySelector("#rating")!
      .shadowRoot!.querySelectorAll("button")
      [n - 1]!.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, n);

/** Whether the panel draws about this color at a fraction of a box. */
async function drawsColor(box: Box, color: number[], fx = 0.5, fy = 0.5): Promise<boolean> {
  const drawn = await panel.pixel(box.left + box.width * fx, box.top + box.height * fy);
  return drawn.every((value, index) => Math.abs(value - color[index]!) < 24);
}

const result = () => panel.frame.evaluate(() => document.querySelector("#result")!.textContent);

test("draws shadow roots, and what follows them, where the page shows them", async () => {
  await panel.ifDrawn(async () => {
    expect(await drawsColor(await star(1), STAR_ON)).toBe(true);
    expect(await drawsColor(await star(5), STAR_OFF)).toBe(true);
    const badge = await panel.box("#badge");
    expect(await drawsColor(badge, BADGE, 0.9)).toBe(true);
    // Its ::before, from a rule of its shadow root.
    expect(await drawsColor({ ...badge, left: badge.left + 20, width: 10 }, BADGE_DOT)).toBe(true);
    // As tall as the stars make the rating: not drawn higher than it is. (Clear of its label.)
    expect(await drawsColor(await panel.box("#after"), AFTER, 0.05)).toBe(true);
  });
});

test("presses what is drawn in a shadow root, and what follows it", async () => {
  const fourth = await star(4);
  await panel.click(panel.screen(fourth.left + fourth.width / 2, fourth.top + fourth.height / 2));
  await expect.poll(result).toBe("Rated 4. Pressed 0 times.");
  await panel.click(await panel.at("#after"));
  await expect.poll(result).toBe("Rated 4. Pressed 1 times.");
  await panel.ifDrawn(async () => {
    await expect.poll(async () => drawsColor(await star(4), STAR_ON)).toBe(true);
  });
});

test("moves the focus with Tab through a shadow root, which the page sees as its host's", async ({
  page,
}) => {
  const second = await star(2);
  await panel.focus(panel.screen(second.left + second.width / 2, second.top + second.height / 2));
  await page.keyboard.press("Tab");
  const focus = () =>
    panel.frame.evaluate(() => {
      const rating = document.querySelector("#rating")!;
      return {
        page: document.activeElement?.id,
        shadow: rating.shadowRoot!.activeElement?.getAttribute("aria-label"),
      };
    });
  await expect.poll(focus).toEqual({ page: "rating", shadow: "3 stars" });
});

test("draws a shadow root attached after the page loaded, as it changes", async () => {
  await panel.ifDrawn(async () => {
    await expect
      .poll(async () => drawsColor(await panel.box("#late"), LATE), { timeout: 5_000 })
      .toBe(true);
  });
});
