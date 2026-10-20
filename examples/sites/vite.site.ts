// The Vite configuration every example site that is a package of its own
// (examples/sites/<name>/package.json) builds on. Each site is a separate
// origin, as a page shown in a panel would be: `vp dev` serves it on its own
// port, and `vp build` makes a site to deploy on its own.
//
// A site starts the agent itself, first thing in its entry (see the sites'
// agent module), with the host's origin from VITE_HOST_ORIGIN, the same
// variable the scene uses (see originsFor and .env.example). It imports the
// agent from the published package (@urth/three-html-panel, a dependency of
// its own), as any site would: a change to the library shows in the sites
// once it is published and their dependency raised.

import { defineConfig, type PluginOption, type UserConfig } from "vite";
import { originsFor, staticHeaders } from "../../vite.panels.config.ts";

/** Each site's port in development; `vp preview` uses this minus 1000 (as the scene: 5173 and 4173). */
export const SITE_PORTS = {
  "web-standards": 5175,
  "hn-reader": 5176,
  chat: 5177,
  gallery: 5178,
  // 5179 is the live demo's.
  timetable: 5180,
  zenn: 5181,
} as const;

export type SiteName = keyof typeof SITE_PORTS;

export const SITE_NAMES = Object.keys(SITE_PORTS) as SiteName[];

/** The variable that sets where a site is deployed, e.g. VITE_SITE_HN_READER_ORIGIN. */
export const siteOriginVariable = (name: SiteName) =>
  `VITE_SITE_${name.toUpperCase().replace(/-/g, "_")}_ORIGIN`;

export interface SiteOptions {
  name: SiteName;
  /** The site's directory (its vite.config.ts's import.meta.dirname). */
  dir: string;
  plugins?: PluginOption[];
  /** More configuration, merged over the shared one (shallowly). */
  config?: UserConfig;
}

export function siteConfig({ name, dir, plugins = [], config = {} }: SiteOptions) {
  return defineConfig(({ mode }) => {
    const host = originsFor(mode).host;
    const port = SITE_PORTS[name];
    const server = {
      strictPort: true,
      // Shown sandboxed (the scene's iframes are), the page is on the opaque
      // origin "null", and so is every request it makes for its own scripts
      // and styles. Opened directly, it is an ordinary page of its origin:
      // these are the demo's own sites, trusted, which send no sandbox.
      cors: { origin: [host, "null"] },
    };
    return {
      root: dir,
      base: "./",
      clearScreen: false,
      server: { ...server, port },
      preview: { ...server, port: port - 1000 },
      define: { "import.meta.env.VITE_HOST_ORIGIN": JSON.stringify(host) },
      // Deployed, the whole site is readable from "null", as in development.
      plugins: [...plugins, staticHeaders({ "/*": { "Access-Control-Allow-Origin": "*" } })],
      ...config,
    };
  });
}
