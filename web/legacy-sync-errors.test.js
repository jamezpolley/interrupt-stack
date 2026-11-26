import { describe, expect, test } from "bun:test";
import { createSync } from "./legacy-sync.js";

function memStorage() {
  let dirty = [];
  return {
    load: async () => ({ items: [], dirty, cursor: 0, epoch: null }),
    setEpoch: async () => {},
    putItem: async () => {},
    setDirty: async (ids) => void (dirty = [...ids]),
    setCursor: async () => {},
  };
}

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
// A reply to the one sync request: every change in it stored, or refused where `refuse` says so.
const reply = (init, refuse = () => false) => {
  const sent = JSON.parse(init.body ?? "{}").changes?.items ?? {};
  const saved = {};
  const rejected = {};
  for (const [id, c] of Object.entries(sent)) {
    if (refuse(id)) rejected[id] = { error: "bad" };
    else saved[id] = { id, ...c, at: c.at ?? c.ts, seq: 1 };
  }
  return json({ epoch: "e1", cursor: 1, tables: { items: { rows: [], saved, rejected } } });
};

// Runs one sync with a queued local change. `respond(path, init)` is the fake network.
async function run(respond, { online = () => true, queued = true } = {}) {
  const seen = [];
  const sync = createSync({ storage: memStorage(), fetch: async (p, i) => respond(p, i ?? {}), onStatus: (s) => seen.push(s), online });
  await sync.start();
  if (queued) await sync.push("one");
  await sync.syncNow();
  return { sync, status: sync.status(), seen };
}

const ok = (p, i) => reply(i);
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

  test("401 and 403 are sign-in needed", async () => {
    for (const code of [401, 403]) {
      const { status } = await run(() => new Response("no", { status: code }));
      expect(status.error).toEqual({ kind: "sign-in" });
      expect(status.state).toBe("offline");
    }
  });

  test("a 401 on a push keeps the change queued", async () => {
    const { status } = await run(() => new Response("no", { status: 401 }));
    expect(status.pending).toBe(1);
    expect(status.error).toEqual({ kind: "sign-in" });
  });

  test("502 with an HTML body is a server error with its status, not a sign-in", async () => {
    const { status } = await run(() => html({ status: 502 }));
    expect(status.error).toEqual({ kind: "server-error", status: 502 });
  });

  test("500", async () => {
    const { status } = await run(() => new Response("oops", { status: 500 }));
    expect(status.error).toEqual({ kind: "server-error", status: 500 });
  });

  test("other 4xx carries the status", async () => {
    const { status } = await run(() => new Response("{}", { status: 404, headers: { "content-type": "application/json" } }));
    expect(status.error).toEqual({ kind: "client-error", status: 404 });
  });

  test("a change the server refuses is reported as a client error and the rest still syncs", async () => {
    const { status } = await run((p, i) => reply(i, () => true));
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
    expect(inits.length).toBeGreaterThan(0);
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

describe("never synced", () => {
  test("a device that has never reached the server says so, until a sync works", async () => {
    let fail = true;
    const { sync } = await run((p, i) => (fail ? Promise.reject(new TypeError("x")) : ok(p, i)), { queued: false });
    expect(sync.status().neverSynced).toBe(true);
    fail = false;
    await sync.syncNow();
    expect(sync.status().neverSynced).toBeUndefined();
  });

  test("a device that synced before is not flagged when it later fails", async () => {
    const storage = memStorage();
    const first = createSync({ storage, fetch: async (p, i) => ok(p, i) });
    await first.start();
    await first.syncNow();
    const storageAfter = { ...storage, load: async () => ({ items: [], dirty: [], cursor: 0, epoch: "e1" }) };
    const second = createSync({ storage: storageAfter, fetch: async () => Promise.reject(new TypeError("x")) });
    await second.start();
    expect(second.status().neverSynced).toBeUndefined();
  });

  test("the static version is never flagged", async () => {
    const sync = createSync({ storage: memStorage(), fetch: async () => Promise.reject(new TypeError("x")), local: true });
    await sync.start();
    expect(sync.status().neverSynced).toBeUndefined();
  });
});

describe("lastFailure (debug detail)", () => {
  const detail = async (respond, opts) => (await run(respond, opts)).sync.lastFailure();

  test("none before any failure and none after success", async () => {
    expect((await run(ok)).sync.lastFailure()).toBeNull();
  });

  test("a network failure records the request, the error and onLine", async () => {
    const d = await detail(() => Promise.reject(new TypeError("Failed to fetch")), { online: () => false });
    expect(d.request).toEqual({ method: "POST", url: "/api/sync" });
    expect(d.error).toEqual({ name: "TypeError", message: "Failed to fetch" });
    expect(d.online).toBe(false);
    expect(d.response).toBeUndefined();
  });

  test("a 502 records status, status text, type, url, redirected, headers and the raw body", async () => {
    const d = await detail(() => html({ status: 502, statusText: "Bad Gateway" }));
    expect(d.request.method).toBe("POST");
    expect(d.response.status).toBe(502);
    expect(d.response.statusText).toBe("Bad Gateway");
    expect(d.response.type).toBe("default");
    expect(d.response.redirected).toBe(false);
    expect(d.response.headers).toContainEqual(["content-type", "text/html"]);
    expect(d.response.body).toBe("<html>Sign in</html>");
  });

  test("an opaque redirect records what little there is", async () => {
    const r = { type: "opaqueredirect", status: 0, statusText: "", ok: false, redirected: false, url: "", headers: new Headers() };
    const d = await detail(() => r);
    expect(d.response).toMatchObject({ type: "opaqueredirect", status: 0, headers: [] });
    expect(d.response.body).toBeNull();
  });

  test("a body that is not JSON despite its content type is kept for display", async () => {
    const d = await detail(() => new Response("<html", { status: 200, headers: { "content-type": "application/json" } }));
    expect(d.response.body).toBe("<html");
  });

  test("a refused change records what the server said about it", async () => {
    const d = await detail((p, i) => reply(i, () => true));
    expect(d.response.status).toBe(400);
    expect(JSON.parse(d.response.body)).toEqual([{ table: "items", id: expect.stringMatching(/^s-/), error: "bad" }]);
  });

  test("long bodies are truncated and flagged", async () => {
    const d = await detail(() => new Response("x".repeat(10000), { status: 500 }));
    expect(d.response.body.length).toBe(4096);
    expect(d.response.bodyTruncated).toBe(true);
  });

  test("cookie and authorization headers are never kept", async () => {
    const d = await detail(() => new Response("no", { status: 401, headers: { "set-cookie": "a=b", authorization: "x", "x-ok": "1" } }));
    const names = d.response.headers.map(([k]) => k);
    expect(names).toContain("x-ok");
    expect(names).not.toContain("set-cookie");
    expect(names).not.toContain("authorization");
  });

  test("the request body and headers are not part of the detail", async () => {
    const d = await detail(() => Promise.reject(new TypeError("x")));
    expect(JSON.stringify(d)).not.toContain("one"); // the pushed text
  });

  test("cleared after a later success", async () => {
    let fail = true;
    const { sync } = await run((p, i) => (fail ? Promise.reject(new TypeError("x")) : ok(p, i)));
    expect(sync.lastFailure()).not.toBeNull();
    fail = false;
    await sync.syncNow();
    expect(sync.lastFailure()).toBeNull();
  });

  test("the static version has none", async () => {
    const sync = createSync({ storage: memStorage(), fetch: async () => Promise.reject(new TypeError("x")), local: true });
    await sync.start();
    expect(sync.lastFailure()).toBeNull();
  });
});
