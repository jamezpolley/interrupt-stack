import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareLiveCopy, readQuarantine, supervise } from "./update";
import { cleanupFixtures, fixture, sh } from "./gitfixture";

afterEach(cleanupFixtures);
const cfg = (f: ReturnType<typeof fixture>, extra: object = {}) => ({
  bakedDir: f.baked, liveDir: f.live, dataDir: f.data, ref: "main", fetchTimeoutMs: 10_000, ...extra,
});

describe("prepareLiveCopy", () => {
  test("a newer commit on the ref becomes the live copy, and the icons are regenerated there", async () => {
    const f = fixture();
    const b = f.commit("v2");
    const r = await prepareLiveCopy(cfg(f));
    expect(r).toMatchObject({ dir: f.live, updated: true, commit: b });
    expect(f.read(join(f.live, "marker.txt"))).toBe("v2");
    expect(f.read(join(f.live, "web/icons/made.txt"))).toBe("v2");
  });

  test("the baked copy is never modified", async () => {
    const f = fixture();
    f.commit("v2");
    await prepareLiveCopy(cfg(f));
    expect(f.head(f.baked)).toBe(f.bakedCommit);
    expect(f.read(join(f.baked, "marker.txt"))).toBe("v1");
    expect(existsSync(join(f.baked, "scripts"))).toBe(false);
  });

  test("an unreachable remote means the baked copy", async () => {
    const f = fixture();
    sh(f.baked, "remote", "set-url", "origin", join(f.root, "does-not-exist"));
    const r = await prepareLiveCopy(cfg(f));
    expect(r).toMatchObject({ dir: f.baked, updated: false });
    expect(r.reason).toMatch(/fetch/i);
  });

  test("a ref that does not exist means the baked copy", async () => {
    const f = fixture();
    const r = await prepareLiveCopy(cfg(f, { ref: "no-such-branch" }));
    expect(r).toMatchObject({ dir: f.baked, updated: false });
    expect(r.reason).toMatch(/not found/i);
  });

  test("a tag can be followed, and stays put when the branch moves on", async () => {
    const f = fixture();
    const tagged = f.commit("tagged");
    f.tag("v1.0.0");
    f.commit("later");
    const r = await prepareLiveCopy(cfg(f, { ref: "v1.0.0" }));
    expect(r).toMatchObject({ updated: true, commit: tagged });
    expect(f.read(join(f.live, "marker.txt"))).toBe("tagged");
  });

  test("a branch other than main can be followed", async () => {
    const f = fixture();
    sh(f.origin, "checkout", "-q", "-b", "next");
    const n = f.commit("on-next");
    sh(f.origin, "checkout", "-q", "main");
    const r = await prepareLiveCopy(cfg(f, { ref: "next" }));
    expect(r).toMatchObject({ updated: true, commit: n });
  });

  test("when the ref is already what is baked, the baked copy is used and nothing is copied", async () => {
    const f = fixture();
    const r = await prepareLiveCopy(cfg(f));
    expect(r).toMatchObject({ dir: f.baked, updated: false, commit: f.bakedCommit });
    expect(existsSync(f.live)).toBe(false);
  });

  test("a quarantined commit is skipped, but a different one is not", async () => {
    const f = fixture();
    const b = f.commit("v2");
    writeFileSync(join(f.data + "-q"), "");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(f.data, { recursive: true });
    writeFileSync(join(f.data, "update-quarantine.json"), JSON.stringify([b]));
    expect(await prepareLiveCopy(cfg(f))).toMatchObject({ dir: f.baked, updated: false });
    const c = f.commit("v3");
    expect(await prepareLiveCopy(cfg(f))).toMatchObject({ updated: true, commit: c });
  });

  test("a baked copy with no .git means no update", async () => {
    const f = fixture();
    const { rmSync } = await import("node:fs");
    rmSync(join(f.baked, ".git"), { recursive: true, force: true });
    expect(await prepareLiveCopy(cfg(f))).toMatchObject({ dir: f.baked, updated: false });
  });

  test("a failing icon step means the baked copy", async () => {
    const f = fixture();
    f.commit("icons-fail");
    const r = await prepareLiveCopy(cfg(f));
    expect(r).toMatchObject({ dir: f.baked, updated: false });
    expect(r.reason).toMatch(/icon/i);
  });

  test("a stale live folder from a previous run is replaced, not reused", async () => {
    const f = fixture();
    f.commit("v2");
    await prepareLiveCopy(cfg(f));
    writeFileSync(join(f.live, "junk.txt"), "old");
    f.commit("v3");
    await prepareLiveCopy(cfg(f));
    expect(existsSync(join(f.live, "junk.txt"))).toBe(false);
    expect(f.read(join(f.live, "marker.txt"))).toBe("v3");
  });
});

