// The small version line under the heading: this copy of the app's own label, plus (when the server says so) the commit
// its image was built from, so you can see the image has fallen behind a self-updated server. Pure.
const COMMIT_ID = /^[0-9a-f]{7,64}$/i;

export function versionLine(build, info) {
  const own =
    typeof build?.LABEL === "string" && build.LABEL
      ? build.LABEL
      : typeof build?.COMMIT === "string" && build.COMMIT
        ? build.COMMIT.slice(0, 7)
        : "version unknown";
  const base = typeof info?.base === "string" && COMMIT_ID.test(info.base) ? info.base.slice(0, 7) : null;
  return base ? `${own} · image ${base}` : own;
}
