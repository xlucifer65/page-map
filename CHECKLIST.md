# Page-Map — Build Checklist

Goal: let any MCP-capable AI agent (Claude Code, Cursor, …) read and drive Chrome tabs
through **structure, not screenshots** — few tokens, fast, no API keys in the extension.

Architecture (verified against docs 2026-11-14):

```
AI agent ──stdio MCP──► mcp/server.js ──unix socket (0600)──► host/native-host.js ──native messaging──► extension SW ──► content script
```

Each part is owned by one "expertise". Every item has a test or check that proves it (→).

## A. DOM / Accessibility (content script)
- [x] A1 Collect only meaningful elements (links, buttons, inputs, selects, textareas, [role], headings, images, [onclick], contenteditable) → unit
- [x] A2 Skip invisible elements (0×0, display:none, visibility:hidden, aria-hidden, hidden inputs) → unit
- [x] A3 Accessible name: aria-labelledby → aria-label → label[for]/wrapping label → alt → title → placeholder → text, trimmed to 80 chars → unit
- [x] A4 Role mapping (a→link, input types→textbox/checkbox/radio/button, select→combobox, h1-6→heading) → unit
- [x] A5 Stable refs via a WeakMap (no DOM writes); same element keeps its ref across rescans; refs carry a random per-page-load prefix (`kqx12`) so refs from an old page are rejected → unit + e2e
- [x] A6 State flags: checked, disabled, expanded, selected, focused, current value of non-secret fields (truncated) → unit
- [x] A7 Open shadow roots are walked → unit
- [x] A8 Compact line format: `12 button "Sign in"` (+ flags) → unit

## B. Browser platform (MV3)
- [x] B1 Manifest V3, fixed extension ID via `key` → manifest check + e2e
- [x] B2 Service worker routes commands to the right tab's content script → e2e
- [x] B3 Native port with reconnect/backoff (+ chrome.alarms retry) when host or server is down → first connect e2e; reconnect/backoff by code review only
- [x] B4 Respect native-messaging 1 MB host→Chrome limit (unit); Chrome→host text replies truncated at 512 KB (code review)
- [x] B5 Diffs (added/removed/changed) computed on demand by snapshot comparison; MutationObserver detects when the page has settled after an action → unit + e2e
- [x] B6 Tabs opened before install get the scripts injected on first use → code review only (no dedicated test)

## C. Agent integration (MCP)
- [x] C1 MCP v2 stdio server (`@modelcontextprotocol/server`), logs only to stderr → integration
- [x] C2 Tools: `list_tabs`, `outline`, `find`, `read_page`, `click`, `type`, `select_option`, `scroll`, `navigate`, `changes`, `stats` → integration
- [x] C3 Clear errors when extension not connected / ref stale / tab missing (`isError: true`) → integration
- [x] C4 Install script: host manifest at `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, absolute node path → script check
- [x] C5 README: one-line `claude mcp add` instructions → doc check

## D. Security
- [x] D1 Never read values of password / hidden / credit-card (`autocomplete=cc-*`) / one-time-code fields → unit
- [x] D2 Site blocklist (banking/email defaults, user-editable) — blocked pages return nothing → unit + e2e
- [x] D3 Page text marked as untrusted data in every MCP result → integration
- [x] D4 Socket file mode 0600 in a 0700 dir; no TCP port opened → integration
- [x] D5 Service worker only accepts messages from its own content scripts / native port → code review
- [x] D6 `type` refuses password fields unless `allow_secret: true` → unit

## E. Token efficiency / speed
- [x] E1 `outline` (headings + landmarks + counts) is the cheap default view → unit
- [x] E2 `read_page` defaults to viewport-only, has `max_items` → unit
- [x] E3 `find` returns top matches only (exact > prefix > substring > word overlap; no typo tolerance yet) → unit
- [x] E4 Actions return a small diff, not the full page → e2e
- [x] E5 Metrics: chars + estimated tokens + latency per tool call logged; `stats` tool reports them → integration

## F. QA
- [x] F1 Unit tests (vitest + jsdom) for content core → `npm test`
- [x] F2 Native framing tests (length prefix, partial chunks, big messages) → `npm test`
- [x] F3 MCP integration test with a fake extension on the socket → `npm test`
- [x] F4 End-to-end: real Chromium + extension + host + MCP client clicks a button on a fixture page → `npm run test:e2e`
- [x] F5 Benchmark script: tokens of `outline`/`read_page`/`find` on live sites (or any URLs passed) vs. screenshot estimate → `npm run bench`

## G. Monitoring
- [x] G1 Independent monitor agent (`.claude/agents/page-map-monitor.md`) audits code against this checklist, runs all tests, reports PASS/FAIL per item
- [x] G2 Monitor findings fixed and re-verified — round 1: 14 findings (2 high) → all fixed or accepted, re-audited clean in round 2. Round 2: 10 findings → 1–4, 6–8 fixed with regression tests; 5 (submit heuristics) and 9 (cap notice only in read_page) documented as limits. Round-2 fixes not yet re-audited by the monitor.

## H. Turn savers, skills, parallel, memory (round 3–4)
- [x] H1 Actions that navigate return the new page's outline → e2e
- [x] H2 `batch` + `fill_form` (text, native/custom dropdowns, checkboxes by label) → e2e
- [x] H3 Label targeting for click/type/select (no find() needed) → e2e
- [x] H4 `read_text(query)` grep mode → unit + live Wikipedia check
- [x] H5 Auto-close cookie banners/popups (privacy-friendly choice first) → unit + e2e
- [x] H6 Multi-session host: parallel agents, sticky per-session tabs → e2e (two sessions at once)
- [x] H7 Recipes + site memory on disk; step-checked replay; zero-token CLI → unit + e2e + live benchmark
- [x] H8 Extension self-reload for updates (`scripts/reload-ext.js`) → live

## Later (not in this build)
- Same-uid socket squatting (monitor #14): accepted risk, any same-user process can already read Chrome's profile
- Multiple agents/browsers sharing one server (needs a daemon with routing)
- Recipes (record/replay action sequences per site) · image semantics (dominant color, OCR, CLIP) · Chrome built-in AI labeling
