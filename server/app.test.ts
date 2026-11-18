import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { openStore, type Store } from "./store";

let store: Store;
let dir: string;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = openStore(":memory:");
  dir = mkdtempSync(join(tmpdir(), "ist-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(dir, "app.js"), "export {}");
  app = createApp(store, { webDir: dir });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const put = (id: string, body: unknown) =>
  app.fetch(
    new Request(`http://t/api/items/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const get = (path: string) => app.fetch(new Request(`http://t${path}`));
const item = (text = "task", ts = 100, removed = false) => ({ text, ts, removed });

describe("api", () => {
  test("PUT then GET since 0 returns the item", async () => {
    const res = await put("s-aaaa", item("hello", 7));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "s-aaaa", text: "hello", ts: 7, at: 7, removed: false, seq: 1 });
    const list = await (await get("/api/items?since=0")).json();
    expect(list).toEqual({ seq: 1, epoch: store.epoch, items: [{ id: "s-aaaa", text: "hello", ts: 7, at: 7, removed: false, seq: 1 }] });
  });

  test("GET /api/items carries the database epoch as a string", async () => {
    const body = await (await get("/api/items")).json();
    expect(typeof body.epoch).toBe("string");
    expect(body.epoch.length).toBeGreaterThan(8);
  });

  test("PUT twice is idempotent", async () => {
    await put("s-aaaa", item());
    await put("s-aaaa", item());
    const list = await (await get("/api/items")).json();
    expect(list.items).toHaveLength(1);
  });

  test("PUT with 201-character text returns 400", async () => {
    const res = await put("s-aaaa", item("x".repeat(201)));
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });

  test("PUT with whitespace text returns 400", async () => {
    expect((await put("s-aaaa", item("   "))).status).toBe(400);
  });

  test("PUT with bad JSON returns 400", async () => {
    const res = await put("s-aaaa", "{not json");
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });

  test("PUT over 4 KB returns 413", async () => {
    const res = await put("s-aaaa", JSON.stringify({ text: "x", ts: 1, removed: false, pad: "y".repeat(5000) }));
    expect(res.status).toBe(413);
  });

  test("GET since beyond current seq returns empty items and the current seq", async () => {
    await put("s-aaaa", item());
    expect(await (await get("/api/items?since=99")).json()).toEqual({ seq: 1, epoch: store.epoch, items: [] });
  });

  test("GET with invalid since is treated as 0", async () => {
    await put("s-aaaa", item());
    const list = await (await get("/api/items?since=abc")).json();
    expect(list.items).toHaveLength(1);
  });
});

describe("static and health", () => {
  test("GET /healthz returns 200 ok", async () => {
    const res = await get("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("GET /../server/store.ts returns 404", async () => {
    expect((await get("/../server/store.ts")).status).toBe(404);
    expect((await get("/%2e%2e/server/store.ts")).status).toBe(404);
    expect((await get("/..%2fserver%2fstore.ts")).status).toBe(404);
  });

  test("GET / returns index.html with text/html", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("<title>t</title>");
  });

  test("GET of a javascript file has a javascript content type", async () => {
    const res = await get("/app.js");
    expect(res.headers.get("content-type")).toMatch(/javascript/);
  });

  test("GET of an unknown path returns 404", async () => {
    expect((await get("/nope.txt")).status).toBe(404);
  });
});

describe("events", () => {
  test("event stream emits a seq event on connect and after a PUT", async () => {
    await put("s-aaaa", item());
    const res = await get("/api/events");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const next = async () => dec.decode((await reader.read()).value);

    expect(await next()).toBe("event: seq\ndata: 1\n\n");
    await put("s-bbbb", item());
    expect(await next()).toBe("event: seq\ndata: 2\n\n");
    await reader.cancel();
  });
});

describe("metrics", () => {
  const metrics = async () => (await get("/metrics")).text();
  const sample = (text: string, name: string) => {
    const line = text.split("\n").find((l) => l.startsWith(name + " ") || l.startsWith(name + "{"));
    return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : undefined;
  };

  test("GET /metrics is served in the Prometheus text format", async () => {
    const res = await get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const text = await res.text();
    expect(text.endsWith("\n")).toBe(true);
    for (const line of text.trimEnd().split("\n")) {
      expect(line).toMatch(/^(# (HELP|TYPE) [a-z_:][a-z0-9_:]* .+|[a-z_:][a-z0-9_:]*(\{[^}]*\})? -?[0-9.e+]+)$/);
    }
    expect(text).toContain("# TYPE interrupt_stack_items gauge");
    expect(text).toContain("# TYPE interrupt_stack_http_requests_total counter");
  });

  test("item gauges and seq follow writes", async () => {
    await put("s-aaaa", item("a"));
    await put("s-bbbb", item("b"));
    await put("s-cccc", item("c", 3, true));
    const text = await metrics();
    expect(sample(text, 'interrupt_stack_items{state="live"}')).toBe(2);
    expect(sample(text, 'interrupt_stack_items{state="removed"}')).toBe(1);
    expect(sample(text, "interrupt_stack_seq")).toBe(3);
  });

  test("requests are counted by route, method and status code", async () => {
    await put("s-aaaa", item());
    await put("s-bbbb", item("   "));
    await get("/api/items");
    const text = await metrics();
    expect(sample(text, 'interrupt_stack_http_requests_total{route="/api/items/:id",method="PUT",code="200"}')).toBe(1);
    expect(sample(text, 'interrupt_stack_http_requests_total{route="/api/items/:id",method="PUT",code="400"}')).toBe(1);
    expect(sample(text, 'interrupt_stack_http_requests_total{route="/api/items",method="GET",code="200"}')).toBe(1);
  });

  test("unknown paths share one label so scanners cannot grow the metric set", async () => {
    await get("/nope-1.txt");
    await get("/nope-2.txt");
    const text = await metrics();
    expect(sample(text, 'interrupt_stack_http_requests_total{route="static",method="GET",code="404"}')).toBe(2);
    expect(text).not.toContain("nope-1");
  });

  test("open event streams are gauged and released on cancel", async () => {
    const res = await get("/api/events");
    const reader = res.body!.getReader();
    await reader.read();
    expect(sample(await metrics(), "interrupt_stack_event_streams")).toBe(1);
    await reader.cancel();
    expect(sample(await metrics(), "interrupt_stack_event_streams")).toBe(0);
  });

  test("process start time is a plausible unix timestamp in seconds", async () => {
    const t = sample(await metrics(), "interrupt_stack_start_time_seconds")!;
    expect(t).toBeGreaterThan(1_700_000_000);
    expect(t).toBeLessThanOrEqual(Date.now() / 1000);
  });
});

describe("event log", () => {
  test("a non-integer at is a 400 and nothing is logged", async () => {
    const res = await put("s-aaaa", { text: "x", ts: 1, removed: false, at: "soon" });
    expect(res.status).toBe(400);
    expect(store.log()).toEqual([]);
  });

  test("a far-future or absurdly old at is accepted and clamped", async () => {
    expect((await put("s-aaaa", { text: "x", ts: Date.now(), removed: false, at: Date.now() + 86_400_000 * 365 })).status).toBe(200);
    expect((await put("s-bbbb", { text: "y", ts: 1, removed: true, at: -9_000_000_000_000_000 })).status).toBe(200);
    for (const e of store.log()) {
      expect(e.at).toBeGreaterThanOrEqual(0);
      expect(e.at).toBeLessThanOrEqual(e.ts);
    }
  });

  test("a PUT is logged in the same call", async () => {
    await put("s-aaaa", item("a", 5));
    await put("s-aaaa", { ...item("a", 5, true), at: 6 });
    expect(store.log().map((e) => [e.op, e.at])).toEqual([
      ["push", 5],
      ["pop", 6],
    ]);
  });
});

describe("version", () => {
  const versionOf = async (a: ReturnType<typeof createApp>) =>
    (await (await a.fetch(new Request("http://t/api/version"))).json()).version as string;

  test("GET /api/version returns the version of the shipped web files, uncached", async () => {
    const res = await get("/api/version");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).version).toMatch(/^[0-9a-f]{12}$/);
  });

  test("/version.js is a module exporting the same version, so a cached copy records what the app was built from", async () => {
    const res = await get("/version.js");
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(`export const VERSION = "${await versionOf(app)}";\nexport const COMMIT = null;\nexport const LABEL = null;\n`);
  });

  test("the version is stable for unchanged files and changes when a shipped file changes", async () => {
    const before = await versionOf(app);
    expect(await versionOf(createApp(store, { webDir: dir }))).toBe(before);
    writeFileSync(join(dir, "app.js"), "export const changed = 1");
    expect(await versionOf(createApp(store, { webDir: dir }))).not.toBe(before);
  });

  test("test files and files in subfolders are accounted for correctly", async () => {
    const before = await versionOf(app);
    writeFileSync(join(dir, "thing.test.js"), "// not shipped");
    expect(await versionOf(createApp(store, { webDir: dir }))).toBe(before);
    mkdirSync(join(dir, "icons"));
    writeFileSync(join(dir, "icons", "a.png"), "png");
    expect(await versionOf(createApp(store, { webDir: dir }))).not.toBe(before);
  });

  test("/api/version is counted under its own route label", async () => {
    await get("/api/version");
    const text = await (await get("/metrics")).text();
    expect(text).toContain('interrupt_stack_http_requests_total{route="/api/version",method="GET",code="200"} 1');
  });
});

describe("commit in /api/version", () => {
  const withCommit = (commit?: string | null) => createApp(store, { webDir: dir, commit });
  const ask = async (a: ReturnType<typeof createApp>) => (await a.fetch(new Request("http://t/api/version"))).json();

  test("reports the commit the server was built from", async () => {
    expect((await ask(withCommit("0123456789abcdef0123456789abcdef01234567"))).commit).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  test("reports null when the commit is unknown, and still reports the web version", async () => {
    const body = await ask(withCommit(null));
    expect(body.commit).toBeNull();
    expect(body.version).toMatch(/^[0-9a-f]{12}$/);
    expect((await ask(withCommit())).commit).toBeNull();
  });
});

describe("commit in /version.js", () => {
  test("carries the commit the server was built from, so a cached copy records what it is", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const a = createApp(store, { webDir: dir, commit: sha });
    const text = await (await a.fetch(new Request("http://t/version.js"))).text();
    expect(text).toContain(`export const COMMIT = "${sha}";`);
    expect(text).toContain("export const VERSION = ");
  });
});

describe("version label and update check", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const fakeChecker = (available: object | null = null) => {
    const calls: number[] = [];
    return {
      calls,
      checker: {
        request: () => void calls.push(1),
        state: () => ({ enabled: true, ref: "main", checkedAt: 123, available }),
      },
    };
  };
  const post = (a: ReturnType<typeof createApp>, path: string) => a.fetch(new Request(`http://t${path}`, { method: "POST" }));

  test("/version.js and /api/version carry the label", async () => {
    const a = createApp(store, { webDir: dir, commit: SHA, label: "v1.2.0-3-g0123456" });
    expect(await (await a.fetch(new Request("http://t/version.js"))).text()).toContain('export const LABEL = "v1.2.0-3-g0123456";');
    expect((await (await a.fetch(new Request("http://t/api/version"))).json()).label).toBe("v1.2.0-3-g0123456");
  });

  test("/api/version says what the update checker knows", async () => {
    const { checker } = fakeChecker({ commit: "f".repeat(40), short: "fffffff", ref: "main" });
    const a = createApp(store, { webDir: dir, commit: SHA, updateChecker: checker });
    const body = await (await a.fetch(new Request("http://t/api/version"))).json();
    expect(body.update).toEqual({ enabled: true, ref: "main", checkedAt: 123, restartable: false, available: { commit: "f".repeat(40), short: "fffffff", ref: "main" } });
  });

  test("without an update checker /api/version says updating is not enabled", async () => {
    const body = await (await get("/api/version")).json();
    expect(body.update).toEqual({ enabled: false, ref: null, checkedAt: null, restartable: false, available: null });
  });

  test("POST /api/update-check starts a check and answers at once with 202", async () => {
    const { checker, calls } = fakeChecker();
    const a = createApp(store, { webDir: dir, updateChecker: checker });
    const res = await post(a, "/api/update-check");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ checking: true });
    expect(calls).toHaveLength(1);
  });

  test("POST /api/update-check without a checker is a harmless 200", async () => {
    const res = await post(app, "/api/update-check");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checking: false });
  });

  test("only POST is accepted, and the route has its own metrics label", async () => {
    expect((await get("/api/update-check")).status).toBe(404);
    await post(app, "/api/update-check");
    const text = await (await get("/metrics")).text();
    expect(text).toContain('route="/api/update-check",method="POST",code="200"');
  });
});

