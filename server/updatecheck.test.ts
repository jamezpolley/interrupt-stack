import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createUpdateChecker } from "./updatecheck";
import { cleanupFixtures, fixture, sh } from "./gitfixture";

afterEach(cleanupFixtures);

describe("update checker against a real repository", () => {
  test("is enabled when the code has an origin remote, and not otherwise", () => {
    const f = fixture();
    expect(createUpdateChecker({ codeDir: f.baked, ref: "main", current: f.bakedCommit }).state().enabled).toBe(true);
    expect(createUpdateChecker({ codeDir: f.root, ref: "main", current: null }).state().enabled).toBe(false);
  });

  test("reports a newer commit on the ref, and clears it when the code has caught up", async () => {
    const f = fixture();
    const c = createUpdateChecker({ codeDir: f.baked, ref: "main", current: f.bakedCommit, minIntervalMs: 0 });
    c.request();
    await c.settled();
    expect(c.state().available).toBeNull();
    expect(c.state().checkedAt).not.toBeNull();

    const b = f.commit("v2");
    c.request();
    await c.settled();
    expect(c.state().available).toEqual({ commit: b, short: b.slice(0, 7), ref: "main" });

    const caughtUp = createUpdateChecker({ codeDir: f.baked, ref: "main", current: b, minIntervalMs: 0 });
    caughtUp.request();
    await caughtUp.settled();
    expect(caughtUp.state().available).toBeNull();
  });

  test("follows a tag, using the commit the tag points at", async () => {
    const f = fixture();
    const tagged = f.commit("tagged");
    sh(f.origin, "tag", "-a", "-m", "annotated", "v2.0.0"); // an annotated tag has its own object id
    f.commit("later");
    const c = createUpdateChecker({ codeDir: f.baked, ref: "v2.0.0", current: f.bakedCommit });
    c.request();
    await c.settled();
    expect(c.state().available?.commit).toBe(tagged);
  });

  test("an unreachable remote leaves the state unchanged and never throws", async () => {
    const f = fixture();
    sh(f.baked, "remote", "set-url", "origin", join(f.root, "nowhere"));
    const c = createUpdateChecker({ codeDir: f.baked, ref: "main", current: f.bakedCommit });
    c.request();
    await c.settled();
    expect(c.state()).toMatchObject({ enabled: true, checkedAt: null, available: null });
  });

  test("when it does not know which commit it is running, it claims nothing", async () => {
    const f = fixture();
    f.commit("v2");
    const c = createUpdateChecker({ codeDir: f.baked, ref: "main", current: null });
    c.request();
    await c.settled();
    expect(c.state().available).toBeNull();
  });
});

describe("update checker behaviour", () => {
  const make = (extra: object = {}) => {
    const calls: string[] = [];
    let t = 1_000_000;
    const f = fixture();
    const checker = createUpdateChecker({
      codeDir: f.baked, ref: "main", current: "a".repeat(40), now: () => t, minIntervalMs: 60_000,
      lsRemote: async (_url: string, ref: string) => (calls.push(ref), "b".repeat(40)),
      ...extra,
    });
    return { checker, calls, advance: (ms: number) => (t += ms) };
  };

  test("request returns at once, before the check has finished", async () => {
    let release!: (v: string) => void;
    const { checker } = make({ lsRemote: () => new Promise<string>((r) => (release = r)) });
    const returned = checker.request();
    expect(returned).toBeUndefined();
    expect(checker.state().checkedAt).toBeNull();
    release("b".repeat(40));
    await checker.settled();
    expect(checker.state().available?.commit).toBe("b".repeat(40));
  });

  test("asking again within the minimum interval does not ask GitHub again", async () => {
    const { checker, calls, advance } = make();
    checker.request();
    await checker.settled();
    advance(5_000);
    checker.request();
    await checker.settled();
    expect(calls).toHaveLength(1);
    advance(60_000);
    checker.request();
    await checker.settled();
    expect(calls).toHaveLength(2);
  });

  test("asking while a check is already running does not start another", async () => {
    let release!: (v: string) => void;
    const calls: number[] = [];
    const { checker } = make({ lsRemote: () => (calls.push(1), new Promise<string>((r) => (release = r))), minIntervalMs: 0 });
    checker.request();
    checker.request();
    checker.request();
    release("b".repeat(40));
    await checker.settled();
    expect(calls).toHaveLength(1);
  });

  test("a throwing lookup is contained", async () => {
    const { checker } = make({ lsRemote: async () => { throw new Error("boom"); } });
    checker.request();
    await checker.settled();
    expect(checker.state().available).toBeNull();
  });

  test("a disabled checker does nothing", async () => {
    const f = fixture();
    const calls: number[] = [];
    const checker = createUpdateChecker({ codeDir: f.root, ref: "main", current: "a".repeat(40), lsRemote: async () => (calls.push(1), "b".repeat(40)) });
    checker.request();
    await checker.settled();
    expect(calls).toHaveLength(0);
  });
});