// Real servers on real ports: a fake server per commit, serving /healthz with its marker.
let nextPort = 24000 + Math.floor(Math.random() * 2000);
const run = async (f: ReturnType<typeof fixture>, extra: object = {}) => {
  const port = nextPort++;
  const s = await supervise({ ...cfg(f), port, healthWindowMs: 4000, ...extra });
  const body = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        return await (await fetch(`http://127.0.0.1:${port}/healthz`)).text();
      } catch {
        await Bun.sleep(100);
      }
    }
    return null;
  };
  return { s, body };
};

describe("supervise", () => {
  test("updated code that comes up healthy is what runs", async () => {
    const f = fixture();
    f.commit("v2");
    const { s, body } = await run(f);
    try {
      expect(s).toMatchObject({ updated: true, fellBack: false });
      expect(await body()).toBe("ok v2");
    } finally {
      s.child.kill();
    }
  });

  test("updated code that crashes falls back to the baked code, and the bad commit is remembered", async () => {
    const f = fixture();
    const bad = f.commit("crash-now");
    const { s, body } = await run(f);
    try {
      expect(s).toMatchObject({ updated: true, fellBack: true, dir: f.baked });
      expect(await body()).toBe("ok v1");
      expect(readQuarantine(f.data)).toEqual([bad]);
    } finally {
      s.child.kill();
    }
  });

  test("updated code that starts but never answers /healthz falls back too, and the stuck server is killed", async () => {
    const f = fixture();
    f.commit("hang-forever");
    const { s, body } = await run(f, { healthWindowMs: 1500 });
    try {
      expect(s.fellBack).toBe(true);
      expect(await body()).toBe("ok v1");
      expect(s.abandonedPid).toBeGreaterThan(0);
      await Bun.sleep(300);
      expect(() => process.kill(s.abandonedPid!, 0)).toThrow(); // no such process
    } finally {
      s.child.kill();
    }
  });

  test("a remembered bad commit is not tried again, until the ref moves to a different commit", async () => {
    const f = fixture();
    f.commit("crash-now");
    const first = await run(f);
    first.s.child.kill();
    await Bun.sleep(200);
    const second = await run(f);
    try {
      expect(second.s).toMatchObject({ updated: false, fellBack: false, dir: f.baked });
    } finally {
      second.s.child.kill();
    }
    f.commit("fixed");
    const third = await run(f);
    try {
      expect(third.s).toMatchObject({ updated: true, fellBack: false });
      expect(await third.body()).toBe("ok fixed");
    } finally {
      third.s.child.kill();
    }
  });

  test("with updating switched off the baked code runs and GitHub is not consulted", async () => {
    const f = fixture();
    f.commit("v2");
    const { s, body } = await run(f, { update: false });
    try {
      expect(s).toMatchObject({ updated: false, dir: f.baked });
      expect(await body()).toBe("ok v1");
      expect(existsSync(f.live)).toBe(false);
    } finally {
      s.child.kill();
    }
  });
});
