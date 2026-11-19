import { describe, expect, test } from "bun:test";
import { pushAgain } from "./again.js";

// A stand-in for the sync core: records pushes and returns what a real push would.
function fakeSync(items) {
  const pushes = [];
  return {
    pushes,
    allItems: () => items,
    push: async (text, opts) => {
      pushes.push([text, opts]);
      return { id: "s-new", text, origin: opts?.origin };
    },
  };
}
const done = { id: "s-old1", text: "write report", ts: 1000, at: 2000, removed: true, seq: 3 };

describe("push again", () => {
  test("pushes a new item with the same text, linked to the finished one", async () => {
    const sync = fakeSync([done]);
    expect(await pushAgain(sync, "s-old1")).toMatchObject({ id: "s-new", text: "write report" });
    expect(sync.pushes).toEqual([["write report", { origin: "s-old1" }]]);
  });

  test("does not pin an id: the clone gets a fresh one", async () => {
    const sync = fakeSync([done]);
    await pushAgain(sync, "s-old1");
    expect(sync.pushes[0][1].id).toBeUndefined();
  });

  test("a clone of a clone points at its direct parent", async () => {
    const sync = fakeSync([{ ...done, id: "s-old2", origin: "s-old1" }]);
    await pushAgain(sync, "s-old2");
    expect(sync.pushes[0][1]).toEqual({ origin: "s-old2" });
  });

  test("does nothing for an item that is unknown, still on the stack, or has no end time", async () => {
    const sync = fakeSync([done, { ...done, id: "s-live", removed: false }, { ...done, id: "s-old", at: undefined }]);
    for (const id of ["s-nope", "s-live", "s-old"]) expect(await pushAgain(sync, id)).toBeNull();
    expect(sync.pushes).toEqual([]);
  });
});
