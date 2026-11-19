import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { openStore } from "../server/store";
import { createSync } from "./sync.js";

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function memStorage() {
  const items = new Map();
  let dirty = [];
  return {
    load: async () => ({ items: [...items.values()].map((i) => ({ ...i })), dirty: [...dirty], lastSeq: 0, epoch: null }),
    setEpoch: async () => {},
    putItem: async (i) => void items.set(i.id, { ...i }),
    setDirty: async (ids) => void (dirty = [...ids]),
    setLastSeq: async () => {},
  };
}

function server() {
  const store = openStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "ist-edit-"));
  writeFileSync(join(dir, "index.html"), "x");
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return createApp(store, { webDir: dir });
}

// A client against the real app. `net.up = false` makes it throw like an offline device; `net.bodies` records PUT bodies.
function client(app, { stripEdit = false } = {}) {
  const net = { up: true, bodies: [] };
  const fetch = async (path, init = {}) => {
    if (!net.up) throw new TypeError("offline");
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      net.bodies.push(body);
      if (stripEdit) delete body.edit; // an older build never sends it
      init = { ...init, body: JSON.stringify(body) };
    }
    return app.fetch(new Request("http://t" + path, init));
  };
  const sync = createSync({ storage: memStorage(), fetch });
  return { sync, net };
}

// Pushes and pops one item so it is finished, synced.
async function finishedItem(c, text = "old") {
  const item = await c.sync.push(text);
  await c.sync.syncNow();
  await c.sync.remove(item.id);
  await c.sync.syncNow();
  return c.sync.allItems().find((i) => i.id === item.id);
}

describe("sync.edit", () => {
  test("changes the item at once, marks it edited, and sends it flagged as an edit", async () => {
    const c = client(server());
    await c.sync.start();
    const it = await finishedItem(c);
    c.net.bodies.length = 0;
    await c.sync.edit(it.id, { text: "  new  ", ts: it.ts - 1000 });
    const now = c.sync.allItems().find((i) => i.id === it.id);
    expect(now).toMatchObject({ text: "new", ts: it.ts - 1000 });
    expect(typeof now.edited_at).toBe("number");
    await c.sync.syncNow();
    expect(c.net.bodies).toEqual([{ text: "new", ts: it.ts - 1000, removed: true, at: it.at, edit: true }]);
  });

  test("after the server acknowledges it the local copy is the server's and no longer pending", async () => {
    const c = client(server());
    await c.sync.start();
    const it = await finishedItem(c);
    await c.sync.edit(it.id, { text: "new" });
    await c.sync.syncNow();
    expect(c.sync.status().pending).toBe(0);
    c.net.bodies.length = 0;
    await c.sync.syncNow();
    expect(c.net.bodies).toEqual([]); // nothing left to send
    expect(c.sync.allItems().find((i) => i.id === it.id).pendingEdit).toBeUndefined();
  });

  test("made offline, it waits as an unsent change and is applied when the connection returns", async () => {
    const app = server();
    const c = client(app);
    await c.sync.start();
    const it = await finishedItem(c);
    c.net.up = false;
    await c.sync.edit(it.id, { text: "typed on the train" });
    expect(c.sync.status().pending).toBe(1);
    c.net.up = true;
    await c.sync.syncNow();
    const other = client(app);
    await other.sync.start();
    expect(other.sync.allItems().find((i) => i.id === it.id)).toMatchObject({ text: "typed on the train" });
  });

  test("an edit followed by a restore before syncing still reaches the server as an edit", async () => {
    const app = server();
    const c = client(app);
    await c.sync.start();
    const it = await finishedItem(c);
    c.net.up = false;
    await c.sync.edit(it.id, { text: "kept" });
    await c.sync.restore(it.id);
    c.net.up = true;
    await c.sync.syncNow();
    const other = client(app);
    await other.sync.start();
    expect(other.sync.allItems().find((i) => i.id === it.id)).toMatchObject({ text: "kept", removed: false });
  });

  test("an old build resending its stale copy cannot undo an edit and ends up with the edited values", async () => {
    const app = server();
    const a = client(app);
    const old = client(app, { stripEdit: true });
    await a.sync.start();
    const it = await finishedItem(a, "original");
    await old.sync.start(); // pulls the finished item
    a.net.up = true;
    await a.sync.edit(it.id, { text: "corrected", ts: it.ts - 5000 });
    await a.sync.syncNow();
    old.net.up = false;
    await old.sync.restore(it.id); // changes it on the old device while it has not seen the edit
    old.net.up = true;
    await old.sync.syncNow();
    const got = old.sync.allItems().find((i) => i.id === it.id);
    expect(got).toMatchObject({ text: "corrected", ts: it.ts - 5000, removed: false });
    expect(typeof got.edited_at).toBe("number");
    await a.sync.syncNow();
    expect(a.sync.allItems().find((i) => i.id === it.id)).toMatchObject({ text: "corrected", ts: it.ts - 5000 });
  });

  test("an item still on the stack, an unknown id, empty text and non-numbers change nothing", async () => {
    const c = client(server());
    await c.sync.start();
    const live = await c.sync.push("live");
    const done = await finishedItem(c, "done");
    await c.sync.syncNow();
    c.net.bodies.length = 0;
    await c.sync.edit(live.id, { text: "nope", ts: live.ts - 1 });
    await c.sync.edit("s-zzzz", { text: "nope" });
    await c.sync.edit(done.id, { text: "   ", ts: Number.NaN, at: "9" });
    expect(c.sync.allItems().find((i) => i.id === live.id).text).toBe("live");
    expect(c.sync.allItems().find((i) => i.id === done.id)).toMatchObject({ text: "done", ts: done.ts, at: done.at });
    await c.sync.syncNow();
    expect(c.net.bodies).toEqual([]);
  });

  test("the static version edits locally, marks it, and never uses the network", async () => {
    const calls = [];
    const storage = memStorage();
    const sync = createSync({ storage, fetch: async (...a) => (calls.push(a), Promise.reject(new TypeError("no"))), local: true });
    await sync.start();
    const a = await sync.push("one");
    await sync.remove(a.id);
    await sync.edit(a.id, { text: "two", at: a.ts + 5000 });
    const it = sync.allItems()[0];
    expect(it).toMatchObject({ text: "two", at: a.ts + 5000 });
    expect(typeof it.edited_at).toBe("number");
    expect(calls).toEqual([]);
    const again = createSync({ storage, fetch: async () => {}, local: true });
    await again.start();
    expect(again.allItems()[0]).toMatchObject({ text: "two", at: a.ts + 5000 });
  });
});
