# Device checklist

Run this on the real devices. It could not be tested from the build machine, which only had desktop Chrome (headless). The desktop Chrome checks that did pass are listed at the end.

Start with the app served over HTTPS at its real address, and note which devices you tested and the OS version next to each section.

## What the research found (searched 2026-11-17)

These come from secondary sources and old WebKit bug reports, not current official Safari documentation, so treat them as reasons for the checks below and not as facts.

- Safari deletes script-writable storage (IndexedDB, service worker caches) for sites you haven't visited in about seven days. Sources agree that apps added to the Home Screen are exempt, but disagree on whether that depends on the web manifest. Check 3 below tests it.
- iOS suspends a backgrounded web app within seconds. Nothing syncs while the app is closed or suspended, so the app must catch up when you return. It pulls on return and recreates its live-update stream then.
- One Apple developer-forum report (iOS 18) says an `EventSource` can still report itself as open after the app resumes even though the connection has dropped. The app recreates the stream when it becomes visible for this reason; check 6 tests that it works.
- Whether `navigator.storage.persist()` helps on iOS was not found. The app does not call it.

Sources searched: WebKit Bugzilla 232302 and 237350 (storage deleted after 7 days), 211018 (iOS Home Screen apps freezing after backgrounding), Apple Developer Forums thread 765183 (EventSource after resume), and a MagicBell guide to PWA limits on iOS.

## Checks

Mark each pass or fail. A fail on 3, 4 or 6 is worth telling me about.

### iPhone and iPad (Safari)

- [ ] 1. Open the HTTPS address in Safari. The page loads and the status dot shows Synced.
- [ ] 2. Share, then Add to Home Screen. The icon and the name "Interrupts" look right. It opens full screen with no Safari address bar.
- [ ] 3. Push two tasks, close the app completely, and open it again after a day or more, then a week or more. The stack is still there. (The 7-day check.)
- [ ] 4. Put the phone in airplane mode, open the app, and push a task. It appears at once and the status reads "Offline, 1 unsent". Turn airplane mode off. The status returns to Synced and the task shows on your other device.
- [ ] 5. With the app open, push a task from another device. It appears here within a few seconds, with no reload.
- [ ] 6. Leave the app in the background for an hour, then push from another device. Open the app. It catches up within a few seconds without a manual reload.
- [ ] 7. Stop the server. The installed app still opens and shows your stack. Start the server again and it catches up.

### Windows and ChromeOS (Chrome or Edge)

- [ ] 8. Open the HTTPS address. The browser offers to install it (address bar icon or menu). Install it, and it opens in its own window with the right icon.
- [ ] 9. Checks 4, 5 and 7 above, using this device.

### Across devices

- [ ] 10. Push on one device, pop on another, and undo on a third. All three end with the same stack.
- [ ] 11. Turn one device's clock a few minutes forward, push there, then push on another device. Note the order. (Known limit: order follows each device's own clock.)

## Desktop checks already done

In headless desktop Chrome against `localhost`: install requirements met (no installability errors), manifest parses, service worker active with the app files cached, the app opens with the server stopped, and push, pop, drop, undo, reload persistence, live updates between two tabs, and offline-then-reconnect all work.
