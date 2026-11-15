## Goal
The native-port reconnect logic in `extension/background.js` (`connect` / `scheduleReconnect`) has no tests.

Expected behaviour today:
- a port that dies within 5 s doubles the backoff (1 s → 2 s → … → max 30 s)
- a port that lived > 5 s resets the backoff to 1 s
- a `chrome.alarms` alarm (`pagemap-reconnect`, every 30 s) reconnects if the service worker was killed

## Acceptance criteria
- [ ] Move the backoff decision into a small pure function (e.g. `nextBackoff(current, livedMs)`) that `background.js` uses
- [ ] Unit tests cover: doubling, cap at 30 s, reset after a long-lived port
- [ ] No behaviour change; all existing tests pass


---
**Rules:** follow [AGENTS.md](https://github.com/xlucifer65/page-map/blob/main/AGENTS.md). Add tests that fail before your change and pass after. Run `npm test` and `npm run test:e2e`. Do not weaken secret masking, the blocklist, the untrusted-content marker or socket permissions. `node scripts/tool-size.js` must not grow unless the issue says so.
