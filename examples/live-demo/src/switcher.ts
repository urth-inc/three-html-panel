// The switcher: a page shown as a panel next to the site, to choose which site
// the scene shows. It tells the scene with sendToHost(), and hears back which
// one is shown. The agent comes first, before anything else on the page.
import { startAgent } from "@urth/three-html-panel/agent";
import { onHostMessage, sendToHost } from "@urth/three-html-panel/page";
import { SITES, parseSiteMessage, type SiteMessage } from "./sites";

startAgent({ hostOrigin: import.meta.env.VITE_HOST_ORIGIN });

const list = document.querySelector<HTMLUListElement>("#sites")!;
const buttons = new Map<string, HTMLButtonElement>();

for (const site of SITES) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  const title = document.createElement("strong");
  title.textContent = site.title;
  const stack = document.createElement("span");
  stack.className = "stack";
  stack.textContent = site.stack;
  const description = document.createElement("span");
  description.className = "description";
  description.textContent = site.description;
  button.append(title, stack, description);
  button.addEventListener("click", () => {
    markCurrent(site.name);
    sendToHost({ site: site.name } satisfies SiteMessage);
  });
  buttons.set(site.name, button);
  item.append(button);
  list.append(item);
}

function markCurrent(name: string): void {
  for (const [siteName, button] of buttons) {
    if (siteName === name) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

// Shown first: the one the scene opened with; then each one it shows.
markCurrent(new URLSearchParams(location.search).get("current") ?? "");
onHostMessage((data) => {
  const site = parseSiteMessage(data);
  if (site) markCurrent(site.name);
});
