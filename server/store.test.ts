import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, ValidationError, type Store } from "./store";

const open: Store[] = [];
const mem = () => {
  const s = openStore(":memory:");
  open.push(s);
  return s;
};
afterEach(() => {
  while (open.length) open.pop()!.close();
});

const input = (text = "task", ts = 1000, removed = false) => ({ text, ts, removed });

describe("store", () => {
  test("upsert creates a row with seq 1", () => {
    const item = mem().upsert("s-aaaa", input("write plan", 5));
    expect(item).toEqual({ id: "s-aaaa", text: "write plan", ts: 5, at: 5, removed: false, seq: 1 });
  });

  test("second upsert of another id gets seq 2", () => {
    const s = mem();
    s.upsert("s-aaaa", input());
    expect(s.upsert("s-bbbb", input()).seq).toBe(2);
  });

  test("upsert of the same id with identical input still bumps seq and keeps one row", () => {
    const s = mem();
    s.upsert("s-aaaa", input());
    const again = s.upsert("s-aaaa", input());
    expect(again.seq).toBe(2);
    expect(s.since(0).items).toHaveLength(1);
  });

  test("removed true then false round-trips", () => {
    const s = mem();
    s.upsert("s-aaaa", input());
    expect(s.upsert("s-aaaa", input("task", 1000, true)).removed).toBe(true);
    expect(s.upsert("s-aaaa", input("task", 1000, false)).removed).toBe(false);
    expect(s.since(0).items[0].removed).toBe(false);
  });

  test("since(0) returns all rows including removed", () => {
    const s = mem();
    s.upsert("s-aaaa", input("a", 1, true));
    s.upsert("s-bbbb", input("b", 2));
    const r = s.since(0);
    expect(r.items.map((i) => i.id)).toEqual(["s-aaaa", "s-bbbb"]);
    expect(r.seq).toBe(2);
  });

  test("since(n) returns only later rows ascending", () => {
    const s = mem();
    s.upsert("s-aaaa", input());
    s.upsert("s-bbbb", input());
    s.upsert("s-cccc", input());
    s.upsert("s-aaaa", input("changed"));
    const r = s.since(2);
    expect(r.items.map((i) => [i.id, i.seq])).toEqual([
      ["s-cccc", 3],
      ["s-aaaa", 4],
    ]);
    expect(r.seq).toBe(4);
  });

  test("since on empty store returns seq 0 and no items", () => {
    expect(mem().since(0)).toEqual({ seq: 0, items: [] });
  });

  test("text is trimmed before storing", () => {
    expect(mem().upsert("s-aaaa", input("  hello  ")).text).toBe("hello");
  });

  test("rejects whitespace-only text", () => {
    expect(() => mem().upsert("s-aaaa", input("   \n "))).toThrow(ValidationError);
  });

  test("accepts 200 characters and rejects 201", () => {
    const s = mem();
    expect(s.upsert("s-aaaa", input("x".repeat(200))).text).toHaveLength(200);
    expect(() => s.upsert("s-bbbb", input("x".repeat(201)))).toThrow(ValidationError);
  });

  test("stores emoji text unchanged", () => {
    const text = "ship it 🚀 café 日本語";
    const s = mem();
    s.upsert("s-aaaa", input(text));
    expect(s.since(0).items[0].text).toBe(text);
  });

  test('rejects id "../x"', () => {
    expect(() => mem().upsert("../x", input())).toThrow(ValidationError);
  });

  test("rejects non-integer ts", () => {
    const s = mem();
    expect(() => s.upsert("s-aaaa", input("t", 1.5))).toThrow(ValidationError);
    expect(() => s.upsert("s-aaaa", input("t", NaN))).toThrow(ValidationError);
  });

  test("data persists across close and reopen of a file database", () => {
    const dir = mkdtempSync(join(tmpdir(), "ist-"));
    try {
      const path = join(dir, "stack.db");
      const a = openStore(path);
      a.upsert("s-aaaa", input("kept", 9));
      a.close();
      const b = openStore(path);
      expect(b.since(0).items[0]).toMatchObject({ id: "s-aaaa", text: "kept", seq: 1 });
      expect(b.upsert("s-bbbb", input()).seq).toBe(2);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("counts reports live and removed items separately", () => {
    const s = mem();
    expect(s.counts()).toEqual({ live: 0, removed: 0 });
    s.upsert("s-aaaa", input("a"));
    s.upsert("s-bbbb", input("b"));
    s.upsert("s-cccc", input("c", 3, true));
    s.upsert("s-bbbb", input("b", 2, true));
    expect(s.counts()).toEqual({ live: 1, removed: 2 });
  });

  test("epoch is stable for one database and differs between databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "ist-epoch-"));
    try {
      const path = join(dir, "stack.db");
      const a = openStore(path);
      const epoch = a.epoch;
      a.close();
      const b = openStore(path);
      expect(b.epoch).toBe(epoch);
      b.close();
      expect(epoch).toMatch(/^[0-9a-f-]{16,}$/);
      expect(mem().epoch).not.toBe(epoch);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("event log", () => {
  const clocked = (t: { now: number }) => {
    const s = openStore(":memory:", { now: () => t.now });
    open.push(s);
    return s;
  };
  const ops = (s: Store) => s.log().map((e) => [e.op, e.id]);

  test("a new live item logs one push, at its own ts when no at is sent", () => {
    const t = { now: 9000 };
    const s = clocked(t);
    s.upsert("s-aaaa", input("write plan", 5000));
    expect(s.log()).toEqual([{ n: 1, ts: 9000, at: 5000, op: "push", id: "s-aaaa", text: "write plan" }]);
  });

  test("a new item that arrives already removed logs a push then a pop", () => {
    const s = clocked({ now: 9000 });
    s.upsert("s-aaaa", { text: "quick", ts: 4000, removed: true, at: 6000 });
    expect(s.log().map((e) => [e.op, e.at])).toEqual([
      ["push", 4000],
      ["pop", 6000],
    ]);
  });

  test("live to removed logs a pop and removed to live logs a restore, with the device's at", () => {
    const s = clocked({ now: 9000 });
    s.upsert("s-aaaa", input("task", 1000));
    s.upsert("s-aaaa", { text: "task", ts: 1000, removed: true, at: 2000 });
    s.upsert("s-aaaa", { text: "task", ts: 1000, removed: false, at: 3000 });
    expect(s.log().map((e) => [e.op, e.at])).toEqual([
      ["push", 1000],
      ["pop", 2000],
      ["restore", 3000],
    ]);
  });

  test("resending the same state logs nothing more", () => {
    const s = clocked({ now: 9000 });
    s.upsert("s-aaaa", input("task", 1000));
    s.upsert("s-aaaa", input("task", 1000));
    s.upsert("s-aaaa", { text: "task", ts: 1000, removed: true, at: 2000 });
    s.upsert("s-aaaa", { text: "task", ts: 1000, removed: true, at: 2500 });
    expect(ops(s)).toEqual([
      ["push", "s-aaaa"],
      ["pop", "s-aaaa"],
    ]);
  });

  test("a missing at on a pop falls back to the server clock", () => {
    const t = { now: 9000 };
    const s = clocked(t);
    s.upsert("s-aaaa", input("task", 1000));
    t.now = 9500;
    s.upsert("s-aaaa", input("task", 1000, true));
    expect(s.log()[1]).toMatchObject({ op: "pop", ts: 9500, at: 9500 });
  });

  test("an at later than the server clock is clamped to it, not rejected", () => {
    const s = clocked({ now: 9000 });
    s.upsert("s-aaaa", { text: "task", ts: 1000, removed: false, at: 99_000_000 });
    s.upsert("s-aaaa", { text: "task", ts: 1000, removed: true, at: 99_000_000 });
    expect(s.log().map((e) => [e.op, e.at])).toEqual([
      ["push", 1000],
      ["pop", 9000],
    ]);
  });

  test("a non-integer at is rejected", () => {
    const s = clocked({ now: 9000 });
    expect(() => s.upsert("s-aaaa", { text: "t", ts: 1, removed: false, at: 1.5 })).toThrow(ValidationError);
    expect(() => s.upsert("s-aaaa", { text: "t", ts: 1, removed: false, at: "x" as any })).toThrow(ValidationError);
    expect(s.log()).toEqual([]);
  });

  test("the item carries its at, defaulting to ts", () => {
    const s = clocked({ now: 9000 });
    expect(s.upsert("s-aaaa", input("task", 1000)).at).toBe(1000);
    expect(s.upsert("s-aaaa", { text: "task", ts: 1000, removed: true, at: 2000 }).at).toBe(2000);
  });

  test("a stale resend after another device's pop never logs an event dated before that pop", () => {
    // Phone A's push reached the server but the response was lost; desktop B popped it; A then retries its old state.
    const s = clocked({ now: 9000 });
    s.upsert("s-aaaa", { text: "task", ts: 500, removed: false, at: 500 });
    s.upsert("s-aaaa", { text: "task", ts: 500, removed: true, at: 1900 });
    s.upsert("s-aaaa", { text: "task", ts: 500, removed: false, at: 500 });
    expect(s.log().map((e) => [e.op, e.at])).toEqual([
      ["push", 500],
      ["pop", 1900],
      ["restore", 1900],
    ]);
    expect(s.since(0).items[0].at).toBe(1900);
  });

  test("an item resent to a fresh database is logged as pushed at its own ts, whatever its later history", () => {
    const s = clocked({ now: 9000 });
    const item = s.upsert("s-aaaa", { text: "task", ts: 100, removed: false, at: 800 }); // pushed, popped, restored
    expect(s.log().map((e) => [e.op, e.at])).toEqual([["push", 100]]);
    expect(item.at).toBe(800);
  });

  test("a resend with the same state but new text or ts logs nothing and keeps the stored at", () => {
    const s = clocked({ now: 9000 });
    s.upsert("s-aaaa", input("task", 1000));
    const again = s.upsert("s-aaaa", { text: "changed", ts: 2000, removed: false, at: 5000 });
    expect(s.log()).toHaveLength(1);
    expect(again.at).toBe(1000);
  });

  test("events survive close and reopen of a file database", () => {
    const dir = mkdtempSync(join(tmpdir(), "ist-log-"));
    try {
      const path = join(dir, "stack.db");
      const a = openStore(path);
      a.upsert("s-aaaa", input("kept", 1000));
      a.close();
      const b = openStore(path);
      expect(b.log().map((e) => e.op)).toEqual(["push"]);
      b.upsert("s-aaaa", input("kept", 1000, true));
      expect(b.log().map((e) => [e.n, e.op])).toEqual([
        [1, "push"],
        [2, "pop"],
      ]);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a database created before the event log opens, keeps its items, and starts an empty log", () => {
    const dir = mkdtempSync(join(tmpdir(), "ist-old-"));
    try {
      const path = join(dir, "stack.db");
      const old = new Database(path, { create: true });
      old.run(
        "CREATE TABLE items (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, removed INTEGER NOT NULL, seq INTEGER NOT NULL)",
      );
      old.run("INSERT INTO items VALUES ('s-aaaa', 'from before', 700, 0, 1)");
      old.close();
      const s = openStore(path);
      expect(s.since(0).items).toEqual([{ id: "s-aaaa", text: "from before", ts: 700, at: 700, removed: false, seq: 1 }]);
      expect(s.log()).toEqual([]);
      expect(s.upsert("s-aaaa", input("from before", 700)).at).toBe(700); // same state, old row with a null at
      expect(s.log()).toEqual([]);
      s.upsert("s-aaaa", input("from before", 700, true));
      expect(ops(s)).toEqual([["pop", "s-aaaa"]]);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("queue store", () => {
  const q = (text = "later", ts = 1000, removed = false, started = false) => ({ text, ts, removed, started });
  const clocked = (t: { now: number }) => {
    const s = openStore(":memory:", { now: () => t.now });
    open.push(s);
    return s;
  };
  const ops = (s: Store) => s.log().map((e) => [e.op, e.id]);

  test("queue rows are separate from stack items, with their own seq", () => {
    const s = mem();
    s.upsert("s-aaaa", input());
    const row = s.upsertQueue("q-aaaa", q("later", 5));
    expect(row).toEqual({ id: "q-aaaa", text: "later", ts: 5, at: 5, removed: false, started: false, seq: 1 });
    expect(s.since(0).items.map((i) => i.id)).toEqual(["s-aaaa"]);
    expect(s.queueSince(0)).toEqual({ seq: 1, items: [row] });
    expect(s.queueSince(1).items).toEqual([]);
  });

  test("a queue id must look like q-...; stack ids are refused", () => {
    expect(() => mem().upsertQueue("s-aaaa", q())).toThrow(ValidationError);
    expect(() => mem().upsertQueue("q-!", q())).toThrow(ValidationError);
    expect(() => mem().upsert("q-aaaa", input())).toThrow(ValidationError);
    expect(() => mem().upsertQueue("q-aaaa", { ...q(), started: "yes" as any })).toThrow(ValidationError);
    expect(() => mem().upsertQueue("q-aaaa", q(" "))).toThrow(ValidationError);
  });

  test("queue events: queue, dequeue (drop), requeue (undo), start", () => {
    const t = { now: 9000 };
    const s = clocked(t);
    s.upsertQueue("q-aaaa", q("a", 1000));
    s.upsertQueue("q-aaaa", q("a", 1000)); // retry: nothing new
    t.now = 9100;
    s.upsertQueue("q-aaaa", { ...q("a", 1000, true), at: 9100 });
    t.now = 9200;
    s.upsertQueue("q-aaaa", { ...q("a", 1000, false), at: 9200 });
    s.upsertQueue("q-bbbb", q("b", 2000));
    t.now = 9300;
    s.upsertQueue("q-bbbb", { ...q("b", 2000, true, true), at: 9300 });
    expect(ops(s)).toEqual([
      ["queue", "q-aaaa"],
      ["dequeue", "q-aaaa"],
      ["requeue", "q-aaaa"],
      ["queue", "q-bbbb"],
      ["start", "q-bbbb"],
    ]);
    expect(s.log().map((e) => e.at)).toEqual([1000, 9100, 9200, 2000, 9300]);
  });

  test("a row first seen already dropped logs queue then dequeue; started logs queue then start", () => {
    const s = clocked({ now: 9000 });
    s.upsertQueue("q-aaaa", q("a", 1000, true));
    s.upsertQueue("q-bbbb", q("b", 1000, true, true));
    expect(ops(s)).toEqual([["queue", "q-aaaa"], ["dequeue", "q-aaaa"], ["queue", "q-bbbb"], ["start", "q-bbbb"]]);
  });

  test("queue counts and stack counts are independent", () => {
    const s = mem();
    s.upsert("s-aaaa", input());
    s.upsertQueue("q-aaaa", q());
    s.upsertQueue("q-bbbb", q("b", 1, true));
    expect(s.counts()).toEqual({ live: 1, removed: 0 });
    expect(s.queueCounts()).toEqual({ queued: 1, removed: 1 });
  });

  test("opening a database that already has an items.queued column still works", () => {
    const dir = mkdtempSync(join(tmpdir(), "ist-q-"));
    const path = join(dir, "x.db");
    const raw = new Database(path);
    raw.run("CREATE TABLE items (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, at INTEGER, removed INTEGER NOT NULL, queued INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL)");
    raw.run("INSERT INTO items VALUES ('s-aaaa','old',1,1,0,0,1)");
    raw.close();
    const s = openStore(path);
    expect(s.since(0).items.map((i) => i.text)).toEqual(["old"]);
    expect(s.since(0).items[0]).not.toHaveProperty("queued");
    s.upsert("s-bbbb", input());
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
