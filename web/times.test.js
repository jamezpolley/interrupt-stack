import { describe, expect, test } from "bun:test";
import { doneRow, formatClock, formatDuration, formatStart, timeline, timeOnTop, detailsFor } from "./times.js";

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
    expect(formatStart(at(2026, 11, 19, 9, 12), NOW, "en-US")).toBe("09:12");
  });
  test("within the last 7 days: weekday and time", () => {
    const s = formatStart(at(2026, 11, 18, 16, 50), NOW, "en-US");
    expect(s).toMatch(/^Wed /);
    expect(s).toMatch(/ 16:50$/);
    expect(formatStart(at(2026, 11, 13, 8, 0), NOW, "en-US")).toMatch(/^Fri /); // six days back
  });
  test("a week or more ago: date and time", () => {
    const s = formatStart(at(2026, 11, 12, 16, 50), NOW, "en-US");
    expect(s).toMatch(/^Nov 12, /);
    expect(s).toMatch(/, 16:50$/);
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
  const row = (x, all = [x]) => doneRow(x, all, "en-US", at(2026, 11, 19, 15, 0));
  test("end time and time on top", () => {
    const a = { id: "a", text: "a", ts: b, at: b + 30 * MIN, removed: true };
    const c = { id: "c", text: "c", ts: b + 10 * MIN, at: b + 20 * MIN, removed: true };
    expect(row(a, [a, c])).toEqual({ start: "09:00", end: "09:30", duration: "20 min" });
  });
  test("an item with no end time shows dashes, not its push time", () => {
    const old = { id: "o", text: "o", ts: b, removed: true };
    expect(row(old)).toEqual({ start: "09:00", end: "\u2014", duration: "\u2014" });
  });
  test("an impossible span keeps the end time but shows no duration", () => {
    const x = { id: "x", text: "x", ts: b + 10 * MIN, at: b, removed: true };
    expect(row(x)).toEqual({ start: "09:10", end: "09:00", duration: "\u2014" });
  });
});

describe("24-hour clock, whatever the device locale", () => {
  const c = (h, m) => at(2026, 11, 19, h, m);
  test("always two-digit 24-hour", () => {
    for (const loc of ["en-US", "en-GB", "de-DE", "ja-JP", "ar-EG", "hi-IN", undefined]) {
      expect(formatClock(c(14, 49), loc)).toBe("14:49");
      expect(formatClock(c(9, 5), loc)).toBe("09:05");
    }
  });
  test("midnight is 00:xx, never 24:xx", () => {
    expect(formatClock(c(0, 5), "en-US")).toBe("00:05");
    expect(formatClock(c(0, 0), "en-US")).toBe("00:00");
    expect(formatClock(c(23, 59), "en-US")).toBe("23:59");
    expect(formatClock(c(12, 0), "en-US")).toBe("12:00");
  });
  test("the weekday and date forms carry the same clock", () => {
    expect(formatStart(at(2026, 11, 18, 0, 5), at(2026, 11, 19, 15, 30), "en-US")).toMatch(/^Wed 00:05$/);
    expect(formatStart(at(2026, 11, 1, 23, 8), at(2026, 11, 19, 15, 30), "en-US")).toMatch(/, 23:08$/);
  });
});

describe("doneRow started", () => {
  const NOWD = at(2026, 11, 19, 15, 0);
  test("today's push shows just the time; an earlier day is date-aware", () => {
    const today = { id: "t", text: "t", ts: at(2026, 11, 19, 0, 5), at: at(2026, 11, 19, 1, 0), removed: true };
    const earlier = { id: "e", text: "e", ts: at(2026, 11, 18, 16, 50), at: at(2026, 11, 19, 9, 0), removed: true };
    expect(doneRow(today, [today], "en-US", NOWD).start).toBe("00:05");
    expect(doneRow(earlier, [earlier], "en-US", NOWD).start).toBe("Wed 16:50");
  });
  test("an item with no end time still has a real start", () => {
    const old = { id: "o", text: "o", ts: at(2026, 11, 19, 7, 0), removed: true };
    expect(doneRow(old, [old], "en-US", NOWD)).toEqual({ start: "07:00", end: "\u2014", duration: "\u2014" });
  });
});

