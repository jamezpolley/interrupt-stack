import { createSync } from "./sync.js";
import { openStorage, QUEUE_DB_NAME } from "./idb.js";
import { createQueue, QUEUE_LABEL } from "./queue.js";
import { createEventStream } from "./events.js";
import { canUpdateNow, describeServerUpdate, forceRefresh, readVersionInfo, requestServerCheck, updateServerNow } from "./refresh.js";
import { completedToday } from "./today.js";
import { formatFailure } from "./debug-text.js";
import { statusLabel } from "./status-text.js";
import { LOCAL_ONLY } from "./config.js";
import { startInstallPrompt } from "./install.js";

const $ = (id) => document.getElementById(id);
const UNDO_MS = 15000;

let sync;
let queue;
let lastRemoved = null; // { it, kind: "stack" | "queue" }
let undoTimer = null;

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function showNote(text) {
  const n = $("note");
  n.textContent = text || "";
  n.hidden = !text;
}

const STORAGE_NOTE = "This device could not save your changes locally. Keep this page open until they sync.";
let storageNoteShown = false;

// One line for both structures: the worst state of the two, and every unsent change counted. The failure kind (and
// so the Debug link) comes from the stack, which records it; a failure only the Later sync has shows as plain
// "Offline" / "Sync problem".
function combinedStatus() {
  const st = sync.status();
  const parts = [st, queue?.status()].filter(Boolean);
  const state = ["error", "offline", "syncing", "synced"].find((x) => parts.some((p) => p.state === x)) ?? "local";
  return {
    state,
    pending: parts.reduce((n, p) => n + p.pending, 0),
    storageFailed: parts.some((p) => p.storageFailed),
    ...(st.state === state && st.error ? { error: st.error } : {}),
    ...(st.neverSynced ? { neverSynced: true } : {}),
  };
}
// When only the Later sync has just failed, have the stack try too: it knows how to name a failure (and keeps the
// detail the Debug link shows), and both use the same network, so it will normally fail for the same reason.
let queueWasOffline = false;
function updateStatus() {
  const q = queue?.status().state === "offline";
  if (q && !queueWasOffline && sync.status().state === "synced") sync.syncNow().catch(() => {});
  queueWasOffline = q;
  renderStatus(combinedStatus());
}

// An empty stack on a device that has never reached the server may just mean nothing has arrived yet.
let showingNeverSynced = false;

function renderStatus({ state, pending, storageFailed, error, neverSynced }) {
  const unsynced = !!neverSynced && (state === "offline" || state === "error");
  if (unsynced !== showingNeverSynced) {
    showingNeverSynced = unsynced;
    if (sync) render();
  }
  $("debug-btn").hidden = !(error && sync?.lastFailure());
  const label = statusLabel({ state, pending, error });
  $("status").textContent = label;
  $("dot").className = "dot" + (state === "synced" ? " ok" : state === "offline" || state === "error" ? " warn" : "");
  if (storageFailed && !storageNoteShown) showNote(STORAGE_NOTE);
  if (!storageFailed && storageNoteShown) showNote("");
  storageNoteShown = !!storageFailed;
}

