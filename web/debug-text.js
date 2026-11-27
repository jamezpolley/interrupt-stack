// Turns the raw detail of a failed sync call (sync.lastFailure()) into text for the Debug panel. Pure.
export function formatFailure(f) {
  const lines = [];
  lines.push(`Time: ${new Date(f.at).toISOString()}`);
  if (f.request) lines.push(`Request: ${f.request.method} ${f.request.url}`);
  lines.push(`navigator.onLine: ${f.online}`);
  if (f.error) {
    lines.push(`Error: ${f.error.name}: ${f.error.message}`);
  }
  const r = f.response;
  if (r) {
    lines.push(`Response: ${r.status} ${r.statusText}`.trimEnd());
    lines.push(`type: ${r.type}`);
    lines.push(`redirected: ${r.redirected}`);
    lines.push(`url: ${r.url}`);
    if (r.type === "opaqueredirect") lines.push("The server answered with a redirect. The browser hides the location, status, headers and body of a redirect the app did not follow.");
    if (r.headers.length) lines.push("Headers:", ...r.headers.map(([k, v]) => `  ${k}: ${v}`));
    if (r.body != null && r.body !== "") {
      let body = r.body;
      if (r.headers.some(([k, v]) => k.toLowerCase() === "content-type" && /json/i.test(v))) {
        try {
          body = JSON.stringify(JSON.parse(body), null, 2);
        } catch {}
      }
      lines.push("Body:", body);
      if (r.bodyTruncated) lines.push("(truncated)");
    } else if (r.type !== "opaqueredirect") lines.push("Body: (empty)");
  }
  return lines.join("\n");
}
