# interrupt-stack

A push/pop stack of what you're working on. Push a task when you start it; pop it when you're done and see what you were doing before. It's an installable web app (PWA) with a small self-hosted sync server, so the same stack follows you across a laptop, phone and tablet. It works offline and catches up when the connection returns.

## Run it

```sh
docker compose up -d --build
```

The container publishes no port on the host, so nothing is reachable on the host's `localhost`. The app and its API listen on port `9958` inside the container. Put the service on a Docker network that your reverse proxy also uses, and point the proxy at `interrupt-stack:9958`. Data lives in the `interrupt-stack-data` volume (a SQLite file at `/data/stack.db`).

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
- Nothing needs configuring in the stack's environment: the compose file has no variables. Attach the service to your proxy's network (or add your proxy's labels) in a compose override or in `compose.yaml`.
- On a remote host running Hawser from its standard systemd unit, a build needs the unit's `DOCKER_CONFIG` and `RuntimeDirectory` lines (current Hawser installers add them; older installs do not). Without them the build fails with `mkdir /root/.docker: read-only file system`.
- Dockhand only redeploys when the git commit changed (a manual Deploy always redeploys), so a new commit is what triggers a rebuild.

Not covered by the manual: whether a webhook-triggered run applies the build option. Check on your first webhook deploy.

## How it works

- Each stack item is its own record (`id`, `text`, `ts`, `removed`, `seq`), so two devices pushing at once never overwrite each other. Removing an item sets a flag, so the removal reaches your other devices; undo clears it.
- The browser keeps a local copy in IndexedDB and a list of unsent changes. Every action applies locally first, then syncs. The server announces new changes over a server-sent event stream so open devices update live.
- If the server's database is ever replaced, clients notice the sequence number went backwards and re-send what they hold.
- Order comes from each device's clock, as in the original prototype. A badly wrong clock can misorder items.

API (JSON): `GET /api/items?since=<seq>`, `PUT /api/items/<id>`, `GET /api/events` (event stream), `GET /healthz`.

`GET /metrics` serves Prometheus metrics (text exposition format 0.0.4): `interrupt_stack_items{state}`, `interrupt_stack_seq`, `interrupt_stack_event_streams`, `interrupt_stack_start_time_seconds`, and `interrupt_stack_http_requests_total{route,method,code}`. Route labels come from a fixed set, so unknown paths all count as `static`. Like everything else here it has no authentication, so keep it behind the same access control.

## Develop

Needs [Bun](https://bun.sh) (the repo pins it with mise).

```sh
bun test                              # server and sync-core tests
PORT=8099 DATA_DIR=/tmp/ist bun server/main.ts
bun scripts/make-icons.ts             # regenerate web/icons
```

Design and plan: `docs/superpowers/`. `prototype/index.html` is the earlier claude.ai artifact version, kept for reference.