// ---- timeline: every push and pop as a row, with running totals ----
const tl = (x, all) => timeline(x, all);
const kinds = (t) => t.rows.map((r) => r.kind);
const sum = (t) => t.rows.map((r) => [r.t, r.kind, r.onTop, r.wall]);

describe("timeline", () => {
  test("the worked example: pushed 0, interrupted 30-45, popped 90", () => {
    const x = it("x", 0, 90);
    const y = it("pay super", 30, 45);
    const t = tl(x, [x, y]);
    expect(sum(t)).toEqual([
      [B, "pushed", 0, 0],
      [B + 30 * MIN, "paused", 30 * MIN, 30 * MIN],
      [B + 45 * MIN, "back", 30 * MIN, 45 * MIN],
      [B + 90 * MIN, "popped", 75 * MIN, 90 * MIN],
    ]);
    expect(t.rows[1].who).toBe("pay super");
    expect(t.rows[2].who).toBe("pay super");
    expect(t.onTop).toBe(75 * MIN);
    expect(t.wall).toBe(90 * MIN);
  });

  test("nothing above it: pushed and popped only", () => {
    const x = it("x", 0, 30);
    expect(kinds(tl(x, [x]))).toEqual(["pushed", "popped"]);
  });

  test("nested pushes make one pause and one return, naming the first pusher and the last to end", () => {
    const x = it("x", 0, 60);
    const b = it("b", 10, 50);
    const c = it("c", 20, 30);
    const t = tl(x, [x, b, c]);
    expect(kinds(t)).toEqual(["pushed", "paused", "back", "popped"]);
    expect(t.rows[1].who).toBe("b");
    expect(t.rows[2].who).toBe("b");
    expect(t.onTop).toBe(20 * MIN);
  });

  test("a drop from the middle: the item above ends later, so the return names it", () => {
    const x = it("x", 0, 60);
    const b = it("b", 10, 30);
    const c = it("c", 20, 40); // pushed over b, still there after b went
    const t = tl(x, [x, b, c]);
    expect(kinds(t)).toEqual(["pushed", "paused", "back", "popped"]);
    expect(t.rows[1].who).toBe("b");
    expect(t.rows[2].who).toBe("c");
  });

  test("two separate excursions", () => {
    const x = it("x", 0, 60);
    const a = it("a", 10, 20);
    const b = it("b", 30, 45);
    expect(kinds(tl(x, [x, a, b]))).toEqual(["pushed", "paused", "back", "paused", "back", "popped"]);
  });

  test("dropped from underneath an item that is still live: no return, ends as dropped", () => {
    const x = it("x", 0, 40);
    const y = it("y", 10, undefined, false);
    const t = tl(x, [x, y]);
    expect(kinds(t)).toEqual(["pushed", "paused", "dropped"]);
    expect(t.rows[2].who).toBe("y");
    expect(t.onTop).toBe(10 * MIN);
    expect(t.wall).toBe(40 * MIN);
  });

  test("a swap: the push at the instant of the pop is not an interruption", () => {
    const x = it("x", 0, 30);
    const y = it("y", 30, 50);
    expect(kinds(tl(x, [x, y]))).toEqual(["pushed", "popped"]);
  });

  test("an item pushed and popped at the very instant another is pushed leaves no zero-length noise", () => {
    const x = it("x", 0, 60);
    const a = it("a", 10, 20);
    const b = it("b", 20, 30); // pushed the moment a popped: x never came back between them
    const t = tl(x, [x, a, b]);
    expect(kinds(t)).toEqual(["pushed", "paused", "back", "popped"]);
    expect(t.rows[2].t).toBe(B + 30 * MIN);
    expect(t.rows[2].who).toBe("b");
  });

  test("the item above ends at the very instant this one does: it still paused, came back, and was popped", () => {
    const x = it("x", 0, 60);
    const y = it("y", 30, 60);
    const t = tl(x, [x, y]);
    expect(kinds(t)).toEqual(["pushed", "paused", "back", "popped"]);
    expect(t.onTop).toBe(30 * MIN);
    expect(t.rows.at(-1).onTop).toBe(30 * MIN);
  });

  test("identical timestamps and zero-length items", () => {
    const x = it("x", 5, 5);
    expect(sum(tl(x, [x]))).toEqual([[B + 5 * MIN, "pushed", 0, 0], [B + 5 * MIN, "popped", 0, 0]]);
    const y = it("y", 5, 30);
    const z = it("z", 5, 10);
    expect(tl(y, [y, z]).onTop).toBe(25 * MIN);
  });

  test("an item started from Later is an ordinary push", () => {
    const x = it("x", 0, 30);
    const later = it("s-later", 5, 15);
    expect(tl(x, [x, later]).rows[1].who).toBe("s-later");
  });

  test("two items with the same text are told apart by id", () => {
    const x = { ...it("x", 0, 30), text: "same" };
    const y = { ...it("y", 5, 10), text: "same" };
    const t = tl(x, [x, y]);
    expect(t.rows[1].whoId).toBe("y");
    expect(t.rows[1].who).toBe("same");
  });

  test("no end time, a negative span, or a live item gives no timeline", () => {
    expect(tl(it("a", 0, undefined), [])).toBeNull();
    expect(tl(it("a", 10, 5), [])).toBeNull();
    expect(tl(it("a", 0, 10, false), [])).toBeNull();
  });

  test("a clock-skewed item above that ends before it begins adds nothing", () => {
    const x = it("x", 0, 30);
    const y = it("y", 20, 10);
    expect(kinds(tl(x, [x, y]))).toEqual(["pushed", "popped"]);
    expect(tl(x, [x, y]).onTop).toBe(30 * MIN);
  });
});

