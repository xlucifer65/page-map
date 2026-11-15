## Goal
`extension/core.js` stops walking the DOM after `MAX_VISIT` (60,000) nodes. Only `read_page` (via `format`) tells the agent; `find`, `outline` and action diffs truncate silently, so the agent may wrongly conclude an element does not exist.

## Acceptance criteria
- [ ] `find`, `outline` and the diff returned by actions append a short notice when the scan was capped (e.g. `… page very large: scan stopped after 60000 nodes`)
- [ ] Unit test with a generated page larger than the cap (lower the cap via an option in the test rather than building 60k nodes, if that keeps the test fast)
- [ ] Notice adds no tokens on normal pages


---
**Rules:** follow [AGENTS.md](https://github.com/xlucifer65/page-map/blob/main/AGENTS.md). Add tests that fail before your change and pass after. Run `npm test` and `npm run test:e2e`. Do not weaken secret masking, the blocklist, the untrusted-content marker or socket permissions. `node scripts/tool-size.js` must not grow unless the issue says so.
