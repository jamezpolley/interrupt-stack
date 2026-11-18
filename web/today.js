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
