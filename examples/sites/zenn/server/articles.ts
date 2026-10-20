// Reads Zenn's RSS feeds and keeps only what the page shows.
//
// The feeds (zenn.dev/feed, the trending articles, and
// zenn.dev/topics/<topic>/feed, a topic's newest) send no CORS headers: the
// page, shown sandboxed on the origin "null", cannot read them itself. A Pages
// Function (functions/api/articles.ts) reads them for the page, and so does
// the dev server (vite.config.ts), both through here.
//
// Only the topics below are read: the function is not an open proxy to Zenn.

/** The page's tabs: a Zenn topic, or "" for Zenn's trending articles. */
export const TOPICS = ["", "threejs", "webxr", "webgl", "svg", "vr", "metaverse"] as const;
export type Topic = (typeof TOPICS)[number];

export const isTopic = (value: unknown): value is Topic => TOPICS.includes(value as Topic);

export interface Article {
  title: string;
  url: string;
  /** Who wrote it (the feed's dc:creator). */
  author: string;
}

export interface Articles {
  topic: Topic;
  articles: Article[];
}

/** How long a tab's articles are reused before Zenn is asked again (s). */
export const MAX_AGE = 600;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** An element's text in an RSS item: its CDATA as it is, or its text with the entities read. */
function field(item: string, name: string): string {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item);
  if (!match) return "";
  const value = match[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(value);
  if (cdata) return cdata[1]!.trim();
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, name: string) => {
    if (name[0] === "#")
      return String.fromCodePoint(
        name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1)),
      );
    return ENTITIES[name] ?? entity;
  });
}

/**
 * The articles of an RSS feed. There is no DOMParser in Workers, and Zenn's
 * feeds are regular (one <item> per article, the fields CDATA or plain text):
 * the items are read with expressions.
 */
export function parseFeed(xml: string): Article[] {
  return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/g), (match) => match[1]!).flatMap(
    (item) => {
      const title = field(item, "title");
      const url = field(item, "link");
      if (!title || !url.startsWith("https://zenn.dev/")) return [];
      return [{ title, url, author: field(item, "dc:creator") }];
    },
  );
}

/** A topic's newest articles, or Zenn's trending ones, from its feed. */
export async function fetchArticles(topic: Topic): Promise<Articles> {
  const url = topic ? `https://zenn.dev/topics/${topic}/feed` : "https://zenn.dev/feed";
  const response = await fetch(url, { headers: { accept: "application/rss+xml" } });
  if (!response.ok) throw new Error(`Zenn answered ${response.status}`);
  return { topic, articles: parseFeed(await response.text()) };
}

/** The response to `GET /api/articles?topic=…`, readable from any origin. */
export async function articlesResponse(url: URL): Promise<Response> {
  const headers = {
    "access-control-allow-origin": "*",
    "content-type": "application/json; charset=utf-8",
  };
  const topic = url.searchParams.get("topic") ?? "";
  if (!isTopic(topic))
    return new Response(JSON.stringify({ error: "unknown topic" }), { status: 400, headers });
  try {
    return new Response(JSON.stringify(await fetchArticles(topic)), {
      headers: { ...headers, "cache-control": `public, max-age=${MAX_AGE}` },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: message }), { status: 502, headers });
  }
}