function render() {
  const stack = sync.stack();
  $("depth").textContent = `${stack.length} deep`;

  const wrap = $("now-wrap");
  wrap.textContent = "";
  if (!stack.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = showingNeverSynced
      ? "Never synced, nothing to show yet"
      : "Empty.";
    wrap.appendChild(e);
  } else {
    const top = stack[0];
    const card = document.createElement("div");
    card.className = "now";
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = "Working on";
    const t = document.createElement("div");
    t.className = "now-text";
    t.textContent = top.text;
    const foot = document.createElement("div");
    foot.className = "now-foot";
    const a = document.createElement("span");
    a.className = "age";
    a.textContent = `Pushed ${ago(top.ts)}`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "primary";
    b.textContent = stack.length > 1 ? "Pop, back to previous" : "Pop, all done";
    b.addEventListener("click", () => removeItem(top));
    foot.append(a, b);
    card.append(l, t, foot);
    wrap.appendChild(card);
  }

  $("swap-btn").disabled = stack.length === 0;

  const done = completedToday(sync.allItems(), Date.now());
  const doneList = $("done");
  doneList.textContent = "";
  $("done-wrap").hidden = done.length === 0;
  for (const it of done) {
    const li = document.createElement("li");
    const tx = document.createElement("span");
    tx.className = "item-text";
    tx.textContent = it.text;
    const when = document.createElement("span");
    when.className = "item-age";
    when.textContent = new Date(it.at ?? it.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    li.append(tx, when);
    doneList.appendChild(li);
  }

  renderQueue();

  const under = $("under");
  under.textContent = "";
  const rest = stack.slice(1);
  $("under-wrap").hidden = rest.length === 0;
  rest.forEach((it, i) => {
    const li = document.createElement("li");
    const d = document.createElement("span");
    d.className = "depth";
    d.textContent = String(stack.length - 1 - i);
    const tx = document.createElement("span");
    tx.className = "item-text";
    tx.textContent = it.text;
    const ag = document.createElement("span");
    ag.className = "item-age";
    ag.textContent = ago(it.ts);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "drop";
    x.textContent = "Drop";
    x.setAttribute("aria-label", `Drop ${it.text} from the stack`);
    x.addEventListener("click", () => removeItem(it));
    li.append(d, tx, ag, x);
    under.appendChild(li);
  });
}

function renderQueue() {
  const items = queue ? queue.queue() : [];
  $("to-queue").textContent = items.length ? `${QUEUE_LABEL} ${items.length} \u203a` : `${QUEUE_LABEL} \u203a`;
  $("queue-empty").hidden = items.length > 0;
  const list = $("queue");
  list.textContent = "";
  for (const it of items) {
    const li = document.createElement("li");
    const tx = document.createElement("span");
    tx.className = "item-text";
    tx.textContent = it.text;
    const go = document.createElement("button");
    go.type = "button";
    go.className = "start";
    go.textContent = "Start";
    go.setAttribute("aria-label", `Start ${it.text}`);
    go.addEventListener("click", () => queue.promote(it.id));
    const x = document.createElement("button");
    x.type = "button";
    x.className = "drop";
    x.textContent = "Drop";
    x.setAttribute("aria-label", `Drop ${it.text} from ${QUEUE_LABEL}`);
    x.addEventListener("click", async () => {
      await queue.drop(it.id);
      offerUndo(it, "queue");
    });
    li.append(tx, go, x);
    list.appendChild(li);
  }
}

// Everything on screen that names the queue takes its words from QUEUE_LABEL (queue.js), so renaming is one line.
function labelQueue() {
  const name = QUEUE_LABEL;
  document.querySelectorAll("[data-queue-label]").forEach((el) => (el.textContent = name));
  document.querySelectorAll("[data-queue-aria]").forEach((el) => el.setAttribute("aria-label", name));
  $("queue-input").placeholder = "Something for later";
  $("queue-input").setAttribute("aria-label", `New task to add to ${name}`);
  $("queue-add").textContent = "Add";
  $("queue-add").setAttribute("aria-label", `Add to ${name}`);
  $("queue-empty").textContent = `Nothing in ${name}.`;
  $("to-queue").setAttribute("aria-label", `Show ${name}`);
  $("to-stack").setAttribute("aria-label", "Show the stack");
}

// On a phone the panes sit side by side and scroll sideways; the edge tabs do the same as a swipe.
function showPane(id) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  $(id).scrollIntoView({ behavior: reduce ? "auto" : "smooth", inline: "start", block: "nearest" });
}

function offerUndo(it, kind = "stack") {
  lastRemoved = { it, kind };
  $("toast-text").textContent = `Removed: ${it.text}`;
  $("toast").hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => {
    $("toast").hidden = true;
    lastRemoved = null;
  }, UNDO_MS);
}

async function removeItem(it) {
  await sync.remove(it.id);
  offerUndo(it);
}

async function undo() {
  const last = lastRemoved;
  if (!last) return;
  $("toast").hidden = true;
  lastRemoved = null;
  await (last.kind === "queue" ? queue : sync).restore(last.it.id);
}

// Where the server answers "are you there" and "what version are you": its own endpoints, or, in the static
// version, a version.json written beside the app by the build (relative, so it works under any path).
const VERSION_URL = LOCAL_ONLY ? "version.json" : "/api/version";

const CHECK_REQUESTED = "interrupt-stack-check-requested";

