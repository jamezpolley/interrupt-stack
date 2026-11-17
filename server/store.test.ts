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
    expect(item).toEqual({ id: "s-aaaa", text: "write plan", ts: 5, removed: false, seq: 1 });
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
