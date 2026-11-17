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
