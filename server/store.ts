import { Database } from "bun:sqlite";

export type Item = { id: string; text: string; ts: number; removed: boolean; seq: number };
export type ItemInput = { text: string; ts: number; removed: boolean };

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export const MAX_TEXT = 200;
const ID_RE = /^s-[a-z0-9]{4,40}$/;

export interface Store {
  upsert(id: string, input: ItemInput): Item;
  since(seq: number): { seq: number; items: Item[] };
  counts(): { live: number; removed: number };
  close(): void;
}

type Row = { id: string; text: string; ts: number; removed: number; seq: number };
const toItem = (r: Row): Item => ({ id: r.id, text: r.text, ts: r.ts, removed: r.removed === 1, seq: r.seq });

export function openStore(path: string): Store {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(
    "CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, text TEXT NOT NULL, ts INTEGER NOT NULL, removed INTEGER NOT NULL, seq INTEGER NOT NULL)",
  );
  db.run("CREATE INDEX IF NOT EXISTS items_seq ON items (seq)");

  const write = db.prepare(
    `INSERT INTO items (id, text, ts, removed, seq)
     VALUES ($id, $text, $ts, $removed, (SELECT COALESCE(MAX(seq), 0) + 1 FROM items))
     ON CONFLICT(id) DO UPDATE SET text = $text, ts = $ts, removed = $removed,
       seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM items)
     RETURNING id, text, ts, removed, seq`,
  );
  const later = db.prepare("SELECT id, text, ts, removed, seq FROM items WHERE seq > $seq ORDER BY seq ASC");
  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM items");
  const tally = db.prepare(
    "SELECT COALESCE(SUM(removed = 0), 0) AS live, COALESCE(SUM(removed = 1), 0) AS removed FROM items",
  );

  const upsertTx = db.transaction((id: string, text: string, ts: number, removed: boolean) =>
    toItem(write.get({ $id: id, $text: text, $ts: ts, $removed: removed ? 1 : 0 }) as Row),
  );

  return {
    upsert(id, input) {
      if (typeof id !== "string" || !ID_RE.test(id)) throw new ValidationError("invalid id");
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) throw new ValidationError("text is required");
      if (text.length > MAX_TEXT) throw new ValidationError(`text is over ${MAX_TEXT} characters`);
      if (!Number.isSafeInteger(input.ts)) throw new ValidationError("ts must be an integer");
      return upsertTx.immediate(id, text, input.ts, input.removed === true);
    },
    since(seq) {
      const items = (later.all({ $seq: seq }) as Row[]).map(toItem);
      return { seq: (maxSeq.get() as { seq: number }).seq, items };
    },
    counts() {
      return tally.get() as { live: number; removed: number };
    },
    close() {
      db.close();
    },
  };
}
