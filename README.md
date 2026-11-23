# interrupt-stack

A push/pop stack of what you're working on. Push a task when you start it; pop it when you're done and see what you were doing before. It's an installable web app (PWA) with a small self-hosted sync server, so the same stack follows you across a laptop, phone and tablet. It works offline and catches up when the connection returns.

## Run it

```sh
docker compose up -d --build
```

The container publishes no port on the host, so nothing is reachable on the host's `localhost`. The app and its API listen on port `9958` inside the container. The compose file defines a network named `interrupt-stack`. Attach your reverse proxy or agent to it (for example `networks: interrupt-stack: {external: true}` in the agent's compose file, or `docker network connect interrupt-stack <container>`) and point it at `interrupt-stack:9958`. The network is created when this stack is deployed, so deploy this stack before starting anything that references it as external. Data lives in the `interrupt-stack-data` volume (a SQLite file at `/data/stack.db`).

The container has a health check on `/healthz`, so `docker compose ps` shows whether it is healthy.

## Read this before exposing it

- **There is no login.** Anyone who can reach the port can read and change the stack. Put access control in front of it.
- **There is no TLS.** Browsers only install a PWA and run its service worker from an `https://` address (or `localhost`). Put HTTPS in front of it, or installing and offline use will not work. The app shows a notice when it is opened without HTTPS.
- It holds one stack for one person. There are no accounts or sharing.

## Install on your devices

Open the https address once online, then:

- **iPhone / iPad (Safari):** Share, then Add to Home Screen.
- **Windows / ChromeOS (Chrome or Edge):** use the install icon in the address bar, or the menu's Install option.

