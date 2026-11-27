# interrupt-stack

> **Note:** As the commit history shows, this entire project is AI slop. Do not assume it is useful for anything.

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

- Everything you do is an **action** in an append-only log (a push, a pop, a drop, a correction, a delete, an undo ...), each with two times: `ts`, when the server received it, and `at`, when you say it happened. Neither is ever changed. What you see (the stack, Done today, Later, notes) is derived from the log by one shared reducer (`web/reduce.js`), on the server and in the browser alike, so two devices acting at once never overwrite each other. The design and its reasoning are in `docs/superpowers/specs/2026-11-23-data-model-design.md`.
- The browser keeps its own journal of actions in IndexedDB (`interrupt-stack-journal`), with the ones the server has not acknowledged marked unsent. Every action applies locally first, then syncs, one action at a time, so several changes made offline reach the server as they were made. The server announces new changes over a server-sent event stream so open devices update live.
- If the server's database is ever replaced, clients notice (each database has an epoch ID, and the log's numbering going backwards also counts) and re-send their whole journal, which rebuilds it.
- The live-update stream reconnects with a backoff if a proxy answers a reconnect with an error, such as a 502 during a restart.
- Order on the stack comes from the time you said each push happened (`at`), clamped so it is never later than when the server received it. A badly wrong device clock cannot put a push in the future, and a pop reported before its push reads as a zero-length stay.
- The log is applied in the order the server received it, so every device ends up showing the same thing. An undo is an action that cancels a named earlier action (a `void`), so nothing is ever erased.
- An action the server refuses is reported by its id, dropped from the journal, and shown as "Sync problem" without blocking the others. If the device's own storage fails, it says so and keeps working from memory.

