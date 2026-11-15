#!/bin/sh
# Creates the Copilot handoff issues on GitHub from handoff/issues/*.md.
# Usage: bash handoff/create-issues.sh   (needs `gh auth login`)
set -e
cd "$(dirname "$0")/.."
REPO=xlucifer65/page-map
gh label create copilot --repo "$REPO" --color 6f42c1 --description "Handed off to Copilot coding agent" 2>/dev/null || true
gh label create "good first issue" --repo "$REPO" --color 7057ff 2>/dev/null || true

create() { # file title labels
  url=$(gh issue create --repo "$REPO" --title "$2" --body-file "handoff/issues/$1" --label "$3")
  echo "$url  $2"
}
create 01-test-reconnect.md       "Test: native port reconnect + backoff"               "copilot,good first issue"
create 02-test-tab-not-found.md   "Test + fix: 'tab not found' and sticky-tab reset"    "copilot,good first issue"
create 03-large-page-notice.md    "Show 'page too large' notice in find/outline/diffs"  "copilot,good first issue"
create 04-find-typo-tolerance.md  "Typo tolerance in find()"                            "copilot,good first issue"
create 05-other-browsers.md       "Native host install for Chromium, Brave and Edge"    "copilot,good first issue"
create 06-same-origin-iframes.md  "Same-origin iframe support"                          "copilot,enhancement"
create 07-safer-submit.md         "Safer submit: no double submits"                     "copilot,bug"
create 08-windows-plan.md         "Windows support — write the plan"                    "copilot,enhancement"
