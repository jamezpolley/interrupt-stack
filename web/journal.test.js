import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { openStore } from "../server/store";
import { createSync } from "./sync.js";
import { createQueue, stackIdFor } from "./queue.js";
import { createNotes } from "./notes.js";

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function newServer(now) {
  const store = openStore(":memory:", now ? { now } : {});
  const dir = mkdtempSync(join(tmpdir(), "ist-journal-"));
  writeFileSync(join(dir, "index.html"), "x");
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, app: createApp(store, { webDir: dir }) };
}

function memStorage() {
  const actions = new Map();
  let cursor = 0;
  let epoch = null;
  return {
    load: async () => ({ actions: [...actions.values()].map((a) => ({ ...a })), cursor, epoch }),
    putAction: async (a) => void actions.set(a.id, { ...a }),
    deleteAction: async (id) => void actions.delete(id),
    setCursor: async (n) => void (cursor = n),
    setEpoch: async (e) => void (epoch = e),
    _actions: actions,
  };
}

// A shared "network": every client talks to server.current.app; an offline client throws like a device with no signal.
function world(serverNow) {
  const server = { current: newServer(serverNow) };
  const mkClient = (opts = {}) => {
    const ctl = { online: true, loseReply: false };
    const storage = opts.storage ?? memStorage();
    const statuses = [];
    const fetch = async (path, init = {}) => {
      if (!ctl.online) throw new TypeError("network down");
      const res = await server.current.app.fetch(new Request("http://t" + path, init));
      if (ctl.loseReply) {
        ctl.loseReply = false;
        throw new TypeError("reply lost");
      }
      return res;
    };
    const sync = createSync({ storage, fetch, now: opts.now, onChange: opts.onChange, onStatus: (s) => statuses.push(s) });
    const queue = createQueue({ stack: sync, now: opts.now });
    const notes = createNotes({ stack: sync, now: opts.now });
    return { sync, queue, notes, ctl, storage, statuses };
  };
  return { server, mkClient };
}

const served = (w) => Object.values(w.server.current.store.state().items).map((i) => ({ text: i.text, live: i.live, deleted: i.deleted, first: i.intervals[0] }));
const texts = (c) => c.sync.stack().map((i) => i.text);
const started = async (c) => (await c.sync.start(), c);

