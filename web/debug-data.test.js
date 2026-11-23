import { describe, expect, test } from "bun:test";
import { buildDebugData, localIso, readStorage } from "./debug-data.js";

const loaded = (items, extra = {}) => ({ items, meta: { dirty: [], cursor: 0, epoch: null, ...extra } });
const NOW = Date.UTC(2026, 10, 23, 3, 4, 5, 678);

describe("localIso", () => {
  test("shows local time with the offset", () => {
    expect(localIso(NOW, -660)).toBe("2026-11-23T14:04:05.678+11:00");
    expect(localIso(NOW, 0)).toBe("2026-11-23T03:04:05.678+00:00");
    expect(localIso(NOW, 210)).toBe("2026-11-22T23:34:05.678-03:30");
  });
});

describe("buildDebugData", () => {
  const stackItem = { id: "s-aaaa", text: "task", ts: 1700000000000, at: 1700000001000, removed: true, seq: 3, origin: "s-bbbb" };
  const doc = (over = {}) =>
    buildDebugData({
      now: NOW,
      offsetMinutes: -660,
      version: "abc123 (main)",
      mode: "server",
      db: {
        stack: loaded([stackItem], { dirty: ["s-aaaa"], cursor: 7, epoch: "e1" }),
        queue: loaded([{ id: "q-aaaa", text: "later", ts: 5, at: 5, removed: false, started: false, seq: 1 }]),
        notes: loaded([{ id: "n-aaaa", text: "a note", ts: 9, removed: false, seq: 2 }], { cursor: 7, epoch: "e1" }),
      },
      ...over,
    });

  test("has the header fields", () => {
    const d = doc();
    expect(d.generated).toBe("2026-11-23T14:04:05.678+11:00");
    expect(d.version).toBe("abc123 (main)");
    expect(d.mode).toBe("server");
  });

  test("rows are the stored ones, untouched, with ms timestamps; meta holds dirty, cursor, epoch", () => {
    const d = doc();
    expect(d.db.stack.items).toEqual([stackItem]);
    expect(d.db.stack.items[0].ts).toBe(1700000000000);
    expect(d.db.stack.meta).toEqual({ dirty: ["s-aaaa"], cursor: 7, epoch: "e1" });
    expect(d.db.queue.items[0].id).toBe("q-aaaa");
    expect(d.db.notes.items[0].text).toBe("a note");
    expect(Object.keys(d.db).sort()).toEqual(["notes", "queue", "stack"]);
  });

  test("deleted and pending-edit rows are kept as they are", () => {
    const d = doc({ db: { stack: loaded([{ ...stackItem, deleted: true, pendingEdit: true }]), queue: loaded([]), notes: loaded([]) } });
    expect(d.db.stack.items[0]).toMatchObject({ deleted: true, pendingEdit: true });
  });

  test("lastFailure appears only when there is one", () => {
    expect("lastFailure" in doc()).toBe(false);
    expect("lastFailure" in doc({ lastFailure: null })).toBe(false);
    const f = { at: 1, request: { method: "POST", url: "/api/sync" }, online: false, error: { name: "TypeError", message: "x" } };
    expect(doc({ lastFailure: f }).lastFailure).toEqual(f);
  });

  test("static mode is named", () => {
    expect(doc({ mode: "static" }).mode).toBe("static");
  });

  test("a database that could not be read says so instead of failing the document", () => {
    const d = doc({ db: { stack: loaded([]), queue: { error: "closed" }, notes: loaded([]) } });
    expect(d.db.queue).toEqual({ error: "closed" });
  });

  test("it is plain JSON", () => {
    const d = doc();
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });
});

describe("readStorage", () => {
  test("reads items and meta from a storage", async () => {
    const s = { load: async () => ({ items: [{ id: "x" }], dirty: ["x"], cursor: 2, epoch: "e" }) };
    expect(await readStorage(s)).toEqual({ items: [{ id: "x" }], meta: { dirty: ["x"], cursor: 2, epoch: "e" } });
  });
  test("a missing or failing storage gives an error entry", async () => {
    expect(await readStorage({})).toEqual({ error: "no storage" });
    expect(await readStorage({ load: async () => { throw new Error("boom"); } })).toEqual({ error: "boom" });
  });
});
