// Offline-first sync core. No browser globals: storage and fetch are injected so it runs under `bun test`.
//
// Items are replaced, never mutated, so object identity tells us whether an item changed while a request was in flight.

// Client errors that will not fix themselves by retrying the same request straight away.
const permanentlyRejected = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

// What went wrong with a request, as far as the UI needs to tell the person: a kind, plus the HTTP status when there is one.
class SyncFailure extends Error {
  constructor(error) {
    super(error.kind);
    this.error = error;
  }
}

const isJson = (res) => /\bjson\b/i.test(res.headers?.get?.("content-type") ?? "");

// A proxy that wants a sign-in answers an API call with a redirect to its login page, a 401/403, or the login page itself.
// With `redirect: "manual"` a redirect arrives as an "opaqueredirect" response (status 0).
const wantsSignIn = (res) => res.type === "opaqueredirect" || res.redirected || res.status === 401 || res.status === 403;

// Throws the matching failure unless the response is one the app can use. Callers handle 4xx themselves where they must.
function assertUsable(res) {
  if (wantsSignIn(res)) throw new SyncFailure({ kind: "sign-in" });
  if (res.status >= 500) throw new SyncFailure({ kind: "server-error", status: res.status });
  if (!res.ok) throw new SyncFailure({ kind: "client-error", status: res.status });
  if (!isJson(res)) throw new SyncFailure({ kind: "sign-in" }); // HTML where JSON was expected: a login page
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    throw new SyncFailure({ kind: "bad-reply" });
  }
}

