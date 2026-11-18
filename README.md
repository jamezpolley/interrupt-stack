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

The label is the nearest git tag (`v1.2.0`), the tag plus how far past it (`v1.2.0-3-g5a7581b`), or just the short commit when there are no tags. The same label shows in small grey text under the heading in the app (for the copy of the app that device is running, so a device that has not refreshed yet shows its older label), and `GET /api/version` returns it with the full commit. If nothing can tell (an image built from a folder with no `.git`), it says `version unknown`.

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

When the server starts without a repository set, it does not touch the network. With one set, the page's Refresh button also asks the server to look at GitHub in the background (at most once a minute, and it never delays the refresh). If the ref has moved past what is running, a note appears: "GitHub's main is now at abc1234. Redeploy or restart to apply." Restarting the container applies it, because the update happens at start.

If your deployment tool builds from a checkout that has no `.git`, setting `INTERRUPT_STACK_REPO` is how the server gets a version.

## Pangolin labels

`compose.yaml` carries `pangolin.public-resources.interrupt-stack.*` labels. Two values come from the stack's environment; leave them unset if you do not use Pangolin:

```
INTERRUPT_STACK_DOMAIN=interrupts.example.com
INTERRUPT_STACK_POLICY=your-policy-name
```

Enter the values as plain text, with nothing after them. In Dockhand's variables panel a trailing `# comment` becomes part of the value and ends up in the label. The target is `interrupt-stack:9958` on the `interrupt-stack` network, with a health check on `/healthz`.

## How it works

- Each stack item is its own record (`id`, `text`, `ts`, `at`, `removed`, `seq`), so two devices pushing at once never overwrite each other. Removing an item sets a flag, so the removal reaches your other devices; undo clears it.
- The browser keeps a local copy in IndexedDB and a list of unsent changes. Every action applies locally first, then syncs. The server announces new changes over a server-sent event stream so open devices update live.
- If the server's database is ever replaced, clients notice (each database has an epoch ID, and sequence numbers going backwards also counts) and re-send everything they hold.
- The live-update stream reconnects with a backoff if a proxy answers a reconnect with an error, such as a 502 during a restart.
- Order comes from each device's clock, as in the original prototype. A badly wrong clock can misorder items.
- Conflicts resolve by arrival: the last change the server receives for an item wins, not the change made last. If a device was offline when it removed an item and reconnects after another device restored it, the older removal wins. Both devices then show the same thing.
- A change the server refuses (a 4xx response) stays on the device and shows as "Sync problem" without blocking other changes. If the device's own storage fails, it says so and keeps working from memory.

API (JSON): `GET /api/items?since=<seq>`, `PUT /api/items/<id>`, `GET /api/events` (event stream), `GET /api/version`, `GET /healthz`.

## & Pop, and Done today

- **& Pop** is a second segment attached to **Push**. Push is the default (Enter pushes); "& Pop" takes a deliberate tap. It pushes what you typed and takes the item that was on top off the stack, as one change: the screen never shows the empty stack in between, and offline both changes are kept and sent together. With nothing typed it does nothing (it never pops without pushing); with an empty stack it is disabled. The usual Undo appears for the item it removed.
- **Done today** lists everything taken off the stack since local midnight on that device, newest first, greyed out, with the time. It rolls over at midnight. Popped items and items removed with **Drop** (the button on each item underneath the top one) both appear, because the app records only that an item was removed. Items removed before this version existed show under the day they were pushed.

## Updating the app on your devices

Devices keep a cached copy of the app so it opens instantly and offline, and they refresh it in the background, so a new release normally appears on the second load. Two things speed that up:

- **Update banner.** The server hashes the web files it ships (`GET /api/version`) and every copy of the app records the version it was built from (`/version.js`, cached with the app). A device checks when it opens, when it comes back online, and once a minute. If the two differ it shows "A new version of the app is available" with a **Refresh app** button. If the server cannot be reached, or answers with a sign-in redirect, it says nothing.
- **Refresh app** (also a small circular-arrow icon beside the sync status at the top of the page). It checks the server answers, then clears the cached app files and the service worker and reloads. If the server cannot be reached it changes nothing and says so, because clearing the cache while offline would leave an app that cannot open. Your stack is stored separately and is never touched.

The version covers only the web files, so a server-only change does not raise the banner. It is computed when the server starts.

## The event log

The server records every push, pop and restore in an append-only `events` table in the same SQLite database (`/data/stack.db`), written in the same transaction as the change to the item. Columns: `n`, `ts` (when the server recorded it), `at` (when it happened, by the device's clock; both in ms since the epoch), `op`, `id`, `text`. Nothing reads it back yet.

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
