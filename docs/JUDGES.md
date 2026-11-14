# Echo for judges

Echo finds the source that is not in the results. Search engines count sources. Echo counts origins, and it reads
what the pages keep naming when no page comes from it. This page maps the four judging criteria to what is in the
repo. The repo is public: <https://github.com/lucasmasen/echo>. The app is not deployed.

Echo's app and original demo flows predate Nov 14. This document covers the Nov 14 Telem cohort; earlier dated captures and the original runbook remain in the repository. See [DEMO_DAY_ARCHIVE.md](DEMO_DAY_ARCHIVE.md) for the prior runbook.

Cohort figures below come from the sixteen runs traced live through Telem on Nov 14, saved in `mcp/traces/`. They are
recomputed offline from those files by `originFlow` and `engineScorecard` in `src/lib/echo/origin-flow.ts` and
`originLayer` in `src/lib/echo/origin-layer.ts`. The Echo Score rates the evidence base one run found, not whether the
claim is true. To see it running with no API key, follow the tour at the top of the
[README](../README.md).

![How Echo works](architecture.svg)

**Three things to look at on `/origins`, in this order.**

1. **The source that is not in the results.** On the brain tab all 3 origin publishers name William James, and no
   page of the run is from him. The dark card above the tabs has five more names (section 3).
2. **Where Echo was wrong.** The last tab: a score of 98 from 8 origins that were mostly write-ups of one MIT report.
   Echo flags the shared name, sends one more search through Telem, finds a copy of the report and folds 6 of the 8.
   98 goes to 67, which is still too high (sections 1 and 3).
3. **What a search router could take back.** For the phone claim any one engine was enough. For body heat it took
   three, by each run's record (section 1).

## 1. Use of Telem (40%)

**Echo goes looking through Telem.** On six of the sixteen claims the pages name a source that no page of the run
comes from (section 3). When at least half of a run's origin publishers share such a name, Echo can send one more
search through Telem for that document. On the run Echo got wrong, "95% of generative AI pilots fail" (score 98 from 8
origins), that search found a copy of the MIT report. 6 of the 8 origins fold into it and the score goes from 98 to
67. That is still too high, and the page says so.

**The router signal.** For each claim Echo works out how many engines it needed, by the run's record, and which
engines answered each search. That is a record a search router could take back. For the phone claim any one engine
was enough: every one of the five reached the one origin. For body heat it took three. For the 93% nonverbal claim it
took all five. By each run's record, 5 of the sixteen claims needed one engine, 3 needed two, 7 needed three and 1
needed five. So Echo can tell a router which case a claim was in. It is hindsight on one run, not a forecast.

**Ranking.** Echo re-ranks results by independence, not relevance: origins first, confirmed copies folded under them,
pages it could not place set aside.

**What Telem does in Echo.** Telem routed every search of the sixteen runs. Each search is one call with auto-routing
on, and Telem chooses among Perplexity, Brave, Exa, Parallel and Tavily. Page reading stays on Tavily.

- The Telem client: `src/lib/echo/telem.ts`. The request is sent from `src/lib/echo/pipeline.ts`, through a daily
  spending cap (`src/lib/echo/daily-budget.ts`).
- What Echo keeps from Telem's reply: which engine returned each page and which engines answered each search. Echo
  then prices each engine run itself, at list price. The dollar figures here are Echo's own pricing, not a figure
  from Telem's reply. All of it is saved inside each run file in `mcp/traces/`.

**What Echo adds on top** (`src/lib/echo/origin-flow.ts`):

- Origins per engine: the origins each engine's pages lead back to.
- Engines needed: the fewest engines whose pages together reach every origin of a run, found by trying every set.
- What each search added: the engines that answered it and the pages it was first to return. Echo sends the claim as
  asked and its other searches together.
- One more search when a run needs it: when at least half of a run's origin publishers mention one outside document,
  Echo searches for that document through Telem (`npm run origin:upstream`, saved in `src/app/origin-upstream-saved.json`).

**The figures.** 16 claims, 80 searches, 320 engine runs billed, about $1.99 of search at list price (Echo's own
pricing), 285 pages kept, 67 independent origins counted, 32 of them with evidence of their own, 31 with only one
engine on record.

**Two runs side by side.** On the phone claim every one of the five engines returned a page that leads back to the
one origin, so any one engine would have reached it (engines needed: 1 of 5). On the body-heat claim, by this run's
record, no single engine reached all 7 origins. It took 3 of the 5, and 4 origins have only one engine on record.

**Where to see it.** `/origins` has eighteen tabs: the sixteen claims, "Check a list of links" and "Where Echo was
wrong". Above them is the dark card "The source that is not in the results". Then "What each engine added" and "What
each search added" on each tab, "The record a search router could take back" at the foot of each Telem tab (JSON, sent
nowhere), and the engine scorecard under the tabs
(`src/app/origins/page.tsx`, `src/app/origin-graphic.tsx`, `src/app/origins/origin-showcase.tsx`).

