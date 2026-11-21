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

function newServer() {
  const store = openStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "ist-sync-"));
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

// One shared "network": clients call server.current.app; `down` clients throw like an offline device.
function world() {
  const server = { current: newServer() };
  const mkClient = (opts = {}) => {
    const ctl = { online: true, hook: null, intercept: null };
    const storage = opts.storage ?? memStorage();
    const statuses = [];
    const fetch = async (path, init = {}) => {
      if (!ctl.online) throw new TypeError("network down");
      const forced = ctl.intercept?.(path, init);
      if (forced) return forced;
      if (ctl.hook) {
        const h = ctl.hook;
        ctl.hook = null;
        await h();
      }
      // `ctl.refuse(text)`: the server refuses a change with that text the way it refuses an invalid row (per change, in a 200).
      if (ctl.refuse && path === "/api/sync") {
        const body = JSON.parse(init.body);
        const refused = {};
        for (const [id, c] of Object.entries(body.changes.items ?? {})) if (ctl.refuse(c.text)) (refused[id] = { error: "nope" }, delete body.changes.items[id]);
        const res = await server.current.app.fetch(new Request("http://t" + path, { ...init, body: JSON.stringify(body) }));
        const data = await res.json();
        Object.assign(data.tables.items.rejected, refused);
        return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
      }
      return server.current.app.fetch(new Request("http://t" + path, init));
    };
    const sync = createSync({ storage, fetch, now: opts.now, onChange: opts.onChange, onStatus: (s) => statuses.push(s) });
    return { sync, ctl, storage, statuses };
  };
  return { server, mkClient };
}

const texts = (c) => c.sync.stack().map((i) => i.text);

