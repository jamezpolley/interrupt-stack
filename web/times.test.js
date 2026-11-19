import { describe, expect, test } from "bun:test";
import { doneRow, formatClock, formatDuration, formatStart, timeOnTop } from "./times.js";

const MIN = 60000;
// Items are (id, ts, at, removed). Times are minutes from a base so the arithmetic is easy to read.
const B = 1_000_000_000_000;
const it = (id, ts, at, removed = true) => ({ id, text: id, ts: B + ts * MIN, at: at == null ? undefined : B + at * MIN, removed, seq: 1 });
const top = (x, all, now = B + 1000 * MIN) => timeOnTop(x, all, now);

describe("timeOnTop", () => {
  test("an item nothing was pushed above has its whole span", () => {
    const a = it("a", 0, 30);
    expect(top(a, [a])).toBe(30 * MIN);
  });

  test("subtracts an item pushed and popped while it was live", () => {
    const a = it("a", 0, 30);
    const b = it("b", 10, 20);
    expect(top(a, [a, b])).toBe(20 * MIN);
  });

  test("nested pushes: only the union is subtracted, not double", () => {
    const a = it("a", 0, 60);
    const b = it("b", 10, 50);
    const c = it("c", 20, 30); // on top of b, inside b's span
    expect(top(a, [a, b, c])).toBe(20 * MIN);
    expect(top(b, [a, b, c])).toBe(30 * MIN);
  });

  test("overlapping, non-nested intervals are unioned", () => {
    const a = it("a", 0, 60);
    const b = it("b", 10, 30);
    const c = it("c", 20, 40); // pushed over b, popped after it (b dropped from the middle)
    expect(top(a, [a, b, c])).toBe(30 * MIN); // a was on top for 0-10 and 40-60 and nothing else
  });

  test("two separate excursions", () => {
    const a = it("a", 0, 60);
    const b = it("b", 10, 20);
    const c = it("c", 30, 45);
    expect(top(a, [a, b, c])).toBe(35 * MIN);
  });

  test("an item still live above a lower item that was dropped from the middle counts until the drop", () => {
    const a = it("a", 0, 40); // dropped at 40 while b is still on the stack
    const b = it("b", 10, undefined, false);
    expect(top(a, [a, b])).toBe(10 * MIN);
  });

  test("an item pushed after X ended is ignored, and clipped to X's span", () => {
    const a = it("a", 0, 30);
    const late = it("late", 40, 50);
    const long = it("long", 20, 90); // outlives a: only 20-30 is inside a
    expect(top(a, [a, late])).toBe(30 * MIN);
    expect(top(a, [a, long])).toBe(20 * MIN);
  });

  test("a swap (push at the instant the other pops) takes nothing", () => {
    const a = it("a", 0, 30);
    const b = it("b", 30, 50);
    expect(top(a, [a, b])).toBe(30 * MIN);
  });

  test("an item pushed at the same instant as X (identical timestamps) is not above it", () => {
    const a = it("a", 5, 30);
    const b = it("b", 5, 10);
    expect(top(a, [a, b])).toBe(25 * MIN);
  });

  test("an item started from Later is an ordinary push", () => {
    const a = it("a", 0, 30);
    const fromLater = it("s-later", 5, 15);
    expect(top(a, [a, fromLater])).toBe(20 * MIN);
  });

  test("a removed item above with no end time is assumed to last until X ended", () => {
    const a = it("a", 0, 30);
    const b = it("b", 10, undefined, true);
    expect(top(a, [a, b])).toBe(10 * MIN);
  });

  test("no end time, a negative span, or junk gives no duration", () => {
    expect(top(it("a", 0, undefined), [])).toBeNull();
    expect(top(it("a", 10, 5), [])).toBeNull(); // clock skew: ended before it began
    expect(top({ id: "a", ts: NaN, at: 5, removed: true }, [])).toBeNull();
    expect(top({ id: "a", ts: 1, at: "x", removed: true }, [])).toBeNull();
  });

  test("a zero span is zero, not missing", () => {
    expect(top(it("a", 5, 5), [])).toBe(0);
  });

  test("never negative even with skewed neighbours", () => {
    const a = it("a", 0, 10);
    const b = it("b", 1, 9);
    const c = it("c", 2, 8);
    expect(top(a, [a, b, c])).toBe(2 * MIN);
  });
});

