import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./app";
import { resolveCommit } from "./commit";
import { openStore } from "./store";

const port = Number(process.env.PORT ?? 9958);
const dataDir = process.env.DATA_DIR ?? "/data";
mkdirSync(dataDir, { recursive: true });

// The image build records its commit in build-info.json. Running from a checkout (development), read it from .git.
function buildCommit(): string | null {
  try {
    const info = JSON.parse(readFileSync(resolve(import.meta.dir, "../build-info.json"), "utf8"));
    if (typeof info.commit === "string" && info.commit) return info.commit;
    return null;
  } catch {
    return resolveCommit(resolve(import.meta.dir, "../.git"));
  }
}
const commit = buildCommit();

const store = openStore(join(dataDir, "stack.db"));
const app = createApp(store, { webDir: resolve(import.meta.dir, "../web"), commit });

// idleTimeout 0: the event stream is long-lived and must not be cut by the default idle timer.
const server = Bun.serve({ port, idleTimeout: 0, fetch: app.fetch });
console.log(`interrupt-stack ${commit ? `commit ${commit.slice(0, 12)}` : "commit unknown"} listening on :${server.port}, data in ${dataDir}`);

const shutdown = () => {
  server.stop(true);
  store.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