describe("the journal and the stack over it", () => {
  test("a push shows at once, even offline, and syncs when there is a connection", async () => {
    const w = world();
    const a = w.mkClient();
    a.ctl.online = false;
    await a.sync.start();
    await a.sync.push("first");
    expect(texts(a)).toEqual(["first"]);
    expect(a.sync.status().pending).toBe(1);
    expect(served(w)).toEqual([]);
    a.ctl.online = true;
    await a.sync.syncNow();
    expect(a.sync.status().pending).toBe(0);
    expect(served(w).map((i) => i.text)).toEqual(["first"]);
  });

  test("two devices converge, and each sees what the other did", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const b = await started(w.mkClient());
    await a.sync.push("from a");
    await b.sync.syncNow();
    expect(texts(b)).toEqual(["from a"]);
    await b.sync.push("from b");
    await a.sync.syncNow();
    expect(texts(a).sort()).toEqual(["from a", "from b"]);
    await b.sync.remove(b.sync.stack().find((r) => r.text === "from a").id);
    await a.sync.syncNow();
    expect(texts(a)).toEqual(["from b"]);
    expect(a.sync.allItems().find((r) => r.text === "from a").removed).toBe(true);
  });

  test("several offline changes reach the server one by one, not as one net change", async () => {
    const w = world();
    const a = await started(w.mkClient());
    a.ctl.online = false;
    const p = await a.sync.push("task");
    await a.sync.remove(p.id);
    await a.sync.restore(p.id);
    await a.sync.remove(p.id);
    a.ctl.online = true;
    await a.sync.syncNow();
    expect(w.server.current.store.actions().map((x) => x.kind)).toEqual(["push", "pop", "void", "pop"]);
  });

  test("a reply that was lost is resent and does not make a second copy", async () => {
    const w = world();
    const a = await started(w.mkClient());
    a.ctl.loseReply = true;
    await a.sync.push("once");
    await a.sync.syncNow();
    expect(w.server.current.store.actions()).toHaveLength(1);
    expect(a.sync.status().pending).toBe(0);
    expect(texts(a)).toEqual(["once"]);
  });

  test("swap pops the top and pushes the new one as one change", async () => {
    const w = world();
    const a = await started(w.mkClient());
    await a.sync.push("old");
    const r = await a.sync.swap("new");
    expect(r.removed.text).toBe("old");
    expect(texts(a)).toEqual(["new"]);
  });

  test("undo of a pop is a void: the item never left, with one stay", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const p = await a.sync.push("x");
    await a.sync.remove(p.id);
    expect(texts(a)).toEqual([]);
    await a.sync.restore(p.id);
    expect(texts(a)).toEqual(["x"]);
    expect(a.sync.allItems()).toHaveLength(1);
  });

  test("push again adds a stay to the same item and keeps the earlier one", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const p = await a.sync.push("x");
    await a.sync.remove(p.id);
    const again = await a.sync.pushAgain(p.id);
    expect(again.itemId).toBe(p.id);
    await a.sync.remove(again.id);
    const stays = a.sync.allItems();
    expect(stays.map((r) => r.id)).toEqual([p.id, `${p.id}~1`]);
    expect(stays.every((r) => r.removed)).toBe(true);
    expect(await a.sync.pushAgain(p.id).then((r) => r.id)).toBe(`${p.id}~2`);
    expect(await a.sync.pushAgain(p.id)).toBeNull(); // on the stack already
  });

  test("dropping a buried item flags it; it is popped by itself when it reaches the top, once, even with two devices", async () => {
    let t = 10_000_000;
    const tick = () => (t += 10); // pushes made in the same millisecond have no order, so give each its own
    const w = world(tick);
    const a = await started(w.mkClient({ now: tick }));
    const b = await started(w.mkClient({ now: tick }));
    const one = await a.sync.push("one");
    await a.sync.push("two");
    await a.sync.push("three");
    await a.sync.drop(one.id);
    await a.sync.syncNow();
    expect(texts(a)).toEqual(["three", "two", "one"]); // still on the stack, flagged
    expect(a.sync.stack().find((r) => r.id === one.id).dropped).toBe(true);
    await b.sync.syncNow();
    await a.sync.remove(a.sync.stack()[0].id); // pop three
    await a.sync.remove(a.sync.stack()[0].id); // pop two: "one" reaches the top
    expect(texts(a)).toEqual([]); // and is popped by itself
    await a.sync.syncNow();
    await b.sync.syncNow(); // b notices it too, and makes the same pop
    expect(texts(b)).toEqual([]);
    expect(w.server.current.store.actions().filter((x) => x.kind === "pop" && x.target === one.id)).toHaveLength(1);
  });

  test("undoing the automatic pop of a dropped item brings it back for good", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const one = await a.sync.push("one");
    await a.sync.push("two");
    await a.sync.drop(one.id);
    await a.sync.remove(a.sync.stack()[0].id);
    expect(texts(a)).toEqual([]);
    await a.sync.restore(one.id);
    expect(texts(a)).toEqual(["one"]);
    expect(a.sync.stack()[0].dropped).toBeUndefined();
  });

  test("dropping the top item just pops it", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const p = await a.sync.push("x");
    await a.sync.drop(p.id);
    expect(texts(a)).toEqual([]);
  });

  test("a correction is an action that points at the one it corrects, and the first report stays in the log", async () => {
    let t = 10_000_000;
    const w = world(() => t);
    const a = await started(w.mkClient({ now: () => t }));
    const p = await a.sync.push("old");
    t += 60_000;
    await a.sync.remove(p.id);
    t += 60_000;
    const done = a.sync.allItems()[0];
    const edited = await a.sync.edit(p.id, { text: "new", ts: done.ts - 1000, at: done.at + 5000 });
    expect(edited).toMatchObject({ text: "new", ts: done.ts - 1000, at: done.at + 5000 });
    expect(edited.edited_at).toBeDefined();
    await a.sync.syncNow();
    const log = w.server.current.store.actions();
    expect(log.find((x) => x.kind === "push").at).toBe(done.ts); // never rewritten
    expect(log.filter((x) => x.kind === "edit")).toHaveLength(3);
    expect(served(w)[0]).toMatchObject({ text: "new", first: { start: { at: done.ts - 1000 } } });
  });

  test("an item on the stack can have its title and push time changed, but not an end time", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const p = await a.sync.push("old");
    expect(await a.sync.edit(p.id, { at: 5 })).toBeNull();
    expect((await a.sync.edit(p.id, { ts: p.ts - 60_000 })).ts).toBe(p.ts - 60_000);
    expect((await a.sync.edit(p.id, { text: "new" })).text).toBe("new");
  });

  test("delete hides an item everywhere and undelete brings it back", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const b = await started(w.mkClient());
    const p = await a.sync.push("x");
    await a.sync.delete(p.id);
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.sync.allItems()).toEqual([]);
    expect(b.sync.stack()).toEqual([]);
    expect(b.sync.has(p.id)).toBe(true);
    await a.sync.undelete(p.id);
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(texts(b)).toEqual(["x"]);
  });

  test("an action the server refuses is dropped and reported, and the rest still land", async () => {
    let t = 10_000_000;
    const w = world(() => t);
    const a = await started(w.mkClient({ now: () => t }));
    const p = await a.sync.push("x");
    t += 1000;
    await a.sync.remove(p.id);
    await a.sync.edit(p.id, { at: t + 3_600_000 }); // an hour ahead: refused
    await a.sync.push("fine");
    await a.sync.syncNow();
    expect(a.statuses.some((s) => s.state === "error")).toBe(true);
    expect(a.sync.status().pending).toBe(0);
    expect(a.sync.journal.refused()).toHaveLength(1);
    expect(texts(a)).toEqual(["fine"]);
  });

  test("when the server's database is replaced, the device sends everything it holds so the server is rebuilt", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const p = await a.sync.push("keep");
    await a.sync.push("this too");
    await a.sync.remove(p.id);
    await a.sync.syncNow();
    w.server.current = newServer();
    await a.sync.syncNow();
    await a.sync.syncNow();
    const s = w.server.current.store;
    expect(s.actions().map((x) => x.kind)).toEqual(["push", "push", "pop"]);
    expect(texts(a)).toEqual(["this too"]);
  });

  test("a device that restarts keeps its pending actions and sends them", async () => {
    const w = world();
    const storage = memStorage();
    const a = w.mkClient({ storage });
    a.ctl.online = false;
    await a.sync.start();
    await a.sync.push("unsent");
    const b = w.mkClient({ storage }); // the app is closed and opened again
    await b.sync.start();
    expect(texts(b)).toEqual(["unsent"]);
    await b.sync.syncNow();
    expect(served(w).map((i) => i.text)).toEqual(["unsent"]);
  });

  test("a fresh device downloads everything", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const p = await a.sync.push("x");
    await a.sync.remove(p.id);
    await a.notes.add("hello");
    const b = await started(w.mkClient());
    expect(b.sync.allItems().map((r) => r.text)).toEqual(["x"]);
    expect(b.notes.notes().map((n) => n.text)).toEqual(["hello"]);
  });
});