describe("sync core", () => {
  test("push shows on stack immediately", async () => {
    const w = world();
    const a = w.mkClient();
    a.ctl.online = false;
    await a.sync.start();
    const p = a.sync.push("first");
    expect(texts(a)).toEqual(["first"]);
    await p;
  });

  test("push syncs to the server", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    await a.sync.push("hello");
    await a.sync.syncNow();
    const rows = w.server.current.store.since(0).items;
    expect(rows.map((r) => r.text)).toEqual(["hello"]);
    expect(a.sync.status()).toEqual({ state: "synced", pending: 0 });
  });

  test("two clients converge after push on A and syncNow on B", async () => {
    const w = world();
    const a = w.mkClient();
    const b = w.mkClient();
    await a.sync.start();
    await b.sync.start();
    await a.sync.push("from A");
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(texts(b)).toEqual(["from A"]);
  });

  test("remove on A disappears from B", async () => {
    const w = world();
    const a = w.mkClient();
    const b = w.mkClient();
    await a.sync.start();
    await b.sync.start();
    const item = await a.sync.push("gone soon");
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.remove(item.id);
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(texts(b)).toEqual([]);
  });

  test("restore after remove reappears on both", async () => {
    const w = world();
    const a = w.mkClient();
    const b = w.mkClient();
    await a.sync.start();
    await b.sync.start();
    const item = await a.sync.push("back again");
    await a.sync.remove(item.id);
    await a.sync.restore(item.id);
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(texts(a)).toEqual(["back again"]);
    expect(texts(b)).toEqual(["back again"]);
  });

  test("concurrent remove on A and restore on B converge to the same state on both after syncing", async () => {
    const w = world();
    const a = w.mkClient();
    const b = w.mkClient();
    await a.sync.start();
    await b.sync.start();
    const item = await a.sync.push("contested");
    await a.sync.syncNow();
    await b.sync.syncNow();
    a.ctl.online = false;
    b.ctl.online = false;
    await a.sync.remove(item.id);
    await b.sync.remove(item.id);
    await b.sync.restore(item.id);
    a.ctl.online = true;
    b.ctl.online = true;
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(texts(a)).toEqual(texts(b));
    expect(texts(a)).toEqual(["contested"]); // B's write reached the server last
  });

  test("push then remove while offline sends one removed row after reconnect", async () => {
    const w = world();
    const a = w.mkClient();
    const b = w.mkClient();
    await a.sync.start();
    await b.sync.start();
    a.ctl.online = false;
    const item = await a.sync.push("blink");
    await a.sync.remove(item.id);
    expect(a.sync.status()).toEqual({ state: "offline", pending: 1, error: { kind: "unreachable" } });
    a.ctl.online = true;
    await a.sync.syncNow();
    await b.sync.syncNow();
    const rows = w.server.current.store.since(0).items;
    expect(rows).toHaveLength(1);
    expect(rows[0].removed).toBe(true);
    expect(texts(a)).toEqual([]);
    expect(texts(b)).toEqual([]);
  });

  test("offline push survives a new createSync from the same storage", async () => {
    const w = world();
    const storage = memStorage();
    const a1 = w.mkClient({ storage });
    a1.ctl.online = false;
    await a1.sync.start();
    await a1.sync.push("kept offline");
    const a2 = w.mkClient({ storage });
    await a2.sync.start();
    expect(texts(a2)).toEqual(["kept offline"]);
    await a2.sync.syncNow();
    expect(w.server.current.store.since(0).items.map((r) => r.text)).toEqual(["kept offline"]);
  });

  test("failed PUT keeps the item dirty and status offline", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    a.ctl.online = false;
    await a.sync.push("pending one");
    await a.sync.syncNow();
    expect(a.sync.status()).toEqual({ state: "offline", pending: 1, error: { kind: "unreachable" } });
    expect((await a.storage.load()).dirty).toHaveLength(1);
  });

  test("status pending equals dirty count", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    a.ctl.online = false;
    await a.sync.push("one");
    await a.sync.push("two");
    await a.sync.syncNow();
    expect(a.sync.status().pending).toBe(2);
    a.ctl.online = true;
    await a.sync.syncNow();
    expect(a.sync.status()).toEqual({ state: "synced", pending: 0 });
  });

  test("server database replaced (new store) triggers full re-send and both clients converge", async () => {
    const w = world();
    const a = w.mkClient();
    const b = w.mkClient();
    await a.sync.start();
    await b.sync.start();
    await a.sync.push("survivor");
    await a.sync.syncNow();
    await b.sync.syncNow();
    w.server.current = newServer(); // empty database, seq back to 0
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(w.server.current.store.since(0).items.map((r) => r.text)).toEqual(["survivor"]);
    expect(texts(a)).toEqual(["survivor"]);
    expect(texts(b)).toEqual(["survivor"]);
  });

  test("whitespace push returns null and changes nothing", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    expect(await a.sync.push("   ")).toBeNull();
    expect(a.sync.stack()).toEqual([]);
    expect(a.sync.status().pending).toBe(0);
  });

  test("stack orders by ts newest first", async () => {
    const w = world();
    let t = 1000;
    const a = w.mkClient({ now: () => t++ });
    await a.sync.start();
    await a.sync.push("one");
    await a.sync.push("two");
    await a.sync.push("three");
    expect(texts(a)).toEqual(["three", "two", "one"]);
  });

  test("pulled row does not overwrite a locally dirty item", async () => {
    const w = world();
    const a = w.mkClient();
    const b = w.mkClient();
    await a.sync.start();
    await b.sync.start();
    const item = await a.sync.push("race");
    await a.sync.syncNow();
    await b.sync.syncNow();
    // While B is mid-sync (its pull is in flight), B removes the item locally.
    b.ctl.hook = async () => {
      await b.sync.remove(item.id);
    };
    await a.sync.push("poke"); // gives B's next pull something to fetch
    await a.sync.syncNow();
    await b.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(texts(b)).toEqual(["poke"]);
    const row = w.server.current.store.since(0).items.find((r) => r.id === item.id);
    expect(row.removed).toBe(true);
    expect(texts(a)).toEqual(["poke"]);
  });
});

const serverTexts = (w) => w.server.current.store.since(0).items.map((r) => r.text).sort();

