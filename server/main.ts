import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "./app";
import { codeVersion } from "./gitver";
import { createUpdateChecker } from "./updatecheck";
import { openStore } from "./store";

const port = Number(process.env.PORT ?? 9958);
const dataDir = process.env.DATA_DIR ?? "/data";
mkdirSync(dataDir, { recursive: true });

// What this code is: read from its own .git (so a self-updated copy reports what it updated to), or from the commit
// the image build recorded when there is no .git.
const codeDir = resolve(import.meta.dir, "..");
const version = codeVersion(codeDir);
const ref = process.env.INTERRUPT_STACK_REF || "main";
const updateChecker = process.env.INTERRUPT_STACK_UPDATE === "off" ? undefined : createUpdateChecker({ codeDir, ref, current: version.commit });

const store = openStore(join(dataDir, "stack.db"));
const app = createApp(store, { webDir: resolve(import.meta.dir, "../web"), commit: version.commit, label: version.label, baseCommit: process.env.INTERRUPT_STACK_BASE_COMMIT, updateChecker, onRestart: process.env.INTERRUPT_STACK_SUPERVISED === "1" ? () => shutdown() : undefined });

// idleTimeout 0: the event stream is long-lived and must not be cut by the default idle timer.
const server = Bun.serve({ port, idleTimeout: 0, fetch: app.fetch });
console.log(
  `interrupt-stack ${version.label ?? "version unknown"}${version.commit ? ` (commit ${version.commit.slice(0, 12)})` : ""} listening on :${server.port}, data in ${dataDir}`,
);

const shutdown = () => {
  server.stop(true);
  store.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
