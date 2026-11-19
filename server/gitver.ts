import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeCommit, resolveCommit } from "./commit";

export type CodeVersion = { commit: string | null; label: string | null };

/**
 * What a code directory is: its commit, and a human label. The label is the nearest tag (`v1.2.0`), the tag plus how
 * far past it (`v1.2.0-3-g5a7581b`), or just the short commit when there are no tags to describe it by.
 * Falls back to the commit written at image build time (build-info.json) when there is no .git, and to nulls.
 */
export function codeVersion(dir: string): CodeVersion {
  let commit = resolveCommit(join(dir, ".git"));
  if (!commit) {
    try {
      commit = normalizeCommit(JSON.parse(readFileSync(join(dir, "build-info.json"), "utf8")).commit);
    } catch {}
    return { commit, label: commit ? commit.slice(0, 7) : null };
  }

  let label = commit.slice(0, 7);
  try {
    const r = Bun.spawnSync(["git", "-C", dir, "describe", "--tags", "--always"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    const described = r.stdout.toString().trim();
    if (r.exitCode === 0 && described) label = described;
  } catch {} // no git binary: the short commit will do
  return { commit, label };
}

/**
 * The commit the container image was built from ("base"), but only when it is worth showing: both commits are known and
 * they differ, which means the server has updated itself past its image. Otherwise null (never guess).
 */
export function reportedBase(running: unknown, base: unknown): string | null {
  const r = normalizeCommit(running);
  const b = normalizeCommit(base);
  return r && b && r !== b ? b : null;
}
