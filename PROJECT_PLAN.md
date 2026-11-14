# Echo: build and event plan

Updated November 9, 2026. This is a working plan; claim choices and timing can change when live traces are reviewed. The [official SearchHack page](https://luma.com/e13wf1bd) lists judging criteria as innovation, technical execution, search intelligence, and impact; submissions are due at 4:15 PM on November 14.

## Product target

For any short factual claim, Echo should show the retrieved pages, likely source relationships, unresolved relationships, evidence at candidate roots, and an answer grounded only in roots. A reviewer should be able to open every cited source and see why the tree has each edge. A saved trace should work offline. The headline must never turn a search result count into a claim about the whole web.

## Current state

- Built: search fan-out, Tavily retrieval and extraction, claim grouping, cautious Claude source judgments, chronology guards, root-only answer, deterministic limited-evidence answer, interactive tree and timeline, review queue, query audit, portable traces, saved-run comparison, offline rehearsal fixtures, presentation view, and local/Upstash Claude spend guard.
- Verified without provider charges: lint, production build, graph, portable-trace, and mocked pipeline checks. The production app opens and the rehearsal trace renders.
- The demo claims are **not frozen**. The last recorded live traces in [DEMO_PRETEST.md](./DEMO_PRETEST.md) showed only 5% confirmed echoes for the brain claim and 0% for the startup claim. Those results do not support a dramatic source collapse.
- Local Git commits exist. No Echo GitHub remote or Vercel deployment is connected. `.env.local` is ignored.

## Priority order

### P0 — make the central result credible

1. **Build a small source-judgment evaluation set.** The offline label-sheet and scoring commands are built and checked in CI; the remaining work is to manually review 6–10 real cases with direct reuse, paraphrase, independent reporting, missing dates, reversed dates, and snippet-only extraction. Record expected edges and abstentions using [EVALUATION_GUIDE.md](./EVALUATION_GUIDE.md). Synthetic command tests do not measure model quality.
2. **Improve chronology evidence.** Measure how many pages have dates from page text or URL versus Tavily estimates. Tavily says its `published_date` can reflect publication *or a later update*; it cannot establish an earlier-to-later edge alone. Preserve that distinction in the UI and tests. Try metadata extraction only if it produces enough additional trustworthy dates to justify the credits.
3. **Validate the actual preset claims.** Repeat the exact current build with the candidate and backup claims, inspect the pages behind every proposed root and high-impact edge, then save the results. If a claim fails the gates below, replace the claim. Do not force the tree toward the intended story.
   Use `npm run audit:trace -- saved.echo.json` on each exported result for a no-credit coverage check. The notes are prompts for review, not an automatic pass.
4. **Check answer grounding.** For each frozen trace, verify that each answer sentence is supported by cited root passages. An inline citation being syntactically valid is insufficient if its page does not support the sentence.

### P1 — make the result easier to inspect

5. **Improve the first-screen explanation.** Keep one claim input and one large verdict. Show likely dated links, possible paths, and missing or estimated dates together; let a judge open the exact pages behind a path in one click. Keep secondary audits collapsed.
6. **Exercise failure paths.** Test no results, Tavily partial extraction, provider rate limits, answer failure, user cancellation, offline reopening, invalid imports, and a trace with no confirmed roots. No paid provider calls are needed for these tests.
7. **Check projector and phone layouts.** Verify the live trace, root ledger, source detail, and presentation at common viewport widths. Confirm keyboard navigation, contrast, and readable text in the presentation view.

### P2 — launch readiness

8. **Connect a GitHub remote and Vercel preview** after the event's code-reuse rule is clear. Put credentials in Vercel environment variables, never in Git. Set up shared Upstash for the $2/day Echo Claude guard before enabling paid live calls on Vercel.
9. **Run the production end-to-end path** from browser to API to saved trace, then test it offline. A localhost build is not evidence that Vercel credentials, function duration, and shared budget storage work.
10. **Create a short fallback recording** of a verified trace, plus portable trace files on the laptop. Keep the live claim as the only stage step that depends on search-provider availability.

## Claim freeze gates

Each preset should meet all of these before it is used as evidence on stage:

- At least 20 distinct search URLs in the full-claim and quoted-phrase pretest, with the exact assertion visible on enough pages to form a meaningful group.
- Publication dates for most retained pages, with key directional edges supported by a page or URL date rather than a search-provider estimate.
- Every root and major parent edge manually opened and checked; primary evidence labeled honestly.
- The intended stage line matches the *observed* trace. For a ghost, say “no verifiable origin found in this search,” never “no origin exists.” For a zombie, require a visibly documented source trail before claiming one root.
- Saved portable trace, browser cache, and an offline opening all work on the presentation machine.

If a candidate fails, bench it and test a backup. The current startup candidate has **not** demonstrated a one-root echo collapse; it should not be presented as one until it does.

## Cost guardrails

- Echo already enforces a $2 Pacific-day cap on its supported Claude calls. The cap covers this app, not other Anthropic clients or accounts.
- The cap does not cover Tavily search and extract credits. A fresh trace may use up to ten basic searches, three advanced searches when thin, and extraction batches. Reopen saved traces during UI work; run live searches only for questions that the offline harness cannot answer.
- Keep model prompts bounded and use the cheaper supported classifier model only after checking that judgment quality holds on the evaluation set. Do not choose a model by token price alone.

## Event day, November 14 (Pacific time)

The [organizer's schedule](https://luma.com/e13wf1bd) is 10:00 check-in, 10:30 kickoff and rules, 11:00 building starts, 4:15 submissions, 4:30 judging, and 5:30 final presentations. The public page does not spell out code-reuse rules; ask the organizers at kickoff whether this prebuilt code may be used or must be disclosed, and follow their answer. The original pasted spec's “first commit after 11:00” line is a planning claim, not a verified public rule.

1. **Before leaving:** make a local backup, verify `npm run build`, open the saved traces offline, check laptop power and hotspot, and confirm account access. No new feature work during this check.
2. **10:30–11:00:** record the actual rules and submission format. Decide what existing code can be used. Confirm the final claim list from observed traces.
3. **11:00–3:15:** complete only the highest-priority allowed gaps; run the full no-credit checks after each meaningful change. Do at least one controlled production trace with the real credentials.
4. **3:15–3:30:** freeze features. Choose the clearest validated trace and the offline fallback.
5. **3:30–4:15:** rehearse the short walkthrough, confirm the live URL and GitHub link, test an offline opening, and submit before 4:15.
6. **Judging:** lead with one claim and the collapse (or honest lack of it), open one decisive edge and one root, then show the root-only answer. Use the uncached claim only if time and network permit.

## Research and wording checks

- [Zhou et al., EMNLP 2026](https://aclanthology.org/2026.emnlp-main.509/) supports the broad evidence-laundering problem and testing a structural provenance gate. Its natural-news masked-skeleton test reports 35.9% recall for that specific method and dataset; do **not** call this “the best published defense catches 36%” without a separate comparison. The app itself has not been benchmarked against the paper.
- [Tavily Search documentation](https://docs.tavily.com/documentation/api-reference/endpoint/search) says the search `published_date` is an estimate that may be a later update. [Tavily Extract documentation](https://docs.tavily.com/documentation/api-reference/endpoint/extract) says HTTP 200 can still contain per-URL failures. Both matter when judging roots and coverage.
