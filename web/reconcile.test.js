import { describe, expect, test } from "bun:test";
import { planReconcile } from "./reconcile.js";

// Applies a plan to a list of keys the way the DOM helper does: remove, then walk the new order from the end placing
// each created or moved key before the one after it. Returns the resulting order and how many insertions it made.
function apply(oldKeys, newKeys, plan) {
  const list = oldKeys.filter((k) => !plan.remove.includes(k));
  let inserts = 0;
  for (let i = newKeys.length - 1; i >= 0; i--) {
    const k = newKeys[i];
    if (!plan.place.includes(k)) continue;
    const at = list.indexOf(k);
    if (at >= 0) list.splice(at, 1);
    const next = i + 1 < newKeys.length ? list.indexOf(newKeys[i + 1]) : list.length;
    list.splice(next, 0, k);
    inserts++;
  }
  return { list, inserts };
}
const run = (o, n, f) => {
  const plan = planReconcile(o, n, f);
  return { plan, ...apply(o, n, plan) };
};

describe("planReconcile", () => {
  test("nothing changes: nothing to do", () => {
    const { plan, inserts } = run(["a", "b", "c"], ["a", "b", "c"]);
    expect(plan).toEqual({ remove: [], place: [] });
    expect(inserts).toBe(0);
  });

  test("empty to full: everything is created, in order", () => {
    const r = run([], ["a", "b", "c"]);
    expect(r.list).toEqual(["a", "b", "c"]);
    expect(r.plan.remove).toEqual([]);
    expect(r.plan.place).toEqual(["a", "b", "c"]);
  });

  test("full to empty: everything is removed", () => {
    const r = run(["a", "b", "c"], []);
    expect(r.plan).toEqual({ remove: ["a", "b", "c"], place: [] });
    expect(r.list).toEqual([]);
  });

  test("insert at the start, middle and end touches only the new key", () => {
    for (const [n, k] of [[["x", "a", "b", "c"], "x"], [["a", "x", "b", "c"], "x"], [["a", "b", "c", "x"], "x"]]) {
      const r = run(["a", "b", "c"], n);
      expect(r.list).toEqual(n);
      expect(r.plan.place).toEqual([k]);
      expect(r.plan.remove).toEqual([]);
    }
  });

  test("remove from the start, middle and end moves nothing", () => {
    for (const [n, k] of [[["b", "c"], "a"], [["a", "c"], "b"], [["a", "b"], "c"]]) {
      const r = run(["a", "b", "c"], n);
      expect(r.list).toEqual(n);
      expect(r.plan).toEqual({ remove: [k], place: [] });
    }
  });

  test("a swap of neighbours moves one element", () => {
    const r = run(["a", "b", "c", "d"], ["a", "c", "b", "d"]);
    expect(r.list).toEqual(["a", "c", "b", "d"]);
    expect(r.inserts).toBe(1);
  });

  test("moving the last to the front moves one element, not all the others", () => {
    const r = run(["a", "b", "c", "d", "e"], ["e", "a", "b", "c", "d"]);
    expect(r.list).toEqual(["e", "a", "b", "c", "d"]);
    expect(r.inserts).toBe(1);
  });

  test("reversing moves all but one", () => {
    const r = run(["a", "b", "c", "d"], ["d", "c", "b", "a"]);
    expect(r.list).toEqual(["d", "c", "b", "a"]);
    expect(r.inserts).toBe(3);
  });

  test("a mix of removal, insertion and reordering", () => {
    const r = run(["a", "b", "c", "d", "e"], ["e", "x", "b", "a", "y"], null);
    expect(r.list).toEqual(["e", "x", "b", "a", "y"]);
    expect(r.plan.remove.sort()).toEqual(["c", "d"]);
  });

  test("keys are identity: duplicate texts with distinct keys are different elements", () => {
    const r = run(["k1", "k2"], ["k2", "k3", "k1"]);
    expect(r.list).toEqual(["k2", "k3", "k1"]);
    expect(r.plan.place).toContain("k3");
  });

  test("the focused element is never the one that moves", () => {
    // Without focus the cheapest plan moves "a" (one move). With "a" focused it must move the others instead.
    const o = ["a", "b", "c", "d"];
    const n = ["b", "c", "d", "a"];
    expect(run(o, n).plan.place).toEqual(["a"]);
    const r = run(o, n, "a");
    expect(r.list).toEqual(n);
    expect(r.plan.place).not.toContain("a");
    expect(r.plan.place.sort()).toEqual(["b", "c", "d"]);
  });

  test("a focused element that is already in a stable position costs nothing extra", () => {
    const r = run(["a", "b", "c"], ["a", "x", "b", "c"], "b");
    expect(r.plan.place).toEqual(["x"]);
  });

  test("a focused element that was removed or is new is simply ignored", () => {
    expect(run(["a", "b"], ["a"], "b").list).toEqual(["a"]);
    expect(run(["a"], ["a", "b"], "b").list).toEqual(["a", "b"]);
    expect(run(["a", "b"], ["b", "a"], "zzz").list).toEqual(["b", "a"]);
  });

  test("duplicate keys in the new list are rejected loudly", () => {
    expect(() => planReconcile(["a"], ["a", "a"])).toThrow();
  });
});