describe("server replacement", () => {
  test("a replaced server still receives items the client already synced, even when the client has unsent items", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    await a.sync.push("X");
    await a.sync.push("Y");
    await a.sync.syncNow();
    w.server.current = newServer();
    a.ctl.online = false;
    await a.sync.push("P");
    await a.sync.push("Q");
    a.ctl.online = true;
    await a.sync.syncNow();
    await a.sync.syncNow();
    expect(serverTexts(w)).toEqual(["P", "Q", "X", "Y"]);
  });

  test("a replaced server refilled by another device past this client's seq still receives this client's items", async () => {
    const w = world();
    const a = w.mkClient();
    const b = w.mkClient();
    await a.sync.start();
    await b.sync.start();
    await a.sync.push("X");
    await a.sync.push("Y");
    await a.sync.syncNow();
    w.server.current = newServer();
    for (const t of ["b1", "b2", "b3", "b4", "b5"]) await b.sync.push(t);
    await b.sync.syncNow();
    await a.sync.syncNow();
    await a.sync.syncNow();
    expect(serverTexts(w)).toEqual(["X", "Y", "b1", "b2", "b3", "b4", "b5"]);
  });
});

describe("failing requests", () => {
  const rejectBad = (text) => text === "bad";

  test("one item the server rejects does not block the others or the pull", async () => {
    const w = world();
    const a = w.mkClient();
    const b = w.mkClient();
    await a.sync.start();
    await b.sync.start();
    a.ctl.refuse = rejectBad;
    await a.sync.push("bad");
    await a.sync.push("good");
    await a.sync.syncNow();
    expect(serverTexts(w)).toEqual(["good"]);
    expect(a.sync.status()).toEqual({ state: "error", pending: 1, error: { kind: "client-error", status: 400 } });
    await b.sync.push("from B");
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(texts(a)).toContain("from B");
  });

  test("a rejected item is kept and sent once the server accepts it", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    a.ctl.refuse = rejectBad;
    await a.sync.push("bad");
    await a.sync.syncNow();
    a.ctl.refuse = null;
    await a.sync.syncNow();
    expect(serverTexts(w)).toEqual(["bad"]);
    expect(a.sync.status()).toEqual({ state: "synced", pending: 0 });
  });

  test("a server error (5xx) is still reported as offline, not as a rejection", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    a.ctl.intercept = (path, init) => (path === "/api/sync" ? new Response("bad gateway", { status: 502 }) : null);
    await a.sync.push("kept");
    await a.sync.syncNow();
    expect(a.sync.status()).toEqual({ state: "offline", pending: 1, error: { kind: "server-error", status: 502 } });
  });
});

describe("local storage failure", () => {
  test("a push still shows and syncs when the device storage rejects the write", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    a.storage.putItem = async () => {
      throw new Error("QuotaExceededError");
    };
    const item = await a.sync.push("kept in memory");
    expect(item?.text).toBe("kept in memory");
    expect(texts(a)).toEqual(["kept in memory"]);
    await a.sync.syncNow();
    expect(serverTexts(w)).toEqual(["kept in memory"]);
    expect(a.sync.status().storageFailed).toBe(true);
    expect(a.sync.status().state).toBe("synced");
  });

  test("start still works, with an empty stack, when the device storage cannot be read", async () => {
    const w = world();
    const storage = memStorage();
    storage.load = async () => {
      throw new Error("InvalidStateError");
    };
    const a = w.mkClient({ storage });
    await a.sync.start();
    expect(a.sync.status().storageFailed).toBe(true);
    await a.sync.push("after a failed load");
    await a.sync.syncNow();
    expect(texts(a)).toEqual(["after a failed load"]);
    expect(serverTexts(w)).toEqual(["after a failed load"]);
    expect(a.sync.status().storageFailed).toBeUndefined(); // storage works again, so the flag cleared
  });
});


