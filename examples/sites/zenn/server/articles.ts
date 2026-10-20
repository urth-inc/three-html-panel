// Reads Zenn's articles and keeps only what the page shows.
//
// Zenn's API (zenn.dev/api/articles) is not documented, and it sends no CORS
// headers: the page, shown sandboxed on the origin "null", cannot read it
// itself. A Pages Function (functions/api/articles.ts) reads it for the page,
// and so does the dev server (vite.config.ts), both through here.
//
// Only the topics below are read: the function is not an open proxy to Zenn.

/** The page's tabs: a Zenn topic, or "" for all of Zenn. */
export const TOPICS = ["", "threejs", "webxr", "webgl", "vr", "metaverse"] as const;
export type Topic = (typeof TOPICS)[number];

export const isTopic = (value: unknown): value is Topic => TOPICS.includes(value as Topic);

export interface Article {
  title: string;
  emoji: string;
  url: string;
  /** The author, or the publication it is in. */
  author: string;
  likes: number;
}

export interface Articles {
  topic: Topic;
  articles: Article[];
}

/** How many articles a tab shows. */
const COUNT = 30;
/** How long a tab's articles are reused before Zenn is asked again (s). */
export const MAX_AGE = 600;

const text = (value: unknown) => (typeof value === "string" ? value : "");

function toArticle(raw: Record<string, unknown>): Article[] {
  const path = text(raw.path);
  const title = text(raw.title);
  if (!path.startsWith("/") || !title) return [];
  const user = (raw.user ?? {}) as Record<string, unknown>;
  const publication = (raw.publication ?? null) as Record<string, unknown> | null;
  return [
    {
      title,
      emoji: text(raw.emoji) || "📝",
      url: new URL(path, "https://zenn.dev").href,
      author: text(publication?.display_name) || text(user.name) || text(user.username),
      likes: typeof raw.liked_count === "number" ? raw.liked_count : 0,
    },
  ];
}

/** A topic's trending articles, from Zenn. */
export async function fetchArticles(topic: Topic): Promise<Articles> {
  const url = new URL("https://zenn.dev/api/articles");
  url.searchParams.set("order", "daily");
  url.searchParams.set("count", String(COUNT));
  if (topic) url.searchParams.set("topicname", topic);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Zenn answered ${response.status}`);
  const data = (await response.json()) as { articles?: unknown };
  const list = Array.isArray(data.articles) ? data.articles : [];
  return { topic, articles: list.flatMap(toArticle) };
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
