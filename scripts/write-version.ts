// Run in the image build: records which commit the build context is on, so the running server can say.
// Always writes the file (commit null when there is no usable .git), so a missing .git never breaks a build.
//   bun scripts/write-version.ts <path to .git> <output file>
import { writeFileSync } from "node:fs";
import { resolveCommit } from "../server/commit";

const [gitPath, out] = process.argv.slice(2);
const commit = gitPath ? resolveCommit(gitPath) : null;
writeFileSync(out, JSON.stringify({ commit }) + "\n");
console.log(commit ? `build commit ${commit}` : "build commit unknown: no usable .git in the build context");
