import { describe, expect, test } from "bun:test";
import { completedToday } from "./today.js";

// Built with the local-time constructor so the tests mean the same thing in any time zone.
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const item = (id, removed, when, extra = {}) => ({ id, text: id, ts: when - 1000, at: when, removed, seq: 1, ...extra });
const NOW = at(2026, 11, 18, 15, 30);

describe("completed today", () => {
  test("lists items removed today, most recently removed first", () => {
    const items = [item("a", true, at(2026, 11, 18, 9, 0)), item("c", true, at(2026, 11, 18, 14, 0)), item("b", true, at(2026, 11, 18, 11, 0))];
    expect(completedToday(items, NOW).map((i) => i.id)).toEqual(["c", "b", "a"]);
  });

  test("leaves out items still on the stack", () => {
    expect(completedToday([item("a", false, at(2026, 11, 18, 9, 0))], NOW)).toEqual([]);
  });

  test("leaves out items removed on an earlier day, even a minute before midnight", () => {
    expect(completedToday([item("a", true, at(2026, 11, 17, 23, 59))], NOW)).toEqual([]);
  });

  test("includes an item removed at exactly local midnight", () => {
    expect(completedToday([item("a", true, at(2026, 11, 18, 0, 0))], NOW).map((i) => i.id)).toEqual(["a"]);
  });

  test("the day rolls over: the same item is gone once it is tomorrow", () => {
    const items = [item("a", true, at(2026, 11, 18, 15, 0))];
    expect(completedToday(items, at(2026, 11, 18, 23, 59))).toHaveLength(1);
    expect(completedToday(items, at(2026, 11, 19, 0, 1))).toEqual([]);
  });

  test("an item stored before removal times existed falls back to its push time", () => {
    const old = { id: "old", text: "old", ts: at(2026, 11, 18, 8, 0), removed: true, seq: 1 };
    expect(completedToday([old], NOW).map((i) => i.id)).toEqual(["old"]);
  });
});
