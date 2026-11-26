// Views over the reducer's state (reduce.js) in the shape the screens read: plain rows with ts, at and removed.
//
// An item can have several stays on the stack (push, pop, push again, pop ...), and the times, Done today and the details
// all think in "a push and a pop". So each STAY is one row: the first keeps the item's id, later ones are `<id>~<k>`.
// A row has `itemId` (what an action targets), `k` (which stay), and the ids of the actions that start and end the stay,
// which is what a time correction points at.

export const rowId = (itemId, k) => (k === 0 ? itemId : `${itemId}~${k}`);
export function parseRowId(id) {
  const i = id.indexOf("~");
  return i < 0 ? { itemId: id, k: 0 } : { itemId: id.slice(0, i), k: Number(id.slice(i + 1)) };
}

// When the person last corrected this item: an edit of its text, or of a time of one of the stay's actions.
function editedTs(acts, ids) {
  let t = null;
  for (const a of acts) if (a.kind === "edit" && (a.ref ? ids.has(a.ref) : typeof a.data?.text === "string")) t = a.ts;
  return t;
}

/** One row per stay of every item. */
export function itemRows(state) {
  const out = [];
  for (const it of Object.values(state.items)) {
    const acts = state.log[it.id] ?? [];
    it.intervals.forEach((iv, k) => {
      const ended = !!iv.end;
      const edited = editedTs(acts, new Set([iv.start.action, iv.end?.action]));
      out.push({
        id: rowId(it.id, k),
        itemId: it.id,
        k,
        stays: it.intervals.length,
        text: it.text,
        ts: iv.start.at,
        at: ended ? iv.end.at : iv.start.at,
        removed: ended,
        seq: 0,
        startAction: iv.start.action,
        ...(ended ? { endAction: iv.end.action } : {}),
        ...(it.origin && k === 0 ? { origin: it.origin } : {}),
        ...(edited !== null ? { edited_at: edited } : {}),
        ...(it.deleted ? { deleted: true } : {}),
        ...(!ended && it.dropped ? { dropped: true, dropAction: it.dropAction } : {}),
      });
    });
  }
  return out;
}

/** The Later queue's rows. */
export function queueRows(state) {
  return Object.values(state.queue).map((q) => ({ id: q.id, text: q.text, ts: q.at, at: q.at, removed: q.removed, started: q.started, seq: 0 }));
}

/** The notes' rows. */
export function noteRows(state) {
  return Object.values(state.notes).map((n) => {
    const acts = state.log[n.id] ?? [];
    const edited = editedTs(acts, new Set([n.action]));
    return { id: n.id, text: n.text, ts: n.at, removed: n.removed, seq: 0, action: n.action, ...(edited !== null ? { edited_at: edited } : {}) };
  });
}
