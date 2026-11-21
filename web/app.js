import { createSync } from "./sync.js";
import { NOTES_DB_NAME, openStorage, QUEUE_DB_NAME } from "./idb.js";
import { createQueue, QUEUE_LABEL } from "./queue.js";
import { createNotes, MAX_TEXT as NOTE_MAX } from "./notes.js";
import { currentPane, pillFor } from "./pane.js";
import { createEventStream } from "./events.js";
import { canUpdateNow, describeServerUpdate, forceRefresh, readVersionInfo, requestServerCheck, updateServerNow } from "./refresh.js";
import { doneTodayEntries } from "./today.js";
import { describeRow, doneRow, formatClock, formatStart, timeline, totalText, wasEdited } from "./times.js";
import { applyDraft, changesFrom, clockText, dateText, parseEdited, canShiftLater, noteDayShift, shiftRowTime, rowTargets, sideEffectText, sideEffects, validateDraft } from "./edit.js";
import { pushAgain } from "./again.js";
import { displayText, renderLinked } from "./links.js";
import { formatFailure } from "./debug-text.js";
import { offersSignIn, shortStatus, statusLabel, statusMessage, unsentWords } from "./status-text.js";
import { LOCAL_ONLY } from "./config.js";
import { versionLine } from "./version-line.js";
import { startInstallPrompt } from "./install.js";

const $ = (id) => document.getElementById(id);
const UNDO_MS = 15000;

let sync;
let queue;
let notes;
let lastRemoved = null; // { it, kind: "stack" | "queue" }
let undoTimer = null;

function showNote(text) {
  const n = $("note");
  n.textContent = text || "";
  n.hidden = !text;
}

const STORAGE_NOTE = "This device could not save your changes locally. Keep this page open until they sync.";
let storageNoteShown = false;

// The stack and Later share one sync channel (core.js), so there is one status for both: every unsent change counted.
const combinedStatus = () => sync.status();
function updateStatus() {
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
  // A named failure shows as a button that opens the Debug panel; anything else is plain text. Unsent changes show as a count.
  const trouble = state === "offline" || state === "error";
  const failed = trouble && !!error && !!sync?.lastFailure();
  const word = shortStatus({ state, pending, error });
  const showCount = trouble && pending > 0;
  $("status-btn").hidden = !failed;
  $("status-plain").hidden = failed;
  $("status").textContent = word;
  $("status-count-plain").hidden = !showCount || failed;
  $("status-count-plain").textContent = String(pending);
  $("status-word").textContent = word;
  $("status-count").hidden = !showCount;
  $("status-count").textContent = String(pending);
  $("status-btn").setAttribute("aria-label", `${statusLabel({ state, pending, error })}. Show details`);
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
    renderLinked(t, top.text);
    const foot = document.createElement("div");
    foot.className = "now-foot";
    const a = document.createElement("span");
    a.className = "age";
    a.textContent = `Pushed ${formatStart(top.ts, Date.now())}`;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "primary";
    b.textContent = "Pop";
    b.addEventListener("click", () => removeItem(top));
    foot.append(a, b);
    card.append(l, t, foot);
    wrap.appendChild(card);
  }

  $("swap-btn").disabled = stack.length === 0;

  const all = sync.allItems();
  const done = doneTodayEntries(all, notes ? notes.notes() : [], Date.now());
  const doneList = $("done");
  doneList.textContent = "";
  $("done-cols").hidden = done.length === 0;
  for (const entry of done) {
    if (entry.kind === "note") {
      doneList.appendChild(noteRow(entry.note));
      continue;
    }
    const it = entry.item;
    const li = document.createElement("li");
    const row = doneRow(it, all, undefined, Date.now());
    // A row with a real end time opens its details; one without (stored before end times existed) is plain text.
    const body = document.createElement(Number.isFinite(it.at) ? "button" : "div");
    body.className = "done-body";
    if (body.tagName === "BUTTON") {
      body.type = "button";
      body.dataset.itemId = it.id;
      body.setAttribute("aria-label", `Details for ${displayText(it.text)}`);
      body.setAttribute("aria-haspopup", "dialog");
      body.addEventListener("click", () => openDetails(it.id));
    }
    const tx = document.createElement("span");
    tx.className = "item-text";
    renderLinked(tx, it.text, { links: false }); // inside a button: the same label as plain text
    if (wasEdited(it, all)) {
      const mark = document.createElement("small");
      mark.className = "edited-tag";
      mark.textContent = " edited";
      tx.appendChild(mark);
    }
    const start = document.createElement("span");
    start.className = "item-age col-start";
    start.textContent = row.start;
    const end = document.createElement("span");
    end.className = "item-age";
    end.textContent = row.end;
    const dur = document.createElement("span");
    dur.className = "item-age";
    dur.textContent = row.duration;
    body.append(tx, start, end, dur);
    li.appendChild(body);
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
    renderLinked(tx, it.text);
    const ag = document.createElement("span");
    ag.className = "item-age";
    ag.textContent = formatStart(it.ts, Date.now());
    const x = document.createElement("button");
    x.type = "button";
    x.className = "drop";
    x.textContent = "Drop";
    x.setAttribute("aria-label", `Drop ${displayText(it.text)} from the stack`);
    x.addEventListener("click", () => removeItem(it));
    li.append(d, tx, ag, x);
    under.appendChild(li);
  });
}

