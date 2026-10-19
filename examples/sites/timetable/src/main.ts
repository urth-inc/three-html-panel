import "./agent";
import "./style.css";
import { loadSchedule, type Schedule, type Session } from "./schedule";
import { tween } from "./tween";

// An event's timetable that follows the clock: a line marks now, sessions
// light up while they are on and fill as they go, and the side lists what is
// on and what comes next. Fast-forward runs the day in minutes.
//
// Made to be cheap to show in a panel, where every change is a copy of the
// whole page: no framework, system fonts, no images, and as few elements as
// can be. A session or a card is one element: its other lines are pseudo-
// elements showing its attributes (attr()), and its progress is a background.
// Sessions out of view are taken out of the page, and the details are in it
// only while open. It changes once a second at normal speed, and moves only
// by script (see tween.ts).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PX_PER_HOUR = 220;
/** Room before the first session and after the last (px). */
const PAD = 40;
/** The stages' names, which stay at the left of the timeline (px, as in style.css). */
const LABEL_WIDTH = 116;
/** How long the timeline does not follow the clock after the user scrolled it (ms). */
const FOLLOW_PAUSE = 6000;
/** Elements this far out of the timeline's view are taken out of the page (px). */
const CULL_MARGIN = 160;
const NEXT_COUNT = 3;
const SPEEDS = [1, 60, 600];

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

