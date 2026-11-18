// Force the app to pick up a new version: clear the cached app files and the service worker, then reload.
// The stack itself lives in IndexedDB and is never touched here.
//
// Clearing the cache while offline would leave an app that cannot open at all, so the server is checked first
// and nothing is cleared unless it answers. /healthz is used (the static version passes its version.json) because
// the service worker never intercepts it:
// asking for the page itself would just be answered from the cache this is about to clear.
export async function forceRefresh({ fetch, caches, serviceWorker, reload, checkUrl = "/healthz" }) {
  let res;
  try {
    res = await fetch(checkUrl, { cache: "no-store" });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  // A proxy that wants a sign-in answers with a redirect to its login page.
  if (res.redirected) return { ok: false, reason: "signed-out" };
  if (!res.ok) return { ok: false, reason: "unreachable" };

  // Best effort from here: the server is reachable, so reloading is safe even if clearing partly fails.
  try {
    if (caches) for (const name of await caches.keys()) await caches.delete(name);
  } catch {}
  try {
    if (serviceWorker) for (const reg of await serviceWorker.getRegistrations()) await reg.unregister();
  } catch {}
  reload();
  return { ok: true };
}

// What the server says about itself (GET /api/version, or version.json in the static version). Null when it cannot
// be known: server unreachable, a sign-in redirect, or an unexpected answer.
export async function readVersionInfo({ fetch, url = "/api/version" }) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok || res.redirected) return null;
    const info = await res.json();
    return info && typeof info === "object" ? info : null;
  } catch {
    return null;
  }
}

// Is the server running newer web files than this copy of the app? Returns true or false, or null when that
// cannot be known: the caller should then say nothing.
export async function updateAvailable({ fetch, current, url = "/api/version" }) {
  if (!current) return null;
  const info = await readVersionInfo({ fetch, url });
  return typeof info?.version === "string" && info.version ? info.version !== current : null;
}

// Asks the server to look at GitHub in the background. It answers at once; the result shows up in /api/version
// a little later. Fire and forget: `keepalive` lets the request finish even if the page reloads straight after.
export async function requestServerCheck({ fetch }) {
  try {
    await fetch("/api/update-check", { method: "POST", keepalive: true });
  } catch {}
}

// The notice for when GitHub holds a different commit than the one the server is running, or null.
export function describeServerUpdate(info) {
  const update = info?.update;
  if (!update?.enabled || !update.available) return null;
  return `GitHub's ${update.available.ref} is now at ${update.available.short}. Redeploy or restart to apply.`;
}
