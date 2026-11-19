import { describe, expect, test } from "bun:test";
import { displayText, linkify } from "./links.js";

const VELLUM = "vellum://note/sRoTnKcja0ay/Forward-email-from-Emanuele-Muratore-to-Ben?vault=NQfSGsXwYMeC";
const text = (t) => ({ type: "text", text: t });
const link = (href, label, title = href) => ({ type: "link", href, label, title, web: /^https?:/i.test(href) });

describe("linkify: James's example", () => {
  const input = `Email from Emanuele to Ben ${VELLUM}`;
  test("a custom-scheme address becomes a link labelled with its scheme", () => {
    expect(linkify(input)).toEqual([text("Email from Emanuele to Ben "), link(VELLUM, "Vellum")]);
  });
  test("displayed as plain text it reads 'Email from Emanuele to Ben Vellum ↗'", () => {
    expect(displayText(input)).toBe("Email from Emanuele to Ben Vellum \u2197");
  });
});

describe("linkify: what becomes a link", () => {
  test("two links in one text", () => {
    expect(linkify("a obsidian://open?vault=x then https://www.github.com/a/b done")).toEqual([
      text("a "),
      link("obsidian://open?vault=x", "Obsidian"),
      text(" then "),
      link("https://www.github.com/a/b", "github.com"),
      text(" done"),
    ]);
  });
  test("at the very start and the very end", () => {
    expect(linkify("zotero://select/items/1 read")).toEqual([link("zotero://select/items/1", "Zotero"), text(" read")]);
    expect(linkify("read zotero://select/items/1")).toEqual([text("read "), link("zotero://select/items/1", "Zotero")]);
    expect(linkify("https://example.com/")).toEqual([link("https://example.com/", "example.com")]);
  });
  test("http and https, with and without www", () => {
    expect(linkify("http://example.com/x")[0]).toMatchObject({ label: "example.com" });
    expect(linkify("https://www.example.com/x")[0]).toMatchObject({ label: "example.com" });
    expect(linkify("https://wwwexample.com/x")[0]).toMatchObject({ label: "wwwexample.com" });
    expect(linkify("https://sub.www.example.com/x")[0]).toMatchObject({ label: "sub.www.example.com" });
  });
  test("an uppercase scheme", () => {
    const s = linkify("see HTTPS://Example.com/A and VELLUM://note/x");
    expect(s[1]).toMatchObject({ type: "link", label: "example.com" });
    expect(s[3]).toMatchObject({ type: "link", label: "Vellum" });
  });
  test("a query string and a fragment stay in the address", () => {
    const a = "https://example.com/p?a=1&b=2#frag";
    expect(linkify(`x ${a}`)).toEqual([text("x "), link(a, "example.com")]);
  });
  test("the full address as written is the title", () => {
    expect(linkify("HTTPS://Example.com")[0].title).toBe("HTTPS://Example.com");
  });
});

describe("linkify: trailing punctuation", () => {
  test("a sentence full stop, comma, and friends are not part of the address", () => {
    expect(linkify("see https://example.com/a.")).toEqual([text("see "), link("https://example.com/a", "example.com"), text(".")]);
    for (const p of [",", ";", ":", "!", "?", "'", '"', "...", ".)"]) {
      const s = linkify(`go https://example.com/a${p}`);
      expect(s[1].href, p).toBe("https://example.com/a");
      expect(s.at(-1), p).toEqual(text(p));
    }
  });
  test("an unbalanced closing bracket is left out", () => {
    expect(linkify("(https://example.com/a)")).toEqual([text("("), link("https://example.com/a", "example.com"), text(")")]);
    expect(linkify("[https://example.com/a]")[2]).toEqual(text("]"));
    expect(linkify("{https://example.com/a}")[2]).toEqual(text("}"));
  });
  test("balanced parentheses inside the address are kept", () => {
    expect(linkify("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual([link("https://en.wikipedia.org/wiki/Foo_(bar)", "en.wikipedia.org")]);
    expect(linkify("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([text("("), link("https://en.wikipedia.org/wiki/Foo_(bar)", "en.wikipedia.org"), text(")")]);
    expect(linkify("https://en.wikipedia.org/wiki/Foo_(bar).")[1]).toEqual(text("."));
  });
});

describe("linkify: what must never become a link", () => {
  test.each([
    ["javascript://%0aalert(1)"],
    ["JavaScript:alert(1)"],
    ["JAVASCRIPT://example.com/%0aalert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["data://text/html,hello"],
    ["file:///etc/passwd"],
    ["FILE://host/share"],
    ["vbscript://x/y"],
    ["blob://x/y"],
    ["about://blank"],
    ["see javascript://x/%0aalert(1) now"],
  ])("%s stays plain text", (t) => {
    expect(linkify(t).every((s) => s.type === "text")).toBe(true);
    expect(linkify(t).map((s) => s.text).join("")).toBe(t);
  });
  test("markup in the text is only ever text", () => {
    const t = "<b>bold</b> <img src=x onerror=alert(1)> done";
    expect(linkify(t)).toEqual([text(t)]);
    expect(displayText(t)).toBe(t);
  });
  test("markup next to a real link stays literal text", () => {
    expect(linkify("<i>x</i> https://example.com/a")).toEqual([text("<i>x</i> "), link("https://example.com/a", "example.com")]);
  });
  test("empty and whitespace-only text", () => {
    expect(linkify("")).toEqual([]);
    expect(linkify("   ")).toEqual([text("   ")]);
    expect(linkify(undefined)).toEqual([]);
    expect(linkify(null)).toEqual([]);
  });
  test("'://' alone, a scheme with nothing after it, and an address that does not parse", () => {
    expect(linkify("://")).toEqual([text("://")]);
    expect(linkify("a :// b")).toEqual([text("a :// b")]);
    expect(linkify("vellum://")).toEqual([text("vellum://")]);
    expect(linkify("vellum:// later")).toEqual([text("vellum:// later")]);
    expect(linkify("vellum://.")).toEqual([text("vellum://.")]);
    expect(linkify("https://")).toEqual([text("https://")]);
    expect(linkify("http://[bad host")).toEqual([text("http://[bad host")]);
  });
  test("text with no links is returned byte-for-byte as one segment", () => {
    for (const t of ["Plain task", "  spaced  out  ", "tabs\tand\nnewlines", "emoji \u{1F600} and \u00e9", "a:b c://", "50% done; see (page 2)"]) {
      expect(linkify(t)).toEqual([text(t)]);
    }
  });
  test("joining the segments' text and addresses rebuilds the original", () => {
    const t = "a https://example.com/x, b vellum://n/1 (c).";
    const rebuilt = linkify(t).map((s) => (s.type === "text" ? s.text : s.title)).join("");
    expect(rebuilt).toBe(t);
  });
});

describe("displayText", () => {
  test("replaces each link with its label and an arrow, leaves the rest", () => {
    expect(displayText("a https://www.example.com/x, b vellum://n/1.")).toBe("a example.com \u2197, b Vellum \u2197.");
  });
  test("no link, no change", () => {
    expect(displayText("Plain task")).toBe("Plain task");
  });
});
