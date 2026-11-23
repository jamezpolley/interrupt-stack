# Data model: an append-only log of actions

Status: revised proposal for the owner, after review comments on the first draft. Design only; nothing here is built.
Decisions needed are numbered in section 8. The first draft's options A (per-action rows plus materialised state) and
B (stage columns plus a history table) are dropped: B because every new operation would mean more columns on one
table, A because it kept two sources of truth. This is the log-structured design (the legacy `dex-stack` shape),
now with SQLite underneath.

## Summary

The **actions log** is the only source of truth. An action is one thing the person did, recorded once and never
changed: `push`, `pop`, `drop`, `restore`, `edit`, `delete`, `note`, and whatever is added later. Each action carries
two times: `ts`, the server clock when it was received (always the server's), and `at`, when the person says it
happened (always the person's, never later than `ts`). Everything else (the stack, the Done list, the Later queue,
notes, time on top) is a projection computed from the log, kept as tables by the server and recomputed on the device
by the same code. The client keeps its own journal of actions, sends the unsent ones as one stream, and receives
other devices' actions the same way.

Not "two stages" per item: an item has however many actions have happened to it.

---

## 1. Structural weaknesses of the current model

The current model keeps one row per item with `ts` (push time) and `at` (time of the last state change) and
repurposes both for pop. Each of these follows from that.

| # | Weakness | Where |
|---|----------|-------|
| W1 | **The end time shares a field with "last change".** A pop writes `items.at`; an undo overwrites it. A pop time has no field of its own, and an undone pop leaves no trace in `items`. | `store.ts` upsertTx, `at` branches; `sync.js` `remove`/`restore` |
| W2 | **The push time can be rewritten** by any write marked `edit: true`, with no record in the row of what it was. | `store.ts` line 166 and the check on line 190 |
| W3 | **No immutable server-received time per action.** The server's receipt time exists only in `events.ts`, which nothing reads. Once `ts` or `at` is edited the row cannot say when the server first saw the push or the pop. | `events` table |
| W4 | **`at < ts` is representable and gets stored.** A new row keeps its device `ts` unclamped while its `at` is clamped to the server clock, so a device whose clock runs a little fast stores an item that "ended" before it began. The derivation then returns null. | `store.ts` lines 166 vs 177; queue line 250; `times.js` `derive` |
| W5 | **A pop and a later restore make "on top" wrong.** Time on top is derived from `[ts, at]`; after pop, restore, pop, `at` is the last pop, so the gap when the item was off the stack counts as on top. | `times.js` `derive` |
| W6 | **Offline changes collapse, and history is a lossy side table.** The client keeps current-state rows plus a dirty flag, not a journal, so several offline changes to a row reach the server as one net change. The server-side `events` table (it exists today, server only, no read endpoint, never seen by the client) records diffs, and dates edit/delete events by the server clock rather than the person's. | `store.ts` lines 151-154, 199-204; `web/core.js` outbox |
| W7 | **Stack order uses the device's push time**, so a fast clock can put a push above one made a moment later on another device. Follows from W4. | `sync.js` `currentStack` |

W4's two cross-checks, in the owner's words: with a separate `ts`/`at` pair per action, `pop.ts > push.ts` always
holds (`ts` is server receipt order), and `pop.at` is only the person's claim. `pop.at < push.ts` can still happen
harmlessly. The one comparison worth making is `pop.at >= push.at`, between two things the person said (section 3).
The original draft's forensic section on why "Shave" showed a pop 1.3 s before its push is removed: the model is
broken, and fixing the model fixes whatever instance exposed it.

---

## 2. The design

### The log

```sql
CREATE TABLE actions (
  n       INTEGER PRIMARY KEY AUTOINCREMENT,  -- server order of receipt; also the sync cursor
  id      TEXT NOT NULL UNIQUE,               -- made by the client; INSERT OR IGNORE makes resends idempotent
  ts      INTEGER NOT NULL,                   -- server clock at receipt. Never changes.
  at      INTEGER NOT NULL,                   -- the person's time, clamped to <= ts at receipt. Never changes.
  kind    TEXT NOT NULL,                      -- open-ended; see below
  target  TEXT NOT NULL,                      -- what it acts on: an item, queue row or note id
  ref     TEXT,                               -- an action id (edit, void) or an item id (restore), per kind
  data    TEXT,                               -- JSON payload per kind: text, a new time, ...
  origin  TEXT                                -- device that made it
);
CREATE INDEX actions_target ON actions(target, n);
CREATE INDEX actions_at     ON actions(at);
```

Rows are only ever inserted. There is no `voided` flag and no second edits table: undoing and editing are actions
that point at earlier actions.

### Kinds

`kind` is a plain string; the reducer ignores kinds it does not know, so new operations are new kinds, never new
columns. Today's:

| Kind | `target` | Meaning |
|------|----------|---------|
| `push` | new item id | Item starts; `data.text` |
| `pop` | item id | Item ended while it was on top of the stack |
| `drop` | item id | Item ended while not on top |
| `restore` | item id | An ended item goes back on the stack. Its earlier push and pop stay; this adds a new interval with its own start time |
| `void` | item id | Undo: `ref` names the action to cancel (the UI offers it only for the latest pop; the item then "never left") |
| `edit` | item id | `ref` names the action whose time changes, with `data.at`; or no `ref` and `data.text` for a text change |
| `delete` / `undelete` | item id | Hide / unhide |
| `note` / `edit`/`delete` on a note | note id | Notes: same mechanism, no intervals |
| `later` / `start` / `dequeue` / `requeue` | queue id | Today's Later queue operations; `start` also pushes (`s-x` from `q-x`) as an ordinary `push` action |

**Pop vs drop** are two kinds, recorded by the client at the moment of the action, because the log should hold what
the person did, not what a rule later infers. (Today the client derives it from whether anything was above the item;
decision 4 asks whether to keep that derivation instead and have one `end` kind. With open-ended kinds there is no
need for an `end` abstraction.)

**Undo pop vs restore** are different things and the old draft's `unend` conflated them:

- *Undo pop* = a `void` action naming the pop. As far as every projection is concerned the pop never happened. The
  pop stays in the log.
- *Restore* = a `restore` action. The pop did happen; the item is pushed again. The item now has two intervals, and
  both keep their original times. Time on top sums the intervals, so W5 goes away.

The current app's button (called "restore" in the code and events) has only ever behaved as undo: that is decision 5.

### Projections

Derived, never edited, rebuildable from the log by one function (and tested to equal the incrementally updated
tables):

```sql
items      (id PK, text, deleted, origin, last_n)            -- current state per item
intervals  (item_id, k, start_n, start_at, start_ts,
            end_n, end_at, end_ts, end_kind)                  -- one row per time on the stack
notes      (id PK, text, at, ts, removed, last_n)
queue      (id PK, text, state, last_n)
```

The server applies each action to these tables in the same transaction that appends it, so the log and the state
cannot disagree. An item is on the stack when it has an interval with no end. Done today = intervals whose end falls
in the day. "What was on the stack at 10:40 last Tuesday" is one query over `intervals` using `start_at`/`end_at`
(with edits applied, below). "What did the database say at 10:40" is a replay of `actions WHERE ts <= :T`, rare and
debug-only.

Edits: an `edit` action naming an earlier action sets that action's effective `at`; the projection takes the latest
edit by `n`. The original `ts` and `at` stay in the log forever. Today's rule that an edit is rejected when it would
put a pop before its push is kept (refused per action, reported in `rejected`).

Read-time normalisation instead of write-time raising: if a device reports a pop whose `at` precedes its interval's
start `at` (clock skew, push-then-pop within a second), the log stores exactly what was sent (clamped to `ts`), and
the interval's *effective* end is `max(at, start)`: a zero-length stay, never an impossible one. Nothing is lost
and nothing needs special handling at write time.

### Sync

The client keeps a journal (IndexedDB `actions` store: every action it made or received, with a `sent` flag) and a
local projection from the same reducer as the server. One request:

```json
{ "epoch": "…", "cursor": 812,
  "actions": [ { "id": "a-…", "at": 1795394445891, "kind": "push", "target": "s-abc", "data": {"text": "Shave"} },
               { "id": "a-…", "at": 1795394446900, "kind": "pop",  "target": "s-abc" } ] }
```

Response: `{ "epoch", "cursor", "actions": [every action with n > cursor, including the client's own, now with n/ts],
"rejected": { "<id>": "reason" } }`. The client merges by `id`, advances `cursor`, recomputes its projection. The SSE
`sync` event stays a counter (`n`), as now. Offline work is replayed action by action, in order, so nothing collapses
(W6). `at` is the device clock when the person acted, so it survives the delay.

A fresh device does not have to replay years of actions: `GET /api/state` returns the current projection plus the
cursor, the client starts from that, and fetches history only when asked. That means the reducer must apply an action
onto a projection (`apply(state, action)`), not only fold a whole log. It is written that way from the start.

### The shared reducer

The costly, central piece: one pure module (`web/reduce.js`, imported by `server/` and the client; Bun runs the same
ES modules) turns a log into projections, and the Later queue, notes and stack all use it. It is where W4/W5 are
fixed (interval handling, read-time normalisation), and it replaces `derive`/`timeline` assumptions in `times.js`. If
server and client ever disagreed about it the two would display different Done lists, so it is covered by one test
suite run against both a Bun server and the browser module, with the same fixture logs (section 7).

### Why this and not rows

The first draft recommended keeping row-based sync and adding columns. The reasons it gave against this design were
the client protocol rewrite, "edits become correction actions every reader must apply", and reordering. Those are
costs of work the owner asked to have planned, not defects, and none is a SQLite problem:

- SQLite is happy with an insert-only table; transactions give the "log and state cannot disagree" guarantee a JSONL
  file could not, and `INSERT OR IGNORE` on a unique `id` is a one-line idempotency check.
- Processing events as received into state tables (rather than recomputing from the log per request) is the right
  server shape, and it is what is proposed.
- Ordering has one rule: state transitions apply in `n` (receipt) order; time questions use `at`. A late action from
  another device never rewrites an earlier `n`, it is just later in the log.
- The real extra work versus a row-based design: the shared reducer, a client journal, migrating existing rows into
  actions (section 4), and keeping an old-client translation for a while. All of these were going to be touched by the
  data-model change anyway (`sync.js`, `queue.js`, `notes.js`, `core.js`, `times.js`).
- One honest downside: the log only grows. At one person's rate this is a few thousand rows a year; if it ever
  matters, a snapshot-and-truncate step (the same `apply(state, action)` function) is the answer.

### `events` and `seq`

`events` is frozen at the migration (no new writes) and read-only afterwards; it is the source for migration. `seq`
is replaced by `actions.n` as the one counter; until old clients are gone, `/api/sync`, `/api/items` and `/api/queue`
are served from the projections and old-shape writes are translated into actions at the store boundary.

---

## 3. Time semantics (summary; detailed rules wait for the owner's go-ahead on the above)

- `ts` is always the server's clock at receipt. Never sent by clients, never edited.
- `at` is always the person's time. Clamped to `min(sent, ts)` when stored (fixes W4's unclamped new rows). An edit
  more than 5 minutes ahead is refused, as now.
