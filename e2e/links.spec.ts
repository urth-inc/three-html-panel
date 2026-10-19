// Links the user follows in a panel (here, put into the inbox page by the
// test): one to the panel's own origin opens in the panel, which connects to
// the page there and draws it; one to another origin opens in a new tab.

import { expect, test } from "@playwright/test";
import { PanelPage } from "./panel";

let panel: PanelPage;

test.beforeEach(async ({ page }) => {
  panel = await PanelPage.open(page, "inbox", 720, 480);
});

/** Puts a link at the top left of the page, over the rest, and returns where to press it. */
async function addLink(href: string) {
  const framesBefore = await panel.page.evaluate(() => window.harness.frames);
  await panel.frame.evaluate((href) => {
    const link = document.createElement("a");
    link.id = "test-link";
    link.href = href;
    link.textContent = "Go";
    link.style.cssText =
      "position:fixed;left:0;top:0;width:120px;height:60px;z-index:9;background:#fff;display:block";
    document.body.append(link);
  }, href);
  // Drawn (the page sends a frame with it), so that a press lands on it.
  await expect
    .poll(() => panel.page.evaluate(() => window.harness.frames))
    .toBeGreaterThan(framesBefore);
  return panel.at("#test-link");
}

test("opens a link to the panel's own origin in the panel, and draws the page there", async ({
  page,
}) => {
  const point = await addLink("../controls/");
  const framesBefore = await page.evaluate(() => window.harness.frames);
  await panel.click(point);
  // The panel's iframe goes to the page, which loads the agent, connects and sends frames.
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes("/examples/sites/controls/")))
    .toBe(true);
  await expect.poll(() => page.evaluate(() => window.harness.frames)).toBeGreaterThan(framesBefore);
  // No tab was opened for it.
  expect(page.context().pages()).toHaveLength(1);
});

test("goes back to the page it left when the page a link opened in the panel has no agent", async ({
  page,
}) => {
  panel = await PanelPage.open(page, "inbox", 720, 480, "&ready-timeout=2000");
  // A page of the panel's origin without the agent (a PDF or a 404 page, say).
  await page
    .context()
    .route("**/examples/sites/no-agent/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>No agent here</p>" }),
    );
  const point = await addLink("../no-agent/");
  await panel.click(point);
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes("/examples/sites/no-agent/")))
    .toBe(true);
  const framesBefore = await page.evaluate(() => window.harness.frames);
  // After the timeout, the panel's iframe is back on the inbox, which connects and draws again.
  await expect
    .poll(() => page.frames().some((frame) => frame.url().includes("/examples/sites/inbox/")))
    .toBe(true);
  await expect.poll(() => page.evaluate(() => window.harness.frames)).toBeGreaterThan(framesBefore);
  expect(page.context().pages()).toHaveLength(1);
});

test("opens a link to another origin in a new tab", async ({ page }) => {
  // Not loaded: the tab is what matters.
  await page.context().route("https://example.com/**", (route) => route.fulfill({ body: "" }));
  const point = await addLink("https://example.com/elsewhere");
  const tab = page.context().waitForEvent("page");
  await panel.click(point);
  expect((await tab).url()).toBe("https://example.com/elsewhere");
  // The panel stayed on its page.
  expect(page.frames().some((frame) => frame.url().includes("/examples/sites/inbox/"))).toBe(true);
});