**Read the engine figures this way.** An engine is credited with a page only for the search that first returned it.
One Telem run per claim. These figures describe sixteen runs. They do not rank the engines.

Echo's tracing works on any search. The per-engine view exists only because Telem records which engine returned each
page.

## 2. Venture potential (20%)

This part is a guess. Nobody has been asked whether they would pay for it.

- **Who needs it (first guess).** Teams shipping AI answers with citations. Their product shows five citations that can
  really be one source.
- **The problem (a guess).** They cannot tell today.
- **Pricing (a guess).** Per check, like the search APIs it sits on.
- **The edge (a guess).** The check needs per-engine provenance, which a router like Telem records.
- Nobody has been asked yet. That is next week. There is no market size here, because none has been measured.

What is in the repo today:

- The kinds of work this check might fit are on `/origins`, each shown with a real saved run
  (`src/app/origins/use-cases.tsx`). The page says the same thing in its own words: nobody has been asked.
- The form it would most likely take is a check an agent calls before it repeats a claim. That check can be called
  three ways today, and there is a tool definition (see section 4).
- The slides are at `/pitch` (`src/app/pitch/page.tsx`). Every number on them is computed from the saved runs.
- A measured comparison of input tokens, with every page Echo kept against one page per origin, is saved for each
  claim in `src/app/origin-layer-saved.json`. Across the sixteen runs the origins-only prompt took 51% to 90% fewer
  input tokens, by the model's own counts. One measurement per run, and the origins-only prompt also tells the model
  what Echo found, so it is not a blind test. It is shown on each tab. It is not the business case.

The next step is to ask teams who ship AI answers with citations. That has not been done.

## 3. Innovation (20%)

- **The source that is not in the results.** A tool that removes duplicates or checks facts can only look at the pages
  it was handed. Echo also reads what those pages keep pointing at. On six of the sixteen claims the pages name a source that no page of the run comes from:
  William James on the brain claim (named on 6 of the 20 sites Echo kept, and by 3 of the 3 origin publishers), Maxwell
  Maltz on the 21-day habit (11 of 19 sites, 3 of 4 origin publishers), the Food and Nutrition Board on 8 glasses of
  water (6 of 20 sites), Malcolm Gladwell on 10,000 hours (16 of 20 sites, 4 of 5 origin publishers), Albert Mehrabian
  on the 93% nonverbal claim (9 of 20 sites) and Robin Dunbar on 150 friendships (7 of 19 sites). It is found by matching names across the
  saved passages, by rule, with no model call (`pageNames` in `src/lib/echo/upstream.ts`). On `/origins` it is the
  dark card above the tabs (`src/app/origins/upstream-map.tsx`). It is a lead to go and look, not a finding: a name
  many pages share can be a person or a body the claim is about.
- **Many pages, few independent origins.** `src/lib/echo/origin-layer.ts` turns a finished trace into an Echo Score
  (0 to 100), a count of independent origins, and a type for each origin, all by rule. On the phone claim Echo kept 19
  pages: 6 lead back to one press release, 13 it could not place, and the score is 18. The score rates the evidence
  base a run found. It does not rate whether the claim is true.
- **A name the origins share.** The same file flags a run when at least half of its origin publishers (and at least
  two) mention one name and no page of the run is that source. Then the origin count may be too high. It flags three of
  the sixteen runs: the brain claim (William James, 3 of 3 publishers among the origins), the habit claim (Maxwell
  Maltz, 3 of 4) and the hours claim (Malcolm Gladwell, 4 of 5).
- **Engines needed.** A number a search router could take back: how many engines a claim needed, by that run's record
  (`originFlow(...).needed` in `src/lib/echo/origin-flow.ts`).
- **Echo went looking.** For a flagged run, one more search through Telem for that document, then one model call that
  decides which origins rest on it (`src/lib/echo/upstream-fold.ts`). On the brain and habit runs it found no page
  that is the document and folded nothing. No look-up is saved for the hours run.
- **Showing the miss.** One more run from Nov 14, "95% of generative AI pilots fail", scored 98 with 8 origins counted
  from 19 pages. Most of them are separate write-ups of one MIT report that was not among the pages Echo kept. The run
  is in `evaluation/known-limits/telem-genai-pilots-2026-11-14.echo.json`, out of every figure here, and it is the
  last tab on `/origins`, marked "Where Echo was wrong". The shared-name rule flags it (MIT, 6 of 7 publishers). Echo
  then went looking: one more Telem search found a copy of the report, hosted at mlq.ai and not on MIT's own site. 6
  of the 8 origins fold into it, origins go from 8 to 3, and the score from 98 to 67. That is still too high: two of
  the three origins left are pages that mention neither the report nor the 95% figure. One measurement, and a model
  decided which origins fold.
