// Shared by both sync clients: what went wrong with a request, as far as the UI needs to tell the person, and the checks
// on a response. No browser globals.
export const SYNC_URL = "/api/sync";

// What went wrong with a request, as far as the UI needs to tell the person: a kind, plus the HTTP status when there is one.
export class SyncFailure extends Error {
  constructor(error, res = null, body) {
    super(error.kind);
    this.error = error;
    this.res = res; // the response behind it, for the debug detail
    this.body = body; // its body text, when it was already read
  }
}

const BODY_LIMIT = 4096;
const NEVER_KEPT = new Set(["set-cookie", "set-cookie2", "cookie", "authorization", "proxy-authorization"]);
/** At most this many changes go in one request; the rest follow in the next pass. The server accepts 500. */
export const BATCH = 100;

// What the browser lets us see of a failed response, kept in memory only for the Debug panel.
export async function describeResponse(res, body) {
  if (body === undefined) {
    try {
      body = await res.clone().text();
    } catch {
      body = null;
    }
  }
  const headers = [];
  try {
    for (const [k, v] of res.headers ?? []) if (!NEVER_KEPT.has(k.toLowerCase())) headers.push([k, v]);
  } catch {}
  const out = { status: res.status, statusText: res.statusText ?? "", type: res.type ?? "", redirected: !!res.redirected, url: res.url ?? "", headers, body };
  if (typeof body === "string" && body.length > BODY_LIMIT) {
    out.body = body.slice(0, BODY_LIMIT);
    out.bodyTruncated = true;
  }
  return out;
}

const isJson = (res) => /\bjson\b/i.test(res.headers?.get?.("content-type") ?? "");

// A proxy that wants a sign-in answers an API call with a redirect to its login page, a 401/403, or the login page itself.
// With `redirect: "manual"` a redirect arrives as an "opaqueredirect" response (status 0).
const wantsSignIn = (res) => res.type === "opaqueredirect" || res.redirected || res.status === 401 || res.status === 403;

// Throws the matching failure unless the response is one the app can use.
export function assertUsable(res) {
  if (wantsSignIn(res)) throw new SyncFailure({ kind: "sign-in" }, res);
  if (res.status >= 500) throw new SyncFailure({ kind: "server-error", status: res.status }, res);
  if (!res.ok) throw new SyncFailure({ kind: "client-error", status: res.status }, res);
  if (!isJson(res)) throw new SyncFailure({ kind: "sign-in" }, res); // HTML where JSON was expected: a login page
}

