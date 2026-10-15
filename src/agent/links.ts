// Links in the panel page go to the host.
//
// Followed inside the panel, a link would either do nothing (a target="_blank"
// link opens a popup, which the browser blocks: the click is synthetic, so there
// is no user activation) or replace the panel with a page that has no agent,
// leaving the panel blank. So link clicks that the page does not cancel, and the
// page's window.open(), are handed to the host, which opens them (in a new tab,
// by default). Links within the page (#fragment) are left alone.

import { OPENABLE_PROTOCOLS } from "../protocol";
import type { FrameWindow } from "../types";

/** The absolute URL a link or window.open() names, if the host should open it. */
function openableUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    return OPENABLE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Whether `url` only moves within the current document (a #fragment). */
function isInPage(url: string, location: Location): boolean {
  const target = new URL(url);
  const here = new URL(location.href);
  return (
    target.hash !== "" &&
    target.origin === here.origin &&
    target.pathname === here.pathname &&
    target.search === here.search
  );
}

/** Hands the page's link clicks and window.open() to `open`. Returns a function that stops it. */
export function interceptLinks(window: FrameWindow, open: (url: string) => void): () => void {
  const { document } = window;

  // Whether the page cancels a click is known only once its handlers ran. A
  // listener added on the window while the click is being captured runs at
  // the end of the bubbling, after the page's own.
  const onClickCapture = (event: MouseEvent) => {
    const target = event.target instanceof window.Element ? event.target : null;
    const link = target?.closest<HTMLAnchorElement | HTMLAreaElement>("a[href], area[href]");
    if (!link || link.hasAttribute("download")) return;
    const url = openableUrl(link.getAttribute("href")!, document.baseURI);
    if (!url || isInPage(url, window.location)) return;
    const decide = (bubbled: Event) => {
      window.removeEventListener("click", decide);
      if (bubbled !== event || event.defaultPrevented) return;
      event.preventDefault();
      open(url);
    };
    window.addEventListener("click", decide);
  };
  window.addEventListener("click", onClickCapture, true);

  const pageOpen = window.open;
  window.open = ((url?: string | URL) => {
    const href = url === undefined ? null : openableUrl(String(url), document.baseURI);
    if (href) open(href);
    // No window to give back: the page cannot reach what the host opened.
    return null;
  }) as typeof window.open;

  return () => {
    window.removeEventListener("click", onClickCapture, true);
    window.open = pageOpen;
  };
}
