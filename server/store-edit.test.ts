// Editing the text and times of an existing item: the `edit` write, its event, the edited marker and the rules that
// keep an old client from undoing an edit.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, ValidationError, type Store } from "./store";

const T = 1_700_000_000_000;
const NOW = T + 100_000;
const open: Store[] = [];
const dirs: string[] = [];
const mk = () => {
  const store = openStore(":memory:", { now: () => NOW });
  open.push(store);
  return store;
};
afterEach(() => {
  while (open.length) open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
// A finished item: pushed at T, popped at T + 50 s.
const finished = (s: Store, id = "s-aaaa", text = "old") => {
  s.upsert(id, { text, ts: T, removed: false });
  return s.upsert(id, { text, ts: T, removed: true, at: T + 50_000 });
};

describe("edit writes", () => {
  test("change text, ts and the end time of a finished item, and set edited_at", () => {
    const s = mk();
    finished(s);
    const saved = s.upsert("s-aaaa", { text: "new", ts: T + 1000, removed: true, at: T + 20_000, edit: true });
    expect(saved).toMatchObject({ text: "new", ts: T + 1000, at: T + 20_000, removed: true, edited_at: NOW });
  });

  test("an item never edited has no edited_at key at all", () => {
    expect("edited_at" in finished(mk())).toBe(false);
  });

  test("logs one edit event with from/to for exactly the fields that changed; the push and pop events stay", () => {
    const s = mk();
    finished(s);
    s.upsert("s-aaaa", { text: "new", ts: T, removed: true, at: T + 20_000, edit: true });
    const log = s.log();
    expect(log.map((e) => e.op)).toEqual(["push", "pop", "edit"]);
    const edit = log[2];
    expect(edit).toMatchObject({ id: "s-aaaa", text: "new", ts: NOW, at: NOW });
    expect(JSON.parse(edit.detail!)).toEqual({ text: { from: "old", to: "new" }, at: { from: T + 50_000, to: T + 20_000 } });
    expect(log[0].detail).toBeUndefined(); // original rows are untouched
    expect(log[1]).toMatchObject({ op: "pop", at: T + 50_000 });
  });

  test("an edit that changes nothing logs nothing and leaves edited_at unset", () => {
    const s = mk();
    finished(s);
    const saved = s.upsert("s-aaaa", { text: "old", ts: T, removed: true, at: T + 50_000, edit: true });
    expect("edited_at" in saved).toBe(false);
    expect(s.log().length).toBe(2);
  });

  test("resending the same edit adds no second event", () => {
    const s = mk();
    finished(s);
    const e = { text: "new", ts: T, removed: true, at: T + 50_000, edit: true };
    s.upsert("s-aaaa", e);
    s.upsert("s-aaaa", e);
    expect(s.log().filter((x) => x.op === "edit").length).toBe(1);
  });

  test("a brand-new row ignores the marker: normal push, no edit event, no edited_at", () => {
    const s = mk();
    const saved = s.upsert("s-aaaa", { text: "x", ts: T, removed: false, edit: true });
    expect("edited_at" in saved).toBe(false);
    expect(s.log().map((e) => e.op)).toEqual(["push"]);
  });

  test("an edit sent together with a pop (offline: popped, then edited) pops and edits", () => {
    const s = mk();
    s.upsert("s-aaaa", { text: "old", ts: T, removed: false });
    const saved = s.upsert("s-aaaa", { text: "new", ts: T, removed: true, at: T + 30_000, edit: true });
    expect(saved).toMatchObject({ text: "new", removed: true, at: T + 30_000, edited_at: NOW });
    expect(s.log().map((e) => e.op)).toEqual(["push", "pop", "edit"]);
  });

  test("a backdated end is not held back by the previous-event floor", () => {
    const s = mk();
    finished(s);
    expect(s.upsert("s-aaaa", { text: "old", ts: T, removed: true, at: T + 1000, edit: true }).at).toBe(T + 1000);
  });

  test("the end of a live item is not editable: at is ignored, text and ts apply", () => {
    const s = mk();
    s.upsert("s-aaaa", { text: "old", ts: T, removed: false });
    const saved = s.upsert("s-aaaa", { text: "new", ts: T, removed: false, at: T + 5000, edit: true });
    expect(saved.at).toBe(T);
    expect(saved.text).toBe("new");
  });
});

describe("edit validation", () => {
  test("end before start is a ValidationError, nothing is written", () => {
    const s = mk();
    finished(s);
    expect(() => s.upsert("s-aaaa", { text: "old", ts: T, removed: true, at: T - 1, edit: true })).toThrow(ValidationError);
    expect(() => s.upsert("s-aaaa", { text: "old", ts: T + 60_000, removed: true, at: T + 50_000, edit: true })).toThrow(/before the start/);
    expect(s.since(0).items[0]).toMatchObject({ ts: T, at: T + 50_000 });
    expect(s.log().length).toBe(2);
  });

  test("a time well in the future is a ValidationError; a few minutes of clock skew is clamped", () => {
    const s = mk();
    finished(s);
    expect(() => s.upsert("s-aaaa", { text: "old", ts: T, removed: true, at: NOW + 3_600_000, edit: true })).toThrow(/future/);
    expect(() => s.upsert("s-aaaa", { text: "old", ts: NOW + 3_600_000, removed: false, edit: true })).toThrow(/future/);
    expect(s.upsert("s-aaaa", { text: "old", ts: T, removed: true, at: NOW + 60_000, edit: true }).at).toBe(NOW);
  });

  test("empty and over-long text are still rejected on an edit", () => {
    const s = mk();
    finished(s);
    expect(() => s.upsert("s-aaaa", { text: "  ", ts: T, removed: true, edit: true })).toThrow(ValidationError);
    expect(() => s.upsert("s-aaaa", { text: "x".repeat(201), ts: T, removed: true, edit: true })).toThrow(ValidationError);
  });
});

describe("old clients", () => {
  test("an unmarked resend of the old copy cannot undo an edit and gets the edited values back", () => {
    const s = mk();
    finished(s);
    s.upsert("s-aaaa", { text: "new", ts: T + 1000, removed: true, at: T + 20_000, edit: true });
    const stale = s.upsert("s-aaaa", { text: "old", ts: T, removed: true, at: T + 50_000 });
    expect(stale).toMatchObject({ text: "new", ts: T + 1000, at: T + 20_000, edited_at: NOW });
  });

  test("an unmarked restore keeps the edited text and ts, and a later pop keeps them too", () => {
    const s = mk();
    finished(s);
    s.upsert("s-aaaa", { text: "new", ts: T + 1000, removed: true, at: T + 20_000, edit: true });
    const restored = s.upsert("s-aaaa", { text: "old", ts: T, removed: false, at: T + 60_000 });
    expect(restored).toMatchObject({ text: "new", ts: T + 1000, removed: false, edited_at: NOW });
    const popped = s.upsert("s-aaaa", { text: "old", ts: T, removed: true, at: T + 70_000 });
    expect(popped).toMatchObject({ text: "new", ts: T + 1000, removed: true });
  });

  test("an unmarked write never clears edited_at", () => {
    const s = mk();
    finished(s);
    s.upsert("s-aaaa", { text: "new", ts: T, removed: true, edit: true });
    expect(s.upsert("s-aaaa", { text: "new", ts: T, removed: true }).edited_at).toBe(NOW);
  });

  test("pop and restore events written after an edit use the stored text", () => {
    const s = mk();
    finished(s);
    s.upsert("s-aaaa", { text: "new", ts: T, removed: true, edit: true });
    s.upsert("s-aaaa", { text: "old", ts: T, removed: false, at: T + 60_000 });
    expect(s.log().at(-1)).toMatchObject({ op: "restore", text: "new" });
  });
});

describe("migration", () => {
  test("a database from before editing gains edited_at and detail, keeps its rows, and can then be edited", () => {
    const dir = mkdtempSync(join(tmpdir(), "ist-edit-"));
    dirs.push(dir);
    const path = join(dir, "old.db");
    const old = new Database(path, { create: true });
    old.run("CREATE TABLE items (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, at INTEGER, removed INTEGER NOT NULL, origin TEXT, seq INTEGER NOT NULL)");
    old.run("CREATE TABLE events (n INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, at INTEGER NOT NULL, op TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL)");
    old.run("INSERT INTO items (id, text, ts, at, removed, seq) VALUES ('s-aaaa', 'kept', 1000, 2000, 1, 1)");
    old.run("INSERT INTO events (ts, at, op, id, text) VALUES (1000, 1000, 'push', 's-aaaa', 'kept')");
    old.close();
    const s = openStore(path, { now: () => NOW });
    open.push(s);
    expect(s.since(0).items[0]).toEqual({ id: "s-aaaa", text: "kept", ts: 1000, at: 2000, removed: true, seq: 1 });
    expect(s.log()).toEqual([{ n: 1, ts: 1000, at: 1000, op: "push", id: "s-aaaa", text: "kept" }]);
    const saved = s.upsert("s-aaaa", { text: "fixed", ts: 1000, removed: true, at: 2000, edit: true });
    expect(saved.edited_at).toBe(NOW);
    expect(s.log().at(-1)!.op).toBe("edit");
    // opening again (already migrated) is fine
    s.close();
    open.pop();
    const again = openStore(path, { now: () => NOW });
    open.push(again);
    expect(again.since(0).items[0].text).toBe("fixed");
  });
});
