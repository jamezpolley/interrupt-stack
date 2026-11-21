import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { openStore } from "../server/store";
import { createSync } from "./sync.js";
import { createQueue } from "./queue.js";
import { createNotes } from "./notes.js";
import { doneTodayEntries } from "./today.js";
import { doneRow, timeline, timeOnTop } from "./times.js";

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function newServer() {
  const store = openStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "ist-notes-"));
  writeFileSync(join(dir, "index.html"), "x");
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, app: createApp(store, { webDir: dir }) };
}

function memStorage() {
  const items = new Map();
  let dirty = [];
  let cursor = 0;
  let epoch = null;
  return {
    load: async () => ({ items: [...items.values()].map((i) => ({ ...i })), dirty: [...dirty], cursor, epoch }),
    setEpoch: async (e) => void (epoch = e),
    putItem: async (i) => void items.set(i.id, { ...i }),
    setDirty: async (ids) => void (dirty = [...ids]),
    setCursor: async (n) => void (cursor = n),
  };
}

function world() {
  const server = newServer();
  const mkDevice = (opts = {}) => {
    const ctl = { online: true };
    const stackStorage = opts.stackStorage ?? memStorage();
    const noteStorage = opts.noteStorage ?? memStorage();
    const fetch = async (path, init = {}) => {
      if (!ctl.online) throw new TypeError("network down");
      return server.app.fetch(new Request("http://t" + path, init));
    };
    const stack = createSync({ storage: stackStorage, fetch, now: opts.now, local: opts.local });
    const notes = createNotes({ storage: noteStorage, now: opts.now, stack });
    return { stack, notes, ctl, stackStorage, noteStorage };
  };
  return { server, mkDevice };
}
const ntexts = (d) => d.notes.notes().map((n) => n.text);