describe("timeline agrees with timeOnTop and with a brute-force oracle", () => {
  // A seeded generator, so a failure can be reproduced.
  const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  function simulate(seed) {
    const r = rng(seed);
    const items = [];
    const stack = [];
    let t = 100;
    let lastPush = 0;
    const n = 4 + Math.floor(r() * 30);
    for (let i = 0; i < n; i++) {
      t += r() < 0.2 ? 0 : 1 + Math.floor(r() * 6);
      const roll = r();
      if (roll < 0.5 || !stack.length) {
        t = Math.max(t, lastPush + 1);
        const x = { id: "i" + i, text: "t" + i, ts: t, at: t, removed: false };
        lastPush = t;
        items.push(x);
        stack.push(x);
      } else if (roll < 0.8) {
        const x = stack.pop();
        x.removed = true;
        x.at = t;
      } else {
        const x = stack.splice(Math.floor(r() * stack.length), 1)[0]; // dropped from anywhere
        x.removed = true;
        x.at = t;
      }
    }
    return items;
  }
  // Independent: at every unit of time, the top is the live item with the greatest push time.
  function oracle(x, items) {
    let n = 0;
    for (let u = x.ts; u < x.at; u++) {
      let top = null;
      for (const y of items) if (y.ts <= u && (!y.removed || u < y.at) && (!top || y.ts > top.ts)) top = y;
      if (top === x) n++;
    }
    return n;
  }

  test("over 400 generated stacks", () => {
    let checked = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const items = simulate(seed);
      for (const x of items.filter((i) => i.removed)) {
        const t = timeline(x, items);
        const msg = `seed ${seed} item ${x.id}`;
        expect(t, msg).not.toBeNull();
        expect(t.onTop, msg).toBe(oracle(x, items));
        expect(timeOnTop(x, items), msg).toBe(t.onTop);
        expect(t.wall, msg).toBe(x.at - x.ts);
        const rows = t.rows;
        expect(rows[0].kind, msg).toBe("pushed");
        expect(["popped", "dropped"], msg).toContain(rows.at(-1).kind);
        expect(rows.at(-1).onTop, msg).toBe(t.onTop);
        expect(rows.at(-1).wall, msg).toBe(t.wall);
        for (let i = 1; i < rows.length; i++) {
          expect(rows[i].t, msg).toBeGreaterThanOrEqual(rows[i - 1].t);
          expect(rows[i].onTop, msg).toBeGreaterThanOrEqual(rows[i - 1].onTop);
          expect(rows[i].wall, msg).toBeGreaterThanOrEqual(rows[i - 1].wall);
          expect(rows[i].onTop, msg).toBeLessThanOrEqual(rows[i].wall);
          // no zero-length pause: a pause is followed by a return strictly later, or by the end
          if (rows[i - 1].kind === "paused" && rows[i].kind === "back") expect(rows[i].t, msg).toBeGreaterThan(rows[i - 1].t);
        }
        const mid = rows.slice(1, -1).map((r) => r.kind);
        mid.forEach((k, i) => expect(k, msg).toBe(i % 2 === 0 ? "paused" : "back"));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe("detailsFor: the words in the panel", () => {
  const D = at(2026, 11, 19, 9, 0);
  const m = (n) => D + n * MIN;
  const mk = (id, text, a, b, removed = true) => ({ id, text, ts: m(a), at: b == null ? undefined : m(b), removed, seq: 1 });
  const NOWD = at(2026, 11, 19, 15, 0);

  test("the worked example, exactly", () => {
    const x = mk("x", "Write report", 0, 90);
    const y = mk("y", "Pay super", 30, 45);
    const d = detailsFor(x, [x, y], NOWD, "en-US");
    expect(d.title).toBe("Write report");
    expect(d.summary).toBe("Started 09:00 \u00b7 Ended 10:30");
    expect(d.rows).toEqual([
      { time: "09:00", what: "Pushed", onTop: "0 min", wall: "0 min" },
      { time: "09:30", what: "Paused: Pay super pushed", onTop: "30 min", wall: "30 min" },
      { time: "09:45", what: "Back on top: Pay super ended", onTop: "30 min", wall: "45 min" },
      { time: "10:30", what: "Popped", onTop: "1 h 15 min", wall: "1 h 30 min" },
    ]);
  });

  test("dropped from underneath something still on top", () => {
    const x = mk("x", "Under", 0, 40);
    const y = mk("y", "Above", 10, undefined, false);
    const d = detailsFor(x, [x, y], NOWD, "en-US");
    expect(d.rows.at(-1)).toEqual({ time: "09:40", what: "Dropped: Above still on top", onTop: "10 min", wall: "40 min" });
  });

  test("an item pushed on an earlier day shows dated times", () => {
    const x = { id: "x", text: "Old", ts: at(2026, 11, 18, 16, 50), at: at(2026, 11, 19, 9, 0), removed: true };
    const d = detailsFor(x, [x], NOWD, "en-US");
    expect(d.summary).toBe("Started Wed 16:50 \u00b7 Ended 09:00");
    expect(d.rows[0].time).toBe("Wed 16:50");
    expect(d.rows.at(-1).wall).toBe("16 h 10 min");
  });

  test("the final On top equals the Done today row's duration", () => {
    const x = mk("x", "x", 0, 90);
    const y = mk("y", "y", 30, 45);
    expect(detailsFor(x, [x, y], NOWD, "en-US").rows.at(-1).onTop).toBe(doneRow(x, [x, y], "en-US", NOWD).duration);
  });

  test("another item's text is shown in its label form, not as a raw address", () => {
    const x = mk("x", "Write report", 0, 90);
    const y = mk("y", "Email Ben vellum://note/abc/Forward?vault=Q", 30, 45);
    const d = detailsFor(x, [x, y], NOWD, "en-US");
    expect(d.rows[1].what).toBe("Paused: Email Ben Vellum \u2197 pushed");
    expect(d.rows[2].what).toBe("Back on top: Email Ben Vellum \u2197 ended");
    expect(d.title).toBe("Write report"); // the title is rendered with real links by the page
  });

  test("nothing to show for an item with no end time", () => {
    expect(detailsFor(mk("x", "x", 0, null), [], NOWD, "en-US")).toBeNull();
  });
});
