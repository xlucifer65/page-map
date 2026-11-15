# Instructions for coding agents (Copilot, Claude Code, Codex, Cursor…)

Page-Map = Chrome MV3 extension (`extension/`) + native messaging host (`host/`) + MCP server (`mcp/`).
Agents call MCP tools → server → per-session unix socket → native host → extension service worker → content script.

## Layout
- `extension/core.js` — pure DOM logic (snapshot, outline, readText/grepText, find, act, skills, safety). Runs in the page and in jsdom tests. **Most changes go here.**
- `extension/content.js` — async orchestration in the page (settle, batch/fill_form, dropdowns, step reporting).
- `extension/background.js` — service worker: routing, blocklist, navigation handling, screenshots.
- `host/native-host.js` — relays Chrome ⇄ every session socket in `~/.page-map/sessions/`.
- `mcp/server.js` — MCP tools; `mcp/recipes.js` — recipes + site memory on disk.
- `scripts/compare.js` — benchmark vs a screenshot loop (costs real model tokens; don't run in CI).

## Rules
1. Run `npm test` and `npm run test:e2e` before finishing. Add a test for every fix (`tests/unit/core.test.js` for DOM logic).
2. Tool descriptions/results are paid on every model turn: keep them short; check `node scripts/tool-size.js`.
3. Never weaken: secret masking (`isSecret`, `maskCards`), blocklist (checked in service worker *and* content script), the untrusted-content marker, 0600/0700 permissions.
4. No build step, no TypeScript, no new runtime dependencies without an issue discussing it.
5. Refs are per-page-load (`kqxa12`); recipes store labels + roles, never refs or coordinates.
