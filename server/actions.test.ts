import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "./store";

const open: Store[] = [];
const dirs: string[] = [];
const mem = (now?: () => number) => {
  const s = openStore(":memory:", now ? { now } : {});
  open.push(s);
  return s;
};
afterEach(() => {
  while (open.length) open.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The reducer's view must agree with what the old row tables say, for every item. */
function expectAgrees(s: Store) {
  const st = s.state() as any;
  for (const row of s.since(0).items) {
    const it = st.items[row.id];
    expect(it, row.id).toBeDefined();
    expect(it.text).toBe(row.text);
    expect(it.live).toBe(!row.removed);
    expect(it.deleted).toBe(row.deleted === true);
    const last = it.intervals[it.intervals.length - 1];
    expect(last.start.at).toBe(row.ts);
    if (row.removed) expect(last.end.at).toBe(Math.max(row.at, row.ts));
  }
  expect(Object.keys(st.items).sort()).toEqual(s.since(0).items.map((r) => r.id).sort());
}

describe("actions are written alongside the old rows", () => {
  test("push, pop and undo", () => {
    let t = 1000;
    const s = mem(() => t);
    s.upsert("s-aaaa", { text: "write", ts: 1000, removed: false });
    t = 2000;
    s.upsert("s-aaaa", { text: "write", ts: 1000, removed: true, at: 2000 });
    expectAgrees(s);
    t = 3000;
    s.upsert("s-aaaa", { text: "write", ts: 1000, removed: false, at: 3000 }); // the app's undo
    expectAgrees(s);
    const kinds = s.actions().map((a) => a.kind);
    expect(kinds).toEqual(["push", "pop", "void"]);
    expect((s.state() as any).items["s-aaaa"].intervals).toHaveLength(1);
  });

  test("every action carries the server time and the person's time, and the person's time is never later", () => {
    const s = mem(() => 5000);
    s.upsert("s-aaaa", { text: "x", ts: 1000, removed: true, at: 9999 }); // a device clock ahead of the server
    for (const a of s.actions()) {
      expect(a.ts).toBe(5000);
      expect(a.at).toBeLessThanOrEqual(a.ts);
    }
  });

  test("an edit becomes edit actions that point at the push and pop, and the originals stay", () => {
    let t = 1000;
    const s = mem(() => t);
    s.upsert("s-aaaa", { text: "old", ts: 1000, removed: false });
    t = 2000;
    s.upsert("s-aaaa", { text: "old", ts: 1000, removed: true, at: 2000 });
    t = 3000;
    s.upsert("s-aaaa", { text: "new", ts: 900, removed: true, at: 2100, edit: true });
    expectAgrees(s);
    const acts = s.actions();
    expect(acts.filter((a) => a.kind === "edit")).toHaveLength(3);
    const push = acts.find((a) => a.kind === "push")!;
    expect(push.at).toBe(1000); // never rewritten
    expect((s.state() as any).items["s-aaaa"].intervals[0].start.at).toBe(900);
  });

  test("delete and undelete, notes and the Later queue", () => {
    let t = 1000;
    const s = mem(() => t);
    s.upsert("s-aaaa", { text: "x", ts: 1000, removed: false });
    t = 1100;
    s.upsert("s-aaaa", { text: "x", ts: 1000, removed: false, deleted: true });
    s.upsertNote("n-aaaa", { text: "a note", ts: 1100 });
    s.upsertQueue("q-aaaa", { text: "later", ts: 1100, removed: false });
    t = 1200;
    s.upsertQueue("q-aaaa", { text: "later", ts: 1100, removed: true, started: true, at: 1200 });
    const st = s.state() as any;
    expect(st.items["s-aaaa"].deleted).toBe(true);
    expect(st.notes["n-aaaa"]).toMatchObject({ text: "a note", removed: false });
    expect(st.queue["q-aaaa"]).toMatchObject({ removed: true, started: true });
    expectAgrees(s);
  });

  test("a push-then-pop from a device whose clock is ahead no longer reads as impossible", () => {
    const s = mem(() => 2000);
    s.upsert("s-aaaa", { text: "x", ts: 2500, removed: true, at: 2300 }); // sent ahead of the server's clock
    const it = (s.state() as any).items["s-aaaa"];
    expect(it.intervals[0].end.at).toBeGreaterThanOrEqual(it.intervals[0].start.at);
  });

  test("resent actions are ignored (the same id twice)", () => {
    const s = mem(() => 1000);
    s.upsert("s-aaaa", { text: "x", ts: 1000, removed: false });
    const before = s.actions().length;
    s.upsert("s-aaaa", { text: "x", ts: 1000, removed: false }); // nothing changed: nothing is logged
    expect(s.actions().length).toBe(before);
  });
});

describe("migration 1: the existing database becomes an actions log", () => {
  function legacy(path: string) {
    const d = new Database(path, { create: true });
    d.run("CREATE TABLE items (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, at INTEGER, removed INTEGER NOT NULL, seq INTEGER NOT NULL)");
    d.run("ALTER TABLE items ADD COLUMN origin TEXT");
    d.run("ALTER TABLE items ADD COLUMN edited_at INTEGER");
    d.run("ALTER TABLE items ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
    d.run("CREATE TABLE events (n INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, at INTEGER NOT NULL, op TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, detail TEXT)");
    d.run("CREATE TABLE queue (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, at INTEGER NOT NULL, removed INTEGER NOT NULL, started INTEGER NOT NULL, seq INTEGER NOT NULL)");
    d.run("CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, removed INTEGER NOT NULL, seq INTEGER NOT NULL, edited_at INTEGER)");
    const item = (id: string, text: string, ts: number, at: number | null, removed: number, seq: number, origin: string | null = null, deleted = 0) =>
      d.run("INSERT INTO items (id, text, ts, at, removed, seq, origin, deleted) VALUES (?,?,?,?,?,?,?,?)", [id, text, ts, at, removed, seq, origin, deleted]);
    const ev = (ts: number, at: number, op: string, id: string, text: string, detail: string | null = null) =>
      d.run("INSERT INTO events (ts, at, op, id, text, detail) VALUES (?,?,?,?,?,?)", [ts, at, op, id, text, detail]);
    item("s-aaaa", "done", 1000, 2000, 1, 1);
    ev(1000, 1000, "push", "s-aaaa", "done");
    ev(2000, 2000, "pop", "s-aaaa", "done");
    item("s-bbbb", "again", 3000, 3000, 0, 2, "s-aaaa");
    ev(3000, 3000, "push", "s-bbbb", "again");
    item("s-cccc", "ancient", 500, null, 1, 3); // older than the event log: no events, no end time
    item("s-dddd", "undone", 4000, 4500, 0, 4);
    ev(4000, 4000, "push", "s-dddd", "undone");
    ev(4400, 4400, "pop", "s-dddd", "undone");
    ev(4500, 4500, "restore", "s-dddd", "undone");
    item("s-eeee", "renamed", 900, 2100, 1, 5);
    ev(1000, 1000, "push", "s-eeee", "old name");
    ev(2000, 2000, "pop", "s-eeee", "old name");
    ev(3000, 3000, "edit", "s-eeee", "renamed", JSON.stringify({ text: { from: "old name", to: "renamed" }, ts: { from: 1000, to: 900 }, at: { from: 2000, to: 2100 } }));
    item("s-ffff", "gone", 6000, 6000, 0, 6, null, 1);
    ev(6000, 6000, "push", "s-ffff", "gone");
    ev(6100, 6100, "delete", "s-ffff", "gone");
    d.run("INSERT INTO notes (id, text, ts, removed, seq) VALUES ('n-aaaa', 'a note', 7000, 0, 7)");
    ev(7000, 7000, "note", "n-aaaa", "a note");
    d.run("INSERT INTO notes (id, text, ts, removed, seq) VALUES ('n-bbbb', 'old note', 100, 1, 8)");
    d.run("INSERT INTO queue (id, text, ts, at, removed, started, seq) VALUES ('q-aaaa', 'later', 8000, 8100, 1, 1, 9)");
    ev(8000, 8000, "queue", "q-aaaa", "later");
    ev(8100, 8100, "start", "q-aaaa", "later");
    d.run("INSERT INTO queue (id, text, ts, at, removed, started, seq) VALUES ('q-bbbb', 'older', 50, 50, 0, 0, 10)");
    d.close();
  }

  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), "actions-"));
    dirs.push(dir);
    const path = join(dir, "stack.db");
    legacy(path);
    return path;
  };

  test("every row ends up explained by actions, and the reducer agrees with the old tables", () => {
    const path = fixture();
    const s = openStore(path);
    open.push(s);
    const st = s.state() as any;
    expectAgrees(s);
    expect(st.items["s-aaaa"].intervals[0]).toMatchObject({ start: { at: 1000 }, end: { at: 2000, kind: "pop" } });
    expect(st.items["s-bbbb"]).toMatchObject({ live: true, origin: "s-aaaa" });
    expect(st.items["s-cccc"].live).toBe(false); // synthesised
    expect(st.items["s-dddd"]).toMatchObject({ live: true }); // the old restore is an undo: a void of the pop
    expect(st.items["s-dddd"].intervals).toHaveLength(1);
    expect(st.items["s-eeee"].text).toBe("renamed");
    expect(st.items["s-eeee"].intervals[0]).toMatchObject({ start: { at: 900 }, end: { at: 2100 } });
    expect(st.items["s-ffff"].deleted).toBe(true);
    expect(st.notes["n-aaaa"].text).toBe("a note");
    expect(st.notes["n-bbbb"].removed).toBe(true);
    expect(st.queue["q-aaaa"]).toMatchObject({ removed: true, started: true });
    expect(st.queue["q-bbbb"]).toMatchObject({ removed: false });
  });

  test("rows older than the event log are marked as guesses", () => {
    const s = openStore(fixture());
    open.push(s);
    const synth = s.actions().filter((a) => a.data?.synth);
    expect(synth.map((a) => a.id)).toContain("syn-s-cccc-push");
    expect(synth.every((a) => a.ts === a.at)).toBe(true);
  });

  test("the original edit times are still in the log; the edit is a later action", () => {
    const s = openStore(fixture());
    open.push(s);
    const acts = s.actions().filter((a) => a.target === "s-eeee");
    expect(acts.find((a) => a.kind === "push")!.at).toBe(1000);
    expect(acts.find((a) => a.kind === "pop")!.at).toBe(2000);
    expect(acts.filter((a) => a.kind === "edit")).toHaveLength(3);
  });

  test("a copy is taken first, and reopening neither converts again nor changes anything", () => {
    const path = fixture();
    const first = openStore(path);
    const actions = first.actions();
    first.close();
    expect(existsSync(`${path}.pre-actions`)).toBe(true);
    expect(new Database(path).query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    const second = openStore(path);
    open.push(second);
    expect(second.actions()).toEqual(actions);
  });

  test("a new empty database starts at version 1 with no copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "actions-"));
    dirs.push(dir);
    const path = join(dir, "stack.db");
    const s = openStore(path);
    open.push(s);
    expect(s.actions()).toEqual([]);
    expect(existsSync(`${path}.pre-actions`)).toBe(false);
  });
});

