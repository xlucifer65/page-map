## Goal
`scripts/install-host.js` only registers the native host for Google Chrome. Chromium, Brave and Edge users can't use Page-Map.

## Acceptance criteria
- [ ] `--browser chrome|chromium|brave|edge|all` option (default `chrome`) writing the host manifest to each browser's user-level NativeMessagingHosts folder on macOS and Linux (look up the official paths for each browser and cite them in a code comment)
- [ ] Export the browser → folder mapping as a function and unit test it for both platforms
- [ ] README install section documents the option


---
**Rules:** follow [AGENTS.md](https://github.com/xlucifer65/page-map/blob/main/AGENTS.md). Add tests that fail before your change and pass after. Run `npm test` and `npm run test:e2e`. Do not weaken secret masking, the blocklist, the untrusted-content marker or socket permissions. `node scripts/tool-size.js` must not grow unless the issue says so.
