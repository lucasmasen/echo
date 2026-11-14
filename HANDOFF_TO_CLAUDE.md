# Echo handoff (current state, 2026-11-12 evening)

Read this first in any new Claude Code session. It replaces the earlier Codex-to-Claude handoff.

## Start here (state at 2026-11-12 ~6:30pm PT)

- **Hackathon Saturday Nov 14, 10am–7pm PT; code freeze 4:15pm (build stops about 2pm; the demo is a recorded video).** Demo: slots 01 brain, 02 phones; backups goldfish and
  head heat (all four open saved live runs offline). `npm run preflight -- --serve` and `npm run smoke:ui` pass.
- **What changed on 11/12** (details in the dated bullets below): retelling check on; Echo reads each page's own HTML
  for source links, publisher dates (US-style, deep in page, journal issue months) and article text when search
  extraction fails; cited-parent and PubMed-copy rules; duplicate addresses and same-publication roots merged; a fix
  so live traces with newer citation rules can be reopened; `trace:claim`, `rejudge:trace --dates --links`.
- **Measured:** fresh live head heat 10/15, 2 wrong (was 5/13, 6 wrong); fresh spiders 11/15, 0 wrong, exact parents
  3/6 (was 0/8). Unseen claims are weaker: Vikings 12/20 (2 wrong), knuckles re-judged with all current rules
  (`rejudge:trace --dates --links`) **14/19, 1 wrong, exact parents 3/6** (saved run: 12/19, 3 wrong) with AI labels.
  Nine unseen claims ran live with no crashes (30–51 s each).
- **Known weak spots:** pages that use a quote or a myth in their own essay get counted as origins (Einstein quote: 7
  origins); some sites block Echo's honest bot user agent (403), so their links are unseen; cross-claim-group links
  (Badger, Yardstick) are not drawn by design.
