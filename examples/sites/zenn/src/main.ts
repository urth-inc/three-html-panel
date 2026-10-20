import "./agent";
import "./style.css";
import type { Article, Articles, Topic } from "../server/articles";
import { tween } from "./tween";

// Zenn's trending articles, and a tab per topic with its newest, from Zenn's
// RSS feeds, read through /api/articles (a Pages Function: the feeds send no
// CORS headers, see server/articles.ts).
//
// Made to be cheap to show in a panel, where every change is a copy of the
// whole page: no framework, system fonts, no images. An article is one link:
// its author is a pseudo-element showing an attribute (attr()), and it has no
// style of its own. The list is virtual:
// only the rows shown are in the page, in the flow, after a padding as tall as
// the rows above them. Things move only by script (see tween.ts), when a tab
// is chosen.

const ROW_HEIGHT = 68;
/** How often the shown tab is read again (ms); the function keeps it as long. */
const REFRESH = 10 * 60_000;

const TABS: { topic: Topic; name: string }[] = [
  { topic: "", name: "トレンド" },
  { topic: "threejs", name: "three.js" },
  { topic: "webxr", name: "WebXR" },
  { topic: "webgl", name: "WebGL" },
  { topic: "svg", name: "SVG" },
  { topic: "vr", name: "VR" },
  { topic: "metaverse", name: "メタバース" },
];

// The whitespace between the page's tags is copied on every frame too.
const blanks = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
for (let node = blanks.nextNode(); node;) {
  const next = blanks.nextNode();
  if (!node.textContent?.trim()) node.parentNode?.removeChild(node);
  node = next;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = byId("list");
const rows = byId("rows");

let topic: Topic = "";
let articles: Article[] = [];
/** The rows made so far, by index: those out of view are kept out of the page. */
let made = new Map<number, HTMLAnchorElement>();
/** The rows in the page: from `shown.first` to `shown.last`. */
let shown = { first: 0, last: -1 };
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function row(index: number): HTMLAnchorElement {
  let element = made.get(index);
  if (element) return element;
  const article = articles[index]!;
  element = document.createElement("a");
  element.href = article.url;
  element.textContent = article.title;
  element.dataset.author = article.author.trim();
  made.set(index, element);
  return element;
}

/** Puts in the page the rows shown (a row partly shown included), and only those. */
function place(): void {
  const first = Math.floor(list.scrollTop / ROW_HEIGHT);
  const last = Math.min(
    articles.length - 1,
    Math.ceil((list.scrollTop + list.clientHeight) / ROW_HEIGHT) - 1,
  );
  if (first === shown.first && last === shown.last) return;
  shown = { first, last };
  const elements = [];
  for (let index = first; index <= last; index++) elements.push(row(index));
  rows.style.paddingTop = `${first * ROW_HEIGHT}px`;
  rows.replaceChildren(...elements);
}

/** Shows a line in place of the articles (there are none, or they could not be read). */
function say(text: string): void {
  const line = document.createElement("p");
  line.className = "message";
  line.textContent = text;
  rows.replaceChildren(line);
}

/** Shows a tab's articles: the rows shown slide in one after the other. */
function show(data: Articles): void {
  articles = data.articles;
  made = new Map();
  shown = { first: 0, last: -1 };
  rows.style.height = `${articles.length * ROW_HEIGHT}px`;
  list.scrollTop = 0;
  place();
  if (articles.length === 0) say("記事がありません");
  Array.from(rows.children as HTMLCollectionOf<HTMLElement>).forEach((element, index) => {
    element.style.opacity = "0";
    setTimeout(
      () =>
        tween(
          element,
          0,
          1,
          320,
          (v) => {
            element.style.opacity = v.toFixed(2);
            element.style.translate = `${((1 - v) * 24).toFixed(1)}px 0`;
          },
          () => element.removeAttribute("style"),
        ),
      index * 45,
    );
  });
}

async function load(next: Topic): Promise<void> {
  topic = next;
  clearTimeout(refreshTimer);
  // The tabs are in the order of TABS.
  Array.from(byId("tabs").children).forEach((tab, index) =>
    tab.toggleAttribute("data-on", TABS[index]!.topic === next),
  );
  try {
    const response = await fetch(`./api/articles?topic=${encodeURIComponent(next)}`);
    const data = (await response.json()) as Articles & { error?: string };
    if (!response.ok) throw new Error(data.error ?? String(response.status));
    // Another tab was chosen meanwhile.
    if (topic === next) show(data);
  } catch (error) {
    if (topic === next) {
      show({ topic: next, articles: [] });
      say(`読み込めませんでした（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
  refreshTimer = setTimeout(() => void load(topic), REFRESH);
}

const tabs = byId("tabs");
for (const { topic: value, name } of TABS) {
  const tab = document.createElement("button");
  tab.textContent = name;
  tab.addEventListener("click", () => void load(value));
  tabs.append(tab);
}
list.addEventListener("scroll", place, { passive: true });
// The panel's agent scrolls the list itself (scrollBy for the wheel, a drag or
// the scrollbar's track, scrollTo for its thumb) and copies the page right
// after, before the browser fires `scroll`: in a panel's iframe, whose
// rendering the browser holds back, that can come long after. Placing the rows
// in those calls too keeps the copy from showing the list without them. (The
// agent of 0.3.0 does so; one that fires `scroll` as it scrolls needs none of this.)
for (const name of ["scrollBy", "scrollTo"] as const) {
  const scroll = list[name] as (this: Element, ...args: unknown[]) => void;
  Object.defineProperty(list, name, {
    configurable: true,
    value(this: Element, ...args: unknown[]) {
      scroll.apply(this, args);
      place();
    },
  });
}
void load("");
