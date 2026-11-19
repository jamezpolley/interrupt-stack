import { describe, expect, test } from "bun:test";
import { COOLDOWN_DAYS, decideInstall, instructionsFor, parseDismissal } from "./install.js";

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 19, 12);
const UA = {
  chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  edgeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  chromeOS: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  safariIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ Safari asks for the desktop site by default and says it is a Mac.
  safariIpad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  chromeIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1",
  chromeIpad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1",
  firefoxDesktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
};
const env = (over) => ({ userAgent: UA.chromeWindows, platform: "Win32", maxTouchPoints: 0, standalone: false, dismissedAt: null, installed: false, hasPromptEvent: false, now: NOW, ...over });

describe("chromium path", () => {
  for (const [name, userAgent, platform, maxTouchPoints] of [
    ["Chrome on Windows", UA.chromeWindows, "Win32", 0],
    ["Edge on Windows", UA.edgeWindows, "Win32", 0],
    ["Chrome on ChromeOS", UA.chromeOS, "Linux x86_64", 0],
    ["Chrome on Android", UA.chromeAndroid, "Linux armv81", 5],
  ]) {
    test(`${name}: offers the install button once the browser has fired beforeinstallprompt`, () => {
      expect(decideInstall(env({ userAgent, platform, maxTouchPoints, hasPromptEvent: true }))).toEqual({ platform: "chromium", state: "show", canPrompt: true });
    });
    test(`${name}: shows nothing until the event arrives`, () => {
      expect(decideInstall(env({ userAgent, platform, maxTouchPoints }))).toMatchObject({ platform: "chromium", state: "none", canPrompt: false });
    });
  }
});

describe("iOS and iPadOS: instructions only", () => {
  test("Safari on iPhone", () => {
    expect(decideInstall(env({ userAgent: UA.safariIphone, platform: "iPhone", maxTouchPoints: 5 }))).toEqual({ platform: "ios", device: "iphone", browser: "safari", state: "show", canPrompt: false });
  });
  test("Safari on iPad identifies as a Mac, so touch points give it away", () => {
    expect(decideInstall(env({ userAgent: UA.safariIpad, platform: "MacIntel", maxTouchPoints: 5 }))).toEqual({ platform: "ios", device: "ipad", browser: "safari", state: "show", canPrompt: false });
  });
  test("Chrome on iPhone", () => {
    expect(decideInstall(env({ userAgent: UA.chromeIphone, platform: "iPhone", maxTouchPoints: 5 }))).toEqual({ platform: "ios", device: "iphone", browser: "other", state: "show", canPrompt: false });
  });
  test("Chrome on iPad (iPad UA)", () => {
    expect(decideInstall(env({ userAgent: UA.chromeIpad, platform: "iPad", maxTouchPoints: 5 }))).toMatchObject({ platform: "ios", device: "ipad", browser: "other" });
  });
  test("a real Mac Safari (no touch) is not an iPad", () => {
    expect(decideInstall(env({ userAgent: UA.safariMac, platform: "MacIntel", maxTouchPoints: 0 }))).toEqual({ platform: "other", state: "none", canPrompt: false });
  });
});

describe("browsers with no install support", () => {
  test("desktop Firefox", () => {
    expect(decideInstall(env({ userAgent: UA.firefoxDesktop, platform: "Win32" }))).toEqual({ platform: "other", state: "none", canPrompt: false });
  });
  test("desktop Safari", () => {
    expect(decideInstall(env({ userAgent: UA.safariMac, platform: "MacIntel" }))).toEqual({ platform: "other", state: "none", canPrompt: false });
  });
});

describe("never when already installed", () => {
  test("running standalone (display-mode or navigator.standalone), on every platform", () => {
    for (const e of [
      { hasPromptEvent: true },
      { userAgent: UA.safariIphone, platform: "iPhone", maxTouchPoints: 5 },
      { userAgent: UA.safariIpad, platform: "MacIntel", maxTouchPoints: 5 },
    ]) {
      expect(decideInstall(env({ ...e, standalone: true }))).toMatchObject({ state: "installed", canPrompt: false });
    }
  });
  test("after appinstalled", () => {
    expect(decideInstall(env({ hasPromptEvent: true, installed: true }))).toMatchObject({ state: "installed", canPrompt: false });
  });
});

describe("dismissal cool-down", () => {
  test("cool-down is 14 days", () => expect(COOLDOWN_DAYS).toBe(14));
  test("dismissed yesterday: stays hidden, on both paths", () => {
    expect(decideInstall(env({ hasPromptEvent: true, dismissedAt: NOW - DAY }))).toMatchObject({ state: "dismissed", canPrompt: false });
    expect(decideInstall(env({ userAgent: UA.safariIphone, platform: "iPhone", maxTouchPoints: 5, dismissedAt: NOW - DAY }))).toMatchObject({ state: "dismissed" });
  });
  test("just inside and just outside the window", () => {
    expect(decideInstall(env({ hasPromptEvent: true, dismissedAt: NOW - COOLDOWN_DAYS * DAY + 1 })).state).toBe("dismissed");
    expect(decideInstall(env({ hasPromptEvent: true, dismissedAt: NOW - COOLDOWN_DAYS * DAY })).state).toBe("show");
  });
  test("a dismissal stamped in the future (clock change) is ignored rather than hiding forever", () => {
    expect(decideInstall(env({ hasPromptEvent: true, dismissedAt: NOW + 400 * DAY })).state).toBe("show");
  });
});

describe("parseDismissal", () => {
  test("accepts a stored millisecond timestamp", () => expect(parseDismissal(String(NOW))).toBe(NOW));
  test("junk, empty and missing give null", () => {
    for (const v of [null, undefined, "", "abc", "-5", "NaN", "Infinity"]) expect(parseDismissal(v)).toBeNull();
  });
});

describe("instructionsFor", () => {
  test("every variant names Share and Add to Home Screen", () => {
    for (const v of [{ device: "iphone", browser: "safari" }, { device: "ipad", browser: "safari" }, { device: "iphone", browser: "other" }]) {
      expect(instructionsFor(v)).toMatch(/Share/);
      expect(instructionsFor(v)).toMatch(/Add to Home Screen/);
    }
  });
});
