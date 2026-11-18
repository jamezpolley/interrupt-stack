import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ist-static-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// A small stand-in for web/, so the tests control exactly what is shipped.
function fakeWeb(extra: Record<string, string> = {}) {
  const web = tmp();
  const files: Record<string, string> = {
    "index.html": '<link rel="stylesheet" href="style.css"><script type="module" src="app.js"></script>',
    "app.js": "export {}",
    "config.js": "export const LOCAL_ONLY = false;\n",
    "style.css": "body{}",
    "app.test.js": "// not shipped",
    "icons/icon-192.png": "png",
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(web, rel, ".."), { recursive: true });
    writeFileSync(join(web, rel), text);
  }
  return web;
}

const build = async (web: string, out: string, env: Record<string, string> = {}) => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "build-static.ts"), out, web], {
    env: { ...process.env, GITHUB_SHA: "", ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return { code, err: await new Response(proc.stderr).text() };
};
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("build-static", () => {
  test("copies the web files, leaving out tests", async () => {
    const out = tmp();
    expect((await build(fakeWeb(), out)).code).toBe(0);
    expect(existsSync(join(out, "index.html"))).toBe(true);
    expect(existsSync(join(out, "icons/icon-192.png"))).toBe(true);
    expect(existsSync(join(out, "app.test.js"))).toBe(false);
  });

  test("switches the app to local-only mode", async () => {
    const out = tmp();
    await build(fakeWeb(), out);
    expect(readFileSync(join(out, "config.js"), "utf8")).toBe("export const LOCAL_ONLY = true;\n");
  });

  test("writes version.js and version.json that agree, with the commit from GITHUB_SHA", async () => {
    const out = tmp();
    await build(fakeWeb(), out, { GITHUB_SHA: SHA });
    const json = JSON.parse(readFileSync(join(out, "version.json"), "utf8"));
    expect(json.commit).toBe(SHA);
    expect(json.version).toMatch(/^[0-9a-f]{12}$/);
    expect(readFileSync(join(out, "version.js"), "utf8")).toBe(`export const VERSION = "${json.version}";\nexport const COMMIT = "${SHA}";\n`);
  });

  test("the commit is null when it cannot be determined", async () => {
    const out = tmp();
    await build(fakeWeb(), out, { GITHUB_SHA: "" });
    const json = JSON.parse(readFileSync(join(out, "version.json"), "utf8"));
    expect(json.commit === null || /^[0-9a-f]{40}$/.test(json.commit)).toBe(true); // a checkout's own .git may answer
    expect(readFileSync(join(out, "version.js"), "utf8")).toContain(`export const COMMIT = ${JSON.stringify(json.commit)};`);
  });

  test("the version is stable for the same files and changes when a file changes", async () => {
    const web = fakeWeb();
    const a = tmp(), b = tmp(), c = tmp();
    await build(web, a);
    await build(web, b);
    writeFileSync(join(web, "app.js"), "export const changed = 1");
    await build(web, c);
    const v = (d: string) => JSON.parse(readFileSync(join(d, "version.json"), "utf8")).version;
    expect(v(a)).toBe(v(b));
    expect(v(c)).not.toBe(v(a));
  });

  test("the version does not depend on the commit, so a docs-only commit does not raise the update banner", async () => {
    const web = fakeWeb();
    const a = tmp(), b = tmp();
    await build(web, a, { GITHUB_SHA: SHA });
    await build(web, b, { GITHUB_SHA: "f".repeat(40) });
    const v = (d: string) => JSON.parse(readFileSync(join(d, "version.json"), "utf8")).version;
    expect(v(a)).toBe(v(b));
  });

  test("the output is cleaned first, so a deleted file does not linger", async () => {
    const out = tmp();
    writeFileSync(join(out, "stale.txt"), "old");
    await build(fakeWeb(), out);
    expect(existsSync(join(out, "stale.txt"))).toBe(false);
  });

  test("the real web/ directory ships only relative URLs, so it works under any path or host", async () => {
    const real = join(import.meta.dir, "../web");
    const html = readFileSync(join(real, "index.html"), "utf8");
    expect(html).not.toMatch(/(href|src)="\//);
    const manifest = JSON.parse(readFileSync(join(real, "manifest.webmanifest"), "utf8"));
    expect(manifest.id).toBeUndefined(); // the app id follows start_url, so it moves with the app
    for (const u of [manifest.start_url, manifest.scope, ...manifest.icons.map((i: any) => i.src)]) {
      expect(u.startsWith("/")).toBe(false);
      expect(u).not.toMatch(/^[a-z]+:/);
    }
    const sw = readFileSync(join(real, "sw.js"), "utf8");
    expect(sw).not.toMatch(/"\/[a-z]/); // no absolute shell paths
  });
});