API (JSON): `POST /api/sync` (the one sync call, below), `GET /api/state?from=<ms>&to=<ms>` (the stack, Later, what ended in the window, the notes in it, and the stays that overlap them), `GET /api/day?from=<ms>&to=<ms>` (the same for one day, plus what was pushed in it), `GET /api/items/<id>/history` (every action that touched an item, oldest first, with both times), `GET /api/events` (event stream; `sync` carries the log's counter), `GET /api/version`, `GET /healthz`. The window is the client's (`from` inclusive, `to` exclusive, milliseconds), so the server needs no time zone. One stay on the stack is one row (`id`, or `<id>~1` for a second stay of the same item).

### One sync channel

A device sends its last cursor and the actions it has not sent, `{epoch, cursor, actions: [{id, at, kind, target, ref?, data?}]}`, to `POST /api/sync`; the server checks each one, stamps it with its own clock, ignores an id it already holds (a resend), and answers with every action above the cursor (the device's own included, now stamped), plus what it refused. A copy of the app cached from before the actions log sends rows instead; it is told to reload. The `sync` stream event announces that the log's counter moved. The client sends at most 100 actions per request. The kinds are `push`, `push-again`, `pop`, `drop`, `edit`, `void`, `delete`, `undelete` (the stack), `note` (notes) and `later`, `dequeue`, `requeue`, `start` (Later); a kind the reducer does not know is ignored, so a new kind needs no migration.

## Swap, and Done today

- **Swap** is a second segment attached to **Push**. Push is the default (Enter pushes); "Swap" takes a deliberate tap. It pushes what you typed and takes the item that was on top off the stack, as one change: the screen never shows the empty stack in between, and offline both changes are kept and sent together. With nothing typed it does nothing (it never pops without pushing); with an empty stack it is disabled. The usual Undo appears for the item it removed, underneath the Working-on card and above the rest of the stack, so the text box does not move.
- **Done today** lists everything taken off the stack since local midnight on that device, newest first, greyed out, with the time. It rolls over at midnight. Popped items and items removed with **Drop** (the button on each item underneath the top one) both appear, because the app records only that an item was removed. Items removed before this version existed show under the day they were pushed. Tapping a finished row opens its details, which has a **Push again** button: it puts the same item back on the stack as a new stay (the finished stay remains in Done today).

### Editing an item

**Edit** in an item's details changes its title and the times of its own push and end rows (an item still on the stack has only a push row). The "Paused" and "Back on top" rows are about other items, so they show the time but cannot be edited here; open that item to change it. In the details, **Close** is the highlighted default button (Push again, Edit and Delete are plain); once editing starts, Save is. Times are 24-hour `HH:MM` or `HH:MM:SS`; leave the seconds out and the original seconds stay. The totals recompute as you type, and **Save** is disabled while a time is in the future, an end comes before its start, or the title is empty. An edited item gets a small "edited" mark in Done today and in the details (also when an item pushed above it was edited, since that moves its numbers).

An edit is an `edit` action; a changed time points at the push or pop it corrects, which stays in the log as it was. If two devices edit the same thing, the later edit wins.

## Queue (shown as "Later")

A pile of things to do later, in no particular order (not a line: nothing about it means "next"). The newest addition shows on top. On screen it is labelled **Later**; that label is one constant (`QUEUE_LABEL` in `web/queue.js`).

- **A separate structure from the stack.** Targets with ids `q-<x>` and their own kinds of action (`later`, `dequeue`, `requeue`, `start`), but the same journal and sync channel as the stack (one request, one counter, one status). Later rows never appear on the stack.
- **Layout.** Wide screens (700px and up) show two columns, Stack on the left and Later on the right. On a phone they are side-by-side panes: swipe sideways, or tap the "Later 3 ›" tab (Stack side) and "‹ Stack" tab (Later side). Done today stays under the stack. Both panes are reachable by keyboard (focusing a control in the other pane scrolls it into view).
- **Its own input.** The Later pane has its own text box and **Add** button (Enter adds). The **Push / Swap** control is unchanged.
- **Start and Drop.** Each row has **Start**, which puts it on top of the stack, and **Drop**, which removes it (with the usual Undo, which puts it back in the queue). Start has no Undo.
- **Start is two actions, made safe to repeat.** (1) Push onto the stack under a derived id: the queue id `q-<x>` becomes the stack id `s-<x>`, and if that id already exists (even popped since) nothing is pushed again. (2) A `start` action on the queue row. Step 1 is saved on the device before step 2 begins, and whenever the app next runs, any live queue row whose stack twin exists is tombstoned. So a crash or flaky network between the two cannot duplicate the task, and two devices starting the same row converge on one stack item. Dropped rows never touch the stack, so they never appear in Done today; started-then-popped ones appear as normal stack items.
- **In the log.** `later`, `dequeue`, `requeue` and `start` actions on the `q-` id. A start also logs the stack item's `push` (id `s-<x>`), so the two join on the id suffix.
- **Metrics.** `interrupt_stack_items{state="live"}` still counts the stack only. The queue has `interrupt_stack_queue_items{state="queued"|"removed"}`.
- **Static version.** Works the same, entirely in the browser, with no network calls.

## Notes

A short text entry (not empty, up to 200 characters) that never touches the stack and goes straight into **Done today**. The **+ Note** button on the Done today heading opens a text box: Enter or **Add** saves, Escape cancels. The time is always now.

- **Its own targets.** Notes (ids `n-<x>`) are `note` actions on the same journal and sync channel; deleting is a `delete` action and undo an `undelete`. Notes are not counted in stack depth, the `live` metric, the timeline or time on top, and are never pushed or popped.
- **In the log.** A `note` action (its text, dated at the note's time); a correction of the text or the time is an `edit` action that points at what it corrects, so the original stays.
- **Row.** One time (in the Ended column), a dash for the duration, a quiet "note" label. The row is a button like any Done today row, so links in the text are plain text there and are clickable in the panel that opens.
- **Edit.** Tapping a note opens a small panel with its text and its time (24-hour `HH:MM` or `HH:MM:SS`, on the note's own day, with buttons to move it a day earlier or later). No timeline, no Push again.
- **Static version.** Notes live in the browser only.

## Deleting an entry

A **Delete** button removes an entry as if it had never existed. It lives in the details card: of a finished entry, of a note, and of an item still on the stack (the **Details** button on the Working-on card and on each row underneath opens it; there it shows when the item was pushed, lets you change its title and push time, and offers Delete; there is no Push again). The usual 15 second Undo toast follows; there is no confirm. A deleted item is not on the stack, not in Done today, not in anyone's timeline or time on top (an item pushed above another and then deleted adds nothing to it), and not counted in depth or the `live` metric. Later rows keep their own Drop.

- **Items** are deleted by a `delete` action and brought back by an `undelete`. Nothing is erased: both stay in the log, and `GET /api/items/<id>/history` shows them.
- **Notes** the same way.

## Copy data (Debug panel)

The Debug panel opens from the status button after a failed sync, or from the quiet **Debug** button beside the version line (so it is there offline and in the static version too). **Copy data** copies one JSON document: when it was made (local time with offset), the version label, the mode (`server` or `static`), the raw rows of the stack, Later and notes databases exactly as stored (millisecond timestamps) with each database's pending ids, cursor and epoch, and the latest failed sync call if there is one. It reads only the app's own databases. If the browser refuses the clipboard, the JSON is shown in a text box to select and copy by hand. The document is built by `web/debug-data.js`.

## Updating the app on your devices

Devices keep a cached copy of the app so it opens instantly and offline, and they refresh it in the background, so a new release normally appears on the second load. Two things speed that up:

- **Update banner.** The server hashes the web files it ships (`GET /api/version`) and every copy of the app records the version it was built from (`/version.js`, cached with the app). A device checks when it opens, when it comes back online, and once a minute. If the two differ it shows "A new version of the app is available" with a **Refresh app** button. If the server cannot be reached, or answers with a sign-in redirect, it says nothing.
- **Refresh app** (also a small circular-arrow icon beside the sync status at the top of the page). It checks the server answers, then clears the cached app files and the service worker and reloads. If the server cannot be reached it changes nothing and says so, because clearing the cache while offline would leave an app that cannot open. Your stack is stored separately and is never touched.

The version covers only the web files, so a server-only change does not raise the banner. It is computed when the server starts.

## The log

The server keeps every action in an append-only `actions` table in the same SQLite database (`/data/stack.db`). Columns: `n` (the order the server received them, and the cursor of the sync wire), `id` (made by the device, so a resend is recognised), `ts` (the server's clock when it received it), `at` (when the person says it happened, never later than `ts`), `kind`, `target` (the item, note or Later row), `ref` (the earlier action a correction or undo points at), `data` (JSON: the text, a corrected time ...) and `origin`.

- Neither `ts` nor `at` ever changes. A correction is a new `edit` action with a `ref`; the effective time is the latest correction, and the original stays.
- A resend of an action the server already has adds nothing.
- A time later than the server's clock is clamped to it, not refused, so a phone with a wrong clock cannot get stuck in a sync error; an edit more than five minutes ahead is refused.
- A pop reported before its push (clock skew, a push-then-pop within a second) is stored as sent and read as a zero-length stay.
- The older `items`, `queue`, `notes` and `events` tables are no longer written. They are kept as they were, as the record of before the actions log; the first start of this version converts what they hold into actions (once, after copying the database to `stack.db.pre-actions`), marking rows from before the event log as guesses.

## Develop

Needs [Bun](https://bun.sh) (the repo pins it with mise).

```sh
bun test                              # server and sync-core tests
PORT=8099 DATA_DIR=/tmp/ist bun server/main.ts
bun scripts/make-icons.ts             # generate web/icons (not in git; the Docker build runs this)
```

Design and plan: `docs/superpowers/`. `prototype/index.html` is the earlier claude.ai artifact version, kept for reference.
