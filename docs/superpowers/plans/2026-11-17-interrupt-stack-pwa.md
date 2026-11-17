# Interrupt Stack PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable, offline-first PWA for a push/pop interrupt stack, with a Bun and SQLite sync server packaged as one Docker container that exposes a single port.

**Architecture:** One Bun process serves static files from `web/` and a small JSON API backed by SQLite. The browser keeps a local copy in IndexedDB plus a set of unsent item ids, applies every action locally first, then syncs: pushes dirty items with idempotent PUTs, pulls changes since its last `seq`, and pulls immediately when the server-sent event stream announces a new `seq`. The sync logic is a pure ES module with injected storage and fetch, so it is tested under `bun test` without a browser.

**Tech Stack:** Bun (built-in `bun:sqlite`, `Bun.serve`, `bun:test`), plain HTML/CSS/JS ES modules, IndexedDB, service worker, Docker.

**Spec:** `docs/superpowers/specs/2026-11-17-interrupt-stack-pwa-design.md`. Visual design and copy come from `prototype/index.html`.

## Global Constraints

- No npm dependencies, no client build step, no framework.
- One item per record; removal sets `removed = 1` (tombstone), never deletes the row. Undo sets it back to 0.
- `text`: trimmed, 1 to 200 characters. `ts`: integer ms since epoch from the pushing device. `id` matches `^s-[a-z0-9]{4,40}$`.
- Last write the server receives for an `id` wins. `PUT` is idempotent.
- API: `GET /api/items?since=<seq>`, `PUT /api/items/<id>`, `GET /api/events` (SSE), `GET /healthz`. All JSON except the stream.
- The server has no authentication and does no TLS; docs say so. Compose publishes `${INTERRUPT_STACK_BIND:-127.0.0.1}:${INTERRUPT_STACK_PORT:-9958}:9958` and mounts a named volume at `/data`.
- James deploys it with Dockhand pointed at this git repo, building on deploy. `compose.yaml` sits at the repo root, builds from the repo with `build: .` (no `image:` line unless Task 8 is done), uses no host paths and no files outside the repo, and takes all settings (`INTERRUPT_STACK_BIND`, `INTERRUPT_STACK_PORT`) from environment variables with defaults, so it runs unchanged when a git-based stack deployment builds it.
- The service worker caches the app shell only and never caches `/api/`.
- Undo window after any removal is 15 seconds. Text is always rendered with `textContent`.
- Container runs as a non-root user and has a health check on `/healthz`.
- Commits end with the trailer lines `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01KX9PiVMWNqvm2b5AuKHXbB`.

## Review Focus

1. Server database wiped or replaced, so the server's `seq` is lower than the client's `lastSeq`: the client must re-pull from 0 and re-send its dirty items, not stall. (Task 3)
2. Whitespace-only text, 200 versus 201 characters, and emoji or other multi-byte text: reject empty and over-length with 400, accept the boundary and Unicode intact. (Task 1, Task 2)
3. The same item removed on one device while undone on another: last write wins and both devices converge to the same state. (Task 3)
4. Pushing then popping an item entirely while offline: after reconnecting, the server holds one removed row and the stack is correct everywhere. (Task 3)
5. Event stream drops (server restart, phone sleep): the client reconnects and pulls on its own without a reload. (Task 3, Task 4)

---

### Task 1: Store

**Files:**
- Create: `server/store.ts`, `server/store.test.ts`, `package.json` (scripts `test`, `start` only), `.gitignore`

**Interfaces:**
- Produces: `type Item = {id: string; text: string; ts: number; removed: boolean; seq: number}`; `type ItemInput = {text: string; ts: number; removed: boolean}`; `openStore(path: string): Store` (`":memory:"` allowed); `Store.upsert(id: string, input: ItemInput): Item` (assigns `seq` = previous max + 1, creating the row if absent); `Store.since(seq: number): {seq: number; items: Item[]}` (items with `seq` greater than the argument, ascending, plus the current max `seq`, 0 when empty); `Store.close(): void`. Throws `ValidationError` for bad `id`, `text` (after trim, empty or over 200 characters) or non-integer `ts`.

- [ ] **Step 1:** Confirm `bun --version` runs; if not, install through mise (`mise use bun@latest`) and note it in the commit.
- [ ] **Step 2:** Write failing tests in `server/store.test.ts`: `upsert creates a row with seq 1`; `second upsert of another id gets seq 2`; `upsert of the same id with identical input still bumps seq and keeps one row`; `removed true then false round-trips`; `since(0) returns all rows including removed`; `since(n) returns only later rows ascending`; `since on empty store returns seq 0 and no items`; `text is trimmed before storing`; `rejects whitespace-only text`; `accepts 200 characters and rejects 201`; `stores emoji text unchanged`; `rejects id "../x"`; `rejects non-integer ts`; `data persists across close and reopen of a file database`.
- [ ] **Step 3:** Run `bun test server/store.test.ts`; expect failures because the module is missing.
- [ ] **Step 4:** Implement `server/store.ts` using `bun:sqlite`; table `items(id TEXT PRIMARY KEY, text TEXT, ts INTEGER, removed INTEGER, seq INTEGER)` with an index on `seq`; compute the next `seq` inside the same transaction as the write.
- [ ] **Step 5:** Run the tests; expect all pass.
- [ ] **Step 6:** Commit.

