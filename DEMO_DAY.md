# Echo: current showcase

This page describes the Nov 14 saved-run showcase. It is not a record of when every part of Echo was built. The earlier demo runbook, including its Nov 10–13 notes, is preserved in [docs/DEMO_DAY_ARCHIVE.md](docs/DEMO_DAY_ARCHIVE.md).

## Open the saved showcase

1. Run `npm ci` and `npm run dev`.
2. Open `http://localhost:3000/origins`. Its main table and aggregate numbers come from sixteen Telem captures dated Nov 14 in `mcp/traces/`.
3. The additional **Check a list of links** tab loads a Nov 13 saved capture. The **Where Echo was wrong** tab loads a Nov 14 limit run from `evaluation/known-limits/`. Neither is part of the sixteen-run totals.
4. `http://localhost:3000/explore` and `public/demo-traces/` retain the earlier Nov 10–13 captures with their original dates. The original demo slots and offline fallback still use those files.

Opening saved runs requires no provider key and makes no paid request. A new live claim needs configured search and model credentials and can spend credits.

## Read the figures accurately

The Nov 14 cohort is one run per claim. Counts and scores describe the pages each run found. They do not establish that a claim is true, rank search engines, or measure score stability. The previous AI-made label checks are historical evaluation data, not an accuracy measure for this cohort. The page marks one additional run where Echo overcounted independent origins.

The repository has code and artifacts from before Nov 14. Keep original capture timestamps, evaluation provenance, and Git history when sharing it.
