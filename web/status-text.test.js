import { describe, expect, test } from "bun:test";
import { shortStatus, statusLabel, statusMessage, unsentWords } from "./status-text.js";

describe("statusLabel", () => {
  test("states without a failure", () => {
    expect(statusLabel({ state: "local", pending: 0 })).toBe("Local only");
    expect(statusLabel({ state: "synced", pending: 0 })).toBe("Synced");
    expect(statusLabel({ state: "syncing", pending: 2 })).toBe("Syncing");
  });

  test("each failure kind says what happened", () => {
    const l = (error) => statusLabel({ state: "offline", pending: 0, error });
    expect(l({ kind: "no-network" })).toBe("No network");
    expect(l({ kind: "unreachable" })).toBe("Server unreachable");
    expect(l({ kind: "sign-in" })).toBe("Sign-in needed");
    expect(l({ kind: "server-error", status: 502 })).toBe("Server error 502");
    expect(l({ kind: "client-error", status: 404 })).toBe("Server refused the request, 404");
    expect(l({ kind: "bad-reply" })).toBe("Unexpected reply from server");
  });

  test("unsent changes are appended", () => {
    expect(statusLabel({ state: "offline", pending: 3, error: { kind: "sign-in" } })).toBe("Sign-in needed, 3 unsent");
  });

  test("a rejected change", () => {
    expect(statusLabel({ state: "error", pending: 1, error: { kind: "client-error", status: 400 } })).toBe("Server refused a change, 400, 1 unsent");
  });

  test("offline with no known kind falls back to Offline", () => {
    expect(statusLabel({ state: "offline", pending: 0 })).toBe("Offline");
    expect(statusLabel({ state: "offline", pending: 2 })).toBe("Offline, 2 unsent");
  });

  test("the static version never shows a failure even if one is passed", () => {
    expect(statusLabel({ state: "local", pending: 0, error: { kind: "unreachable" } })).toBe("Local only");
  });
});

describe("shortStatus: the one-word header status", () => {
  const w = (error, state = "offline") => shortStatus({ state, pending: 0, error });
  test("healthy and static states are unchanged", () => {
    expect(shortStatus({ state: "synced", pending: 0 })).toBe("Synced");
    expect(shortStatus({ state: "local", pending: 0 })).toBe("Local only");
    expect(shortStatus({ state: "syncing", pending: 3 })).toBe("Syncing");
    expect(shortStatus({ state: "local", pending: 0, error: { kind: "unreachable" } })).toBe("Local only");
  });
  test("every failure kind has a short word", () => {
    expect(w({ kind: "sign-in" })).toBe("Sign-in");
    expect(w({ kind: "server-error", status: 502 })).toBe("Error 502");
    expect(w({ kind: "client-error", status: 404 })).toBe("Error 404");
    expect(w({ kind: "client-error", status: 400 }, "error")).toBe("Error 400");
    expect(w({ kind: "no-network" })).toBe("Offline");
    expect(w({ kind: "unreachable" })).toBe("Unreachable");
    expect(w({ kind: "bad-reply" })).toBe("Error");
    expect(w(undefined)).toBe("Offline");
    expect(w({ kind: "something-new" })).toBe("Offline");
  });
  test("the unsent count is not part of the word", () => {
    expect(shortStatus({ state: "offline", pending: 5, error: { kind: "sign-in" } })).toBe("Sign-in");
  });
});

describe("panel text", () => {
  test("statusMessage is the full message without the unsent count", () => {
    expect(statusMessage({ state: "offline", pending: 4, error: { kind: "sign-in" } })).toBe("Sign-in needed");
    expect(statusMessage({ state: "offline", pending: 0, error: { kind: "server-error", status: 502 } })).toBe("Server error 502");
    expect(statusMessage({ state: "offline", pending: 0, error: { kind: "no-network" } })).toBe("No network");
    expect(statusMessage({ state: "error", pending: 1, error: { kind: "client-error", status: 400 } })).toBe("Server refused a change, 400");
  });
  test("unsentWords", () => {
    expect(unsentWords(0)).toBe("");
    expect(unsentWords(1)).toBe("1 change waiting to sync");
    expect(unsentWords(3)).toBe("3 changes waiting to sync");
  });
});
