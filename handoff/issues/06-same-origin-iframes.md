## Goal
Content inside iframes is invisible to Page-Map today (`walk()` and `readText()` only see the top document).

## Acceptance criteria
- [ ] Same-origin iframes: their elements appear in `read_page`, `find`, `read_text` and can be acted on by ref (refs must stay unique across frames)
- [ ] Cross-origin iframes are listed as a single line `[iframe: <host>]` and are not read
- [ ] Blocklist still applies per frame URL
- [ ] e2e fixture page with a same-origin iframe containing a form; test fills and submits it with `fill_form`


---
**Rules:** follow [AGENTS.md](https://github.com/xlucifer65/page-map/blob/main/AGENTS.md). Add tests that fail before your change and pass after. Run `npm test` and `npm run test:e2e`. Do not weaken secret masking, the blocklist, the untrusted-content marker or socket permissions. `node scripts/tool-size.js` must not grow unless the issue says so.
