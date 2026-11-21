// Items taken off the stack today, newest first. "Today" is the device's own calendar day, so it rolls over at
// local midnight. An item stored before removal times existed has no `at`, so its push time stands in for it.
export function completedToday(items, nowMs) {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const when = (i) => i.at ?? i.ts;
  return items
    .filter((i) => i.removed && when(i) >= start.getTime())
    .sort((a, b) => when(b) - when(a) || (a.id < b.id ? 1 : -1));
}

/**
 * Done today as one list: the finished items and today's notes together, newest first. An item is dated by when it
 * ended, a note by its time. Each entry is `{ kind: "item" | "note", item | note }`.
 */
export function doneTodayEntries(items, notes, nowMs) {
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const entries = [
    ...completedToday(items, nowMs).map((item) => ({ kind: "item", item, when: item.at ?? item.ts })),
    ...notes.filter((n) => !n.removed && n.ts >= start.getTime()).map((note) => ({ kind: "note", note, when: note.ts })),
  ];
  return entries.sort((a, b) => b.when - a.when || ((a.item ?? a.note).id < (b.item ?? b.note).id ? 1 : -1));
}
