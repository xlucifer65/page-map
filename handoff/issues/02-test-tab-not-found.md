## Goal
Calling a tool with a tab id that does not exist must fail clearly, and the session's sticky tab must reset.

## Acceptance criteria
- [ ] e2e test in `tests/e2e/extension.e2e.test.js`: `outline({ tab: 999999 })` → `isError`, text contains `tab 999999 not found (call list_tabs)`
- [ ] e2e test: after a session's tab is closed (`page.close()` on the tab it navigated), the next call without `tab` does not keep failing — `currentTab` in `mcp/server.js` is reset
- [ ] Fix the code if either test fails


---
**Rules:** follow [AGENTS.md](https://github.com/xlucifer65/page-map/blob/main/AGENTS.md). Add tests that fail before your change and pass after. Run `npm test` and `npm run test:e2e`. Do not weaken secret masking, the blocklist, the untrusted-content marker or socket permissions. `node scripts/tool-size.js` must not grow unless the issue says so.
