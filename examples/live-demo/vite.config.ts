// The live demo: a 3D scene that shows the example sites (examples/sites/),
// one at a time, and a panel to choose one (switcher.html). It is a package of
// its own that uses the published @urth/three-html-panel, as any app would.
//
// `vp dev` serves it on :5179 and shows the sites from their own ports (start
// them for it with `pnpm dev:live-demo` at the root, which tells them this
// origin). `vp build --mode deploy` needs VITE_HOST_ORIGIN, where the demo is
// deployed, and shows the sites whose VITE_SITE_*_ORIGIN is set (see
// .env.example); the sites must be built with the same VITE_HOST_ORIGIN.

import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite-plus";
import { SITE_NAMES, SITE_PORTS, siteOriginVariable } from "../sites/vite.site.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PORT = 5179;
const DEPLOY_MODE = "deploy";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, ROOT, "VITE_");
  const deploying = mode === DEPLOY_MODE;
  // Built without --mode deploy, for `vp preview`: the ports `vp preview` uses (1000 below).
  const local = command === "build" ? 1000 : 0;
  const host = env.VITE_HOST_ORIGIN || `http://localhost:${PORT - local}`;
  if (deploying && !env.VITE_HOST_ORIGIN)
    throw new Error("VITE_HOST_ORIGIN is not set: where the live demo is deployed");
  const sites = Object.fromEntries(
    SITE_NAMES.flatMap((name) => {
      const origin = env[siteOriginVariable(name)];
      if (origin) return [[name, origin]];
      // Deployed, only the sites deployed too.
      return deploying ? [] : [[name, `http://localhost:${SITE_PORTS[name] - local}`]];
    }),
  );
  if (Object.keys(sites).length === 0)
    throw new Error("No site to show: set a VITE_SITE_*_ORIGIN (see .env.example)");
  const server = {
    port: PORT,
    strictPort: true,
    // The switcher is shown sandboxed, on the opaque origin "null", and so is
    // every request it makes for its own scripts and styles.
    cors: { origin: [host, "null"] },
  };
  return {
    root: import.meta.dirname,
    base: "./",
    clearScreen: false,
    server,
    preview: { ...server, port: PORT - 1000 },
    define: {
      "import.meta.env.VITE_HOST_ORIGIN": JSON.stringify(host),
      "import.meta.env.VITE_SITES": JSON.stringify(sites),
    },
    // Deployed, the switcher's page and assets are readable from "null", as in
    // development: public/_headers, for Cloudflare Pages and Netlify.
    build: {
      // three.js alone is about 500 kB.
      chunkSizeWarningLimit: 800,
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, "index.html"),
          switcher: resolve(import.meta.dirname, "switcher.html"),
        },
      },
    },
  };
});
