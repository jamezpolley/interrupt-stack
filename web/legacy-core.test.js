import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { openStore } from "../server/store";
import { createHub } from "./legacy-core.js";
import { createSync } from "./legacy-sync.js";
import { createQueue, stackIdFor } from "./legacy-queue.js";

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function newServer() {
  const store = openStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "ist-core-"));
  writeFileSync(join(dir, "index.html"), "x");
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, app: createApp(store, { webDir: dir }) };
}

function memStorage(initial = {}) {
  const items = new Map((initial.items ?? []).map((i) => [i.id, i]));
  let dirty = initial.dirty ?? [];
  let cursor = initial.cursor ?? 0;
  let epoch = initial.epoch ?? null;
  return {
    load: async () => ({ items: [...items.values()].map((i) => ({ ...i })), dirty: [...dirty], cursor, epoch }),
    setEpoch: async (e) => void (epoch = e),
    putItem: async (i) => void items.set(i.id, { ...i }),
    setDirty: async (ids) => void (dirty = [...ids]),
    setCursor: async (n) => void (cursor = n),
    peek: () => ({ cursor, epoch, dirty: [...dirty] }),
  };
}

// A device: the stack and the queue over one network. `calls` records every request.
function world(server = newServer()) {
  const mkDevice = (opts = {}) => {
    const ctl = { online: true, calls: [] };
    const stackStorage = opts.stackStorage ?? memStorage();
    const queueStorage = opts.queueStorage ?? memStorage();
    const fetch = async (path, init = {}) => {
      if (!ctl.online) throw new TypeError("network down");
      ctl.calls.push({ path, init, body: init.body ? JSON.parse(init.body) : null });
      return server.app.fetch(new Request("http://t" + path, init));
    };
    const stack = createSync({ storage: stackStorage, fetch, now: opts.now });
    const queue = createQueue({ storage: queueStorage, stack, now: opts.now });
    const start = () => Promise.all([stack.start(), queue.start()]);
    return { stack, queue, ctl, stackStorage, queueStorage, start };
  };
  return { server, mkDevice };
}

describe("one channel", () => {
  test("stack and queue changes travel in one request, and nothing else is requested", async () => {
    const w = world();
    const a = w.mkDevice();
    a.ctl.online = false;
    await a.start();
    await a.stack.push("on the stack");
    await a.queue.add("for later");
    a.ctl.online = true;
    a.ctl.calls.length = 0;
    await a.stack.syncNow();
    expect(a.ctl.calls.every((c) => c.path === "/api/sync" && c.init.method === "POST" && c.init.redirect === "manual")).toBe(true);
    const first = a.ctl.calls[0].body;
    expect(Object.keys(first.changes.items)).toHaveLength(1);
    expect(Object.keys(first.changes.queue)).toHaveLength(1);
    expect(w.server.store.since(0).items.map((i) => i.text)).toEqual(["on the stack"]);
    expect(w.server.store.queueSince(0).items.map((i) => i.text)).toEqual(["for later"]);
  });

  test("one status for both: pending counts every table, and the two views agree", async () => {
    const w = world();
    const a = w.mkDevice();
    a.ctl.online = false;
    await a.start();
    await a.stack.push("s");
    await a.queue.add("q");
    expect(a.stack.status()).toEqual({ state: "offline", pending: 2, error: { kind: "unreachable" }, neverSynced: true });
    expect(a.queue.status()).toEqual(a.stack.status());
    a.ctl.online = true;
    await a.queue.syncNow();
    expect(a.stack.status()).toEqual({ state: "synced", pending: 0 });
  });

  test("two devices converge on both tables with a single cursor", async () => {
    const w = world();
    const a = w.mkDevice();
    const b = w.mkDevice();
    await a.start();
    await b.start();
    await a.stack.push("shared task");
    const q = await a.queue.add("shared later");
    await a.stack.syncNow();
    await b.stack.syncNow();
    expect(b.stack.stack().map((i) => i.text)).toEqual(["shared task"]);
    expect(b.queue.queue().map((i) => i.text)).toEqual(["shared later"]);
    expect(b.stackStorage.peek().cursor).toBe(w.server.store.cursor());
    // starting the queued row on B: both tables change in one request, A sees both
    await b.queue.promote(q.id);
    await b.stack.syncNow();
    await a.stack.syncNow();
    expect(a.queue.queue()).toEqual([]);
    expect(a.stack.stack().map((i) => i.id)).toContain(stackIdFor(q.id));
  });

  test("a second pull with nothing new returns nothing new, and keeps the cursor", async () => {
    const w = world();
    const a = w.mkDevice();
    await a.start();
    await a.stack.push("x");
    await a.stack.syncNow();
    const cursor = a.stackStorage.peek().cursor;
    expect(cursor).toBe(1);
    a.ctl.calls.length = 0;
    await a.stack.syncNow();
    expect(a.ctl.calls).toHaveLength(1);
    expect(a.ctl.calls[0].body).toMatchObject({ cursor, changes: {} });
    expect(a.stackStorage.peek().cursor).toBe(cursor);
  });

  test("a tombstone reaches a device that never saw the row", async () => {
    const w = world();
    const a = w.mkDevice();
    const b = w.mkDevice();
    await a.start();
    const item = await a.stack.push("gone");
    await a.stack.remove(item.id);
    const q = await a.queue.add("dropped");
    await a.queue.drop(q.id);
    await a.stack.syncNow();
    await b.start();
    expect(b.stack.allItems().map((i) => [i.text, i.removed])).toEqual([["gone", true]]);
    expect(b.queue.queue()).toEqual([]);
  });

  test("when the server's database is replaced, every table is re-sent", async () => {
    const w = world();
    const a = w.mkDevice();
    await a.start();
    await a.stack.push("keep me");
    await a.queue.add("and me");
    await a.stack.syncNow();
    w.server.store.close();
    w.server = Object.assign(w.server, newServer()); // a fresh database: new epoch, numbering starts again
    await a.stack.syncNow();
    await a.stack.syncNow();
    expect(w.server.store.since(0).items.map((i) => i.text)).toEqual(["keep me"]);
    expect(w.server.store.queueSince(0).items.map((i) => i.text)).toEqual(["and me"]);
    expect(a.stackStorage.peek().epoch).toBe(w.server.store.epoch);
    expect(a.stack.status().state).toBe("synced");
  });

  test("pending changes are sent in batches of 100, so a big backlog never hits the server's limit", async () => {
    const w = world();
    const a = w.mkDevice();
    a.ctl.online = false;
    await a.start();
    for (let i = 0; i < 130; i++) await a.stack.push(`task ${i}`);
    for (let i = 0; i < 20; i++) await a.queue.add(`later ${i}`);
    a.ctl.online = true;
    a.ctl.calls.length = 0;
    await a.stack.syncNow();
    const sizes = a.ctl.calls.map((c) => Object.values(c.body.changes).reduce((n, rows) => n + Object.keys(rows).length, 0));
    expect(sizes.slice(0, 2)).toEqual([100, 50]);
    expect(w.server.store.since(0).items).toHaveLength(130);
    expect(w.server.store.queueSince(0).items).toHaveLength(20);
    expect(a.stack.status()).toEqual({ state: "synced", pending: 0 });
  });

  test("rows the server refuses never starve the rest of a big backlog", async () => {
    const w = world();
    const a = w.mkDevice();
    a.ctl.online = false;
    await a.start();
    for (let i = 0; i < 100; i++) await a.stack.push("x".repeat(201)); // too long: refused
    await a.stack.push("fine");
    a.ctl.online = true;
    await a.stack.syncNow();
    await a.stack.syncNow();
    expect(w.server.store.since(0).items.map((i) => i.text)).toEqual(["fine"]);
    expect(a.stack.status().pending).toBe(100);
    expect(a.stack.status().state).toBe("error");
  });
});