describe("event log from the client", () => {
  // The in-process server uses the real clock, so the client clock must sit in the past or it would be clamped.
  const base = Date.now() - 10 * 60_000;
  const clock = () => {
    const c = { t: base };
    c.now = () => c.t;
    return c;
  };
  const log = (w) => w.server.current.store.log();

  test("push, remove and restore reach the log in order, stamped with the device's clock", async () => {
    const w = world();
    const c = clock();
    const a = w.mkClient({ now: c.now });
    await a.sync.start();
    const item = await a.sync.push("write report");
    await a.sync.syncNow();
    c.t = base + 30_000;
    await a.sync.remove(item.id);
    await a.sync.syncNow();
    c.t = base + 45_000;
    await a.sync.restore(item.id);
    await a.sync.syncNow();
    expect(log(w).map((e) => [e.op, e.at])).toEqual([
      ["push", base],
      ["pop", base + 30_000],
      ["restore", base + 45_000],
    ]);
  });

  test("a pop made offline is logged with the time it happened, not the time it synced", async () => {
    const w = world();
    const c = clock();
    const a = w.mkClient({ now: c.now });
    await a.sync.start();
    const item = await a.sync.push("phone call");
    await a.sync.syncNow();
    a.ctl.online = false;
    c.t = base + 120_000;
    await a.sync.remove(item.id);
    await a.sync.syncNow();
    expect(log(w).map((e) => e.op)).toEqual(["push"]);
    a.ctl.online = true;
    await a.sync.syncNow();
    const pop = log(w)[1];
    expect(pop.op).toBe("pop");
    expect(pop.at).toBe(base + 120_000);
    expect(pop.ts).toBeGreaterThan(pop.at);
  });

  test("items resent to a replaced server keep their original event times", async () => {
    const w = world();
    const c = clock();
    const a = w.mkClient({ now: c.now });
    await a.sync.start();
    const item = await a.sync.push("survives a rebuild");
    c.t = base + 50_000;
    await a.sync.remove(item.id);
    await a.sync.syncNow();
    w.server.current = newServer();
    await a.sync.syncNow();
    expect(log(w).map((e) => [e.op, e.at])).toEqual([
      ["push", base],
      ["pop", base + 50_000],
    ]);
  });
});

describe("swap", () => {
  test("pops the current item and pushes the new one, and both reach the server", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    await a.sync.push("meeting");
    const result = await a.sync.swap("lunch");
    await a.sync.syncNow();
    expect(texts(a)).toEqual(["lunch"]);
    expect(result.removed.text).toBe("meeting");
    expect(result.pushed.text).toBe("lunch");
    const rows = w.server.current.store.since(0).items;
    expect(rows.map((r) => [r.text, r.removed]).sort()).toEqual([["lunch", false], ["meeting", true]]);
    const events = w.server.current.store.log().map((e) => `${e.op} ${e.text}`);
    expect(events.sort()).toEqual(["pop meeting", "push lunch", "push meeting"]);
  });

  test("the screen never sees the empty stack between the pop and the push", async () => {
    const w = world();
    const seen = [];
    let a;
    a = w.mkClient({ onChange: () => seen.push(a.sync.stack().map((i) => i.text)) });
    await a.sync.start();
    await a.sync.push("meeting");
    seen.length = 0;
    await a.sync.swap("lunch");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((stack) => stack.length === 1 && stack[0] === "lunch")).toBe(true);
  });

  test("on an empty stack it simply pushes", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    const result = await a.sync.swap("first thing");
    expect(texts(a)).toEqual(["first thing"]);
    expect(result.removed).toBeNull();
  });

  test("whitespace text changes nothing, in particular it does not pop", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    await a.sync.push("meeting");
    expect(await a.sync.swap("   ")).toBeNull();
    expect(texts(a)).toEqual(["meeting"]);
  });

  test("made offline, both changes are kept and sent together later", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    await a.sync.push("meeting");
    await a.sync.syncNow();
    a.ctl.online = false;
    await a.sync.swap("lunch");
    expect(a.sync.status().pending).toBe(2);
    a.ctl.online = true;
    await a.sync.syncNow();
    expect(a.sync.status()).toEqual({ state: "synced", pending: 0 });
    const rows = w.server.current.store.since(0).items;
    expect(rows.map((r) => [r.text, r.removed]).sort()).toEqual([["lunch", false], ["meeting", true]]);
  });
});