// A note in Done today: one time (in the Ended column; the Started column stays empty), a dash for the duration, a quiet
// "note" label. Tapping it opens a small panel to change its text and time.
function noteRow(n) {
  const li = document.createElement("li");
  const body = document.createElement("button");
  body.type = "button";
  body.className = "done-body";
  body.dataset.noteId = n.id;
  body.setAttribute("aria-label", `Note: ${displayText(n.text)}. Edit`);
  body.setAttribute("aria-haspopup", "dialog");
  body.addEventListener("click", () => openNote(n.id));
  const tx = document.createElement("span");
  tx.className = "item-text";
  renderLinked(tx, n.text, { links: false });
  const tag = document.createElement("small");
  tag.className = "note-tag";
  tag.textContent = n.edited_at != null ? "note, edited" : "note";
  tx.appendChild(tag);
  const start = document.createElement("span");
  start.className = "item-age col-start";
  const time = document.createElement("span");
  time.className = "item-age";
  time.textContent = formatStart(n.ts, Date.now());
  const dur = document.createElement("span");
  dur.className = "item-age";
  dur.textContent = "\u2014";
  body.append(tx, start, time, dur);
  li.appendChild(body);
  return li;
}

let noteEditing = null; // id of the note whose panel is open
let noteDayMs = 0; // the day shown in the panel (moved by the day buttons), as a time on that day

function openNote(id) {
  const n = notes.get(id);
  if (!n || n.removed) return;
  noteEditing = id;
  $("note-text").value = n.text;
  renderLinked($("note-linked"), n.text); // the row is a button, so its links are plain text; here they work
  $("note-time").value = clockText(n.ts);
  noteDayMs = n.ts;
  checkNote();
  $("note-dialog").showModal();
}

// What the panel would save, or why not. The time is on the day the day buttons have moved it to.
function noteDraft() {
  const n = noteEditing && notes.get(noteEditing);
  if (!n) return null;
  const text = $("note-text").value.trim();
  const ts = parseEdited(n.ts, $("note-time").value, dateText(noteDayMs));
  const problems = [];
  if (!text) problems.push("Text cannot be empty.");
  else if (text.length > NOTE_MAX) problems.push(`Text is over ${NOTE_MAX} characters.`);
  if (ts === null) problems.push("That time is not valid. Use HH:MM or HH:MM:SS, 24 hour.");
  else if (ts > Date.now()) problems.push("A time cannot be in the future.");
  return { n, text, ts, problems, changed: text !== n.text || ts !== n.ts };
}

