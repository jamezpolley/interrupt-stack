import type { Database } from "bun:sqlite";

/**
 * The append-only log of actions (docs/superpowers/specs/2026-11-23-data-model-design.md). One row is one thing the
 * person did. `ts` is the server's clock when it was received, `at` is the person's time (never later than `ts`);
 * neither ever changes. Corrections and undos are further actions that point at earlier ones through `ref`.
 */
export type Action = { n: number; id: string; ts: number; at: number; kind: string; target: string; ref?: string; data?: any; origin?: string };

export const CREATE_ACTIONS = [
  `CREATE TABLE IF NOT EXISTS actions (
     n INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     ts INTEGER NOT NULL,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     target TEXT NOT NULL,
     ref TEXT,
     data TEXT,
     origin TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS actions_target ON actions (target, n)",
  "CREATE INDEX IF NOT EXISTS actions_at ON actions (at)",
];

type ActionRow = { n: number; id: string; ts: number; at: number; kind: string; target: string; ref: string | null; data: string | null; origin: string | null };
export const toAction = (r: ActionRow): Action => ({
  n: r.n,
  id: r.id,
  ts: r.ts,
  at: r.at,
  kind: r.kind,
  target: r.target,
  ...(r.ref ? { ref: r.ref } : {}),
  ...(r.data ? { data: JSON.parse(r.data) } : {}),
  ...(r.origin ? { origin: r.origin } : {}),
});

type Opts = { origin?: string | null; mkId: () => string };

/**
 * Writes actions. `fromEvent` turns one thing the store has just done (an old-style event: push, pop, restore, edit,
 * delete, ...) into the action(s) that record it, so the live write path and the conversion of old data share one
 * translation. A legacy `restore` is the app's undo, so it becomes a `void` of the latest pop.
 */
export function makeRecorder(db: Database) {
  const insert = db.prepare("INSERT OR IGNORE INTO actions (id, ts, at, kind, target, ref, data, origin) VALUES ($id, $ts, $at, $kind, $target, $ref, $data, $origin)");
  const latest = db.prepare(
    "SELECT id FROM actions WHERE target = $t AND kind = $k AND id NOT IN (SELECT ref FROM actions WHERE kind = 'void' AND ref IS NOT NULL) ORDER BY n DESC LIMIT 1",
  );
  const lastOf = (target: string, kind: string) => (latest.get({ $t: target, $k: kind }) as { id: string } | null)?.id ?? null;
  const newId = () => `a-${crypto.randomUUID()}`;

  function put(id: string, kind: string, target: string, ts: number, at: number, data: unknown, ref: string | null = null, origin: string | null = null) {
    const safeAt = Math.max(0, Math.min(at, ts)); // the person's time is never later than the server's
    insert.run({ $id: id, $ts: ts, $at: safeAt, $kind: kind, $target: target, $ref: ref, $data: data === null || data === undefined ? null : JSON.stringify(data), $origin: origin });
  }

  function fromEvent(op: string, id: string, text: string, ts: number, at: number, detail: string | null, o: Opts) {
    switch (op) {
      case "push":
        put(o.mkId(), "push", id, ts, at, { text, ...(o.origin ? { origin: o.origin } : {}) });
        break;
      case "pop":
      case "delete":
      case "undelete":
      case "dequeue":
      case "requeue":
      case "start":
        put(o.mkId(), op, id, ts, at, null);
        break;
      case "restore": {
        const pop = lastOf(id, "pop");
        if (pop) put(o.mkId(), "void", id, ts, at, null, pop);
        break;
      }
      case "queue":
        put(o.mkId(), "later", id, ts, at, { text });
        break;
      case "note":
        put(o.mkId(), "note", id, ts, at, { text });
        break;
      case "edit": {
        const d = detail ? (JSON.parse(detail) as Record<string, { from: unknown; to: unknown }>) : {};
        if (d.text) put(o.mkId(), "edit", id, ts, at, { text: d.text.to });
        // Editing the push time (or a note's time) corrects the action that made it; editing the end time, the latest pop.
        if (d.ts) {
          const ref = lastOf(id, id.startsWith("n-") ? "note" : "push");
          if (ref) put(o.mkId(), "edit", id, ts, at, { at: d.ts.to }, ref);
        }
        if (d.at) {
          const ref = lastOf(id, "pop");
          if (ref) put(o.mkId(), "edit", id, ts, at, { at: d.at.to }, ref);
        }
        break;
      }
    }
  }

  return { put, fromEvent, lastOf, newId };
}

/**
 * Migration 1: builds the actions log from what the database already holds. Events become actions one for one (an
 * event's `ts` and `at` carry over; ids are `ev-<n>`). Rows that predate the event log have no events, so each gets
 * the actions that would explain it, marked `synth` (received time unknown: it is set to the person's time).
 */
export function convertLegacy(db: Database) {
  const rec = makeRecorder(db);
  const origins = new Map((db.prepare("SELECT id, origin FROM items WHERE origin IS NOT NULL").all() as { id: string; origin: string }[]).map((r) => [r.id, r.origin]));
  const events = db.prepare("SELECT n, ts, at, op, id, text, detail FROM events ORDER BY n ASC").all() as { n: number; ts: number; at: number; op: string; id: string; text: string; detail: string | null }[];
  for (const e of events) {
    let i = 0;
    rec.fromEvent(e.op, e.id, e.text, e.ts, e.at, e.detail, { origin: e.op === "push" ? origins.get(e.id) : null, mkId: () => `ev-${e.n}-${i++}` });
  }
  const has = db.prepare("SELECT 1 AS x FROM actions WHERE target = $t AND kind = $k LIMIT 1");
  const seen = (t: string, k: string) => has.get({ $t: t, $k: k }) !== null;
  const items = db.prepare("SELECT id, text, ts, at, removed, origin, deleted FROM items ORDER BY ts, id").all() as { id: string; text: string; ts: number; at: number | null; removed: number; origin: string | null; deleted: number }[];
  for (const r of items) {
    if (!seen(r.id, "push")) {
      rec.put(`syn-${r.id}-push`, "push", r.id, r.ts, r.ts, { text: r.text, synth: true, ...(r.origin ? { origin: r.origin } : {}) });
      if (r.removed === 1) {
        const end = r.at ?? r.ts;
        rec.put(`syn-${r.id}-pop`, "pop", r.id, end, end, { synth: true });
      }
    }
    if (r.deleted === 1 && !seen(r.id, "delete")) rec.put(`syn-${r.id}-delete`, "delete", r.id, r.ts, r.ts, { synth: true });
  }
  const notes = db.prepare("SELECT id, text, ts, removed FROM notes ORDER BY ts, id").all() as { id: string; text: string; ts: number; removed: number }[];
  for (const r of notes) {
    if (!seen(r.id, "note")) {
      rec.put(`syn-${r.id}-note`, "note", r.id, r.ts, r.ts, { text: r.text, synth: true });
      if (r.removed === 1) rec.put(`syn-${r.id}-delete`, "delete", r.id, r.ts, r.ts, { synth: true });
    }
  }
  const queue = db.prepare("SELECT id, text, ts, at, removed, started FROM queue ORDER BY ts, id").all() as { id: string; text: string; ts: number; at: number; removed: number; started: number }[];
  for (const r of queue) {
    if (!seen(r.id, "later")) {
      rec.put(`syn-${r.id}-later`, "later", r.id, r.ts, r.ts, { text: r.text, synth: true });
      if (r.removed === 1) rec.put(`syn-${r.id}-leave`, r.started === 1 ? "start" : "dequeue", r.id, r.at, r.at, { synth: true });
    }
  }
}
