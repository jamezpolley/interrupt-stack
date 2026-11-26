// The queue: a pile of things to do later, in no particular order. A view over the journal's state, with its own kinds of
// action (later, dequeue, requeue, start). The stack's code knows nothing about it.
import { queueRows } from "./rows.js";

/** The label the person sees for this pile. Rename it here and nowhere else. */
export const QUEUE_LABEL = "Later";

/**
 * Starting a queued task pushes it onto the stack as `s-` plus the rest of its id. The id is derived, not random, so
 * repeating the push (a retry after a crash or a dropped connection, or a second device starting the same row)
 * lands on the same stack item instead of making a second one.
 */
export const stackIdFor = (queueId) => "s-" + queueId.slice(2);

export function createQueue({ stack, now = () => Date.now(), onChange = () => {} }) {
  const journal = stack.journal;
  let cache = null;
  const rows = () => {
    const st = journal.state();
    if (cache?.st !== st) cache = { st, rows: queueRows(st) };
    return cache.rows;
  };
  const row = (id) => rows().find((r) => r.id === id) ?? null;
  const starting = new Set(); // ids whose start is under way here, so reconcile leaves them to promote

  // Newest added first. It is a pile, not a line: nothing about the order means "next".
  const current = () => rows().filter((i) => !i.removed).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  const finishStart = (it) => journal.append([{ kind: "start", target: it.id }]);

  return {
    async start() {
      await journal.load();
      await this.reconcile();
      onChange();
    },

    queue: current,

    /** Put a task on the pile. Empty text changes nothing. */
    async add(text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return null;
      const id = `q-${now().toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
      await journal.append([{ kind: "later", target: id, data: { text: trimmed } }]);
      return row(id);
    },

    async drop(id) {
      const it = row(id);
      if (it && !it.removed) await journal.append([{ kind: "dequeue", target: id }]);
    },

    /** Undo a drop. A started row is not restorable: it is on the stack now. */
    async restore(id) {
      const it = row(id);
      if (it && it.removed && !it.started) await journal.append([{ kind: "requeue", target: id }]);
    },

    /**
     * Start: move a row from the queue to the top of the stack: push onto the stack under the derived id (skipped if that id
     * is already there, even if since popped), then mark the queue row started. Each step is safe to repeat. If the app dies
     * between them, `reconcile` finishes the second step the next time it runs.
     */
    async promote(id) {
      const it = row(id);
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

    /** Finish any start that was interrupted: a live row whose stack item already exists is marked started. */
    async reconcile() {
      for (const it of [...rows()]) {
        if (!it.removed && !starting.has(it.id) && stack.has(stackIdFor(it.id))) await finishStart(it);
      }
    },

    syncNow: journal.syncNow,
    /** The one status of the shared channel. */
    status: journal.status,
  };
}
