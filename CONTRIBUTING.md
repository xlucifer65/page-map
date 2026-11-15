# Contributing to Page-Map

Thanks for helping! Page-Map is a community project: issues, site reports, fixes and new skills are all welcome —
from humans and from coding agents (Copilot, Claude Code, Codex…).

## Quick start

```sh
git clone <your fork> && cd page-map-extension
npm ci
npx playwright install chromium
npm test            # unit + MCP integration (fast)
npm run test:e2e    # real Chromium + extension + native host + MCP server
```

Load `./extension` in `chrome://extensions` (Developer mode → Load unpacked) and run `npm run install-host` to try it live.
After editing extension code, `node scripts/reload-ext.js` reloads it without touching Chrome.

## What makes a good PR

- **One problem per PR**, with a test that fails before and passes after. Most fixes belong in
  `tests/unit/core.test.js` (jsdom, fast) or `tests/e2e/` (real browser).
- **Keep agent cost low.** Tool descriptions and results are re-sent to the model on every turn:
  `node scripts/tool-size.js` must not grow without a reason, and new output should be compact.
- **Measure claims.** If a change is about speed/tokens, include `node scripts/compare.js --only <task> --modes structure` output.
- **Never weaken safety** (secret masking, blocklist, untrusted marker, socket permissions) without discussing it in an issue first.
- Plain JavaScript (ES modules), no build step, no new runtime dependencies without discussion.

## Reporting a site that doesn't work

Use the **"Site doesn't work"** issue template: URL, what you asked the agent, and the `outline` / `read_page`
output. Don't paste anything private — Page-Map output can include page text.

## Releases

Every merge to `main` runs CI. Bumping `version` in `extension/manifest.json` (and `package.json`) publishes a
GitHub Release with a zipped extension automatically.

## Code of conduct

Be kind, assume good intent, keep discussions technical. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
