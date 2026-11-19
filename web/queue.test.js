import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { openStore } from "../server/store";
import { createSync } from "./sync.js";
import { createQueue, stackIdFor } from "./queue.js";
import { completedToday } from "./today.js";

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function newServer() {
  const store = openStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "ist-queue-"));
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
  let lastSeq = 0;
  let epoch = null;
  return {
    load: async () => ({ items: [...items.values()].map((i) => ({ ...i })), dirty: [...dirty], lastSeq, epoch }),
    setEpoch: async (e) => void (epoch = e),
    putItem: async (i) => void items.set(i.id, { ...i }),
    setDirty: async (ids) => void (dirty = [...ids]),
    setLastSeq: async (n) => void (lastSeq = n),
  };
}

// A device: a stack sync and a queue sync over one fake network, each with its own storage.
function world() {
  const server = newServer();
  const mkDevice = (opts = {}) => {
    const ctl = { online: true };
    const stackStorage = opts.stackStorage ?? memStorage();
    const queueStorage = opts.queueStorage ?? memStorage();
    const fetch = async (path, init = {}) => {
      if (!ctl.online) throw new TypeError("network down");
      return server.app.fetch(new Request("http://t" + path, init));
    };
    const stack = createSync({ storage: stackStorage, fetch, now: opts.now });
    const queue = createQueue({ storage: queueStorage, fetch, now: opts.now, stack });
    return { stack, queue, ctl, stackStorage, queueStorage };
  };
  return { server, mkDevice };
}

const qtexts = (d) => d.queue.queue().map((i) => i.text);
const stexts = (d) => d.stack.stack().map((i) => i.text);

describe("queue sync core", () => {
  test("add shows at once, newest on top, and reaches the server without touching the stack", async () => {
    const w = world();
    let t = 1000;
    const a = w.mkDevice({ now: () => t++ });
    await a.stack.start();
    await a.queue.start();
    a.ctl.online = false;
    const p1 = a.queue.add("first");
    expect(qtexts(a)).toEqual(["first"]);
    await p1;
    await a.queue.add("second");
    expect(qtexts(a)).toEqual(["second", "first"]);
    a.ctl.online = true;
    await a.queue.syncNow();
    expect(w.server.store.queueSince(0).items.map((i) => i.text).sort()).toEqual(["first", "second"]);
    expect(w.server.store.since(0).items).toEqual([]);
    expect(stexts(a)).toEqual([]);
  });

  test("empty text adds nothing", async () => {
    const d = world().mkDevice();
    await d.queue.start();
    expect(await d.queue.add("   ")).toBeNull();
    expect(qtexts(d)).toEqual([]);
  });

  test("two devices converge on adds, drops and undo", async () => {
    const w = world();
    const a = w.mkDevice();
    const b = w.mkDevice();
    await a.queue.start();
    await b.queue.start();
    const x = await a.queue.add("x");
    await b.queue.add("y");
    await a.queue.syncNow();
    await b.queue.syncNow();
    expect(qtexts(a).sort()).toEqual(["x", "y"]);
    expect(qtexts(b).sort()).toEqual(["x", "y"]);
    await a.queue.drop(x.id);
    await a.queue.syncNow();
    await b.queue.syncNow();
    expect(qtexts(b)).toEqual(["y"]); // tombstone travelled
    await a.queue.restore(x.id);
    await a.queue.syncNow();
    await b.queue.syncNow();
    expect(qtexts(b).sort()).toEqual(["x", "y"]);
  });

  test("offline changes are kept across a restart and sent later", async () => {
    const w = world();
    const a = w.mkDevice();
    await a.queue.start();
    a.ctl.online = false;
    await a.queue.add("kept");
    const again = w.mkDevice({ queueStorage: a.queueStorage, stackStorage: a.stackStorage });
    await again.queue.start();
    expect(qtexts(again)).toEqual(["kept"]);
    await again.queue.syncNow();
    expect(w.server.store.queueSince(0).items.map((i) => i.text)).toEqual(["kept"]);
  });

  test("a replaced server database gets everything re-sent", async () => {
    const w = world();
    const a = w.mkDevice();
    await a.queue.start();
    await a.queue.add("survivor");
    const fresh = newServer();
    w.server.store = fresh.store;
    w.server.app = fresh.app;
    await a.queue.syncNow();
    await a.queue.syncNow();
    expect(fresh.store.queueSince(0).items.map((i) => i.text)).toEqual(["survivor"]);
  });

  test("an old stack client never sees queue items, and its own writes still work", async () => {
    const w = world();
    const a = w.mkDevice();
    await a.queue.start();
    await a.queue.add("queued only");
    // The stack client from before the queue existed: createSync alone, no queue module.
    const old = createSync({
      storage: memStorage(),
      fetch: (path, init) => w.server.app.fetch(new Request("http://t" + path, init)),
    });
    await old.start();
    expect(old.allItems()).toEqual([]);
    await old.push("old style");
    expect(old.stack().map((i) => i.text)).toEqual(["old style"]);
    expect(w.server.store.since(0).items.map((i) => i.text)).toEqual(["old style"]);
  });
});