function checkNote() {
  const d = noteDraft();
  if (!d) return;
  $("note-time").classList.toggle("bad", d.ts === null);
  const now = Date.now();
  $("note-day-next").disabled = !canShiftLater(noteDayMs, now);
  $("note-meta").textContent = dateText(noteDayMs) === dateText(now) ? "Today" : `On ${dateText(noteDayMs)}`;
  const p = $("note-problems");
  p.hidden = !d.problems.length;
  p.textContent = d.problems.join(" ");
  $("note-save").disabled = d.problems.length > 0 || !d.changed;
}

async function saveNote() {
  const d = noteDraft();
  if (!d || d.problems.length || !d.changed) return;
  $("note-save").disabled = true;
  await notes.edit(d.n.id, { text: d.text, ts: d.ts });
  $("note-dialog").close();
}

function openNoteBox(open) {
  $("note-form").hidden = !open;
  $("note-add-btn").setAttribute("aria-expanded", String(open));
  if (open) $("note-input").focus();
  else {
    $("note-input").value = "";
    $("note-add-btn").focus();
  }
}

function renderQueue() {
  const items = queue ? queue.queue() : [];
  updatePill(items.length);
  $("queue-empty").hidden = items.length > 0;
  const list = $("queue");
  list.textContent = "";
  for (const it of items) {
    const li = document.createElement("li");
    const tx = document.createElement("span");
    tx.className = "item-text";
    renderLinked(tx, it.text);
    const go = document.createElement("button");
    go.type = "button";
    go.className = "start";
    go.textContent = "Start";
    go.setAttribute("aria-label", `Start ${displayText(it.text)}`);
    go.addEventListener("click", () => queue.promote(it.id));
    const x = document.createElement("button");
    x.type = "button";
    x.className = "drop";
    x.textContent = "Drop";
    x.setAttribute("aria-label", `Drop ${displayText(it.text)} from ${QUEUE_LABEL}`);
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
}

// The header pill points at the other pane, so its words depend on which one is showing (a swipe changes that).
let laterCount = 0;
function updatePill(count = laterCount) {
  laterCount = count;
  let pane = "stack";
  try {
    const board = $("board");
    pane = currentPane(board.scrollLeft, board.clientWidth);
  } catch {}
  const pill = pillFor({ pane, count, label: QUEUE_LABEL });
  const el = $("pane-pill");
  el.textContent = pill.text;
  el.setAttribute("aria-label", pill.aria);
  el.setAttribute("aria-controls", pill.target === "queue" ? "pane-queue" : "pane-stack");
  el.dataset.target = pill.target;
}

// On a phone the panes sit side by side and scroll sideways; the header pill does the same as a swipe.
function showPane(id) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  $(id).scrollIntoView({ behavior: reduce ? "auto" : "smooth", inline: "start", block: "nearest" });
}

// The details panel for a Done today row: every push and pop of that item, with running totals (derived on this device).
// Edit mode (the Edit button) changes the item's title and the times of the rows, with the totals recomputing as you
// type; Save sends the whole change, Cancel drops it. `ed` is null when not editing.
let detailsFor_id = null;
let ed = null; // {draft: {texts, times}} while editing: only what was changed, as new values

function openDetails(id) {
  const all = sync.allItems();
  const item = all.find((i) => i.id === id);
  if (!item || !timeline(item, all)) return;
  detailsFor_id = id;
  ed = null;
  renderDetails();
  $("details-dialog").showModal();
}

function startEdit() {
  ed = { draft: { texts: {}, times: {} } };
  renderDetails();
}

function endEdit() {
  ed = null;
  renderDetails();
}

