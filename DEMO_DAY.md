# Echo demo-day runbook

Written 2026-11-10 after a stress test of the production build. On-screen wording and figures updated on the evening of
2026-11-13 to match `main` (checked against the source, the smoke-test expectations and the bundled traces): the home
**Check an AI answer's links →** button and the Check these sources flow, the live wait's search plan, the "How Echo
checked this" strip, the tree slide's ORIGIN / SAME RELEASE tags and tree key, and the 11/13 live timings. QA round 5
(11/14): the Telem case (under "Optional live run" and "If something breaks"), the key's place above the tree, the
asurion.com source-detail line as shown, and the offline panel's "5 / 5 saved runs". QA round 6 (11/14): the wait
card's **Stop**, the panel's link chips, the Telem status and cap lines, the "Daily spending cap reached" card, and the
night-before readiness check (5 / 5 on the first online load). Evidence funnel (11/14): the result page's **WHAT ECHO
PROCESSED** funnel under the plain-search box, its **Run details**, the source detail's **Page details**, and a new
Present slide 2 (**How Echo searched**, or **What Echo read** for supplied links), so every later slide moved up one
(the tree is now slide 3, the answer slide 6, "How we checked" slide 7).
Vocabulary (11/13): the independence count is **independent origins** on every screen (no more "candidate roots",
"independent roots" or "verifiable origins"); origins showing data of their own are **with own evidence**; **root pages**
is a page count (pages published together are several root pages but one origin).
Pitch script: `~/AI Infrastructure Claude/company/pitch/3min-judges-echo-searchhack.md`.

## Origin layer (added Sat Nov 14; optional, off by default on the result page)

The slots and every step below are unchanged with it off.

- **Fastest way to show it: open `/origins`** (for example `http://localhost:3000/origins`). One address, no file to
  pick, nothing to switch on, no request sent. Four tabs, all live Telem runs from today (phones 11:02am; body heat,
  brain myth and goldfish about 11:48am). Top to bottom: how Echo fits with Telem (three steps), the Echo Score with
  its meter (each tab also shows its score), a before-and-after block (the flat list search hands an agent, and the
  origins Echo hands it), the flow from search engines to pages to independent origins (point at a page to read Echo's
  saved note on it), what each engine added with the run's search bill and "Engines this claim needed", what each
  search added, how the claim travelled, the token bars (phones tab only: the other three have no saved comparison),
  and at the bottom the **engine scorecard** across the four claims.
- **The engine scorecard, as measured:** across 4 claims Telem billed **85 engine runs (about $0.52 of search)** and
  Echo confirmed **13 independent origins; 6 of them were reached through only one engine** (3 through Perplexity, 3
  through Parallel). Say it as a contrast, with figures that do not depend on the order of the engine list: on the phone claim
  **every one of the five engines reached the one origin (engines needed: 1 of 5)**; on the body-heat claim (**Echo
  Score 86, 7 origins, 7 publishers**) **no single engine reached all seven; it took 3 of the 5, and 4 origins came
  through one engine only**. Brain myth needed 2 of 4; goldfish 1 of 5 (only Parallel reached both). And Echo's own
  searches: on body heat the plain search reached 3 of the 7 origins and Echo's follow-up searches the other 4 (the
  "study OR report OR paper" search is the one that returned both papers).
  "Echo tells a router which case it is in." Four claims, one run each: never rank the engines from it.
- **Scores move with what a run retrieves.** Today's Telem runs score brain myth 10 (3 origins, none with evidence of
  its own) and goldfish 6 (2 origins, none with evidence). The older Tavily-captured goldfish backup scores 72 because
  that run retrieved a PubMed study and a BBC report; today's did not. If a judge asks why the same claim scores
  differently: "the score describes the pages this run found, and that difference is exactly what the engine
  scorecard is for."
- **On a result page:** click an empty part of the page and press **Shift+O**. The same graphic appears under WHAT ECHO
  PROCESSED (Shift+O again hides it; the choice is remembered in this browser, so press it once before recording and
  check the panel is there). To open the Telem run there: on any result, **More → Open trace file** and pick
  `mcp/traces/telem-phones-2026-11-14.echo.json`.
