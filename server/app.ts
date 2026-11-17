import { resolve, sep, extname } from "node:path";
import { ValidationError, type Store } from "./store";

const MAX_BODY = 4096;
const KEEPALIVE_MS = 25_000;
const enc = new TextEncoder();

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createApp(store: Store, opts: { webDir: string }) {
  const root = resolve(opts.webDir);
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();

  const currentSeq = () => store.since(Number.MAX_SAFE_INTEGER).seq;
  const seqEvent = () => enc.encode(`event: seq\ndata: ${currentSeq()}\n\n`);

  function notify() {
    if (!streams.size) return;
    const chunk = seqEvent();
    for (const c of streams) {
      try {
        c.enqueue(chunk);
      } catch {
        streams.delete(c);
      }
    }
  }

  function events(): Response {
    let ctl: ReadableStreamDefaultController<Uint8Array>;
    let timer: ReturnType<typeof setInterval>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
        streams.add(c);
        c.enqueue(seqEvent());
        timer = setInterval(() => {
          try {
            c.enqueue(enc.encode(": keep-alive\n\n"));
          } catch {
            clearInterval(timer);
            streams.delete(c);
          }
        }, KEEPALIVE_MS);
      },
      cancel() {
        clearInterval(timer);
        streams.delete(ctl);
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  async function putItem(id: string, req: Request): Promise<Response> {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY) return json({ error: "body too large" }, 413);
    const raw = await req.text();
    if (enc.encode(raw).length > MAX_BODY) return json({ error: "body too large" }, 413);
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    if (data === null || typeof data !== "object") return json({ error: "expected a JSON object" }, 400);
    try {
      const item = store.upsert(id, { text: data.text, ts: data.ts, removed: data.removed === true });
      notify();
      return json(item);
    } catch (e) {
      if (e instanceof ValidationError) return json({ error: e.message }, 400);
      throw e;
    }
  }

  async function serveStatic(pathname: string): Promise<Response> {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return new Response("not found", { status: 404 });
    }
    if (rel === "/") rel = "/index.html";
    if (rel.includes("\0")) return new Response("not found", { status: 404 });
    const full = resolve(root, "." + rel);
    if (full !== root && !full.startsWith(root + sep)) return new Response("not found", { status: 404 });
    const file = Bun.file(full);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": TYPES[extname(full)] ?? "application/octet-stream",
        "cache-control": "no-cache",
      },
    });
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    if (pathname === "/healthz") return new Response("ok");
    if (pathname === "/api/events" && req.method === "GET") return events();
    if (pathname === "/api/items" && req.method === "GET") {
      const n = Number(url.searchParams.get("since"));
      return json(store.since(Number.isSafeInteger(n) && n > 0 ? n : 0));
    }
    const m = pathname.match(/^\/api\/items\/([^/]+)$/);
    if (m && req.method === "PUT") return putItem(decodeURIComponent(m[1]), req);
    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(pathname);
    return new Response("not found", { status: 404 });
  }

  return { fetch: handle, notify };
}