describe("start (queue to stack)", () => {
  test("pushes onto the top of the stack with a derived id and tombstones the queue row", async () => {
    const w = world();
    let t = 1000;
    const a = w.mkDevice({ now: () => t++ });
    await a.stack.start();
    await a.queue.start();
    await a.stack.push("current");
    const q = await a.queue.add("later");
    const s = await a.queue.promote(q.id);
    expect(s.id).toBe(stackIdFor(q.id));
    expect(s.id).toBe("s-" + q.id.slice(2));
    expect(stexts(a)).toEqual(["later", "current"]);
    expect(qtexts(a)).toEqual([]);
    await a.stack.syncNow();
    await a.queue.syncNow();
    const row = w.server.store.queueSince(0).items[0];
    expect(row).toMatchObject({ id: q.id, removed: true, started: true });
    expect(w.server.store.since(0).items.map((i) => i.id)).toContain(s.id);
  });

  test("retrying does not duplicate, even after the stack part already happened", async () => {
    const w = world();
    const a = w.mkDevice();
    await a.stack.start();
    await a.queue.start();
    const q = await a.queue.add("later");
    await a.queue.promote(q.id);
    await a.queue.promote(q.id);
    expect(stexts(a)).toEqual(["later"]);
    // Dropping the pushed item and retrying the start must not bring it back.
    await a.stack.remove(stackIdFor(q.id));
    await a.queue.promote(q.id);
    expect(stexts(a)).toEqual([]);
  });

  test("a crash between the two writes is repaired on the next start", async () => {
    const w = world();
    const a = w.mkDevice();
    await a.stack.start();
    await a.queue.start();
    const q = await a.queue.add("later");
    // Part one only: the stack item exists, then the app dies before the queue row is tombstoned.
    await a.stack.push("later", { id: stackIdFor(q.id) });
    const b = w.mkDevice({ stackStorage: a.stackStorage, queueStorage: a.queueStorage });
    await b.stack.start();
    await b.queue.start();
    await b.queue.reconcile();
    expect(qtexts(b)).toEqual([]);
    expect(stexts(b)).toEqual(["later"]);
    await b.queue.syncNow();
    expect(w.server.store.queueSince(0).items[0]).toMatchObject({ removed: true, started: true });
    expect(w.server.store.since(0).items).toHaveLength(1);
  });

  test("starting on one device while another still shows the row converges to one stack item", async () => {
    const w = world();
    const a = w.mkDevice();
    const b = w.mkDevice();
    for (const d of [a, b]) {
      await d.stack.start();
      await d.queue.start();
    }
    const q = await a.queue.add("later");
    await b.queue.syncNow();
    await a.queue.promote(q.id);
    await b.queue.promote(q.id); // b has not heard of a's start yet
    for (const d of [a, b]) {
      await d.stack.syncNow();
      await d.queue.syncNow();
    }
    expect(stexts(a)).toEqual(["later"]);
    expect(stexts(b)).toEqual(["later"]);
    expect(qtexts(a)).toEqual([]);
    expect(qtexts(b)).toEqual([]);
    expect(w.server.store.since(0).items).toHaveLength(1);
  });

  test("a dropped item is not in Done today; a started and popped one is", async () => {
    const w = world();
    const a = w.mkDevice();
    await a.stack.start();
    await a.queue.start();
    const dropped = await a.queue.add("never started");
    const kept = await a.queue.add("started");
    await a.queue.drop(dropped.id);
    await a.queue.promote(kept.id);
    await a.stack.remove(stackIdFor(kept.id));
    const done = completedToday(a.stack.allItems(), Date.now());
    expect(done.map((i) => i.text)).toEqual(["started"]);
  });

  test("the server log has queue, dequeue, start and the stack push, in one history", async () => {
    const w = world();
    const a = w.mkDevice();
    await a.stack.start();
    await a.queue.start();
    const d = await a.queue.add("drop me");
    const s = await a.queue.add("start me");
    await a.queue.drop(d.id);
    await a.queue.promote(s.id);
    await a.stack.syncNow();
    await a.queue.syncNow();
    const ops = w.server.store.log().map((e) => [e.op, e.id]).sort((x, y) => (x.join() < y.join() ? -1 : 1));
    expect(ops).toEqual(
      [
        ["queue", d.id],
        ["dequeue", d.id],
        ["queue", s.id],
        ["start", s.id],
        ["push", stackIdFor(s.id)],
      ].sort((x, y) => (x.join() < y.join() ? -1 : 1)),
    );
  });
});

describe("local only (static version)", () => {
  test("works with no network calls at all", async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      throw new Error("no network in the static version");
    };
    const stack = createSync({ storage: memStorage(), fetch, local: true });
    const queue = createQueue({ storage: memStorage(), fetch, local: true, stack });
    await stack.start();
    await queue.start();
    const a = await queue.add("a");
    const b = await queue.add("b");
    await queue.drop(a.id);
    await queue.restore(a.id);
    await queue.promote(b.id);
    await queue.syncNow();
    expect(queue.queue().map((i) => i.text)).toEqual(["a"]);
    expect(stack.stack().map((i) => i.text)).toEqual(["b"]);
    expect(queue.status()).toEqual({ state: "local", pending: 0 });
    expect(calls).toBe(0);
  });

  test("survives a restart from its own storage", async () => {
    const qs = memStorage();
    const ss = memStorage();
    const fetch = async () => {
      throw new Error("no network");
    };
    const stack = createSync({ storage: ss, fetch, local: true });
    const queue = createQueue({ storage: qs, fetch, local: true, stack });
    await stack.start();
    await queue.start();
    await queue.add("persisted");
    const queue2 = createQueue({ storage: qs, fetch, local: true, stack });
    await queue2.start();
    expect(queue2.queue().map((i) => i.text)).toEqual(["persisted"]);
  });
});

describe("queue storage failure", () => {
  test("keeps working in memory and reports it", async () => {
    const bad = { ...memStorage(), putItem: async () => { throw new Error("quota"); } };
    const fetch = async () => { throw new TypeError("down"); };
    const stack = createSync({ storage: memStorage(), fetch, local: true });
    const queue = createQueue({ storage: bad, fetch, local: true, stack });
    await queue.start();
    await queue.add("x");
    expect(queue.queue().map((i) => i.text)).toEqual(["x"]);
    expect(queue.status().storageFailed).toBe(true);
  });
});
