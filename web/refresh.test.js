import { describe, expect, test } from "bun:test";
import { canUpdateNow, describeServerUpdate, forceRefresh, readVersionInfo, requestServerCheck, updateAvailable, updateServerNow } from "./refresh.js";

// Fakes record what happened, in order, so a test can assert both what was touched and what was left alone.
function env({ fetchImpl, cacheNames = ["interrupt-stack-v2", "old-cache"], registrations = 1, deleteFails = false, noApis = false } = {}) {
  const calls = [];
  const e = {
    calls,
    fetch: async (url, init) => {
      calls.push(["fetch", url, init?.cache]);
      return fetchImpl ? fetchImpl() : { ok: true, redirected: false };
    },
    caches: noApis
      ? undefined
      : {
          keys: async () => cacheNames,
          delete: async (name) => {
            calls.push(["delete", name]);
            if (deleteFails) throw new Error("boom");
            return true;
          },
        },
    serviceWorker: noApis
      ? undefined
      : {
          getRegistrations: async () =>
            Array.from({ length: registrations }, (_, i) => ({ unregister: async () => void calls.push(["unregister", i]) })),
        },
    reload: () => calls.push(["reload"]),
  };
  return e;
}

describe("force refresh", () => {
  test("when the server cannot be reached nothing is cleared and the page is not reloaded", async () => {
    const e = env({ fetchImpl: () => Promise.reject(new TypeError("network down")) });
    expect(await forceRefresh(e)).toEqual({ ok: false, reason: "unreachable" });
    expect(e.calls.map((c) => c[0])).toEqual(["fetch"]);
  });

  test("a server error response counts as unreachable and clears nothing", async () => {
    const e = env({ fetchImpl: () => ({ ok: false, redirected: false, status: 502 }) });
    expect(await forceRefresh(e)).toEqual({ ok: false, reason: "unreachable" });
    expect(e.calls.map((c) => c[0])).toEqual(["fetch"]);
  });

  test("a response that was redirected, as a sign-in page is, clears nothing and says so", async () => {
    const e = env({ fetchImpl: () => ({ ok: true, redirected: true }) });
    expect(await forceRefresh(e)).toEqual({ ok: false, reason: "signed-out" });
    expect(e.calls.map((c) => c[0])).toEqual(["fetch"]);
  });

  test("the reachability check can use another URL, as the static version does", async () => {
    const e = env();
    await forceRefresh({ ...e, checkUrl: "version.json" });
    expect(e.calls[0]).toEqual(["fetch", "version.json", "no-store"]);
  });

  test("the reachability check bypasses the service worker and the HTTP cache", async () => {
    const e = env();
    await forceRefresh(e);
    expect(e.calls[0]).toEqual(["fetch", "/healthz", "no-store"]);
  });

  test("on success every cache is deleted, every service worker unregistered, then the page reloads", async () => {
    const e = env({ registrations: 2 });
    expect(await forceRefresh(e)).toEqual({ ok: true });
    const names = e.calls.map((c) => c[0]);
    expect(names.filter((n) => n === "delete")).toHaveLength(2);
    expect(names.filter((n) => n === "unregister")).toHaveLength(2);
    expect(names.at(-1)).toBe("reload");
    expect(names.filter((n) => n === "reload")).toHaveLength(1);
  });

  test("a failure while clearing still reloads, because the server was reachable", async () => {
    const e = env({ deleteFails: true });
    expect(await forceRefresh(e)).toEqual({ ok: true });
    expect(e.calls.at(-1)).toEqual(["reload"]);
  });

  test("works where the cache and service worker APIs do not exist", async () => {
    const e = env({ noApis: true });
    expect(await forceRefresh(e)).toEqual({ ok: true });
    expect(e.calls.map((c) => c[0])).toEqual(["fetch", "reload"]);
  });
});

