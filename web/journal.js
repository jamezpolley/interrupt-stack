// The client's journal: every action this device made or received, the state the shared reducer (reduce.js) derives from
// them, and the sync of that journal with the server over the actions wire (POST /api/sync with `actions`).
//
// Nothing here knows about the stack, the queue or notes: sync.js, queue.js and notes.js are views over this state. No
// browser globals: storage and fetch are injected, so it runs under `bun test`.
//
// A local action is stamped at once with this device's clock (`ts` = `at` = now) and is *pending* until the server
// answers with it again, carrying the server's `ts` and its place in the log (`n`). The state is always the reduction of
// the acknowledged actions in `n` order followed by the pending ones in the order they were made, so another device's
// action that arrives later but sits earlier in the log slots into its place.
import { reduce } from "./reduce.js";
import { BATCH, SYNC_URL, SyncFailure, assertUsable, describeResponse } from "./net.js";

async function readJson(res) {
  let text = null;
  try {
    text = await res.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || typeof data.cursor !== "number" || !Array.isArray(data.actions)) throw new Error("not a sync reply");
    return data;
  } catch {
    throw new SyncFailure({ kind: "bad-reply" }, res, text);
  }
}

const newId = () => `a-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;

/**
 * `storage`: `{ load() -> {actions, cursor, epoch}, putAction(a), deleteAction(id), setCursor(n), setEpoch(e) }`.
 * `local` is the static version: nothing is sent anywhere, so every action stays pending-free and there is no network use.
 */
export function createJournal({ storage, fetch, now = () => Date.now(), online = () => true, onChange = () => {}, onStatus = () => {}, local = false, makeId = newId }) {
  const acked = new Map(); // id -> action with `n`
  let pending = []; // local actions the server has not acknowledged, in the order they were made
  let cursor = 0;
  let epoch = null;
  let state = local ? "local" : "syncing";
  let lastFailure = null;
  let lastError = null;
  let storageFailed = false;
  let running = null;
  let rerun = false;
  let loaded = null;
  let view = null; // the reduced state, rebuilt when the journal changes
  const refused = []; // actions the server refused: { id, kind, target, error }, for the Debug panel; they are dropped

  const status = () => ({ state, pending: pending.length, ...(!local && epoch === null ? { neverSynced: true } : {}), ...(lastError && state !== "syncing" ? { error: lastError } : {}), ...(storageFailed ? { storageFailed: true } : {}) });
  const setState = (s, error = null) => {
    state = s;
    lastError = error;
    if (!error) lastFailure = null;
    onStatus(status());
  };
  async function safe(fn) {
    try {
      await fn();
    } catch {
      storageFailed = true;
    }
  }

  const ordered = () => [...[...acked.values()].sort((a, b) => a.n - b.n), ...pending];
  const invalidate = () => (view = null);
  /** The state the reducer derives from everything this device knows. Cached until the journal changes. */
  const stateNow = () => (view ??= reduce(ordered()));

  /** Loads what is saved, once; anything that syncs waits for it. */
  function load() {
    loaded ??= (async () => {
      let saved = null;
      try {
        saved = await storage.load();
      } catch {
        storageFailed = true;
      }
      cursor = saved?.cursor ?? 0;
      epoch = saved?.epoch ?? null;
      for (const a of saved?.actions ?? []) {
        if (a.sent === false) pending.push(a);
        else acked.set(a.id, a);
      }
      pending.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
      invalidate();
    })();
    return loaded;
  }

  async function putSaved(a, sent) {
    await safe(() => storage.putAction({ ...a, sent }));
  }

  async function pass() {
    setState("syncing");
    await load();
    const req = { method: "POST", url: SYNC_URL };
    try {
      const batch = pending.slice(0, BATCH);
      const wire = batch.map(({ id, at, kind, target, ref, data }) => ({ id, at, kind, target, ...(ref ? { ref } : {}), ...(data ? { data } : {}) }));
      const res = await fetch(SYNC_URL, { redirect: "manual", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ epoch, cursor, actions: wire }) });
      assertUsable(res);
      const data = await readJson(res);

      const replaced = data.cursor < cursor || (epoch && data.epoch && data.epoch !== epoch);
      if (replaced) {
        // The server's database was replaced (its epoch changed, or its numbering went backwards). Start over: everything
        // this device holds becomes pending again and is sent in order, so the server is rebuilt from the journal.
        cursor = 0;
        epoch = data.epoch ?? null;
        const all = ordered();
        acked.clear();
        pending = all.map((a) => ({ id: a.id, ts: a.ts, at: a.at, kind: a.kind, target: a.target, ...(a.ref ? { ref: a.ref } : {}), ...(a.data ? { data: a.data } : {}) }));
        invalidate();
        for (const a of pending) await putSaved(a, false);
        await safe(() => storage.setCursor(0));
        await safe(() => storage.setEpoch?.(epoch));
        rerun = true;
        onChange();
        return;
      }
      if (data.epoch && data.epoch !== epoch) {
        epoch = data.epoch;
        await safe(() => storage.setEpoch?.(epoch));
      }

      // What the server did with each action: stored (it comes back below, stamped) or refused (dropped, and reported).
      const rejected = data.rejected ?? {};
      const refusedNow = [];
      for (const [id, why] of Object.entries(rejected)) {
        const a = pending.find((p) => p.id === id);
        if (!a) continue;
        pending = pending.filter((p) => p.id !== id);
        refused.push({ id, kind: a.kind, target: a.target, error: why?.error ?? "refused" });
        refusedNow.push({ id, error: why?.error ?? "refused" });
        await safe(() => storage.deleteAction?.(id));
      }
      for (const a of data.actions) {
        pending = pending.filter((p) => p.id !== a.id);
        acked.set(a.id, a);
        await putSaved(a, true);
      }
      invalidate();
      cursor = data.cursor;
      await safe(() => storage.setCursor(cursor));
      if (refusedNow.length) {
        lastFailure = { at: now(), request: req, online: online(), response: { status: 400, statusText: "change refused", type: res.type ?? "", redirected: false, url: res.url ?? "", headers: [["content-type", "application/json"]], body: JSON.stringify(refusedNow) } };
      }
      onChange();
      if (refusedNow.length) setState("error", { kind: "client-error", status: 400 });
      else setState(pending.length ? "syncing" : "synced");
      if (data.more || pending.length) rerun = true;
    } catch (e) {
      const detail = { at: now(), request: req, online: online() };
      if (e instanceof SyncFailure && e.res) detail.response = await describeResponse(e.res, e.body);
      else if (!(e instanceof SyncFailure)) detail.error = { name: e?.name ?? "Error", message: String(e?.message ?? e) };
      lastFailure = detail;
      setState("offline", e instanceof SyncFailure ? e.error : { kind: online() ? "unreachable" : "no-network" });
    }
  }

  function syncNow() {
    if (local) return Promise.resolve();
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await pass();
        } while (rerun);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    load,
    /** Reads what is saved and syncs once. */
    async start() {
      await load();
      onChange();
      if (local) return onStatus(status());
      await syncNow();
    },
    /** The state derived from every action this device knows (see reduce.js). */
    state: stateNow,
    /** Every action, acknowledged ones in log order, then pending ones. */
    actions: ordered,
    has: (id) => acked.has(id) || pending.some((p) => p.id === id),
    /**
     * Records one or more actions made now, together: one redraw, one status update, one sync. Each is
     * `{ kind, target, ref?, data?, at?, id? }`. An id already known is not recorded again (so a retried action is one action).
     */
    async append(list) {
      await load();
      storageFailed = false;
      const t = now();
      const made = [];
      for (const x of list) {
        const id = x.id ?? makeId();
        if (acked.has(id) || pending.some((p) => p.id === id)) continue;
        const a = { id, ts: t, at: Math.min(x.at ?? t, t), kind: x.kind, target: x.target, ...(x.ref ? { ref: x.ref } : {}), ...(x.data ? { data: x.data } : {}) };
        pending.push(a);
        made.push(a);
      }
      if (!made.length) return [];
      invalidate();
      for (const a of made) await putSaved(a, local ? true : false);
      if (local) {
        // Nothing to send: the action is as settled as it will ever be.
        for (const a of made) {
          pending = pending.filter((p) => p.id !== a.id);
          acked.set(a.id, { ...a, n: acked.size + 1 });
        }
        invalidate();
      }
      onChange();
      onStatus(status());
      syncNow().catch(() => {});
      return made;
    },
    syncNow,
    status,
    lastFailure: () => lastFailure,
    /** Actions the server refused (and so were dropped), newest last. */
    refused: () => [...refused],
    onStatus: () => onStatus(status()),
    local,
  };
}
