// The agent's API, for panel pages that start it from their own bundle (it must
// run before the page's other scripts). Pages that load it with a <script> tag
// use the self-starting build instead (entry.ts, published as agent-script.js).

export {
  readHostOrigin,
  readHostOrigins,
  startAgent,
  type AgentOptions,
  type PanelAgent,
} from "./agent";
