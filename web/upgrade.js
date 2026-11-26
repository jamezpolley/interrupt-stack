// Moving a device from the old row databases (items, queue, notes) to the journal. Runs once per device, before the
// journal starts. The static version holds everything only here, so all of its rows become actions. A server device's
// rows are already on the server (it converted them itself), so only the rows this device had not sent yet are carried over,
// as actions, and sent in the usual way. Either way it is marked done, so it never runs again.

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
 * `journal` is the journal. Returns "done" (nothing to do), "imported" (the static version's rows) or "carried" (a server
 * device's unsent rows).
 */
export async function upgradeFromRows({ old, meta, journal, local = false }) {
  if (await meta.getMeta(DONE, false)) return "done";
  const read = async (s) => {
    try {
      const x = await s.load();
      return { items: x.items ?? [], dirty: new Set(x.dirty ?? []) };
    } catch {
      return { items: [], dirty: new Set() };
    }
  };
  const [stack, queue, notes] = await Promise.all([read(old.stack), read(old.queue), read(old.notes)]);
  const pick = (x) => (local ? x.items : x.items.filter((r) => x.dirty.has(r.id)));
  const actions = actionsFromRows({ items: pick(stack), queue: pick(queue), notes: pick(notes) });
  if (actions.length) await journal.append(actions);
  await meta.putMeta(DONE, true);
  return actions.length ? (local ? "imported" : "carried") : "done";
}
