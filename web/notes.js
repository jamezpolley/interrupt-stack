// Notes: a short text entry with a time. A separate synced table (it joins the stack's sync channel, core.js), never on
// the stack and never "on top": the stack's code, timeline and depth know nothing about it. Last write wins.
//
// Like sync.js this has no browser globals: storage is injected so it runs under `bun test`.

export const MAX_TEXT = 200;

// What a note sends. `pendingEdit` is local: it makes the server take the new text and time.
const toWire = (n) => ({ text: n.text, ts: n.ts, removed: !!n.removed, ...(n.pendingEdit ? { edit: true } : {}) });

export function createNotes({ storage, stack, now = () => Date.now(), onChange = () => {} }) {
  const hub = stack.hub;
  const table = hub.table("notes", { storage, onChange, toWire }); // id -> {id, text, ts, removed, seq, edited_at?}
  const items = table.items;
  const setNote = (n) => table.setItems([n]);

  const newNote = (text, ts) => ({
    id: `n-${ts.toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`,
    text,
    ts,
    removed: false,
    seq: 0,
  });

  return {
    async start() {
      await table.load();
      onChange();
      if (hub.local) return hub.onStatus();
      await hub.syncNow();
    },

    /** Every note that is not removed, newest first. */
    notes: () => [...items.values()].filter((n) => !n.removed).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1)),

    get: (id) => items.get(id),

    /** Add a note, dated now. Empty or over-long text changes nothing. */
    async add(text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed || trimmed.length > MAX_TEXT) return null;
      const note = newNote(trimmed, now());
      await setNote(note);
      return note;
    },

    /**
     * Correct a note: `fields` may hold text and ts. Anything invalid is ignored, a time in the future is ignored, and
     * nothing is written when nothing changes. Sent as an edit until the server acknowledges it; `edited_at` is set
     * here too so the change shows at once, offline.
     */
    async edit(id, fields = {}) {
      const n = items.get(id);
      if (!n || n.removed) return null;
      const next = { ...n };
      const text = typeof fields.text === "string" ? fields.text.trim() : "";
      if (text && text.length <= MAX_TEXT) next.text = text;
      if (Number.isFinite(fields.ts) && fields.ts >= 0 && fields.ts <= now()) next.ts = fields.ts;
      if (next.text === n.text && next.ts === n.ts) return null;
      next.edited_at = now();
      if (!hub.local) next.pendingEdit = true;
      await setNote(next);
      return next;
    },

    /** Delete a note: a tombstone, so the removal syncs. */
    async remove(id) {
      const n = items.get(id);
      if (n && !n.removed) await setNote({ ...n, removed: true });
    },

    /** Undo a delete. */
    async restore(id) {
      const n = items.get(id);
      if (n && n.removed) await setNote({ ...n, removed: false });
    },
  };
}
