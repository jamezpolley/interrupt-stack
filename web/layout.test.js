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
  test("the buttons along the bottom of the details card are compact and do not stretch; Close is the bigger one", () => {
    const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.details-foot button\{flex:0 0 auto\}/);
    expect(css).not.toMatch(/\.details-foot button\{flex:1 1 auto\}/);
    const foot = Number(css.match(/\.details-foot button\{min-height:(\d+)px/)[1]);
    const close = Number(css.match(/\.details \.debug-actions button\{min-height:(\d+)px/)[1]);
    expect(foot).toBeLessThanOrEqual(36);
    expect(close).toBeGreaterThan(foot);
  });
  test("while editing, the details table keeps a width where the names can be read and scrolls sideways", () => {
    const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
    const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
    expect(css).toMatch(/\.details\.editing table\.timeline\{min-width:\d+rem\}/);
    expect(css).toMatch(/\.details\.editing \.timeline \.w\{min-width:\d+rem\}/);
    expect(css).toMatch(/\.details-scroll\{overflow:auto/);
    expect(app).toMatch(/classList\.toggle\("editing", !!ed\)/);
  });
});
