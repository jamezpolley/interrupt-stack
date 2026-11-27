// The stack: pushing, swapping, popping, dropping, undoing and editing tasks, locally first. Every change is one or more
// actions in the journal (journal.js); the rows the screens read are views over the reducer's state (rows.js). The network
// side (one request, the cursor, the epoch, failures) is the journal's.
import { createJournal } from "./journal.js";
import { itemRows, parseRowId } from "./rows.js";

const MAX_TEXT = 200;
const idFor = (ts) => `s-${ts.toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
const byTop = (a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1);

// `local` is the static version: nothing is ever sent anywhere, so there is no network use.
export function createSync({ storage, fetch, now = () => Date.now(), online = () => true, onChange = () => {}, onStatus = () => {}, local = false }) {
  let settling = false;
  const changed = () => {
    settleDropped();
    onChange();
  };
  const journal = createJournal({ storage, fetch, now, online, onChange: changed, onStatus, local });

  let cache = null;
  const rows = () => {
    const st = journal.state();
    if (cache?.st !== st) cache = { st, rows: itemRows(st) };
    return cache.rows;
  };
  const row = (id) => rows().find((r) => r.id === id) ?? null;
  const itemOf = (id) => journal.state().items[parseRowId(id).itemId] ?? null;
  const currentStack = () => rows().filter((r) => !r.removed && !r.deleted).sort(byTop);

  // A dropped item is only flagged; the moment it reaches the top of the stack it is popped, at that moment. The pop's id
  // comes from the drop's, so two devices that both notice it make the same action.
  async function settleDropped() {
    if (settling) return;
    settling = true;
    try {
      for (let guard = 0; guard < 100; guard++) {
        const top = currentStack()[0];
        if (!top?.dropped) break;
        const id = `auto-${top.dropAction}`;
        if (journal.has(id)) break;
        await journal.append([{ id, kind: "pop", target: top.itemId }]);
      }
    } finally {
      settling = false;
    }
  }

  const lastLive = (acts, kind) => {
    const voided = new Set(acts.filter((a) => a.kind === "void" && a.ref).map((a) => a.ref));
    return [...acts].reverse().find((a) => a.kind === kind && !voided.has(a.id)) ?? null;
  };

  return {
    async start() {
      await journal.start();
      await settleDropped();
      onChange();
    },

    /** The stack, newest push first. A dropped item is still here, flagged, until it reaches the top. */
    stack: currentStack,

    /** Every stay of every item, finished or not, for views of what has been done. Deleted items are left out: they never happened. */
    allItems: () => rows().filter((r) => !r.deleted),

    /** Whether an item with this id exists here, finished or deleted or not. */
    has: (id) => !!itemOf(id),

    /**
     * Push a task. `opts.id` pins the id (the queue uses it so that starting a queued task twice is the same push): if
     * that id is already here, nothing changes and the existing item is returned. `opts.origin` is the id of an item this
     * one was made from.
     */
    async push(text, opts = {}) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return null;
      if (opts.id && itemOf(opts.id)) return row(opts.id);
      const id = opts.id ?? idFor(now());
      await journal.append([{ kind: "push", target: id, data: { text: trimmed, ...(typeof opts.origin === "string" ? { origin: opts.origin } : {}) } }]);
      return row(id);
    },

    /** Take the current item off the stack and push a new one, as one change. Empty text changes nothing. */
    async swap(text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return null;
      const t = now();
      const top = currentStack()[0] ?? null;
      const id = idFor(t);
      await journal.append([...(top ? [{ kind: "pop", target: top.itemId, at: t }] : []), { kind: "push", target: id, at: t, data: { text: trimmed } }]);
      return { removed: top, pushed: row(id) };
    },

    /** Pop an item that is on the stack. */
    async remove(id) {
      const r = row(id);
      if (r && !r.removed) await journal.append([{ kind: "pop", target: r.itemId }]);
    },

    /**
     * Drop an item: the top one is simply popped; a buried one is flagged, stays where it is, and is popped by itself
     * when it reaches the top.
     */
    async drop(id) {
      const r = row(id);
      if (!r || r.removed) return;
      const top = currentStack()[0];
      if (top && top.id === r.id) return this.remove(id);
      if (!r.dropped) await journal.append([{ kind: "drop", target: r.itemId }]);
    },

    /** Undo a pop or a drop: the pop (or the flag) is cancelled, as if it never happened. */
    async restore(id) {
      const it = itemOf(id);
      if (!it) return;
      const acts = journal.state().log[it.id] ?? [];
      const undo = [];
      if (!it.live) {
        const pop = lastLive(acts, "pop");
        if (pop) undo.push({ kind: "void", target: it.id, ref: pop.id });
        // popped by itself because it was dropped: bringing it back must bring it back for good
        if (pop?.id.startsWith("auto-") && it.dropAction) undo.push({ kind: "void", target: it.id, ref: it.dropAction });
      } else if (it.dropped && it.dropAction) undo.push({ kind: "void", target: it.id, ref: it.dropAction });
      if (undo.length) await journal.append(undo);
    },

    /**
     * Corrects an item: `fields` may hold text, ts (when this stay started) and at (when it ended). Anything not valid is
     * ignored, and so is `at` for a stay that has not ended. Each correction is an action that points at the action it
     * corrects, so what was first reported stays in the log. Returns the row, or null when nothing changed.
     */
    async edit(id, fields = {}) {
      const r = row(id);
      if (!r || r.deleted) return null;
      const made = [];
      const text = typeof fields.text === "string" ? fields.text.trim() : "";
      if (text && text.length <= MAX_TEXT && text !== r.text) made.push({ kind: "edit", target: r.itemId, data: { text } });
      if (Number.isFinite(fields.ts) && fields.ts >= 0 && fields.ts !== r.ts) made.push({ kind: "edit", target: r.itemId, ref: r.startAction, data: { at: fields.ts } });
      if (Number.isFinite(fields.at) && fields.at >= 0 && fields.at !== r.at && r.removed) made.push({ kind: "edit", target: r.itemId, ref: r.endAction, data: { at: fields.at } });
      if (!made.length) return null;
      await journal.append(made);
      return row(id);
    },

    /** Delete an item (on the stack or finished): hidden everywhere as if never made. Null if unknown or already deleted. */
    async delete(id) {
      const r = row(id);
      if (!r || r.deleted) return null;
      await journal.append([{ kind: "delete", target: r.itemId }]);
      return { ...r, deleted: true };
    },

    /** Undo a delete. */
    async undelete(id) {
      const it = itemOf(id);
      if (!it || !it.deleted) return null;
      await journal.append([{ kind: "undelete", target: it.id }]);
      return row(id);
    },

    /** Push a finished item onto the stack again: a new stay of the same item, the earlier ones kept. Null if it is on the stack already. */
    async pushAgain(id) {
      const it = itemOf(id);
      if (!it || it.live || it.deleted) return null;
      await journal.append([{ kind: "push-again", target: it.id }]);
      return currentStack().find((r) => r.itemId === it.id) ?? null;
    },

    syncNow: journal.syncNow,
    status: journal.status,
    /** Raw detail of the latest failed call (memory only), or null. */
    lastFailure: journal.lastFailure,
    /** The journal, for the queue and notes to share. */
    journal,
  };
}