describe("upgrading a device that held the two-channel version", () => {
  test("old per-table numbers are ignored, pending changes survive, and one full pull follows", async () => {
    const w = world();
    // another device already put rows on the server
    const other = w.mkDevice();
    await other.start();
    await other.stack.push("from elsewhere");
    await other.queue.add("later elsewhere");
    await other.stack.syncNow();
    // this device's storage as the old build left it: a stack `lastSeq`, an epoch, a pending row; no `cursor`
    const stackStorage = memStorage({
      items: [{ id: "s-oldone", text: "pending", ts: 5, at: 5, removed: false, seq: 0 }],
      dirty: ["s-oldone"],
      epoch: w.server.store.epoch,
    });
    const queueStorage = memStorage({ items: [{ id: "q-oldone", text: "pending later", ts: 6, at: 6, removed: false, started: false, seq: 0 }], dirty: ["q-oldone"] });
    const a = w.mkDevice({ stackStorage, queueStorage });
    await a.start();
    await a.stack.syncNow();
    expect(a.stack.stack().map((i) => i.text).sort()).toEqual(["from elsewhere", "pending"]);
    expect(a.queue.queue().map((i) => i.text).sort()).toEqual(["later elsewhere", "pending later"]);
    expect(a.stackStorage.peek().dirty).toEqual([]);
    expect(a.stackStorage.peek().cursor).toBe(w.server.store.cursor());
    expect(a.stack.status()).toEqual({ state: "synced", pending: 0 });
  });
});

describe("adding a table", () => {
  // A third table needs only a hub.table(...) call: everything else (cursor, epoch, batching, status) is shared.
  test("a table registered on the hub rides the same request", async () => {
    const seen = [];
    const fetch = async (path, init) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      const notes = Object.fromEntries(Object.entries(body.changes.notes ?? {}).map(([id, c]) => [id, { id, ...c, seq: 7 }]));
      return new Response(JSON.stringify({ epoch: "e", cursor: 7, tables: { notes: { rows: [{ id: "n-remote", text: "hi", seq: 6 }], saved: notes, rejected: {} } } }), { headers: { "content-type": "application/json" } });
    };
    const storage = memStorage();
    const hub = createHub({ meta: storage, fetch });
    const notes = hub.table("notes", { storage, toWire: (n) => ({ text: n.text }) });
    await notes.load();
    await notes.setItems([{ id: "n-local", text: "mine" }]);
    await hub.syncNow();
    expect(seen.at(-1).changes).toEqual({}); // acknowledged by the first, automatic pass
    expect(seen[0].changes).toEqual({ notes: { "n-local": { text: "mine" } } });
    expect([...notes.items.keys()].sort()).toEqual(["n-local", "n-remote"]);
    expect(storage.peek()).toMatchObject({ cursor: 7, epoch: "e", dirty: [] });
  });
});

describe("a table that has not finished loading", () => {
  test("a sync pass never overwrites its saved pending list", async () => {
    const w = world();
    const queueStorage = memStorage({ items: [{ id: "q-unsent", text: "unsent", ts: 6, at: 6, removed: false, started: false, seq: 0 }], dirty: ["q-unsent"] });
    const a = w.mkDevice({ queueStorage });
    await a.stack.start(); // the queue has not been started: its rows and pending list are not loaded yet
    await a.stack.syncNow();
    expect(queueStorage.peek().dirty).toEqual(["q-unsent"]);
    await a.queue.start();
    await a.stack.syncNow();
    expect(w.server.store.queueSince(0).items.map((i) => i.text)).toEqual(["unsent"]);
    expect(queueStorage.peek().dirty).toEqual([]);
  });
});
