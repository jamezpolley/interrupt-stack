// The words for the sync status shown in the header. Pure, so it can be tested without a browser.
const FAILURES = {
  "no-network": () => "No network",
  unreachable: () => "Server unreachable",
  "sign-in": () => "Sign-in needed",
  "server-error": (e) => `Server error ${e.status}`,
  "client-error": (e) => `Server refused the request, ${e.status}`,
  "bad-reply": () => "Unexpected reply from server",
};

export function statusLabel({ state, pending, error }) {
  if (state === "local") return "Local only";
  if (state === "synced") return "Synced";
  if (state === "syncing") return "Syncing";
  const unsent = pending ? `, ${pending} unsent` : "";
  if (state === "error" && error?.kind === "client-error") return `Server refused a change, ${error.status}${unsent}`;
  if (state === "error") return `Sync problem${unsent}`;
  const kind = FAILURES[error?.kind];
  return (kind ? kind(error) : "Offline") + unsent;
}
