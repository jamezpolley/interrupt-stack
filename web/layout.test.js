import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const at = (s) => html.indexOf(s);

describe("page layout", () => {
  test("the Undo bar sits under the Working-on card and above the rest of the stack", () => {
    expect(at('id="now-wrap"')).toBeGreaterThan(-1);
    expect(at('id="toast"')).toBeGreaterThan(at('id="now-wrap"'));
    expect(at('id="toast"')).toBeLessThan(at('id="under-wrap"'));
    expect(html.split('id="toast"').length).toBe(2);
  });
  test("the second Push button says Swap", () => {
    expect(html).toMatch(/id="swap-btn"[^>]*>Swap<\/button>/);
    expect(html).not.toMatch(/&amp; Pop/);
  });
  test("Close is the default in the details, not Push again", () => {
    expect(html).toMatch(/class="primary" id="details-close"/);
    expect(html).toMatch(/<button type="button" id="details-again">/);
    expect(html).toMatch(/id="details-close" autofocus/);
  });
});
