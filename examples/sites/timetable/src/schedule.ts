// The timetable's data: a JSON file (public/schedule.json, or another one named
// by ?schedule=), checked here and turned into times on today's date. The page
// is static: to show another event, change the file, not the page.
//
// With "anchor": "now", the day is moved so that the clock is in its middle:
// a demo opened at any hour shows sessions that have ended, are on and are
// still to come. Without it, the times are today's as written.

export interface Stage {
  id: string;
  name: string;
  color: string;
}

export interface Session {
  /** Its index in the file: a stable key. */
  id: number;
  stage: Stage;
  /** ms since the epoch. */
  start: number;
  end: number;
  title: string;
  speaker: string;
  tags: string[];
  description: string;
}

export interface Schedule {
  title: string;
  subtitle: string;
  stages: Stage[];
  sessions: Session[];
  /** The day's first start and last end (ms), for the timeline. */
  dayStart: number;
  dayEnd: number;
}

const MINUTE = 60_000;

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/** "13:05" as minutes after midnight, or null. */
function minutesOf(value: unknown): number | null {
  const match = typeof value === "string" ? /^(\d{1,2}):(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

const COLOR = /^#[0-9a-f]{3,8}$/i;

export function parseSchedule(data: unknown, now: number): Schedule {
  const record = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const stages: Stage[] = (Array.isArray(record.stages) ? record.stages : []).flatMap(
    (raw: Record<string, unknown>) => {
      const id = text(raw?.id);
      if (!id) return [];
      const color = text(raw.color);
      return [{ id, name: text(raw.name, id), color: COLOR.test(color) ? color : "#8a93a6" }];
    },
  );
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));

  const rows = (Array.isArray(record.sessions) ? record.sessions : []).flatMap(
    (raw: Record<string, unknown>, id: number) => {
      const stage = stageById.get(text(raw?.stage));
      const start = minutesOf(raw?.start);
      const end = minutesOf(raw?.end);
      if (!stage || start === null || end === null || end <= start) return [];
      const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === "string") : [];
      return [{ id, stage, start, end, raw, tags }];
    },
  );
  if (rows.length === 0) throw new Error("The schedule has no session");

  const first = Math.min(...rows.map((row) => row.start));
  const last = Math.max(...rows.map((row) => row.end));
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  let offset = 0;
  if (record.anchor === "now") {
    // The clock, on the half hour before it, at the half hour a quarter to
    // two thirds into the day when the most sessions are on.
    const clock = Math.floor((now - midnight.getTime()) / MINUTE / 30) * 30;
    const onAt = (minutes: number) =>
      rows.filter((row) => row.start <= minutes && minutes < row.end).length;
    let best = first;
    for (let slot = first; slot <= last; slot += 30) {
      const into = (slot - first) / (last - first);
      if (into >= 0.25 && into <= 0.66 && onAt(slot + 15) > onAt(best + 15)) best = slot;
    }
    offset = clock - best;
  }
  const at = (minutes: number) => midnight.getTime() + (minutes + offset) * MINUTE;

  return {
    title: text(record.title, "Timetable"),
    subtitle: text(record.subtitle),
    stages: stages.filter((stage) => rows.some((row) => row.stage === stage)),
    sessions: rows
      .map(({ id, stage, start, end, raw, tags }) => ({
        id,
        stage,
        start: at(start),
        end: at(end),
        title: text(raw.title, "(無題)"),
        speaker: text(raw.speaker),
        tags,
        description: text(raw.description),
      }))
      .sort((a, b) => a.start - b.start),
    dayStart: at(first),
    dayEnd: at(last),
  };
}

/** Fetches and checks the schedule: ./schedule.json, or the URL in ?schedule=. */
export async function loadSchedule(now: number): Promise<Schedule> {
  const param = new URLSearchParams(location.search).get("schedule");
  const url = new URL(param ?? "./schedule.json", location.href);
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("The schedule must be an http(s) URL");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The schedule could not be read (${response.status})`);
  return parseSchedule(await response.json(), now);
}
