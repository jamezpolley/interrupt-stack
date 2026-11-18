import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCommit, resolveCommit } from "./commit";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "fedcba9876543210fedcba9876543210fedcba98";
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ist-git-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const write = (root: string, rel: string, text: string) => {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

describe("resolveCommit", () => {
  test("follows HEAD to a loose branch ref", () => {
    const g = tmp();
    write(g, "HEAD", "ref: refs/heads/main\n");
    write(g, "refs/heads/main", SHA + "\n");
    expect(resolveCommit(g)).toBe(SHA);
  });

  test("falls back to packed-refs when the branch has no loose file", () => {
    const g = tmp();
    write(g, "HEAD", "ref: refs/heads/main\n");
    write(g, "packed-refs", `# pack-refs with: peeled fully-peeled sorted\n${SHA2} refs/heads/other\n${SHA} refs/heads/main\n`);
    expect(resolveCommit(g)).toBe(SHA);
  });

  test("a detached HEAD is the commit itself", () => {
    const g = tmp();
    write(g, "HEAD", SHA + "\n");
    expect(resolveCommit(g)).toBe(SHA);
  });

  test("a .git file pointing at another directory is followed (worktrees, submodules)", () => {
    const root = tmp();
    const real = join(root, "real-git");
    write(real, "HEAD", SHA + "\n");
    write(root, "work/.git", `gitdir: ${real}\n`);
    expect(resolveCommit(join(root, "work/.git"))).toBe(SHA);
  });

  test("null when there is no git directory, no HEAD, or nothing usable in it", () => {
    expect(resolveCommit(join(tmp(), "nope"))).toBeNull();
    expect(resolveCommit(tmp())).toBeNull();
    const g = tmp();
    write(g, "HEAD", "garbage\n");
    expect(resolveCommit(g)).toBeNull();
  });

  test("null when HEAD names a branch that cannot be found", () => {
    const g = tmp();
    write(g, "HEAD", "ref: refs/heads/gone\n");
    expect(resolveCommit(g)).toBeNull();
  });

  test("a ref file holding something that is not a commit id is not trusted", () => {
    const g = tmp();
    write(g, "HEAD", "ref: refs/heads/main\n");
    write(g, "refs/heads/main", "not a sha\n");
    expect(resolveCommit(g)).toBeNull();
  });

  test("a ref name that tries to leave the git directory is refused", () => {
    const root = tmp();
    write(root, "secret", SHA + "\n");
    write(root, "git/HEAD", "ref: ../secret\n");
    expect(resolveCommit(join(root, "git"))).toBeNull();
  });
});

describe("write-version script", () => {
  test("writes the commit as JSON, and null when there is no git directory", async () => {
    const root = tmp();
    write(root, "git/HEAD", SHA + "\n");
    const run = async (gitDir: string, out: string) =>
      Bun.spawn(["bun", join(import.meta.dir, "../scripts/write-version.ts"), gitDir, out], { stdout: "ignore", stderr: "ignore" }).exited;
    expect(await run(join(root, "git"), join(root, "a.json"))).toBe(0);
    expect(await Bun.file(join(root, "a.json")).json()).toEqual({ commit: SHA });
    expect(await run(join(root, "missing"), join(root, "b.json"))).toBe(0);
    expect(await Bun.file(join(root, "b.json")).json()).toEqual({ commit: null });
  });
});

describe("normalizeCommit", () => {
  test("accepts a commit id in either case and trims it", () => {
    expect(normalizeCommit(SHA.toUpperCase() + "\n")).toBe(SHA);
  });

  test("rejects anything that is not a commit id", () => {
    for (const bad of ["", "abc", "zzzz", SHA + "0", null, undefined, 42, {}]) expect(normalizeCommit(bad as any)).toBeNull();
  });
});
