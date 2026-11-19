import { describe, expect, test } from "bun:test";
import { createSync } from "./sync.js";

function memStorage() {
  let dirty = [];
  return {
    load: async () => ({ items: [], dirty, lastSeq: 0, epoch: null }),
    setEpoch: async () => {},
    putItem: async () => {},
    setDirty: async (ids) => void (dirty = [...ids]),
    setLastSeq: async () => {},
  };
}

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
const empty = () => json({ items: [], seq: 0, epoch: "e1" });
const saved = (init) => json({ id: "x", text: "t", ts: 1, at: 1, removed: false, seq: 1 }, init);

// Runs one sync with a queued local change so both the PUT and the GET are exercised. `respond(path, init)` is the fake network.
async function run(respond, { online = () => true, queued = true } = {}) {
  const seen = [];
  const sync = createSync({ storage: memStorage(), fetch: async (p, i) => respond(p, i ?? {}), onStatus: (s) => seen.push(s), online });
  await sync.start();
  if (queued) await sync.push("one");
  await sync.syncNow();
  return { sync, status: sync.status(), seen };
}

const ok = (p, i) => (i.method === "PUT" ? saved() : empty());
const html = (init = {}) => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" }, ...init });

describe("failure kinds", () => {
  test("a successful sync has no error", async () => {
    const { status } = await run(ok);
    expect(status.state).toBe("synced");
    expect(status.error).toBeUndefined();
  });

  test("device offline: navigator says so", async () => {
    const { status } = await run(() => Promise.reject(new TypeError("Failed to fetch")), { online: () => false });
    expect(status.state).toBe("offline");
    expect(status.error).toEqual({ kind: "no-network" });
  });

  test("fetch rejects while the device thinks it is online: server unreachable", async () => {
    const { status } = await run(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(status.state).toBe("offline");
    expect(status.error).toEqual({ kind: "unreachable" });
  });

  test("an opaque redirect (what redirect: manual gives for a login redirect) is sign-in needed", async () => {
    const r = { type: "opaqueredirect", status: 0, ok: false, redirected: false, headers: new Headers() };
    const { status } = await run(() => r);
    expect(status.error).toEqual({ kind: "sign-in" });
  });

  test("a followed redirect to an HTML page is sign-in needed", async () => {
    const r = html();
    Object.defineProperty(r, "redirected", { value: true });
    const { status } = await run(() => r);
    expect(status.error).toEqual({ kind: "sign-in" });
  });

  test("HTML with status 200 where JSON was expected is sign-in needed", async () => {
    const { status } = await run(() => html());
    expect(status.error).toEqual({ kind: "sign-in" });
  });

  test("HTML on the pull (after pushes worked) is sign-in needed", async () => {
    const { status } = await run((p, i) => (i.method === "PUT" ? saved() : html()));
    expect(status.error).toEqual({ kind: "sign-in" });
  });

  test("401 and 403 are sign-in needed", async () => {
    for (const code of [401, 403]) {
      const { status } = await run(() => new Response("no", { status: code }));
      expect(status.error).toEqual({ kind: "sign-in" });
      expect(status.state).toBe("offline");
    }
  });

  test("a 401 on a push keeps the change queued", async () => {
    const { status } = await run((p, i) => (i.method === "PUT" ? new Response("no", { status: 401 }) : empty()));
    expect(status.pending).toBe(1);
    expect(status.error).toEqual({ kind: "sign-in" });
  });

  test("502 with an HTML body is a server error with its status, not a sign-in", async () => {
    const { status } = await run(() => html({ status: 502 }));
    expect(status.error).toEqual({ kind: "server-error", status: 502 });
  });

  test("500 on the pull", async () => {
    const { status } = await run((p, i) => (i.method === "PUT" ? saved() : new Response("oops", { status: 500 })));
    expect(status.error).toEqual({ kind: "server-error", status: 500 });
  });

  test("other 4xx on the pull carries the status", async () => {
    const { status } = await run((p, i) => (i.method === "PUT" ? saved() : new Response("{}", { status: 404, headers: { "content-type": "application/json" } })));
    expect(status.error).toEqual({ kind: "client-error", status: 404 });
  });

  test("a rejected push (4xx) is reported with its status and the rest still syncs", async () => {
    const { status } = await run((p, i) => (i.method === "PUT" ? new Response('{"error":"bad"}', { status: 400, headers: { "content-type": "application/json" } }) : empty()));
    expect(status.state).toBe("error");
    expect(status.error).toEqual({ kind: "client-error", status: 400 });
    expect(status.pending).toBe(1);
  });

  test("a JSON content type with a body that is not JSON is an unexpected reply", async () => {
    const { status } = await run(() => new Response("<html", { status: 200, headers: { "content-type": "application/json" } }));
    expect(status.error).toEqual({ kind: "bad-reply" });
  });

  test("the error clears after a later successful sync", async () => {
    let fail = true;
    const { sync } = await run((p, i) => (fail ? Promise.reject(new TypeError("x")) : ok(p, i)));
    expect(sync.status().error).toEqual({ kind: "unreachable" });
    fail = false;
    await sync.syncNow();
    expect(sync.status().state).toBe("synced");
    expect(sync.status().error).toBeUndefined();
  });

  test("the error is not in the status while a retry is in flight", async () => {
    const seen = [];
    let fail = true;
    const sync = createSync({ storage: memStorage(), fetch: async (p, i) => (fail ? Promise.reject(new TypeError("x")) : ok(p, i)), onStatus: (s) => seen.push(s) });
    await sync.start();
    fail = false;
    seen.length = 0;
    await sync.syncNow();
    expect(seen[0].state).toBe("syncing");
    expect(seen[0].error).toBeUndefined();
  });

  test("API requests ask not to follow redirects, so a login redirect can be recognised", async () => {
    const inits = [];
    await run((p, i) => (inits.push(i), ok(p, i)));
    expect(inits.length).toBeGreaterThan(1);
    for (const i of inits) expect(i.redirect).toBe("manual");
  });

  test("the static version never reports an error", async () => {
    const calls = [];
    const sync = createSync({ storage: memStorage(), fetch: async (...a) => (calls.push(a), Promise.reject(new TypeError("x"))), local: true, online: () => false });
    await sync.start();
    await sync.push("a");
    await sync.syncNow();
    expect(calls).toEqual([]);
    expect(sync.status().state).toBe("local");
    expect(sync.status().error).toBeUndefined();
  });
});
