// The script a panel page loads, before its own scripts:
//
//   <script type="module" src=".../agent.js" data-host-origin="https://host.example"></script>
//
// data-host-origin may name several origins the host may be on, separated by
// white space ("https://host.example https://staging.example").
//
// It has to run first because it replaces focus() and pointer capture in the
// page, and the page's code should only ever see the replacements.

import { readHostOrigins, startAgent } from "./agent";

const hostOrigins = readHostOrigins(document);
if (!hostOrigins) {
  console.warn(
    "[three-html-panel] the agent is not started: its <script> needs data-host-origin set to the host's origin (or origins, separated by spaces)",
  );
} else {
  startAgent({ hostOrigin: hostOrigins });
}
