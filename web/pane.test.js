import { describe, expect, test } from "bun:test";
import { currentPane, pillFor } from "./pane.js";

describe("currentPane", () => {
  test("stack until the board is scrolled past half a pane", () => {
    expect(currentPane(0, 390)).toBe("stack");
    expect(currentPane(150, 390)).toBe("stack");
    expect(currentPane(200, 390)).toBe("queue");
    expect(currentPane(382, 390)).toBe("queue");
  });
  test("falls back to the stack for anything unusable", () => {
    expect(currentPane(undefined, 390)).toBe("stack");
    expect(currentPane(NaN, 390)).toBe("stack");
    expect(currentPane(100, 0)).toBe("stack");
    expect(currentPane(-5, 390)).toBe("stack");
  });
});

describe("pillFor", () => {
  test("on the stack it names the other pane with its count", () => {
    expect(pillFor({ pane: "stack", count: 4, label: "Later" })).toEqual({ text: "Later 4 ›", aria: "Show Later, 4 items", target: "queue" });
  });
  test("no count when empty or singular wording for one", () => {
    expect(pillFor({ pane: "stack", count: 0, label: "Later" })).toEqual({ text: "Later ›", aria: "Show Later", target: "queue" });
    expect(pillFor({ pane: "stack", count: 1, label: "Later" }).aria).toBe("Show Later, 1 item");
  });
  test("on the queue pane it goes back to the stack", () => {
    expect(pillFor({ pane: "queue", count: 4, label: "Later" })).toEqual({ text: "‹ Stack", aria: "Show the stack", target: "stack" });
  });
});
