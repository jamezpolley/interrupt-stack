import { resolve, sep, extname } from "node:path";
import { ValidationError, type Store } from "./store";
import { webVersion } from "./webversion";
import { reportedBase } from "./gitver";
import type { UpdateState } from "./updatecheck";

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

type UpdateChecker = { request(): void; state(): UpdateState };

export function createApp(
  store: Store,
  opts: {
    webDir: string;
    commit?: string | null;
    /** The commit the container image was built from; reported as `base` only when it differs from `commit`. */
    baseCommit?: string | null;
    label?: string | null;
    updateChecker?: UpdateChecker;
    /** Present only when something will start the server again after it exits (the container's entrypoint). */
    onRestart?: () => void;
  },
) {
  const root = resolve(opts.webDir);
  const version = webVersion(root);
  const base = reportedBase(opts.commit, opts.baseCommit);
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const startedAt = Math.floor(Date.now() / 1000);
  const startedAtMs = Date.now();
  let restarting = false;
  const requests = new Map<string, number>(); // `${route}|${method}|${code}` -> count

  // Route labels come from a fixed set so a scanner hitting random paths cannot grow the metric series.
  function routeLabel(pathname: string): string {
    if (pathname === "/healthz" || pathname === "/login" || pathname === "/metrics" || pathname === "/api/events" || pathname === "/api/items" || pathname === "/api/queue" || pathname === "/api/version" || pathname === "/api/update-check" || pathname === "/api/update") return pathname;
    if (/^\/api\/items\/[^/]+$/.test(pathname)) return "/api/items/:id";
    if (/^\/api\/queue\/[^/]+$/.test(pathname)) return "/api/queue/:id";
    return pathname.startsWith("/api/") ? "/api/other" : "static";
  }

  function metricsText(): string {
    const { live, removed } = store.counts();
    const queue = store.queueCounts();
    const lines = [
      "# HELP interrupt_stack_items Stack items held by the server.",
      "# TYPE interrupt_stack_items gauge",
      `interrupt_stack_items{state="live"} ${live}`,
      `interrupt_stack_items{state="removed"} ${removed}`,
      "# HELP interrupt_stack_queue_items Queue items held by the server (a separate pile from the stack).",
      "# TYPE interrupt_stack_queue_items gauge",
      `interrupt_stack_queue_items{state="queued"} ${queue.queued}`,
      `interrupt_stack_queue_items{state="removed"} ${queue.removed}`,
      "# HELP interrupt_stack_seq Highest change sequence number issued.",
      "# TYPE interrupt_stack_seq gauge",
      `interrupt_stack_seq ${currentSeq()}`,
      "# HELP interrupt_stack_event_streams Open server-sent event streams.",
      "# TYPE interrupt_stack_event_streams gauge",
      `interrupt_stack_event_streams ${streams.size}`,
      "# HELP interrupt_stack_start_time_seconds Process start time as a unix timestamp.",
      "# TYPE interrupt_stack_start_time_seconds gauge",
      `interrupt_stack_start_time_seconds ${startedAt}`,
      "# HELP interrupt_stack_http_requests_total HTTP requests handled, by route, method and status code.",
      "# TYPE interrupt_stack_http_requests_total counter",
    ];
    for (const [key, n] of [...requests].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const [route, method, code] = key.split("|");
      lines.push(`interrupt_stack_http_requests_total{route="${route}",method="${method}",code="${code}"} ${n}`);
    }
    return lines.join("\n") + "\n";
  }

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

  // The queue announces itself on its own event name, so a client that only listens for `seq` never hears of it.
  function notifyQueue() {
    const chunk = enc.encode(`event: qseq\ndata: ${store.queueSince(Number.MAX_SAFE_INTEGER).seq}\n\n`);
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

  async function readBody(req: Request): Promise<{ data: any } | { error: Response }> {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY) return { error: json({ error: "body too large" }, 413) };
    const raw = await req.text();
    if (enc.encode(raw).length > MAX_BODY) return { error: json({ error: "body too large" }, 413) };
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return { error: json({ error: "invalid JSON" }, 400) };
    }
    if (data === null || typeof data !== "object") return { error: json({ error: "expected a JSON object" }, 400) };
    return { data };
  }

  async function putQueue(id: string, req: Request): Promise<Response> {
    const body = await readBody(req);
    if ("error" in body) return body.error;
    const { data } = body;
    try {
      const row = store.upsertQueue(id, { text: data.text, ts: data.ts, removed: data.removed === true, at: data.at, started: data.started });
      notifyQueue();
      return json(row);
    } catch (e) {
      if (e instanceof ValidationError) return json({ error: e.message }, 400);
      throw e;
    }
  }

  async function putItem(id: string, req: Request): Promise<Response> {
    const body = await readBody(req);
    if ("error" in body) return body.error;
    const { data } = body;
    try {
      const item = store.upsert(id, { text: data.text, ts: data.ts, removed: data.removed === true, at: data.at, origin: data.origin });
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

  async function dispatch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    if (pathname === "/healthz") return new Response("ok");
    // The sign-in landing page. Behind the sign-in proxy an unauthenticated request never gets here: the proxy
    // intercepts it, and after sign-in sends the person back to this path, which sends them into the app.
    // A relative Location, so it works under any host or path; no state, and never cached.
    if (pathname === "/login" && (req.method === "GET" || req.method === "HEAD")) {
      return new Response(null, { status: 302, headers: { location: "./", "cache-control": "no-store" } });
    }
    if (pathname === "/metrics" && req.method === "GET") {
      return new Response(metricsText(), { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
    }
    if (pathname === "/api/events" && req.method === "GET") return events();
    if (pathname === "/api/items" && req.method === "GET") {
      const n = Number(url.searchParams.get("since"));
      return json({ ...store.since(Number.isSafeInteger(n) && n > 0 ? n : 0), epoch: store.epoch });
    }
    if (pathname === "/api/queue" && req.method === "GET") {
      const n = Number(url.searchParams.get("since"));
      return json({ ...store.queueSince(Number.isSafeInteger(n) && n > 0 ? n : 0), epoch: store.epoch });
    }
    const qm = pathname.match(/^\/api\/queue\/([^/]+)$/);
    if (qm && req.method === "PUT") return putQueue(decodeURIComponent(qm[1]), req);
    if (pathname === "/api/version" && req.method === "GET") {
      return new Response(JSON.stringify({
          version,
          commit: opts.commit ?? null,
          label: opts.label ?? null,
          ...(base ? { base } : {}),
          startedAt: startedAtMs,
          update: {
            ...(opts.updateChecker?.state() ?? { enabled: false, ref: null, checkedAt: null, available: null }),
            restartable: !!opts.onRestart,
          },
        }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    // Cached with the rest of the app, so each device keeps the version its own files were built from.
    if (pathname === "/version.js" && req.method === "GET") {
      return new Response(`export const VERSION = "${version}";\nexport const COMMIT = ${JSON.stringify(opts.commit ?? null)};\nexport const LABEL = ${JSON.stringify(opts.label ?? null)};\n`, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
      });
    }
    // Starts a check of GitHub in the background and answers straight away; the result appears in /api/version.
    if (pathname === "/api/update-check" && req.method === "POST") {
      if (!opts.updateChecker) return json({ checking: false });
      opts.updateChecker.request();
      return json({ checking: true }, 202);
    }
    // Restart so the container's entrypoint picks up the newer code. Only when something will bring the server back,
    // and only when GitHub holds a different commit. The answer goes out first; the process goes a moment later.
    if (pathname === "/api/update" && req.method === "POST") {
      const state = opts.updateChecker?.state();
      if (!opts.onRestart) return json({ restarting: false, reason: "not supervised: nothing would start the server again" }, 409);
      if (!state?.enabled || !state.available) return json({ restarting: false, reason: "nothing different on GitHub" }, 409);
      if (!restarting) {
        restarting = true;
        setTimeout(() => opts.onRestart!(), 500);
      }
      return json({ restarting: true }, 202);
    }
    const m = pathname.match(/^\/api\/items\/([^/]+)$/);
    if (m && req.method === "PUT") return putItem(decodeURIComponent(m[1]), req);
    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(pathname);
    return new Response("not found", { status: 404 });
  }

  async function handle(req: Request): Promise<Response> {
    const route = routeLabel(new URL(req.url).pathname);
    const count = (code: number) => {
      const key = `${route}|${req.method}|${code}`;
      requests.set(key, (requests.get(key) ?? 0) + 1);
    };
    try {
      const res = await dispatch(req);
      count(res.status);
      return res;
    } catch (e) {
      count(500);
      throw e;
    }
  }

  return { fetch: handle, notify };
}
