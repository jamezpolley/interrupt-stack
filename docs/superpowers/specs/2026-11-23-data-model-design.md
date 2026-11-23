# Data model: actions, times and history

Status: proposal for the owner. Design only; nothing here is built. Decisions needed are numbered in section 8.

## Summary

Keep one current-state row per stack item, but give each of its two stages (push and end) **two** times:
`*_ts` (server clock when the server first stored that stage; written once, never changed) and `*_at` (when the person
says it happened; device clock at first, changed only by an edit). Every write to any synced row also appends a full
snapshot of the row to one append-only `history` table in the same transaction. Current state is one indexed query;
"what was on the stack at 10:40 last Tuesday" is one indexed query; "what did the database say at 10:40" is a history
lookup. The sync protocol stays row-based, so the offline outbox, last-write-wins and old clients all keep working.

---

## 1. Structural weaknesses of the current model

| # | Weakness | Where |
|---|----------|-------|
| W1 | **The end time shares a field with "last change".** `items.at` is "device time of the last state change". A pop writes it, an undo (restore) overwrites it, so a pop time has no field of its own and a pop that was undone leaves no trace in `items`. | `store.ts` upsertTx, `at` branches (lines 174-189); `sync.js` `remove`/`restore` |
| W2 | **The push time can be rewritten** by any write marked `edit: true`, with no record in the row of what it was. The server checks end >= start only when the item is removed; an edit of a live item can move `ts` anywhere up to now + 5 min. | `store.ts` line 166 and the check on line 190 (only `isEdit && removed`) |
| W3 | **No immutable server-received time per action.** The server's receipt time exists only in `events.ts`, which nothing reads; the row itself has none. Once `ts` or `at` is edited, the row cannot tell you when the server first saw the push or the pop. | `events` table; `items` has no such column |
| W4 | **`at < ts` is representable and gets stored.** A new row keeps its device `ts` unclamped while its `at` is clamped to the server clock, so a device whose clock runs a second or two fast stores a live item that "ended" before it began. Cross-device skew does the same for a pop: a push from a fast phone popped a second later from a correct laptop. A push-then-pop within a second or two (a real case) is exactly where this shows. The derivation then returns null. | `store.ts` lines 166 (`: inTs`, unclamped) vs 177 (`clamp(...)`); same in the queue (line 250); `times.js` `derive` (`x.at < x.ts` gives null) |
| W5 | **A pop and a later restore make "on top" wrong.** Time on top is derived from `[ts, at]`; after pop, restore, pop, `at` is the last pop, so the gap when the item was not on the stack counts as on top. | `times.js` `derive` |
| W6 | **History is a side table with its own vocabulary.** `events` holds diffs (`push`, `pop`, `edit` with JSON `detail`), so to know an item's state at some moment you must replay events and apply edit diffs over them. It is also lossy: offline changes collapse to the net change between two syncs, and edit/delete events are dated by the server, not the person. | `store.ts` lines 151-154, 199-204 |
| W7 | **Stack order uses the device's push time**, so a fast clock can put a push above one made a moment later on another device. Minor, but it follows from W4. | `sync.js` `currentStack` |

### How "Shave" got a pop 1.3 s before its push

Stored: `s-mwmz44ywsvot`, `ts` 1795394445891 (10:40:45.891), `at` 1795394444614 (10:40:44.614). It was added to Later
on Thursday (the `q-` id, and so the derived `s-` id, embeds that time: `stackIdFor` in `web/queue.js`), started this
morning and popped within a few seconds.

Start is not special here. `promote` calls `stack.push(text, { id: "s-" + rest })`, which makes an ordinary new item
with `ts = at = device now` (`sync.js` `newItem`), then tombstones the queue row. The pop is `sync.remove`, which sets
`at = device now`. On the device, `at > ts`. The inversion happens on the server, from W4, and needs only one thing:
**the device's clock running ahead of the server's by more than the time between the push and the pop reaching the
server.** Either path gives the same result:

- *Push and pop arrive together* (the pop happened while the push was still pending, so the outbox sent one row,
  already removed). New row: `ts` is stored as sent (device time, a little in the server's future), `at = clamp(pop)`
  = server now. Server now < device push time, so `at < ts`.
- *Push arrives first, pop a moment later.* The push stores `ts` unclamped and `at = clamp(ts)` = server now. The pop
  computes `max(clamp(pop), floor)`; with the device ahead, `clamp(pop)` is the server's now again. If that is still
  earlier than the device's push time, `at < ts`.

So `ts - at` (1.28 s) is at least how far that device's clock was ahead, minus how long it took the pop to arrive. A
second live item with `at < ts` by 2 s fits the same cause: for a live item `at` is just the clamped arrival time.
Every quick push-then-pop from a device that runs a second or two fast will do this; longer tasks hide it because
the pop arrives after the server's clock has passed the device's push time.

To confirm on the server, without changing anything:

```sql
SELECT n, ts, at, op, id FROM events WHERE id IN ('s-mwmz44ywsvot', 'q-mwmz44ywsvot') ORDER BY n;
```

Expected if this is the cause: the `push` event's `at` equals its own `ts` (it was clamped to server now) and is
earlier than `items.ts`; no `edit` event. If push and pop arrived together, both events share one `ts`.

The proposed model fixes it twice over: every stored reported time is clamped on arrival, including a new row's push
(rule 1, section 3), and an end is never stored before its push (rule 2). The same push-then-pop is stored as a
push at the server's arrival time and a zero- or near-zero-length on-top time, with the device's raw values kept in
`history.sent`.

The other weaknesses need no forensic story: they all come from two times doing four jobs.

---

## 2. Candidate models

Words used below:

- **Reported time** (`_at`): when the person says something happened. Starts as the device clock, clamped so it is
  never later than the server's clock when it arrives. Edits change it.
- **Received time** (`_ts`): the server clock when the server first stored that stage. Set once. Never edited, never
  overwritten by a resend.
- **World time** question: "what was on my stack at 10:40 on Tuesday?" (uses reported times, after edits).
- **Record time** question: "what did the database say at 10:40 on Tuesday?" (uses received times; for debugging).

Every option keeps the existing shared `seq` counter on the current-state rows for sync, unchanged.

### (a) Per-action rows plus a materialised current state

```sql
CREATE TABLE actions (
  id        TEXT PRIMARY KEY,          -- client-made, e.g. "<item>:push", "<item>:end:<k>"; makes resends idempotent
  item_id   TEXT NOT NULL,
  kind      TEXT NOT NULL,             -- push | end | unend | delete | undelete
  ts        INTEGER NOT NULL,          -- received, immutable
  at        INTEGER NOT NULL,          -- reported, editable
  at_first  INTEGER NOT NULL,          -- reported as first received, immutable
  voided    INTEGER NOT NULL DEFAULT 0 -- an undo voids the action instead of adding a counter-action (or not; a choice)
);
CREATE INDEX actions_item ON actions(item_id, ts);
CREATE INDEX actions_at   ON actions(at);
CREATE TABLE action_edits (n INTEGER PRIMARY KEY, action_id TEXT, ts INTEGER, from_at INTEGER, to_at INTEGER);
-- items: current state, recomputed from the item's actions in the same transaction
```

| Operation | Written |
|-----------|---------|
| push | insert `push` action; insert item row |
| pop / drop | insert `end` action; set item ended |
| undo pop | void the `end` action (or insert `unend`); clear item end |
| edit | update `actions.at`, insert `action_edits` row; recompute item |
| delete / undelete | insert action; set flag |

- State at world time T: per item, the latest non-voided action with `at <= T`. Done today: `end` actions with `at`
  in the day.
- Sync: either the client sends **actions** (a new outbox and protocol; idempotent by action id; the most faithful
  record), or it keeps sending rows and the server diffs them into actions (today's approach, and it keeps W6's
  collapse problem).
- For: richest record; any number of pop/restore cycles. Against: two sources of truth (actions and items) that must
  agree; edits still need a second mechanism (`action_edits`), because the owner wants editable times on immutable
  facts; the honest version needs a client protocol rewrite.

### (b) Stage columns on the item plus an append-only history (recommended)

```sql
-- items: existing table, new columns added (see migration)
push_at   INTEGER NOT NULL,   -- reported push time
push_ts   INTEGER,            -- received push time; NULL only for rows older than the event log (unknown)
end_at    INTEGER,            -- reported end (pop or drop) time; NULL while on the stack
end_ts    INTEGER,            -- received end time; NULL while on the stack
CREATE INDEX items_push_at ON items(push_at);
CREATE INDEX items_end_at  ON items(end_at);

CREATE TABLE history (
  n       INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl     TEXT NOT NULL,      -- items | queue | notes
  row_id  TEXT NOT NULL,
  ts      INTEGER NOT NULL,   -- server clock of this write
  op      TEXT NOT NULL,      -- push | end | unend | edit | delete | undelete | migrate | (queue/note ops)
  row     TEXT NOT NULL,      -- the whole row after the write, as JSON
  sent    TEXT                -- what the client sent, as JSON, when it differs (e.g. a raw time that was clamped)
);
CREATE INDEX history_row ON history(tbl, row_id, n);
CREATE INDEX history_ts  ON history(ts);
```

An item has exactly one push and at most one live end. That is why the stages fit as columns: the "actions" of option
(a) are folded into the row, and the history table keeps every version.

| Operation (client wire) | Item row | History |
|-------------------------|----------|---------|
| push (new id) | `push_at = clamp(sent)`, `push_ts = now` | `push` |
| push arriving already ended (pushed and popped offline) | as push, plus `end_at = max(clamp(sent end), push_at)`, `end_ts = now` | `push`, then `end` |
| pop or drop (live to ended) | `end_at = max(clamp(sent ?? now), push_at)`, `end_ts = now` | `end` (with `sent` if raised) |
| undo pop (ended to live) | `end_at = end_ts = NULL` | `unend` (old end stays in history) |
| edit | `push_at` and/or `end_at` and/or `text` replaced; `*_ts` untouched; `edited_at = now` | `edit` |
| delete / undelete | `deleted` flag | `delete` / `undelete` |
| resend of the same state | nothing changes | nothing |
| stale non-edit write (old copy) | stored text, `push_at`, `end_at` kept, as today | nothing |
| Start from Later (`q-x` to `s-x`) | a push of `s-x` like any other (first arrival sets `push_ts`; a second device starting the same row is a resend of an existing id, so nothing changes); the queue row's tombstone is its own write | `push` for `s-x`; queue's own `start` row |

- **State at world time T** (one query, both indexes):
  `SELECT * FROM items WHERE deleted = 0 AND push_at <= :T AND (end_at IS NULL OR end_at > :T) ORDER BY push_at DESC`.
- **Done list for a day** `[from, to)`: `WHERE deleted = 0 AND end_at >= :from AND end_at < :to`. Time on top also
  needs the items that overlapped those: `WHERE deleted = 0 AND push_at < :to AND (end_at IS NULL OR end_at > :earliestPush)`.
- **State at record time T** (what the database said): for each row, the history entry with the greatest `n` where
  `ts <= :T`: `SELECT row FROM history h WHERE tbl='items' AND n = (SELECT MAX(n) FROM history WHERE tbl='items' AND row_id=h.row_id AND ts <= :T)`.
  Rare and debugging-only, so speed does not matter.
- **Sync**: unchanged shape (rows by `seq`); the row gains four fields. See section 4.
- For: current state is a plain row; the questions the app asks are single indexed queries; the client keeps
  thinking in rows; history is complete versions (no diff replay) and generic across tables.
- Against: an undo erases the pop from the current row (the history keeps it); several pop/restore cycles are not
  modelled as separate intervals (see decision 1). Offline changes still collapse to the net change between two syncs,
  which is fine here because the row only ever holds one interval.

### (c) Full event sourcing with projections

The client sends events (`push`, `pop`, `edit`, ...); the server appends them to an immutable log (the dex-stack shape,
in SQLite); current state, Done lists and timelines are projections, either rebuilt on read or kept as tables.

- For: the history is the source of truth; any past state can be recomputed with any future rule.
- Against: needs the client protocol rewrite of (a); edits become "correction" events every reader must apply;
  ordering by arrival vs by reported time must be defined for every projection; a kept projection table is option (a)
  again, and an unkept one means replaying everything on each read. dex-stack used this shape because a JSONL file
  forces append-only; SQLite does not, and transactions give the same "log and state cannot disagree" guarantee.

### Recommendation: (b)

The domain is intervals: something is on the stack from its push to its end. (b) stores exactly that, with the
received/reported split the owner asked for on each stage, and puts the history in one generic table that answers
"what did it look like then" without replaying diffs. It changes the least on the client (the outbox, conflict rules
and row-based sync stay), and it can grow into (a) later if multiple intervals per item ever matter: the history
table already holds every transition with its received time.

### What happens to `events` and `seq`

- `events`: frozen at the migration (no new writes), kept read-only as the record of what happened before. It is the
  source for back-filling `push_ts`/`end_ts` (section 4). It can be dropped in a much later cleanup, or never.
- `seq`: unchanged. Still the shared counter on `items`, `queue`, `notes`, still what `/api/sync`, the old endpoints
  and the SSE `sync` event use. `history.n` is a separate counter and is never used for sync.

---

## 3. Time semantics

| Column | Meaning | Set by | Can change? |
|--------|---------|--------|-------------|
| `push_ts` | Server clock when the server first stored this item | server, on insert | Never. NULL only for rows that predate the event log |
| `push_at` | When the person says they started it | device clock on push, clamped; an edit | Only by an edit |
| `end_ts` | Server clock when the server first stored the end it currently has | server, on live to ended | Cleared by an undo; a new end gets a new value. Never edited |
| `end_at` | When the person says it ended (pop or drop) | device clock on pop, clamped and raised; an edit | By an edit; cleared by an undo |
| `edited_at` | Server clock of the last edit that changed something | server | Each edit |
| `history.ts` | Server clock of that write | server | Never (append-only) |

Rules (all in the store's write transaction):

1. **Never in the future.** Every reported time is clamped to `min(sent, now)` when stored. This includes new rows
   (fixes W4's unclamped `ts`). Edits more than 5 minutes ahead are refused, as now (a person typed a wrong date);
   within 5 minutes they are clamped.
2. **End is never before push.** For a non-edit write (a device reporting what it did), `end_at = max(clamp(sent), push_at)`.
   A push-then-pop within a second, with the pop's clock a little behind the push's, stores a zero-length item instead
   of an impossible one. The raw sent value goes into `history.sent`, so nothing is lost. Not refused: refusing a
   device's own action would wedge its outbox.
3. **Edits that invert the order are refused** (per-row `rejected`, as today; the client's `validateDraft` already
   blocks them before saving). An edit of the push time of an item whose end is earlier is refused the same way.
4. **What an edit writes:** only reported fields (`text`, `push_at`, `end_at`) and `edited_at`, plus a history row
   with the whole new version. `push_ts`, `end_ts`, `origin`, `id` are never touched by an edit.
5. **Immutable:** `id`, `origin`, `push_ts`, an `end_ts` while that end stands, every history row, the frozen `events`.
6. **Invariant enforced:** `end_at IS NULL OR end_at >= push_at`, and `end_ts IS NULL` exactly when `end_at IS NULL`.
   Enforced in code, checked by tests, and checked at startup (count violating rows, log them). A `CHECK` constraint
   would need a table rebuild, which would break the automatic fallback to older code (section 7), so it waits for the
   final cleanup step.
7. **Ordering of the stack** uses `push_at` (the person's time), with `push_ts` then `id` as tie-breakers. Rule 1
   bounds the damage of a fast clock to "never later than the server's now".

Notes fit the same way with one stage: `note_at` (today's `ts`: when it was noted, editable) and a new `note_ts`
(received, immutable). A note appears in a day by `note_at`. Its writes also go to `history`.

The Later queue is out of scope: its table and wire stay as they are. Its writes also append to `history` (cheap,
generic; decision 6), and its new-row `ts` gets the same clamp as items in step 1.

---

## 4. Migration and shipping

### What each existing row becomes

| Existing | New |
|----------|-----|
| `items.ts` | `push_at` |
| `items.at` when `removed = 1` | `end_at` (raised to `push_at` if lower: these are the at < ts rows; the original goes in the `migrate` history row) |
| `items.at` when `removed = 0` | dropped from the new model (it was "last change" only) |
| `items.at` NULL, removed (rows older than the event log) | `end_at = ts`, which is what the client already assumes (`at ?? ts`); zero length, marked by `op = 'migrate'` in history |
| `push_ts` | `events.ts` of the item's first `push` event; NULL if none (items older than 2026-11-18) |
| `end_ts` | `events.ts` of the last `pop` event not followed by a `restore`; NULL if none |
| `edited_at`, `origin`, `deleted`, `text`, `seq` | unchanged |
| every item, queue and note row | one `history` row, `op = 'migrate'`, `ts = migration time`, `row` = the old row as it was |
| `events` | kept, frozen |
| `notes.ts` | `note_at` (same column, see below); `note_ts` from the note's `note` event, else NULL |

Lost: received times for rows older than the event log (they stay NULL, honestly unknown), and the pop times of pops
that were undone before the migration (still in `events`). Nothing else.

### Keeping old code safe

The deployment can fall back automatically to the image's older code against the migrated database (README,
"Baking in a clone"). So the migration is **additive only**: new columns, a new table, no renames, no rebuilds. The
legacy columns `ts`, `at`, `removed` stay and the new code keeps writing them (`ts = push_at`,
`at = end_at ?? push_at`, `removed = end_at IS NOT NULL`). If older code runs for a while and writes rows, the new code
finds them on start (a `v2_seq` column holds the `seq` of the last new-code write; rows where `seq != v2_seq` were
written by older code) and re-derives their new columns from the legacy ones.

Before migrating, the server copies `/data/stack.db` to `/data/stack.db.pre-v2` (once). Migrations become numbered
steps recorded in `meta` (`schema_version`), each in one transaction, replacing the scattered `PRAGMA table_info`
guards for new work.

### Steps (each a PR)

| Step | What | Client change | Old clients |
|------|------|---------------|-------------|
| 1 | Clamp new-row `ts` on items and queue (W4); `meta.schema_version`; a real-shaped fixture database for migration tests; startup invariant check that logs at < ts rows | none | unaffected |
| 2 | Additive migration (columns, `history`, back-fill, `v2_seq`, backup copy); write path keeps the new columns and history; `events` frozen; rules of section 3 on the server; old wire translated at the boundary | none | unaffected; rows they receive gain extra fields they ignore |
| 3 | Wire v2 on `/api/sync`: the client sends `push_at`/`end_at`, keeps rows with both shapes; `times.js`, `today.js`, `edit.js` read the new fields; IndexedDB rows converted on load | yes | still served by the translation |
| 4 | `GET /api/state`, `GET /api/day`, `GET /api/items/:id/history` (section 5) | none | n/a |
| 5 | Client uses `/api/state` for a fresh device and `/api/day` for past days | yes | n/a |
| 6 (later) | Remove old endpoints and the legacy wire once no cached client remains; optionally rebuild `items` with `CHECK` constraints and drop `ts`/`at`/`removed` | none | gone |

Step 3 is optional for correctness: steps 1-2 already fix the model on the server. It is what lets the client show
received times and edit the push time of a live item.

### Unified sync, v2

Request (`POST /api/sync`), unchanged envelope:

```json
{ "epoch": "…", "cursor": 812,
  "changes": {
    "items": { "s-abc123": { "text": "Shave", "push_at": 1795394445891, "end_at": 1795394446900,
                             "deleted": false, "origin": null, "edit": false } },
    "queue": { "q-…": { "text": "…", "ts": 0, "removed": false, "started": false, "at": 0 } },
    "notes": { "n-…": { "text": "…", "note_at": 0, "removed": false } } } }
```

An item change with `push_at` is v2; one with `ts`/`removed` is the old shape and is translated
(`push_at = ts` for a new row; `removed` plus `at` gives `end_at`; `removed: false` on an ended row is an undo).
`end_at: null` on an ended row is an undo. Notes accept `ts` or `note_at` the same way.

Response, unchanged envelope; each item row carries both shapes during the transition, so a device with a mix of old
and new cached files still works:

```json
{ "epoch": "…", "cursor": 815,
  "tables": { "items": { "rows": [ { "id": "s-abc123", "text": "Shave",
      "push_at": 1795394444614, "push_ts": 1795394444614,
      "end_at": 1795394445702, "end_ts": 1795394445702,
      "deleted": false, "seq": 815, "edited_at": null,
      "ts": 1795394444614, "at": 1795394445702, "removed": true } ],
    "saved": { "s-abc123": { … } }, "rejected": {} },
  "queue": { … }, "notes": { … } } }
```

(This is the Shave case under the new rules: the push came from a device about 1.3 s fast, so `push_at` was clamped
to the server's clock at arrival (10:40:44.614). The pop, sent a second later, was clamped to its own arrival
(10:40:45.702), which is after the push, so the order holds without any raising. Raising (rule 2) is only needed when
a different device with a slower clock reports the end (if push and pop arrive in one write from a fast device, both
clamp to the same server now and the item is zero length). Both raw device times are in `history.sent`.)

---

## 5. API sketch

Auth is the proxy's job; none here. All times are ms since epoch. Days are given by the client as `from`/`to` (its own
local midnight to midnight), so the server needs no time zones and "today" means the device's day, as now.

### `GET /api/state?from=<ms>&to=<ms>`

Everything a screen needs, in one call:

```json
{ "epoch": "…", "cursor": 815, "now": 1795001000000,
  "stack": [Item…],          // live, not deleted, newest push first
  "later": [QueueItem…],     // live queue rows
  "done":  [Item…],          // ended in [from, to)
  "notes": [Note…],          // note_at in [from, to), not removed
  "context": [Item…] }       // other items that overlapped those, needed for time on top
```

It does not replace `/api/sync`: an offline-first client still needs its outbox and incremental changes. What it adds:
a new or reset device starts from current state plus `cursor` and then syncs incrementally from there, instead of
downloading every tombstone ever written (`cursor: 0` today returns all history, and grows forever). It is also the
easiest thing to look at when debugging, and it is the same query as `/api/day`. Cheap to build: yes, in step 4.

### `GET /api/day?from=<ms>&to=<ms>`

The same as `/api/state` without `stack`/`later` ("what happened that day"), plus `"pushed": [Item…]` (pushed in the
day, whatever their end). The client computes durations and timelines with `times.js`, as now; a server copy of that
logic is not needed yet.

### `GET /api/days?from=<ms>&to=<ms>&tz_offset=<min>` (later)

A per-day summary for a calendar or week view: `[{ "date": "2026-11-23", "done": 12, "notes": 3 }]`. Needs a day
boundary on the server, hence the offset; leave until a screen wants it.

### `GET /api/items/:id/history`

The item's history rows, oldest first: `[{ "n", "ts", "op", "row", "sent" }]`. For answering "what happened to this
item" without shell access to the database. The owner declined an `events` read endpoint before; this one is narrow
and debug-only (decision 8).

### Now or later

Build `/api/state`, `/api/day` and the item history in step 4, right after the model lands, and not before: built on
today's columns they would bake in W1-W4. They are small (each is one or two of the queries in section 2) and give
the "previous days" screens something to call. Leave `/api/days` until a screen needs it.

---

## 6. ORM / query layer

Recommendation: **don't adopt one.** Keep `bun:sqlite` with prepared statements.

- The hard part of `store.ts` is not query building, it is the write rules inside each transaction (clamping, edit
  protection, stage logic, the shared `NEXT_SEQ` subquery). An ORM does not help with any of it.
- **Drizzle** wants to own the schema and generate migrations (`drizzle-kit`). That fights the guarded, in-place,
  additive migrations this deployment needs, and the `seq` subquery would be raw SQL anyway.
- **Kysely** is the better fit of the two (a typed query builder, no runtime magic), but has no first-party
  `bun:sqlite` dialect (a community one exists), and a dozen statements do not justify a dependency.
- What is worth doing instead, without a dependency: numbered migrations in `meta.schema_version` (step 1); one row
  type per table with a single `toX` mapper (already the pattern); `new Database(path, { strict: true })` so bindings
  need no `$` prefixes. Revisit if the query count grows several-fold, and then pick Kysely.

---

## 7. Tests and risks

Tests:

- **Fixture database**: a SQL script that builds a database in today's exact schema with real-shaped rows: rows
  with NULL `at`, items older than the event log (no events), at < ts rows (live and ended), pop-restore-pop items,
  edited items (with `edit` events), deleted items, queue starts (`q-x` and `s-x`), notes. Migrate it; assert every
  row of section 4's table; migrate again and assert nothing changes.
- **Invariants under random writes**: generate sequences of pushes, pops, undos, edits and resends from two devices
  with clocks skewed by up to +-5 s and some writes arriving twice or late; assert after each write that
  `end_at >= push_at`, `*_at <= the server clock at receipt` (unless edited), `push_ts` never changes once set, and
  every write that changed a row added exactly one history row.
- **Push-then-pop within a second**, with the pop's clock behind the push's: stored as zero length, raw time in
  `history.sent`.
- **Compatibility**: the existing server tests for the old wire and old endpoints run unchanged against the new
  server; that is the old-client suite.
- **Fallback**: open a migrated database with the current release's `store.ts`, write through it, start the new code,
  check the `v2_seq` repair.
- Client: `times.test.js` and `edit.test.js` cases in the new field names; IndexedDB conversion on load.

Risks:

| Risk | Mitigation |
|------|------------|
| Migration damages the real database | additive only; one transaction; `stack.db.pre-v2` copy; fixture test; can be run first on a copy pulled from baldur |
| Older code runs against the migrated database (automatic fallback) | legacy columns kept and written; `v2_seq` repair on start |
| Two shapes on the wire for a while | translation in one place at the store boundary; responses carry both shapes |
| Raising `end_at` hides a real clock problem | the raw value is kept in `history.sent`; the startup check counts raised rows |
| `history` grows without bound | it is one row per real change; at this scale (one person) years fit in a few MB |
| Undo-as-erase hides undone pops from the Done list | that is the intent (decision 1); the history still shows them |

---

## 8. Decisions for the owner

1. **Undo of a pop: "it never ended" (clear the end) or "it was off the stack for a while" (keep both intervals)?**
   Recommend: never ended. Undo is the only restore in the app and is used straight after a mistaken pop; the history
   keeps the undone pop.
2. **A device reports an end earlier than the push (clock skew, push-then-pop within a second): raise it to the push
   time, or store it as sent and make the client cope?** Recommend: raise it, keep the raw value in history.
3. **Column names: `push_ts`/`push_at`/`end_ts`/`end_at` (your convention: `ts` = server, `at` = person)?** The old
   wire's `ts` means the person's push time, so the two will coexist until step 6. Recommend: yes, your convention,
   with the old meaning confined to the legacy wire.
4. **Allow editing the push time of an item still on the stack** ("I actually started this ten minutes ago")?
   Recommend: yes; with `push_ts` immutable nothing is lost.
5. **Stop writing `events` at the migration (history replaces it) or write both for one release?** Recommend: stop;
   keep the table read-only.
6. **`history` for all synced tables (items, Later, notes) or items only?** Recommend: all three; it is generic and
   costs nothing extra.
7. **Build `/api/state` and `/api/day` in step 4, right after the model?** Recommend: yes; leave `/api/days` until a
   screen needs it.
8. **Add the debug read endpoint `GET /api/items/:id/history`?** Recommend: yes, narrow and read-only.
9. **Days defined by the client (`from`/`to` in ms) rather than by the server with a time zone?** Recommend: client.
10. **No ORM; numbered migrations with plain `bun:sqlite`.** Recommend: agree.
11. **Record pop vs drop explicitly on the item?** Recommend: no; it is derivable (was anything above it still on the
    stack at its end), and the client already derives it.
