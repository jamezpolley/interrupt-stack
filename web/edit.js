// PROTOTYPE: editing the text and times shown in the details panel. Pure logic, no DOM.
import { timeOnTop, timeline, formatDuration } from "./times.js";

export const MAX_TEXT = 200;
const ok = (n) => typeof n === "number" && Number.isFinite(n);

/**
 * Which item field each timeline row's time belongs to. Row 1 is the item's own push time, "Paused" is the pushed
 * item's push time, "Back on top" is the ended item's end time, the last row is the item's own end time.
 */
export function rowTargets(x, all) {
  const t = timeline(x, all);
  if (!t) return null;
  return t.rows.map((r) => {
    if (r.kind === "pushed") return { id: x.id, field: "ts" };
    if (r.kind === "paused") return { id: r.whoId, field: "ts" };
    if (r.kind === "back") return { id: r.whoId, field: "at" };
    return { id: x.id, field: "at" }; // popped / dropped
  });
}

/** `draft` = { texts: {id: string}, times: {"id:field": ms} }. Returns copies of the items with the draft applied. */
export function applyDraft(all, draft) {
  return all.map((i) => {
    const text = draft.texts?.[i.id];
    const ts = draft.times?.[`${i.id}:ts`];
    const at = draft.times?.[`${i.id}:at`];
    if (text === undefined && ts === undefined && at === undefined) return i;
    return { ...i, ...(text !== undefined ? { text: text.trim() } : {}), ...(ts !== undefined ? { ts } : {}), ...(at !== undefined ? { at } : {}) };
  });
}

/** Rules, as a list of plain-words problems (empty = can save). */
export function validateDraft(all, draft, now) {
  const problems = [];
  const byId = new Map(all.map((i) => [i.id, i]));
  for (const [id, text] of Object.entries(draft.texts ?? {})) {
    const t = text.trim();
    if (!t) problems.push("Text cannot be empty.");
    else if (t.length > MAX_TEXT) problems.push(`Text is over ${MAX_TEXT} characters.`);
  }
  for (const [key, ms] of Object.entries(draft.times ?? {})) {
    const [id, field] = key.split(":");
    const it = byId.get(id);
    if (!it) continue;
    if (!ok(ms)) problems.push("That time is not valid.");
    else if (!it.removed) problems.push(`"${it.text}" is still on the stack, so its times cannot be changed.`);
    else if (ms > now) problems.push("A time cannot be in the future.");
    else if (ms < 0) problems.push("That time is not valid.");
  }
  const after = applyDraft(all, draft);
  for (const it of after) {
    const was = byId.get(it.id);
    if (it !== was && it.removed && it.at < it.ts) problems.push(`"${it.text}" would end before it started.`);
  }
  return [...new Set(problems)];
}

/** Other finished items whose time on top changes because of the draft: [{text, from, to}] (ms). */
export function sideEffects(all, draft, exceptId) {
  const after = applyDraft(all, draft);
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    if (!a.removed || a.id === exceptId) continue;
    const from = timeOnTop(a, all);
    const to = timeOnTop(after[i], after);
    if (from !== to) out.push({ text: after[i].text, from, to });
  }
  return out;
}

export const sideEffectText = (e) => `${e.text}: on top ${formatDuration(e.from) || "?"} to ${formatDuration(e.to) || "?"}`;

/** What to send: one change per item with only the fields that really differ (text, ts, at). */
export function changesFrom(all, draft) {
  const out = [];
  for (const after of applyDraft(all, draft)) {
    const was = all.find((i) => i.id === after.id);
    if (after === was) continue;
    const c = { id: after.id };
    for (const f of ["text", "ts", "at"]) if (after[f] !== was[f]) c[f] = after[f];
    if (Object.keys(c).length > 1) out.push(c);
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
/** "HH:MM:SS" (24 hour) from ms. */
export const clockText = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
/** "YYYY-MM-DD" in local time, for a date input. */
export const dateText = (ms) => `${new Date(ms).getFullYear()}-${pad(new Date(ms).getMonth() + 1)}-${pad(new Date(ms).getDate())}`;

/** "YYYY-MM-DD" moved by `n` calendar days (local time, so month, year and DST edges just work). Null for a bad date. */
export function shiftDate(date, n) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!d) return null;
  const out = new Date(+d[1], +d[2] - 1, +d[3] + n);
  return Number.isFinite(out.getTime()) ? dateText(out.getTime()) : null;
}

/** The row's time after a day button: the typed clock on the day `step` from `currentMs`'s day. Null for a bad clock. */
export const shiftRowTime = (original, clock, currentMs, step) => parseEdited(original, clock, shiftDate(dateText(currentMs), step));

/** Whether "+1 day" is allowed: only while the row's day is before today (no future dates). */
export const canShiftLater = (ms, now) => dateText(ms) < dateText(now);

/**
 * A new time from what was typed: "HH:MM" or "HH:MM:SS" (24 hour), on `date` (default: the original's day).
 * Seconds are optional: left out, the original seconds (and milliseconds) are kept, even when the minute changes.
 * Typed seconds replace them (milliseconds are kept only when the typed seconds equal the original's, so confirming a
 * value unchanged changes nothing). Returns null for anything else.
 */
export function parseEdited(original, clock, date = dateText(original)) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(clock).trim());
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || !d) return null;
  const o = new Date(original);
  const typed = m[3] !== undefined;
  const sec = typed ? +m[3] : o.getSeconds();
  const msPart = !typed || sec === o.getSeconds() ? o.getMilliseconds() : 0;
  const out = new Date(+d[1], +d[2] - 1, +d[3], +m[1], +m[2], sec, msPart).getTime();
  return Number.isFinite(out) ? out : null;
}
