// Notes: short text entries with a time, kept apart from the stack. Own table on the shared sync counter, one `note`
// event when created, an `edit` event when changed, and no effect on the stack's counts.
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
const note = (text = "a note", ts = T) => ({ text, ts, removed: false });
const sync = (s: Store, cursor: number, changes: Record<string, unknown>) => s.sync(cursor, changes);

describe("notes on the sync channel", () => {
  test("a note is saved and comes back in rows, drawing from the shared counter", () => {
    const s = mk();
    s.upsert("s-aaaa", { text: "task", ts: T, removed: false });
    const r = sync(s, 0, { notes: { "n-aaaa": note("hello") } });
    expect(r.tables.notes.saved["n-aaaa"]).toMatchObject({ id: "n-aaaa", text: "hello", ts: T, removed: false, seq: 2 });
    expect(r.tables.notes.rows.map((x: any) => x.id)).toEqual(["n-aaaa"]);
    expect(r.cursor).toBe(2);
    expect(r.touched).toEqual(["notes"]);
  });

  test("a client that already has the cursor sees only newer notes", () => {
    const s = mk();
    sync(s, 0, { notes: { "n-aaaa": note() } });
    const r = sync(s, 1, { notes: { "n-bbbb": note("two") } });
    expect(r.tables.notes.rows.map((x: any) => x.id)).toEqual(["n-bbbb"]);
  });

  test("validation: empty text, over 200, bad id and bad ts are rejected per change", () => {
    const s = mk();
    const r = sync(s, 0, {
      notes: { "n-aaaa": note("   "), "n-bbbb": note("x".repeat(201)), "bad": note(), "n-cccc": { text: "t", ts: 1.5, removed: false }, "n-dddd": note("ok") },
    });
    expect(Object.keys(r.tables.notes.rejected).sort()).toEqual(["bad", "n-aaaa", "n-bbbb", "n-cccc"]);
    expect(Object.keys(r.tables.notes.saved)).toEqual(["n-dddd"]);
  });

  test("a stack id is not a note id", () => {
    const s = mk();
    expect(() => s.upsertNote("s-aaaa", note())).toThrow(ValidationError);
  });
});

describe("notes in the event log", () => {
  test("creating a note logs one `note` event with its text and time", () => {
    const s = mk();
    sync(s, 0, { notes: { "n-aaaa": note("hello", T) } });
    expect(s.log()).toEqual([{ n: 1, ts: NOW, at: T, op: "note", id: "n-aaaa", text: "hello" }]);
  });

  test("a resend of the same note adds nothing", () => {
    const s = mk();
    sync(s, 0, { notes: { "n-aaaa": note() } });
    sync(s, 0, { notes: { "n-aaaa": note() } });
    expect(s.log()).toHaveLength(1);
  });

  test("a note dated in the future is clamped to the server clock", () => {
    const s = mk();
    sync(s, 0, { notes: { "n-aaaa": note("x", NOW + 60_000) } });
    expect(s.log()[0].at).toBe(NOW);
  });

  test("notes add no push, pop or any other stack event, and leave the stack counts alone", () => {
    const s = mk();
    s.upsert("s-aaaa", { text: "task", ts: T, removed: false });
    sync(s, 0, { notes: { "n-aaaa": note() } });
    expect(s.log().map((e) => e.op)).toEqual(["push", "note"]);
    expect(s.counts()).toEqual({ live: 1, removed: 0 });
    expect(s.since(0).items.map((i) => i.id)).toEqual(["s-aaaa"]);
  });
});

describe("editing a note", () => {
  test("an edit changes text and time, sets edited_at and logs an edit event with detail", () => {
    const s = mk();
    sync(s, 0, { notes: { "n-aaaa": note("old", T) } });
    const r = sync(s, 0, { notes: { "n-aaaa": { text: "new", ts: T + 5000, removed: false, edit: true } } });
    expect(r.tables.notes.saved["n-aaaa"]).toMatchObject({ text: "new", ts: T + 5000, edited_at: NOW });
    const e = s.log()[1];
    expect(e).toMatchObject({ op: "edit", id: "n-aaaa", text: "new", at: NOW });
    expect(JSON.parse(e.detail!)).toEqual({ text: { from: "old", to: "new" }, ts: { from: T, to: T + 5000 } });
  });

  test("a write without edit keeps the stored text and time (a stale copy cannot undo an edit)", () => {
    const s = mk();
    sync(s, 0, { notes: { "n-aaaa": note("old", T) } });
    sync(s, 0, { notes: { "n-aaaa": { text: "new", ts: T + 5000, removed: false, edit: true } } });
    const r = sync(s, 0, { notes: { "n-aaaa": note("old", T) } });
    expect(r.tables.notes.saved["n-aaaa"]).toMatchObject({ text: "new", ts: T + 5000 });
    expect(s.log()).toHaveLength(2);
  });

  test("an edit with no real change logs nothing and leaves edited_at off", () => {
    const s = mk();
    sync(s, 0, { notes: { "n-aaaa": note("same", T) } });
    const r = sync(s, 0, { notes: { "n-aaaa": { text: "same", ts: T, removed: false, edit: true } } });
    expect("edited_at" in r.tables.notes.saved["n-aaaa"]).toBe(false);
    expect(s.log()).toHaveLength(1);
  });

  test("a time more than a few minutes in the future is refused; a little ahead is clamped", () => {
    const s = mk();
    sync(s, 0, { notes: { "n-aaaa": note() } });
    const far = sync(s, 0, { notes: { "n-aaaa": { text: "x", ts: NOW + 10 * 60_000, removed: false, edit: true } } });
    expect(far.tables.notes.rejected["n-aaaa"].error).toMatch(/future/);
    const near = sync(s, 0, { notes: { "n-aaaa": { text: "x", ts: NOW + 60_000, removed: false, edit: true } } });
    expect(near.tables.notes.saved["n-aaaa"].ts).toBe(NOW);
  });

  test("removing a note keeps a tombstone that syncs, and logs nothing more", () => {
    const s = mk();
    sync(s, 0, { notes: { "n-aaaa": note() } });
    const r = sync(s, 1, { notes: { "n-aaaa": { text: "a note", ts: T, removed: true } } });
    expect(r.tables.notes.rows[0]).toMatchObject({ id: "n-aaaa", removed: true });
    expect(s.log()).toHaveLength(1);
  });
});
