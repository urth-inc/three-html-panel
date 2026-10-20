import type { IncomingMessage, ServerResponse } from "node:http";
import { articlesResponse, MAX_AGE } from "./server/articles.ts";
import { siteConfig } from "../vite.site.ts";

// In development (and `vp preview`), /api/articles is answered here, as the
// Pages Function (functions/api/articles.ts) answers it when deployed. Each
// topic's answer is kept for MAX_AGE, so that reloading does not ask Zenn again.
const kept = new Map<string, { at: number; status: number; body: string }>();

// Typed without importing Vite's types: the sites use Vite through their own
// dependency, and the repository's check would meet two copies of them.
type Middleware = (
  request: IncomingMessage & { originalUrl?: string },
  response: ServerResponse,
) => void;
interface Server {
  middlewares: { use(path: string, handle: Middleware): void };
}

const answer: Middleware = async (request, response) => {
  const url = new URL(request.originalUrl ?? request.url ?? "/", "http://localhost");
  const key = url.searchParams.get("topic") ?? "";
  let entry = kept.get(key);
  if (!entry || Date.now() - entry.at > MAX_AGE * 1000) {
    const fresh = await articlesResponse(url);
    entry = { at: Date.now(), status: fresh.status, body: await fresh.text() };
    if (fresh.ok) kept.set(key, entry);
  }
  response.statusCode = entry.status;
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(entry.body);
};

const articlesApi = {
  name: "zenn-articles",
  // Returning nothing: a function returned here would be run as a hook after Vite's own.
  configureServer(server: Server) {
    server.middlewares.use("/api/articles", answer);
  },
  configurePreviewServer(server: Server) {
    server.middlewares.use("/api/articles", answer);
  },
};

export default siteConfig({ name: "zenn", dir: import.meta.dirname, plugins: [articlesApi] });
