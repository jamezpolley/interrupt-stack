// LEGACY: the row-based client sync of before the actions log. Kept only to send an upgrading device its last unsent changes
// over the old wire once (see upgrade.js); the app itself uses journal.js. It is retired with the old wire (step 4).
// The shared sync core. No browser globals: fetch and storage are injected so it runs under `bun test`.
//
// There is ONE channel for every synced table (the stack, the Later queue, and whatever comes next): one cursor, one
// epoch, one request that carries every table's pending changes and returns everything changed since the cursor.
// A table is registered with `hub.table(name, options)`; the table keeps its own rows and pending set and nothing else.
//
// Rows are replaced, never mutated, so object identity tells us whether a row changed while a request was in flight.

import { BATCH, SyncFailure, SYNC_URL, assertUsable, describeResponse } from "./net.js";
export { SyncFailure, SYNC_URL };

async function readJson(res) {
  let text = null;
  try {
    text = await res.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || typeof data.cursor !== "number" || !data.tables || typeof data.tables !== "object") throw new Error("not a sync reply");
    return data;
  } catch {
    throw new SyncFailure({ kind: "bad-reply" }, res, text);
  }
}

/**
 * `meta` holds the cursor and the epoch: `{ load() -> {cursor, epoch}, setCursor(n), setEpoch(e) }`.
 * `local` is the static version: nothing is ever sent anywhere, so there is no pending set and no network use.
 */
