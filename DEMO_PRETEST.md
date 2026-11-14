# Echo demo claim pre-test

The stage claims below are the current candidates in the app. Search volume alone does not validate the demo: the tree must show the intended source relationship. Bundled graphs are labeled UI rehearsal fixtures; only a live analysis saved in the browser is a real cached result.

## Three stage slots

| Slot | Claim | Target outcome |
| --- | --- | --- |
| 01 · Ghost stat | “Humans use only 10% of their brains.” | Many pages; no verifiable original source |
| 02 · Zombie stat | “90% of startups fail.” | Pages collapse to a documented root |
| 03 · Live claim | A claim a judge chooses from the week's news | Run uncached; use the backup video if the network fails |

## Pre-test results and current call

These figures are from two Tavily searches per claim (full claim plus quoted phrase), deduplicated by URL. They measure search coverage, not proof that every result repeats the claim. Echo's live analysis can return fewer pages after relevance filtering.

| Claim | Search URLs | Dated | Live Echo snapshot | Decision |
| --- | ---: | ---: | --- | --- |
| 10% of brain | 23 | 17 (74%) | 20 pages, 14 dated, 1 candidate root, 5% echo | Current Ghost candidate; repeat after the latest judge change before stage use |
| 90% of startups fail | 20 | 11 (55%) | 20 pages, 16 dated, 1 candidate root, 0% confirmed echo | Current Zombie candidate, but weak date coverage and no demonstrated collapse yet |
| 73% of RAG deployments degrade in 90 days | 33 | 25 (76%) | 3 relevant pages, 3 dated, 0 roots | Bench: broad results mostly fail the app's relevance filter |
| 8 spiders a year | 24 | 16 (67%) | 11 pages, 7 dated, 4 candidate roots, 0% echo | Bench: no single-root collapse; the popular Lisa Holst origin story is itself unverified |
| Goldfish 3-second memory | 28 | 13 (46%) | Not promoted to a live trace | Bench: date coverage below half |
| Most body heat lost through head | 24 | 11 (46%) | Not promoted to a live trace | Bench: date coverage below half |

The current slots are practical rehearsal choices, not a claim that either intended story has passed. The startup claim's frequently repeated “90%” figure is not backed by a clear underlying study in the traced report; treat the report as a traceable quotation, not proof of the statistic. The brain myth has multiple proposed origin explanations, so the defensible demo line is “no verifiable original source found in this search,” not “the origin is known to be absent.” Re-run both current candidates using the latest build and freeze only if the resulting pages support the stage story.

## Backup pool

- “Goldfish have a 3-second memory.”
- “You lose most of your body heat through your head.”

## Search phrase sheet

Run one search with the full claim and a second with the quoted phrase:

| Candidate | Full claim | Quoted phrase |
| --- | --- | --- |
| Ghost stat | 73% of RAG deployments degrade within 90 days | `"73% of RAG deployments"` |
| Zombie stat | You swallow 8 spiders a year in your sleep | `"8 spiders a year"` |
| Goldfish memory | Goldfish have a 3-second memory | `"3-second memory"` |
| Head heat loss | You lose most of your body heat through your head | `"most of your body heat through your head"` |

## Wednesday manual checks

Use Tavily's playground or call its Search API directly. Repeat each search with the full claim and with its distinctive quoted phrase. Deduplicate URLs across the responses.

You can also run the local helper for one candidate at a time. It reads `TAVILY_API_KEY` from `.env.local`, makes exactly two Tavily basic-search requests, and prints distinct URLs, date coverage, titles, and snippets. It never calls Claude or Anthropic. Running it may use Tavily search credits.

```bash
npm run pretest:claim -- --claim "73% of RAG deployments degrade within 90 days" --phrase '"73% of RAG deployments"'
```

Review repeated wording and origin stories yourself; the helper does not decide whether a claim passes or identify a true source root.

```bash
curl --request POST \
  --url https://api.tavily.com/search \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"query":"73% of RAG deployments degrade within 90 days","search_depth":"basic","max_results":20,"include_published_date":true}'
```

For every primary claim and backup, record:

- [ ] The claim and quoted-phrase searches produce at least 20 distinct URLs.
- [ ] Pages visibly repeat the same unusual number or phrasing.
- [ ] Publication dates are available for most pages; leave missing dates unknown.
- [ ] Check dates against the page when chronology matters: Tavily's date is an estimate and may reflect a later update.
- [ ] The origin story is supported by retrievable sources, or the absence of a source is confirmed.
- [ ] If any check fails, bench the claim and test a backup.

| Claim | Distinct URLs | Pages with dates | Repeated wording visible | Origin checked | Pass / bench |
| --- | ---: | ---: | --- | --- | --- |
| 10% brain (Ghost candidate) | 23 | 17 (74%) | Yes | Multiple origin theories; no original source located | Recheck with latest build |
| 90% startup failure (Zombie candidate) | 20 | 11 (55%) | Yes | Startup Genome report is a traceable quotation, but its figure is unsupported | Recheck; do not claim echo collapse |
| 73% RAG deployment | 33 | 25 (76%) | Mixed | No origin found; only 3 relevant pages in Echo | Bench |
| 8 spiders a year | 24 | 16 (67%) | Yes | Lisa Holst story unverified; Echo found 4 candidate roots | Bench |
| Goldfish memory |  |  |  |  |  |
| Head heat loss |  |  |  |  |  |

Freeze the selected claims Friday night. After the manual pre-test, select each frozen claim and press **Trace sources** once with API keys configured. Echo stores the complete live result for each preset or backup in the current browser's local cache; reopening that claim should load it without a new search. If answer synthesis fails or a snippet-only page leaves its relationship unresolved, Echo shows the available tree and skips the pinned cache so the claim can be retried. Preset caches stay pinned in that browser profile until cleared. Slot 03 always bypasses saved results; a custom claim run there can be reopened afterward from Recent live traces. Keep the browser profile used for the demo on the same laptop used for the pre-test.

## Event-day freeze and cut order

At **3:30 PM**, stop adding features. Use the remaining time for fixes, three clean demo runs, and a 60-second backup video. Submit at 4:15 PM.

If the build is behind, cut in this order: answer synthesis, the live claim, then pairwise judging (switch to per-cluster judging). **Never cut the tree.** The backup video covers the live-claim slot if the network fails.
