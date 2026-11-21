import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openStore, type Store } from "./store";

let store: Store;
let dir: string;
let app: ReturnType<typeof createApp>;
let clock = 1_000_000;

beforeEach(() => {
  clock = 1_000_000;
  store = openStore(":memory:", { now: () => clock });
  dir = mkdtempSync(join(tmpdir(), "ist-sync-srv-"));
  writeFileSync(join(dir, "index.html"), "x");
  app = createApp(store, { webDir: dir });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (body: unknown, raw = false) =>
  app.fetch(new Request("http://t/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) }));
const sync = async (body: unknown) => (await post(body)).json() as Promise<any>;
const get = (p: string) => app.fetch(new Request("http://t" + p));
const item = (text = "task", ts = 100, removed = false) => ({ text, ts, removed });
const qitem = (text = "later", ts = 100, removed = false) => ({ text, ts, removed });

describe("POST /api/sync", () => {
  test("applies changes for several tables and returns everything since the cursor", async () => {
    const r = await sync({ epoch: null, cursor: 0, changes: { items: { "s-aaaa": item("a") }, queue: { "q-aaaa": qitem("b") } } });
    expect(r.epoch).toBe(store.epoch);
    expect(r.cursor).toBe(2);
    expect(r.tables.items.rows.map((x: any) => x.id)).toEqual(["s-aaaa"]);
    expect(r.tables.queue.rows.map((x: any) => x.id)).toEqual(["q-aaaa"]);
    expect(r.tables.items.saved["s-aaaa"]).toMatchObject({ text: "a", removed: false });
    expect(r.tables.queue.saved["q-aaaa"]).toMatchObject({ text: "b", started: false });
    expect(r.tables.items.rejected).toEqual({});
  });

  test("one counter is shared by every table", async () => {
    const r = await sync({ cursor: 0, changes: { items: { "s-aaaa": item() }, queue: { "q-aaaa": qitem() } } });
    const seqs = [r.tables.items.rows[0].seq, r.tables.queue.rows[0].seq].sort();
    expect(seqs).toEqual([1, 2]);
    const r2 = await sync({ cursor: 2, changes: { items: { "s-bbbb": item() } } });
    expect(r2.cursor).toBe(3);
    expect(r2.tables.items.rows.map((x: any) => x.id)).toEqual(["s-bbbb"]);
    expect(r2.tables.queue.rows).toEqual([]);
  });

  test("with no changes it is a pure pull, and tombstones come through", async () => {
    await sync({ cursor: 0, changes: { items: { "s-aaaa": item("a", 5, true) } } });
    const r = await sync({ cursor: 0 });
    expect(r.tables.items.rows).toHaveLength(1);
    expect(r.tables.items.rows[0].removed).toBe(true);
    expect((await sync({ cursor: r.cursor })).tables.items.rows).toEqual([]);
  });

  test("a rejected change is reported per row and does not block the others", async () => {
    const r = await sync({ cursor: 0, changes: { items: { "s-aaaa": item("a"), "bad id": item("b"), "s-cccc": item("") }, queue: { "q-aaaa": qitem("ok") } } });
    expect(Object.keys(r.tables.items.saved)).toEqual(["s-aaaa"]);
    expect(Object.keys(r.tables.items.rejected).sort()).toEqual(["bad id", "s-cccc"]);
    expect(r.tables.items.rejected["s-cccc"].error).toMatch(/text/);
    expect(Object.keys(r.tables.queue.saved)).toEqual(["q-aaaa"]);
  });

  test("keeps item semantics: edit flag, stored text kept without it, origin set once, times clamped, events logged", async () => {
    await sync({ cursor: 0, changes: { items: { "s-aaaa": { text: "one", ts: 100, removed: true, at: 200 } } } });
    await sync({ cursor: 0, changes: { items: { "s-aaaa": { text: "stale", ts: 50, removed: true, at: 200 } } } });
    expect(store.since(0).items[0]).toMatchObject({ text: "one", ts: 100 });
    const r = await sync({ cursor: 0, changes: { items: { "s-aaaa": { text: "fixed", ts: 100, removed: true, at: 300, edit: true } } } });
    expect(r.tables.items.saved["s-aaaa"]).toMatchObject({ text: "fixed", at: 300 });
    expect(typeof r.tables.items.saved["s-aaaa"].edited_at).toBe("number");
    await sync({ cursor: 0, changes: { items: { "s-bbbb": { text: "b", ts: 100, removed: false, origin: "s-aaaa" } } } });
    await sync({ cursor: 0, changes: { items: { "s-bbbb": { text: "b", ts: 100, removed: false, origin: "s-zzzz" } } } });
    expect(store.since(0).items.find((i) => i.id === "s-bbbb")!.origin).toBe("s-aaaa");
    await sync({ cursor: 0, changes: { items: { "s-cccc": { text: "future", ts: 5_000_000, removed: false } } } });
    expect(store.log().some((e) => e.op === "push" && e.id === "s-cccc" && e.at <= clock)).toBe(true);
    expect(store.log().filter((e) => e.op === "edit")).toHaveLength(1);
  });

  test("keeps queue semantics: started tombstones and their events", async () => {
    await sync({ cursor: 0, changes: { queue: { "q-aaaa": qitem("a") } } });
    const r = await sync({ cursor: 0, changes: { queue: { "q-aaaa": { text: "a", ts: 100, removed: true, started: true } } } });
    expect(r.tables.queue.saved["q-aaaa"]).toMatchObject({ removed: true, started: true });
    expect(store.log().map((e) => e.op)).toEqual(["queue", "start"]);
  });

  test("a stack push and the queue start arrive in one request", async () => {
    await sync({ cursor: 0, changes: { queue: { "q-aaaa": qitem("a") } } });
    const r = await sync({ cursor: 1, changes: { items: { "s-aaaa": item("a") }, queue: { "q-aaaa": { text: "a", ts: 100, removed: true, started: true } } } });
    expect(r.cursor).toBe(3);
    expect(store.log().map((e) => e.op)).toEqual(["queue", "push", "start"]);
  });

  test("a client from a replaced database gets the new epoch and a lower cursor", async () => {
    const r = await sync({ epoch: "someone-else", cursor: 99, changes: { items: { "s-aaaa": item() } } });
    expect(r.epoch).toBe(store.epoch);
    expect(r.cursor).toBeLessThan(99);
    expect(r.tables.items.saved["s-aaaa"]).toBeDefined();
  });

  test("bad requests keep HTTP semantics", async () => {
    expect((await post("{nope", true)).status).toBe(400);
    expect((await post("[1]", true)).status).toBe(400);
    expect((await post({ cursor: 0, changes: { nope: { "n-aaaa": {} } } })).status).toBe(400);
    expect((await post({ cursor: 0, changes: { items: [] } })).status).toBe(400);
    expect((await post({ cursor: 0, changes: { items: { "s-aaaa": item("x".repeat(300_000)) } } })).status).toBe(413);
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`s-a${String(i).padStart(4, "0")}`, item()]));
    expect((await post({ cursor: 0, changes: { items: many } })).status).toBe(413);
    expect((await app.fetch(new Request("http://t/api/sync"))).status).toBe(404);
  });

  test("an invalid cursor is treated as 0", async () => {
    await sync({ cursor: 0, changes: { items: { "s-aaaa": item() } } });
    expect((await sync({ cursor: "x" })).tables.items.rows).toHaveLength(1);
    expect((await sync({})).tables.items.rows).toHaveLength(1);
  });

  test("the request is counted under its own metrics route", async () => {
    await sync({ cursor: 0 });
    expect(await (await get("/metrics")).text()).toContain('route="/api/sync",method="POST",code="200"');
  });
});

describe("events", () => {
  const open = async () => {
    const reader = (await get("/api/events")).body!.getReader();
    const dec = new TextDecoder();
    return { next: async () => dec.decode((await reader.read()).value), cancel: () => reader.cancel() };
  };

  test("sync event carries the shared cursor, on connect and after a change from any table", async () => {
    const s = await open();
    expect(await s.next()).toContain("event: sync\ndata: 0\n\n");
    await sync({ cursor: 0, changes: { queue: { "q-aaaa": qitem() } } });
    const chunk = await s.next();
    expect(chunk).toContain("event: sync\ndata: 1\n\n");
    expect(chunk).toContain("event: qseq\n");
    expect(chunk).not.toContain("event: seq\n");
    await sync({ cursor: 0, changes: { items: { "s-aaaa": item() } } });
    const c2 = await s.next();
    expect(c2).toContain("event: sync\ndata: 2\n\n");
    expect(c2).toContain("event: seq\ndata: 2\n\n");
    await s.cancel();
  });

  test("a request that changes nothing sends nothing", async () => {
    const s = await open();
    await s.next();
    await sync({ cursor: 0 });
    await sync({ cursor: 0, changes: { items: { bad: item() } } });
    await sync({ cursor: 0, changes: { items: { "s-aaaa": item() } } });
    expect(await s.next()).toContain("event: sync\ndata: 1\n\n");
    await s.cancel();
  });
});

describe("old endpoints keep working beside it", () => {
  const put = (path: string, body: unknown) => app.fetch(new Request("http://t" + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  test("PUT and GET on /api/items and /api/queue, with the shared counter", async () => {
    await put("/api/items/s-aaaa", item("a"));
    await put("/api/queue/q-aaaa", qitem("b"));
    await put("/api/items/s-bbbb", item("c"));
    const items = await (await get("/api/items?since=0")).json();
    expect(items.items.map((i: any) => i.id)).toEqual(["s-aaaa", "s-bbbb"]);
    expect(items.seq).toBe(3);
    expect((await (await get("/api/items?since=1")).json()).items.map((i: any) => i.id)).toEqual(["s-bbbb"]);
    const q = await (await get("/api/queue?since=0")).json();
    expect(q.items.map((i: any) => i.id)).toEqual(["q-aaaa"]);
    expect(q.seq).toBe(2);
  });

  test("a write through either door is visible through the other", async () => {
    await put("/api/items/s-aaaa", item("old client"));
    await sync({ cursor: 0, changes: { items: { "s-bbbb": item("new client") } } });
    const r = await sync({ cursor: 0 });
    expect(r.tables.items.rows.map((i: any) => i.text)).toEqual(["old client", "new client"]);
    expect((await (await get("/api/items?since=0")).json()).items).toHaveLength(2);
  });
});

describe("an existing database file from main", () => {
  // The schema main creates (and migrates to), with rows numbered per table, so seqs overlap across tables.
  function legacyFile(path: string) {
    const db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE items (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, at INTEGER, removed INTEGER NOT NULL, seq INTEGER NOT NULL, origin TEXT, edited_at INTEGER)");
    db.run("CREATE TABLE events (n INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, at INTEGER NOT NULL, op TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, detail TEXT)");
    db.run("CREATE INDEX items_seq ON items (seq)");
    db.run("CREATE TABLE queue (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, at INTEGER NOT NULL, removed INTEGER NOT NULL, started INTEGER NOT NULL, seq INTEGER NOT NULL)");
    db.run("CREATE INDEX queue_seq ON queue (seq)");
    db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.run("INSERT INTO meta VALUES ('epoch', 'legacy-epoch')");
    for (const [i, id] of ["s-aaaa", "s-bbbb", "s-cccc"].entries()) db.run("INSERT INTO items (id, text, ts, at, removed, seq) VALUES (?, ?, 10, 10, 0, ?)", [id, id, i + 1]);
    for (const [i, id] of ["q-aaaa", "q-bbbb"].entries()) db.run("INSERT INTO queue VALUES (?, ?, 10, 10, 0, 0, ?)", [id, id, i + 1]);
    db.close();
  }

  test("opens unchanged, the counter continues above every table, and reopening is stable", () => {
    const d = mkdtempSync(join(tmpdir(), "ist-legacy-"));
    const path = join(d, "stack.db");
    try {
      legacyFile(path);
      let s = openStore(path, { now: () => clock });
      expect(s.epoch).toBe("legacy-epoch");
      expect(s.cursor()).toBe(3);
      const first = s.sync(0, {});
      expect(first.cursor).toBe(3);
      expect(first.tables.items.rows).toHaveLength(3);
      expect(first.tables.queue.rows).toHaveLength(2);
      const w = s.sync(3, { queue: { "q-cccc": { text: "new", ts: 5, removed: false } } });
      expect(w.tables.queue.saved["q-cccc"].seq).toBe(4);
      expect(w.tables.items.rows).toEqual([]);
      expect(s.upsert("s-dddd", { text: "d", ts: 5, removed: false }).seq).toBe(5);
      s.close();
      s = openStore(path, { now: () => clock });
      expect(s.cursor()).toBe(5);
      expect(s.epoch).toBe("legacy-epoch");
      // an old client's cursors are still per-table numbers and still work
      expect(s.since(2).items.map((i) => i.id)).toEqual(["s-cccc", "s-dddd"]);
      expect(s.queueSince(1).items.map((i) => i.id)).toEqual(["q-bbbb", "q-cccc"]);
      s.close();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
