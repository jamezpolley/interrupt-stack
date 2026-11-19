// The queue: a pile of things to do later, in no particular order. It is a separate structure from the stack, with its
// own sync state (this file), its own IndexedDB database, and its own API (/api/queue). The stack's code (sync.js)
// knows nothing about it, so a cached client from before the queue existed ignores it and keeps working.
//
// Like sync.js this has no browser globals: storage and fetch are injected so it runs under `bun test`.

/** The label the person sees for this pile. Rename it here and nowhere else. */
export const QUEUE_LABEL = "Later";

/**
 * Starting a queued task pushes it onto the stack as `s-` plus the rest of its id. The id is derived, not random, so
 * repeating the push (a retry after a crash or a dropped connection, or a second device starting the same row)
 * lands on the same stack item instead of making a second one.
 */
export const stackIdFor = (queueId) => "s-" + queueId.slice(2);

const permanentlyRejected = (status) => status >= 400 && status < 500 && status !== 408 && status !== 429;

// `local` is the static version: nothing is sent anywhere. `stack` is the stack's sync (sync.js), used by `promote`.
export function createQueue({ storage, fetch, stack, now = () => Date.now(), onChange = () => {}, onStatus = () => {}, local = false }) {
  const items = new Map(); // id -> {id, text, ts, at, removed, started, seq}; `removed` rows are tombstones
  const dirty = new Set();
  let lastSeq = 0;
  let epoch = null;
  let state = local ? "local" : "syncing";
  let storageFailed = false;
  let running = null;
  let rerun = false;
  const starting = new Set(); // ids whose start is under way here, so reconcile leaves them to promote

  const status = () => ({ state, pending: dirty.size, ...(storageFailed ? { storageFailed: true } : {}) });
  const setState = (s) => {
    state = s;
    onStatus(status());
  };
  async function safe(fn) {
    try {
      await fn();
    } catch {
      storageFailed = true;
    }
  }

  async function setItem(item) {
    storageFailed = false;
    items.set(item.id, item);
    if (!local) dirty.add(item.id);
    await safe(() => storage.putItem(item));
    if (!local) await safe(() => storage.setDirty([...dirty]));
    onChange();
    onStatus(status());
    syncNow().catch(() => {});
  }

  const newItem = (text, ts) => ({
    id: `q-${ts.toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`,
    text,
    ts,
    at: ts,
    removed: false,
    started: false,
    seq: 0,
  });

  // Newest added first. It is a pile, not a line: nothing about the order means "next".
  const current = () =>
    [...items.values()].filter((i) => !i.removed).sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));

  async function pass() {
    setState("syncing");
    try {
      const rejected = new Set();
      for (const id of [...dirty]) {
        const sent = items.get(id);
        const res = await fetch(`/api/queue/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: sent.text, ts: sent.ts, removed: sent.removed, started: !!sent.started, at: sent.at }),
        });
        if (permanentlyRejected(res.status)) {
          rejected.add(id);
          continue;
        }
        if (!res.ok) throw new Error(`PUT ${id} failed: ${res.status}`);
        const saved = await res.json();
        if (items.get(id) === sent) {
          items.set(id, saved);
          dirty.delete(id);
          await safe(() => storage.putItem(saved));
          await safe(() => storage.setDirty([...dirty]));
        }
      }

      const res = await fetch(`/api/queue?since=${lastSeq}`);
      if (!res.ok) throw new Error(`GET queue failed: ${res.status}`);
      const data = await res.json();

      const replaced = data.seq < lastSeq || (epoch && data.epoch && data.epoch !== epoch);
      if (replaced) {
        // The server's database was replaced: start over and re-send everything this device holds.
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
      setState(rejected.size ? "error" : changedMeanwhile ? "syncing" : "synced");
      if (changedMeanwhile) rerun = true;
    } catch {
      setState("offline");
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

  // The second part of a start: the row is tombstoned and marked started (not dropped).
  const finishStart = (it) => setItem({ ...it, removed: true, started: true, at: now() });

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

    queue: current,

    /** Put a task on the pile. Empty text changes nothing. */
    async add(text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return null;
      const item = newItem(trimmed, now());
      await setItem(item);
      return item;
    },

    async drop(id) {
      const it = items.get(id);
      if (it && !it.removed) await setItem({ ...it, removed: true, started: false, at: now() });
    },

    /** Undo a drop. A started row is not restorable: it is on the stack now. */
    async restore(id) {
      const it = items.get(id);
      if (it && it.removed && !it.started) await setItem({ ...it, removed: false, at: now() });
    },

    /**
     * Start: move a row from the queue to the top of the stack. Two writes, in two structures that sync separately:
     *   1. push onto the stack under the derived id (skipped if that id is already there, even if since popped);
     *   2. tombstone the queue row as started.
     * Each step is safe to repeat, and step 1 is saved on the device before step 2 begins. If the app dies between
     * them, `reconcile` finishes step 2 the next time it runs, so the row is never left looking unstarted next to
     * its own stack item, and never pushed twice.
     */
    async promote(id) {
      const it = items.get(id);
      if (!it || it.removed) return null;
      starting.add(id);
      try {
        const pushed = await stack.push(it.text, { id: stackIdFor(id) });
        await finishStart(it);
        return pushed;
      } finally {
        starting.delete(id);
      }
    },

    /** Finish any start that was interrupted: a live row whose stack item already exists is tombstoned as started. */
    async reconcile() {
      for (const it of [...items.values()]) {
        if (!it.removed && !starting.has(it.id) && stack.has(stackIdFor(it.id))) await finishStart(it);
      }
    },

    syncNow,
    status,
  };
}
