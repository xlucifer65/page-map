## Goal
`find("serch")` returns nothing today. Agents and users make typos.

## Acceptance criteria
- [ ] In `find()` (`extension/core.js`), add a typo tier: a query word within edit distance 1 of a word in the element name (words ≥ 4 letters) scores **below** substring matches
- [ ] Exact / prefix / substring ranking is unchanged (existing tests pass)
- [ ] `minScore` (used by label targeting) still rejects junk: `resolveField("Emial")` may match "Email", but `find("zzzz")` still returns nothing
- [ ] Unit tests for all of the above


---
**Rules:** follow [AGENTS.md](https://github.com/xlucifer65/page-map/blob/main/AGENTS.md). Add tests that fail before your change and pass after. Run `npm test` and `npm run test:e2e`. Do not weaken secret masking, the blocklist, the untrusted-content marker or socket permissions. `node scripts/tool-size.js` must not grow unless the issue says so.