### Task 2: HTTP app

**Files:**
- Create: `server/app.ts`, `server/app.test.ts`, `server/main.ts`
- Modify: `package.json` (`start`: `bun server/main.ts`)

**Interfaces:**
- Consumes: `openStore`, `Store`, `ValidationError` from `server/store.ts`.
- Produces: `createApp(store: Store, opts: {webDir: string}): {fetch(req: Request): Promise<Response>; notify(): void}`, usable as `Bun.serve({fetch: app.fetch})` and directly in tests. `main.ts` reads `PORT` (default 9958) and `DATA_DIR` (default `/data`; creates it), opens `DATA_DIR/stack.db`, and serves.

Behaviour: `GET /api/items?since=N` returns `{seq, items}` (missing or invalid `since` means 0). `PUT /api/items/:id` validates, upserts, calls `notify()`, returns the item; 400 with `{error}` on `ValidationError` or malformed JSON; 413 above 4 KB. `GET /api/events` returns `text/event-stream`, sends `event: seq` with the current `seq` on connect, again after every write, and a comment line every 25 seconds. `GET /healthz` returns `ok`. Any other GET serves a file from `webDir` with the right content type, `/` maps to `index.html`, path traversal is refused, and unknown paths return 404. Static responses set `Cache-Control: no-cache`.

- [ ] **Step 1:** Write failing tests in `server/app.test.ts` calling `app.fetch` with an in-memory store: `PUT then GET since 0 returns the item`; `PUT twice is idempotent`; `PUT with 201-character text returns 400`; `PUT with whitespace text returns 400`; `PUT with bad JSON returns 400`; `PUT over 4 KB returns 413`; `GET since beyond current seq returns empty items and the current seq`; `GET /healthz returns 200 ok`; `GET /../server/store.ts returns 404`; `GET / returns index.html with text/html`; `event stream emits a seq event on connect and after a PUT` (read from the response body stream).
- [ ] **Step 2:** Run `bun test server/app.test.ts`; expect failures.
- [ ] **Step 3:** Implement `server/app.ts` and `server/main.ts`. Keep a set of open stream controllers in `createApp` for `notify()`.
- [ ] **Step 4:** Run all tests; expect pass.
- [ ] **Step 5:** Smoke test: run `PORT=8099 DATA_DIR=/tmp/ist bun server/main.ts` in the background, `curl -s localhost:8099/healthz` prints `ok`, then stop it.
- [ ] **Step 6:** Commit.

### Task 3: Client sync core

**Files:**
- Create: `web/sync.js`, `web/sync.test.js` (run by `bun test`)

**Interfaces:**
- Produces: `createSync(deps): Sync` where `deps = {storage, fetch, now?: () => number, onChange?: () => void, onStatus?: (s: Status) => void}` and `Status = {state: "synced" | "syncing" | "offline", pending: number}`.
- `Storage` (async): `load(): Promise<{items: Item[]; dirty: string[]; lastSeq: number}>`; `putItem(item: Item): Promise<void>`; `setDirty(ids: string[]): Promise<void>`; `setLastSeq(n: number): Promise<void>`.
- `Sync`: `start(): Promise<void>` (loads storage, notifies, runs one sync); `stack(): Item[]` (non-removed, newest `ts` first); `push(text: string): Promise<Item | null>` (trims, ignores empty, truncates nothing, returns null on empty); `remove(id: string): Promise<void>`; `restore(id: string): Promise<void>`; `syncNow(): Promise<void>`; `status(): Status`.
- Local item `seq` is the last known server `seq` for it, 0 if never sent.

Behaviour: every action updates local items and the dirty set via storage first, calls `onChange`, then tries `syncNow()` without awaiting failures. `syncNow` is single-flight: first PUT each dirty item (clear its dirty flag only on 2xx, and only if the item was not changed again during the request), then `GET /api/items?since=lastSeq`, merge pulled rows into local items except ids currently dirty, update `lastSeq`. A network error or non-2xx sets state `offline` and keeps the dirty set. If the pulled `seq` is lower than `lastSeq`, reset `lastSeq` to 0, mark every local item dirty, and sync again (server was replaced).

