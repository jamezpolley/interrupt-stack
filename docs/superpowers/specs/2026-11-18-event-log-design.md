# Event log design

Status: approved by James in conversation, 2026-11-18.

## Intent

Record what happens to the stack (push, pop, restore) with real timestamps, so time spent on tasks can be analysed
afterwards. Today an item is one mutable row; removing it overwrites its state and the history is lost.

The old dex-stack tool kept an append-only jsonl journal with two timestamps per entry. That is inspiration for the
shape only: no interop, no import or export of its format.

## Goals

- Every push, pop and restore is recorded durably, surviving server restarts and redeploys.
- Each event carries when it happened on the device (`at`) and when the server recorded it (`ts`), because devices
  go offline and sync later.
- The log is readable as jsonl, oldest first, for analysis with `jq`, DuckDB or a script.

## Non-goals

- No analysis UI, and no time-per-task calculation in the app.
- No import or export in any other format, no backfill of history from before this ships.
- No change to how devices sync or to the stack the person sees.

## Constraints

- Same SQLite database and `/data` volume. The event is written in the same transaction as the item change, so the
  log and the stack cannot disagree.
- Old cached clients (which send no `at`) and old servers (which ignore it) must keep working.
- A device must never get stuck in a sync error because its clock is wrong.

## Approaches considered

1. **`events` table in the existing SQLite database (chosen).** One transaction covers item and event; `/api/log`
   renders jsonl from it.
2. A separate `events.jsonl` file on the volume. Greppable on disk, but a second write that can fail on its own, so
   the log and stack can disagree.
3. Clients send explicit events instead of item state. Truest history, but rewrites the sync protocol for a feature
   that only needs the server to notice state changes.

## Design

**Item gains `at`:** the device's clock when the item last changed state (equals `ts` for a fresh push). Stored in
the `items` table (added by a guarded `ALTER TABLE` for existing databases), sent in the PUT body, returned in the
item. Optional everywhere: missing means "use `ts` for a push, the server's clock otherwise".

**Events are derived by the server on each upsert, by comparing with the stored row:**

| Stored state     | Incoming        | Events written                   |
|------------------|-----------------|----------------------------------|
| none             | live            | `push`                           |
| none             | removed         | `push` (at = `ts`), then `pop`   |
| live             | removed         | `pop`                            |
| removed          | live            | `restore`                        |
| same as incoming | same            | none (retries are idempotent)    |

Devices send only an item's latest state, so several offline transitions between two syncs collapse to the net
change. That is a known limit of the log.

**Event row:** `n` (autoincrement), `ts` and `at` (integer ms since epoch), `op`, `id`, `text`.

**Clock guard:** an `at` later than the server's clock is clamped to the server's clock, not rejected. Rejecting
would leave an item stuck in a permanent sync error on a phone whose clock runs ahead.

**`GET /api/log`:** `application/x-ndjson`, one event per line, oldest first, e.g.
`{"n":1,"ts":"2026-11-18T01:02:03.000Z","at":"2026-11-18T01:01:50.000Z","op":"push","id":"s-abc123","text":"bank rec"}`.
Times are ISO-8601 UTC strings. Behind the same access as the rest of the API; no new auth.

## Left to the builder

Exact SQL, test names, the README paragraph.
