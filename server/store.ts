import { Database } from "bun:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { reduce } from "../web/reduce.js";
import { CREATE_ACTIONS, convertLegacy, makeRecorder, toAction, type Action } from "./actions";

export type { Action };

/** What a device sends for one action. `ts` is never sent: the server stamps it. */
export type ActionInput = { id: string; at: number; kind: string; target: string; ref?: string | null; data?: unknown };
/** The answer to an actions sync: every action above the cursor (the device's own, now stamped, included) and the ones refused. */
export type ActionsSyncResult = { cursor: number; actions: Action[]; more: boolean; rejected: Record<string, { error: string }>; changed: boolean };

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export const MAX_TEXT = 200;
const SKEW_MS = 5 * 60_000; // how far past the server clock an edited time may be before it is refused

export interface Store {
  /** Identifies this database. A client that sees it change knows the server's data was replaced. */
  readonly epoch: string;
  /**
   * The one sync call: stores each action a device sends (stamping `ts`, clamping `at` to it, ignoring an id it already
   * has) and returns every action above `cursor`.
   */
  syncActions(cursor: number, input: unknown[]): ActionsSyncResult;
  /** The highest `n` in the actions log: the cursor of the actions wire. */
  actionsCursor(): number;
  /** The append-only log of actions (the source of truth), oldest first. */
  actions(): Action[];
  /** The state the reducer (web/reduce.js) derives from the whole log: items with their intervals, notes, the Later queue. */
  state(): ReturnType<typeof reduce>;
  /** Items on the stack and items that have ended (deleted ones are not counted), for the metrics. */
  counts(): { live: number; removed: number };
  queueCounts(): { queued: number; removed: number };
  close(): void;
}

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
  // Databases created before deleting have no `deleted` (1 = hidden everywhere; see ItemInput.deleted).
  if (!columns.some((c) => c.name === "deleted")) db.run("ALTER TABLE items ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
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
  db.run("CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, removed INTEGER NOT NULL, seq INTEGER NOT NULL, edited_at INTEGER)");
  db.run("CREATE INDEX IF NOT EXISTS notes_seq ON notes (seq)");
  db.run("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const savedEpoch = db.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: string } | null;
  const epoch = savedEpoch?.value ?? crypto.randomUUID();
  if (!savedEpoch) db.prepare("INSERT INTO meta (key, value) VALUES ('epoch', ?)").run(epoch);

  // Numbered migrations, recorded in PRAGMA user_version. Everything above is the original guarded schema; each step
  // below runs once, in one transaction, and is only ever added to the end of the list.
  const MIGRATIONS: ((d: Database) => void)[] = [
    // 1: the actions log, with the existing rows and events converted into it
    (d) => {
      for (const q of CREATE_ACTIONS) d.run(q);
      convertLegacy(d);
    },
  ];
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version < MIGRATIONS.length) {
    // A real database is copied once before its first conversion, so there is always a way back.
    const hasData = (db.prepare("SELECT COUNT(*) AS c FROM items").get() as { c: number }).c > 0;
    if (version === 0 && path !== ":memory:" && hasData && !existsSync(`${path}.pre-actions`)) {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      copyFileSync(path, `${path}.pre-actions`);
    }
    for (let v = version; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        MIGRATIONS[v](db);
        db.run(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }
  const rec = makeRecorder(db);

  // ---- the actions wire ----
  const KINDS = new Set(["push", "push-again", "pop", "drop", "edit", "void", "delete", "undelete", "note", "later", "dequeue", "requeue", "start"]);
  const ACTION_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
  const TARGET_RE = /^[sqn]-[a-z0-9]{4,40}$/;
  const PAGE = 5000; // at most this many actions in one answer; `more` says there are further ones
  const actionsAbove = db.prepare("SELECT n, id, ts, at, kind, target, ref, data, origin FROM actions WHERE n > $n ORDER BY n ASC LIMIT $limit");
  const maxN = db.prepare("SELECT COALESCE(MAX(n), 0) AS n FROM actions");
  const hasAction = db.prepare("SELECT 1 AS x FROM actions WHERE id = $id");

  function checkAction(a: unknown, now: number): ActionInput {
    if (a === null || typeof a !== "object" || Array.isArray(a)) throw new ValidationError("an action must be an object");
    const x = a as Record<string, unknown>;
    if (typeof x.id !== "string" || !ACTION_ID_RE.test(x.id)) throw new ValidationError("invalid action id");
    if (typeof x.kind !== "string" || !KINDS.has(x.kind)) throw new ValidationError("unknown kind");
    if (typeof x.target !== "string" || !TARGET_RE.test(x.target)) throw new ValidationError("invalid target");
    if (!Number.isSafeInteger(x.at)) throw new ValidationError("at must be an integer");
    if (x.ref !== undefined && x.ref !== null && (typeof x.ref !== "string" || !ACTION_ID_RE.test(x.ref))) throw new ValidationError("invalid ref");
    const data = x.data === undefined || x.data === null ? null : x.data;
    if (data !== null && (typeof data !== "object" || Array.isArray(data))) throw new ValidationError("data must be an object");
    const d = (data ?? {}) as Record<string, unknown>;
    const needsText = x.kind === "push" || x.kind === "later" || x.kind === "note";
    if (needsText || (x.kind === "edit" && "text" in d)) {
      const t = typeof d.text === "string" ? d.text.trim() : "";
      if (!t) throw new ValidationError("text is required");
      if (t.length > MAX_TEXT) throw new ValidationError(`text is over ${MAX_TEXT} characters`);
      d.text = t;
    }
    if (x.kind === "edit" && "at" in d && (!Number.isSafeInteger(d.at) || (d.at as number) < 0)) throw new ValidationError("that time is not valid");
    if (x.kind === "edit" && typeof d.at === "number" && d.at > now + SKEW_MS) throw new ValidationError("a time cannot be in the future");
    if (x.kind === "edit" && !("text" in d) && !("at" in d)) throw new ValidationError("an edit must change the text or a time");
    if (x.kind === "edit" && "at" in d && x.ref == null) throw new ValidationError("a time edit must point at an action");
    if (typeof d.at === "number") d.at = Math.min(d.at, now);
    if (x.target.startsWith("s-") && x.kind === "later") throw new ValidationError("wrong kind for this target");
    return { id: x.id, at: x.at as number, kind: x.kind, target: x.target, ref: (x.ref as string | null | undefined) ?? null, data: data === null ? null : d };
  }

  const syncActionsTx = db.transaction((since: number, input: unknown[]): ActionsSyncResult => {
    const now = clock();
    const rejected: Record<string, { error: string }> = {};
    let changed = false;
    for (const raw of input) {
      const rawId = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : "?";
      try {
        const a = checkAction(raw, now);
        if (hasAction.get({ $id: a.id })) continue; // a resend: already stored
        rec.put(a.id, a.kind, a.target, now, a.at, a.data, a.ref ?? null);
        changed = true;
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        rejected[rawId] = { error: e.message };
      }
    }
    const rows = actionsAbove.all({ $n: since, $limit: PAGE + 1 }) as Parameters<typeof toAction>[0][];
    const more = rows.length > PAGE;
    const actions = rows.slice(0, PAGE).map(toAction);
    const top = more ? actions[actions.length - 1].n : (maxN.get() as { n: number }).n;
    return { cursor: Math.max(top, since > top ? 0 : top), actions, more, rejected, changed };
  });

  const allActions = () => (db.prepare("SELECT n, id, ts, at, kind, target, ref, data, origin FROM actions ORDER BY n ASC").all() as Parameters<typeof toAction>[0][]).map(toAction);

  const store: Store = {
    epoch,
    syncActions(since, input) {
      if (!Array.isArray(input)) throw new ValidationError("actions must be a list");
      return syncActionsTx.immediate(Number.isSafeInteger(since) && since > 0 ? since : 0, input);
    },
    actionsCursor: () => (maxN.get() as { n: number }).n,
    actions: allActions,
    state: () => reduce(allActions()),
    counts() {
      const items = Object.values((store.state() as any).items) as { live: boolean; deleted: boolean }[];
      return { live: items.filter((i) => i.live && !i.deleted).length, removed: items.filter((i) => !i.live && !i.deleted).length };
    },
    queueCounts() {
      const rows = Object.values((store.state() as any).queue) as { removed: boolean }[];
      return { queued: rows.filter((r) => !r.removed).length, removed: rows.filter((r) => r.removed).length };
    },
    close() {
      db.close();
    },
  };
  return store;
}
