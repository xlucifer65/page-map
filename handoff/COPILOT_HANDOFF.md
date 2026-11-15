# Handoff — Page-Map

**From:** Rayyan · **To:** GitHub Copilot coding agent · **Date:** 2026-11-15
**Repo:** https://github.com/xlucifer65/page-map

## Context (read first)
Page-Map lets AI agents control Chrome through page structure instead of screenshots.
Read [AGENTS.md](../AGENTS.md) for the code layout and rules. Benchmarks in the README are the bar:
changes must not make agents use more turns or tokens.

Pipeline: MCP tool (`mcp/server.js`) → per-session unix socket → native host (`host/native-host.js`)
→ extension service worker (`extension/background.js`) → content script (`extension/content.js` + `extension/core.js`).

Commands: `npm ci && npx playwright install chromium`, then `npm test` (fast) and `npm run test:e2e` (real Chromium).

## Tasks (one issue each, in this order)

| # | Task | Size | Issue body |
|---|---|---|---|
| ☐ 1 | Test: native port reconnect + backoff | S | [01](issues/01-test-reconnect.md) |
| ☐ 2 | Test + fix: "tab not found" and sticky-tab reset | S | [02](issues/02-test-tab-not-found.md) |
| ☐ 3 | "Page too large" notice in find / outline / diffs | S | [03](issues/03-large-page-notice.md) |
| ☐ 4 | Typo tolerance in `find` | S | [04](issues/04-find-typo-tolerance.md) |
| ☐ 5 | Native host install for Chromium, Brave, Edge | S | [05](issues/05-other-browsers.md) |
| ☐ 6 | Same-origin iframe support | M | [06](issues/06-same-origin-iframes.md) |
| ☐ 7 | Safer `submit` (no double submits) | M | [07](issues/07-safer-submit.md) |
| ☐ 8 | Windows support — plan only | M | [08](issues/08-windows-plan.md) |

Do them one PR per issue. Tasks 1–5 are independent; 6 and 7 touch `core.js`/`content.js`, so rebase on `main` before opening the PR.

## Rules for every PR
- ☐ Tests added that fail before and pass after (not only "existing tests pass")
- ☐ `npm test` and `npm run test:e2e` green in CI
- ☐ `node scripts/tool-size.js` unchanged unless the issue asks for a new tool option
- ☐ No weakening of: secret masking (`isSecret`, `maskCards`), blocklist (service worker *and* content script), untrusted-content marker, 0600/0700 permissions
- ☐ No new runtime dependencies, no build step, no TypeScript
- ☐ Don't bump the extension version (Rayyan does releases)

## How Rayyan reviews
1. Read the new tests first — do they really prove the claim?
2. Check the PR template checklist.
3. For behaviour changes in the page, try it live: `node scripts/reload-ext.js`, then use the tool from Claude Code.
4. Squash-merge. To release: bump `version` in `extension/manifest.json` + `package.json` on `main`.

## Filing the issues
`bash handoff/create-issues.sh` creates all 8 issues (labels: `copilot`, plus `good first issue` for 1–5)
and prints their URLs. Then assign each to **Copilot** on GitHub (Assignees → Copilot), one or two at a time.