describe("planReconcile: against brute force", () => {
  const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const shuffle = (r, a) => {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  };
  // The fewest moves any plan can make: retained keys minus the longest run of them that already is in order,
  // optionally one that must contain `must`. O(n^2) and obviously right.
  function fewest(oldKeys, newKeys, must) {
    const keep = newKeys.filter((k) => oldKeys.includes(k));
    const pos = keep.map((k) => oldKeys.indexOf(k));
    const n = pos.length;
    const best = Array(n).fill(1);
    const prev = Array(n).fill(-1);
    // longest increasing subsequence of pos that includes index m (if given): prefix ending at m, then suffix from m
    const mIdx = must && keep.includes(must) ? keep.indexOf(must) : -1;
    const lisEnd = (end) => {
      const dp = [];
      for (let i = 0; i <= end; i++) {
        dp[i] = 1;
        for (let j = 0; j < i; j++) if (pos[j] < pos[i]) dp[i] = Math.max(dp[i], dp[j] + 1);
      }
      return dp[end];
    };
    if (mIdx < 0) {
      let m = 0;
      for (let i = 0; i < n; i++) m = Math.max(m, lisEnd(i));
      return n - m;
    }
    const before = lisEnd(mIdx);
    let after = 1;
    const dp = [];
    for (let i = n - 1; i >= mIdx; i--) {
      dp[i] = 1;
      for (let j = i + 1; j < n; j++) if (pos[j] > pos[i]) dp[i] = Math.max(dp[i], dp[j] + 1);
    }
    after = dp[mIdx];
    return n - (before + after - 1);
  }

  test("random old and new lists: the result is right and the plan is as small as possible", () => {
    const r = rng(7);
    for (let t = 0; t < 600; t++) {
      const universe = Array.from({ length: 12 }, (_, i) => "k" + i);
      const oldKeys = shuffle(r, universe).slice(0, Math.floor(r() * 12));
      const newKeys = shuffle(r, universe).slice(0, Math.floor(r() * 12));
      const focused = r() < 0.5 && oldKeys.length ? oldKeys[Math.floor(r() * oldKeys.length)] : null;
      const plan = planReconcile(oldKeys, newKeys, focused);
      const { list } = apply(oldKeys, newKeys, plan);
      const msg = JSON.stringify({ oldKeys, newKeys, focused, plan });
      expect(list, msg).toEqual(newKeys);
      expect(plan.remove.sort(), msg).toEqual(oldKeys.filter((k) => !newKeys.includes(k)).sort());
      const created = newKeys.filter((k) => !oldKeys.includes(k));
      const moved = plan.place.filter((k) => oldKeys.includes(k));
      expect(plan.place.filter((k) => !oldKeys.includes(k)).sort(), msg).toEqual(created.sort());
      expect(moved.length, msg).toBe(fewest(oldKeys, newKeys, focused));
      if (focused && newKeys.includes(focused)) expect(plan.place, msg).not.toContain(focused);
    }
  });
});
