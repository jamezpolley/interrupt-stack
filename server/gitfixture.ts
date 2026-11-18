// Test helper: a throwaway "GitHub" (a local repository) plus an image-like baked clone of it.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

const dirs: string[] = [];
export const cleanupFixtures = () => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
};
export const tmp = (prefix = "ist-fx-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

export const FAKE_SERVER = `
const marker = (await Bun.file(import.meta.dir + "/../marker.txt").text()).trim();
if (marker.startsWith("crash")) process.exit(1);
if (marker.startsWith("hang")) { setInterval(() => {}, 1000); } else {
  Bun.serve({ port: Number(process.env.PORT), fetch: (r) => { const p = new URL(r.url).pathname; return new Response(p === "/healthz" ? "ok " + marker : p === "/supervised" ? String(process.env.INTERRUPT_STACK_SUPERVISED) : "no"); } });
}
`;
export const FAKE_ICONS = `
import { mkdirSync, writeFileSync } from "node:fs";
const marker = (await Bun.file(import.meta.dir + "/../marker.txt").text()).trim();
if (marker.startsWith("icons-fail")) process.exit(1);
mkdirSync(import.meta.dir + "/../web/icons", { recursive: true });
writeFileSync(import.meta.dir + "/../web/icons/made.txt", marker);
`;

/** origin = the pretend GitHub. baked = a clone of it at its first commit, with scripts/ removed like the real image. */
export function fixture(firstMarker = "v1") {
  const root = tmp();
  const origin = join(root, "origin");
  mkdirSync(origin, { recursive: true });
  sh(origin, "init", "-q", "-b", "main");
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(origin, rel)), { recursive: true });
    writeFileSync(join(origin, rel), text);
  };
  put("server/main.ts", FAKE_SERVER);
  put("scripts/make-icons.ts", FAKE_ICONS);
  put("marker.txt", firstMarker + "\n");
  sh(origin, "add", "-A");
  sh(origin, "commit", "-q", "-m", "first");
  const commit = (marker: string, msg = marker) => {
    put("marker.txt", marker + "\n");
    sh(origin, "add", "-A");
    sh(origin, "commit", "-q", "-m", msg);
    return sh(origin, "rev-parse", "HEAD");
  };
  const baked = join(root, "baked");
  Bun.spawnSync(["git", "clone", "-q", origin, baked]);
  rmSync(join(baked, "scripts"), { recursive: true, force: true });
  const bakedCommit = sh(baked, "rev-parse", "HEAD");
  return {
    root, origin, baked, bakedCommit,
    live: join(root, "live"),
    data: join(root, "data"),
    commit,
    tag: (name: string) => sh(origin, "tag", name),
    head: (dir = origin) => sh(dir, "rev-parse", "HEAD"),
    read: (p: string) => readFileSync(p, "utf8").trim(),
  };
}
export { cpSync };
