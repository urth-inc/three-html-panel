// Starts the panel agent when the page is shown in a panel (an iframe of the
// scene at VITE_HOST_ORIGIN). Opened on its own, it does nothing and the site
// is an ordinary site. It must run before the site's other code: main.ts
// imports it first, so it runs before any other module's top level.

import { startAgent } from "@urth/three-html-panel/agent";

startAgent({ hostOrigin: import.meta.env.VITE_HOST_ORIGIN });