describe("notes", () => {
  test("add shows at once, offline, and reaches the server after reconnect", async () => {
    const w = world();
    let t = 1000;
    const d = w.mkDevice({ now: () => t++ });
    await d.stack.start();
    await d.notes.start();
    d.ctl.online = false;
    const p = d.notes.add("  lunch  ");
    expect(ntexts(d)).toEqual(["lunch"]);
    await p;
    expect(d.stack.status().pending).toBe(1);
    d.ctl.online = true;
    await d.stack.syncNow();
    expect(d.stack.status().pending).toBe(0);
    expect(w.server.store.sync(0, {}).tables.notes.rows.map((n) => n.text)).toEqual(["lunch"]);
    expect(w.server.store.log().map((e) => e.op)).toEqual(["note"]);
  });

  test("empty and over-long text add nothing", async () => {
    const d = world().mkDevice();
    await d.notes.start();
    expect(await d.notes.add("   ")).toBeNull();
    expect(await d.notes.add("x".repeat(201))).toBeNull();
    expect(ntexts(d)).toEqual([]);
  });

  test("a note does not touch the stack: depth, items and the server's stack counts stay as they were", async () => {
    const w = world();
    const d = w.mkDevice();
    await d.stack.start();
    await d.notes.start();
    await d.stack.push("task");
    await d.notes.add("a note");
    await d.stack.syncNow();
    expect(d.stack.stack().map((i) => i.text)).toEqual(["task"]);
    expect(d.stack.allItems()).toHaveLength(1);
    expect(w.server.store.counts()).toEqual({ live: 1, removed: 0 });
    expect(w.server.store.log().map((e) => e.op)).toEqual(["push", "note"]);
  });

  test("a note logged while another item is on top does not change that item's timeline or time on top", async () => {
    let t = 10_000;
    const d = world().mkDevice({ now: () => t });
    await d.stack.start();
    await d.notes.start();
    await d.stack.push("bottom");
    t = 20_000;
    await d.stack.push("top");
    const before = d.stack.allItems();
    const snapshot = JSON.stringify(before.map((i) => [timeline(i, before), timeOnTop(i, before)]));
    t = 25_000;
    await d.notes.add("interruption");
    const after = d.stack.allItems();
    const noSeq = (l) => l.map(({ seq, ...r }) => r);
    expect(noSeq(after)).toEqual(noSeq(before));
    expect(JSON.stringify(after.map((i) => [timeline(i, after), timeOnTop(i, after)]))).toBe(snapshot);
    t = 30_000;
    await d.stack.remove(after.find((i) => i.text === "top").id);
    const all = d.stack.allItems();
    const bottom = all.find((i) => i.text === "bottom");
    expect(timeOnTop(bottom, all)).toBe(null); // still on the stack: no duration, note or not
    expect(doneRow(all.find((i) => i.text === "top"), all, undefined, 30_000).duration).not.toBe("—");
  });

  test("an edit changes text and time, syncs as an edit, and is marked edited", async () => {
    const w = world();
    let t = 100_000;
    const a = w.mkDevice({ now: () => t });
    const b = w.mkDevice({ now: () => t });
    for (const d of [a, b]) {
      await d.stack.start();
      await d.notes.start();
    }
    const n = await a.notes.add("old");
    await a.stack.syncNow();
    t = 200_000;
    const edited = await a.notes.edit(n.id, { text: "new", ts: 50_000 });
    expect(edited).toMatchObject({ text: "new", ts: 50_000, edited_at: 200_000 });
    await a.stack.syncNow();
    await b.stack.syncNow();
    expect(b.notes.get(n.id)).toMatchObject({ text: "new", ts: 50_000 });
    expect(w.server.store.log().map((e) => e.op)).toEqual(["note", "edit"]);
    expect(a.notes.get(n.id).pendingEdit).toBeUndefined();
  });

  test("an edit that changes nothing, or is invalid, writes nothing", async () => {
    let t = 1000;
    const d = world().mkDevice({ now: () => t });
    await d.notes.start();
    const n = await d.notes.add("same");
    expect(await d.notes.edit(n.id, { text: "same", ts: n.ts })).toBeNull();
    expect(await d.notes.edit(n.id, { text: "  ", ts: 5000 })).toBeNull(); // empty text and a time in the future
    expect(await d.notes.edit("n-missing", { text: "x" })).toBeNull();
  });

  test("two devices converge; last write wins", async () => {
    const w = world();
    const a = w.mkDevice();
    const b = w.mkDevice();
    for (const d of [a, b]) {
      await d.stack.start();
      await d.notes.start();
    }
    const n = await a.notes.add("from a");
    await a.stack.syncNow();
    await b.stack.syncNow();
    expect(ntexts(b)).toEqual(["from a"]);
    await a.notes.remove(n.id);
    await a.stack.syncNow();
    await b.stack.syncNow();
    expect(ntexts(b)).toEqual([]);
  });

  test("local-only: stored on the device, nothing pending, nothing sent", async () => {
    const w = world();
    const d = w.mkDevice({ local: true });
    await d.stack.start();
    await d.notes.start();
    await d.notes.add("private");
    expect(ntexts(d)).toEqual(["private"]);
    expect(d.stack.status()).toMatchObject({ state: "local", pending: 0 });
    expect(w.server.store.log()).toEqual([]);
    const again = w.mkDevice({ local: true, noteStorage: d.noteStorage, stackStorage: d.stackStorage });
    await again.notes.start();
    expect(ntexts(again)).toEqual(["private"]);
  });

  test("offline notes survive a restart and are sent later", async () => {
    const w = world();
    const a = w.mkDevice();
    await Promise.all([a.stack.start(), a.notes.start()]);
    a.ctl.online = false;
    await a.notes.add("kept");
    const again = w.mkDevice({ stackStorage: a.stackStorage, noteStorage: a.noteStorage });
    await Promise.all([again.stack.start(), again.notes.start()]);
    expect(ntexts(again)).toEqual(["kept"]);
    await again.stack.syncNow();
    expect(w.server.store.log().map((e) => e.text)).toEqual(["kept"]);
  });

  test("notes and the queue ride in the one request", async () => {
    const w = world();
    const calls = [];
    const stack = createSync({
      storage: memStorage(),
      fetch: async (path, init) => {
        calls.push(path);
        return w.server.app.fetch(new Request("http://t" + path, init));
      },
    });
    const queue = createQueue({ storage: memStorage(), stack });
    const notes = createNotes({ storage: memStorage(), stack });
    await Promise.all([stack.start(), queue.start(), notes.start()]);
    calls.length = 0;
    await Promise.all([notes.add("n"), queue.add("q")]);
    await stack.syncNow();
    expect(calls.every((c) => c === "/api/sync")).toBe(true);
    expect(stack.status().pending).toBe(0);
    expect(w.server.store.log().map((e) => e.op).sort()).toEqual(["note", "queue"]);
  });
});

describe("Done today entries", () => {
  const at = (h, m = 0) => new Date(2026, 10, 21, h, m).getTime();
  const NOW = at(15);
  const item = (id, when) => ({ id, text: id, ts: when - 1000, at: when, removed: true, seq: 1 });
  const note = (id, when, extra = {}) => ({ id, text: id, ts: when, removed: false, seq: 1, ...extra });

  test("items and notes interleave newest first", () => {
    const e = doneTodayEntries([item("s-a", at(9)), item("s-b", at(13))], [note("n-a", at(11)), note("n-b", at(14))], NOW);
    expect(e.map((x) => (x.item ?? x.note).id)).toEqual(["n-b", "s-b", "n-a", "s-a"]);
    expect(e.map((x) => x.kind)).toEqual(["note", "item", "note", "item"]);
  });

  test("a note from yesterday or a removed note is left out", () => {
    const e = doneTodayEntries([], [note("n-old", new Date(2026, 10, 20, 23, 59).getTime()), note("n-gone", at(10), { removed: true }), note("n-ok", at(10))], NOW);
    expect(e.map((x) => x.note.id)).toEqual(["n-ok"]);
  });
});
