// GET /api/articles?topic=… on Cloudflare Pages: a topic's trending articles
// on Zenn, which the page cannot read itself (see server/articles.ts). Kept in
// the edge cache for MAX_AGE, so Zenn is asked at most that often per topic.

import { articlesResponse } from "../../server/articles";

interface Context {
  request: Request;
  waitUntil(promise: Promise<unknown>): void;
}

// The cache of the data centre the request reached (Workers' caches.default).
const edgeCache = () => (caches as unknown as { default: Cache }).default;

export async function onRequestGet(context: Context): Promise<Response> {
  const url = new URL(context.request.url);
  // Only the topic varies the answer: other parameters do not make other entries.
  const key = new Request(
    `${url.origin}${url.pathname}?topic=${encodeURIComponent(url.searchParams.get("topic") ?? "")}`,
  );
  const cached = await edgeCache().match(key);
  if (cached) return cached;
  const response = await articlesResponse(url);
  // A successful answer says `max-age=MAX_AGE`, which the cache keeps it for.
  if (response.ok) context.waitUntil(edgeCache().put(key, response.clone()));
  return response;
}
