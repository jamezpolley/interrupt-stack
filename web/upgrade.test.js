import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app";
import { openStore } from "../server/store";
import { actionsFromRows, upgradeFromRows } from "./upgrade.js";
import { createSync } from "./sync.js";

const cleanup = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()();
});

// An old row storage (the shape legacy-sync.js uses) holding some rows and a list of ids not yet sent.
const oldStorage = (items = [], dirty = []) => ({
  load: async () => ({ items: items.map((i) => ({ ...i })), dirty: [...dirty], cursor: 0, epoch: null }),
  putItem: async (i) => void items.push({ ...i }),
  setDirty: async (d) => void (dirty = [...d]),
  setCursor: async () => {},
  setEpoch: async () => {},
});
const meta = () => {
  const m = new Map();
  return { getMeta: async (k, f) => m.get(k) ?? f, putMeta: async (k, v) => void m.set(k, v), _m: m };
};
const journalStorage = () => {
  const actions = new Map();
  return { load: async () => ({ actions: [...actions.values()], cursor: 0, epoch: null }), putAction: async (a) => void actions.set(a.id, a), deleteAction: async (id) => void actions.delete(id), setCursor: async () => {}, setEpoch: async () => {} };
};

describe("actionsFromRows", () => {
  test("rows become the actions that explain them, with ids derived from the rows", () => {
    const acts = actionsFromRows({
      items: [{ id: "s-a", text: "done", ts: 100, at: 200, removed: true, origin: "s-z" }, { id: "s-b", text: "live", ts: 300, at: 300, removed: false, deleted: true }],
      notes: [{ id: "n-a", text: "note", ts: 50, removed: false }],
      queue: [{ id: "q-a", text: "later", ts: 10, at: 20, removed: true, started: true }],
    });
    expect(acts.map((a) => [a.id, a.kind, a.target, a.at])).toEqual([
      ["imp-s-a-push", "push", "s-a", 100],
      ["imp-s-a-pop", "pop", "s-a", 200],
      ["imp-s-b-push", "push", "s-b", 300],
      ["imp-s-b-delete", "delete", "s-b", 300],
      ["imp-n-a-note", "note", "n-a", 50],
      ["imp-q-a-later", "later", "q-a", 10],
      ["imp-q-a-leave", "start", "q-a", 20],
    ]);
    expect(acts[0].data).toEqual({ text: "done", origin: "s-z" });
  });
});

describe("upgradeFromRows", () => {
  test("a device with nothing in its old databases is marked done and does nothing", async () => {
    const m = meta();
    expect(await upgradeFromRows({ old: { stack: oldStorage(), queue: oldStorage(), notes: oldStorage() }, meta: m, fetch: async () => { throw new Error("no network use"); } })).toBe("done");
    expect(await m.getMeta("legacyDone")).toBe(true);
  });

  test("the static version turns its rows into journal actions, once", async () => {
    const m = meta();
    const sync = createSync({ storage: journalStorage(), fetch: async () => { throw new Error("no"); }, local: true });
    await sync.start();
    const old = { stack: oldStorage([{ id: "s-a", text: "kept", ts: 100, at: 200, removed: true }, { id: "s-b", text: "on the stack", ts: 300, at: 300, removed: false }]), queue: oldStorage(), notes: oldStorage() };
    expect(await upgradeFromRows({ old, meta: m, journal: sync.journal, fetch: async () => {}, local: true })).toBe("imported");
    expect(sync.stack().map((r) => r.text)).toEqual(["on the stack"]);
    expect(sync.allItems().map((r) => r.text).sort()).toEqual(["kept", "on the stack"]);
    expect(await upgradeFromRows({ old, meta: m, journal: sync.journal, fetch: async () => {}, local: true })).toBe("done");
  });

  test("a server device sends what it had not sent, over the old wire, and is then done", async () => {
    const store = openStore(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "ist-up-"));
    writeFileSync(join(dir, "index.html"), "x");
    cleanup.push(() => (store.close(), rmSync(dir, { recursive: true, force: true })));
    const app = createApp(store, { webDir: dir });
    const fetch = (path, init) => app.fetch(new Request("http://t" + path, init));
    const m = meta();
    const old = { stack: oldStorage([{ id: "s-unsent", text: "made offline", ts: 1000, at: 1000, removed: false, seq: 0 }], ["s-unsent"]), queue: oldStorage(), notes: oldStorage() };
    expect(await upgradeFromRows({ old, meta: m, fetch })).toBe("sent");
    expect(store.since(0).items.map((i) => i.text)).toEqual(["made offline"]);
    expect(store.actions().map((a) => a.kind)).toEqual(["push"]); // the server turned it into an action
    expect(await m.getMeta("legacyDone")).toBe(true);
  });

  test("a server device that cannot reach the server waits and tries again next start", async () => {
    const m = meta();
    const old = { stack: oldStorage([{ id: "s-unsent", text: "x", ts: 1000, at: 1000, removed: false, seq: 0 }], ["s-unsent"]), queue: oldStorage(), notes: oldStorage() };
    expect(await upgradeFromRows({ old, meta: m, fetch: async () => { throw new TypeError("down"); } })).toBe("waiting");
    expect(await m.getMeta("legacyDone", false)).toBe(false);
  });
});
