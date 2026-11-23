// Deleting an entry: a `deleted` flag on a stack item (hidden everywhere, never counted), and for a note its
// tombstone. The event log stays append-only: a `delete` event, and an `undelete` event when it is undone.
import { afterEach, describe, expect, test } from "bun:test";
import { openStore, ValidationError, type Store } from "./store";

const T = 1_700_000_000_000;
const NOW = T + 100_000;
const open: Store[] = [];
const mk = () => {
  const store = openStore(":memory:", { now: () => NOW });
  open.push(store);
  return store;
};
afterEach(() => {
  while (open.length) open.pop()!.close();
});
const live = (s: Store, id = "s-aaaa", text = "oops") => s.upsert(id, { text, ts: T, removed: false });

describe("deleting a stack item", () => {
  test("the flag is saved, returned, and logs one delete event dated at the deletion", () => {
    const s = mk();
    live(s);
    const saved = s.upsert("s-aaaa", { text: "oops", ts: T, removed: false, deleted: true });
    expect(saved).toMatchObject({ deleted: true, removed: false });
    expect(s.log().map((e) => [e.op, e.id, e.text, e.at])).toEqual([["push", "s-aaaa", "oops", T], ["delete", "s-aaaa", "oops", NOW]]);
  });

  test("an item never deleted has no deleted key at all", () => {
    expect("deleted" in live(mk())).toBe(false);
  });

  test("a resend of the deleted state adds no event", () => {
    const s = mk();
    live(s);
    s.upsert("s-aaaa", { text: "oops", ts: T, removed: false, deleted: true });
    s.upsert("s-aaaa", { text: "oops", ts: T, removed: false, deleted: true });
    expect(s.log().filter((e) => e.op === "delete")).toHaveLength(1);
  });

  test("a write that leaves `deleted` out never clears it (a stale or older client)", () => {
    const s = mk();
    live(s);
    s.upsert("s-aaaa", { text: "oops", ts: T, removed: false, deleted: true });
    const saved = s.upsert("s-aaaa", { text: "oops", ts: T, removed: true, at: T + 5000 });
    expect(saved.deleted).toBe(true);
  });

  test("undo (deleted: false) clears it and logs undelete; the old events stay", () => {
    const s = mk();
    live(s);
    s.upsert("s-aaaa", { text: "oops", ts: T, removed: false, deleted: true });
    const saved = s.upsert("s-aaaa", { text: "oops", ts: T, removed: false, deleted: false });
    expect("deleted" in saved).toBe(false);
    expect(s.log().map((e) => e.op)).toEqual(["push", "delete", "undelete"]);
  });

  test("a new row that arrives already deleted logs push then delete", () => {
    const s = mk();
    s.upsert("s-aaaa", { text: "x", ts: T, removed: false, deleted: true });
    expect(s.log().map((e) => e.op)).toEqual(["push", "delete"]);
  });

  test("a deleted item is not counted as live or removed", () => {
    const s = mk();
    live(s, "s-aaaa");
    live(s, "s-bbbb", "kept");
    s.upsert("s-cccc", { text: "done", ts: T, removed: true, at: T + 10, deleted: true });
    s.upsert("s-aaaa", { text: "oops", ts: T, removed: false, deleted: true });
    expect(s.counts()).toEqual({ live: 1, removed: 0 });
  });

  test("deleted must be a boolean", () => {
    expect(() => mk().upsert("s-aaaa", { text: "x", ts: T, removed: false, deleted: "yes" as any })).toThrow(ValidationError);
  });

  test("it syncs: the row comes back with deleted set", () => {
    const s = mk();
    live(s);
    const r = s.sync(0, { items: { "s-aaaa": { text: "oops", ts: T, removed: false, deleted: true } } });
    expect(r.tables.items.rows[0]).toMatchObject({ id: "s-aaaa", deleted: true });
  });
});

describe("deleting a note", () => {
  const note = { text: "n", ts: T, removed: false };
  test("logs delete, and undelete when undone", () => {
    const s = mk();
    s.upsertNote("n-aaaa", note);
    s.upsertNote("n-aaaa", { ...note, removed: true });
    s.upsertNote("n-aaaa", { ...note, removed: false });
    expect(s.log().map((e) => e.op)).toEqual(["note", "delete", "undelete"]);
    expect(s.log()[1]).toMatchObject({ id: "n-aaaa", text: "n", at: NOW });
  });
});
