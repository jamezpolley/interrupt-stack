// Notes: a short text entry with a time. A view over the journal's state, never on the stack and never "on top".
import { noteRows } from "./rows.js";

export const MAX_TEXT = 200;

export function createNotes({ stack, now = () => Date.now(), onChange = () => {} }) {
  const journal = stack.journal;
  let cache = null;
  const rows = () => {
    const st = journal.state();
    if (cache?.st !== st) cache = { st, rows: noteRows(st) };
    return cache.rows;
  };
  const get = (id) => rows().find((n) => n.id === id) ?? null;

  return {
    async start() {
      await journal.load();
      onChange();
    },

    /** Every note that is not removed, newest first. */
    notes: () => rows().filter((n) => !n.removed).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1)),

    get,

    /** Add a note, dated now. Empty or over-long text changes nothing. */
    async add(text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed || trimmed.length > MAX_TEXT) return null;
      const id = `n-${now().toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
      await journal.append([{ kind: "note", target: id, data: { text: trimmed } }]);
      return get(id);
    },

    /** Correct a note: `fields` may hold text and ts. Anything invalid is ignored, a time in the future is ignored, and nothing is written when nothing changes. */
    async edit(id, fields = {}) {
      const n = get(id);
      if (!n || n.removed) return null;
      const made = [];
      const text = typeof fields.text === "string" ? fields.text.trim() : "";
      if (text && text.length <= MAX_TEXT && text !== n.text) made.push({ kind: "edit", target: id, data: { text } });
      if (Number.isFinite(fields.ts) && fields.ts >= 0 && fields.ts <= now() && fields.ts !== n.ts) made.push({ kind: "edit", target: id, ref: n.action, data: { at: fields.ts } });
      if (!made.length) return null;
      await journal.append(made);
      return get(id);
    },

    /** Delete a note. */
    async remove(id) {
      const n = get(id);
      if (n && !n.removed) await journal.append([{ kind: "delete", target: id }]);
    },

    /** Undo a delete. */
    async restore(id) {
      const n = get(id);
      if (n && n.removed) await journal.append([{ kind: "undelete", target: id }]);
    },
  };
}