- A person's edit is an `edit` action. The *effective* time is the latest edit; the original stays in the log.
- Stack order uses effective `start_at`, with `n` as the tie-breaker.
- Time on top sums intervals (`min(end, next higher push)` is computed from the same intervals as now).

---

## 4. Migration and shipping

Migrations today are scattered `PRAGMA table_info` guards in `store.ts` (verified). There is no migration library and
none is needed: use SQLite's `PRAGMA user_version` (or `meta.schema_version`) plus an ordered list of numbered steps,
each in one transaction. Adding a library would not remove the real work, which is the data conversion.

### What existing data becomes

| Existing | New actions |
|----------|-------------|
| `items` row | `push` (`at` = `items.ts`; `ts` = the first `push` event's `ts`, else `items.ts`, with `data.synth` marking a guess) |
| removed item | `pop` (or `drop` where the event log says so) with `at` = `items.at`; rows with NULL `at` get `at = ts` |
| `events` `edit` | `edit` actions (`ts` = event `ts`) |
| `events` `restore` after a `pop` | a `void` of that pop (that is what the current button does; decision 5) |
| deleted flag / events | `delete` / `undelete` |
| `notes` | `note` (+ `edit`/`delete`) |
| queue rows | `later`, `start`, `dequeue`, `requeue` |

All inside one transaction, recorded in `schema_version`; `/data/stack.db` is copied to `stack.db.pre-actions`
first. The conversion keeps the old tables unchanged; the new code stops writing them. Lost: received times for
rows older than the event log (they are synthesised and marked), and nothing else.

### Falling back to older code

The deployment can fall back automatically to the image's older code (README, "Baking in a clone"). Migration is
additive (new tables only) so older code still opens the database; it would see stale rows, which is a known and
acceptable degraded mode for a fallback. If that is not acceptable, the new code can keep writing the legacy columns
for one release (cost: a second write path). This is a decision (6 below).

### Steps (each a PR, stacked)

1. **Reducer and log, server side.** `actions` table, shared `reduce.js`, projections, rebuild function, numbered
   migrations and the conversion; fixture database of real-shaped rows; old wire translated at the boundary. Clients
   unchanged.
2. **Client journal and wire v2.** IndexedDB `actions` store, local projection from the shared reducer, `POST
   /api/sync` carrying actions; `times.js`, `today.js`, `edit.js` read intervals. Old wire still served.
3. **Read endpoints.** `GET /api/state`, `GET /api/day`, `GET /api/items/:id/history` (the item's actions), for fresh
   devices and "previous days" screens. Build after the model, not before.
4. **Retire the old wire and tables** once no cached client remains.

---

## 5. API sketch

`POST /api/sync` as in section 2. Auth is the proxy's job. Times are ms since epoch; days are given by the client as
`from`/`to` (its own local midnight), so the server needs no time zones.

- `GET /api/state?from=&to=` returns `{ epoch, cursor, now, stack, later, done, notes, context }`: the current
  projection for a new device (the cursor then syncs incrementally).
- `GET /api/day?from=&to=` returns what happened in that window, including pushed-but-not-ended items.
- `GET /api/items/:id/history` returns that item's actions oldest first: for answering "what happened to this
  item". The owner declined an `events` read endpoint earlier; this one is narrow and debug-only (decision 7).
- `GET /api/days` (per-day summary, needs a time zone) is left until a screen needs it.

## 6. ORM / query layer

No ORM. Keep `bun:sqlite` with prepared statements. The hard part is the write rule inside each transaction, which an
ORM does not help with; Drizzle wants to own migrations; Kysely lacks a first-party `bun:sqlite` dialect and a
dozen statements do not justify a dependency. Cheap wins instead: `new Database(path, { strict: true })`, one row type
per table. Revisit if the query count grows several-fold.

## 7. Tests and risks

Tests: a fixture database in today's exact schema with real-shaped rows (NULL `at`, pre-event-log items, `at < ts`
rows, pop-restore-pop items, edited and deleted items, queue starts, notes) converted and checked against section 4's
table, and converted again to prove it idempotent; a rebuild-equals-incremental property test; random action
sequences from two devices with clocks skewed by up to 5 s, resends and late arrivals, asserting the invariants
(`ts` monotonic in `n`, `at <= ts`, no interval with effective end before start, every action id applied once); the
same reducer fixtures run in Bun and in the browser module; old-client wire tests unchanged against the new server.

| Risk | Mitigation |
|------|------------|
| The conversion damages the real database | additive only; one transaction; `.pre-actions` copy; fixture test; a dry run on a copy pulled from baldur |
| Client and server projections diverge | one shared reducer; one fixture suite run in both runtimes |
| Older code against the migrated database (automatic fallback) | decision 6 |
| Two wire shapes for a while | translation in one place at the store boundary |
| The log grows without bound | one person's rate; `apply(state, action)` supports a snapshot later |

---

## 8. Decisions for the owner

1. **Edits.** You said an immutable fact should not be editable; I agree. This design does not edit facts. `ts` and
   the first-reported `at` stay in the log forever. An edit is a new action, and the *effective* time is the latest
   edit. If you accept that, say so; if you want the original `at` truly overwritten, that is a different (and
   worse) design and a major change that I would not slip in.
2. **Restore as a new interval on the same item** (recommended: one task keeps one history, the Done list can show
   each stay) or as a new item with a pointer to the original?
3. **Done list:** one entry per interval (a restored item appears each time it was popped) or one per item?
4. **Pop and drop as separate recorded kinds** (recommended) or one `end` kind with the client deriving which?
5. **The current undo/"restore" button:** it behaves as undo pop (void). Keep it that way and add a separate
   "push again" for restore, or is something else meant?
6. **Falling back to older code after migration:** accept a stale view in that mode (recommended), or write the
   legacy columns for one release?
7. **Debug read endpoint** `GET /api/items/:id/history` (recommended) and the `/api/state` / `/api/day` endpoints
   in step 3.
8. **Void rules:** the UI offers undo only for the latest pop; the server accepts a `void` of any action by the same
   person (recommended), or only the latest?
9. **`events` after migration:** frozen, read-only (recommended).
10. **No ORM; numbered migrations with plain `bun:sqlite`.**
11. **Order of work:** the four steps in section 4 as separate stacked PRs, with step 1 first.
