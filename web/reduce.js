// The reducer: turns a log of actions into the current state. Pure and shared (the server imports this file, and the
// client will). An action is { id, n, ts, at, kind, target, ref?, data?, origin? }:
//   ts = the server's clock when it was received (never changes), at = the person's time (never changes),
//   target = the item (s-...), note (n-...) or Later row (q-...) it acts on, ref = an earlier action (edit, void).
// Apply actions in n order. Applying the same action id twice does nothing.
//
// Kinds: push, push-again, pop, drop, edit, void, delete, undelete (items); note, edit, delete, undelete (notes);
// later, dequeue, requeue, start (the Later queue). Unknown kinds are ignored, so new kinds need no change here.

export function emptyState() {
  return { log: {}, seen: {}, items: {}, notes: {}, queue: {} };
}

const kindOf = (target) => (target.startsWith("n-") ? "notes" : target.startsWith("q-") ? "queue" : "items");

/** Apply one action to the state (mutates and returns it). */
export function apply(state, action) {
  if (state.seen[action.id]) return state;
  state.seen[action.id] = true;
  (state.log[action.target] ??= []).push(action);
  const table = kindOf(action.target);
  const row = project[table](action.target, state.log[action.target]);
  if (row) state[table][action.target] = row;
  else delete state[table][action.target];
  return state;
}

/** The state after applying every action, in the order given. */
export function reduce(actions) {
  const state = emptyState();
  for (const a of actions) apply(state, a);
  return state;
}

// What is left of a target's actions once voids and edits are taken into account.
function prepare(acts) {
  const voided = new Set();
  for (const a of acts) if (a.kind === "void" && a.ref) voided.add(a.ref);
  const live = acts.filter((a) => a.kind !== "void" && !voided.has(a.id));
  const editedAt = {}; // action id -> the latest edited time
  for (const a of live) if (a.kind === "edit" && a.ref && Number.isFinite(a.data?.at)) editedAt[a.ref] = a.data.at;
  return { live, eff: (a) => editedAt[a.id] ?? a.at };
}

const project = {
  items(id, acts) {
    const { live, eff } = prepare(acts);
    let item = null;
    for (const a of live) {
      if (a.kind === "push") {
        if (!item) item = { id, text: a.data?.text ?? "", deleted: false, dropped: false, ...(a.data?.origin ? { origin: a.data.origin } : {}), raw: [{ start: a, end: null }] };
      } else if (!item) continue;
      else if (a.kind === "push-again") {
        if (item.raw[item.raw.length - 1].end) item.raw.push({ start: a, end: null });
      } else if (a.kind === "pop") {
        const iv = item.raw[item.raw.length - 1];
        if (!iv.end) iv.end = a;
      } else if (a.kind === "drop") item.dropped = true;
      else if (a.kind === "edit" && !a.ref && typeof a.data?.text === "string") item.text = a.data.text;
      else if (a.kind === "delete") item.deleted = true;
      else if (a.kind === "undelete") item.deleted = false;
    }
    if (!item) return null;
    // An end the person reported before the start (a device clock a little behind) reads as a zero-length stay.
    const intervals = item.raw.map((iv) => {
      const start = { action: iv.start.id, at: eff(iv.start), ts: iv.start.ts };
      const end = iv.end ? { action: iv.end.id, at: Math.max(eff(iv.end), start.at), ts: iv.end.ts, kind: iv.end.kind } : null;
      return { start, end };
    });
    const { raw, ...rest } = item;
    return { ...rest, live: intervals[intervals.length - 1].end === null, intervals };
  },

  notes(id, acts) {
    const { live, eff } = prepare(acts);
    let note = null;
    for (const a of live) {
      if (a.kind === "note") {
        if (!note) note = { id, text: a.data?.text ?? "", at: eff(a), ts: a.ts, removed: false, _a: a };
      } else if (!note) continue;
      else if (a.kind === "edit" && !a.ref && typeof a.data?.text === "string") note.text = a.data.text;
      else if (a.kind === "delete") note.removed = true;
      else if (a.kind === "undelete") note.removed = false;
    }
    if (!note) return null;
    const { _a, ...rest } = note;
    return { ...rest, at: eff(_a) };
  },

  queue(id, acts) {
    const { live, eff } = prepare(acts);
    let row = null;
    for (const a of live) {
      if (a.kind === "later") {
        if (!row) row = { id, text: a.data?.text ?? "", at: eff(a), ts: a.ts, removed: false, started: false };
      } else if (!row) continue;
      else if (a.kind === "dequeue") ((row.removed = true), (row.started = false));
      else if (a.kind === "start") ((row.removed = true), (row.started = true));
      else if (a.kind === "requeue") ((row.removed = false), (row.started = false));
      else if (a.kind === "edit" && !a.ref && typeof a.data?.text === "string") row.text = a.data.text;
    }
    return row;
  },
};