- **Later 11/12 evening (free):** server-safety (every redirect hop and DNS answer checked before a direct page
  fetch; bounded HTML scans so a malformed page can't stall the server; oversized API bodies refused); citations also
  read from the page's own article text (trimmed reference lists: +7 labeled parents, 0 spurious), with headings kept
  as "#" so a page's own headline is never a citation; links to articles moved between site sections (same slug);
  dates more than two days in the future refused; a PubMed-record copy that also cites the article is linked to the
  article; non-English claims pick their passage with accented words; "cap reached" shown on the budget line;
  `npm run eval:all` (one table of every scored run).
- **Money (since 11/13 10pm):** one cap per provider per Pacific day: Claude $50 (runaway ceiling,
  `ECHO_CLAUDE_DAILY_CAP_USD`), Tavily $5 (`ECHO_TAVILY_DAILY_CAP_USD`), Telem $3 (`ECHO_TELEM_DAILY_CAP_USD`) plus
  Telem's running total against its $20 prepaid credit (`ECHO_TELEM_CREDIT_USD`, advisory). Telem's credit is the money
  to be careful with; at its day cap a run searches with Tavily instead.
- **Deep search (11/13, opt-in per run):** the claim box's Standard | Deep toggle (`src/lib/echo/search-mode.ts`): at
  most 16 searches of 20 results, up to 50 pages, judged in batches of 20. Estimate (measure:cost, not yet a live run):
  ≈$0.6–1.1 with Telem (up to $0.69 Telem credit), ~1–2 min. `npm run trace:claim -- "claim" --deep` from the terminal.

## Where things are

- **Project:** `~/Projects/echo` (moved out of iCloud-synced Documents on 2026-11-10; iCloud kept creating
  "file 2" copies that broke builds). Old copies under `~/Documents/Codex/2026-11-08/` are stale. Don't work there.
- **Git:** one branch, `main`, local only. **No remote. Never push, add a remote, or deploy** unless Lucas asks.
- **Event:** SearchHack, Nov 14 2026 (judged on innovation, technical execution, search intelligence, impact).
  Organizers said reusing this code is fine.
- **Demo runbook:** `DEMO_DAY.md`. **Pitch + judge Q&A:** `~/AI Infrastructure Claude/company/pitch/3min-judges-echo-searchhack.md`.

## Money rules

- Echo's live analysis spends real money (Anthropic + Tavily + Telem). Since 11/13 the app enforces **one cap per
  provider per Pacific day** in `.echo/anthropic-daily-budget.json` (version 2): Claude $50 (a runaway ceiling), Tavily $5
  (at `ECHO_TAVILY_USD_PER_CREDIT`, default $0.008/credit), Telem $3, plus Telem's running total against its $20 prepaid
  credit (advisory). It replaced the combined $2 cap; an old ledger still loads (its days count as Claude's).
- **Never run a live trace or `npm run pretest:claim` without Lucas explicitly asking** for that run.
  All checks (`npm run check:*`) are offline and free. `npm run scout:claim` fetches public pages directly and is free.
- A live trace costs about $0.25–0.30 (≈$0.05–0.08 Claude + ≈18–20 Tavily credits).

## What exists and is verified (offline checks + production build pass)

- Pipeline: Tavily search (10 results per basic query) → extraction → publisher dates read directly from page
  HTML (`page metadata`, with "Date from" evidence) → Claude grouping (by assertion only) → Claude source judgment
  with deterministic guards (chronology, co-published originals, verified citations, partial-judgment salvage) →
  answer from roots only, with a number-grounding check.
- **Retelling check (11/12, on by default; `ECHO_RETELLING_CHECK=0` turns it off).** The judge now tags each origin
  firsthand / own-analysis / retelling; a retelling (restates the claim, credits an outside source not in the trace
  or nobody, no data of its own) is shown as unclear, not as an independent origin. Measured with
  `npm run rejudge:trace` (re-runs only the judge on a saved trace, ~$0.04/run, through the $2 ledger) against 5
  label sheets, 10 runs each way: **wrong confident calls 11 → 6**; pages matching labels equal or better on brain,
  goldfish, spiders, head heat; phones about 1.4 lower on average (13,13,12 → 11,11,10,13). Fresh live head-heat run
  re-judged: 7 wrong → 1 wrong. Bundled demo traces are unchanged. A first, stricter wording removed real
  origins (brain 16 → 10) and a tag-only wording added wrong calls; both were dropped.
- **HTML source links (11/12, on by default; `ECHO_HTML_LINKS=0` turns it off).** Echo now fetches each retrieved
  page's own HTML (free; one direct fetch per page serves both its links and its publisher date; pages that need a date keep the 6 s per-page limit, the rest share a 7 s step limit) and treats a body
  link to another retrieved page as a "link" citation. Nav, header, footer, sidebar, script blocks and own-site links
  are skipped. Search extraction had been dropping source lists. Free check against all 5 label sheets: the HTML links
  hit 10 of 23 labeled parents (text matching had found ~3 of those); 6 other links went to secondary sources the page
  also cites. Re-judged with links injected (~$0.12): spiders 12–14 → **16/20, 0 wrong, 5 exact links**; head heat
  11/12 6 → 8/13 (2 wrong, both origin calls on pages the links don't touch). Badger still unresolved: grouping put it
  in a different claim group ("40%") than WebMD.
- **Later 11/12 (free ticks):** one fetch per page now serves both date and links (dates matched the old reader on
  96/96 labeled pages); link matching keeps the URL query (every YouTube video is youtube.com/watch, which had made a
  Nature blog "link" to two unrelated videos); an HTML link to a page reliably dated *later* is ignored (added in an
  update); HTML link citations count as a visible parent link in the UI, and each page's details now list its
  verified citations ("Cites N retrieved pages"). `npm run rejudge:trace -- … --links` adds HTML-link citations to
  an old saved trace before re-judging. **Not yet seen on a fresh live run** — first paid thing to do 11/13: one live
  head-heat or spiders run (~$0.25) to confirm the links fire live and to check the added time.
- **Date reader (11/12 late):** US-style `01/04/2011` schema dates (ambiguous order assumed month-first only on
  English pages, noted in the evidence) and dates up to 1 MB into a page. WebMD now reads 2011-01-04 and YouTube
  videos get upload dates; all other publisher dates on the 96 labeled pages unchanged. `rejudge:trace --dates`
  re-reads dates for estimate-dated pages. Head heat 11/12 trace, `--mode on --dates --links`: **9/13, 2 wrong**
  (vs 6/13 saved-trace judge, 8/13 links only). Remaining wrongs: two retellings called origins; MeatEater's parent
  picked as Live Science (2013) rather than WebMD (2011) although its HTML links WebMD.
- **Cited-parent rule (11/12 late):** when the judge names a parent the page does not cite, but the page links to
  (or names the distinctive title of) exactly one earlier page in its group, Echo links it to the cited page
  (`citedParentOverride`). Free check on all saved traces with HTML links added: 4 parent picks changed, all 4 to the
  labeled parent (Fox 13 → PR Newswire ×3 traces, MeatEater → WebMD), none worse. Bundled demo traces unchanged.
- **Cost of the HTML step, measured free on all 11 saved traces' real pages:** the date step went from 0.6–5.2 s to
  0.9–4.7 s with links added (+0 to +2 s per run; runs take 40–55 s). On the three bundled demo claims a live rerun
  would now add only: phones, Fox 13's HTML link to PR Newswire (its labeled parent); goldfish and brain, YouTube
  upload dates from page microdata. The bundled traces are captured runs and were not edited.
- **Fresh live head-heat run 2 (11/12 ~5:20pm PT, $0.16, 42 s; `public/demo-traces/lose-most-body-heat-through-head.echo.json` (was evaluation/runs/…-run2))**
  with all of today's changes: 18 pages, 4 origins. Scored: **10/15 kinds, 2 wrong, 3 unclear, exact parents 2/4**
  (run 1 earlier today, old judge: 5/13, 6 wrong). HTML links fired live (FactMyth, Badger, MeatEater → WebMD);
  WebMD read as 2011-01-04 from its page; Badger and MeatEater correctly derived of WebMD. Wrongs: FactMyth derived of
  Live Science (it links both WebMD and Live Science, so the cited-parent rule leaves the judge's pick), and a
  ScienceDirect study page called an origin (labeled unclear). Jamaica Hospital left unclear (dashed to WebMD).
- **Fresh live spiders run 2 (11/12 ~5:30pm PT, $0.18, 37 s; `evaluation/runs/swallow-eight-spiders-a-year.2026-11-12-run2`):**
  20 pages, 5 origins. **11/15 kinds, 0 wrong, 4 unclear, exact parents 3/6** (11/11 live run: 12/20, 0 wrong,
  8 unclear, exact parents 0/8). Ripley's, Reconnect with Nature and Dreams linked to Scientific American by their
  HTML links. Misses: FOX8's page returns 403 to Echo's honest bot user agent, so its Snopes link is unseen (not
  worked around); Yardstick links Britannica but grouping put them in different claim groups; Britannica's dates are
  only estimates.
- **Unseen-claim live runs (11/12 ~5:40pm PT, $0.36; traces in the session scratchpad, unlabeled):** "Einstein failed
  math in school" (51 s, 19 pages, 4 origins: ABC 2004, TIME/Isaacson 2007, Scott Young, Commonplace Facts) and "Bulls
  are angered by the color red" (30 s, 14 pages, 2 origins). No crashes; both answers were "source-limited" (no root
  with primary evidence), the same honest outcome as the brain "ghost stat" slot. Found and fixed: the same ABC
  article returned at two addresses (http + ?site=, https) became two pages.
- **Four more unseen claims (11/12 ~6pm PT, $0.62, 36–44 s each, no crashes):** red lights (source-limited, 2
  origins), banana DNA (generated, 4 origins), Napoleon (generated, 2 origins), knuckle cracking (generated, 7
  origins). Fixed: the JABFM 2011 study and its PubMed abstract counted as two independent origins. Roots with the same
  distinctive title (5+ words, site name stripped) that cite each other or are dated within a year are now one
  "same publication" group; across all saved traces only that pair merges. UI label "same release as" → "same
  publication as".
- **Two more unseen claims (11/12 ~6:15pm PT, $0.35):** Einstein "insanity" quote (48 s, 20 pages, 7 origins; answer
  traces it to Rita Mae Brown 1983 via Quote Investigator, but opinion blogs using the quote counted as origins) and
  "2% have green eyes" (32 s, 20 pages, 1 origin, source-limited). Fixed: a page's own markdown heading that repeats
  another page's title (AARP's "# What Is the Rarest Eye Color" vs Glasses.com) was taken as a title citation. Of the
  9 saved title citations only the 3 heading matches drop; the "Sources:" ones stay.
- **More free fixes (11/12 evening):** journal `citation_publication_date` "1990 May" → first of month (2 PMC
  studies dated); the source-limited answer is now plain English; `npm run trace:claim` runs one ledgered live
  trace from the terminal. 9th unseen claim, "Vikings wore horned helmets" (42 s, $0.15): good answer (Gjermundbu
  helmet, Wagner 1876). Its actual source paper (journals.lib.unb.ca PDF viewer page) came back as a snippet only.
- **Page-text fallback (11/12 evening):** 68 of 337 saved pages were search-snippet only (mostly social sites that
  block fetches). When search extraction returns nothing for a page, Echo now uses the page's own `<article>`/`<main>`
  paragraphs from the same direct fetch (`extractionSource: "Page HTML"`, shown as "Text read from the page"), so
  it can be judged on its own words. Free live check: both snippet-only Guardian articles (2008, 2026 head-heat) now
  get 2–4k chars of clean text; sites returning 403 still fall back to the snippet. Survives export/import.
- **Two new label sheets (AI-made 11/12 evening, from full pages; need human spot-check):**
  `evaluation/vikings-wore-horned-helmets` (20: 5 origin, 4 derived, 6+5 unclear) and
  `evaluation/cracking-knuckles-causes-arthritis` (19: 7 origin, 6 derived, 6 unclear), with their live runs in
  `evaluation/runs/`. Scores on these unseen claims are lower than on the tuned ones: Vikings **12/20, 2 wrong, 0/4
  exact parents** (all four labeled copies point to History.com 2013, which the labeler calls a generic retelling;
  Echo calls it an origin); knuckles **12/19, 3 wrong, 1/6 exact parents** (PubMed record of the JABFM study judged
  an origin; two copies linked to the wrong one of two studies). Spot-check first: History.com's label.
- **Import bug fixed (11/12 evening):** 2 of 9 unseen-claim live traces (banana DNA, Napoleon) failed
  `parsePortableTrace`, so reopening the session, the recent-runs list, export/import and copy hunt would all have
  rejected them. Cause: since 11/12 a reliably dated page may cite an undated/estimate-dated parent, but the import
  check still allowed only the reverse. It now mirrors the pipeline (citation + exactly one side reliably dated, or a
  PubMed-style index copy). `check:pipeline` now re-imports every trace it produces (17). All 21 saved traces load.
- **Index records as copies:** a PubMed/Europe PMC/Semantic Scholar/ResearchGate record with the same distinctive title
  as a journal page in its group is derived of it (`indexRecordsAsCopies`). Knuckles labels: 12→13 kinds, 3→2 wrong.
- **Head-heat backup bundled (11/12 ~6:30pm PT, Lucas's yes):** run 2 moved to
  `public/demo-traces/lose-most-body-heat-through-head.echo.json`; the "Head heat loss" backup now opens it (offline
  cache v8). Baseline 10/15, 2 wrong, 3 unclear, exact parents 2/4. Its accuracy card lists the two pre-fix runs (10 and
  6 wrong) marked "earlier Echo" (runs before 2026-11-13T00:30Z, after a claim also has a newer run); the Present line says how many were before the fixes.
- **Caps (11/13):** `ECHO_DAILY_CAP_OVERRIDE_USD` and `ECHO_ANTHROPIC_DAILY_CAP_USD` (the old single $2 cap) are no
  longer read; each provider has its own variable (README, "one cap per provider").
- Citations can now set direction toward a page whose date is missing or only estimated, when a reliably dated page
  links to it or names its distinctive title (WebMD's 2011 interview carried a 2026 estimate). Mutual links give no
  direction. Unit-tested; it did not fire on the 11/12 live head-heat run (search text lacked the source list).
- New label sheets (AI-labeled from full pages 11/12, not human): `evaluation/lose-most-body-heat-through-head` (18)
  and `evaluation/swallow-eight-spiders-a-year` (20), with their traces in `evaluation/runs/`.
- Copy signals given to the judge: distinctive shared phrases, word-for-word overlap (claim restatements ignored),
  earlier-dated matches first, explicit citations (link / distinctive title / organization + year).
- Demo slots 01 and 02 open real captured traces in `public/demo-traces/` (offline-cached by the service worker).
  Slot 02 = "Americans check their phones 96 times a day" (**live run 2, swapped in 11/10 night with Lucas's yes**):
  13 pages → 2 origins, 31% echo. Asurion 2019 release (asurion.com + PR Newswire, one co-published origin) →
  Fox 13 → church blog; → KABC; → Narcissus reference page (undated, linked by its "Asurion (2019)" citation).
  Answer notes Asurion's own 2022 figure of 352. Old 11-page trace is in git history (before this commit).
- Offline mode (production build only) verified: reload offline, both slots, Present mode at 1280×720.
- Evaluation: `evaluation/americans-check-phones-96-times.labels.json`, 14 labels (AI-labeled from full pages, not
  human). Current demo scores **13/13 kinds, 0 mistakes, 0 abstentions**, exact parents 3/4 (Fox 13 → asurion.com
  vs labeled PR Newswire: same co-published release). 1 labeled page absent (Instagram). 6 of the 13 agreements are
  "unclear" = "unclear", so don't oversell the 100%. Old trace scored 9/11, 2 abstentions.
- **Recapture attempted 2026-11-10 ~8:45pm PT (build 0c77438), result: kept the saved trace.** One live run
  (~$0.21) returned 13 pages, 3 origins, 23% echo, and scored worse: 8/10, **1 settled mistake** (a 2026
  ConsumerAffairs stats page judged an *origin*), 1 abstention, and the "We Check Our Phones Every 10 Minutes"
  page was not retrieved. The citation link did **not** fire live: the Narcissus reference page stayed "unclear".
  (Fox 13's parent was asurion.com vs the labeled PR Newswire copy; same co-published release, not a real error.)
  (Superseded: run 2 below proved citation-based direction live and became the demo trace.)
  Rerunning is a coin flip because search returns different pages each time; don't rerun just to try again.
- **Both bugs from that run fixed offline (11/10 ~9pm, `src/lib/echo/pipeline.ts`, tests in
  `scripts/check-pipeline.mjs`):** (1) `findCitations` now also reads the citing page's *title* for
  organization + year (the live Narcissus page had "Asurion, . (2019)" only in its title); (2) `safeJudgment`
  downgrades an "origin" to "unclear" when the page states none of the claim's numbers and has no primary evidence
  (ConsumerAffairs quoted 205, not 96). Lint, all checks and build pass. Proven live in run 2 (below). Lucas now says the hackathon runs to **Sunday** and wants to keep building.
  Copy of tonight's live trace for offline testing: `.echo/phone-recapture-2026-11-10.echo.json` (git-ignored).
- **Live run 2 with the fixes (11/10 ~8:52pm, $0.21; day total $1.65 of $2): both fixes worked live.** Narcissus →
  derived from Asurion 2019 by title citation; ConsumerAffairs → unclear. 13 pages, 2 origins, 31% echo. Against
  the labels (compared by hand): **10/10 labeled pages present correct, 0 wrong, 0 abstentions**, 1 labeled page
  missing (the Instagram post). Saved at `.echo/phone-recapture-2026-11-10-run2.echo.json`.
  **Import blocker fixed (11/10 night, `src/lib/echo/portable.ts`):** the import check required both dates on every
  live "derived" link, but the pipeline deliberately links an undated page to an earlier, reliably dated page it
  cites. The import check now mirrors that pipeline rule exactly. Regression cases in `scripts/check-portable.mjs`.
  Run 2 then became the demo trace (see above). **Citation-based direction is now proven on one live run.**

- **Built 11/10 late night (all offline-tested, lint/checks/build/preflight pass):**
  - `npm run preflight [-- --serve]` (`scripts/preflight-demo.mjs`, baseline in `evaluation/demo-baseline.json`).
  - Demo slots now always open the bundled trace; a browser's saved live run is only a fallback.
  - Copy hunt (`src/lib/echo/copy-hunt.ts`, `src/app/api/copy-hunt/route.ts`, `CopyHuntPanel` in the workbench),
    **off unless `ECHO_COPY_HUNT=1`**. Phone fingerprints: "twice as likely to send a text", "check their phones
    twice as much as the national average", "baby boomers are seven times more likely to text". **First live hunt 11/10 ~9pm PT ($0.024; day total $1.68):**
    29 results, 1 new possible copy: fox13news.com (Tampa Fox, 2021-09-28, page metadata) matching "check their phones
    twice as much as the national average". Weak for the stage as is: it only counts a result when the phrase is in
    Tavily's short snippet. Idea: check each new result's full page with a free direct fetch. `.env.local` set back to
    `ECHO_COPY_HUNT=0`.
  - Brain trace labeled (20 pages): 14/20, 1 settled mistake, 5 abstentions, 0/4 copies found. **The pitch's
    "independent debunks, no copying" line is now contradicted by the labels** (4 pages copy Scientific American or
    the Washington faculty page). Lucas must reword it (e.g. "Echo found no confirmed copying" is still literally
    true of Echo's output, but the labels say it missed some). Told Lucas 11/10.
  - Citation detector fixes from those labels (`findCitations` in `pipeline.ts`): spaced organization names and
    reference-list "(year). title" entries. Offline: catches MNT and Wikipedia → SciAm, no new false citations on
    either demo trace. Not proven live; the saved brain trace is unchanged.

- **Built 11/10 ~9pm PT (offline-tested; lint/checks/build/preflight pass; card checked in the browser):**
  - Copy hunt now also opens each new search result directly (free, up to 30, same safety limits as the date
    fetcher) and counts phrases found in the page itself (`foundIn: "full page"`). **Re-run live 11/10 ~9:20pm PT
    ($0.024; Pacific-day total $1.70):** 30 results, 23 new pages opened, still only 1 possible copy (fox13news.com).
    Conclusion: Tavily does not honor exact-phrase quotes, so it returns similar pages rather than copies. Copy hunt
    stays **off** for the demo; making it work needs an exact-phrase search provider (new key and cost). Don't keep
    spending on it before Sunday.
  - Accuracy card on both demo slots (`AccuracyCard`, data in `src/lib/echo/demo-scores.ts`, regenerate with
    `npm run eval:demo-scores`; preflight checks it is current). Brain slot shows 14/20, 1 wrong call, 0/4 copies.

- **Built 11/10 ~9:40pm PT:** Present mode has a 5th slide, "How we checked" (bundled demo traces only), with the
  accuracy numbers and disagreements; checked at 1280×720. Pitch file reworded (Lucas approved): the brain beat now
  says Echo couldn't prove copying, labels show 4 copies it missed, and points at the Accuracy check card.
- **Next (Lucas approved 11/10): re-capture the brain trace after midnight PT** (fresh $2 day; today has $0.30 left,
  not enough for a safe run). Swap it in only if it beats 14/20, 1 mistake, 5 abstentions, 0/4 copies, then rerun
  `npm run eval:demo-scores` and preflight.

- **Copy hunt fixed 11/10 ~10pm PT (Lucas asked to do it today):** Tavily's `exact_match: true` makes results contain
  the quoted phrase. Two more rules: a phrase also found on a page dated before the original is "common wording" and
  not counted; the original's own site is excluded; filter before the 15-result cap. Live result on the phone trace
  ($0.024; day total $1.75): 15 possible copies, all after 2019-11-21 or undated, e.g. fox5ny.com, iHeart 102.5 The
  Bull, thebeat925.ca, hispanicengineer.com (all 3 phrases); "twice as likely to send a text" set aside as common
  (Pew 2009, CNBC 2015). Still off by default. **Saved into the bundled phone trace (Lucas said yes):** shows offline
  on slot 02 with no button (feature still off); score unchanged 13/13; data otherwise identical.

- **Brain re-capture 11/11 ~6:55pm PT ($0.13; day total $0.13 of $2), kept OUT of the demo:** 20 pages, 5 origins,
  5% echo; only 11 labeled pages retrieved; 5/11 kinds, 0 mistakes, 6 abstentions, 0/4 labeled copies (hub.jhu.edu
  → SciAm found by name and year, but it is unlabeled). Saved at `.echo/brain-recapture-2026-11-11.echo.json`.
  The saved brain demo (14/20) stays.
- **Citation rule added 11/11 from that run: "named as source"** (`findCitations`): a page reliably dated after the
  target that credits its publisher by name after "according to / published by / reported by / in an interview…"
  counts, without a year. Never used to set direction for undated pages (`linkCitedUndatedPages`, `safeJudgment`
  citedParent and the import check all ignore it). Offline on all 4 saved traces it adds exactly MNT → SciAm
  (correct per labels) and nothing on phone traces; no new false citations on the 20 fetched brain pages. Not proven live.

- **Brain demo swapped 11/11 ~7:30pm PT (Lucas said yes):** slot 01 = live run 2 of 11/11 ($0.13; day total $0.27).
  Headline "0 verifiable origins — this stat is a ghost.", 20 pages, 8 roots, 15% echo; MNT, Wikipedia, JHU →
  Scientific American 2008 by citation. Score vs 29 labels: 16/20, 0 mistakes, 4 abstentions, exact parents 3/5
  (old: 14/20, 1 mistake, 0/4). Trade-off: no written answer (answerStatus source-limited: all roots are expert
  quotes without data). Baseline, accuracy card, DEMO_DAY, README and the pitch brain beat are updated. Old trace is
  in git history (`git show 16393bb:public/demo-traces/humans-use-10-percent-of-brain.echo.json`).

- **Lucas 11/11: paid runs allowed without asking, up to the $2/day cap** (memory saved). Brain copy hunt run and
  saved into slot 01 ($0.024; day total $0.29): 15 possible copies via "Let's put it this way the brain represents
  three percent of the", 6 dated after 2008-02-07; other two phrases set aside as common wording.

- **Backup claims tested live 11/11 (~$0.39; day total $0.68):** "Goldfish have a 3-second memory": 15 pages, 3 origins
  (PubMed 1976, BBC/Oxford, Live Science), 7% echo, answer written → bundled as a saved backup
  (`public/demo-traces/goldfish-3-second-memory.echo.json`, offline-cached, sw cache v7; the backup chip opens it).
  "You lose most of your body heat through your head": 18 pages, **12 "origins"**, 0% echo, incl. Reddit and fact-list
  sites: almost certainly wrong (retellings of BBC 2013 / BMJ 2008 judged origins). Not bundled; saved at
  `.echo/headheat-2026-11-11.echo.json`. **Known weakness:** a myth retold in different words looks like many origins.
  Don't run `pretest:claim` for spending: it calls Tavily directly and bypasses the daily cap ledger.

- **11/11 later:** goldfish labeled (15 pages, AI-made). Day-first / "answered on" date fix (`dateFrom`), confirmed live
  on a goldfish re-run ($0.20; day total $0.89): I'm a Scientist dated 2013-03-20. That re-run scored 12/14, 0
  mistakes, 2 abstentions (old 11/15, 4 abstentions) and replaced the goldfish backup trace. Baseline updated.

## Plan agreed with Lucas (2026-11-10, late night; replaces the earlier "freeze Wednesday" plan)

Lucas decided to **keep building through the hackathon**. **Judging/turn-in is Sunday night (Nov 16), confirmed
by Lucas 11/10.** Rules:

1. **No pitch drills.** Lucas said not to drill him or ask about practice; he'll brainstorm the pitch later.
   Build when he asks to build.
2. **Every new feature ships off by default** (flag or opt-in setting) unless it beats the demo score: on the saved
   phone trace + labels (`npm run eval:trace -- score ...`), currently 13/13, 0 mistakes, 0 abstentions, exact
   parents 3/4. "Beats" means a better score with no new settled mistakes, measured offline where possible. Never
   re-capture or hand-edit the demo trace to make a feature look better.
3. **Code freeze Saturday Nov 14, 4:15pm (building stops about 2pm)**: bug fixes only after that. Then run the night-before checklist in
   `DEMO_DAY.md` (production build, preload both slots, offline reload test).
4. Live runs still only when Lucas explicitly asks (they cost money; Telem's prepaid credit is the one to watch).

Still open: Lucas personally opens the copy links (Fox 13, KABC, church blog, Narcissus) so he can say "I checked it
myself"; he confirms the wording of what organizers said about reusing prebuilt code (pitch hard question 8). The pitch file
`~/AI Infrastructure Claude/company/pitch/3min-judges-echo-searchhack.md` was updated 11/10 late night to the run-2
numbers (10 pages on the claim, 4 confirmed copies, 13 pages / 31% on screen).

**Anytime:** old folders in `~/Documents/Codex/2026-11-08/` can be deleted by Lucas (don't delete them yourself).

## How to work with Lucas

- He's 18, non-technical, building startups; plain English, short sentences, click-by-click steps.
- Lead with your actual recommendation and confidence; disagree plainly when he's wrong; hold your view unless he
  brings new facts. He asks to "keep building" often: say honestly when building has stopped paying off.
- Answers in chat, not extra files, unless a file is the deliverable.

- **11/11 night (Lucas: "better guarantee of actually working"; day total $1.45 of $2):**
  - Live-run safety net: a failed live run of 01, 02 or the goldfish backup shows "Open the saved run of this claim";
    a live step with no progress for 40 s (`STALL_MS`) shows a stall note with the same button. Browser-tested.
  - `npm run smoke:ui` (`scripts/smoke-ui.mjs`, devDependency `playwright-core`, uses installed Google Chrome): clicks
    both slots, the backup, all Present slides, the failure fallback, then the whole demo offline via the service
    worker. Starts its own `next start` with API keys blanked, so it cannot spend. Passes.
  - Fresh live re-runs ($0.39): phones 10/10, 0 wrong, 0 unclear; brain 13/19, 0 wrong, 6 unclear. Non-bundled runs
    are committed in `evaluation/runs/<name>.<date>.echo.json`; `eval:demo-scores` scores every run, and the Accuracy
    card and the "How we checked" slide list them. Totals: 8 scored live runs, 124 page calls, 1 wrong call
    (phones run 1, 11/10). The bundled runs are the best of 2-3: the card says so.
  - Spider claim ("You swallow eight spiders a year while sleeping", $0.17, 37 s): answer correct ("a myth"), but
    20 pages → 4 origins with most retellings left unclear: the paraphrase weakness again. Not bundled
    (`.echo/spiders-2026-11-11.echo.json`).

## How to verify before saying "done"

```bash
npm run lint
for c in pipeline graph portable readiness evaluation wording copy-hunt; do npm run -s check:$c; done
npm run build
npm run preflight -- --serve
npm run smoke:ui
```
Stage files by name (never `git add -A` blindly) and read `git show --stat HEAD` after each commit.
