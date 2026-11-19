// Which pane is showing on a phone, and what the header pill should say. Pure, so it is tested without a browser.

/** The board scrolls sideways between two panes; past half a pane means the second (the queue) is showing. */
export function currentPane(scrollLeft, paneWidth) {
  if (!Number.isFinite(scrollLeft) || !(paneWidth > 0) || scrollLeft < 0) return "stack";
  return scrollLeft > paneWidth / 2 ? "queue" : "stack";
}

/** The pill always points at the other pane. `label` is the queue's on-screen name. */
export function pillFor({ pane, count, label }) {
  if (pane === "queue") return { text: "‹ Stack", aria: "Show the stack", target: "stack" };
  const n = Number(count) > 0 ? Number(count) : 0;
  return {
    text: n ? `${label} ${n} ›` : `${label} ›`,
    aria: n ? `Show ${label}, ${n} ${n === 1 ? "item" : "items"}` : `Show ${label}`,
    target: "queue",
  };
}
