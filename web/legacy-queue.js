// The queue: a pile of things to do later, in no particular order. It is a separate structure from the stack, with its
// own rows, its own server table and its own IndexedDB database for them, but it syncs through the same channel as the
// stack (core.js): it joins the stack's hub, so one request carries both. The stack's code knows nothing about it.
//
// Like sync.js this has no browser globals: storage is injected so it runs under `bun test`.

/** The label the person sees for this pile. Rename it here and nowhere else. */
export const QUEUE_LABEL = "Later";

/**
 * Starting a queued task pushes it onto the stack as `s-` plus the rest of its id. The id is derived, not random, so
 * repeating the push (a retry after a crash or a dropped connection, or a second device starting the same row)
 * lands on the same stack item instead of making a second one.
 */
export const stackIdFor = (queueId) => "s-" + queueId.slice(2);

// What the queue sends for one row.
const toWire = (it) => ({ text: it.text, ts: it.ts, removed: it.removed, started: !!it.started, at: it.at });

// `local` is the static version: nothing is sent anywhere. `stack` is the stack's sync (sync.js), used by `promote` and
// to share its sync channel. `fetch` and `onStatus` are not used: the stack's hub owns the network and the one status.
export function createQueue({ storage, stack, now = () => Date.now(), onChange = () => {} }) {
  const hub = stack.hub;
  const table = hub.table("queue", { storage, onChange, toWire }); // id -> {id, text, ts, at, removed, started, seq}; `removed` rows are tombstones
  const items = table.items;
  const setItem = (item) => table.setItems([item]);
  const syncNow = hub.syncNow;
  const starting = new Set(); // ids whose start is under way here, so reconcile leaves them to promote

  const newItem = (text, ts) => ({
    id: `q-${ts.toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`,
    text,
    ts,
    at: ts,
    removed: false,
    started: false,
    seq: 0,
  });

  // Newest added first. It is a pile, not a line: nothing about the order means "next".
  const current = () =>
    [...items.values()].filter((i) => !i.removed).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));

  // The second part of a start: the row is tombstoned and marked started (not dropped).
  const finishStart = (it) => setItem({ ...it, removed: true, started: true, at: now() });

  return {
    async start() {
      await table.load();
      onChange();
      if (hub.local) return hub.onStatus();
      await syncNow();
    },

    queue: current,

    /** Put a task on the pile. Empty text changes nothing. */
    async add(text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return null;
      const item = newItem(trimmed, now());
      await setItem(item);
      return item;
    },

    async drop(id) {
      const it = items.get(id);
      if (it && !it.removed) await setItem({ ...it, removed: true, started: false, at: now() });
    },

    /** Undo a drop. A started row is not restorable: it is on the stack now. */
    async restore(id) {
      const it = items.get(id);
      if (it && it.removed && !it.started) await setItem({ ...it, removed: false, at: now() });
    },

    /**
     * Start: move a row from the queue to the top of the stack. Two writes, in two structures that sync separately:
     *   1. push onto the stack under the derived id (skipped if that id is already there, even if since popped);
     *   2. tombstone the queue row as started.
     * Each step is safe to repeat, and step 1 is saved on the device before step 2 begins. If the app dies between
     * them, `reconcile` finishes step 2 the next time it runs, so the row is never left looking unstarted next to
     * its own stack item, and never pushed twice.
     */
    async promote(id) {
      const it = items.get(id);
      if (!it || it.removed) return null;
      starting.add(id);
      try {
        const pushed = await stack.push(it.text, { id: stackIdFor(id) });
        await finishStart(it);
        return pushed;
      } finally {
        starting.delete(id);
      }
    },

    /** Finish any start that was interrupted: a live row whose stack item already exists is tombstoned as started. */
    async reconcile() {
      for (const it of [...items.values()]) {
        if (!it.removed && !starting.has(it.id) && stack.has(stackIdFor(it.id))) await finishStart(it);
      }
    },

    syncNow,
    /** The one status of the shared channel: the same object shape as the stack's, counting every table's pending changes. */
    status: hub.status,
  };
}