- [ ] **Step 1:** Write failing tests with an in-memory `storage` and a fake server implemented as a `fetch` function over the real `createApp` and an in-memory store from Tasks 1 and 2: `push shows on stack immediately`; `push syncs to the server`; `two clients converge after push on A and syncNow on B`; `remove on A disappears from B`; `restore after remove reappears on both`; `concurrent remove on A and restore on B converge to the same state on both after syncing`; `push then remove while offline sends one removed row after reconnect`; `offline push survives a new createSync from the same storage`; `failed PUT keeps the item dirty and status offline`; `status pending equals dirty count`; `server database replaced (new store) triggers full re-send and both clients converge`; `whitespace push returns null and changes nothing`; `stack orders by ts newest first`; `pulled row does not overwrite a locally dirty item`.
- [ ] **Step 2:** Run `bun test web/sync.test.js`; expect failures.
- [ ] **Step 3:** Implement `web/sync.js` as a plain ES module with no browser globals.
- [ ] **Step 4:** Run all tests; expect pass.
- [ ] **Step 5:** Commit.

### Task 4: Browser app

**Files:**
- Create: `web/index.html`, `web/style.css`, `web/app.js`, `web/idb.js`

**Interfaces:**
- Consumes: `createSync` from `web/sync.js`.
- Produces: `idb.js` exports `openStorage(): Promise<Storage>` implementing the Task 3 `Storage` interface over IndexedDB (stores `items`, `meta`).

`app.js` wires the prototype's interface (push form, "Working on" card, "Underneath" list with Drop, 15-second Undo toast, depth count, theme tokens and copy) to `createSync`. Status shows Synced, Syncing, or Offline with the pending count. It opens `EventSource("/api/events")` and calls `syncNow()` on each `seq` event; `EventSource` reconnects itself, and the app also calls `syncNow()` on `visibilitychange` to visible, `online`, and every 60 seconds. Ages refresh every 30 seconds. Port CSS from the prototype and keep the side-gutter and focus styles.

- [ ] **Step 1:** Port the markup, styles and render code from `prototype/index.html`, replacing the artifact `db` calls with `createSync`.
- [ ] **Step 2:** Run `PORT=8099 DATA_DIR=/tmp/ist bun server/main.ts` and open `http://localhost:8099` in Chrome via the chrome-devtools tools. Verify: push, pop, drop and undo work; reload keeps the stack; two tabs update each other live; stopping the server shows Offline, pushes still work, and restarting the server shows them arrive.
- [ ] **Step 3:** Check the console shows no errors, and light and dark themes both render at 400px width.
- [ ] **Step 4:** Commit.

### Task 5: PWA shell

**Files:**
- Create: `web/manifest.webmanifest`, `web/sw.js`, `web/icons/icon-192.png`, `web/icons/icon-512.png`, `web/icons/icon-maskable-512.png`, `web/icons/apple-touch-icon.png` (180px)
- Modify: `web/index.html` (manifest link, `apple-touch-icon`, `theme-color`, `apple-mobile-web-app-capable`, status bar style), `web/app.js` (register the service worker; show a notice when `isSecureContext` is false)

`sw.js` precaches `/`, `/app.js`, `/sync.js`, `/idb.js`, `/style.css`, the manifest and icons, serves them cache-first with a network refresh, and passes everything under `/api/` straight to the network. The cache name carries a version string, and old caches are deleted on activate. Icons are simple generated PNGs (a stack of three bars), made with a script kept in `scripts/make-icons.ts`.

- [ ] **Step 1:** Create the manifest (`name` "Interrupt Stack", `display` `standalone`, `start_url` `/`, theme and background colours from the CSS tokens) and the icons.
- [ ] **Step 2:** Implement `sw.js` and registration.
- [ ] **Step 3:** In Chrome (localhost counts as a secure origin), verify with chrome-devtools: manifest parses with no errors, the service worker is active, and a Lighthouse audit reports the app installable. Stop the server and reload: the app still opens and shows Offline.
- [ ] **Step 4:** Commit.

### Task 6: Container

**Files:**
- Create: `Dockerfile`, `compose.yaml`, `.dockerignore`
- Modify: `README.md`