describe("update check", () => {
  const ask = (reply, current = "aaa111") =>
    updateAvailable({ fetch: async () => (typeof reply === "function" ? reply() : reply), current });
  const json = (body, extra = {}) => ({ ok: true, redirected: false, json: async () => body, ...extra });

  test("true when the server's version differs from the one this copy of the app was built from", async () => {
    expect(await ask(json({ version: "bbb222" }))).toBe(true);
  });

  test("false when they match", async () => {
    expect(await ask(json({ version: "aaa111" }))).toBe(false);
  });

  test("null, meaning unknown, when the server cannot be asked or answers oddly, so nobody is nagged", async () => {
    expect(await ask(() => Promise.reject(new TypeError("down")))).toBeNull();
    expect(await ask({ ok: false, redirected: false, json: async () => ({}) })).toBeNull();
    expect(await ask(json({ version: "bbb222" }, { redirected: true }))).toBeNull();
    expect(await ask({ ok: true, redirected: false, json: async () => { throw new SyntaxError("not json"); } })).toBeNull();
    expect(await ask(json({}))).toBeNull();
    expect(await ask(json({ version: "bbb222" }), null)).toBeNull(); // this app does not know its own version
  });

  test("can ask a different URL for the version, as the static version does", async () => {
    let seen;
    await updateAvailable({ fetch: async (...a) => ((seen = a), json({ version: "x" })), current: "y", url: "version.json" });
    expect(seen).toEqual(["version.json", { cache: "no-store" }]);
  });

  test("asks for /api/version without using any cache", async () => {
    let seen;
    await updateAvailable({ fetch: async (...a) => ((seen = a), json({ version: "x" })), current: "y" });
    expect(seen).toEqual(["/api/version", { cache: "no-store" }]);
  });
});

describe("server update notice", () => {
  const info = (update) => ({ version: "v", commit: null, label: null, update });

  test("describeServerUpdate says nothing unless GitHub has something different", () => {
    expect(describeServerUpdate(null)).toBeNull();
    expect(describeServerUpdate({})).toBeNull();
    expect(describeServerUpdate(info({ enabled: true, available: null }))).toBeNull();
    expect(describeServerUpdate(info({ enabled: false, available: { ref: "main", short: "abc1234" } }))).toBeNull();
  });

  test("describeServerUpdate names the ref and the short commit", () => {
    const text = describeServerUpdate(info({ enabled: true, available: { ref: "main", short: "abc1234", commit: "abc1234".padEnd(40, "0") } }));
    expect(text).toContain("main");
    expect(text).toContain("abc1234");
  });

  test("requestServerCheck POSTs to /api/update-check and does not wait on the answer being useful", async () => {
    let seen;
    await requestServerCheck({ fetch: async (...a) => ((seen = a), { ok: true }) });
    expect(seen[0]).toBe("/api/update-check");
    expect(seen[1]).toMatchObject({ method: "POST", keepalive: true });
  });

  test("requestServerCheck swallows every failure", async () => {
    await requestServerCheck({ fetch: async () => { throw new TypeError("down"); } });
    await requestServerCheck({ fetch: () => { throw new Error("sync throw"); } });
  });

  test("readVersionInfo returns the parsed answer, or null when it cannot", async () => {
    const ok = { ok: true, redirected: false, json: async () => ({ version: "x" }) };
    expect(await readVersionInfo({ fetch: async () => ok })).toEqual({ version: "x" });
    expect(await readVersionInfo({ fetch: async () => ({ ...ok, redirected: true }) })).toBeNull();
    expect(await readVersionInfo({ fetch: async () => ({ ...ok, ok: false }) })).toBeNull();
    expect(await readVersionInfo({ fetch: async () => { throw new TypeError("x"); } })).toBeNull();
    expect(await readVersionInfo({ fetch: async () => ({ ...ok, json: async () => { throw new SyntaxError("x"); } }) })).toBeNull();
    expect(await readVersionInfo({ fetch: async () => ({ ...ok, json: async () => null }) })).toBeNull();
  });

  test("readVersionInfo uses the URL it is given without caching", async () => {
    let seen;
    await readVersionInfo({ fetch: async (...a) => ((seen = a), { ok: true, redirected: false, json: async () => ({}) }), url: "version.json" });
    expect(seen).toEqual(["version.json", { cache: "no-store" }]);
  });
});

