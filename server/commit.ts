import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/; // SHA-1, or SHA-256 repositories

/** A commit id in canonical (lowercase) form, or null if the text is not one. */
export function normalizeCommit(text: unknown): string | null {
  const id = typeof text === "string" ? text.trim().toLowerCase() : "";
  return COMMIT_ID.test(id) ? id : null;
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * The commit a git checkout is on, read straight from its files (no git binary needed, so it works in a bare
 * build image). Accepts a `.git` directory or a `.git` file pointing at one. Returns null when it cannot tell.
 */
export function resolveCommit(gitPath: string): string | null {
  let gitDir = gitPath;
  try {
    if (statSync(gitPath).isFile()) {
      const target = read(gitPath)?.match(/^gitdir:\s*(.+)$/m)?.[1];
      if (!target) return null;
      gitDir = resolve(dirname(gitPath), target.trim());
    }
  } catch {
    return null;
  }

  const head = read(join(gitDir, "HEAD"))?.trim();
  if (!head) return null;
  if (COMMIT_ID.test(head)) return head; // detached HEAD

  const ref = head.match(/^ref:\s*(\S+)$/)?.[1];
  if (!ref || !ref.startsWith("refs/") || ref.split("/").includes("..")) return null;

  const loose = read(join(gitDir, ref))?.trim();
  if (loose && COMMIT_ID.test(loose)) return loose;

  for (const line of (read(join(gitDir, "packed-refs")) ?? "").split("\n")) {
    const [id, name] = line.trim().split(" ");
    if (name === ref && COMMIT_ID.test(id)) return id;
  }
  return null;
}
