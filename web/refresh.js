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

// Is the server running newer web files than this copy of the app? Returns true or false, or null when that
// cannot be known (server unreachable, a sign-in redirect, an unexpected answer): the caller should then say nothing.
export async function updateAvailable({ fetch, current, url = "/api/version" }) {
  if (!current) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok || res.redirected) return null;
    const { version } = await res.json();
    return typeof version === "string" && version ? version !== current : null;
  } catch {
    return null;
  }
}
