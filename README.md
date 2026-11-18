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

API (JSON): `GET /api/items?since=<seq>`, `PUT /api/items/<id>`, `GET /api/events` (event stream), `GET /api/log` (event log, below), `GET /healthz`.

## The event log

The server records every push, pop and restore in an append-only `events` table in the same SQLite database, written in the same transaction as the change to the item, and `GET /api/log` returns it as newline-delimited JSON, oldest first:

```
{"n":1,"ts":"2026-11-18T01:02:03.000Z","at":"2026-11-18T01:01:50.000Z","op":"push","id":"s-lq3x9k2ab","text":"bank rec"}
{"n":2,"ts":"2026-11-18T03:20:11.000Z","at":"2026-11-18T03:19:40.000Z","op":"pop","id":"s-lq3x9k2ab","text":"bank rec"}
```

- `at` is when it happened, by the device's clock. `ts` is when the server heard about it. They differ when a device was offline.
- Resending an item the server already has in the same state adds nothing, so retries and re-syncs do not duplicate events.
- A device only sends an item's latest state. If you push, pop and restore something offline, the server sees the net change, not each step.
- A device time later than the server's clock is clamped to the server's clock (and one before 1970 to 1970), not refused, so a phone with a wrong clock cannot get stuck in a sync error. Its events are only as accurate as its clock.
- Only changes made after this feature shipped are logged. Older items have no history.

Time on a task is the time it was on top of the stack, not push to pop: pushing B over A pauses A. Work that out from the log with a script. For a quick look, the time between each item's push and its (last) pop, in minutes:

```sh
curl -s https://<your-domain>/api/log | jq -s '
  group_by(.id) | map({text: .[0].text,
    minutes: ((map(select(.op=="pop"))|last.at // empty|fromdate) - (.[0].at|fromdate)) / 60})'
```

(Behind SSO, fetch it from a signed-in browser or with your proxy's token.) The log has no authentication of its own, like the rest of the API.

`GET /metrics` serves Prometheus metrics (text exposition format 0.0.4): `interrupt_stack_items{state}`, `interrupt_stack_seq`, `interrupt_stack_event_streams`, `interrupt_stack_start_time_seconds`, and `interrupt_stack_http_requests_total{route,method,code}`. Route labels come from a fixed set, so unknown paths all count as `static`. Like everything else here it has no authentication, so keep it behind the same access control.

## Develop

Needs [Bun](https://bun.sh) (the repo pins it with mise).

```sh
bun test                              # server and sync-core tests
PORT=8099 DATA_DIR=/tmp/ist bun server/main.ts
bun scripts/make-icons.ts             # generate web/icons (not in git; the Docker build runs this)
```

Design and plan: `docs/superpowers/`. `prototype/index.html` is the earlier claude.ai artifact version, kept for reference.