describe("update now", () => {
  const A = "a".repeat(40), B = "b".repeat(40);
  const info = (extra = {}) => ({ version: "v", commit: A, label: "aaaaaaa", startedAt: 1000, update: { enabled: true, restartable: true, available: { ref: "main", short: "bbbbbbb", commit: B } }, ...extra });
  const ok = (body) => ({ ok: true, redirected: false, status: 200, json: async () => body });

  test("canUpdateNow needs updating enabled, a restart possible, and something different on GitHub", () => {
    expect(canUpdateNow(info())).toBe(true);
    expect(canUpdateNow(null)).toBe(false);
    expect(canUpdateNow(info({ update: { enabled: true, restartable: false, available: { ref: "main" } } }))).toBe(false);
    expect(canUpdateNow(info({ update: { enabled: true, restartable: true, available: null } }))).toBe(false);
    expect(canUpdateNow(info({ update: { enabled: false, restartable: true, available: { ref: "main" } } }))).toBe(false);
  });

  // A scripted server: the first reply is the state before, then the POST, then whatever the polls should see.
  const scripted = ({ post = () => ({ ok: true, status: 202 }), polls = [] }) => {
    const calls = [];
    const queue = [...polls];
    return {
      calls,
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (init?.method === "POST") {
          const r = post();
          if (r instanceof Error) throw r;
          return r;
        }
        if (calls.filter((c) => c.startsWith("GET")).length === 1) return ok(info());
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return ok(next);
      },
    };
  };
  const run = (server, extra = {}) => {
    let t = 0;
    const refreshed = [];
    return {
      refreshed,
      done: updateServerNow({ fetch: server.fetch, forceRefresh: async () => void refreshed.push(1), sleep: async (ms) => void (t += ms), now: () => t, pollMs: 1000, timeoutMs: 20_000, ...extra }),
    };
  };

  test("asks for the restart, waits through the outage, and refreshes once the server is back on new code", async () => {
    const server = scripted({ polls: [new TypeError("down"), new TypeError("down"), info({ commit: B, startedAt: 2000 })] });
    const r = run(server);
    expect(await r.done).toEqual({ ok: true });
    expect(server.calls.filter((c) => c === "POST /api/update")).toHaveLength(1);
    expect(r.refreshed).toHaveLength(1);
  });

  test("a dropped connection on the POST itself still counts: the server may already be going down", async () => {
    const server = scripted({ post: () => new TypeError("connection reset"), polls: [info({ commit: B, startedAt: 2000 })] });
    const r = run(server);
    expect(await r.done).toEqual({ ok: true });
  });

  test("a server that restarts but is still on the same commit is reported, and the page is not refreshed", async () => {
    const server = scripted({ polls: [info({ startedAt: 2000 })] });
    const r = run(server);
    expect(await r.done).toMatchObject({ ok: false, reason: "unchanged", label: "aaaaaaa" });
    expect(r.refreshed).toHaveLength(0);
  });

  test("a server that never comes back times out", async () => {
    const server = scripted({ polls: [new TypeError("down")] });
    const r = run(server);
    expect(await r.done).toEqual({ ok: false, reason: "timeout" });
    expect(r.refreshed).toHaveLength(0);
  });

  test("a server that answers but has not restarted yet is waited for, not mistaken for done", async () => {
    const server = scripted({ polls: [info(), info(), info({ commit: B, startedAt: 2000 })] });
    const r = run(server);
    expect(await r.done).toEqual({ ok: true });
  });

  test("a refusal stops at once, with no polling", async () => {
    const server = scripted({ post: () => ({ ok: false, status: 409 }) });
    const r = run(server);
    expect(await r.done).toEqual({ ok: false, reason: "refused" });
    expect(server.calls).toEqual(["GET /api/version", "POST /api/update"]);
  });

  test("does nothing when the server says an update cannot be applied", async () => {
    const calls = [];
    const fetch = async (url, init) => (calls.push(`${init?.method ?? "GET"} ${url}`), ok(info({ update: { enabled: true, restartable: false, available: { ref: "main" } } })));
    const r = await updateServerNow({ fetch, forceRefresh: async () => {}, sleep: async () => {}, now: () => 0 });
    expect(r).toEqual({ ok: false, reason: "unavailable" });
    expect(calls).toEqual(["GET /api/version"]);
  });
});
