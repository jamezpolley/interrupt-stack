# Static version design

Status: approved by James in conversation, 2026-11-18 (with the changes below).

## Intent

A version of the app that runs from static hosting (GitHub Pages) with no server. Everything is stored in the
browser, nothing syncs. It is named "Static version" everywhere (not "trial").

## Decisions

- **Relative paths everywhere** for the page, manifest and service worker, so the site works under any path and
  any host (a Pages project site lives under `/<repo>/`). No host name or URL is hardcoded anywhere: moving the
  site later means redeploying, nothing else. The same change is used by the Docker deployment.
- **A build-time switch**, `config.js`, defaulting to server mode (`LOCAL_ONLY = false`). The static build
  overwrites it with `LOCAL_ONLY = true`. In local mode the app makes no sync calls and opens no event stream.
- **The static version still checks for updates.** The build writes `version.json` (`{version, commit}`). The app
  compares its own `version.js` with a fresh fetch of `version.json` (which the service worker never caches), and
  shows the same "new version available" banner. The Refresh icon stays, and its reachability check uses
  `version.json` too.
- **Status text** reads `Local only` where server mode shows Synced/Offline. No other explanatory line.
- **Deployment:** a GitHub Actions workflow builds the site on every push to `main` and publishes it with
  GitHub Pages (source set to GitHub Actions). It runs the tests, generates the icons, and writes the commit
  from `GITHUB_SHA` into `version.js`.

## Non-goals

- No syncing, accounts, export or import in the static version.
- No Docker image building in CI (discussed separately).

## Known caveat

All Pages sites of one GitHub user share one browser origin, so another project on the same host could read this
app's browser storage. Fine for a static version; put nothing sensitive in it.
