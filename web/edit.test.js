import { describe, expect, test } from "bun:test";
import { applyDraft, changesFrom, parseEdited, shiftDate, shiftRowTime, canShiftLater, noteDayShift, rowTargets, isOwnRow, sideEffects, validateDraft, clockText, dateText } from "./edit.js";

const m = (h, min = 0) => new Date(2026, 10, 19, h, min).getTime();
const item = (id, ts, at, removed = true, text = id) => ({ id, text, ts, at, removed, seq: 1 });
// A pushed 9:00, B pushed 9:10 above it, B popped 9:30, A popped 10:00.
const A = item("A", m(9), m(10));
const B = item("B", m(9, 10), m(9, 30));
const all = [A, B];
const NOW = m(18);

describe("rowTargets", () => {
  test("each row edits the field of the item it belongs to", () => {
    expect(rowTargets(A, all)).toEqual([
      { id: "A", field: "ts" },
      { id: "B", field: "ts" },
      { id: "B", field: "at" },
      { id: "A", field: "at" },
    ]);
  });
});

describe("isOwnRow", () => {
  test("only the rows that belong to the item being viewed are editable", () => {
    const tg = rowTargets(A, all);
    expect(tg.map((t) => isOwnRow(A, t))).toEqual([true, false, false, true]);
  });
});

describe("validateDraft", () => {
  test("a good edit has no problems", () => {
    expect(validateDraft(all, { times: { "B:at": m(9, 20) } }, NOW)).toEqual([]);
  });
  test("end before start", () => {
    expect(validateDraft(all, { times: { "B:at": m(9, 5) } }, NOW).join()).toMatch(/end before it started/);
  });
  test("future time", () => {
    expect(validateDraft(all, { times: { "A:at": NOW + 60000 } }, NOW).join()).toMatch(/future/);
  });
  test("a draft that gives an item still on the stack an end time is refused", () => {
    const live = item("L", m(9, 15), m(9, 15), false);
    expect(validateDraft([...all, live], { times: { "L:at": m(9, 16) } }, NOW).join()).toMatch(/has not ended/);
  });
  test("empty and over-long text", () => {
    expect(validateDraft(all, { texts: { A: "  " } }, NOW).join()).toMatch(/empty/);
    expect(validateDraft(all, { texts: { A: "x".repeat(201) } }, NOW).join()).toMatch(/200/);
  });
});

describe("sideEffects and changes", () => {
  test("moving B's push to before A's changes A's time on top", () => {
    const draft = { times: { "B:ts": m(8, 50) } };
    expect(applyDraft(all, draft)[1].ts).toBe(m(8, 50));
    expect(sideEffects(all, draft, "A").map((e) => e.text)).toEqual(["B"]); // now A sat above B, so B's time on top shrinks
    const other = sideEffects(all, { times: { "B:at": m(9, 20) } }, "B");
    expect(other.map((e) => e.text)).toEqual(["A"]); // A gets back 10 minutes
  });
  test("an empty draft changes nothing (open Edit, then Cancel)", () => {
    expect(changesFrom(all, { texts: {}, times: {} })).toEqual([]);
    expect(validateDraft(all, { texts: {}, times: {} }, NOW)).toEqual([]);
    expect(sideEffects(all, { texts: {}, times: {} }, "A")).toEqual([]);
  });
  test("renaming the item changes no totals", () => {
    expect(sideEffects(all, { texts: { A: "renamed" } }, "A")).toEqual([]);
  });
  test("changesFrom lists only the fields that differ", () => {
    expect(changesFrom(all, { texts: { A: "A" }, times: { "B:at": m(9, 20) } })).toEqual([{ id: "B", at: m(9, 20) }]);
    expect(changesFrom(all, { texts: { A: "renamed" } })).toEqual([{ id: "A", text: "renamed" }]);
  });
});

describe("parseEdited", () => {
  const withSec = (h, min, sec, ms = 0) => new Date(2026, 10, 19, h, min, sec, ms).getTime();
  test("the same minute and day, seconds omitted, keeps the original exactly", () => {
    const t = withSec(9, 5, 42, 321);
    expect(parseEdited(t, "09:05")).toBe(t);
  });
  test("a changed minute with seconds omitted keeps the original seconds", () => {
    expect(parseEdited(withSec(9, 5, 42, 321), "9:07")).toBe(withSec(9, 7, 42, 321));
  });
  test("typed seconds are used, with no milliseconds", () => {
    expect(parseEdited(withSec(9, 5, 42, 321), "09:07:15")).toBe(withSec(9, 7, 15));
  });
  test("typed seconds equal to the original keep its milliseconds", () => {
    const t = withSec(9, 5, 42, 321);
    expect(parseEdited(t, "09:05:42")).toBe(t);
  });
  test("a changed date keeps the time of day and seconds", () => {
    const out = parseEdited(withSec(9, 0, 30), "09:00", "2026-11-18");
    expect(new Date(out).getDate()).toBe(18);
    expect(new Date(out).getSeconds()).toBe(30);
  });
  test("junk is null", () => {
    for (const bad of ["25:00", "9:7", "09:00:60", "09:00:5", "09", "", "09:00:00:00", "09.00"]) expect(parseEdited(withSec(9, 0, 0), bad)).toBeNull();
    expect(parseEdited(withSec(9, 0, 0), "09:00", "nope")).toBeNull();
  });
});

describe("clockText", () => {
  test("is HH:MM:SS, 24 hour", () => {
    expect(clockText(new Date(2026, 10, 19, 7, 5, 9).getTime())).toBe("07:05:09");
    expect(clockText(new Date(2026, 10, 19, 0, 0, 0).getTime())).toBe("00:00:00");
  });
});

