import { displayText } from "./links.js";

// Time helpers for the lists: how long an item was on top, and absolute times. Pure, so they run under `bun test`.

const MIN = 60000;
const ok = (n) => typeof n === "number" && Number.isFinite(n);

/**
 * The one derivation behind both the Done today duration and the details timeline.
 *
 * At any moment the item on top is the live item with the greatest push time. For a removed item X, anything pushed
 * while X was live (strictly after X, strictly before X ended) sat above X from its own push until it ended, was
 * removed, or X itself ended, whichever came first. Those spans are merged (overlaps and touching spans count once)
 * into "covers"; X was on top for everything in [ts, at] outside the covers.
 * An item above that is removed but has no end time is assumed to have lasted until X ended.
 * Returns null when there is no real answer (not removed, no end time, junk values, ended before it began).
 */
function derive(x, items) {
  if (!x || !x.removed || !ok(x.ts) || !ok(x.at) || x.at < x.ts) return null;
  const above = [];
  for (const y of items) {
    if (y === x || y.id === x.id || !ok(y.ts) || !(y.ts > x.ts && y.ts < x.at)) continue;
    const rawEnd = y.removed && ok(y.at) ? y.at : Infinity;
    const end = Math.min(rawEnd, x.at);
    if (end > y.ts) above.push({ y, start: y.ts, end, rawEnd });
  }
  above.sort((p, q) => p.start - q.start || (p.y.id < q.y.id ? -1 : 1));
  const covers = [];
  for (const a of above) {
    const last = covers.at(-1);
    if (last && a.start <= last.end) {
      last.members.push(a);
      if (a.end > last.end) last.end = a.end;
    } else covers.push({ start: a.start, end: a.end, members: [a] });
  }
  return { covers };
}

const coveredLength = (covers) => covers.reduce((n, c) => n + (c.end - c.start), 0);

/**
 * How long a removed item was the one being worked on, in milliseconds, or null when there is no real answer.
 */
export function timeOnTop(x, items) {
  const d = derive(x, items);
  return d ? Math.max(0, x.at - x.ts - coveredLength(d.covers)) : null;
}

/**
 * Every push and pop that mattered to a removed item, as rows with running totals:
 *   pushed (when it was pushed), paused (something was pushed above it), back (everything above it had ended; names
 *   the item whose end returned it to the top), then popped (it was on top when it ended) or dropped (it ended from
 *   underneath something still on top). `who` is the other item's text, `whoId` its id. onTop and wall are the running
 *   totals in ms at that moment. Returns null where timeOnTop does, and its final onTop equals timeOnTop.
 */
export function timeline(x, items) {
  const d = derive(x, items);
  if (!d) return null;
  const total = (t) => {
    let covered = 0;
    for (const c of d.covers) covered += Math.max(0, Math.min(c.end, t) - Math.min(c.start, t));
    return Math.max(0, t - x.ts - covered);
  };
  const row = (t, kind, other) => ({ t, kind, ...(other ? { who: other.text, whoId: other.id } : {}), onTop: total(t), wall: t - x.ts });
  const rows = [row(x.ts, "pushed")];
  let dropped = null;
  for (const c of d.covers) {
    rows.push(row(c.start, "paused", c.members[0].y));
    if (c.end < x.at) {
      // the item that ended last (and was pushed last, if tied) is the one whose end gave the top back
      const last = c.members.filter((m) => m.end === c.end).sort((p, q) => q.y.ts - p.y.ts)[0];
      rows.push(row(c.end, "back", last.y));
    } else {
      const still = c.members.filter((m) => m.rawEnd > x.at).sort((p, q) => q.y.ts - p.y.ts)[0];
      if (still) dropped = still.y;
      else rows.push(row(c.end, "back", c.members.filter((m) => m.end === c.end).sort((p, q) => q.y.ts - p.y.ts)[0].y)); // all ended at the very instant it did
    }
  }
  rows.push(row(x.at, dropped ? "dropped" : "popped", dropped));
  return { start: x.ts, end: x.at, onTop: total(x.at), wall: x.at - x.ts, rows };
}

/** "<1 min", "12 min", "1 h 5 min", "2 h", "1 d 2 h". Empty for anything that is not a duration. */
export function formatDuration(ms) {
  if (!ok(ms) || ms < 0) return "";
  const m = Math.round(ms / MIN);
  if (ms < MIN) return "<1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return rest ? `${h} h ${rest} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}

/**
 * A clock time as 24-hour HH:MM with a two-digit hour, whatever the device's locale. Built from the local hours and
 * minutes directly (not Intl), so no locale can give 12-hour text, other digits, or "24:05" at midnight.
 * The `locale` argument is kept so callers need not change; it no longer affects the clock.
 */
export const formatClock = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** When something was pushed: the time today, "Wed 4:50 PM" within the last week, "12 Nov, 4:50 PM" before that. */
export function formatStart(ts, nowMs, locale) {
  if (!ok(ts)) return "—";
  const days = Math.round((startOfDay(nowMs) - startOfDay(ts)) / 86400000);
  const time = formatClock(ts, locale);
  if (days <= 0) return time; // today (or a clock running ahead)
  if (days < 7) return `${new Date(ts).toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  return `${new Date(ts).toLocaleDateString(locale, { day: "numeric", month: "short" })}, ${time}`;
}

const DASH = "—";

/**
 * The right-hand columns of a Done today row: when it started, when it ended, how long it was on top. An item with no end time (stored before end times existed) has
 * neither: its push time is not an end time, so both show a dash. `all` is every item, removed ones included.
 */
export function doneRow(item, all, locale, nowMs = Date.now()) {
  const start = formatStart(item.ts, nowMs, locale); // the time today, date-aware for an earlier day
  if (!ok(item.at)) return { start, end: DASH, duration: DASH };
  const d = formatDuration(timeOnTop(item, all));
  return { start, end: formatClock(item.at), duration: d || DASH };
}

export const totalText = (ms) => (ms === 0 ? "0 min" : formatDuration(ms));
const WHAT = {
  pushed: () => "Pushed",
  paused: (r) => `Paused: ${displayText(r.who)} pushed`,
  back: (r) => `Back on top: ${displayText(r.who)} ended`,
  popped: () => "Popped",
  dropped: (r) => (r.who ? `Dropped: ${displayText(r.who)} still on top` : "Dropped"),
};

/** The "What happened" text of a timeline row (links shown as their labels). */
export const describeRow = (r) => WHAT[r.kind](r);

/**
 * Whether this item's numbers rest on an edit: it was edited itself, or an item in its timeline (one pushed above it)
 * was, since that moves its totals too. `edited_at` is set by the server (or locally, at once) when an edit changes something.
 */
export function wasEdited(item, all) {
  if (item?.edited_at != null) return true;
  const t = timeline(item, all);
  if (!t) return false;
  const byId = new Map(all.map((i) => [i.id, i]));
  return t.rows.some((r) => r.whoId && byId.get(r.whoId)?.edited_at != null);
}

/**
 * The details panel for a Done today item: the title (its text), a summary line, and the timeline as display strings.
 * Null when there is nothing real to show (no end time). The last row's On top is the Done today row's duration,
 * because both come from the same derivation.
 */
export function detailsFor(item, all, nowMs, locale) {
  const t = timeline(item, all);
  if (!t) return null;
  return {
    title: item.text,
    summary: `Started ${formatStart(t.start, nowMs, locale)} · Ended ${formatClock(t.end)}`,
    rows: t.rows.map((r) => ({ time: formatStart(r.t, nowMs, locale), what: describeRow(r), onTop: totalText(r.onTop), wall: totalText(r.wall) })),
  };
}
