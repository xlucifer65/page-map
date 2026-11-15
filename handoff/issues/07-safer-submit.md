## Goal
`type(..., submit=true)` (`act()` in `extension/core.js`) fires Enter and then calls `form.requestSubmit()` unless the page called `preventDefault()`. Pages that handle Enter themselves *without* preventDefault get submitted twice.

## Acceptance criteria
- [ ] After dispatching Enter, wait one task; if the URL changed or the form/DOM reacted, skip `requestSubmit()`
- [ ] e2e fixtures: (a) form that only submits natively, (b) page whose keydown handler submits via fetch without preventDefault — each must submit exactly once (count on a local test server)
- [ ] Existing submit tests still pass


---
**Rules:** follow [AGENTS.md](https://github.com/xlucifer65/page-map/blob/main/AGENTS.md). Add tests that fail before your change and pass after. Run `npm test` and `npm run test:e2e`. Do not weaken secret masking, the blocklist, the untrusted-content marker or socket permissions. `node scripts/tool-size.js` must not grow unless the issue says so.