function renderDetails() {
  const base = sync.allItems();
  const all = ed ? applyDraft(base, ed.draft) : base;
  const origX = base.find((i) => i.id === detailsFor_id);
  if (!origX) return $("details-dialog").close();
  let x = all.find((i) => i.id === detailsFor_id);
  let t = timeline(x, all);
  let src = all;
  // A draft that makes no valid history (the problem text says why) must not blank the table, or it could not be fixed.
  if (!t) {
    src = base;
    x = origX;
    t = timeline(x, base);
  }
  if (!t) return $("details-dialog").close();
  const now = Date.now();

  $("details-edit").hidden = $("details-again").hidden = !!ed;
  $("details-save").hidden = $("details-cancel").hidden = !ed;

  // The heading shows the text as people read it (links clickable). The edit box holds the raw stored text.
  const title = $("details-title");
  if (ed) {
    title.textContent = "";
    const inp = document.createElement("input");
    inp.className = "title-edit";
    inp.maxLength = 200;
    inp.value = ed.draft.texts[origX.id] ?? origX.text;
    inp.setAttribute("aria-label", "Text");
    inp.addEventListener("input", () => {
      if (inp.value === origX.text) delete ed.draft.texts[origX.id];
      else ed.draft.texts[origX.id] = inp.value;
      refreshChecks();
    });
    title.appendChild(inp);
  } else renderLinked(title, x.text);

  const edited = wasEdited(origX, base) ? " · edited" : "";
  $("details-summary").textContent = `Started ${formatStart(t.start, now)} · Ended ${formatClock(t.end)}${edited}`;

  const body = $("details-rows");
  body.textContent = "";
  const targets = rowTargets(x, src);
  t.rows.forEach((r0, i) => {
    const tg = targets[i];
    const key = `${tg.id}:${tg.field}`;
    const owner = base.find((it) => it.id === tg.id);
    const r = { ...r0, t: ed?.draft.times[key] ?? r0.t }; // what was typed, even while the draft is invalid
    const tr = document.createElement("tr");
    const tdT = document.createElement("td");
    tdT.className = "t";
    if (ed && owner?.removed) {
      const orig = owner[tg.field];
      const clock = document.createElement("input");
      clock.className = "clock";
      clock.type = "text";
      clock.inputMode = "numeric";
      clock.autocomplete = "off";
      clock.placeholder = "HH:MM:SS";
      clock.maxLength = 8;
      clock.value = clockText(r.t);
      clock.setAttribute("aria-label", `${tg.field === "ts" ? "Pushed" : "Ended"} time, 24 hour, HH:MM or HH:MM:SS, for ${displayText(owner.text)}`);
      tdT.appendChild(clock);
      // Skinny -1 / +1 day buttons (no date box); +1 is off once the row is on today.
      const days = document.createElement("div");
      days.className = "days";
      const mk = (label, step, aria) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "daybtn";
        b.textContent = label;
        b.setAttribute("aria-label", aria);
        b.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus, so a half-typed clock is not re-rendered away
        b.addEventListener("click", () => {
          const ms = shiftRowTime(orig, clock.value, r.t, step);
          clock.classList.toggle("bad", ms === null);
          if (ms === null) return;
          if (ms === orig) delete ed.draft.times[key];
          else ed.draft.times[key] = ms;
          renderDetails();
        });
        return b;
      };
      const next = mk("+1 day", 1, "One day later");
      next.disabled = !canShiftLater(r.t, now);
      days.append(mk("\u22121 day", -1, "One day earlier"), next);
      tdT.appendChild(days);
      const apply = () => {
        const ms = parseEdited(orig, clock.value, dateText(r.t));
        clock.classList.toggle("bad", ms === null);
        if (ms === null) return false;
        if (ms === orig) delete ed.draft.times[key];
        else ed.draft.times[key] = ms;
        return true;
      };
      clock.addEventListener("input", () => apply() && refreshChecks(true));
      clock.addEventListener("change", () => apply() && renderDetails());
    } else tdT.textContent = formatStart(r.t, now);
    const tdW = document.createElement("td");
    tdW.className = "w";
    tdW.textContent = describeRow(r);
    const tdO = document.createElement("td");
    tdO.className = "n";
    tdO.textContent = totalText(r.onTop);
    const tdWall = document.createElement("td");
    tdWall.className = "n";
    tdWall.textContent = totalText(r.wall);
    tr.append(tdT, tdW, tdO, tdWall);
    body.appendChild(tr);
  });
  refreshChecks();
}

