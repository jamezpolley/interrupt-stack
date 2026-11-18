import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Identifies the web files this server ships, so a device running older copies can tell it is out of date.
// Computed once at start: the files in the image do not change while it runs. Tests are not part of the app.
export function webVersion(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix + e.name;
      if (e.isDirectory()) walk(resolve(dir, e.name), rel + "/");
      else if (!e.name.endsWith(".test.js")) hash.update(rel + "\0").update(readFileSync(resolve(dir, e.name))).update("\0");
    }
  };
  walk(root, "");
  return hash.digest("hex").slice(0, 12);
}
