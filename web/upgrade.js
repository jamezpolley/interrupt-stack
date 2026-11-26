// Moving a device from the old row databases (items, queue, notes) to the journal. Runs once per device, before the
// journal starts.
//
// Server version: the server already holds everything it was sent (it converted its own rows into actions when it was
// upgraded), so all that can be lost is what this device had not sent yet. The old sync code is used one last time to
// send exactly that, over the old wire, which the server still serves. Static version: nothing is held anywhere else, so the
// rows become actions in the journal. Either way it is marked done, so it never runs again.
import { createSync as createLegacySync } from "./legacy-sync.js";
import { createQueue as createLegacyQueue } from "./legacy-queue.js";
import { createNotes as createLegacyNotes } from "./legacy-notes.js";

/** The actions the old rows amount to. Ids are derived from the rows' ids, so doing it twice is the same as once. */
export function actionsFromRows({ items = [], queue = [], notes = [] }) {
  const out = [];
  for (const r of items) {
    out.push({ id: `imp-${r.id}-push`, kind: "push", target: r.id, at: r.ts, data: { text: r.text, ...(r.origin ? { origin: r.origin } : {}) } });
    if (r.removed) out.push({ id: `imp-${r.id}-pop`, kind: "pop", target: r.id, at: Number.isFinite(r.at) ? r.at : r.ts });
    if (r.deleted) out.push({ id: `imp-${r.id}-delete`, kind: "delete", target: r.id, at: r.ts });
  }
  for (const r of notes) {
    out.push({ id: `imp-${r.id}-note`, kind: "note", target: r.id, at: r.ts, data: { text: r.text } });
    if (r.removed) out.push({ id: `imp-${r.id}-delete`, kind: "delete", target: r.id, at: r.ts });
  }
  for (const r of queue) {
    out.push({ id: `imp-${r.id}-later`, kind: "later", target: r.id, at: r.ts, data: { text: r.text } });
    if (r.removed) out.push({ id: `imp-${r.id}-leave`, kind: r.started ? "start" : "dequeue", target: r.id, at: Number.isFinite(r.at) ? r.at : r.ts });
  }
  return out;
}

const DONE = "legacyDone";

/**
 * `old` is `{ stack, queue, notes }`, the three old row storages; `meta` is `{ getMeta, putMeta }` of the journal's storage;
 * `journal` is the journal (only used by the static version). Returns "done", "imported", "sent" or "waiting" (a
 * server device that could not reach the server; the next start tries again).
 */
export async function upgradeFromRows({ old, meta, journal, fetch, online = () => true, local = false }) {
  if (await meta.getMeta(DONE, false)) return "done";
  const read = async (s) => {
    try {
      return await s.load();
    } catch {
      return { items: [], dirty: [] };
    }
  };
  const [stack, queue, notes] = await Promise.all([read(old.stack), read(old.queue), read(old.notes)]);
  const anything = [stack, queue, notes].some((x) => x.items?.length || x.dirty?.length);
  if (!anything) {
    await meta.putMeta(DONE, true);
    return "done";
  }
  if (local) {
    await journal.append(actionsFromRows({ items: stack.items, queue: queue.items, notes: notes.items }));
    await meta.putMeta(DONE, true);
    return "imported";
  }
  if (![stack, queue, notes].some((x) => x.dirty?.length)) {
    await meta.putMeta(DONE, true);
    return "done";
  }
  const s = createLegacySync({ storage: old.stack, fetch, online });
  const q = createLegacyQueue({ storage: old.queue, stack: s });
  const n = createLegacyNotes({ storage: old.notes, stack: s });
  await s.start();
  await q.start();
  await n.start();
  await s.syncNow();
  if (s.status().pending === 0 && s.status().state !== "offline") {
    await meta.putMeta(DONE, true);
    return "sent";
  }
  return "waiting";
}
