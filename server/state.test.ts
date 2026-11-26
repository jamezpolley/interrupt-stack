import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openStore } from "./store";

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function setup(now = () => 10_000) {
  const store = openStore(":memory:", { now });
  const dir = mkdtempSync(join(tmpdir(), "ist-state-"));
  writeFileSync(join(dir, "index.html"), "x");
  cleanup.push(() => (store.close(), rmSync(dir, { recursive: true, force: true })));
  const app = createApp(store, { webDir: dir });
  const get = async (path: string) => {
    const res = await app.fetch(new Request("http://t" + path));
    return { status: res.status, body: await res.json() };
  };
  const send = (actions: unknown[]) => store.syncActions(0, actions);
  return { store, get, send };
}
const act = (id: string, kind: string, target: string, at: number, extra: Record<string, unknown> = {}) => ({ id, kind, target, at, ...extra });

describe("GET /api/state", () => {
  test("the stack, the Later pile, what ended in the window, the notes in it, and the cursor", async () => {
    const { get, send } = setup();
    send([
      act("a-p1", "push", "s-aaaa", 1000, { data: { text: "done" } }),
      act("a-o1", "pop", "s-aaaa", 2000),
      act("a-p2", "push", "s-bbbb", 3000, { data: { text: "live" } }),
      act("a-n1", "note", "n-aaaa", 2500, { data: { text: "a note" } }),
      act("a-l1", "later", "q-aaaa", 100, { data: { text: "someday" } }),
    ]);
    const { status, body } = await get("/api/state?from=0&to=5000");
    expect(status).toBe(200);
    expect(body.stack.map((r: any) => r.text)).toEqual(["live"]);
    expect(body.later.map((r: any) => r.text)).toEqual(["someday"]);
    expect(body.done.map((r: any) => r.text)).toEqual(["done"]);
    expect(body.notes.map((n: any) => n.text)).toEqual(["a note"]);
    expect(body.cursor).toBe(5);
    expect(body.epoch).toEqual(expect.any(String));
  });

  test("the window selects by when a stay ended, and a stay pushed again is two entries", async () => {
    const { get, send } = setup();
    send([
      act("a-p1", "push", "s-aaaa", 1000, { data: { text: "x" } }),
      act("a-o1", "pop", "s-aaaa", 2000),
      act("a-g1", "push-again", "s-aaaa", 3000),
      act("a-o2", "pop", "s-aaaa", 4000),
    ]);
    expect((await get("/api/state?from=0&to=2500")).body.done).toHaveLength(1);
    expect((await get("/api/state?from=2500&to=5000")).body.done).toHaveLength(1);
    const all = (await get("/api/state")).body.done;
    expect(all.map((r: any) => r.id)).toEqual(["s-aaaa~1", "s-aaaa"]); // newest end first
    expect(all.every((r: any) => r.itemId === "s-aaaa")).toBe(true);
  });

  test("deleted items are left out, and a bad window is refused", async () => {
    const { get, send } = setup();
    send([act("a-p1", "push", "s-aaaa", 1000, { data: { text: "x" } }), act("a-d1", "delete", "s-aaaa", 1500)]);
    expect((await get("/api/state")).body.stack).toEqual([]);
    expect((await get("/api/state?from=abc")).status).toBe(400);
  });
});

describe("GET /api/day", () => {
  test("what was pushed and ended in the day, without the stack or the Later pile", async () => {
    const { get, send } = setup();
    send([act("a-p1", "push", "s-aaaa", 1000, { data: { text: "x" } }), act("a-o1", "pop", "s-aaaa", 2000), act("a-p2", "push", "s-bbbb", 9000, { data: { text: "later today" } })]);
    const { body } = await get("/api/day?from=0&to=3000");
    expect(body.stack).toBeUndefined();
    expect(body.later).toBeUndefined();
    expect(body.pushed.map((r: any) => r.text)).toEqual(["x"]);
    expect(body.done.map((r: any) => r.text)).toEqual(["x"]);
  });
});

describe("GET /api/items/:id/history", () => {
  test("every action that touched the item, oldest first, with both times", async () => {
    const { get, send } = setup(() => 5000);
    send([act("a-p1", "push", "s-aaaa", 1000, { data: { text: "x" } }), act("a-o1", "pop", "s-aaaa", 2000), act("a-p9", "push", "s-bbbb", 1, { data: { text: "other" } })]);
    const { status, body } = await get("/api/items/s-aaaa/history");
    expect(status).toBe(200);
    expect(body.actions.map((a: any) => [a.kind, a.at, a.ts])).toEqual([["push", 1000, 5000], ["pop", 2000, 5000]]);
  });

  test("a stay's row id finds its item, and an unknown id is a 404", async () => {
    const { get, send } = setup();
    send([act("a-p1", "push", "s-aaaa", 1000, { data: { text: "x" } })]);
    expect((await get("/api/items/s-aaaa~1/history")).body.id).toBe("s-aaaa");
    expect((await get("/api/items/s-zzzz/history")).status).toBe(404);
  });
});
