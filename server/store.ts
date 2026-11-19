import { Database } from "bun:sqlite";

/** `at` is the device's clock when the item last changed state (equal to `ts` for a fresh push). */
export type Item = { id: string; text: string; ts: number; at: number; removed: boolean; seq: number; origin?: string; edited_at?: number };
/**
 * `origin` is the id of the item this one was pushed again from. It is set once, when the row is created, and never
 * changes. Absent or null means "not given": a write without it (an older client) leaves a stored origin untouched.
 */
/**
 * `edit: true` marks a deliberate correction of an existing item's text, ts or (for a finished item) end time.
 * Without it, a write to an existing row keeps the stored text and ts, so a client holding an old copy (an older
 * build, or a device that has not synced yet) cannot undo an edit by sending its state again. A new row ignores it.
 */
export type ItemInput = { text: string; ts: number; removed: boolean; at?: number; origin?: string | null; edit?: boolean };
export type LogEvent = { n: number; ts: number; at: number; op: "push" | "pop" | "restore" | "queue" | "dequeue" | "requeue" | "start" | "edit"; id: string; text: string; detail?: string };

/**
 * The queue is a pile of things to do later, kept apart from the stack: its own table, its own `seq` numbering and
 * its own API, so an old client that knows nothing of it never sees it. A removed row is a tombstone; `started` says
 * it was removed because it was started (pushed onto the stack as `s-` plus the rest of its id), not dropped.
 */
export type QueueItem = { id: string; text: string; ts: number; at: number; removed: boolean; started: boolean; seq: number };
export type QueueInput = { text: string; ts: number; removed: boolean; started?: boolean; at?: number };

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export const MAX_TEXT = 200;
const SKEW_MS = 5 * 60_000; // how far past the server clock an edited time may be before it is refused
const ID_RE = /^s-[a-z0-9]{4,40}$/;
const QUEUE_ID_RE = /^q-[a-z0-9]{4,40}$/;

export interface Store {
  /** Identifies this database. A client that sees it change knows the server's data was replaced. */
  readonly epoch: string;
  upsert(id: string, input: ItemInput): Item;
  since(seq: number): { seq: number; items: Item[] };
  counts(): { live: number; removed: number };
  /** Every push, pop and restore the server has seen, oldest first. */
  log(): LogEvent[];
  upsertQueue(id: string, input: QueueInput): QueueItem;
  queueSince(seq: number): { seq: number; items: QueueItem[] };
  queueCounts(): { queued: number; removed: number };
  close(): void;
}

type QueueRow = { id: string; text: string; ts: number; at: number; removed: number; started: number; seq: number };
const toQueueItem = (r: QueueRow): QueueItem => ({ id: r.id, text: r.text, ts: r.ts, at: r.at, removed: r.removed === 1, started: r.started === 1, seq: r.seq });

type Row = { id: string; text: string; ts: number; at: number | null; removed: number; seq: number; origin: string | null; edited_at: number | null };
// `origin` is left out when there is none, so rows that were never pushed again look exactly as they always did.
const toItem = (r: Row): Item => ({ id: r.id, text: r.text, ts: r.ts, at: r.at ?? r.ts, removed: r.removed === 1, seq: r.seq, ...(r.origin ? { origin: r.origin } : {}), ...(r.edited_at != null ? { edited_at: r.edited_at } : {}) });