describe("update now (restart to apply an update)", () => {
  const available = { commit: "f".repeat(40), short: "fffffff", ref: "main" };
  const checker = (avail: object | null) => ({ request: () => {}, state: () => ({ enabled: true, ref: "main", checkedAt: 1, available: avail }) });
  const post = (a: ReturnType<typeof createApp>) => a.fetch(new Request("http://t/api/update", { method: "POST" }));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("answers 202 at once, then restarts, when it is supervised and GitHub has something different", async () => {
    let restarts = 0;
    const a = createApp(store, { webDir: dir, updateChecker: checker(available), onRestart: () => void restarts++ });
    const res = await post(a);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ restarting: true });
    expect(restarts).toBe(0); // the answer goes out before the process goes away
    await wait(700);
    expect(restarts).toBe(1);
  });

  test("pressing it twice restarts once", async () => {
    let restarts = 0;
    const a = createApp(store, { webDir: dir, updateChecker: checker(available), onRestart: () => void restarts++ });
    await post(a);
    await post(a);
    await wait(900);
    expect(restarts).toBe(1);
  });

  test("refused, and no restart, when the server is not supervised (nothing would bring it back)", async () => {
    const a = createApp(store, { webDir: dir, updateChecker: checker(available) });
    const res = await post(a);
    expect(res.status).toBe(409);
    expect((await res.json()).restarting).toBe(false);
  });

  test("refused, and no restart, when GitHub has nothing different", async () => {
    let restarts = 0;
    const a = createApp(store, { webDir: dir, updateChecker: checker(null), onRestart: () => void restarts++ });
    expect((await post(a)).status).toBe(409);
    await wait(700);
    expect(restarts).toBe(0);
  });

  test("refused when there is no update checker at all", async () => {
    let restarts = 0;
    const a = createApp(store, { webDir: dir, onRestart: () => void restarts++ });
    expect((await post(a)).status).toBe(409);
    expect(restarts).toBe(0);
  });

  test("/api/version says whether a restart can be requested, and when the server started", async () => {
    const supervised = createApp(store, { webDir: dir, updateChecker: checker(available), onRestart: () => {} });
    const body = await (await supervised.fetch(new Request("http://t/api/version"))).json();
    expect(body.update.restartable).toBe(true);
    expect(typeof body.startedAt).toBe("number");
    expect(body.startedAt).toBeLessThanOrEqual(Date.now());
    const plain = await (await get("/api/version")).json();
    expect(plain.update.restartable).toBe(false);
  });

  test("only POST is accepted, and the route has its own metrics label", async () => {
    expect((await get("/api/update")).status).toBe(404);
    await post(createApp(store, { webDir: dir }));
    const a = createApp(store, { webDir: dir });
    await post(a);
    expect(await (await a.fetch(new Request("http://t/metrics"))).text()).toContain('route="/api/update",method="POST",code="409"');
  });
});
