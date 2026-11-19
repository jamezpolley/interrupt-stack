import { describe, expect, test } from "bun:test";
import { versionLine } from "./version-line.js";

const COMMIT = "0c081c5" + "a".repeat(33);
const BASE = "3a4ff67" + "b".repeat(33);

describe("versionLine", () => {
  test("this copy's own label, as before", () => {
    expect(versionLine({ LABEL: "v1.2.0-3-g5a7581b", COMMIT })).toBe("v1.2.0-3-g5a7581b");
    expect(versionLine({ LABEL: null, COMMIT })).toBe("0c081c5");
    expect(versionLine({ LABEL: "", COMMIT })).toBe("0c081c5");
    expect(versionLine({})).toBe("version unknown");
    expect(versionLine(null)).toBe("version unknown");
  });

  test("the image's base commit follows it, in short form, when the server reports one", () => {
    expect(versionLine({ LABEL: "0c081c5", COMMIT }, { base: BASE })).toBe("0c081c5 · image 3a4ff67");
    expect(versionLine({ LABEL: "v1.2.0-3-g5a7581b", COMMIT }, { base: BASE })).toBe("v1.2.0-3-g5a7581b · image 3a4ff67");
    expect(versionLine(null, { base: BASE })).toBe("version unknown · image 3a4ff67");
  });

  test("nothing extra without a usable base", () => {
    for (const info of [null, undefined, {}, { base: null }, { base: "" }, { base: 12 }, { base: "not a commit" }, { commit: COMMIT }]) {
      expect(versionLine({ LABEL: "0c081c5", COMMIT }, info)).toBe("0c081c5");
    }
  });
});