// Problems, side effects and the Save button from the current draft; while typing, also the summary and the totals.
function refreshChecks(liveNumbers = false) {
  if (!ed) {
    $("details-problems").hidden = $("details-effects").hidden = true;
    return;
  }
  const base = sync.allItems();
  const problems = validateDraft(base, ed.draft, Date.now());
  const all = applyDraft(base, ed.draft);
  const x = all.find((i) => i.id === detailsFor_id);
  const t = x && timeline(x, all);
  if (!t && !problems.length) problems.push("Those times do not make a valid history.");
  const p = $("details-problems");
  p.hidden = !problems.length;
  p.textContent = problems.join(" ");
  const fx = problems.length ? [] : sideEffects(base, ed.draft, detailsFor_id);
  const e = $("details-effects");
  e.hidden = !fx.length;
  e.textContent = fx.length ? `This also changes: ${fx.map(sideEffectText).join("; ")}` : "";
  $("details-save").disabled = problems.length > 0 || changesFrom(base, ed.draft).length === 0;
  if (liveNumbers && t) {
    const edited = wasEdited(base.find((i) => i.id === detailsFor_id), base) ? " · edited" : "";
    $("details-summary").textContent = `Started ${formatStart(t.start, Date.now())} · Ended ${formatClock(t.end)}${edited}`;
    const rows = $("details-rows").children;
    if (rows.length === t.rows.length) t.rows.forEach((r, i) => ((rows[i].children[2].textContent = totalText(r.onTop)), (rows[i].children[3].textContent = totalText(r.wall))));
  }
}

async function saveEdit() {
  const base = sync.allItems();
  const changes = changesFrom(base, ed.draft);
  $("details-save").disabled = true;
  for (const c of changes) await sync.edit(c.id, c);
  endEdit();
}

