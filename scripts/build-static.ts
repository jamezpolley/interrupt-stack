// Builds the static version of the app (no server, everything stored in the browser) into a directory that
// any static host can serve, from any path.
//   bun scripts/build-static.ts [output directory = _site] [web directory = ../web]
// The commit comes from GITHUB_SHA (set by GitHub Actions), or from this checkout's .git.
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { resolveCommit } from "../server/commit";
import { webVersion } from "../server/webversion";

const [outArg, webArg] = process.argv.slice(2);
const out = resolve(outArg ?? "_site");
const web = resolve(webArg ?? join(import.meta.dir, "../web"));

// The output directory is emptied first, so refuse one that would take the sources or the working directory with it.
const contains = (outer: string, inner: string) => inner === outer || inner.startsWith(outer + sep);
if (contains(out, web) || contains(out, process.cwd()) || out === resolve("/")) {
  console.error(`refusing to empty ${out}: it contains the web files or the working directory`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(web, out, { recursive: true, filter: (src) => !src.endsWith(".test.js") });
writeFileSync(join(out, "config.js"), "export const LOCAL_ONLY = true;\n");

// The version covers the shipped files only (not the commit), so a commit that changes nothing the app ships
// does not raise the update banner. It is computed before version.js and version.json exist.
const version = webVersion(out);
const fromEnv = process.env.GITHUB_SHA?.trim();
const commit = fromEnv && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(fromEnv) ? fromEnv : resolveCommit(join(import.meta.dir, "../.git"));
writeFileSync(join(out, "version.js"), `export const VERSION = "${version}";\nexport const COMMIT = ${JSON.stringify(commit)};\n`);
writeFileSync(join(out, "version.json"), JSON.stringify({ version, commit }) + "\n");
console.log(`static version ${version}, commit ${commit ?? "unknown"}, written to ${out}`);