The app also offers this itself: a small "Install" banner on Chromium browsers, and short Share, Add to Home Screen instructions on iPhone and iPad. It never shows when the app is already installed, and "Not now" hides it for 14 days (remembered in the browser's local storage). Firefox and desktop Safari get nothing. It makes no network calls, so the static version behaves the same.

## Deploying from git with Dockhand

Settings below come from Dockhand's manual (https://dockhand.pro/manual, read 2026-11-17):

- Compose file path: `compose.yaml` (the default is `docker-compose.yml`, so set it).
- Turn on **Build images on deploy**. It is off by default and adds `--build`; the image is built from this repo's `Dockerfile`.
- Leave **Re-pull images** off.
- The only stack variables are the two optional Pangolin ones (see Pangolin labels below). Attach your proxy or agent to the `interrupt-stack` network (see above).
- On a remote host running Hawser from its standard systemd unit, a build needs the unit's `DOCKER_CONFIG` and `RuntimeDirectory` lines (current Hawser installers add them; older installs do not). Without them the build fails with `mkdir /root/.docker: read-only file system`.
- Dockhand only redeploys when the git commit changed (a manual Deploy always redeploys), so a new commit is what triggers a rebuild.

Not covered by the manual: whether a webhook-triggered run applies the build option. Check on your first webhook deploy.

## Static version (GitHub Pages)

The same app can run with no server at all, from any static host. In the static version everything is stored in the browser and nothing syncs, and the status reads **Local only**. It still checks for updates and offers the same Refresh and update banner, using a `version.json` the build writes beside the app.

- `bun scripts/build-static.ts [output dir]` builds it (default `_site/`; run `bun scripts/make-icons.ts` first for the icons). It switches `config.js` to `LOCAL_ONLY = true` and writes `version.js` and `version.json`. The commit comes from `GITHUB_SHA`, or from the checkout's `.git`.
- `.github/workflows/static-version.yml` runs the tests, builds it and publishes it with GitHub Pages on every push to `main`. In the repository settings, Pages must use the **GitHub Actions** source.
- Every URL in the page, manifest and service worker is relative, so it works under any path on any host. Nothing in the code names the host: if the site moves, redeploy it.
- All Pages sites of one GitHub user share a browser origin, so another project on the same host could read this app's browser storage. Put nothing sensitive in it.

## Which version is running, and updating from GitHub

The first line of the container log says what the code is:

```
interrupt-stack v1.2.0-3-g5a7581b (commit 5a7581b3c9d1) listening on :9958, data in /data
```

The label is the nearest git tag (`v1.2.0`), the tag plus how far past it (`v1.2.0-3-g5a7581b`), or just the short commit when there are no tags. The same label shows in small grey text under the heading in the app (for the copy of the app that device is running, so a device that has not refreshed yet shows its older label), and `GET /api/version` returns it with the full commit. If nothing can tell (an image built from a folder with no `.git`), it says `version unknown`. When the server has updated itself past the commit its image was built from, the line also shows that commit, for example `v1.2.0-3-g5a7581b · image 3a4ff67`, so you can tell the image has fallen behind and a rebuild would catch it up; `GET /api/version` returns it as `base`. It is left out when they are the same or the image's commit is unknown.

### Baking in a clone, and updating at start

By default the image is built from the files in this repository, as before, and only knows its commit if the build context had a `.git` (Dockhand's does not). Two settings, as stack variables or in a `.env` file, change that:

| Variable | Meaning |
|---|---|
| `INTERRUPT_STACK_REPO` | The clone URL, for example `https://github.com/<owner>/interrupt-stack.git`. Public repositories only. Setting it makes the build clone that repository with its `.git` (and tags) into the image. Nothing in the code names a host; this is the only place it is set. |
| `INTERRUPT_STACK_REF` | The branch or tag to follow. Default `main`. |
| `INTERRUPT_STACK_UPDATE` | `off` to never consult GitHub: the code in the image runs as it is. Default `on`. |

With the repository set, the container does this every time it starts:

1. Copies the code in the image to a writable folder and fetches `INTERRUPT_STACK_REF` from GitHub (20 second limit).
2. If that works, moves the copy to that commit, regenerates the icons, and starts the server from it.
3. If any step fails (GitHub unreachable, ref not found, bad checkout), it starts the code that is in the image.
4. After starting updated code it waits up to 30 seconds for `/healthz`. If the server crashes or does not answer, it is stopped, the code in the image is started instead, and that commit is written to `update-quarantine.json` in the data folder so it is not tried again on every restart. A different commit on the ref is tried normally.

Only the entrypoint (`server/entrypoint.ts`) always comes from the image; everything else can be the updated code. Limits: a crash after the 30 second window is an ordinary container restart (and could repeat); falling back runs older code against a database newer code may have changed, which is safe for additive changes; and whatever is on the ref on GitHub is what runs, so anyone who can push there controls the server.

When the server starts without a repository set, it does not touch the network. With one set, the page's Refresh button also asks the server to look at GitHub in the background (at most once a minute, and it never delays the refresh; after the reload the page looks for the answer a few times over the next ten seconds). If the ref has moved past what is running, a note appears: "GitHub's main is now at abc1234. Redeploy or restart to apply." Restarting the container applies it, because the update happens at start. When the server is running under the container's entrypoint (so something will start it again after it exits), the note also has an **Update now** button: it asks the server to restart, waits for it to come back, and refreshes the page onto the new code. Your compose file needs `restart: unless-stopped` (this one has it) so the container comes back. If the new code fails to start, the container comes back on the code in the image (not on the previous update), the note says the server is still on the old version, and the page is not refreshed.

If your deployment tool builds from a checkout that has no `.git`, setting `INTERRUPT_STACK_REPO` is how the server gets a version.

## Pangolin labels

`compose.yaml` carries `pangolin.public-resources.interrupt-stack.*` labels. Two values come from the stack's environment; leave them unset if you do not use Pangolin:

```
INTERRUPT_STACK_DOMAIN=interrupts.example.com
INTERRUPT_STACK_POLICY=your-policy-name
```

Enter the values as plain text, with nothing after them. In Dockhand's variables panel a trailing `# comment` becomes part of the value and ends up in the label. The target is `interrupt-stack:9958` on the `interrupt-stack` network, with a health check on `/healthz`.

## How it works

- Each stack item is its own record (`id`, `text`, `ts`, `at`, `removed`, `seq`, and an optional `origin`), so two devices pushing at once never overwrite each other. Removing an item sets a flag, so the removal reaches your other devices; undo clears it.
- The browser keeps a local copy in IndexedDB and a list of unsent changes. Every action applies locally first, then syncs. The server announces new changes over a server-sent event stream so open devices update live.
- If the server's database is ever replaced, clients notice (each database has an epoch ID, and sequence numbers going backwards also counts) and re-send everything they hold.
- The live-update stream reconnects with a backoff if a proxy answers a reconnect with an error, such as a 502 during a restart.
- Order comes from each device's clock, as in the original prototype. A badly wrong clock can misorder items.
- Conflicts resolve by arrival: the last change the server receives for an item wins, not the change made last. If a device was offline when it removed an item and reconnects after another device restored it, the older removal wins. Both devices then show the same thing.
- A change the server refuses (a 4xx response) stays on the device and shows as "Sync problem" without blocking other changes. If the device's own storage fails, it says so and keeps working from memory.

API (JSON): `POST /api/sync` (the one sync call, below), `GET /api/events` (event stream; `sync` carries the shared counter), `GET /api/version`, `GET /healthz`. Kept so that copies of the app cached before the shared channel keep working, and not used by the current app: `GET /api/items?since=<seq>`, `PUT /api/items/<id>`, `GET /api/queue?since=<seq>`, `PUT /api/queue/<id>`, and the `seq` / `qseq` stream events.

### One sync channel

Every synced table (the stack, Later, and whatever comes next) shares one channel. A device sends its last cursor and its pending changes, `{epoch, cursor, changes: {items: {id: row}, queue: {id: row}}}`, to `POST /api/sync`; the server applies them (each through the same checks, event logging and time clamping as before) and answers with every row changed since the cursor, plus what it stored and what it refused, per table. One counter, shared by all tables, numbers every change; one `sync` stream event announces it. A change the server refuses is reported per row, so it never blocks the others. The client sends at most 100 changes per request. See `docs/superpowers/specs/2026-11-21-one-sync-channel-design.md` for the contract and the reasoning. To add a table: add it to `SYNCED_TABLES` and the registry in `server/store.ts`, and call `hub.table(...)` on the client (`web/core.js`).

## & Pop, and Done today

- **& Pop** is a second segment attached to **Push**. Push is the default (Enter pushes); "& Pop" takes a deliberate tap. It pushes what you typed and takes the item that was on top off the stack, as one change: the screen never shows the empty stack in between, and offline both changes are kept and sent together. With nothing typed it does nothing (it never pops without pushing); with an empty stack it is disabled. The usual Undo appears for the item it removed.
- **Done today** lists everything taken off the stack since local midnight on that device, newest first, greyed out, with the time. It rolls over at midnight. Popped items and items removed with **Drop** (the button on each item underneath the top one) both appear, because the app records only that an item was removed. Items removed before this version existed show under the day they were pushed. Tapping a finished row opens its details, which has a **Push again** button: it pushes a new item with the same text (the finished one stays in Done today) and records the finished item's id as the new one's `origin`. `origin` is set once, when the item is created; a write that leaves it out never clears it, so older cached copies of the app are safe.

### Editing a finished item

**Edit** in a finished item's details changes its title and the times of the rows (a row about another item changes that item's time). Times are 24-hour `HH:MM` or `HH:MM:SS`; leave the seconds out and the original seconds stay. The totals recompute as you type, and **Save** is disabled while a time is in the future, an end comes before its start, or the title is empty. Items still on the stack cannot be edited. An edited item gets a small "edited" mark in Done today and in the details (also when an item pushed above it was edited, since that moves its numbers).

An edit is sent as a write marked `edit: true`. Without the mark the server keeps an existing item's stored text and push time, so a device holding an older copy cannot undo an edit by sending its state again. Each edit sets the item's `edited_at` and appends an `edit` event whose `detail` holds the old and new values; the original push and pop events are left as they were, so anything reading the log must apply `edit` events over them. If two devices edit the same item, the later write wins.

## Queue (shown as "Later")

A pile of things to do later, in no particular order (not a line: nothing about it means "next"). The newest addition shows on top. On screen it is labelled **Later**; that label is one constant (`QUEUE_LABEL` in `web/queue.js`).

- **A separate structure from the stack.** Its own table (`queue`) and IndexedDB database (`interrupt-stack-queue`), but the same sync channel as the stack (one request, one counter, one status). `/api/items`, `/api/queue` and the `seq` / `qseq` stream events are kept as they were for copies of the app cached earlier, and `/api/items` still contains no queue items.
- **Layout.** Wide screens (700px and up) show two columns, Stack on the left and Later on the right. On a phone they are side-by-side panes: swipe sideways, or tap the "Later 3 ›" tab (Stack side) and "‹ Stack" tab (Later side). Done today stays under the stack. Both panes are reachable by keyboard (focusing a control in the other pane scrolls it into view).
- **Its own input.** The Later pane has its own text box and **Add** button (Enter adds). The **Push / & Pop** control is unchanged.
- **Start and Drop.** Each row has **Start**, which puts it on top of the stack, and **Drop**, which removes it (with the usual Undo, which puts it back in the queue). Start has no Undo.
- **Start is two writes in two structures, made safe to repeat.** (1) Push onto the stack under a derived id: the queue id `q-<x>` becomes the stack id `s-<x>`, and if that id already exists (even popped since) nothing is pushed again. (2) Tombstone the queue row, marked `started`. Step 1 is saved on the device before step 2 begins, and whenever the app next runs, any live queue row whose stack twin exists is tombstoned. So a crash or flaky network between the two cannot duplicate the task, and two devices starting the same row converge on one stack item. Dropped rows never touch the stack, so they never appear in Done today; started-then-popped ones appear as normal stack items.
- **Events.** The same `events` table records `queue` (added), `dequeue` (dropped), `requeue` (drop undone) and `start` (started) for the `q-` id, in the same transaction as the change. A start also logs the stack item's `push` (id `s-<x>`), so the two join on the id suffix. No analysis yet.
- **Metrics.** `interrupt_stack_items{state="live"}` still counts the stack only. The queue has `interrupt_stack_queue_items{state="queued"|"removed"}`.
- **Static version.** Works the same, entirely in the browser, with no network calls.

## Notes

A short text entry (not empty, up to 200 characters) that never touches the stack and goes straight into **Done today**. The **+ Note** button on the Done today heading opens a text box: Enter or **Add** saves, Escape cancels. The time is always now.

- **A separate table.** `notes` (ids `n-<x>`) on the same sync channel (`SYNCED_TABLES` entry plus `hub.table("notes", ...)`), last write wins, with tombstones (`removed`). It has its own IndexedDB database (`interrupt-stack-notes`). Notes are not counted in stack depth, the `live` metric, the timeline or time on top, and are never pushed or popped.
- **Events.** One `note` event when a note is created (its text, dated at the note's time). An edit logs an `edit` event with `detail` (`{text?, ts?}` from/to) and sets `edited_at`, the same way item edits do, and is sent with `edit: true` so a stale copy cannot undo it. Removing logs nothing.
- **Row.** One time (in the Ended column), a dash for the duration, a quiet "note" label. The row is a button like any Done today row, so links in the text are plain text there and are clickable in the panel that opens.
- **Edit.** Tapping a note opens a small panel with its text and its time (24-hour `HH:MM` or `HH:MM:SS`, on the note's own day; the day buttons can be added once they are merged). No timeline, no Push again.
- **Static version.** Notes live in the browser only.

## Deleting an entry

A **Delete** button removes an entry as if it had never existed: on the Working-on card and on each row underneath (next to Pop/Drop), and in the details of a finished entry and of a note. The usual 15 second Undo toast follows; there is no confirm. A deleted item is not on the stack, not in Done today, not in anyone's timeline or time on top (an item pushed above another and then deleted adds nothing to it), and not counted in depth or the `live` metric. Later rows keep their own Drop.

- **Items** carry a `deleted` flag, synced like any change. A write that leaves `deleted` out never clears it (an older client or a stale copy cannot bring an item back); only an explicit `deleted: false` (Undo) does. An older cached client just sees a deleted item as an ordinary one.
- **Notes** are deleted by their tombstone (`removed`).
- **Events** stay append-only: nothing is erased. Deleting logs `delete` (at the time of deletion), Undo logs `undelete`.

## Copy data (Debug panel)

The Debug panel opens from the status button after a failed sync, or from the quiet **Debug** button beside the version line (so it is there offline and in the static version too). **Copy data** copies one JSON document: when it was made (local time with offset), the version label, the mode (`server` or `static`), the raw rows of the stack, Later and notes databases exactly as stored (millisecond timestamps) with each database's pending ids, cursor and epoch, and the latest failed sync call if there is one. It reads only the app's own databases. If the browser refuses the clipboard, the JSON is shown in a text box to select and copy by hand. The document is built by `web/debug-data.js`.

## Updating the app on your devices

Devices keep a cached copy of the app so it opens instantly and offline, and they refresh it in the background, so a new release normally appears on the second load. Two things speed that up:

- **Update banner.** The server hashes the web files it ships (`GET /api/version`) and every copy of the app records the version it was built from (`/version.js`, cached with the app). A device checks when it opens, when it comes back online, and once a minute. If the two differ it shows "A new version of the app is available" with a **Refresh app** button. If the server cannot be reached, or answers with a sign-in redirect, it says nothing.
- **Refresh app** (also a small circular-arrow icon beside the sync status at the top of the page). It checks the server answers, then clears the cached app files and the service worker and reloads. If the server cannot be reached it changes nothing and says so, because clearing the cache while offline would leave an app that cannot open. Your stack is stored separately and is never touched.

The version covers only the web files, so a server-only change does not raise the banner. It is computed when the server starts.

## The event log

The server records every push, pop and restore (and the queue operations, see Queue) in an append-only `events` table in the same SQLite database (`/data/stack.db`), written in the same transaction as the change to the item. Columns: `n`, `ts` (when the server recorded it), `at` (when it happened, by the device's clock; both in ms since the epoch), `op`, `id`, `text`. Nothing reads it back yet.

- Resending an item the server already has in the same state adds nothing.
- A device only sends an item's latest state, so a push, pop and restore done offline between syncs shows up as the net change.
- A device time later than the server's clock is clamped to it (and one before 1970 to 1970), not refused, so a phone with a wrong clock cannot get stuck in a sync error.
- Whichever change reaches the server last wins, so a device resending an older state, such as a retry after a lost response, can log a `restore` for an item another device popped. Its time is never earlier than the item's previous event.
- Only changes made after this feature shipped are logged.

## Develop

Needs [Bun](https://bun.sh) (the repo pins it with mise).

```sh
bun test                              # server and sync-core tests
PORT=8099 DATA_DIR=/tmp/ist bun server/main.ts
bun scripts/make-icons.ts             # generate web/icons (not in git; the Docker build runs this)
```

Design and plan: `docs/superpowers/`. `prototype/index.html` is the earlier claude.ai artifact version, kept for reference.