function offerUndo(it, kind = "stack") {
  lastRemoved = { it, kind };
  $("toast-text").textContent = `Removed: ${displayText(it.text)}`;
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
  $("version").textContent = versionLine(build);
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
  let notesStorage = {};
  try {
    notesStorage = await openStorage(NOTES_DB_NAME);
  } catch {}
  // A start can be interrupted between its two parts; whenever either side changes, finish any that were.
  const changed = () => {
    render();
    queue?.reconcile().catch(() => {});
  };
  sync = createSync({ storage, fetch: (p, i) => fetch(p, i), onChange: changed, onStatus: updateStatus, online: () => navigator.onLine, local: LOCAL_ONLY });
  queue = createQueue({ storage: queueStorage, stack: sync, onChange: changed, local: LOCAL_ONLY }); // joins the stack's sync channel
  notes = createNotes({ storage: notesStorage, stack: sync, onChange: changed, local: LOCAL_ONLY }); // joins it too
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
  $("note-add-btn").addEventListener("click", () => openNoteBox($("note-form").hidden));
  $("note-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = $("note-input").value.trim();
    if (!text) return;
    const note = await notes.add(text);
    if (note) openNoteBox(false);
  });
  $("note-input").addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      openNoteBox(false);
    }
  });
  $("note-text").addEventListener("input", checkNote);
  $("note-time").addEventListener("input", checkNote);
  $("note-save").addEventListener("click", saveNote);
  for (const [id, step] of [["note-day-back", -1], ["note-day-next", 1]]) {
    $(id).addEventListener("click", () => {
      const n = noteEditing && notes.get(noteEditing);
      if (!n) return;
      const ms = noteDayShift(n.ts, $("note-time").value, noteDayMs, step, Date.now());
      $("note-time").classList.toggle("bad", ms === null);
      if (ms === null) return;
      noteDayMs = ms;
      checkNote();
    });
  }
  $("note-close").addEventListener("click", () => $("note-dialog").close());
  $("note-dialog").addEventListener("click", (ev) => {
    if (ev.target === $("note-dialog")) $("note-dialog").close();
  });
  $("note-dialog").addEventListener("close", () => {
    const id = noteEditing;
    noteEditing = null;
    if (id) document.querySelector(`#done [data-note-id="${CSS.escape(id)}"]`)?.focus();
  });
  $("pane-pill").addEventListener("click", () => showPane($("pane-pill").dataset.target === "queue" ? "pane-queue" : "pane-stack"));
  let paneFrame = 0;
  $("board").addEventListener("scroll", () => {
    cancelAnimationFrame(paneFrame);
    paneFrame = requestAnimationFrame(() => updatePill());
  }, { passive: true });
  addEventListener("resize", () => updatePill());
  $("undo-btn").addEventListener("click", undo);
  $("status-btn").addEventListener("click", () => {
    const f = sync.lastFailure();
    if (!f) return;
    const st = combinedStatus();
    $("debug-title").textContent = statusMessage(st);
    const unsent = unsentWords(st.pending);
    $("debug-unsent").textContent = unsent;
    $("debug-unsent").hidden = !unsent;
    $("debug-signin").hidden = !offersSignIn(st.error, LOCAL_ONLY);
    $("debug-text").textContent = formatFailure(f);
    $("debug-copy-msg").hidden = true;
    $("debug-dialog").showModal();
  });
  // A top-level navigation to the server's /login (relative to this page), which the sign-in proxy intercepts;
  // after signing in the person is sent back to /login, which redirects into the app.
  $("signin-btn").addEventListener("click", () => {
    location.href = new URL("login", location.href).href;
  });
  $("debug-close").addEventListener("click", () => $("debug-dialog").close());
  $("details-close").addEventListener("click", () => $("details-dialog").close());
  $("details-edit").addEventListener("click", startEdit);
  $("details-cancel").addEventListener("click", endEdit);
  $("details-save").addEventListener("click", saveEdit);
  // Push again: a new stack item with the same text (linked to this one), then the panel closes on the new top item.
  $("details-again").addEventListener("click", async () => {
    const id = detailsFor_id;
    if (!id) return;
    const pushed = await pushAgain(sync, id);
    if (pushed) $("details-dialog").close();
  });
  // A click on the backdrop lands on the dialog element itself (its content sits in an inner box that fills it).
  $("details-dialog").addEventListener("click", (ev) => {
    if (ev.target === $("details-dialog")) $("details-dialog").close();
  });
  // The list is rebuilt whenever anything changes, so the row that opened the panel may be a new element by now:
  // put focus back on the row for the same item.
  $("details-dialog").addEventListener("close", () => {
    const id = detailsFor_id;
    detailsFor_id = null;
    ed = null;
    if (id) document.querySelector(`#done [data-item-id="${CSS.escape(id)}"]`)?.focus();
  });
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
      // The server also says which commit its image was built from, when that differs (it has updated itself).
      if (!LOCAL_ONLY) $("version").textContent = versionLine(build, info);
      const notice = LOCAL_ONLY ? null : describeServerUpdate(info);
      if (!updatingServer) {
        $("server-update-text").textContent = notice ?? "";
        $("update-now-btn").hidden = !(notice && canUpdateNow(info));
      }
      $("server-update").hidden = !notice && !updatingServer;
    }
  };

  await Promise.all([sync.start(), queue.start(), notes.start()]);
  updateStatus();

  const syncNow = () => {
    sync.syncNow().catch(() => {});
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
  const events = LOCAL_ONLY ? { connect() {} } : createEventStream({ url: "/api/events", onSync: syncNow });
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
