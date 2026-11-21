// The stack: pushing, swapping, removing, restoring and editing tasks, locally first. The network side (one request for
// every synced table, the cursor, the epoch, failures) is the shared core in core.js; this file only knows the stack's rows.
//
// Items are replaced, never mutated, so object identity tells us whether an item changed while a request was in flight.
import { createHub } from "./core.js";

// What the stack sends for one item. `pendingEdit` is local: it makes the server take the new text and times.
const toWire = (it) => ({ text: it.text, ts: it.ts, removed: it.removed, at: it.at, ...(it.origin ? { origin: it.origin } : {}), ...(it.pendingEdit ? { edit: true } : {}) });

// `local` is the static version: nothing is ever sent anywhere, so there is no pending set and no network use.
export function createSync({ storage, fetch, now = () => Date.now(), online = () => true, onChange = () => {}, onStatus = () => {}, local = false }) {
  // The storage also keeps the cursor and epoch for every table. Other tables join through `sync.hub`.
  const hub = createHub({ meta: storage, fetch, now, online, onStatus, local });
  const table = hub.table("items", { storage, onChange, toWire }); // id -> {id, text, ts, at, removed, seq}; `at` is when it last changed state, on this device's clock
  const items = table.items;
  const setItems = (list) => table.setItems(list);
  const setItem = (item) => setItems([item]);
  const syncNow = hub.syncNow;

  const newItem = (text, ts, id = `s-${ts.toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`, origin = null) => {
    return { id, text, ts, at: ts, removed: false, seq: 0, ...(origin ? { origin } : {}) };
  };

  const currentStack = () =>
    [...items.values()].filter((i) => !i.removed).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));

  return {
    async start() {
      await table.load();
      onChange();
      if (local) return hub.onStatus();
      await syncNow();
    },

    stack: currentStack,

    /** Every item, including removed ones, for views of what has been done. */
    allItems() {
      return [...items.values()];
    },

    /** Whether an item with this id exists here, removed or not. */
    has: (id) => items.has(id),

    /**
     * Push a task. `opts.id` pins the id (the queue uses it so that starting a queued task twice is the same push):
     * if that id is already here, removed or not, nothing changes and the existing item is returned.
     * `opts.origin` is the id of the finished item this is a fresh copy of ("push again"); it is stored once and kept.
     */
    async push(text, opts = {}) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return null;
      if (opts.id && items.has(opts.id)) return items.get(opts.id);
      const item = newItem(trimmed, now(), opts.id, typeof opts.origin === "string" ? opts.origin : null);
      await setItem(item);
      return item;
    },

    /** Take the current item off the stack and push a new one, as one change. Empty text changes nothing. */
    async swap(text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return null;
      const t = now();
      const top = currentStack()[0] ?? null;
      const removed = top ? { ...top, removed: true, at: t } : null;
      const pushed = newItem(trimmed, t);
      await setItems(removed ? [removed, pushed] : [pushed]);
      return { removed: top, pushed };
    },

    async remove(id) {
      const it = items.get(id);
      if (it && !it.removed) await setItem({ ...it, removed: true, at: now() });
    },

    async restore(id) {
      const it = items.get(id);
      if (it && it.removed) await setItem({ ...it, removed: false, at: now() });
    },

    /**
     * Corrects a finished item: `fields` may hold text, ts (when it was pushed) and at (when it ended). Anything not
     * valid is ignored, and an item still on the stack is not editable. The copy is marked `pendingEdit` until the
     * server acknowledges it, and is sent as an edit, so the server takes the new text and times instead of treating
     * the write as a stale copy. `edited_at` is set here too, so the "edited" mark shows at once and offline; the
     * server's own value replaces it on acknowledgement.
     */
    async edit(id, fields = {}) {
      const it = items.get(id);
      if (!it || !it.removed) return null;
      const next = { ...it };
      const text = typeof fields.text === "string" ? fields.text.trim() : "";
      if (text && text.length <= 200) next.text = text;
      if (Number.isFinite(fields.ts)) next.ts = fields.ts;
      if (Number.isFinite(fields.at)) next.at = fields.at;
      if (next.text === it.text && next.ts === it.ts && next.at === it.at) return null;
      next.edited_at = now();
      if (!local) next.pendingEdit = true;
      await setItem(next);
      return next;
    },

    syncNow,
    status: hub.status,
    /** Raw detail of the latest failed call (memory only), or null. */
    lastFailure: hub.lastFailure,
    /** The shared sync core, for other tables (the queue) to join. */
    hub,
  };
}