- **The Telem run, as measured (live, 11:02am today, 32 s, about $0.25):** Echo Score 18, "Thin evidence base". 5
  searches through Telem, 23 engine runs billed, about $0.14 of search at list price. Of the 19 pages about the claim:
  **2 origin pages that are one origin** (Asurion's Nov 2019 press release, on asurion.com and PR Newswire), **4
  confirmed copies**, and **13 pages Echo could not tie to any origin**. All five engines (Perplexity, Brave, Exa,
  Parallel, Tavily) returned pages that lead back to that one origin: any one engine would have reached it (engines needed: 1 of
  5). Do not say "18 of 23 engine runs added nothing": that figure depended on list order and is gone from the screen. Same question to Claude with all 19 pages vs the 1 origin: **9,304 vs 971 input
  tokens (−90%)**.
- **One caveat on every engine figure (found 12:24pm, on screen in the fine print):** the trace credits an engine with a
  page for the search that FIRST returned that page; an engine that returned the same page only in a later search is
  not credited. So "every one of the five engines reached the origin" is solid (it is positive evidence), while "no
  single engine reached all seven", "needed 3 of 5" and "6 origins through one engine only" are **what this run
  recorded**. Say "by this run's record" once when you use them, and never "Brave cannot find X".
- **Telem's routing is on screen** in "What each search added": each search row lists the engines Telem sent it to
  and how many of that search's new pages each returned (body heat: the plain claim went to Tavily, Brave and
  Perplexity; the exact-phrase follow-up to four engines; the rest to all five).
