// "Push again" from a finished item's details: a brand new stack item with the same text, linked to the finished
// one by `origin`. The finished item is not touched. Returns the new item, or null when there is nothing to push
// (unknown id, still on the stack, or no end time, which is also what keeps such a row from opening details).
export async function pushAgain(sync, id) {
  const item = sync.allItems().find((i) => i.id === id);
  if (!item || !item.removed || !Number.isFinite(item.at)) return null;
  return sync.push(item.text, { origin: item.id });
}
