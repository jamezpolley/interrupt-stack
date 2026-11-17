import { describe, expect, test } from "bun:test";
import { createEventStream } from "./events.js";

class FakeSource {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.listeners = {};
    this.closed = false;
    FakeSource.all.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type, ev = {}) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
    if (type === "error") this.onerror?.(ev);
  }
}

function setup(opts = {}) {
  FakeSource.all = [];
  const timers = [];
  const seqs = [];
  const stream = createEventStream({
    url: "/api/events",
    make: (u) => new FakeSource(u),
    onSeq: () => seqs.push(1),
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    cancel: (t) => void (t.cancelled = true),
    baseMs: 1000,
    maxMs: 30000,
    ...opts,
  });
  const live = () => timers.filter((t) => !t.cancelled);
  const current = () => FakeSource.all[FakeSource.all.length - 1];
  return { stream, timers, live, seqs, current };
}

describe("event stream", () => {
  test("a seq event calls onSeq", () => {
    const { stream, current, seqs } = setup();
    stream.connect();
    current().emit("seq");
    expect(seqs).toHaveLength(1);
  });

  test("a stream the browser has closed after an error is reconnected after a delay", () => {
    const { stream, current, live } = setup();
    stream.connect();
    current().readyState = 2; // e.g. the proxy answered the reconnect with a 502
    current().emit("error");
    expect(live()).toHaveLength(1);
    expect(live()[0].ms).toBe(1000);
    live()[0].fn();
    expect(FakeSource.all).toHaveLength(2);
  });

  test("an error while the browser is still retrying itself schedules nothing", () => {
    const { stream, current, live } = setup();
    stream.connect();
    current().readyState = 0; // CONNECTING: the browser retries on its own
    current().emit("error");
    expect(live()).toHaveLength(0);
  });

  test("repeated failures back off and cap at the maximum", () => {
    const { stream, current, live } = setup();
    stream.connect();
    const delays = [];
    for (let i = 0; i < 8; i++) {
      current().readyState = 2;
      current().emit("error");
      delays.push(live().at(-1).ms);
      live().at(-1).fn();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  test("a successful open resets the backoff", () => {
    const { stream, current, live } = setup();
    stream.connect();
    for (let i = 0; i < 3; i++) {
      current().readyState = 2;
      current().emit("error");
      live().at(-1).fn();
    }
    current().readyState = 1;
    current().emit("open");
    current().readyState = 2;
    current().emit("error");
    expect(live().at(-1).ms).toBe(1000);
  });

  test("two errors before the timer fires schedule one reconnect", () => {
    const { stream, current, live } = setup();
    stream.connect();
    current().readyState = 2;
    current().emit("error");
    current().emit("error");
    expect(live()).toHaveLength(1);
  });

  test("connect() replaces an open stream and cancels a pending reconnect", () => {
    const { stream, current, live } = setup();
    stream.connect();
    const first = current();
    first.readyState = 2;
    first.emit("error");
    expect(live()).toHaveLength(1);
    stream.connect(); // e.g. the page became visible again
    expect(live()).toHaveLength(0);
    expect(first.closed).toBe(true);
    expect(FakeSource.all).toHaveLength(2);
  });

  test("close() stops the stream and any pending reconnect", () => {
    const { stream, current, live } = setup();
    stream.connect();
    current().readyState = 2;
    current().emit("error");
    stream.close();
    expect(live()).toHaveLength(0);
    expect(current().closed).toBe(true);
  });
});
