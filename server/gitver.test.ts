import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeVersion } from "./gitver";
import { cleanupFixtures, fixture, sh, tmp } from "./gitfixture";

afterEach(cleanupFixtures);

describe("codeVersion", () => {
  test("a tagged commit is labelled with its tag", () => {
    const f = fixture();
    f.tag("v1.0.0");
    const v = codeVersion(f.origin);
    expect(v.commit).toBe(f.head());
    expect(v.label).toBe("v1.0.0");
  });

  test("commits after a tag are labelled with the distance and the short commit", () => {
    const f = fixture();
    f.tag("v1.0.0");
    f.commit("second");
    f.commit("third");
    expect(codeVersion(f.origin).label).toMatch(/^v1\.0\.0-2-g[0-9a-f]{7,}$/);
  });

  test("with no tags the label is the short commit", () => {
    const f = fixture();
    expect(codeVersion(f.origin).label).toBe(f.head().slice(0, 7));
  });

  test("an image whose .git is shallow and has no tags still gets a label", () => {
    const f = fixture();
    f.tag("v1.0.0");
    const shallow = join(tmp(), "shallow");
    Bun.spawnSync(["git", "clone", "-q", "--depth", "1", "--no-tags", "file://" + f.origin, shallow]);
    const v = codeVersion(shallow);
    expect(v.commit).toBe(f.head());
    expect(v.label).toBe(f.head().slice(0, 7));
  });

  test("with no .git, the commit written at build time is used", () => {
    const dir = tmp();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ commit: sha }));
    expect(codeVersion(dir)).toEqual({ commit: sha, label: sha.slice(0, 7) });
  });

  test("nothing known gives nulls, not an error", () => {
    expect(codeVersion(tmp())).toEqual({ commit: null, label: null });
    expect(codeVersion(join(tmp(), "missing"))).toEqual({ commit: null, label: null });
    const dir = tmp();
    writeFileSync(join(dir, "build-info.json"), "not json");
    expect(codeVersion(dir)).toEqual({ commit: null, label: null });
  });

  test("a directory that git refuses (not a repository) falls back to the file-based answer", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "garbage\n");
    expect(codeVersion(dir)).toEqual({ commit: null, label: null });
  });
});