// Each change is a new frame for the panel: these change only what differs.
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function setAttribute(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setStyle(element: HTMLElement, property: string, value: string | null): void {
  if (value === null) {
    if (!element.style.getPropertyValue(property)) return;
    element.style.removeProperty(property);
    if (!element.style.length) element.removeAttribute("style");
  } else if (element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value);
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (t: number) => {
  const date = new Date(t);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const hms = (t: number) => `${hm(t)}:${pad(new Date(t).getSeconds())}`;

function duration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  if (minutes < 60) return `${minutes} 分`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} 時間 ${rest} 分` : `${minutes / 60} 時間`;
}

type State = "upcoming" | "live" | "ended";
const stateAt = (session: Session, t: number): State =>
  t < session.start ? "upcoming" : t < session.end ? "live" : "ended";

function statusText(session: Session, t: number): string {
  const state = stateAt(session, t);
  if (state === "live") return `開催中 · 残り ${duration(session.end - t)}`;
  if (state === "upcoming") return `あと ${duration(session.start - t)}で開始`;
  return "終了しました";
}

/** How far a session has gone, as a percentage for --p (its background's width). */
const progress = (session: Session, t: number) =>
  `${(Math.min(1, Math.max(0, (t - session.start) / (session.end - session.start))) * 100).toFixed(1)}%`;

/** Something on the timeline that is in the page only while near its view. */
interface Placed {
  element: HTMLElement;
  parent: HTMLElement;
  left: number;
  right: number;
}

interface Block extends Placed {
  session: Session;
  state: State | null;
}

interface Drawer {
  element: HTMLElement;
  heading: HTMLElement;
  meta: HTMLElement;
  status: HTMLElement;
  description: HTMLElement;
}

const title = byId("title");
const clock = byId("clock");
const speedButton = byId<HTMLButtonElement>("speed");
const main = byId("body");
const scroller = byId("scroller");
const track = byId("track");
const nowLine = byId("now-line");
const nowList = byId("now-list");
const nextList = byId("next-list");

let schedule: Schedule;
const blocks: Block[] = [];
const placed: Placed[] = [];
let selected: Block | null = null;
let drawer: Drawer | null = null;
let userScrolledAt = -Infinity;
const shownKeys = { now: "", next: "" };

const xOf = (t: number) => LABEL_WIDTH + PAD + ((t - schedule.dayStart) / HOUR) * PX_PER_HOUR;

// ---- Building the page ----

function build(): void {
  setText(title, schedule.title);
  setText(
    byId("subtitle"),
    [
      schedule.subtitle,
      `${schedule.stages.length} ステージ`,
      `${schedule.sessions.length} セッション`,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  document.title = schedule.title;

  track.style.width = `${Math.round(xOf(schedule.dayEnd)) + PAD}px`;
  // Hour lines and labels, from the first whole hour (the day may start on a half hour).
  const startOfHour = new Date(schedule.dayStart);
  startOfHour.setMinutes(0, 0, 0);
  const hourAt =
    startOfHour.getTime() < schedule.dayStart
      ? startOfHour.getTime() + HOUR
      : startOfHour.getTime();
  track.style.setProperty("--hour", `${PX_PER_HOUR}px`);
  track.style.setProperty("--hour-offset", `${Math.round(xOf(hourAt)) % PX_PER_HOUR}px`);
  const ruler = byId("ruler");
  for (let t = hourAt; t <= schedule.dayEnd; t += HOUR) {
    const left = Math.round(xOf(t));
    const label = el("span", "", hm(t));
    label.style.left = `${left}px`;
    placed.push({ element: label, parent: ruler, left, right: left + 40 });
  }

  for (const stage of schedule.stages) {
    // The stage's colour, once for its row: its sessions inherit it.
    const row = el("div", "row");
    row.style.setProperty("--c", stage.color);
    row.append(el("div", "stage-label", stage.name));
    for (const session of schedule.sessions) {
      if (session.stage !== stage) continue;
      const left = Math.round(xOf(session.start));
      const right = Math.round(xOf(session.end)) - 6;
      const element = el("button", "session", session.title);
      element.type = "button";
      element.dataset.time = `${hm(session.start)}–${hm(session.end)}`;
      element.style.left = `${left}px`;
      element.style.width = `${right - left}px`;
      const block: Block = { session, element, parent: row, left, right, state: null };
      element.addEventListener("click", () => open(block));
      blocks.push(block);
      placed.push(block);
    }
    track.insertBefore(row, nowLine);
  }

  // The user scrolling the timeline: stop following the clock for a while.
  for (const type of ["wheel", "pointerdown", "touchstart"])
    scroller.addEventListener(type, () => (userScrolledAt = Date.now()), { passive: true });
  scroller.addEventListener("scroll", cull, { passive: true });

  speedButton.addEventListener("click", () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!;
    setText(speedButton, `早送り ×${next}`);
    speedButton.toggleAttribute("data-on", next > 1);
    setSpeed(next);
  });
}

// ---- The details, in the page only while open ----

const slide = (element: HTMLElement) => (v: number) =>
  (element.style.transform = `translateX(${(v * 105).toFixed(1)}%)`);

function makeDrawer(): Drawer {
  const element = el("section", "drawer");
  element.setAttribute("aria-label", "セッションの詳細");
  const parts = {
    heading: el("h2"),
    meta: el("p", "drawer-meta"),
    status: el("p", "drawer-status"),
    description: el("p"),
  };
  const close = el("button", "", "閉じる");
  close.type = "button";
  close.addEventListener("click", closeDrawer);
  element.append(parts.heading, parts.meta, parts.status, parts.description, close);
  main.append(element);
  tween(element, 1, 0, 280, slide(element), () => setStyle(element, "transform", null));
  return { element, ...parts };
}

function open(block: Block): void {
  selected?.element.removeAttribute("data-selected");
  selected = block;
  block.element.setAttribute("data-selected", "");
  const { session } = block;

  drawer ??= makeDrawer();
  setText(drawer.heading, session.title);
  setText(
    drawer.meta,
    [session.stage.name, `${hm(session.start)}–${hm(session.end)}`, session.speaker]
      .filter(Boolean)
      .join(" · "),
  );
  setText(drawer.status, statusText(session, virtualNow()));
  setText(drawer.description, session.description);
  drawer.element.style.setProperty("--c", session.stage.color);

  // Bring the session into view, in the middle of what is shown of the timeline.
  userScrolledAt = Date.now();
  const view = scroller.scrollLeft;
  if (block.left < view + LABEL_WIDTH || block.right > view + scroller.clientWidth) {
    const target = Math.max(0, (block.left + block.right - scroller.clientWidth - LABEL_WIDTH) / 2);
    tween(scroller, view, target, 450, (v) => (scroller.scrollLeft = v));
  }
}

function closeDrawer(): void {
  selected?.element.removeAttribute("data-selected");
  selected = null;
  const element = drawer?.element;
  drawer = null;
  if (element) tween(element, 0, 1, 220, slide(element), () => element.remove());
}

// ---- Following the clock ----

function card(session: Session, t: number): HTMLButtonElement {
  const button = el("button", "card", session.title);
  button.type = "button";
  button.style.setProperty("--c", session.stage.color);
  button.dataset.meta = `${session.stage.name} · ${hm(session.start)}`;
  button.dataset.when = statusText(session, t);
  button.addEventListener("click", () => {
    const block = blocks.find((b) => b.session === session);
    if (block) open(block);
  });
  return button;
}

/** Shows `sessions` in `list`: again when they changed (the new ones slide in), else only their times. */
function showCards(
  list: HTMLElement,
  which: "now" | "next",
  sessions: Session[],
  t: number,
  empty: string,
): void {
  const key = sessions.map((session) => session.id).join(",");
  if (key !== shownKeys[which]) {
    const before = new Set(shownKeys[which].split(","));
    shownKeys[which] = key;
    list.replaceChildren();
    if (sessions.length === 0) list.append(el("p", "empty", empty));
    sessions.forEach((session, index) => {
      const item = card(session, t);
      list.append(item);
      if (before.has(String(session.id))) return;
      const style = item.style;
      style.opacity = "0";
      setTimeout(
        () =>
          tween(
            item,
            0,
            1,
            360,
            (v) => {
              style.opacity = v.toFixed(2);
              style.translate = `0 ${((1 - v) * 10).toFixed(1)}px`;
            },
            () => {
              setStyle(item, "opacity", null);
              setStyle(item, "translate", null);
            },
          ),
        index * 70,
      );
    });
  }
  sessions.forEach((session, index) => {
    const item = list.children[index] as HTMLElement | undefined;
    if (!item) return;
    setAttribute(item, "data-when", statusText(session, t));
    if (which === "now") setStyle(item, "--p", progress(session, t));
  });
}

function render(t: number): void {
  setText(clock, hms(t));
  setStyle(nowLine, "transform", `translateX(${xOf(t).toFixed(1)}px)`);
  setAttribute(nowLine, "data-time", hm(t));

  let anyLive = false;
  for (const block of blocks) {
    const state = stateAt(block.session, t);
    if (state !== block.state) {
      block.state = state;
      block.element.dataset.state = state;
    }
    if (state === "live") anyLive = true;
    setStyle(block.element, "--p", state === "live" ? progress(block.session, t) : null);
  }
  // The title's dot blinks with the seconds of the real clock, at any speed.
  title.toggleAttribute("data-on", anyLive && Math.floor(Date.now() / 1000) % 2 === 0);

  showCards(
    nowList,
    "now",
    schedule.sessions.filter((session) => stateAt(session, t) === "live"),
    t,
    "いま開催中のセッションはありません",
  );
  showCards(
    nextList,
    "next",
    schedule.sessions.filter((session) => session.start > t).slice(0, NEXT_COUNT),
    t,
    "このあとの予定はありません",
  );
  if (selected && drawer) setText(drawer.status, statusText(selected.session, t));

  // Keep now about a third of the way into what is shown.
  if (Date.now() - userScrolledAt > FOLLOW_PAUSE) {
    const target = Math.max(
      0,
      Math.round(xOf(t) - LABEL_WIDTH - (scroller.clientWidth - LABEL_WIDTH) * 0.3),
    );
    if (Math.abs(scroller.scrollLeft - target) >= 1) scroller.scrollLeft = target;
  }
  cull();
}

/**
 * Takes what is far out of the timeline's view out of the page, and puts back
 * what comes into it: the panel copies the whole page on each change, shown or not.
 */
function cull(): void {
  const from = scroller.scrollLeft + LABEL_WIDTH - CULL_MARGIN;
  const to = scroller.scrollLeft + scroller.clientWidth + CULL_MARGIN;
  for (const item of placed) {
    const shown = item === selected || (item.right > from && item.left < to);
    if (shown === item.element.isConnected) continue;
    if (shown) item.parent.append(item.element);
    else item.element.remove();
  }
}

// ---- The clock, and fast-forward ----

let speed = 1;
let baseReal = Date.now();
let baseVirtual = baseReal;
let timer: ReturnType<typeof setTimeout> | undefined;
let frame: number | undefined;

const virtualNow = () => baseVirtual + (Date.now() - baseReal) * speed;

function tick(): void {
  timer = frame = undefined;
  let t = virtualNow();
  // Fast-forwarded past the day's end: start the day again.
  if (speed > 1 && t > schedule.dayEnd + 15 * MINUTE) {
    baseVirtual = schedule.dayStart - 15 * MINUTE;
    baseReal = Date.now();
    t = baseVirtual;
  }
  render(t);
  // Once a second at normal speed (on the second), every frame fast-forwarded.
  if (speed === 1) timer = setTimeout(tick, 1000 - (virtualNow() % 1000) + 5);
  else frame = requestAnimationFrame(tick);
}

function setSpeed(value: number): void {
  // Back at normal speed, back to the real time.
  baseVirtual = value === 1 ? Date.now() : virtualNow();
  baseReal = Date.now();
  speed = value;
  clearTimeout(timer);
  if (frame !== undefined) cancelAnimationFrame(frame);
  tick();
}

try {
  schedule = await loadSchedule(Date.now());
  build();
  tick();
} catch (error) {
  setText(title, "スケジュールを読み込めませんでした");
  setText(byId("subtitle"), error instanceof Error ? error.message : String(error));
}
