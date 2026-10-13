// The example sites the demo shows, each on its own origin (see vite.config.ts):
// the scene and the switcher both read them from here.

export interface Site {
  name: string;
  title: string;
  /** What it is built with. */
  stack: string;
  description: string;
  url: URL;
}

const ABOUT: Record<string, Omit<Site, "name" | "url">> = {
  "web-standards": {
    title: "Web Platform Field Guide",
    stack: "HTML · CSS · JS",
    description: "Browser-native features with no framework: media, forms, layout, popovers.",
  },
  "hn-reader": {
    title: "HN Reader",
    stack: "Vue · Vuetify",
    description: "A Hacker News reader: lists, menus, infinite scrolling.",
  },
  chat: {
    title: "Chat",
    stack: "React · Mantine",
    description: "A chat app with rich text, mentions and notifications.",
  },
  gallery: {
    title: "Gallery",
    stack: "Svelte",
    description: "A photo gallery and editor: filters, sliders, drag and drop.",
  },
};

export const SITES: readonly Site[] = Object.entries(import.meta.env.VITE_SITES).flatMap(
  ([name, origin]) => {
    const about = ABOUT[name];
    return about ? [{ name, ...about, url: new URL("/", origin) }] : [];
  },
);

export const siteNamed = (name: unknown): Site | undefined =>
  SITES.find((site) => site.name === name);

/** What the switcher sends when a site is chosen, and the scene, which one is shown. */
export interface SiteMessage {
  site: string;
}

/** A message from the switcher, checked: it comes from a page, which could send anything. */
export function parseSiteMessage(data: unknown): Site | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  return siteNamed((data as Partial<SiteMessage>).site);
}
