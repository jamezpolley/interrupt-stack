import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeVersion } from "./gitver";

// Startup self-update. The image holds a baked copy of the code with its .git. At start we try to move to the newest
// commit of a branch or tag from GitHub, in a writable copy; if anything fails we run the baked code. After starting
// updated code we wait for /healthz, and if it does not come up we fall back and remember the commit as bad.

type Git = { ok: boolean; out: string; err: string };
const git = (cwd: string, args: string[], timeoutMs = 20_000): Git => {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  } catch (e) {
    return { ok: false, out: "", err: String(e) };
  }
};

const quarantineFile = (dataDir: string) => join(dataDir, "update-quarantine.json");
export function readQuarantine(dataDir: string): string[] {
  try {
    const list = JSON.parse(readFileSync(quarantineFile(dataDir), "utf8"));
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function addQuarantine(dataDir: string, commit: string) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(quarantineFile(dataDir), JSON.stringify([...new Set([...readQuarantine(dataDir), commit])]) + "\n");
  } catch {} // not being able to remember must never stop the app starting
}

export type Prepared = { dir: string; updated: boolean; commit: string | null; reason: string };
export type PrepareConfig = { bakedDir: string; liveDir: string; dataDir: string; ref: string; fetchTimeoutMs?: number };

export async function prepareLiveCopy(cfg: PrepareConfig): Promise<Prepared> {
  const baked = (reason: string, commit: string | null = null): Prepared => ({ dir: cfg.bakedDir, updated: false, commit, reason });
  if (!existsSync(join(cfg.bakedDir, ".git"))) return baked("no git checkout in the image");
  const bakedCommit = git(cfg.bakedDir, ["rev-parse", "HEAD"]).out || null;
  if (!git(cfg.bakedDir, ["remote", "get-url", "origin"]).ok) return baked("the checkout has no origin remote", bakedCommit);

  // Work in a copy: the image's own code is never touched, so it is always there to fall back to.
  rmSync(cfg.liveDir, { recursive: true, force: true });
  try {
    cpSync(cfg.bakedDir, cfg.liveDir, { recursive: true });
  } catch (e) {
    return baked(`could not copy the code: ${e}`, bakedCommit);
  }
  const abandon = (reason: string) => {
    rmSync(cfg.liveDir, { recursive: true, force: true });
    return baked(reason, bakedCommit);
  };

  const shallow = existsSync(join(cfg.liveDir, ".git", "shallow"));
  const fetched = git(
    cfg.liveDir,
    ["fetch", "--force", "--tags", "--prune", ...(shallow ? ["--unshallow"] : []), "origin", "+refs/heads/*:refs/remotes/origin/*"],
    cfg.fetchTimeoutMs ?? 20_000,
  );
  if (!fetched.ok) return abandon(`fetch failed: ${fetched.err.split("\n").pop()}`);

  let target: string | null = null;
  for (const candidate of [`refs/remotes/origin/${cfg.ref}`, `refs/tags/${cfg.ref}`]) {
    const r = git(cfg.liveDir, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
    if (r.ok && r.out) {
      target = r.out;
      break;
    }
  }
  if (!target) return abandon(`ref "${cfg.ref}" not found on origin`);
  if (target === bakedCommit) return abandon("the image is already at that commit");
  if (readQuarantine(cfg.dataDir).includes(target)) return abandon(`commit ${target.slice(0, 7)} failed to start before`);

  if (!git(cfg.liveDir, ["checkout", "--force", "--detach", target]).ok) return abandon("checkout failed");

  // Icons are generated at image build and are not in git, so the updated copy needs them made again.
  if (existsSync(join(cfg.liveDir, "scripts", "make-icons.ts"))) {
    const r = Bun.spawnSync(["bun", "scripts/make-icons.ts"], { cwd: cfg.liveDir, stdout: "ignore", stderr: "ignore", timeout: 60_000 });
    if (r.exitCode !== 0) return abandon("generating the icons failed");
  }
  return { dir: cfg.liveDir, updated: true, commit: target, reason: `updated to ${cfg.ref} at ${target.slice(0, 7)}` };
}

export type SuperviseConfig = PrepareConfig & {
  port: number;
  healthWindowMs?: number;
  /** false: never consult GitHub, run the baked code. */
  update?: boolean;
  log?: (line: string) => void;
};
export type Supervised = {
  child: ReturnType<typeof Bun.spawn>;
  dir: string;
  updated: boolean;
  fellBack: boolean;
  commit: string | null;
  /** Process id of updated code that was abandoned, if any. */
  abandonedPid?: number;
};

// The child is told which commit the image was built from (the baked code), so it can say when it has updated past it.
// Unknown means the variable is removed, so a stale one from the environment is never passed on.
const startServer = (dir: string, port: number, baseCommit: string | null) => {
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), INTERRUPT_STACK_SUPERVISED: "1" };
  if (baseCommit) env.INTERRUPT_STACK_BASE_COMMIT = baseCommit;
  else delete env.INTERRUPT_STACK_BASE_COMMIT;
  return Bun.spawn(["bun", join(dir, "server", "main.ts")], { cwd: dir, env, stdout: "inherit", stderr: "inherit" });
};

async function becomesHealthy(child: ReturnType<typeof Bun.spawn>, port: number, windowMs: number): Promise<boolean> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {}
    await Bun.sleep(200);
  }
  return false;
}

export async function supervise(cfg: SuperviseConfig): Promise<Supervised> {
  const log = cfg.log ?? ((l: string) => console.log(`[update] ${l}`));
  const base = codeVersion(cfg.bakedDir).commit;
  if (cfg.update === false) {
    log("updating is switched off; running the code in the image");
    return { child: startServer(cfg.bakedDir, cfg.port, base), dir: cfg.bakedDir, updated: false, fellBack: false, commit: null };
  }
  const prep = await prepareLiveCopy(cfg);
  log(prep.reason);
  if (!prep.updated) return { child: startServer(prep.dir, cfg.port, base), dir: prep.dir, updated: false, fellBack: false, commit: prep.commit };

  const child = startServer(prep.dir, cfg.port, base);
  if (await becomesHealthy(child, cfg.port, cfg.healthWindowMs ?? 30_000)) {
    log(`updated code is healthy (${prep.commit?.slice(0, 7)})`);
    return { child, dir: prep.dir, updated: true, fellBack: false, commit: prep.commit };
  }

  log(`updated code (${prep.commit?.slice(0, 7)}) did not become healthy; falling back to the code in the image`);
  const abandonedPid = child.pid;
  child.kill("SIGTERM");
  const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
  if (!stopped) child.kill("SIGKILL");
  await child.exited;
  if (prep.commit) addQuarantine(cfg.dataDir, prep.commit);
  return { child: startServer(cfg.bakedDir, cfg.port, base), dir: cfg.bakedDir, updated: true, fellBack: true, commit: null, abandonedPid };
}
