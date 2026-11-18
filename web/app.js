import { createSync } from "./sync.js";
import { openStorage } from "./idb.js";
import { createEventStream } from "./events.js";
import { forceRefresh, updateAvailable } from "./refresh.js";
import { completedToday } from "./today.js";

const $ = (id) => document.getElementById(id);
const UNDO_MS = 15000;

let sync;
let lastRemoved = null;
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

function renderStatus({ state, pending, storageFailed }) {
  const label =
    state === "synced"
      ? "Synced"
      : state === "syncing"
        ? "Syncing"
        : state === "error"
          ? `Sync problem, ${pending} unsent`
          : pending
            ? `Offline, ${pending} unsent`
            : "Offline";
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
    e.textContent = "The stack is empty. Nothing is waiting for you.";
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

function offerUndo(it) {
  lastRemoved = it;
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
  const it = lastRemoved;
  if (!it) return;
  $("toast").hidden = true;
  lastRemoved = null;
  await sync.restore(it.id);
}

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

async function refreshApp() {
  const buttons = [$("refresh-btn"), $("update-btn")];
  buttons.forEach((b) => (b.disabled = true));
  showRefreshMessage("Refreshing...");
  const result = await forceRefresh({
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

async function init() {
  setUpInstall();
  let storage;
  try {
    storage = await openStorage();
  } catch {
    showNote("This browser would not open local storage, so the stack cannot be kept. Try a normal (non-private) window.");
    return;
  }
  sync = createSync({ storage, fetch: (p, i) => fetch(p, i), onChange: render, onStatus: renderStatus });
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
  $("undo-btn").addEventListener("click", undo);
  $("refresh-btn").addEventListener("click", refreshApp);
  $("update-btn").addEventListener("click", refreshApp);

  // The version this copy of the app was built from. A server without /version.js just means no update check.
  const current = await import("./version.js").then((m) => m.VERSION).catch(() => null);
  const checkForUpdate = async () => {
    const newer = await updateAvailable({ fetch: (p, i) => fetch(p, i), current });
    if (newer !== null) $("update").hidden = !newer;
  };

  await sync.start();
  renderStatus(sync.status());

  const syncNow = () => sync.syncNow().catch(() => {});
  checkForUpdate();

  // The stream reconnects itself (events.js). On iOS a stream can also look open after the app resumes from
  // the background while being dead, so it is recreated whenever the page becomes visible.
  const events = createEventStream({ url: "/api/events", onSeq: syncNow });
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