describe("shiftDate", () => {
  test("moves a day either way", () => {
    expect(shiftDate("2026-11-19", -1)).toBe("2026-11-18");
    expect(shiftDate("2026-11-19", 1)).toBe("2026-11-20");
  });
  test("crosses month, year and leap-day boundaries", () => {
    expect(shiftDate("2026-12-01", -1)).toBe("2026-11-30");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDate("2025-12-31", 1)).toBe("2026-01-01");
  });
  test("crosses DST changes without skipping or repeating a day", () => {
    for (const start of ["2026-03-07", "2026-03-28", "2026-04-04", "2026-10-03", "2026-10-24", "2026-11-01"]) {
      let d = start;
      const seen = [];
      for (let i = 0; i < 4; i++) (d = shiftDate(d, 1)), seen.push(d);
      expect(new Set(seen).size).toBe(4);
      for (let i = 0; i < 4; i++) d = shiftDate(d, -1);
      expect(d).toBe(start);
    }
  });
  test("feeds parseEdited, keeping the time of day", () => {
    const t = new Date(2026, 10, 19, 9, 0, 30).getTime();
    const out = parseEdited(t, "09:00", shiftDate(dateText(t), -1));
    expect(dateText(out)).toBe(shiftDate(dateText(t), -1));
    expect(clockText(out)).toBe("09:00:30");
  });
  test("a bad date is null", () => {
    expect(shiftDate("nope", 1)).toBeNull();
  });
});

describe("shiftRowTime", () => {
  const now = new Date(2026, 10, 21, 15, 0, 0).getTime();
  const orig = new Date(2026, 10, 21, 13, 3, 30, 250).getTime();
  test("moves a time made today to yesterday, keeping the clock", () => {
    const out = shiftRowTime(orig, "13:03:30", orig, -1);
    expect(dateText(out)).toBe("2026-11-20");
    expect(clockText(out)).toBe("13:03:30");
  });
  test("uses the typed clock and the current (drafted) day", () => {
    const drafted = new Date(2026, 10, 20, 13, 3, 30).getTime();
    const out = shiftRowTime(orig, "09:15", drafted, -1);
    expect(dateText(out)).toBe("2026-11-19");
    expect(clockText(out)).toBe("09:15:30");
  });
  test("a junk clock is null", () => {
    expect(shiftRowTime(orig, "nope", orig, -1)).toBeNull();
  });
});

describe("canShiftLater", () => {
  const now = new Date(2026, 10, 21, 0, 5, 0).getTime();
  test("not on today (or later), yes on earlier days", () => {
    expect(canShiftLater(new Date(2026, 10, 21, 0, 1).getTime(), now)).toBe(false);
    expect(canShiftLater(new Date(2026, 10, 20, 23, 59).getTime(), now)).toBe(true);
  });
});

describe("noteDayShift", () => {
  const now = new Date(2026, 10, 21, 15, 0, 0).getTime();
  const today = new Date(2026, 10, 21, 13, 3, 30).getTime();
  const yesterday = new Date(2026, 10, 20, 13, 3, 30).getTime();
  test("moves a note from today to yesterday, keeping the typed clock", () => {
    const out = noteDayShift(today, "09:15", today, -1, now);
    expect(dateText(out)).toBe("2026-11-20");
    expect(clockText(out)).toBe("09:15:30");
  });
  test("moves a note from yesterday to today", () => {
    expect(dateText(noteDayShift(yesterday, "13:03:30", yesterday, 1, now))).toBe("2026-11-21");
  });
  test("never goes past today, and a junk clock is null", () => {
    expect(noteDayShift(today, "13:03:30", today, 1, now)).toBeNull();
    expect(noteDayShift(today, "nope", today, -1, now)).toBeNull();
  });
});

describe("an inverted entry can be opened and repaired", () => {
  const X = item("X", m(10, 40) + 30_000, m(10, 40) + 5_000); // ended before it began
  test("rowTargets still maps its two rows to its own fields", () => {
    expect(rowTargets(X, [X])).toEqual([{ id: "X", field: "ts" }, { id: "X", field: "at" }]);
  });
  test("moving both times to yesterday is a valid edit", () => {
    const y = (h, min) => new Date(2026, 10, 18, h, min).getTime();
    expect(validateDraft([X], { times: { "X:ts": y(10, 40), "X:at": y(10, 41) } }, NOW)).toEqual([]);
  });
  test("a draft that leaves it inverted is still refused", () => {
    expect(validateDraft([X], { times: { "X:at": m(10, 40) } }, NOW).join()).toMatch(/end before it started/);
  });
});

describe("an item still on the stack", () => {
  const L = item("L", m(9), null, false);
  test("rowTargets maps its one row to its own push time (the Details card opens it)", () => {
    expect(rowTargets(L, [L])).toEqual([{ id: "L", field: "ts" }]);
  });
});

describe("editing the push time of an item still on the stack", () => {
  const L = item("L", m(9), null, false);
  test("its push time can be edited; a draft giving it an end time is refused", () => {
    expect(validateDraft([L], { texts: {}, times: { "L:ts": m(8) } }, m(12))).toEqual([]);
    expect(validateDraft([L], { texts: {}, times: { "L:at": m(10) } }, m(12)).length).toBe(1);
  });
  test("changesFrom sends the new push time", () => {
    expect(changesFrom([L], { texts: {}, times: { "L:ts": m(8) } })).toEqual([{ id: "L", ts: m(8) }]);
  });
});
