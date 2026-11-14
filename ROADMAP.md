# Echo roadmap

_Written 11/12 night. Thesis: most "facts" online are one source repeated. Echo shows how many independent origins a
claim really has. The product wins when that answer is (1) fast to get, (2) easy to share, (3) believable._

## Branches
- `demo` — frozen at db4f810 (all checks green). Saturday's stage build. Only verified bug fixes go in.
- `main` — where the big features go, each one still verified (lint, checks, build, smoke, preflight).

## Who it is for (assumptions until someone pays)
- Journalists and fact-checkers: "Is this stat sourced, or just repeated?" Need speed and a citable trail.
- Comms, policy and research teams: checking a number before it goes in a deck or a report.
- Curious readers and students: the viral claim in the group chat.
Nobody has paid yet; these are guesses to test, not findings.

## Phase 1 — tonight and Friday (offline-buildable, demo-safe)
1. ✅ **Trace from anywhere (bookmarklet).** (`/anywhere`) Select text on any page, click "Trace with Echo", and Echo opens with the
   claim filled in. Uses the existing `?claim=` links, so it never starts a paid run by itself. Growth: Echo meets
   claims where they are read.
2. ✅ **Explore gallery.** (`/explore`) A page of real, scored traces (the bundled runs) with their verdicts: "0 verifiable origins",
   "2 origins, 13 echoes". The front door for first-time visitors and search engines, and a stage backup.
3. ✅ **Watch the echo spread.** (result view + Present slide 3) An animated timeline replaying how a claim spread year by year from its origins,
   built from reliably dated pages only. The stage "wow" that makes the idea land in five seconds.
4. ✅ **Polish:** the brand link resets to a blank workbench; the PRESENTER_ONLY banner gets its own heading; the
   stalled-run clock resets.

## Phase 2 — Friday, needs a paid live test or a decision from Lucas
5. **Permalinks for live traces** (`/t/<id>`): any live run becomes a shareable page. Needs storage: Upstash Redis
   (already used for the budget ledger) or Vercel Blob. _Decision: which store, and is every trace public?_
6. ✅ **Trace an article URL** (free version, no model call): paste a link, Echo reads the page and suggests the
   sentences that state a figure or credit a source; pick one, then trace it. A Claude-picked "central claim" could
   come later and would need a live cost test.

## Phase 3 — after the hackathon
7. ✅ **Browser extension** (`extension/`, Manifest V3, load unpacked; not in a web store): right-click "Trace with Echo"
   fills the claim box via `?claim=` and never starts a paid run. Chrome/Edge/Brave; Firefox not yet.
8. Public API with keys and per-key budgets, for newsrooms and research tools.
9. Claim watch: re-run a claim weekly and alert when a new echo or a new origin appears.
10. Publisher badge: "Echo-checked: 2 independent origins," linking to the permalink.

## What would make us wrong
- If judges or users do not trust the copy-detection, nothing above matters. Measure accuracy on labels a human
  checked (the current labels are AI-made) before claiming numbers publicly.
- Cost per trace (~$0.15–0.25) must fall, or a free public tier cannot exist. Try Haiku for grouping and judging.
