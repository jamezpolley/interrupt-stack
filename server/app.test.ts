import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(await res.json()).toEqual({ id: "s-aaaa", text: "hello", ts: 7, removed: false, seq: 1 });
    const list = await (await get("/api/items?since=0")).json();
    expect(list).toEqual({ seq: 1, items: [{ id: "s-aaaa", text: "hello", ts: 7, removed: false, seq: 1 }] });
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
    expect(await (await get("/api/items?since=99")).json()).toEqual({ seq: 1, items: [] });
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