// `local` is the static version: nothing is ever sent anywhere, so there is no queue and no network use.
export function createSync({ storage, fetch, now = () => Date.now(), online = () => true, onChange = () => {}, onStatus = () => {}, local = false }) {
  const items = new Map(); // id -> {id, text, ts, at, removed, seq}; `at` is when it last changed state, on this device's clock
  const dirty = new Set(); // ids with changes the server has not acknowledged
  let lastSeq = 0;
  let epoch = null; // identifies the server database we last synced with
  let state = local ? "local" : "syncing";
  let lastError = null; // why the latest pass failed; null after a pass that worked
  let storageFailed = false;
  let running = null;
  let rerun = false;

  const status = () => ({ state, pending: dirty.size, ...(lastError && state !== "syncing" ? { error: lastError } : {}), ...(storageFailed ? { storageFailed: true } : {}) });
  const setState = (s, error = null) => {
    state = s;
    lastError = error;
    onStatus(status());
  };

  // Device storage can fail (quota, eviction, a closed database). The in-memory copy keeps working and
  // keeps syncing; the failure is reported through status() instead of being mistaken for a network error.
  // The flag is sticky: a later successful write must not hide an earlier failure. Each new user action
  // starts it afresh, so it clears once storage works again.
  async function safe(fn) {
    try {
      await fn();
    } catch {
      storageFailed = true;
    }
  }

  // Applies one or more changes together: one redraw, one status update, one sync, so a change made of two parts
  // (a swap) is never seen half done.
  async function setItems(list) {
    storageFailed = false;
    for (const item of list) {
      items.set(item.id, item);
      if (!local) dirty.add(item.id);
    }
    for (const item of list) await safe(() => storage.putItem(item));
    if (!local) await safe(() => storage.setDirty([...dirty]));
    onChange();
    onStatus(status());
    syncNow().catch(() => {});
  }
  const setItem = (item) => setItems([item]);

  const newItem = (text, ts) => {
    const id = `s-${ts.toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
    return { id, text, ts, at: ts, removed: false, seq: 0 };
  };

  const currentStack = () =>
    [...items.values()].filter((i) => !i.removed).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));

  async function pass() {
    setState("syncing");
    try {
      const rejected = new Map(); // id -> status
      const init = { redirect: "manual" };
      for (const id of [...dirty]) {
        const sent = items.get(id);
        const res = await fetch(`/api/items/${encodeURIComponent(id)}`, {
          ...init,
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: sent.text, ts: sent.ts, removed: sent.removed, at: sent.at }),
        });
        if (!wantsSignIn(res) && permanentlyRejected(res.status)) {
          rejected.set(id, res.status); // keep it, but do not let it block the rest of the queue
          continue;
        }
        assertUsable(res);
        const saved = await readJson(res);
        if (items.get(id) === sent) {
          items.set(id, saved);
          dirty.delete(id);
          await safe(() => storage.putItem(saved));
          await safe(() => storage.setDirty([...dirty]));
        }
      }

      const res = await fetch(`/api/items?since=${lastSeq}`, init);
      assertUsable(res);
      const data = await readJson(res);

      const replaced = data.seq < lastSeq || (epoch && data.epoch && data.epoch !== epoch);
      if (replaced) {
        // The server's database was replaced (its epoch changed, or its numbering went backwards).
        // Start over and re-send everything this client holds.
        lastSeq = 0;
        epoch = data.epoch ?? null;
        await safe(() => storage.setLastSeq(0));
        await safe(() => storage.setEpoch?.(epoch));
        for (const id of items.keys()) dirty.add(id);
        await safe(() => storage.setDirty([...dirty]));
        rerun = true;
        return;
      }
      if (data.epoch && data.epoch !== epoch) {
        epoch = data.epoch;
        await safe(() => storage.setEpoch?.(epoch));
      }

      for (const row of data.items) {
        if (dirty.has(row.id)) continue;
        items.set(row.id, row);
        await safe(() => storage.putItem(row));
      }
      lastSeq = data.seq;
      await safe(() => storage.setLastSeq(lastSeq));
      onChange();
      const changedMeanwhile = [...dirty].some((id) => !rejected.has(id));
      if (rejected.size) setState("error", { kind: "client-error", status: [...rejected.values()][0] });
      else setState(changedMeanwhile ? "syncing" : "synced");
      if (changedMeanwhile) rerun = true;
    } catch (e) {
      // A TypeError from fetch means no answer at all: the device has no network, or the server cannot be reached.
      setState("offline", e instanceof SyncFailure ? e.error : { kind: online() ? "unreachable" : "no-network" });
    }
  }

  function syncNow() {
    if (local) return Promise.resolve();
    if (running) {
      rerun = true;
      return running;
    }
    // `running` is cleared in the same tick the loop decides to stop, so a caller that joins can never
    // set `rerun` after the last check and be ignored.
    running = (async () => {
      try {
        do {
          rerun = false;
          await pass();
        } while (rerun); // a failed pass never sets rerun itself, so this cannot spin while offline
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    async start() {
      let saved;
      try {
        saved = await storage.load();
      } catch {
        storageFailed = true;
        saved = { items: [], dirty: [], lastSeq: 0, epoch: null };
      }
      for (const it of saved.items) items.set(it.id, it);
      if (!local) for (const id of saved.dirty) if (items.has(id)) dirty.add(id);
      lastSeq = saved.lastSeq;
      epoch = saved.epoch ?? null;
      onChange();
      if (local) return onStatus(status());
      await syncNow();
    },

    stack: currentStack,

    /** Every item, including removed ones, for views of what has been done. */
    allItems() {
      return [...items.values()];
    },

    async push(text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return null;
      const item = newItem(trimmed, now());
      await setItem(item);
      return item;
    },

    /** Take the current item off the stack and push a new one, as one change. Empty text changes nothing. */
    async swap(text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return null;
      const t = now();
      const top = currentStack()[0] ?? null;
      const removed = top ? { ...top, removed: true, at: t } : null;
      const pushed = newItem(trimmed, t);
      await setItems(removed ? [removed, pushed] : [pushed]);
      return { removed: top, pushed };
    },

    async remove(id) {
      const it = items.get(id);
      if (it && !it.removed) await setItem({ ...it, removed: true, at: now() });
    },

    async restore(id) {
      const it = items.get(id);
      if (it && it.removed) await setItem({ ...it, removed: false, at: now() });
    },

    syncNow,
    status,
  };
}
