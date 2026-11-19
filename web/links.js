// Links inside a task's text. Display only: the stored text is never changed. `linkify` is pure; `renderLinked` builds
// DOM with createElement and text nodes only (never innerHTML), so nothing in a task's text can be treated as markup.

export const ARROW = "↗"; // the "external link" arrow

// scheme://... : scheme per RFC 3986 (letters, digits, + . -), then the rest up to whitespace.
const ADDRESS = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g;
// Never linked, whatever the case or however written (javascript://... included).
const BLOCKED = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:"]);
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"']);
const PAIRS = { ")": "(", "]": "[", "}": "{" };

const count = (s, ch) => s.split(ch).length - 1;

// Drops trailing punctuation that is almost never part of an address, and a closing bracket with no opener inside it.
function trimAddress(s) {
  for (;;) {
    const last = s.at(-1);
    if (TRAILING.has(last)) s = s.slice(0, -1);
    else if (PAIRS[last] && count(s, last) > count(s, PAIRS[last])) s = s.slice(0, -1);
    else return s;
  }
}

function toLink(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  if (BLOCKED.has(scheme)) return null;
  const web = scheme === "http:" || scheme === "https:";
  if (!url.host && url.pathname.length < 2) return null; // nothing after the scheme
  const name = scheme.slice(0, -1);
  const label = web ? url.hostname.replace(/^www\./i, "") : name.charAt(0).toUpperCase() + name.slice(1);
  if (!label) return null;
  return { type: "link", href: url.href, label, title: address, web };
}

/** Splits text into segments: {type:"text", text} and {type:"link", href, label, title, web}. Rejoined, they rebuild it. */
export function linkify(text) {
  const s = typeof text === "string" ? text : "";
  if (!s) return [];
  const out = [];
  let at = 0;
  for (const m of s.matchAll(ADDRESS)) {
    const address = trimAddress(m[0]);
    const link = address ? toLink(address) : null;
    if (!link) continue;
    if (m.index > at) out.push({ type: "text", text: s.slice(at, m.index) });
    out.push(link);
    at = m.index + address.length;
  }
  if (at < s.length || !out.length) out.push({ type: "text", text: s.slice(at) });
  return out;
}

/** The text as people read it where links cannot be clickable: each link shown as "Label ↗". */
export function displayText(text) {
  return linkify(text).map((s) => (s.type === "link" ? `${s.label} ${ARROW}` : s.text)).join("");
}

/**
 * Fills `parent` with the text. With `links` (the default) each address is an <a>; otherwise the same "Label ↗" as plain
 * text (for places that are themselves buttons, where a link would be invalid).
 */
export function renderLinked(parent, text, { links = true } = {}) {
  parent.textContent = "";
  for (const seg of linkify(text)) {
    if (seg.type === "text") {
      parent.appendChild(document.createTextNode(seg.text));
    } else if (!links) {
      parent.appendChild(document.createTextNode(`${seg.label} ${ARROW}`));
    } else {
      const a = document.createElement("a");
      a.className = "tl";
      a.href = seg.href;
      a.title = seg.title;
      a.rel = "noopener noreferrer";
      if (seg.web) a.target = "_blank";
      a.append(seg.label);
      const arrow = document.createElement("span");
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = ` ${ARROW}`;
      a.appendChild(arrow);
      a.addEventListener("click", (ev) => ev.stopPropagation()); // only the navigation, never the surrounding row's handler
      parent.appendChild(a);
    }
  }
}
