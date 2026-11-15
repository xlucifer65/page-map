## Goal
Page-Map doesn't run on Windows. **This issue is planning only** — write the plan, don't implement it.

## Acceptance criteria
- [ ] `docs/windows.md` describing: native host registration via registry key (HKCU) per browser, a `.bat` wrapper for node, replacing unix sockets with named pipes (`\\\\.\\pipe\\page-map-<pid>`) in `host/paths.js` / `mcp/bridge.js` / `host/native-host.js`, and a `windows-latest` CI job
- [ ] List the files that change and the tests needed, split into 3–4 follow-up issues (write their titles + acceptance criteria in the doc)


---
**Rules:** follow [AGENTS.md](https://github.com/xlucifer65/page-map/blob/main/AGENTS.md). Add tests that fail before your change and pass after. Run `npm test` and `npm run test:e2e`. Do not weaken secret masking, the blocklist, the untrusted-content marker or socket permissions. `node scripts/tool-size.js` must not grow unless the issue says so.
