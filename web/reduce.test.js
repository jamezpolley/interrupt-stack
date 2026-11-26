import { describe, expect, test } from "bun:test";
import { apply, emptyState, reduce } from "./reduce.js";

let n = 0;
const act = (kind, target, at, extra = {}) => ({ id: extra.id ?? `a${++n}`, n, ts: extra.ts ?? at, at, kind, target, ...extra });
const push = (target, at, text = "task", data = {}) => act("push", target, at, { data: { text, ...data } });

describe("reduce: items", () => {
  test("a push makes a live item with one open interval", () => {
    const s = reduce([push("s-a", 100, "write")]);
    expect(s.items["s-a"]).toEqual({ id: "s-a", text: "write", deleted: false, dropped: false, live: true, intervals: [{ start: { action: expect.any(String), at: 100, ts: 100 }, end: null }] });
  });

  test("a pop ends the interval", () => {
    const s = reduce([push("s-a", 100), act("pop", "s-a", 200)]);
    expect(s.items["s-a"].live).toBe(false);
    expect(s.items["s-a"].intervals[0].end).toMatchObject({ at: 200, ts: 200, kind: "pop" });
  });

  test("a void of the pop is an undo: the item never left", () => {
    const pop = act("pop", "s-a", 200, { id: "pop1" });
    const s = reduce([push("s-a", 100), pop, act("void", "s-a", 210, { ref: "pop1" })]);
    expect(s.items["s-a"].live).toBe(true);
    expect(s.items["s-a"].intervals).toHaveLength(1);
    expect(s.items["s-a"].intervals[0].end).toBeNull();
  });

  test("push again after a pop adds a second interval and keeps the first", () => {
    const s = reduce([push("s-a", 100), act("pop", "s-a", 200), act("push-again", "s-a", 300), act("pop", "s-a", 400)]);
    const iv = s.items["s-a"].intervals;
    expect(iv.map((i) => [i.start.at, i.end.at])).toEqual([[100, 200], [300, 400]]);
    expect(s.items["s-a"].live).toBe(false);
  });

  test("push again while it is still on the stack does nothing", () => {
    const s = reduce([push("s-a", 100), act("push-again", "s-a", 150)]);
    expect(s.items["s-a"].intervals).toHaveLength(1);
  });

  test("drop only flags the item; it stays on the stack until popped", () => {
    const s = reduce([push("s-a", 100), act("drop", "s-a", 150)]);
    expect(s.items["s-a"]).toMatchObject({ dropped: true, live: true });
    expect(s.items["s-a"].dropAction).toEqual(expect.any(String));
  });

  test("an edit of an action's time changes the effective time and the original action is untouched", () => {
    const p = push("s-a", 100);
    const pop = act("pop", "s-a", 200, { id: "pop1" });
    const s = reduce([p, pop, act("edit", "s-a", 500, { ref: "pop1", data: { at: 250 } })]);
    expect(s.items["s-a"].intervals[0].end).toMatchObject({ at: 250, ts: 200 });
    expect(pop.at).toBe(200);
  });

  test("the latest edit wins", () => {
    const p = push("s-a", 100, "t", {});
    const s = reduce([p, act("edit", "s-a", 150, { ref: p.id, data: { at: 90 } }), act("edit", "s-a", 160, { ref: p.id, data: { at: 95 } })]);
    expect(s.items["s-a"].intervals[0].start.at).toBe(95);
  });

  test("an edit of a voided action is ignored", () => {
    const pop = act("pop", "s-a", 200, { id: "pop1" });
    const s = reduce([push("s-a", 100), pop, act("edit", "s-a", 210, { ref: "pop1", data: { at: 300 } }), act("void", "s-a", 220, { ref: "pop1" })]);
    expect(s.items["s-a"].live).toBe(true);
  });

  test("an end reported before the start reads as a zero-length stay, and the log keeps what was sent", () => {
    const pop = act("pop", "s-a", 90);
    const s = reduce([push("s-a", 100), pop]);
    expect(s.items["s-a"].intervals[0].end.at).toBe(100);
    expect(pop.at).toBe(90);
  });

  test("a text edit and delete / undelete", () => {
    const s = reduce([push("s-a", 100, "old"), act("edit", "s-a", 110, { data: { text: "new" } }), act("delete", "s-a", 120)]);
    expect(s.items["s-a"]).toMatchObject({ text: "new", deleted: true });
    apply(s, act("undelete", "s-a", 130));
    expect(s.items["s-a"].deleted).toBe(false);
  });

  test("applying the same action twice does nothing", () => {
    const p = push("s-a", 100);
    const s = reduce([p, p]);
    expect(s.log["s-a"]).toHaveLength(1);
  });

  test("an action for an item that was never pushed, and an unknown kind, change nothing", () => {
    const s = reduce([act("pop", "s-zzz", 5), push("s-a", 100), act("wobble", "s-a", 110)]);
    expect(s.items["s-zzz"]).toBeUndefined();
    expect(s.items["s-a"].live).toBe(true);
  });

  test("origin of a push is kept", () => {
    const s = reduce([push("s-b", 100, "again", { origin: "s-a" })]);
    expect(s.items["s-b"].origin).toBe("s-a");
  });

  test("incremental apply equals reducing the whole log", () => {
    const log = [push("s-a", 1), push("s-b", 2), act("pop", "s-b", 3, { id: "p" }), act("void", "s-b", 4, { ref: "p" }), act("pop", "s-a", 5)];
    const s = emptyState();
    for (const a of log) apply(s, a);
    expect(s.items).toEqual(reduce(log).items);
  });
});

describe("reduce: notes and the Later queue", () => {
  test("a note, its text edit and its removal", () => {
    const s = reduce([act("note", "n-a", 100, { data: { text: "hello" } }), act("edit", "n-a", 110, { data: { text: "hi" } }), act("delete", "n-a", 120)]);
    expect(s.notes["n-a"]).toMatchObject({ id: "n-a", text: "hi", at: 100, ts: 100, removed: true });
  });

  test("a note's time can be edited through an action that points at it", () => {
    const note = act("note", "n-a", 100, { data: { text: "x" } });
    const s = reduce([note, act("edit", "n-a", 110, { ref: note.id, data: { at: 80 } })]);
    expect(s.notes["n-a"].at).toBe(80);
  });

  test("a queue row is later, then started or dropped, and can come back", () => {
    const s = reduce([act("later", "q-a", 100, { data: { text: "someday" } }), act("start", "q-a", 200)]);
    expect(s.queue["q-a"]).toMatchObject({ removed: true, started: true });
    apply(s, act("requeue", "q-a", 300));
    expect(s.queue["q-a"]).toMatchObject({ removed: false, started: false });
  });
});
