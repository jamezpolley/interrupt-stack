import { describe, expect, test } from "bun:test";
import { statusLabel } from "./status-text.js";

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