export function createHub({ meta, fetch, now = () => Date.now(), online = () => true, onStatus = () => {}, local = false }) {
  const tables = new Map(); // name -> table
  let cursor = 0; // the highest change number received, for every table at once
  let epoch = null; // identifies the server database we last synced with
  let state = local ? "local" : "syncing";
  let lastFailure = null; // raw detail of the latest failed call, in memory only
  let lastError = null; // why the latest pass failed; null after a pass that worked
  let storageFailed = false;
  let running = null;
  let rerun = false;
  let loading = null;
  const refused = new Set(); // `${table}\0${id}` the server refused (validation), tried again last and never blocking

  const pending = () => [...tables.values()].reduce((n, t) => n + t.dirty.size, 0);
  const status = () => ({ state, pending: pending(), ...(!local && epoch === null ? { neverSynced: true } : {}), ...(lastError && state !== "syncing" ? { error: lastError } : {}), ...(storageFailed ? { storageFailed: true } : {}) });
  const setState = (s, error = null) => {
    state = s;
    lastError = error;
    if (!error) lastFailure = null;
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

  const key = (t, id) => `${t.name}\0${id}`;

  /** Loads the cursor and epoch once; anything that syncs waits for it. */
  function load() {
    loading ??= (async () => {
      try {
        const saved = await meta.load();
        cursor = saved?.cursor ?? 0;
        epoch = saved?.epoch ?? null;
      } catch {
        storageFailed = true;
      }
    })();
    return loading;
  }

  function table(name, { storage, onChange = () => {}, toWire }) {
    const t = {
      name,
      items: new Map(), // id -> row; `removed` rows are tombstones
      dirty: new Set(), // ids with changes the server has not acknowledged
      storage,
      onChange,
      toWire,
      loaded: false, // until its saved rows and pending list are in memory, nothing may write that list back
      async load() {
        let saved;
        try {
          saved = await storage.load();
        } catch {
          storageFailed = true;
          saved = { items: [], dirty: [] };
        }
        for (const it of saved.items) t.items.set(it.id, it);
        if (!local) for (const id of saved.dirty) if (t.items.has(id)) t.dirty.add(id);
        t.loaded = true;
        await load();
      },
      // Applies one or more changes together: one redraw, one status update, one sync, so a change made of two parts
      // (a swap) is never seen half done.
      async setItems(list) {
        storageFailed = false;
        for (const item of list) {
          t.items.set(item.id, item);
          refused.delete(key(t, item.id));
          if (!local) t.dirty.add(item.id);
        }
        for (const item of list) await safe(() => storage.putItem(item));
        if (!local) await safe(() => storage.setDirty([...t.dirty]));
        onChange();
        onStatus(status());
        syncNow().catch(() => {});
      },
    };
    tables.set(name, t);
    return t;
  }

  async function pass() {
    setState("syncing");
    await load();
    const req = { method: "POST", url: SYNC_URL }; // the call in flight, for the failure detail
    try {
      // Everything pending, the rows the server refused last, and at most BATCH of them.
      const queued = [];
      for (const t of tables.values()) for (const id of t.dirty) queued.push({ t, id, refused: refused.has(key(t, id)) });
      queued.sort((a, b) => Number(a.refused) - Number(b.refused));
      const sent = [];
      const changes = {};
      for (const { t, id } of queued.slice(0, BATCH)) {
        const row = t.items.get(id);
        sent.push({ t, id, row });
        (changes[t.name] ??= {})[id] = t.toWire(row);
      }

      const res = await fetch(SYNC_URL, {
        redirect: "manual",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ epoch, cursor, changes }),
      });
      assertUsable(res);
      const data = await readJson(res);

      // What the server did with each change: stored (replace our copy unless it changed again meanwhile) or refused.
      const rejectedNow = [];
      for (const { t, id, row } of sent) {
        const result = data.tables[t.name];
        const saved = result?.saved?.[id];
        const refusal = result?.rejected?.[id];
        if (saved) {
          refused.delete(key(t, id));
          if (t.items.get(id) === row) {
            t.items.set(id, saved);
            t.dirty.delete(id);
            await safe(() => t.storage.putItem(saved));
          }
        } else if (refusal) {
          refused.add(key(t, id));
          rejectedNow.push({ table: t.name, id, error: refusal.error });
        }
      }
      for (const t of tables.values()) if (t.loaded) await safe(() => t.storage.setDirty?.([...t.dirty]));
      if (rejectedNow.length) {
        lastFailure = {
          at: now(),
          request: req,
          online: online(),
          response: { status: 400, statusText: "change refused", type: res.type ?? "", redirected: false, url: res.url ?? "", headers: [["content-type", "application/json"]], body: JSON.stringify(rejectedNow) },
        };
      }

      const replaced = data.cursor < cursor || (epoch && data.epoch && data.epoch !== epoch);
      if (replaced) {
        // The server's database was replaced (its epoch changed, or its numbering went backwards).
        // Start over and re-send everything this client holds.
        cursor = 0;
        epoch = data.epoch ?? null;
        refused.clear();
        await safe(() => meta.setCursor(0));
        await safe(() => meta.setEpoch?.(epoch));
        for (const t of tables.values()) {
          for (const id of t.items.keys()) t.dirty.add(id);
          if (t.loaded) await safe(() => t.storage.setDirty?.([...t.dirty]));
        }
        rerun = true;
        return;
      }
      if (data.epoch && data.epoch !== epoch) {
        epoch = data.epoch;
        await safe(() => meta.setEpoch?.(epoch));
      }

      for (const t of tables.values()) {
        for (const row of data.tables[t.name]?.rows ?? []) {
          if (t.dirty.has(row.id)) continue;
          t.items.set(row.id, row);
          await safe(() => t.storage.putItem(row));
        }
      }
      cursor = data.cursor;
      await safe(() => meta.setCursor(cursor));
      for (const fn of new Set([...tables.values()].map((t) => t.onChange))) fn();
      const changedMeanwhile = [...tables.values()].some((t) => [...t.dirty].some((id) => !refused.has(key(t, id))));
      if (rejectedNow.length) setState("error", { kind: "client-error", status: 400 });
      else setState(changedMeanwhile ? "syncing" : "synced");
      if (changedMeanwhile) rerun = true;
    } catch (e) {
      const detail = { at: now(), request: req, online: online() };
      if (e instanceof SyncFailure && e.res) detail.response = await describeResponse(e.res, e.body);
      else if (!(e instanceof SyncFailure)) detail.error = { name: e?.name ?? "Error", message: String(e?.message ?? e) };
      lastFailure = detail;
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

  return { table, load, syncNow, status, onStatus: () => onStatus(status()), lastFailure: () => lastFailure, local };
}
