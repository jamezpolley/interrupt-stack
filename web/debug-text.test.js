import { describe, expect, test } from "bun:test";
import { formatFailure } from "./debug-text.js";

describe("formatFailure", () => {
  const base = { at: Date.UTC(2026, 10, 19, 1, 2, 3), request: { method: "GET", url: "/api/items?since=0" }, online: true };

  test("network failure", () => {
    const t = formatFailure({ ...base, error: { name: "TypeError", message: "Failed to fetch" } });
    expect(t).toContain("GET /api/items?since=0");
    expect(t).toContain("TypeError: Failed to fetch");
    expect(t).toContain("navigator.onLine: true");
    expect(t).not.toContain("No response was received");
  });

  test("response with headers and plain body", () => {
    const t = formatFailure({ ...base, response: { status: 502, statusText: "Bad Gateway", type: "basic", redirected: false, url: "http://h/api/items?since=0", headers: [["content-type", "text/html"]], body: "<html>x</html>" } });
    expect(t).toContain("502 Bad Gateway");
    expect(t).toContain("type: basic");
    expect(t).toContain("redirected: false");
    expect(t).toContain("url: http://h/api/items?since=0");
    expect(t).toContain("content-type: text/html");
    expect(t).toContain("<html>x</html>");
  });

  test("JSON bodies are pretty-printed", () => {
    const t = formatFailure({ ...base, response: { status: 400, statusText: "", type: "basic", redirected: false, url: "", headers: [["content-type", "application/json"]], body: '{"a":1}' } });
    expect(t).toContain('{\n  "a": 1\n}');
  });

  test("an opaque redirect shows its type and no explanation", () => {
    const t = formatFailure({ ...base, response: { status: 0, statusText: "", type: "opaqueredirect", redirected: false, url: "", headers: [], body: null } });
    expect(t).toContain("opaqueredirect");
    expect(t).not.toMatch(/hides the location/i);
  });

  test("truncation is mentioned", () => {
    const t = formatFailure({ ...base, response: { status: 500, statusText: "", type: "basic", redirected: false, url: "", headers: [], body: "xx", bodyTruncated: true } });
    expect(t).toMatch(/truncated/i);
  });
});