export function openStore(path: string, opts: { now?: () => number } = {}): Store {
  const clock = opts.now ?? Date.now;
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(
    "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, at INTEGER, removed INTEGER NOT NULL, seq INTEGER NOT NULL)",
  );
  // Databases created before the event log have no `at` column.
  const columns = db.prepare("PRAGMA table_info(items)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "at")) db.run("ALTER TABLE items ADD COLUMN at INTEGER");
  // Databases created before "push again" have no `origin` column.
  if (!columns.some((c) => c.name === "origin")) db.run("ALTER TABLE items ADD COLUMN origin TEXT");
  // Databases created before editing have no `edited_at` (when the item was last corrected; null if never).
  if (!columns.some((c) => c.name === "edited_at")) db.run("ALTER TABLE items ADD COLUMN edited_at INTEGER");
  db.run(
    "CREATE TABLE IF NOT EXISTS events (n INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, at INTEGER NOT NULL, op TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL)",
  );
  // An `edit` event keeps what changed in `detail`, as JSON: {text?: {from, to}, ts?: {from, to}, at?: {from, to}}.
  if (!(db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).some((c) => c.name === "detail")) db.run("ALTER TABLE events ADD COLUMN detail TEXT");
  db.run("CREATE INDEX IF NOT EXISTS items_seq ON items (seq)");
  db.run(
    "CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, at INTEGER NOT NULL, removed INTEGER NOT NULL, started INTEGER NOT NULL, seq INTEGER NOT NULL)",
  );
  db.run("CREATE INDEX IF NOT EXISTS queue_seq ON queue (seq)");
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const savedEpoch = db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: string } | null;
  const epoch = savedEpoch?.value ?? crypto.randomUUID();
  if (!savedEpoch) db.prepare("INSERT INTO meta (key, value) VALUES ('epoch', ?)").run(epoch);

  const write = db.prepare(
    `INSERT INTO items (id, text, ts, at, removed, origin, edited_at, seq)
     VALUES ($id, $text, $ts, $at, $removed, $origin, NULL, (SELECT COALESCE(MAX(seq), 0) + 1 FROM items))
     ON CONFLICT(id) DO UPDATE SET text = $text, ts = $ts, at = $at, removed = $removed,
       origin = COALESCE(items.origin, $origin),
       edited_at = COALESCE($editedAt, items.edited_at),
       seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM items)
     RETURNING id, text, ts, at, removed, seq, origin, edited_at`,
  );
  const find = db.prepare("SELECT id, text, ts, at, removed, seq, origin, edited_at FROM items WHERE id = $id");
  const record = db.prepare(
    "INSERT INTO events (ts, at, op, id, text, detail) VALUES ($ts, $at, $op, $id, $text, $detail)",
  );
  const events = db.prepare("SELECT n, ts, at, op, id, text, detail FROM events ORDER BY n ASC");
  const later = db.prepare("SELECT id, text, ts, at, removed, seq, origin, edited_at FROM items WHERE seq > $seq ORDER BY seq ASC");
  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM items");
  const tally = db.prepare(
    "SELECT COALESCE(SUM(removed = 0), 0) AS live, COALESCE(SUM(removed = 1), 0) AS removed FROM items",
  );

  // The server compares what a device sends with what it holds and logs the difference, so a resend of the
  // same state adds nothing. A device only sends an item's latest state, so several offline changes between
  // two syncs show up as the net change. Event times from a device are clamped to the server's clock: a phone
  // whose clock runs ahead must not get stuck in a sync error or put events in the future.
  const upsertTx = db.transaction((id: string, inText: string, inTs: number, removed: boolean, at: number | undefined, origin: string | null, edit: boolean) => {
    const now = clock();
    const clamp = (t: number) => Math.max(0, Math.min(t, now)); // never in the future, never before 1970
    const before = find.get({ $id: id }) as Row | null;
    // Only a write marked as an edit may change an existing row's text or ts (see ItemInput.edit).
    const isEdit = edit && before !== null;
    if (isEdit) {
      // A phone's clock may run a little ahead, so a few minutes past the server's clock is clamped, not refused.
      if (inTs > now + SKEW_MS || (at !== undefined && at > now + SKEW_MS)) throw new ValidationError("a time cannot be in the future");
    }
    const text = before && !isEdit ? before.text : inText;
    const ts = before && !isEdit ? before.ts : isEdit ? clamp(inTs) : inTs;
    // A later write can describe an older state (a retry whose response was lost, a device that was offline).
    // Whichever arrives last still wins, as before, but its event is never dated earlier than the item's last one,
    // so the history of one item always reads forwards.
    const floor = before ? Math.min(before.at ?? before.ts, now) : 0;
    const after = (t: number) => Math.max(clamp(t), floor);
    const changes: [LogEvent["op"], number][] = [];
    let itemAt: number;
    if (!before) {
      // A new row is logged as pushed at its own ts, whatever has happened to it since on the device.
      changes.push(["push", clamp(ts)]);
      itemAt = clamp(at ?? (removed ? now : ts));
      if (removed) changes.push(["pop", itemAt]);
    } else if (before.removed === 0 && removed) {
      itemAt = after(at ?? now);
      changes.push(["pop", itemAt]);
    } else if (before.removed === 1 && !removed) {
      itemAt = after(at ?? now);
      changes.push(["restore", itemAt]);
    } else if (isEdit && removed && at !== undefined) {
      itemAt = clamp(at); // a deliberate correction of the end time: the floor above is for retried events, not for this
    } else {
      itemAt = before.at ?? before.ts;
    }
    if (isEdit && removed && itemAt < ts) throw new ValidationError("the end cannot be before the start");
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    if (isEdit) {
      if (before!.text !== text) diff.text = { from: before!.text, to: text };
      if (before!.ts !== ts) diff.ts = { from: before!.ts, to: ts };
      if (before!.removed === 1 && removed && (before!.at ?? before!.ts) !== itemAt) diff.at = { from: before!.at ?? before!.ts, to: itemAt };
    }
    const edited = Object.keys(diff).length > 0;
    const saved = toItem(write.get({ $id: id, $text: text, $ts: ts, $at: itemAt, $removed: removed ? 1 : 0, $origin: origin, $editedAt: edited ? now : null }) as Row);
    for (const [op, when] of changes) record.run({ $ts: now, $at: when, $op: op, $id: id, $text: text, $detail: null });
    if (edited) record.run({ $ts: now, $at: now, $op: "edit", $id: id, $text: text, $detail: JSON.stringify(diff) });
    return saved;
  });

  const QCOLS = "id, text, ts, at, removed, started, seq";
  const writeQueue = db.prepare(
    `INSERT INTO queue (id, text, ts, at, removed, started, seq)
     VALUES ($id, $text, $ts, $at, $removed, $started, (SELECT COALESCE(MAX(seq), 0) + 1 FROM queue))
     ON CONFLICT(id) DO UPDATE SET text = $text, ts = $ts, at = $at, removed = $removed, started = $started,
       seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM queue)
     RETURNING ${QCOLS}`,
  );
  const findQueue = db.prepare(`SELECT ${QCOLS} FROM queue WHERE id = $id`);
  const laterQueue = db.prepare(`SELECT ${QCOLS} FROM queue WHERE seq > $seq ORDER BY seq ASC`);
  const maxQueueSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM queue");
  const queueTally = db.prepare(
    "SELECT COALESCE(SUM(removed = 0), 0) AS queued, COALESCE(SUM(removed = 1), 0) AS removed FROM queue",
  );

  // Same approach as the stack: events are the difference between the stored row and what arrived, written in the
  // same transaction. A queue row leaves by being dropped (`dequeue`) or started (`start`); the stack row it
  // becomes has the id `s-` plus the rest of its id and logs its own `push`, so the two events can be joined.
  const upsertQueueTx = db.transaction((id: string, text: string, ts: number, removed: boolean, started: boolean, at: number | undefined) => {
    const now = clock();
    const clamp = (t: number) => Math.max(0, Math.min(t, now));
    const before = findQueue.get({ $id: id }) as QueueRow | null;
    const floor = before ? Math.min(before.at, now) : 0;
    const after = (t: number) => Math.max(clamp(t), floor);
    const leave: LogEvent["op"] = started ? "start" : "dequeue";
    const changes: [LogEvent["op"], number][] = [];
    let itemAt: number;
    if (!before) {
      changes.push(["queue", clamp(ts)]);
      itemAt = clamp(at ?? (removed ? now : ts));
      if (removed) changes.push([leave, itemAt]);
    } else if (before.removed === 0 && removed) {
      itemAt = after(at ?? now);
      changes.push([leave, itemAt]);
    } else if (before.removed === 1 && !removed) {
      itemAt = after(at ?? now);
      changes.push(["requeue", itemAt]);
    } else {
      itemAt = before.at;
    }
    const keepStarted = removed && started;
    const saved = toQueueItem(
      writeQueue.get({ $id: id, $text: text, $ts: ts, $at: itemAt, $removed: removed ? 1 : 0, $started: keepStarted ? 1 : 0 }) as QueueRow,
    );
    for (const [op, when] of changes) record.run({ $ts: now, $at: when, $op: op, $id: id, $text: text, $detail: null });
    return saved;
  });

  return {
    epoch,
    upsertQueue(id, input) {
      if (typeof id !== "string" || !QUEUE_ID_RE.test(id)) throw new ValidationError("invalid id");
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) throw new ValidationError("text is required");
      if (text.length > MAX_TEXT) throw new ValidationError(`text is over ${MAX_TEXT} characters`);
      if (!Number.isSafeInteger(input.ts)) throw new ValidationError("ts must be an integer");
      const at = input.at ?? undefined;
      if (at !== undefined && !Number.isSafeInteger(at)) throw new ValidationError("at must be an integer");
      if (input.started !== undefined && typeof input.started !== "boolean") throw new ValidationError("started must be a boolean");
      return upsertQueueTx.immediate(id, text, input.ts, input.removed === true, input.started === true, at);
    },
    queueSince(seq) {
      const items = (laterQueue.all({ $seq: seq }) as QueueRow[]).map(toQueueItem);
      return { seq: (maxQueueSeq.get() as { seq: number }).seq, items };
    },
    queueCounts() {
      return queueTally.get() as { queued: number; removed: number };
    },
    upsert(id, input) {
      if (typeof id !== "string" || !ID_RE.test(id)) throw new ValidationError("invalid id");
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) throw new ValidationError("text is required");
      if (text.length > MAX_TEXT) throw new ValidationError(`text is over ${MAX_TEXT} characters`);
      if (!Number.isSafeInteger(input.ts)) throw new ValidationError("ts must be an integer");
      const at = input.at ?? undefined;
      if (at !== undefined && !Number.isSafeInteger(at)) throw new ValidationError("at must be an integer");
      const origin = input.origin ?? null;
      if (origin !== null && (typeof origin !== "string" || !ID_RE.test(origin) || origin === id)) throw new ValidationError("origin must be the id of another item");
      return upsertTx.immediate(id, text, input.ts, input.removed === true, at, origin, input.edit === true);
    },
    since(seq) {
      const items = (later.all({ $seq: seq }) as Row[]).map(toItem);
      return { seq: (maxSeq.get() as { seq: number }).seq, items };
    },
    counts() {
      return tally.get() as { live: number; removed: number };
    },
    log() {
      // `detail` exists only on edit events; leaving it off the rest keeps them looking as they always did.
      return (events.all() as (LogEvent & { detail: string | null })[]).map((e) => {
        if (e.detail === null) delete (e as { detail?: unknown }).detail;
        return e as LogEvent;
      });
    },
    close() {
      db.close();
    },
  };
}
