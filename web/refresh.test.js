import { describe, expect, test } from "bun:test";
import { forceRefresh, updateAvailable } from "./refresh.js";

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

  test("asks for /api/version without using any cache", async () => {
    let seen;
    await updateAvailable({ fetch: async (...a) => ((seen = a), json({ version: "x" })), current: "y" });
    expect(seen).toEqual(["/api/version", { cache: "no-store" }]);
  });
});