describe("local-only mode", () => {
  // A fetch that fails the test if it is ever called.
  const noNetwork = (calls) => async (path) => {
    calls.push(path);
    throw new Error("local-only mode must not touch the network");
  };

  test("makes no network calls at all, however it is used", async () => {
    const calls = [];
    const sync = createSync({ storage: memStorage(), fetch: noNetwork(calls), local: true });
    await sync.start();
    const a = await sync.push("one");
    await sync.swap("two");
    await sync.remove(a.id);
    await sync.restore(a.id);
    await sync.syncNow();
    expect(calls).toEqual([]);
  });

  test("the stack works: push, swap, remove and restore", async () => {
    let t = 1_000_000;
    const sync = createSync({ storage: memStorage(), fetch: noNetwork([]), local: true, now: () => (t += 1000) });
    await sync.start();
    const a = await sync.push("meeting");
    expect(sync.stack().map((i) => i.text)).toEqual(["meeting"]);
    await sync.swap("lunch");
    expect(sync.stack().map((i) => i.text)).toEqual(["lunch"]);
    await sync.restore(a.id);
    expect(sync.stack().map((i) => i.text)).toEqual(["lunch", "meeting"]);
  });

  test("status is local with nothing pending, from the start", async () => {
    const seen = [];
    const sync = createSync({ storage: memStorage(), fetch: noNetwork([]), local: true, onStatus: (s) => seen.push(s) });
    expect(sync.status()).toEqual({ state: "local", pending: 0 });
    await sync.start();
    await sync.push("x");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.state === "local" && s.pending === 0)).toBe(true);
  });

  test("the stack is kept on the device across a restart", async () => {
    const storage = memStorage();
    const first = createSync({ storage, fetch: noNetwork([]), local: true });
    await first.start();
    await first.push("kept");
    const second = createSync({ storage, fetch: noNetwork([]), local: true });
    await second.start();
    expect(second.stack().map((i) => i.text)).toEqual(["kept"]);
  });

  test("nothing is queued to send, so nothing waits to be sent if the app later gains a server", async () => {
    const storage = memStorage();
    const sync = createSync({ storage, fetch: noNetwork([]), local: true });
    await sync.start();
    await sync.push("x");
    expect((await storage.load()).dirty).toEqual([]);
  });
});


describe("push again (origin)", () => {
  test("push with an origin keeps it on the item, in storage, and sends it", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    const first = await a.sync.push("write report");
    await a.sync.remove(first.id);
    const again = await a.sync.push("write report", { origin: first.id });
    expect(again.origin).toBe(first.id);
    expect(again.id).not.toBe(first.id);
    expect((await a.storage.load()).items.find((i) => i.id === again.id).origin).toBe(first.id);
    await a.sync.syncNow();
    expect(w.server.current.store.since(0).items.find((r) => r.id === again.id).origin).toBe(first.id);
    expect(a.sync.stack().map((i) => i.id)).toEqual([again.id]);
  });

  test("a push without an origin sends none and the item has none", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    const it = await a.sync.push("plain");
    await a.sync.syncNow();
    expect("origin" in it).toBe(false);
    expect("origin" in w.server.current.store.since(0).items[0]).toBe(false);
  });

  test("the origin survives popping the clone and a round trip to another device", async () => {
    const w = world();
    const a = w.mkClient();
    const b = w.mkClient();
    await a.sync.start();
    await b.sync.start();
    const first = await a.sync.push("x");
    await a.sync.remove(first.id);
    const again = await a.sync.push("x", { origin: first.id });
    await a.sync.syncNow();
    await a.sync.remove(again.id);
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.sync.allItems().find((i) => i.id === again.id)).toMatchObject({ removed: true, origin: first.id });
    expect(a.sync.allItems().find((i) => i.id === again.id).origin).toBe(first.id);
  });

  test("works offline: kept locally, then sent when the connection returns", async () => {
    const w = world();
    const a = w.mkClient();
    await a.sync.start();
    const first = await a.sync.push("x");
    await a.sync.syncNow();
    await a.sync.remove(first.id);
    a.ctl.online = false;
    const again = await a.sync.push("x", { origin: first.id });
    a.ctl.online = true;
    await a.sync.syncNow();
    expect(w.server.current.store.since(0).items.find((r) => r.id === again.id).origin).toBe(first.id);
  });

  test("local-only mode keeps it without any network use", async () => {
    let calls = 0;
    const sync = createSync({ storage: memStorage(), fetch: async () => void calls++, local: true });
    await sync.start();
    const first = await sync.push("x");
    await sync.remove(first.id);
    const again = await sync.push("x", { origin: first.id });
    expect(again.origin).toBe(first.id);
    expect(calls).toBe(0);
  });
});
