// Updating a list of elements in place instead of rebuilding it, so what is focused, selected, hovered or being
// tapped inside a row survives a re-render. `planReconcile` is the pure decision; `reconcileList` applies it to the DOM.

// Indices (into `values`) of one longest strictly increasing subsequence, by patience sorting in O(n log n).
function lisIndices(values) {
  const tails = []; // tails[k] = index of the smallest tail of an increasing run of length k+1
  const prev = Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(i);
  return out.reverse();
}

/**
 * Which keys to remove and which to (re)place, to turn the element order `oldKeys` into `newKeys`.
 * `place` lists, in new order, the keys that need an insertBefore: the new ones, and the fewest retained ones that must
 * move. Everything else stays untouched. A retained `focusedKey` is never in `place` (moving a node blurs it): the
 * cheapest set of elements that can stay is chosen subject to that one staying, so its neighbours move instead.
 */
export function planReconcile(oldKeys, newKeys, focusedKey = null) {
  const oldPos = new Map();
  oldKeys.forEach((k, i) => oldPos.set(k, i));
  if (new Set(newKeys).size !== newKeys.length) throw new Error("duplicate keys in the new list");
  const newSet = new Set(newKeys);
  const remove = oldKeys.filter((k) => !newSet.has(k));

  const keep = newKeys.filter((k) => oldPos.has(k));
  const pos = keep.map((k) => oldPos.get(k));
  const stay = new Set();
  const m = focusedKey != null ? keep.indexOf(focusedKey) : -1;
  if (m < 0) {
    for (const i of lisIndices(pos)) stay.add(keep[i]);
  } else {
    // Before the focused key only keys that were before it can stay, after it only keys that were after it.
    const before = [];
    for (let i = 0; i < m; i++) if (pos[i] < pos[m]) before.push(i);
    const after = [];
    for (let i = m + 1; i < keep.length; i++) if (pos[i] > pos[m]) after.push(i);
    for (const j of lisIndices(before.map((i) => pos[i]))) stay.add(keep[before[j]]);
    stay.add(keep[m]);
    for (const j of lisIndices(after.map((i) => pos[i]))) stay.add(keep[after[j]]);
  }
  const place = newKeys.filter((k) => !oldPos.has(k) || !stay.has(k));
  return { remove, place };
}

const KEY = Symbol("reconcileKey");

/**
 * Makes `container`'s children match `items`, one element per item, reusing the element for a key that is still
 * there. `create(item)` builds a new element; `update(el, item)` is then called for every item (new or not) and
 * should change only what differs. Elements are only moved when the order really changed, never the focused one.
 */
export function reconcileList(container, items, { key, create, update }) {
  const doc = container.ownerDocument;
  const byKey = new Map();
  const oldKeys = [];
  for (const child of [...container.children]) {
    if (child[KEY] === undefined) container.removeChild(child); // not ours
    else {
      byKey.set(child[KEY], child);
      oldKeys.push(child[KEY]);
    }
  }
  const active = doc.activeElement && container.contains(doc.activeElement) ? doc.activeElement : null;
  let focusedKey = null;
  if (active) for (const [k, el] of byKey) if (el.contains(active)) focusedKey = k;

  const keys = items.map(key);
  const plan = planReconcile(oldKeys, keys, focusedKey);
  for (const k of plan.remove) {
    byKey.get(k).remove();
    byKey.delete(k);
  }
  const itemFor = new Map(items.map((it, i) => [keys[i], it]));
  for (const k of keys) {
    if (!byKey.has(k)) {
      const el = create(itemFor.get(k));
      el[KEY] = k;
      byKey.set(k, el);
    }
  }
  // From the end, each key to place goes before the element that follows it in the new order.
  const placed = new Set(plan.place);
  for (let i = keys.length - 1; i >= 0; i--) {
    if (!placed.has(keys[i])) continue;
    const next = i + 1 < keys.length ? byKey.get(keys[i + 1]) : null;
    container.insertBefore(byKey.get(keys[i]), next);
  }
  for (const k of keys) update(byKey.get(k), itemFor.get(k));
  // A moved or replaced node loses focus in browsers; put it back if the plan could not avoid that.
  if (active && active.isConnected && doc.activeElement !== active) active.focus({ preventScroll: true });
}