Dockerfile: Bun base image pinned to a major version, copies `server/` and `web/` only (tests excluded), creates `/data` owned by the non-root `bun` user, `USER bun`, `EXPOSE 9958`, `HEALTHCHECK` calling `/healthz` with `bun -e`, `CMD ["bun", "server/main.ts"]`. `compose.yaml` has one service with `build: .` and no `image:` line (an `image:` pointing at a registry would make "re-pull" deployers try to pull before the image exists; Task 8 adds it only if needed), `restart: unless-stopped`, the named volume and the port mapping from Global Constraints. `README.md` gets run instructions, a "Deploying from git (Dockhand)" section that says to point the stack at `compose.yaml` and set `INTERRUPT_STACK_BIND` and `INTERRUPT_STACK_PORT` as environment variables there, the HTTPS-required note, the no-auth warning, and the iPhone and iPad install steps. The Dockhand section records what its manual (https://dockhand.pro/manual, read 2026-11-17) says: set the compose file path to `compose.yaml` (the default is `docker-compose.yml`), turn on "Build images on deploy" (off by default; adds `--build`), leave "Re-pull images" off, and supply `INTERRUPT_STACK_BIND` and `INTERRUPT_STACK_PORT` as environment overrides (`${VAR:-default}` is supported). Confirmed in the manual: the compose file path is a free-form path field (its examples use `compose.yaml` names), the deploy options are per-stack and its own CI/CD note relies on them applying to webhook redeploys, and variables set in the stack's override panel are available for `${VAR}` interpolation in the compose file, which is how `INTERRUPT_STACK_BIND` and `INTERRUPT_STACK_PORT` reach the port mapping. Dockhand only redeploys when the git commit changed (a manual Deploy always redeploys), so a new commit is what triggers a rebuild. Not shown literally in the manual: a root-level `compose.yaml` and the build option on a webhook-triggered run; both follow from the above and should be checked on first deploy.

- [ ] **Step 1:** Write the files.
- [ ] **Step 2:** Run `docker compose up -d --build`, wait for the container to report healthy, and `curl -s localhost:9958/healthz` prints `ok`.
- [ ] **Step 3:** Push an item through the app, run `docker compose down` then `up -d`; the item is still there (volume persisted).
- [ ] **Step 4:** Check `docker compose exec` shows the process is not root, and that the port binds to 127.0.0.1 only (`ss -ltn`).
- [ ] **Step 5:** Commit and push.

### Task 7: Manual device checklist

**Files:**
- Create: `docs/device-checklist.md`

Write the checklist James runs on real devices, since iOS cannot be tested here: install from Safari on iPhone and iPad via Share then Add to Home Screen; ChromeOS and Windows via the Chrome install button; push on one device and see it on another with no reload; push in airplane mode and see it sync on reconnect; leave the installed app in the background for an hour and confirm it catches up on return; confirm the app opens with the server stopped. Each item has a pass/fail box. Before writing it, check current Safari documentation through Context7 or a web search for install requirements and storage eviction rules, and record what was found and its date at the top.

- [ ] **Step 1:** Research and write the checklist.
- [ ] **Step 2:** Commit and push.

### Task 8 (optional, last): Image publishing

Do this only if Dockhand turns out not to build from the repo, or James asks for it. A build-on-push race is possible here: Dockhand may sync before the new image is published, so a puller could get the previous `latest`.

**Files:**
- Create: `.github/workflows/image.yml`
- Modify: `README.md`, `compose.yaml` (add `image: ghcr.io/jamezpolley/interrupt-stack:latest` beside `build: .`)

On every push to `main`, the workflow runs `bun test`, then builds the Dockerfile and pushes `ghcr.io/jamezpolley/interrupt-stack` tagged `latest` and with the commit SHA, authenticating with `GITHUB_TOKEN` (permissions `contents: read`, `packages: write`). Use official `docker/login-action`, `docker/setup-buildx-action` and `docker/build-push-action`, pinned to major versions. Build for `linux/amd64` only unless the target host is arm; ask before adding more. The README notes that the first published package may be private and must be set to public in the package settings (or Dockhand given a registry credential), and that a git-deploying tool that cannot build should use the `image:` reference.

- [ ] **Step 1:** Write the workflow.
- [ ] **Step 2:** Validate it with `actionlint` if available (through mise) or by reading it against the action docs.
- [ ] **Step 3:** Push to `main` and confirm the run succeeds with `gh run watch`, and `docker pull ghcr.io/jamezpolley/interrupt-stack:latest` works from this machine (after any visibility change).
- [ ] **Step 4:** Commit.

---

## Self-review notes

- Spec coverage: install and offline (Tasks 4, 5), push, pop, drop, undo (Task 4), tombstones and idempotent PUT (Tasks 1, 2), live updates (Tasks 2, 4), sync status (Task 4), container, port and volume (Task 6), no auth documented (Task 6), secure-origin notice (Task 5), device verification (Task 7). Deferred items (timers, notes, history, accounts) have no tasks, as the spec says.
- Interface names are consistent across tasks: `Item`, `ItemInput`, `Store.upsert` and `Store.since`, `createApp`, `createSync`, `Storage`.

## Amendment (2026-11-17)

After deployment James asked for no published host port and no number in `compose.yaml`. Compose now has no `ports:` and no `INTERRUPT_STACK_PORT`/`INTERRUPT_STACK_BIND` variables. The app listens on 9958 inside the container. Where Global Constraints and Task 6 mention a published port or those variables, this amendment supersedes them.
