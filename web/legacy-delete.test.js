import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { openStore } from "../server/store";
import { createSync } from "./legacy-sync.js";
import { createNotes } from "./legacy-notes.js";
import { completedToday } from "./today.js";
import { timeOnTop, timeline } from "./times.js";
import { pushAgain } from "./legacy-again.js";

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

function newServer() {
  const store = openStore(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "ist-del-"));
  writeFileSync(join(dir, "index.html"), "x");
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, app: createApp(store, { webDir: dir }) };
}
function memStorage() {
  const items = new Map();
  let dirty = [], cursor = 0, epoch = null;
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
    const ctl = { online: true, bodies: [] };
    const fetch = async (path, init = {}) => {
      if (!ctl.online) throw new TypeError("network down");
      if (init.body) ctl.bodies.push(JSON.parse(init.body));
      return server.app.fetch(new Request("http://t" + path, init));
    };
    const stack = createSync({ storage: memStorage(), fetch, now: opts.now, local: opts.local });
    const notes = createNotes({ storage: memStorage(), now: opts.now, stack });
    return { stack, notes, ctl };
  };
  return { server, mkDevice };
}
const texts = (d) => d.stack.stack().map((i) => i.text);

describe("deleting a stack item", () => {
  test("a live item disappears from the stack and from allItems at once, and undo brings it back", async () => {
    const d = world().mkDevice();
    await d.stack.start();
    await d.stack.push("keep");
    const oops = await d.stack.push("oops");
    await d.stack.delete(oops.id);
    expect(texts(d)).toEqual(["keep"]);
    expect(d.stack.allItems().map((i) => i.text)).toEqual(["keep"]);
    await d.stack.undelete(oops.id);
    expect(texts(d)).toEqual(["oops", "keep"]);
  });

  test("a finished item disappears from Done today", async () => {
    let t = 1_000_000_000_000;
    const d = world().mkDevice({ now: () => t });
    await d.stack.start();
    const a = await d.stack.push("a");
    t += 1000;
    await d.stack.remove(a.id);
    expect(completedToday(d.stack.allItems(), t).map((i) => i.text)).toEqual(["a"]);
    await d.stack.delete(a.id);
    expect(completedToday(d.stack.allItems(), t)).toEqual([]);
  });

  test("a deleted item that sat on top adds no on-top time to the one underneath: as if never pushed", async () => {
    let t = 1_000_000_000_000;
    const d = world().mkDevice({ now: () => t });
    await d.stack.start();
    const base = await d.stack.push("base");
    t += 10 * 60_000;
    const oops = await d.stack.push("oops");
    t += 20 * 60_000;
    await d.stack.remove(oops.id);
    t += 10 * 60_000;
    await d.stack.remove(base.id);
    const before = d.stack.allItems();
    const baseBefore = before.find((i) => i.id === base.id);
    expect(timeOnTop(baseBefore, before)).toBe(20 * 60_000); // 40 minutes minus the 20 oops sat above
    await d.stack.delete(oops.id);
    const after = d.stack.allItems();
    const baseAfter = after.find((i) => i.id === base.id);
    expect(timeOnTop(baseAfter, after)).toBe(40 * 60_000);
    expect(timeline(baseAfter, after).rows.map((r) => r.kind)).toEqual(["pushed", "popped"]);
  });

  test("a deleted item is not editable and cannot be pushed again", async () => {
    let t = 1_000_000_000_000;
    const d = world().mkDevice({ now: () => t });
    await d.stack.start();
    const a = await d.stack.push("a");
    t += 1000;
    await d.stack.remove(a.id);
    await d.stack.delete(a.id);
    expect(await d.stack.edit(a.id, { text: "b" })).toBeNull();
    expect(await pushAgain(d.stack, a.id)).toBeNull();
    expect(d.stack.has(a.id)).toBe(true); // still known, so a queue start never pushes it twice
  });

  test("it syncs: the server flags it, a second device drops it, and an undo goes the same way", async () => {
    const w = world();
    const a = w.mkDevice();
    const b = w.mkDevice();
    await a.stack.start();
    await b.stack.start();
    const x = await a.stack.push("oops");
    await a.stack.syncNow();
    await b.stack.syncNow();
    expect(texts(b)).toEqual(["oops"]);
    await a.stack.delete(x.id);
    await a.stack.syncNow();
    await b.stack.syncNow();
    expect(texts(b)).toEqual([]);
    expect(w.server.store.counts()).toEqual({ live: 0, removed: 0 });
    expect(w.server.store.log().map((e) => e.op)).toEqual(["push", "delete"]);
    await a.stack.undelete(x.id);
    await a.stack.syncNow();
    await b.stack.syncNow();
    expect(texts(b)).toEqual(["oops"]);
    expect(w.server.store.log().map((e) => e.op)).toEqual(["push", "delete", "undelete"]);
  });

  test("ordinary writes leave `deleted` out; only a delete sends true and an undo sends false", async () => {
    const w = world();
    const d = w.mkDevice();
    await d.stack.start();
    const x = await d.stack.push("x");
    await d.stack.syncNow();
    const sent = () => d.ctl.bodies.filter((b) => b.changes?.items?.[x.id]).at(-1).changes.items[x.id];
    await d.stack.remove(x.id);
    await d.stack.syncNow();
    expect("deleted" in sent()).toBe(false);
    await d.stack.delete(x.id);
    await d.stack.syncNow();
    expect(sent().deleted).toBe(true);
    await d.stack.undelete(x.id);
    await d.stack.syncNow();
    expect(sent().deleted).toBe(false);
  });

  test("a delete made offline is kept and sent later", async () => {
    const w = world();
    const d = w.mkDevice();
    await d.stack.start();
    const x = await d.stack.push("x");
    await d.stack.syncNow();
    d.ctl.online = false;
    await d.stack.delete(x.id);
    expect(texts(d)).toEqual([]);
    d.ctl.online = true;
    await d.stack.syncNow();
    expect(w.server.store.counts()).toEqual({ live: 0, removed: 0 });
  });

  test("local-only: deleted on the device, nothing sent", async () => {
    const w = world();
    const d = w.mkDevice({ local: true });
    await d.stack.start();
    const x = await d.stack.push("x");
    await d.stack.delete(x.id);
    expect(texts(d)).toEqual([]);
    expect(w.server.store.log()).toEqual([]);
  });

  test("deleting something unknown or already deleted does nothing", async () => {
    const d = world().mkDevice();
    await d.stack.start();
    const x = await d.stack.push("x");
    expect(await d.stack.delete("s-nope")).toBeNull();
    await d.stack.delete(x.id);
    expect(await d.stack.delete(x.id)).toBeNull();
    expect(await d.stack.undelete("s-nope")).toBeNull();
  });
});

describe("deleting a note", () => {
  test("remove hides it, restore brings it back, both sync and log", async () => {
    const w = world();
    const d = w.mkDevice();
    await Promise.all([d.stack.start(), d.notes.start()]);
    const n = await d.notes.add("oops");
    await d.stack.syncNow();
    await d.notes.remove(n.id);
    expect(d.notes.notes()).toEqual([]);
    await d.stack.syncNow();
    await d.notes.restore(n.id);
    expect(d.notes.notes().map((x) => x.text)).toEqual(["oops"]);
    await d.stack.syncNow();
    expect(w.server.store.log().map((e) => e.op)).toEqual(["note", "delete", "undelete"]);
  });
});
