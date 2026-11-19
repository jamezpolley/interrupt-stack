// "Install this app" prompt. decideInstall() is pure: everything it needs is passed in, so it is tested without a
// browser. startInstallPrompt() is the thin DOM/event wiring. It makes no network calls and names no host.
//
// Sources: MDN "Making PWAs installable" (beforeinstallprompt is Chromium-only and "not supported on iOS"; iOS 16.4+
// installs from the Share menu in Safari, Chrome, Edge, Firefox, Orion), MDN beforeinstallprompt / appinstalled,
// web.dev "Customize install" (prompt() once per event), WebKit "Web Push for Web Apps on iOS and iPadOS" (16.4:
// third-party browsers can offer Add to Home Screen from the Share menu), Apple iPhone User Guide
// ("Tap Share ... Add to Home Screen").

export const COOLDOWN_DAYS = 14; // a dismissed prompt comes back after two weeks
export const DISMISS_KEY = "interrupt-stack-install-dismissed";
const DAY_MS = 86400000;

export function parseDismissal(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// iPadOS 13+ Safari sends a Mac user agent by default; a Mac has no touch screen, so touch points tell them apart.
function detectIos({ userAgent = "", platform = "", maxTouchPoints = 0 }) {
  if (/iPad/.test(userAgent) || (platform === "iPad")) return "ipad";
  if (/iPhone|iPod/.test(userAgent) || platform === "iPhone") return "iphone";
  if (platform === "MacIntel" && maxTouchPoints > 1) return "ipad";
  return null;
}

export function decideInstall(env) {
  const { userAgent = "", standalone, installed, hasPromptEvent, dismissedAt, now } = env;
  const device = detectIos(env);
  const platform = device ? "ios" : /Chrome\/|Chromium\/|Edg\//.test(userAgent) ? "chromium" : "other";

  const base = { platform, canPrompt: false };
  if (device) {
    base.device = device;
    base.browser = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(userAgent) ? "other" : "safari";
  }
  if (platform === "other") return { ...base, state: "none" };
  if (standalone || installed) return { ...base, state: "installed" };
  if (typeof dismissedAt === "number" && dismissedAt <= now && now - dismissedAt < COOLDOWN_DAYS * DAY_MS) {
    return { ...base, state: "dismissed" };
  }
  if (platform === "chromium") return hasPromptEvent ? { ...base, state: "show", canPrompt: true } : { ...base, state: "none" };
  return { ...base, state: "show" };
}

export function instructionsFor({ device, browser }) {
  if (browser === "other") return "To install: open this browser's Share menu, then tap Add to Home Screen.";
  if (device === "ipad") return "To install: tap the Share button in Safari's toolbar, then tap Add to Home Screen.";
  return "To install: tap the Share button in Safari (it may be under the ... menu), then tap Add to Home Screen.";
}

const readDismissal = (storage) => {
  try {
    return parseDismissal(storage.getItem(DISMISS_KEY));
  } catch {
    return null;
  }
};

// Wires the prompt to the page. `els` = {box, text, install, dismiss}. Never focuses anything.
export function startInstallPrompt({ win, nav, storage, els, now = () => Date.now() }) {
  let promptEvent = null;
  let installed = false;

  const standalone = () => {
    try {
      return !!(win.matchMedia && win.matchMedia("(display-mode: standalone)").matches) || nav.standalone === true;
    } catch {
      return nav.standalone === true;
    }
  };

  function render() {
    const d = decideInstall({
      userAgent: nav.userAgent,
      platform: nav.platform,
      maxTouchPoints: nav.maxTouchPoints,
      standalone: standalone(),
      installed,
      hasPromptEvent: !!promptEvent,
      dismissedAt: readDismissal(storage),
      now: now(),
    });
    els.box.hidden = d.state !== "show";
    if (d.state !== "show") return;
    els.install.hidden = !d.canPrompt;
    els.text.textContent = d.canPrompt ? "Install this app for quick access, even offline." : instructionsFor(d);
  }

  function dismiss() {
    try {
      storage.setItem(DISMISS_KEY, String(now()));
    } catch {}
    render();
  }

  win.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    promptEvent = e;
    render();
  });
  win.addEventListener("appinstalled", () => {
    installed = true;
    promptEvent = null;
    render();
  });
  els.dismiss.addEventListener("click", dismiss);
  els.install.addEventListener("click", async () => {
    const ev = promptEvent;
    if (!ev) return;
    promptEvent = null; // single use: prompt() can only be called once per event
    els.box.hidden = true;
    try {
      const choice = await ev.prompt();
      const outcome = choice?.outcome ?? (await ev.userChoice)?.outcome;
      if (outcome === "accepted") installed = true;
      else dismiss();
    } catch {
      render();
    }
  });
  render();
}