- **Say it this way (these are the corrections from today's review; do not improvise past them):**
  - "Six of the nineteen pages lead back to one press release. Thirteen Echo could not place, and it says so." Never
    "all nineteen pages are copies" or "everything leads back to one origin".
  - "Five engines, one origin" is true of the pages Echo could place. The engines returned 174 results in all; 19 is
    what Echo kept as about the claim.
  - The score rates the evidence base behind a claim, not whether the claim is true. On body heat (86): "seven
    independent origins weigh in, two papers and BBC reporting among them. A strong evidence base, and what those
    origins say is that the claim is not supported." Never call the goldfish or head-heat claim "well supported" or
    "well sourced".
  - Token saving: "ninety percent fewer input tokens on this run". The origins-only context drops the 4 copies and the
    13 unplaced pages. Claude's stated confidence was high with every page and medium with the origin only, and both
    answers trace the number to the one Asurion survey. Do not say Echo corrected Claude or that search fooled it: the
    origins-only context tells Claude what Echo found, so it is not a blind test. One measurement.
  - Origin types (press release, primary document…) are read by rule from the page address and passage.
- **MCP moment (optional, checked today in a real Claude Code session):** the tool is added for every folder
  (`claude mcp add --scope user echo -- node ~/Projects/echo/mcp/echo-mcp.mjs`, done once). In a new Claude session
  ask "Do Americans really check their phones 96 times a day? Use echo_check first." It answers from the saved Telem
  run, free. Type the figure as it is in the saved claim; a claim with no saved run, or with a word swapped, is
  refused unless the server was added with `ECHO_MCP_LIVE=1`.
- A fresh live run shows the graphic too (score, flow, engines, wording: all free). Its **Run the comparison** button
  needs `ECHO_ORIGIN_LAYER=1` in `.env.local` and a restart; it costs about 2–3 cents.
- One live phones run at about 10:58am today timed out in the judge step (Claude took over 60 s) after spending $0.18;
  the retry took 32 s. If a live run stalls on stage, use the saved run as already planned.
- **Freeze gate note:** `smoke:ui` failed 4 steps today before any origin-layer code existed (same 4 on commit
  d3b055b). Cause: its live-run pages open in a far-off timezone after 3am Pacific, where the saved check's capture day
  reads Nov 14, and the test insisted on Nov 13. The test now expects the date in the zone it opened the page in.

## Recording the demo video (Sat Nov 14: stop building about 2pm, code freeze 4:15pm)

1. Same steps as "The night before" below, on the branch you will record from (`main`).
2. Browser at 1920×1080 (or your screen's native size), zoom 100%, a clean profile with no extensions or bookmarks bar,
   Do Not Disturb on, other tabs closed. Use **Full screen** for Present.
3. Record a 30-second test take first and watch it back: text readable, cursor visible, audio level fine.
4. Retakes of a live run: the same claim within 15 minutes opens the cached result instantly and for free (it will not
   look like a live run). **Run fresh search** spends about $0.23–0.25 (phones, 11/13, measured with Tavily search; see "Telem" below). A Check these sources retake
   can be a new live run (about $0.04): the browser does not keep those results as saved runs (the bundled **Saved
   check: 5 links → 1 origin** opens the 11/13 run of the example's links for free). Avoid the wait card's **Stop**: it holds about
   about $0.06 of the day's caps (Claude's and Tavily's, or Telem's) until midnight Pacific.
5. Say "possible copies" for copy hunt, "a citation names a source, not proof", and never "better than Google" (not tested).
6. Slots open saved live runs; say so if you show them ("a run saved on Nov 10").

## The night before (10 minutes)

0. Optional but best (about 5 minutes, spends nothing): `npm run check:freeze -- main demo` clones each branch into a
   fresh folder, runs every check, build, smoke and preflight there, confirms the bundled traces match `demo`, and checks
   the stage numbers against this file. It must end with GO for the branch you will present from.

1. Open Terminal in the Echo folder and run, one at a time:
   ```bash
   npm ci
   npm run build
   npm run preflight -- --serve
   npm run smoke:ui
   npm start
   ```
   Use `npm start`, **not** `npm run dev`. Offline mode only exists in the production build.
   `preflight` must end with "Preflight passed". It checks both demo traces import and still score at least as well
   as recorded, and that every file offline mode needs loads from the build. It spends nothing.
   `smoke:ui` opens Chrome by itself and clicks through what judges see: both slots, both backups (goldfish, head heat), every Present
   slide, the "open the saved run" button after a failed live run, the Check these sources flow against a mocked run
   (Try an example, the per-link verdicts, Cite once, Present slide 1), the bundled **Saved check: 5 links → 1 origin**
   (and its offer after a failed run of those links), and the whole demo again with the network off.
   It also checks the plain-search lines and the "SAVED LIVE RUN · captured <date>" tags word for word.
   It must end with "UI smoke test passed". It blanks the API keys, so it spends nothing.
   The slot buttons always open the bundled traces, even if you did a live run of the same claim in this browser.
   Keyboard: with no text box focused, **1** opens slot 01, **2** opens slot 02, **3** puts the cursor in the claim
   box for a fresh live run. They do nothing while you type, during a run, or in Present mode.
2. Open `http://localhost:3000` in the browser you will present from, **online**. The first load installs the current
   offline cache (`echo-shell-v12`, replacing any older one): its service worker stores the app, both real traces, the
   backups and the saved Check these sources run by itself, so nothing needs clicking for that. Within a second or two
   the **OFFLINE DEMO READINESS** panel under the claim box reads "5 / 5 saved runs ready offline" (both slots, both
   backups and the saved check; checked 11/14 on a fresh profile against `npm start`).
3. Verify it: click **01 Ghost stat**, then **02 Zombie stat** (both open), then turn wifi off. Reload the page: the
   notice reads "The saved live runs (slots 01 and 02, the backups and the saved check of five links) still open …".
   Click 01 and 02 again, and **Saved check: 5 links → 1 origin** under MORE SAVED RUNS. All three must open. Turn
   wifi back on. (`smoke:ui` tests this in its own Chrome window; this step checks the browser you will actually
   present from.)
4. If `npm run build` fails with "Duplicate identifier" or a file name ending in " 2" or " 3": iCloud copied build
   files. Delete the `.next` folder and build again. (Moving the project out of iCloud Documents prevents this.)

## On stage (the safe path, no wifi needed)

**Present from `main`** (recommendation from the 11/13 judge's-eye review, about 85%; Lucas decides). On the stage laptop,
load the app once online first, so the new offline cache (echo-shell-v12) replaces any older one. Switching branches on the same
localhost:3000 replaces the other branch's offline cache, so do the online visit and the wifi-off reload on the branch
you will present from, last.

1. Laptop running `npm start`, browser at `localhost:3000`, zoom at 100%.
2. Click **02 Zombie stat**. Headline: "13 pages → 2 independent origins", 31% echo.
   After the click the page scrolls to the verdict, with the plain-search box in view; press **Present**.
   If a judge asks "2 origins or 3?": Asurion's release and PR Newswire's copy of it went out the same day, so they are
   3 root pages counted as 2 independent origins (on screen: "13 pages = 3 root pages (2 independent origins; pages
   published together count once) + 4 confirmed copies + 6 unclear"). Tag: "SAVED LIVE RUN · captured Nov 10, 2026".
   - **Plain search vs Echo** (the box under the verdict, and on Present slide 1):
     "Plain search: 10 results, 5 about this claim. Behind those 5: 1 independent origin; 1 page unclear."
     "Of those 5: 2 root pages published together, counted as 1 origin, 2 confirmed copies of them, 1 unclear (no
     confirmed link). Echo's full trace (13 searches) finds 2 independent origins, both with their own evidence."
     The beat: ten results, five about the claim, and those five are one Asurion release, two copies of it, and one
     unclear page. Slide 1 says the same "1 independent origin", and its tiles read "2 independent origins" and
     "2 with own evidence". Hovering the box says plain search is the trace's first Tavily
     search, the claim as typed.
   - **WHAT ECHO PROCESSED** (the funnel right under the plain-search box): how much the run went through, every number
     counted from the trace. Slot 02: "10 query variants → 13 searches (3 deeper) → 124 search results scanned → 15
     distinct pages → 15 pages read (9 with a reliable publisher date) → 4 claim groups (2 off-claim set aside) → 13
     pages about the claim → 2 independent origins (both with their own evidence)". Slot 01: "10 query variants → 5
     searches (5 variants not needed) → 50 search results scanned → 20 distinct pages → 20 pages read → 1 claim group →
     20 pages about the claim → 8 independent origins (none with its own evidence)". The numbers count up the first time
     the funnel comes into view. Hover a stage for exactly what it counts. Say "search results", never "sources": 124 is
     every result of 13 searches, counted search by search (a page two searches returned counts twice), and 15 is the
     distinct pages among them. Under it: "4 citations found between pages", "16,286 characters of page passages saved"
     (the part of each page about the claim) and **RUN DETAILS** (closed; one click lists the router, searches, results,
     pages, text, dates, citations, Claude calls and tokens when recorded, stage times and the cost receipt). The saved
     slots predate the cost receipt, so they show no Claude calls or tokens ("not recorded"); a fresh run and the saved
     check do. Clicking a page in the tree shows its **Page details** in the source detail: its site, publisher date and
     where it came from, characters of passage saved, which search first found it (and, with Telem, which engines), its
     citations within the trace, its wording overlap with its parent, Claude's confidence and its own-evidence status.
3. Click **Present**, then press → to move through the slides (7 on the demo slots). **Esc** exits. **Full screen** is top right.
   **Use Full screen on stage.** In a window with the browser bar showing (about 1280×600 usable on a 720p projector)
   every slide still fits, but the slide 3 tree shows only its first two rows (Asurion → Fox 13 → church blog, PR Newswire
   → KABC); Full screen gives the tree more room.
   All four saved runs (both slots and both backups) fit at 1280×720, 1366×768, 1920×1080, 1280×600 and windowed laptop
   heights (657-719 px); between 661 and 719 px slide 1 hides its one-line explainer, and below 821 px slide 3 hides its
   search hint. The slide 3 tree takes whatever height the slide leaves: 3 whole rows of pages at 1280×720, 4 at 1366×768,
   6 at 1920×1080.
   - Slide 2: **How Echo searched**, the same funnel large, headed "From 124 search results to 2 independent origins"
     (slot 01: "From 50 search results to 8 independent origins"). Say: "13 searches, 124 search results, 15 distinct
     pages read, and they come down to 2 independent origins." Hovering a stage shows what it counts in the line under it.
   - Slide 3 (tree): Asurion 2019 release (asurion.com + PR Newswire, one origin) → Fox 13 → church blog; Asurion → KABC;
     Asurion → a reference page that is undated but cites "Asurion (2019)" (linked by citation).
     Tags: asurion.com (2019) reads **ORIGIN**, PR Newswire reads **SAME RELEASE** (hover: "Published together with
     asurion.com: counted as one independent origin"), and a thin bracket on the left joins the two; Asurion's 2022
     survey page is the second **ORIGIN**. So the slide shows 2 ORIGIN tags for 2 independent origins. Pages with no
     confirmed link are tagged **UNCLEAR** (it read "UNRESOLVED" before 11/14), matching the key. Above the tree, at
     the top right, one key: "Root page · Likely echo · Unclear relationship" and "75% on a link = Claude's confidence
     in it (its own estimate, not measured)". Say it that way: the percent is Claude's own estimate, not an accuracy figure.
     At 1280×720 Full screen the first three rows are fully visible without scrolling: Asurion → Fox 13 → church blog,
     PR Newswire → KABC, and the reference page. In a 1280×600 window, scroll inside the tree to reach the reference page.
     The strip under the tree has a closed **PAGE DETAILS** at its right; a click opens the selected page's details over
     the tree (the slide does not grow), another click closes them.
   - Slide 4: **How it spread** — press **Play the spread** to sweep the years (dated pages only).
   - Slide 6: the answer. It cites Asurion's own 2022 survey (352 times a day, calling 96 its 2019 pre-pandemic figure) and ends:
     "The 96 figure comes from one company's survey and is not a universal or current measure of how often Americans check their phones."
   - Outside Present mode, slot 02 also shows the **COPY HUNT · BETA** panel, collapsed, its one-line summary in view:
     "15 possible copies outside this trace · 8 dated after the original" (the other 7 are undated). One click on it opens
     the list (its first possible copies can be unrelated pages, so it stays shut unless you want it). Say "possible
     copies": Echo matched exact wording but has not read them in full.
   - Slide 7 (optional): "How we checked": "13 of 13 pages match AI-made labels", 0 wrong calls, and a line that this claim
     was run live 6 times (3 on an earlier build) and the best run is shown, with the total wrong calls across all 6. Its one
     difference from the labels sits under "SAME CALL, DIFFERENT PARENT" (both say derived; the parent differs).
     Brain's slide 7: "16 of 20 pages match AI-made labels"; its across-all-runs line includes the 11/13 brain run,
     which had 4 wrong calls.
   - Outside Present mode, under the echo-spread timeline, the **HOW ECHO CHECKED THIS** strip shows what the run did,
     counted from the trace (no model call). Slot 02: "Plan: 10 query variants · Search: 13 searches run (3 deeper) ·
     Read: 15 pages read · Group: 4 claim groups · Judge: 2 independent origins · Verify: 8 of 8 answer figures · Answer:
     Written from 2 independent origins". Slot 01 ends "Judge: 8 independent origins · Answer: No answer written". The
     saved slots carry no stage times (their traces predate the cost receipt); a fresh live run shows them. The strip is
     not on a Present slide (slide 2 shows the funnel instead). "Verify" means the answer's figures appear in the passages
     it cites, not that the claim is true.
4. For the honesty beat: Esc, click **01 Ghost stat** (headline "No origin with its own evidence — this stat is a ghost.", 20 pages, 8 root pages, 8 independent origins, 15% echo). Medical News
   Today, Wikipedia and Johns Hopkins trace to Scientific American 2008 (on slide 3 Wikipedia is in view at 1280×720 Full screen; in a 1280×600 window scroll the tree to reach it). Its answer card says Echo cannot verify the
   claim from its origins (all expert quotes, no data): that is expected. Tag: "SAVED LIVE RUN · captured Nov 11, 2026".
   The tiles "8 independent origins" next to "0 with own evidence" are intended: independent is not the same as
   having evidence of its own (none shows data of its own). Narrate it: the origins here are debunkers (MIT McGovern, Scientific American, BBC), so "cannot verify the claim" is the
   point, not a failure; Echo's copy hunt treats Scientific American 2008 as the original wording, not as the myth's source.
   Plain search vs Echo on this slot: "Plain search: 10 results, all about this claim. Behind them: 4 independent origins,
   none with its own evidence for it; 4 pages unclear." (Most of the ten debunk the myth; "about this claim" never means "agrees".)
   If a judge asks "is this better than Google?": we haven't compared Echo with Google. The plain search on screen is the
   first Tavily search for the claim as typed, the same one Echo starts from, so it shows what Echo adds on top of search
   results (five results can be one source), not that Echo finds better pages.
   Its Copy hunt panel lists 15 more pages quoting the neurologist's line "the brain represents three percent of the
   [body's weight]" from the 2008 interview (6 dated after it). Say "possible copies".

The tags "SAVED LIVE RUN · captured Nov 11, 2026" (slot 01) and "SAVED LIVE RUN · captured Nov 10, 2026" (slot 02) are expected
and honest: these are real live runs saved with the app, not rerun on stage, and both predate the Nov 12 fixes (slide 7 counts the earlier-build runs; the Accuracy check card marks runs made before
the fixes "earlier Echo").
Dates follow the laptop's time zone (these are Pacific).

## Check these sources (live, needs wifi, about $0.04)

The second way in: check the links an AI answer cites instead of searching. Measured on 11/13 (one run each, list-price
estimates): 14–16 s, about $0.04, "5 supplied links → 1 independent origin".

1. On the home screen, the bordered **Check an AI answer's links →** button sits at the right of the claim box's label
   row. It opens the **Check these sources** panel with the cursor in its paste box and runs nothing.
2. Click **Try an example (a sample answer)** (shown while the paste box is empty). It fills a sample answer that says it
   is one and imitates no AI product, citing the five phones links, and the sentence "Americans check their phones 96
   times a day". The links show as numbered chips with the answer's own citation numbers, each the site and the start
   of its path: "[1] asurion.com/press-releases/americans-check-t…", "[2] prnewswire.com/news-releases/americans-check-th…",
   "[3] fox13seattle.com/news/americans-check-their-smart…", "[4] kabc.com/2021/10/03/reality-check-you-che…",
   "[5] churchandculture.org/blog/2021/10/28/96-times-a-day". Nothing is spent yet.
3. Press **Check 5 sources** (this is the live run). The wait card reads "Checking 5 supplied links for: “…”" with
   **SUPPLIED · 5 SITES** chips and no search plan (no web search runs).
4. The result: headline "5 supplied links → 1 independent origin", tiles "5 links read · 1 independent origin · 1 with
   own evidence", no echo rate. Then each link's verdict, as on the saved v2 run of these links:
   ```
   [1] asurion.com — independent origin, with its own evidence
   [2] prnewswire.com — published together with [1], one origin
   [3] fox13seattle.com — copy of [2]
   [4] kabc.com — possible copy of [1], link not confirmed
   [5] churchandculture.org — copy of [3]
   Your answer's 5 citations trace back to 1 independent origin, with its own evidence.
   Cite once: [1] asurion.com (also published as [2]). Repeats it: [3], [5]. Unclear: [4].
   ```
   Live judgments vary: in the earlier 11/13 run PR Newswire read "unclear (same text, no earlier date)" and the line
   read "Cite once: [1] asurion.com. Unclear: [2], [4]. Repeats [2]: [3], [5]." The headline was the same.
   **Copy** copies the Cite once line; **Show as data** shows "The same result as data, for tools that use citations"
   (a small JSON). Its "How Echo checked this" strip reads "Plan · Search: Skipped — read 5 supplied links; no web search".
5. **Present**: slide 1 is headed "CHECK THESE SOURCES · SUPPLIED LINKS, NO WEB SEARCH", then the headline, every link
   with its verdict, the plain line, and the Cite once line under it (6 slides in all). It fits without scrolling at
   1280×720, 1366×768, 1920×1080 and 1280×600 (a 20-link list too; at 1280×600 it shows 13 links and "+7 more supplied
   links"). Slide 2, **What Echo read**, is the funnel for these links, headed "From 5 supplied links to 1 independent
   origin": "5 supplied links (no web search) → 5 links read (5 with a reliable publisher date) → 1 claim group → 5 pages
   about the claim → 3 Claude calls (11,503 tokens) → 1 independent origin (with its own evidence)", the same funnel as
   under the result's headline card (its Run details add the 14 s stage times and the ≈$0.04 receipt). On slide 3 and the result page tree each card shows its supplied number on its top line, beside the date
   ("[2] Nov 21, 2019" over "prnewswire.com"), the same numbers as the list (a search result's cards have none), and
   the whole site name fits. asurion.com is tagged ORIGIN and prnewswire.com SAME RELEASE in any pasting order: the
   list, Cite once, the tree and Present all lead with the page that has its own evidence (asurion.com, which the
   answer cites). On the result page, click asurion.com: its source detail's **DOWNSTREAM SPREAD IN THIS TREE** reads
   "2 likely downstream echoes · 1 directly linked (including prnewswire.com's, published together)", since Fox 13 and
   the church blog hang off PR Newswire, its same release (its root ledger row: "2 likely downstream echoes
   (including prnewswire.com's, published together)"). On slot 02 Asurion still reads 4 (its own links reach all 4).
6. Say: "a citation identifies a supplied source, not proof of the claim", and the origins are counted among these links
   only, not across the web.
7. **The saved run, no wifi needed:** **Saved check: 5 links → 1 origin** sits beside Try an example in the panel (always
   shown) and under **MORE SAVED RUNS** on the home screen. One click opens the bundled live run of these five links
   (from the panel, the panel closes and the focus moves to the result's headline)
   (the v2 run above), tagged "SAVED LIVE RUN · captured Nov 13, 2026"; it runs nothing and spends nothing, works offline
   (the offline cache holds it), and its Copy link is `/?trace=check-these-sources-phones`. Say it is a saved run of
   these links from Nov 13.
8. If a live run fails (wifi, cap) or stalls for 40 s, and its links are the example's five (any order or numbering)
   with the same sentence, the error card offers **Open the saved run of these links** (the stall note: **Open the saved
   run instead**). Click it. Other links get no such button; use **Saved check: 5 links → 1 origin** only if you are
   showing the example.

## Optional live run (only with good wifi and spare time)

- Needs the API keys in `.env.local` and internet. Phones full trace on `main` 11/13 (one run each, list-price
  estimates): 32–44 s, about $0.23–0.25, 16–17 pages → 2 independent origins. Brain: 46 s, about $0.25 (earlier 11/13).
  **Through Telem on 11/14 (main @ de1c311):** UI Standard at 1920×1080: 29 s, ≈$0.27, 5 searches (5 not needed), 173
  results scanned, 75 distinct pages, 20 read → **1 independent origin**. That origin is Asurion's 2019 release with its
  same-day PR Newswire copy; no console errors. CLI Standard: 33 s, $0.24 (Telem $0.12), the same single origin. Asurion
  2022 was not retrieved in any 11/14 run, so a live run now shows 1 origin where saved slot 02 shows 2.
  A fresh run on `main` shows its own receipt under the run time (list-price estimates from counted tokens and credits,
  not an invoice), and its "How Echo checked this" strip shows each step's time.
- While it runs, the loading card names the claim ("Tracing: “…”"), shows the **SEARCH PLAN · 10 VARIANTS** list (the
  claim's search variants, each ticked ✓ as its search finishes; variants it never needed get a dash) and the
  **FOUND SO FAR · N SITES** chips (domains only, e.g. "fox13seattle.com, kabc.com, prnewswire.com…"), then says how
  many pages it is grouping. Tavily finishes the searches in about 4 s, so the ticks fill fast; the long part is the
  judge step (about 30 s) after them. Narrate over it ("now Claude is judging who copied whom"); it is not stuck. At
  1366×768 and 1280×720 the page scrolls only until the card's bottom shows, so the claim box stays in view above it; as
  the card grows the page follows it, unless you scroll yourself (then it stays where you put it).
- **Telem.** With a `TELEM_API_KEY` in `.env.local`, every live search goes through Telem (Tavily still reads the
  pages); the claim box line reads "Provider keys configured · Search: Telem · Slot 03 always fresh" (without one, "Search:
  Tavily"), and the cap line under it "Telem today $0.00 / $3.00 · total $0.00 of $20 credit · Claude $0.00 / $50.00 ·
  Tavily $0.00 / $5.00 · local ledger · resets midnight Pacific" (with Tavily search, "Claude today $0.00 / $50.00 ·
  Tavily $0.00 / $5.00 · …"). The
  timings and costs on this page were measured with Tavily search; a Telem run reserves about $0.031 per search
  ($0.040 deeper) and settles at what the providers that answered cost. The live wait tags each searched variant
  with its providers ("Exa · Tavily · Brave", three at most then "+N"). If the line instead warns "Search is set to
  Telem, but its key is missing or is not a Telem key" (its cap line then reads "Echo API today (Claude + search): …"), fix
  the key or set `ECHO_SEARCH_ROUTER=tavily` in `.env.local` and restart `npm start`.
- **Deep search** (the claim box's **Standard | Deep** toggle; Standard is the default and goes back to it after each
  Deep run): up to 16 searches of 20 results, up to 50 pages read, judged in batches. The wait card and the result tag
  say DEEP SEARCH. Measured 11/14 (CLI, Telem): 61 s, $0.60 (Telem $0.30), 9 searches, 539 results scanned, 48 pages
  about the claim → 1 independent origin (the same Asurion 2019 pair). Don't use it on stage unless it has been tried
  that day; Standard is the measured run.
- Echo caps each provider per day (since 11/13): Claude $50 (a runaway ceiling), Tavily $5, Telem $3, plus Telem's
  running total against its $20 prepaid credit on the cap line. Telem's credit is the money to watch: don't spend it on
  practice runs that morning. If Telem's day cap is reached, a run searches with Tavily instead and the wait card says
  "Telem's daily cap reached, this run searched with Tavily".
- Results vary between runs, because the live web and Claude's judgments do. Phones gave 3, 2, 2 and 2 origins over 4 runs
  (echo 27%, 23%, 31%, and 31% on 11/13), and 2 origins from 16–17 pages in the later 11/13 runs. Brain gave 5, 8, 6 and 14 origins, and the 11/13 run lost the ghost headline
  ("20 pages → 14 independent origins"). **If you run live on stage, use the phones claim, not brain.** If a live run looks
  worse, go back to the saved trace.
- If anything fails (wifi, rate limit, budget), the app shows a plain message with an **Open the saved run of this claim**
  button when the claim is 01, 02 or a backup (goldfish, head heat). Say "that's why we keep saved traces" and click it.
- If a step shows no progress for 40 seconds, a "This step is taking longer than usual" note appears with an
  **Open the saved run instead** button (same claims as above).
- If a judge asks "did you pick the best run?": yes, and the Accuracy check card lists every live run of the claim.
  The 11/13 brain run (the only brain run after the Nov 12 fixes) added 4 wrong calls: explainer pages called origins,
  and Wikipedia's citation of Scientific American missed because the two landed in different claim groups (Echo never
  links across groups, by design). `npm run eval:all` prints every scored run (19 across 7 claims on 11/13); runs marked
  "earlier Echo" on a card were made before the Nov 12 fixes, including both slots' saved runs.
- Backups: **3-second goldfish memory** and **Head heat loss** both open saved live runs. Head heat's card shows two
  older runs with many wrong calls marked "earlier Echo"; the shown run (after the fixes) has 2.
- If a judge types their own claim: nine unseen claims ran live on 11/12 in 30–51 s with no crashes. Expect more
  pages left unclear and, for myths, an answer saying no source shows data of its own. That is the honest result.
- If the budget line says "cap reached", live runs are paused until midnight Pacific; every saved run still opens.

## If something breaks

| Problem | Fix |
|---|---|
| Page shows code-like text instead of the app | Hard reload (Cmd+Shift+R). Fixed in this build; if it still happens, the browser has an old cache: clear site data for localhost and reload once online. |
| Slot opens a gray "sample" graph | The real trace file didn't load. Use **More → Open trace file** (or **Open a saved trace file** on the start screen) and pick `public/demo-traces/americans-check-phones-96-times.echo.json`. |
| `npm start` says port 3000 is in use | Run `npm start -- -p 3001` and open `localhost:3001` (then repeat step 2 above for that address). If you use the right-click extension, set its **Options** address to `http://localhost:3001` (default is 3000). |
| Live run says "Daily spending cap reached" | Body names the cap it hit: "Echo’s $5.00 daily Tavily cap (searches and page reading) is reached for today. It resets at midnight Pacific time." (with Telem searching: "daily Tavily cap (page reading)"; Claude's: "Echo’s $50.00 daily Claude cap …"; near the cap: "… is reached, or too close for this request. About $0.12 remains …"). Telem's own cap never stops a run (it searches with Tavily instead). Use the saved trace (the card offers **Open the saved run of this claim** for the slots and backups). |
| Live run says "Telem's search credit ran out" | Telem's prepaid credit is spent. Set `ECHO_SEARCH_ROUTER=tavily` in `.env.local`, stop and restart `npm start`, and run again (search goes through Tavily). Or use the saved traces. |
| Live run says "Telem rejected the key" | The Telem key is wrong or revoked. Set `ECHO_SEARCH_ROUTER=tavily` in `.env.local`, stop and restart `npm start`. Or use the saved traces. |
| Live run says "Claude account limit reached" | The Anthropic account's own monthly spend limit (Anthropic Console → Limits), not Echo's daily Claude cap. Raise it there, or use the saved traces. Hit on 11/13 at noon. |
| Projector cuts off the right side | Press Cmd+minus once. The layout was checked at 1280×720, 1366×768 and 1920×1080. |

## Checked on 2026-11-10 (production build; history)

- Offline reload after normal use, both slots offline, Present mode offline at 1280×720, offline live-run message.
- No console errors on a normal load. No sideways overflow at 1366×768 or 1920×1080.
- Lint, the six offline checks that existed then, and the production build passed.

Today the verify list is longer: lint, the 10 offline `check:*` scripts (pipeline, graph, portable, readiness,
evaluation, wording, copy-hunt, claims, copy, links), build, `smoke:ui`, `preflight -- --serve`, `measure:cost` and
`eval:all -- --replay`; `check:freeze` (the 11th `check:*` script) runs all of it but `eval:all` in a fresh clone.

## Optional extras on `main` (not on the frozen `demo` branch)

- Paste an article's link into the claim box and press **Find claims in this page**: Echo reads it and offers the
  sentences worth tracing. Needs the network; nothing is spent until you trace one.
- `/explore` shows all four saved runs as cards, plus the saved check ("5 supplied links → 1 independent origin", no echo rate); `/anywhere` has the "Trace with Echo" bookmark.
- Right-click extension (`extension/`, load unpacked in Chrome, Edge or Brave): select text, choose **Trace with Echo**,
  and Echo opens with the claim filled in; nothing runs or is spent until you press the button. Only say it on stage if
  it is loaded and rehearsed in the presenting browser.
- Optional: the selection pop-up and side panel (same extension, v0.2). Select a sentence on any page, click the small
  **echo. Trace** button next to it (or press Alt+Shift+E), and Echo runs it in Chrome's side panel. That click starts
  a real live run and spends like one (about $0.25 a full trace, $0.04 for Check links; see below), so use it only if it is loaded and
  rehearsed in the presenting browser, with `ECHO_EXTENSION_ORIGINS=chrome-extension://binkgignaekgeoklkoplgpddepbefabb`
  in `.env.local` and Echo restarted. Without that line the side panel says "Echo did not open here"; the right-click
  menu still works. On a deployed Echo with a presenter key, Save the address in the extension's Options and allow the
  site when the browser asks, or the panel's run is refused as a visitor's.

## If you deploy Echo publicly

Set `ECHO_PRESENTER_KEY` (any long random string) in the host's environment. Then visitors, including anyone who
opens a shared link, can open the demo slots and saved traces, but cannot start live runs or copy hunts, so they
cannot spend the daily caps (or Telem's credit) before your demo. On your presenting browser, open `/api/presenter?key=<your key>`
once (it sets a 30-day cookie and returns to the app). `/api/presenter?logout=1` removes it. Unset = no lock.
