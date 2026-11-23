// The Debug panel's "Copy data": one JSON document with the app's own local data, for debugging. Pure, so it runs under
// `bun test`. Nothing comes from outside the app's databases; rows are exactly as stored (timestamps in milliseconds).

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** An ISO-style local time with its UTC offset, e.g. "2026-11-23T14:04:05.678+11:00". `offsetMinutes` is Date#getTimezoneOffset (minutes behind UTC). */
export function localIso(ms, offsetMinutes) {
  const d = new Date(ms - offsetMinutes * 60000);
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Reads one storage (the shape sync.js and idb.js use) into `{ items, meta }`, or `{ error }` when it cannot be read. */
export async function readStorage(storage) {
  if (typeof storage?.load !== "function") return { error: "no storage" };
  try {
    const { items, dirty, cursor, epoch } = await storage.load();
    return { items, meta: { dirty, cursor, epoch } };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/**
 * `db` is `{ stack, queue, notes }`, each from `readStorage`. `version` is the version label the app shows, `mode` is
 * "server" or "static", and `lastFailure` (optional) is the raw detail of the latest failed sync call.
 */
export function buildDebugData({ now, offsetMinutes = new Date(now).getTimezoneOffset(), version, mode, db, lastFailure }) {
  return {
    generated: localIso(now, offsetMinutes),
    version,
    mode,
    db: { stack: db.stack, queue: db.queue, notes: db.notes },
    ...(lastFailure ? { lastFailure } : {}),
  };
}