describe("formatDuration", () => {
  test("shapes", () => {
    expect(formatDuration(0)).toBe("<1 min");
    expect(formatDuration(59_000)).toBe("<1 min");
    expect(formatDuration(60_000)).toBe("1 min");
    expect(formatDuration(12 * MIN)).toBe("12 min");
    expect(formatDuration(59 * MIN + 40_000)).toBe("1 h");
    expect(formatDuration(65 * MIN)).toBe("1 h 5 min");
    expect(formatDuration(120 * MIN)).toBe("2 h");
    expect(formatDuration((23 * 60 + 59) * MIN)).toBe("23 h 59 min");
    expect(formatDuration(26 * 60 * MIN)).toBe("1 d 2 h");
    expect(formatDuration(48 * 60 * MIN)).toBe("2 d");
  });
  test("junk gives an empty string", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(-5)).toBe("");
    expect(formatDuration(NaN)).toBe("");
  });
});

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const NOW = at(2026, 11, 19, 15, 30); // a Thursday

describe("formatStart", () => {
  test("today: just the time, in the device's style", () => {
    expect(formatStart(at(2026, 11, 19, 9, 12), NOW, "en-US")).toBe(formatClock(at(2026, 11, 19, 9, 12), "en-US"));
    expect(formatStart(at(2026, 11, 19, 9, 12), NOW, "en-US")).toMatch(/9:12 AM$/);
  });
  test("within the last 7 days: weekday and time", () => {
    const s = formatStart(at(2026, 11, 18, 16, 50), NOW, "en-US");
    expect(s).toMatch(/^Wed /);
    expect(s).toMatch(/4:50 PM$/);
    expect(formatStart(at(2026, 11, 13, 8, 0), NOW, "en-US")).toMatch(/^Fri /); // six days back
  });
  test("a week or more ago: date and time", () => {
    const s = formatStart(at(2026, 11, 12, 16, 50), NOW, "en-US");
    expect(s).toMatch(/^Nov 12, /);
    expect(s).toMatch(/4:50 PM$/);
  });
  test("the day boundary is the device's midnight", () => {
    expect(formatStart(at(2026, 11, 19, 0, 0), NOW, "en-US")).not.toMatch(/^Thu/);
    expect(formatStart(at(2026, 11, 18, 23, 59), NOW, "en-US")).toMatch(/^Wed /);
  });
  test("a time in the future (clock skew) is not an error", () => {
    expect(typeof formatStart(NOW + 3 * 86400000, NOW, "en-US")).toBe("string");
  });
  test("junk gives a dash", () => {
    expect(formatStart(undefined, NOW, "en-US")).toBe("—");
    expect(formatStart(NaN, NOW, "en-US")).toBe("—");
  });
});

describe("doneRow", () => {
  const b = at(2026, 11, 19, 9, 0);
  const row = (x, all = [x]) => doneRow(x, all, "en-US");
  test("end time and time on top", () => {
    const a = { id: "a", text: "a", ts: b, at: b + 30 * MIN, removed: true };
    const c = { id: "c", text: "c", ts: b + 10 * MIN, at: b + 20 * MIN, removed: true };
    expect(row(a, [a, c])).toEqual({ end: formatClock(b + 30 * MIN, "en-US"), duration: "20 min" });
  });
  test("an item with no end time shows dashes, not its push time", () => {
    const old = { id: "o", text: "o", ts: b, removed: true };
    expect(row(old)).toEqual({ end: "\u2014", duration: "\u2014" });
  });
  test("an impossible span keeps the end time but shows no duration", () => {
    const x = { id: "x", text: "x", ts: b + 10 * MIN, at: b, removed: true };
    expect(row(x)).toEqual({ end: formatClock(b, "en-US"), duration: "\u2014" });
  });
});
