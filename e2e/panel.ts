// Drives a panel page through the e2e harness (harness/main.ts): opens it,
// finds elements in the page, and turns their page coordinates into points on
// the screen to press.

import { expect, test, type Frame, type Page } from "@playwright/test";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Caret {
  x: number;
  y: number;
  height: number;
  color: string;
}

export class PanelPage {
  private constructor(
    readonly page: Page,
    /** The panel page's own frame (another origin), to read and check what happened in it. */
    readonly frame: Frame,
    readonly scale: number,
    /** The panel is drawn (the browser has WebGL): what it shows can be checked. */
    readonly drawn: boolean,
  ) {}

  /** Opens `examples/sites/<name>/` in the harness, and waits for its first frames. */
  static async open(
    page: Page,
    name: string,
    width: number,
    height: number,
    /** More of the harness's query, as `&key=value`. */
    query = "",
  ): Promise<PanelPage> {
    // E2E_NO_WEBGL=1: as where the browser has no WebGL (see harness/main.ts).
    const noWebGL = process.env.E2E_NO_WEBGL ? "&no-webgl" : "";
    await page.goto(`/e2e/harness/?page=${name}&width=${width}&height=${height}${noWebGL}${query}`);
    const find = () =>
      page.frames().find((frame) => frame.url().includes(`/examples/sites/${name}/`));
    await expect.poll(() => find() !== undefined, { timeout: 15_000 }).toBe(true);
    const frame = find()!;
    // The page loads its fonts and images after its first frame: wait for the image to settle.
    await expect
      .poll(() => page.evaluate(() => window.harness.frames), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await page.waitForTimeout(500);
    const { scale, drawn } = await page.evaluate(() => ({
      scale: window.harness.scale,
      drawn: window.harness.drawn,
    }));
    return new PanelPage(page, frame, scale, drawn);
  }

  /** An element's box in the page (CSS px). */
  async box(selector: string): Promise<Box> {
    return this.frame.evaluate((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }, selector);
  }

  /** The point on screen of a point of the page (CSS px). */
  screen(x: number, y: number): { x: number; y: number } {
    return { x: x * this.scale, y: y * this.scale };
  }

  /** The point on screen at a fraction of an element's box (its middle by default). */
  async at(selector: string, fx = 0.5, fy = 0.5): Promise<{ x: number; y: number }> {
    const { left, top, width, height } = await this.box(selector);
    return this.screen(left + width * fx, top + height * fy);
  }

  async click(point: { x: number; y: number }, clickCount = 1): Promise<void> {
    await this.page.mouse.click(point.x, point.y, { clickCount });
    await this.page.waitForTimeout(250);
  }

  /**
   * Clicks something in the page that takes the keys (a field, an editable,
   * selected text, a control), and waits until the host gives them to the
   * panel: it does when the page reports the focus, which takes a capture.
   * Keys pressed before that go to the host's own page.
   */
  async focus(point: { x: number; y: number }, clickCount = 1): Promise<void> {
    await this.page.mouse.click(point.x, point.y, { clickCount });
    await expect
      .poll(() =>
        this.page.evaluate(() => {
          const panel = window.harness.panel as { editing: boolean };
          const active = document.activeElement;
          // The host's hidden field (PanelKeyboard), which the keys go through.
          return (
            panel.editing &&
            active instanceof HTMLTextAreaElement &&
            active.getAttribute("aria-hidden") === "true"
          );
        }),
      )
      .toBe(true);
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    const { mouse } = this.page;
    await mouse.move(from.x, from.y);
    await mouse.down();
    await mouse.move(to.x, to.y, { steps: 8 });
    await mouse.up();
    await this.page.waitForTimeout(250);
  }

  /** The text the panel offers for copying (the page's selection, or a field's). */
  selectedText(): Promise<string> {
    return this.page.evaluate(
      () => (window.harness.panel as unknown as { selected: string }).selected,
    );
  }

  /** The caret the page reported last, in its CSS px. */
  caret(): Promise<Caret | null> {
    return this.page.evaluate(
      () => (window.harness.panel as unknown as { caretBox: Caret | null }).caretBox,
    );
  }

  /**
   * Checks what the panel shows, where it is drawn. Without WebGL (headless
   * Firefox on Linux) they are skipped, noted in the report: the rest of the
   * test, the input and the page's state, still runs.
   */
  async ifDrawn(checks: () => Promise<void>): Promise<void> {
    if (this.drawn) await checks();
    else
      test
        .info()
        .annotations.push({ type: "skipped", description: "checks of the drawn image (no WebGL)" });
  }

  /** The color drawn at a point of the page (CSS px). */
  pixel(x: number, y: number): Promise<[number, number, number]> {
    return this.page.evaluate(([x, y]) => window.harness.pixel(x, y), [x, y] as const);
  }
}

declare global {
  interface Window {
    harness: {
      panel: unknown;
      scale: number;
      drawn: boolean;
      frames: number;
      pixel(x: number, y: number): [number, number, number];
    };
  }
}
