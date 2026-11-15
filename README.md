# Page-Map — open-source, low-cost browser control for AI agents

[![CI](https://github.com/xlucifer65/page-map/actions/workflows/ci.yml/badge.svg)](https://github.com/xlucifer65/page-map/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Page-Map lets any AI agent — Claude Code, Cursor, Codex, VS Code, any MCP client — read and control your real
Chrome through the page's structure instead of screenshots.** It is free, runs locally, needs no API key, and
several agents can work in parallel tabs.

Looking for a **cheaper alternative to screenshot-based computer use or browser agents**, a **multi-agent browser
tool**, or **zero-cost replay of repeated browser tasks**? That's what this is.

| Same 5 real tasks, same Chrome | Page-Map | Screenshot + pixel-click loop |
|---|---|---|
| Success | **15/15** | 12/15 (fails dropdowns) |
| Cost | **$0.40** | $1.27 (3.2× more) |
| Time | **132 s** | 246 s (1.9× slower) |
| 5 tasks in parallel | **13.4 s** | not possible (needs the one visible tab) |
| Repeating a task | **$0, < 3 s** (recipe replay) | full price every time |

<sub>Measured with `scripts/compare.js` (Claude via `claude -p`, 3 runs per task, answers checked against live sources). Reproduce it yourself.</sub>

```
AI agent ──MCP──► mcp/server.js ──private socket──► native host ──native messaging──► extension ──► your tabs
```

The agent is the brain; Page-Map is its eyes and hands. Scripts do everything deterministic; the agent only decides.

## Install (macOS / Linux, Chrome)

```sh
git clone https://github.com/xlucifer65/page-map.git && cd page-map
npm install
npm run install-host          # registers the native host with Chrome
npm run install-host -- --browser brave   # or chromium | edge | all (default: chrome)
```

1. Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked** → pick `./extension`
   (or unzip the latest [release](../../releases)). The manifest `key` pins the id to `hmoipddaijkfcidjilmbbiodbmgedbjm`.
2. Add the MCP server to your agent:

   | Agent | Command / config |
   |---|---|
   | Claude Code | `claude mcp add -s user page-map -- node "$PWD/mcp/server.js"` |
   | Cursor / VS Code / others | MCP server, stdio: command `node`, args `["<repo>/mcp/server.js"]` |

3. Ask your agent: *"Open news.ycombinator.com and tell me the top story."*

Windows isn't supported yet (needs a registry-based host install) — PRs welcome.

## Tools

| tool | what it does |
|---|---|
| `navigate(url)` | opens a page; returns its outline + text preview + `[site memory]` (known elements, recipes) |
| `outline` | title, landmarks, headings with refs, element counts, ~700-char text preview |
| `read_text(query?)` | main content as markdown; `query` returns only matching lines ("binomial name" → `Binomial name \| Columba livia`) |
| `find(query, role?)` | best matching elements with refs |
| `read_page` | interactive elements on screen: `ref role "name" =value [flags]` |
| `click` / `type` / `select_option` | by ref **or label** (`type(label="Search", text="…", submit=true)`); returns only what changed, or the new page if it navigated |
| `fill_form(fields, submit)` | fills text fields, dropdowns (native and custom) and checkboxes by label in one call |
| `batch(steps)` | several steps in one call; stops at the first failing step |
| `save_recipe` / `run_recipe` | save a finished task as label-based steps; replay with new values, step-checked |
| `list_tabs`, `screenshot` (fallback), `stats` | tabs; image for canvas apps; token/latency metrics |

Generic skills run automatically: cookie banners / consent walls / newsletter popups are closed (preferring
"Reject all"), custom dropdowns are opened and picked, secrets are never read.

**Recipes & site memory** live in `~/.page-map/recipes.json` (never in the agent's context). Replay with zero
model tokens: `node scripts/recipe.js run signup-form --"Full name"="Alan Turing"`.

**Parallel agents:** every MCP server gets its own socket in `~/.page-map/sessions/`; the native host routes
replies to the session that asked, and each session sticks to its own tab.

Refs carry a random 4-letter prefix per page load (`kqxa`), so a ref from a previous page is rejected rather than clicking
something else. Example `read_page` output:

```
Fixture Shop — http://127.0.0.1:5173/shop.html
kqxa3 link "Home"
kqxa4 link "Second page"
kqxa8 textbox "Search products" ="knives"
kqxa9 button "Search"
kqxa11 combobox "Country" ="Germany"
kqxa13 password "Password" ="<secret>" [secret]
… 1 more off-screen (scroll or viewport_only=false)
```

## Benchmark (`npm run bench`)

Estimated tokens (chars/4) on real pages, 1280×800, vs. one screenshot ≈ 1,365 tokens:

| page | find | outline | viewport | full page | raw HTML |
|---|---|---|---|---|---|
| GitHub repo page | 38 | 363 | 1,024 | 2,921 | 116,339 |
| Hacker News | 0* | 23 | 975 | 1,466 | 8,505 |
| Amazon home | 63 | 217 | 795 | 2,040 | 337,773 |
| YouTube home | 38 | 54 | 276 | 277 | 300,893 |

\*no "search" element on HN. All views computed in < 15 ms. The real saving comes from `find` + `outline` + diffs
replacing a screenshot on *every* step.

## Head-to-head vs. screenshots (`node scripts/compare.js --runs 3 --parallel`)

Same 5 real tasks (GitHub, Hacker News, Wikipedia search, MDN, a signup form), same Chrome, Claude via `claude -p`,
3 runs each. "Screenshots" = classic screenshot + pixel-click loop. Answers checked automatically against live sources.

| | Page-Map (structure) | Screenshots |
|---|---|---|
| Success | **15/15** | 12/15 (fails native dropdowns) |
| Cost | **$0.40** | $1.27 (3.2×) |
| Time | **132 s** | 246 s (1.9×) |
| Turns | **45** | 157 |
| All 5 tasks in parallel | **13.4 s wall** | not possible (needs the one visible tab) |

Recipes (learn once, replay with **new** values):

| | learn | agent replay | `scripts/recipe.js` replay |
|---|---|---|---|
| Wikipedia search | $0.045 · 13 s | $0.033 · 11.5 s | **$0 · 0.8 s** |
| Signup form | $0.026 · 11 s | $0.022 · 9 s | **$0 · 3 s** |

## Safety

- Password, card/CSC, one-time-code, PIN, API-key/token field values — and any Luhn-valid card number — are never read (`<secret>`); `type` refuses secret fields unless `allow_secret=true`.
- Blocklist (email, messaging, payments, banks, password managers by default; plain patterns cover subdomains) — checked in the service worker *and* against the page's real URL in the content script, so redirects can't slip through. Blocked tabs show only their host in `list_tabs`. Edit in the extension's **Options** page; agents can't change it.
- Every result and every extension error is prefixed with a marker telling the agent that page text is untrusted data, not instructions.
- Local only: unix socket `~/.page-map/pagemap.sock` (0600 in a 0700 dir). No TCP port, no network calls.

## Tests

```sh
npm test            # unit: DOM core (jsdom), native framing, MCP server with a fake extension
npm run test:e2e    # real Chromium + extension + native host + MCP server
npm run bench       # token benchmark on live sites
```

`CHECKLIST.md` lists every requirement and the test that proves it. `.claude/agents/page-map-monitor.md`
is an independent auditor agent that re-checks the whole checklist.

## Contributing

Issues, site reports and PRs are welcome — from people and from coding agents. See [CONTRIBUTING.md](CONTRIBUTING.md)
and [AGENTS.md](AGENTS.md). Security reports: [SECURITY.md](SECURITY.md) (please report privately).

Page-Map is an independent community project. It is not affiliated with or endorsed by Anthropic, Google, or any
browser or AI vendor.

## Limits / next

- Main frame only (no iframes yet); closed shadow roots and canvas apps (Google Sheets, Figma) need `screenshot`.
- One MCP server and one browser at a time: a second server or a second Chrome profile gets a clear refusal.
- Any process running as your user could impersonate the server socket while no server runs — same trust level as your Chrome profile files.
- The host wrapper pins the node binary path; re-run `npm run install-host` after upgrading node.
- `type(submit=true)` skips form submit when the page `preventDefault`s Enter itself; pages that handle Enter without that may submit twice.
- Huge pages (>60k nodes): only `read_page` says the scan was cut short.
- Default blocklist is host-based, so `icloud.com` and `wise.com` are blocked whole (incl. non-sensitive parts). Card-number masking also hides IMEIs (also Luhn-valid).
- Next: recipes (record/replay per-site action sequences = 0 tokens), image semantics (dominant color, OCR, CLIP), Chrome built-in AI labeling.
