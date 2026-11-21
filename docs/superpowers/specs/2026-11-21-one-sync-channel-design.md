# One sync channel

Status: decided by the owner (replace two channels with one); details below are the implementer's choices.

## Problem

The stack (`items`, `seq`, `GET /api/items`, `PUT /api/items/:id`, SSE `seq`) and the Later queue (`queue`, `qseq`,
`/api/queue`, SSE `qseq`) each sync on their own: two cursors, two request loops, two failure paths, two copies of the
sync core on the client. Notes are coming next as a third table; copying the pattern a third time is the wrong cost.

## Contract

### Request

`POST /api/sync`, JSON:

```
{ "epoch": "<uuid>" | null,      // the database this client last synced with
  "cursor": 0,                   // last cursor this client received (0 = never synced)
  "changes": { "items": { "<id>": <ItemInput> }, "queue": { "<id>": <QueueInput> } } }
```

`changes` holds each pending row's latest state, keyed by id (so one row appears at most once per request); each value
has exactly the fields the old `PUT` body had (`text, ts, removed, at, origin, edit` for items; `text, ts, removed,
started, at` for queue). A table the client has nothing for may be omitted. Limits: body 256 KiB, 500 changes; the
client sends at most 100 per request and repeats until its pending set is empty. An unknown table name is a 400 for the
whole request.

### Response (200)

```
{ "epoch": "<uuid>", "cursor": 57,
  "tables": { "items": { "rows": [Item...], "saved": { "<id>": Item }, "rejected": { "<id>": {"error": "..."} } },
              "queue": { ... same ... } } }
```

- `rows`: every row (tombstones included) whose `seq` is greater than the request's `cursor`, oldest first, as of
  after the changes were applied. Rows the request just wrote are included.
- `saved`: the stored row for each change that was applied (what the old `PUT` returned).
- `rejected`: a change that failed validation (the old `PUT` 400). Per change, so one bad row never blocks the rest.
  The client keeps it pending and shows a client-error (status 400) as before.
- `cursor`: the server's highest counter value now. The client stores it for the next request.

Whole-request problems keep HTTP semantics: 400 invalid JSON / unknown table, 413 too large, 5xx. The client classifies
them with the existing `assertUsable` (sign-in, server-error, client-error, bad-reply) and keeps
`redirect: "manual"`.

### SSE

`GET /api/events` still carries `seq` and `qseq` (below) and now also `event: sync`, `data: <cursor>`, sent on connect
and after every applied change. The new client listens to `sync` only; on any `sync` event it runs one sync request.

## The shared counter

There is ONE monotonically increasing counter shared by all synced tables. It is not a new stored value: it is
`max(seq)` across the synced tables, and a write sets the row's `seq` to that maximum plus one (inside the same
immediate transaction as the write). Consequences:

- The existing `items.seq` and `queue.seq` columns stay and simply draw from the same sequence, so **no schema
  migration is needed** and an existing database file from `main` opens unchanged. Legacy rows have overlapping
  numbers across tables (items 1..50, queue 1..10); that is harmless because the first new-style request always has
  cursor 0 and receives everything, and every later write is above both maxima.
- Rows are never deleted (tombstones), so the maximum never goes down.
- Adding a table is one entry in the server's table registry (name, id pattern, `upsert`, `read since`, `seq` column)
  plus one `hub.table(name, ...)` on the client. The counter, request, response, cursor, epoch handling, tombstone
  handling, SSE and the failure classification need no change. (The generic part is `tables` in `store.ts` and
  `core.js` on the client.)

## Conflict rules (unchanged, now per change)

Last write wins by arrival, as before, with the same exceptions, all inside the existing per-table `upsert`
transactions, which are reused as they are, so event-log derivation, clamping of device times, the item floor for
retried events, `edit: true` / `edited_at`, immutable `origin` and the queue's `started` all behave exactly as with `PUT`.
A change from a client whose pending row is the same as the server's adds no event. Within one request each id appears
once. Changes are applied items first, then queue, each in its own transaction (a rejected change rolls back alone).

On the client, a row received in `rows` is ignored while that id is pending locally (the local change will be sent and
wins), and an acknowledgement (`saved`) replaces the local row only if the local row is still the object that was sent
(unchanged while the request was in flight), exactly as today.

## Epoch and cursor reset

Unchanged in meaning, now one value for all tables. The client treats the database as replaced when the response's
`epoch` differs from the one it holds, or the response `cursor` is below the client's. It then: applies the `saved`
acknowledgements, drops the rows, sets cursor 0, adopts the new epoch, marks every row of every table pending and
syncs again (which re-uploads everything). The server applies a request's changes even if its epoch is stale; they are
legitimate changes and last-write-wins.

## Old endpoints (rolling deploy)

Left exactly as they are: `GET/PUT /api/items`, `GET/PUT /api/queue`, SSE `seq` and `qseq`, with the same
shapes. Their numbers are now drawn from the shared counter, so `since` and `seq` are still monotonic per table (with gaps),
which is all those clients rely on. `seq` is sent after item changes and `qseq` after queue changes, as before. They
are removed in a later release, once no cached client remains (keep them at least one release).

An already-cached client (old service worker serving old `app.js`) keeps working against the new server. In the other
direction the new `sync.js`/`queue.js` keep their exported names and factories (`createSync`, `createQueue`), so a
device holding a mix of old and new files for a moment (the service worker refreshes cached files one by one) still runs.

## Client

- `web/core.js` (new): `createHub({ fetch, meta, now, online, onStatus, local })`. Owns the single sync loop, cursor,
  epoch, status, failure detail, storage-failure flag, `SyncFailure`, `describeResponse`, `assertUsable`, and a registry of
  tables. `hub.table(name, { storage, onChange })` returns the table's `items` map, `dirty` set and a `setItems(list)`
  that does the local-first write (store, mark pending, save, redraw, request a sync).
- `web/sync.js`: `createSync` makes the hub (its storage holds the cursor and epoch) and registers `items`; the stack
  API is unchanged and `sync.hub` is exposed. `web/queue.js`: `createQueue({ stack, ... })` registers `queue` on
  `stack.hub`; its `fetch`/`onStatus` options are ignored (kept so callers need not change).
- Status is one: `sync.status()` and `queue.status()` return the same hub status (pending counts every table).
  `app.js` therefore stops summing the two, and the "queue went offline, let the stack try" workaround goes.
- Storage: no IndexedDB schema change. The stack database's meta store keeps the cursor under a **new key** `cursor`
  (the old `lastSeq` was a per-table number and must not be reused); the epoch key is reused. The queue database keeps its
  rows and pending list; its old `lastSeq`/`epoch` are ignored. On first run after the upgrade the cursor is 0, so one
  full download happens; pending changes survive and are sent in that same request.
- `events.js`: also listens for `sync`; app.js passes one handler. `redirect: "manual"` stays on the one request.
- LOCAL_ONLY: the hub is created in local mode: no request, no pending set, status "local".
- Service worker: `CACHE` goes to v20 (v19 is in use on the day-buttons work, v18 on in-place-lists, v17 on `main`);
  `core.js` is added to the shell list.

## Decisions I made (flag if wrong)

1. Shared counter derived from existing seq columns, not a new meta counter: avoids a migration and cannot drift.
2. One-time full re-download on upgrade (new `cursor` key) instead of trying to convert two old per-table cursors.
3. Per-change rejection inside a 200 response rather than failing the whole request, so one bad row cannot wedge sync.
4. Client sends at most 100 changes per request, pending rows that were rejected go to the back of the line.
5. Old endpoints stay for at least one more release; removal is not part of this change.
