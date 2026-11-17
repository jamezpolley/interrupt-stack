import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./app";
import { openStore } from "./store";

const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.DATA_DIR ?? "/data";
mkdirSync(dataDir, { recursive: true });

const store = openStore(join(dataDir, "stack.db"));
const app = createApp(store, { webDir: resolve(import.meta.dir, "../web") });

// idleTimeout 0: the event stream is long-lived and must not be cut by the default idle timer.
const server = Bun.serve({ port, idleTimeout: 0, fetch: app.fetch });
console.log(`interrupt-stack listening on :${server.port}, data in ${dataDir}`);

const shutdown = () => {
  server.stop(true);
  store.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
