// Offline-first sync core. No browser globals: storage and fetch are injected so it runs under `bun test`.
//
// Items are replaced, never mutated, so object identity tells us whether an item changed while a request was in flight.

export function createSync({ storage, fetch, now = () => Date.now(), onChange = () => {}, onStatus = () => {} }) {
  const items = new Map(); // id -> {id, text, ts, removed, seq}
  const dirty = new Set(); // ids with changes the server has not acknowledged
  let lastSeq = 0;
  let state = "syncing";
  let running = null;
  let rerun = false;

  const status = () => ({ state, pending: dirty.size });
  const setState = (s) => {
    state = s;
    onStatus(status());
  };

  async function setItem(item) {
    items.set(item.id, item);
    dirty.add(item.id);
    await storage.putItem(item);
    await storage.setDirty([...dirty]);
    onChange();
    onStatus(status());
    syncNow().catch(() => {});
  }

  async function pass() {
    setState("syncing");
    try {
      for (const id of [...dirty]) {
        const sent = items.get(id);
        const res = await fetch(`/api/items/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: sent.text, ts: sent.ts, removed: sent.removed }),
        });
        if (!res.ok) throw new Error(`PUT ${id} failed: ${res.status}`);
        const saved = await res.json();
        if (items.get(id) === sent) {
          items.set(id, saved);
          dirty.delete(id);
          await storage.putItem(saved);
          await storage.setDirty([...dirty]);
        }
      }

      const res = await fetch(`/api/items?since=${lastSeq}`);
      if (!res.ok) throw new Error(`GET items failed: ${res.status}`);
      const data = await res.json();

      if (data.seq < lastSeq) {
        // The server's numbering went backwards: its database was replaced. Start over and re-send everything.
        lastSeq = 0;
        await storage.setLastSeq(0);
        for (const id of items.keys()) dirty.add(id);
        await storage.setDirty([...dirty]);
        rerun = true;
        return;
      }

      for (const row of data.items) {
        if (dirty.has(row.id)) continue;
        items.set(row.id, row);
        await storage.putItem(row);
      }
      lastSeq = data.seq;
      await storage.setLastSeq(lastSeq);
      onChange();
      setState(dirty.size ? "syncing" : "synced");
      if (dirty.size) rerun = true;
    } catch {
      setState("offline");
    }
  }

  function syncNow() {
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
      const saved = await storage.load();
      for (const it of saved.items) items.set(it.id, it);
      for (const id of saved.dirty) if (items.has(id)) dirty.add(id);
      lastSeq = saved.lastSeq;
      onChange();
      await syncNow();
    },

    stack() {
      return [...items.values()]
        .filter((i) => !i.removed)
        .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
    },

    async push(text) {
      const trimmed = String(text ?? "").trim();
      if (!trimmed) return null;
      const ts = now();
      const id = `s-${ts.toString(36)}${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
      const item = { id, text: trimmed, ts, removed: false, seq: 0 };
      await setItem(item);
      return item;
    },

    async remove(id) {
      const it = items.get(id);
      if (it && !it.removed) await setItem({ ...it, removed: true });
    },

    async restore(id) {
      const it = items.get(id);
      if (it && it.removed) await setItem({ ...it, removed: false });
    },

    syncNow,
    status,
  };
}
