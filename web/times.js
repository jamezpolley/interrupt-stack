// Time helpers for the lists: how long an item was on top, and absolute times. Pure, so they run under `bun test`.

const MIN = 60000;
const ok = (n) => typeof n === "number" && Number.isFinite(n);

/**
 * How long a removed item was the one being worked on: its span [ts, at] minus the time anything was above it.
 * Anything pushed while it was live (strictly after it, before it ended) sat above it from its own push until it ended,
 * was removed, or the item itself ended, whichever came first. Overlapping intervals are counted once.
 * An item above that is removed but has no end time is assumed to have lasted until the lower item ended.
 * Returns milliseconds, or null when there is no real answer (no end time, junk values, ended before it began).
 */
export function timeOnTop(x, items) {
  if (!x || !x.removed || !ok(x.ts) || !ok(x.at) || x.at < x.ts) return null;
  const spans = [];
  for (const y of items) {
    if (y === x || y.id === x.id || !ok(y.ts) || !(y.ts > x.ts && y.ts < x.at)) continue;
    const end = y.removed && ok(y.at) ? Math.min(y.at, x.at) : x.at;
    if (end > y.ts) spans.push([y.ts, end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let curStart = null;
  let curEnd = null;
  for (const [s, e] of spans) {
    if (curEnd === null || s > curEnd) {
      if (curEnd !== null) covered += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) curEnd = e;
  }
  if (curEnd !== null) covered += curEnd - curStart;
  return Math.max(0, x.at - x.ts - covered);
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