- **One dated cohort.** The `/origins` table contains the sixteen Nov 14 Telem captures only. Earlier Nov 10–13 demo captures remain in `public/demo-traces/` with their original dates; they are not part of the cohort figures.

## 4. Technical execution (20%)

- **Three ways to call one check, plus a tool definition.** The three answer from the same matching rule
  (`src/lib/echo/saved-check.ts`): the MCP tool `echo_check` (`mcp/echo-mcp.mjs`), plain HTTP
  (`src/app/api/echo-check/route.ts`) and the command line (`mcp/echo-cli.mjs`). The tool definition is a JSON-Schema
  file for function-calling frameworks (`mcp/echo-check.tool.json`). A claim with no saved run is refused, not
  guessed.
- **Local setup.** The repo is public and this app runs on your machine. The three ways to call it answer from
  saved runs, offline.
- **Pure libraries.** `origin-layer.ts`, `origin-flow.ts`, `upstream.ts`, `upstream-fold.ts`, `origin-stability.ts`,
  `origin-batch.ts` and `saved-check.ts` in `src/lib/echo/` take a saved run and return data. They hold no network
  code.
- **Historical label checks.** `evaluation/` and `src/lib/echo/demo-scores.ts` preserve checks on older saved runs. A model wrote the labels, not a person, so these measure agreement with AI-made labels. The Nov 14 Telem cohort has no label sheet and makes no accuracy claim.
- **Offline checks**, each free to run: `npm run check:origin-layer`, `npm run check:origin-flow`,
  `npm run check:upstream`, `npm run check:origin-upstream`, `npm run check:origin-stability`,
  `npm run check:origin-batch`, `npm run check:echo-api`, `npm run check:copy` (no typed figures in the app's copy:
  numbers on screen are computed from the runs) and `npm run check:links` (no link can reach a route that spends).
- **Runs with no key.** `/origins` and `/pitch` read saved files when the page is built. Opening them sends no search
  and no model call.
- **Stack.** Next.js, React and TypeScript. Current showcase notes: [DEMO_DAY.md](../DEMO_DAY.md).

## The sixteen runs

| Claim (one run each, Nov 14) | Echo Score | Pages kept | Origins | Engines needed |
| --- | ---: | ---: | ---: | --- |
| Americans check their phones 96 times a day | 18 | 19 | 1 | 1 of 5 |
| You lose most of your body heat through your head | 86 | 18 | 7 | 3 of 5 |
| Humans use only 10% of their brains | 10 | 20 | 3 | 2 of 4 |
| Goldfish have a 3-second memory | 6 | 18 | 2 | 1 of 5 |
| 90% of startups fail | 52 | 19 | 4 | 3 of 5 |
| It costs 5 times more to acquire a new customer than to keep an existing one | 50 | 18 | 2 | 1 of 5 |
| It takes 21 days to form a habit | 72 | 19 | 4 | 2 of 5 |
| The average human attention span is 8 seconds | 81 | 14 | 5 | 3 of 5 |
| Only 1% of venture-backed startups become unicorns | 50 | 12 | 3 | 3 of 4 |
| A ChatGPT query uses 10 times more electricity than a Google search | 90 | 17 | 4 | 3 of 5 |
| The average person spends 2.5 hours a day on social media | 55 | 12 | 4 | 2 of 5 |
| You need to drink 8 glasses of water a day | 49 | 20 | 5 | 1 of 5 |
| It takes 10,000 hours to master a skill | 81 | 20 | 5 | 3 of 5 |
| 93% of communication is nonverbal | 70 | 20 | 6 | 5 of 5 |
| Humans can only maintain 150 friendships | 89 | 20 | 7 | 3 of 5 |
| People swallow 8 spiders a year in their sleep | 49 | 19 | 5 | 1 of 5 |

"Engines needed" is by each run's record, out of the engines whose pages Echo kept.

## What this does not show

- One Telem run per claim. A second run of the same claim can return other pages and score differently. Two same-day
  re-runs are saved in `evaluation/reruns/` and are not on the page: phones scored 23 against 18, habit 83 against 72.
- A model (Claude) judges which pages copy which. Each link is a judgment, not a measurement.
- 193 of the 285 pages could not be tied to any origin. Echo says so on every tab.
- The missing-source card is a lead, not a finding. A name many pages share can be a person or a body the claim is
  about, not its source. On the brain and habit runs Echo went looking and found no page that is the document.
- Echo is not a fact-checker and not a way to shrink context. The token figures are supporting detail.
- The score is not a truth rating. Body heat scores 86 and Echo's own answer for that run calls the claim a myth.