const REFRESH_MESSAGES = {
  unreachable: "Can't reach the server, so nothing was changed.",
  "signed-out": "You may need to sign in again. Nothing was changed.",
};

let refreshMessageTimer = null;
function showRefreshMessage(text) {
  const el = $("refresh-msg");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(refreshMessageTimer);
  refreshMessageTimer = setTimeout(() => (el.hidden = true), 8000);
}

let updatingServer = false;
const UPDATE_NOW_MESSAGES = {
  unavailable: "The server cannot update itself right now.",
  refused: "The server refused to update.",
  timeout: "The server did not come back within 90 seconds. Check the container.",
};

async function updateNow() {
  updatingServer = true;
  $("update-now-btn").disabled = true;
  $("update-now-btn").hidden = true;
  $("server-update-text").textContent = "Updating the server. This page reloads when it is back.";
  const result = await updateServerNow({
    fetch: (p, i) => fetch(p, i),
    forceRefresh: () =>
      forceRefresh({ checkUrl: VERSION_URL, fetch: (p, i) => fetch(p, i), caches: window.caches, serviceWorker: navigator.serviceWorker, reload: () => location.reload() }),
  });
  if (result.ok) return; // the page is reloading
  updatingServer = false;
  $("update-now-btn").disabled = false;
  $("server-update-text").textContent =
    result.reason === "unchanged"
      ? `The server restarted but is still on ${result.label ?? "the same version"}, so the update did not take. Check the container log.`
      : (UPDATE_NOW_MESSAGES[result.reason] ?? UPDATE_NOW_MESSAGES.refused);
  $("update-now-btn").hidden = false;
}

async function refreshApp() {
  // Also ask the server to look at GitHub, in the background. It does not delay the refresh: the answer arrives
  // in /api/version and is shown by the next version check.
  if (!LOCAL_ONLY) {
    requestServerCheck({ fetch: (p, i) => fetch(p, i) });
    try {
      sessionStorage.setItem(CHECK_REQUESTED, "1"); // so the reloaded page looks for the answer a few times
    } catch {}
  }
  const buttons = [$("refresh-btn"), $("update-btn")];
  buttons.forEach((b) => (b.disabled = true));
  showRefreshMessage("Refreshing...");
  const result = await forceRefresh({
    checkUrl: VERSION_URL,
    fetch: (p, i) => fetch(p, i),
    caches: window.caches,
    serviceWorker: navigator.serviceWorker,
    reload: () => location.reload(),
  });
  if (result.ok) return; // the page is reloading
  showRefreshMessage(REFRESH_MESSAGES[result.reason] ?? REFRESH_MESSAGES.unreachable);
  buttons.forEach((b) => (b.disabled = false));
}

