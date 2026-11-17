# Interrupt Stack PWA: design

Date: 2026-11-17. Status: awaiting approval. Prototype: `prototype/index.html` (an artifact for claude.ai, kept for reference).

## Intent

James gets distracted mid-task. He wants one stack he keeps open on every device (Windows laptop, iPhone, iPad, ChromeOS). He pushes a task when he starts it. When he finishes, he pops it and sees what he was doing before. Devices are not open at the same time, so the stack must persist and sync.

The artifact prototype works but only syncs inside a claude.ai tab and cannot be installed. This project replaces it with an installable PWA backed by a small self-hosted server in a Docker container.

## Goals

- Installable PWA on all four platforms. Opens fast, works offline.
- Push, pop, drop and undo, with the prototype's behaviour and look. The top of the stack is always the large "Working on" card.
- One shared stack, synced across devices, with live updates when another device changes it.
- Offline use: changes made offline are kept and sent when the connection returns.
- Visible sync status (synced, syncing with a count of pending changes, offline).
- One Docker container. It listens on one port and keeps data in a mounted volume. Nothing else is required to run it.

## Non-goals

- Accounts, sign-in, sharing, or multiple users or stacks. One stack per deployment.
- TLS, hostnames, reverse proxy or any decision about how the port is reached. James hooks that up.
- Native apps.
- Timers, notes, history and edit mode. Raised in the brief, deferred.

## Anti-goals

- Losing a push because two devices wrote at once.
- A stack that blanks or errors when the server is unreachable.
- Needing more than `docker compose up` to run.

## Constraints

- The server has no authentication, since access control is handled outside the container. Its docs say so plainly. The compose file publishes the port on 127.0.0.1 by default for that reason (my call; James can change it).
- Browsers only install a PWA and register a service worker from a secure origin. James's access layer must provide HTTPS. The app should say so if it detects an insecure origin.
- Device clocks order the stack, as in the prototype. A badly skewed clock can misorder items.

## Approaches considered

1. **Small self-hosted server with SQLite, offline-first client (chosen).** Local copy in the browser, a sync API, live updates. No external accounts, data stays with James.
2. The same server exposed publicly with its own login. Rejected: adds auth for a single-user tool, and James said not to assume access.
3. A hosted backend (Cloudflare, Supabase). Rejected: new account, possible cost, vendor dependence, for little gain.

James chose approach 1 and asked for it as a Docker container.

## Design

### Data model

One row per stack item, so concurrent pushes never overwrite each other.

| field | meaning |
| --- | --- |
| `id` | client-generated, e.g. `s-<ts base36><random>` as in the prototype |
| `text` | up to 200 characters |
| `ts` | push time in ms since epoch, from the pushing device |
| `removed` | boolean; set by pop or drop, cleared by undo |
| `seq` | server-assigned, increases on every change |

Removal is a flag, not a delete, so a removal made on one device reaches the others (a tombstone). The stack is the non-removed rows ordered by `ts`, newest first.

### Server API

All JSON, served by one process alongside the static files.

- `GET /api/items?since=<seq>` returns all rows changed after `seq` (removed ones included) and the current `seq`.
- `PUT /api/items/<id>` with `{text, ts, removed}` creates or updates a row. It is idempotent, so retrying after a dropped connection is safe. Returns the row with its new `seq`.
- `GET /api/events` is a server-sent event stream that announces new `seq` values so open clients pull straight away.
- `GET /healthz` for the container health check.

Conflicts: the last write the server receives for an `id` wins. This is acceptable for a single-user stack.

### Client

- Plain HTML, CSS and JavaScript, no build step, no framework. The UI and visual design come from the prototype (IBM Plex, light and dark themes, large current-task card).
- Local copy in IndexedDB. Every action updates the local copy first and renders at once.
- An outbox of unsent changes in IndexedDB. A sync loop sends them in order, then pulls `since` its last known `seq`.
- Pulls run on load, on the event stream, on regaining focus or connectivity, and on a slow timer, because iOS may suspend the event stream in the background.
- Service worker caches the app shell so the app opens offline. It never caches `/api/`.
- `manifest.webmanifest` and icons for installation.
- Undo for 15 seconds after any removal, as in the prototype.

### Container

- Dockerfile builds a small image that runs the server as a non-root user, with a health check on `/healthz`.
- `compose.yaml` publishes `${INTERRUPT_STACK_BIND:-127.0.0.1}:${INTERRUPT_STACK_PORT:-8080}:8080` and mounts a named volume at `/data` for the SQLite file.
- No configuration is required.

### Repo layout

```
server/        server code and tests
web/           index.html, app.js, sw.js, manifest, icons
Dockerfile
compose.yaml
docs/
prototype/     kept for reference
```

## Left to the builder

- Runtime: **Bun** (decided). Its SQLite module is built in and stable, it serves static files and server-sent events without a framework, and the image needs no installed dependencies.
- Exact schema, ports inside the container, SSE keep-alive interval, sync timer interval, icon artwork.
- Test approach. At minimum: API tests for the server (idempotent PUT, tombstones, `since` paging) and tests for the client's outbox and merge logic.

## Verification

- `docker compose up` starts the server, and `/healthz` answers.
- Two browser profiles against one server show a push on one appearing on the other without reload.
- Pushing with the server stopped keeps the item; it reaches the server after restart.
- The app installs from Chrome, and the service worker lets it open with the server stopped. iOS install and offline behaviour cannot be tested from this machine, so James checks them on the real devices.