describe("the Later queue and notes over the journal", () => {
  test("add, drop, restore and start", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const q = await a.queue.add("someday");
    expect(a.queue.queue().map((r) => r.text)).toEqual(["someday"]);
    await a.queue.drop(q.id);
    expect(a.queue.queue()).toEqual([]);
    await a.queue.restore(q.id);
    expect(a.queue.queue()).toHaveLength(1);
    const pushed = await a.queue.promote(q.id);
    expect(pushed.id).toBe(stackIdFor(q.id));
    expect(a.queue.queue()).toEqual([]);
    expect(texts(a)).toEqual(["someday"]);
    expect(await a.queue.restore(q.id)).toBeUndefined(); // a started row is not restorable
  });

  test("starting the same row twice is one push", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const q = await a.queue.add("x");
    await a.queue.promote(q.id);
    await a.queue.promote(q.id);
    expect(a.sync.allItems()).toHaveLength(1);
  });

  test("reconcile finishes a start that was interrupted", async () => {
    const w = world();
    const a = await started(w.mkClient());
    const q = await a.queue.add("x");
    await a.sync.push("x", { id: stackIdFor(q.id) }); // the first half happened, the app died
    expect(a.queue.queue()).toHaveLength(1);
    await a.queue.reconcile();
    expect(a.queue.queue()).toEqual([]);
  });

  test("notes: add, edit text and time, remove, restore", async () => {
    let t = 10_000_000;
    const w = world(() => t);
    const a = await started(w.mkClient({ now: () => t }));
    const n = await a.notes.add("hello");
    t += 1000;
    const e = await a.notes.edit(n.id, { text: "hi", ts: n.ts - 5000 });
    expect(e).toMatchObject({ text: "hi", ts: n.ts - 5000 });
    expect(await a.notes.edit(n.id, { ts: t + 10_000 })).toBeNull(); // not in the future
    await a.notes.remove(n.id);
    expect(a.notes.notes()).toEqual([]);
    await a.notes.restore(n.id);
    expect(a.notes.notes().map((x) => x.text)).toEqual(["hi"]);
    await a.sync.syncNow();
    expect((w.server.current.store.state().notes)[n.id]).toMatchObject({ text: "hi", removed: false, at: n.ts - 5000 });
  });
});

describe("the static version", () => {
  test("nothing is sent, and every action is settled at once", async () => {
    let calls = 0;
    const sync = createSync({ storage: memStorage(), fetch: async () => (calls++, new Response("{}")), local: true });
    await sync.start();
    const p = await sync.push("x");
    await sync.remove(p.id);
    await sync.restore(p.id);
    expect(calls).toBe(0);
    expect(sync.stack().map((r) => r.text)).toEqual(["x"]);
    expect(sync.status()).toMatchObject({ state: "local", pending: 0 });
  });
});