function setUpInstall() {
  if (!window.isSecureContext) {
    showNote("This page was opened without HTTPS, so browsers will not install it or let it work offline. Open it through an https:// address.");
    return;
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

async function init() {
  // Early, so a beforeinstallprompt fired during start-up is not missed. Shows nothing unless install is possible.
  try {
    startInstallPrompt({
      win: window,
      nav: navigator,
      storage: localStorage,
      els: { box: $("install"), text: $("install-text"), install: $("install-btn"), dismiss: $("install-dismiss") },
    });
  } catch {} // localStorage itself can throw; the prompt is optional
  // What this copy of the app was built from (cached with the app). A server without /version.js has none.
  const build = await import("./version.js").catch(() => null);
  $("version").textContent =
    typeof build?.LABEL === "string" && build.LABEL
      ? build.LABEL
      : typeof build?.COMMIT === "string"
        ? build.COMMIT.slice(0, 7)
        : "version unknown";
  setUpInstall();
  let storage;
  try {
    storage = await openStorage();
  } catch {
    showNote("This browser would not open local storage, so the stack cannot be kept. Try a normal (non-private) window.");
    return;
  }
  // The queue has its own database, so a failure there never takes the stack down with it.
  let queueStorage = {};
  try {
    queueStorage = await openStorage(QUEUE_DB_NAME);
  } catch {}
  // A start can be interrupted between its two parts; whenever either side changes, finish any that were.
  const changed = () => {
    render();
    queue?.reconcile().catch(() => {});
  };
  sync = createSync({ storage, fetch: (p, i) => fetch(p, i), onChange: changed, onStatus: updateStatus, online: () => navigator.onLine, local: LOCAL_ONLY });
  queue = createQueue({ storage: queueStorage, fetch: (p, i) => fetch(p, i), stack: sync, onChange: changed, onStatus: updateStatus, local: LOCAL_ONLY });
  labelQueue();
  render();

  $("push-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const inp = $("push-input");
    const text = inp.value.trim();
    if (!text) return;
    inp.value = "";
    const item = await sync.push(text);
    if (!item) inp.value = text;
    inp.focus();
  });
  $("swap-btn").addEventListener("click", async () => {
    const inp = $("push-input");
    const text = inp.value.trim();
    if (!text) {
      inp.focus();
      return;
    }
    inp.value = "";
    const result = await sync.swap(text);
    if (!result) inp.value = text;
    else if (result.removed) offerUndo(result.removed);
    inp.focus();
  });
  $("queue-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const inp = $("queue-input");
    const text = inp.value.trim();
    if (!text) return;
    inp.value = "";
    const item = await queue.add(text);
    if (!item) inp.value = text;
    inp.focus();
  });
  $("to-queue").addEventListener("click", () => showPane("pane-queue"));
  $("to-stack").addEventListener("click", () => showPane("pane-stack"));
  $("undo-btn").addEventListener("click", undo);
  $("debug-btn").addEventListener("click", () => {
    const f = sync.lastFailure();
    if (!f) return;
    $("debug-text").textContent = formatFailure(f);
    $("debug-copy-msg").hidden = true;
    $("debug-dialog").showModal();
  });
  $("debug-close").addEventListener("click", () => $("debug-dialog").close());
  $("debug-copy").addEventListener("click", async () => {
    let msg = "Copied.";
    try {
      await navigator.clipboard.writeText($("debug-text").textContent);
    } catch {
      msg = "Could not copy. Select the text and copy it by hand.";
    }
    $("debug-copy-msg").textContent = msg;
    $("debug-copy-msg").hidden = false;
  });
  $("refresh-btn").addEventListener("click", refreshApp);
  $("update-btn").addEventListener("click", refreshApp);
  $("update-now-btn").addEventListener("click", updateNow);

  const current = build?.VERSION ?? null; // no version means no update check
  const checkForUpdate = async () => {
    const info = await readVersionInfo({ fetch: (p, i) => fetch(p, i), url: VERSION_URL });
    // Unknown (server unreachable, sign-in redirect) leaves the banners as they were.
    const newer = current && typeof info?.version === "string" && info.version ? info.version !== current : null;
    if (newer !== null) $("update").hidden = !newer;
    if (info) {
      const notice = LOCAL_ONLY ? null : describeServerUpdate(info);
      if (!updatingServer) {
        $("server-update-text").textContent = notice ?? "";
        $("update-now-btn").hidden = !(notice && canUpdateNow(info));
      }
      $("server-update").hidden = !notice && !updatingServer;
    }
  };

  await Promise.all([sync.start(), queue.start()]);
  updateStatus();

  const syncNow = () => {
    sync.syncNow().catch(() => {});
    queue.syncNow().catch(() => {});
  };
  checkForUpdate();
  // After a Refresh, the server was asked to look at GitHub just before the reload and may not have finished yet.
  let followUp = false;
  try {
    followUp = sessionStorage.getItem(CHECK_REQUESTED) === "1";
    sessionStorage.removeItem(CHECK_REQUESTED);
  } catch {}
  if (followUp) for (const ms of [1500, 4000, 9000]) setTimeout(checkForUpdate, ms);

  // The stream reconnects itself (events.js). On iOS a stream can also look open after the app resumes from
  // the background while being dead, so it is recreated whenever the page becomes visible.
  // The static version has no server, so no live-update stream either.
  const events = LOCAL_ONLY ? { connect() {} } : createEventStream({ url: "/api/events", onSeq: syncNow, onQueueSeq: () => queue.syncNow().catch(() => {}) });
  events.connect();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    events.connect();
    syncNow();
    checkForUpdate();
  });
  addEventListener("online", () => {
    syncNow();
    checkForUpdate();
  });
  setInterval(() => {
    syncNow();
    checkForUpdate();
  }, 60000);
  setInterval(render, 30000);
}

init();
