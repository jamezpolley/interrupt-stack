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

// The one-word header status. The full message (statusLabel) goes in the panel and the button's aria-label.
export function shortStatus({ state, error }) {
  if (state === "local") return "Local only";
  if (state === "synced") return "Synced";
  if (state === "syncing") return "Syncing";
  switch (error?.kind) {
    case "sign-in": return "Sign-in";
    case "server-error":
    case "client-error": return `Error ${error.status}`;
    case "unreachable": return "Unreachable";
    case "bad-reply": return "Error";
    default: return "Offline"; // no-network, or no known kind
  }
}

/** The full plain-language message with no unsent count: the heading of the Debug panel. */
export const statusMessage = ({ state, error }) => statusLabel({ state, pending: 0, error });

export const unsentWords = (n) => (n > 0 ? `${n} ${n === 1 ? "change" : "changes"} waiting to sync` : "");

/** The Debug panel offers a Sign in button for a sign-in failure only, and never where there is no server to sign in to. */
export const offersSignIn = (error, local) => !local && error?.kind === "sign-in";