describe("old behaviour is unchanged", () => {
  test("the rows and events the old wire serves are exactly as before", () => {
    const s = mem(() => 1000);
    s.upsert("s-aaaa", { text: "x", ts: 1000, removed: false });
    expect(s.since(0).items).toEqual([{ id: "s-aaaa", text: "x", ts: 1000, at: 1000, removed: false, seq: 1 }]);
    expect(s.log().map((e) => e.op)).toEqual(["push"]);
  });
});

describe("the actions wire (syncActions)", () => {
  const act = (id: string, kind: string, target: string, at: number, extra: Record<string, unknown> = {}) => ({ id, kind, target, at, ...extra });

  test("stores what a device sends, stamps ts, clamps at, and answers with every action above the cursor", () => {
    const s = mem(() => 5000);
    const r = s.syncActions(0, [act("a-one1", "push", "s-aaaa", 4000, { data: { text: "write" } }), act("a-two2", "pop", "s-aaaa", 9000)]);
    expect(r.rejected).toEqual({});
    expect(r.actions.map((a) => [a.id, a.ts, a.at])).toEqual([["a-one1", 5000, 4000], ["a-two2", 5000, 5000]]); // the second at was ahead of the server
    expect(r.cursor).toBe(2);
    expect(r.more).toBe(false);
    expect(s.syncActions(2, []).actions).toEqual([]);
  });

  test("a resend of the same ids changes nothing", () => {
    const s = mem(() => 5000);
    const batch = [act("a-one1", "push", "s-aaaa", 4000, { data: { text: "write" } })];
    s.syncActions(0, batch);
    const again = s.syncActions(0, batch);
    expect(again.actions).toHaveLength(1);
    expect(s.actions()).toHaveLength(1);
  });

  test("the old row tables follow, so the old wire sees the same data", () => {
    let t = 5000;
    const s = mem(() => t);
    s.syncActions(0, [act("a-one1", "push", "s-aaaa", 4000, { data: { text: "write" } })]);
    expect(s.since(0).items).toMatchObject([{ id: "s-aaaa", text: "write", ts: 4000, removed: false }]);
    t = 6000;
    s.syncActions(0, [act("a-two2", "pop", "s-aaaa", 5500)]);
    expect(s.since(0).items[0]).toMatchObject({ removed: true, at: 5500 });
    s.syncActions(0, [act("a-vo13", "void", "s-aaaa", 5800, { ref: "a-two2" })]); // the undo
    expect(s.since(0).items[0]).toMatchObject({ removed: false });
    s.syncActions(0, [act("a-del4", "delete", "s-aaaa", 5900)]);
    expect(s.since(0).items[0]).toMatchObject({ deleted: true });
    s.syncActions(0, [act("a-nt15", "note", "n-aaaa", 5000, { data: { text: "hi" } }), act("a-lt16", "later", "q-aaaa", 5000, { data: { text: "someday" } })]);
    expect(s.upsertNote("n-aaaa", { text: "hi", ts: 5000 })).toMatchObject({ text: "hi", removed: false });
    expect(s.queueSince(0).items[0]).toMatchObject({ id: "q-aaaa", removed: false });
  });

  test("edits point at the action they correct, and the original stays", () => {
    const s = mem(() => 9000);
    s.syncActions(0, [act("a-one1", "push", "s-aaaa", 1000, { data: { text: "x" } }), act("a-two2", "pop", "s-aaaa", 2000), act("a-ed13", "edit", "s-aaaa", 8000, { ref: "a-two2", data: { at: 2500 } })]);
    expect(s.since(0).items[0]).toMatchObject({ ts: 1000, at: 2500, removed: true });
    expect(s.actions().find((a) => a.id === "a-two2")!.at).toBe(2000);
  });

  test("a malformed action is refused by id and the rest of the batch still lands", () => {
    const s = mem(() => 5000);
    const r = s.syncActions(0, [act("a-bad1", "wobble", "s-aaaa", 1), act("a-bad2", "push", "s-aaaa", 1, { data: { text: "" } }), act("a-ok13", "push", "s-bbbb", 1, { data: { text: "fine" } }), act("a-bad4", "edit", "s-bbbb", 1, { data: { at: 99999999 }, ref: "a-ok13" })]);
    expect(Object.keys(r.rejected).sort()).toEqual(["a-bad1", "a-bad2", "a-bad4"]);
    expect(r.actions.map((a) => a.id)).toEqual(["a-ok13"]);
  });

  test("every device gets the others' actions back, in order", () => {
    const s = mem(() => 5000);
    s.syncActions(0, [act("a-dev11", "push", "s-aaaa", 1000, { data: { text: "from one" } })]);
    const two = s.syncActions(0, [act("a-dev21", "push", "s-bbbb", 1100, { data: { text: "from two" } })]);
    expect(two.actions.map((a) => a.id)).toEqual(["a-dev11", "a-dev21"]);
  });
});
