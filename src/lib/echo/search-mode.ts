// Deep search (opt-in per run, the claim box's "Standard | Deep" toggle): more query variants, both search passes,
// more results per search, up to 50 pages read, and the source judgment split into batches. Standard (the default) is
// the run Echo has always made. Pure and client-safe: the pipeline reads the parameters, the claim box the estimate.

export type SearchMode = "standard" | "deep";

export const DEEP_SEARCH = {
  /** Basic-pass query variants (Standard: 10). */
  basicQueries: 12,
  /** The deeper (advanced / Telem extended-tier) pass always runs on the first 4 variants (Standard: 3, only when thin). */
  advancedQueries: 4,
  /** Results asked of each search: Tavily's max_results and Telem's num_results per provider (Standard: 10, 8 deeper). */
  resultsPerSearch: 20,
  /** The basic pass stops early once this many distinct pages are found (Standard: 20). */
  stopBasicAt: 100,
  /** Pages read and judged (Standard: 20). */
  pagesRead: 50,
  /** At most this many of the pages read come from one site, so more distinct domains are kept. */
  maxPagesPerDomain: 3,
  /** Pages per source-judgment request; a claim group larger than this is split by date. */
  judgeBatchPages: 20,
  /** Judgment requests sent at once. */
  judgeConcurrency: 3,
  /** The grouping request's output limit (Standard: 1,800 tokens) for 2.5 times the pages. */
  groupingMaxTokens: 4_000,
} as const;

/** Searches a Deep run can send at most, whichever router runs them: 12 basic + 4 deeper = 16. */
export const DEEP_MAX_SEARCHES = DEEP_SEARCH.basicQueries + DEEP_SEARCH.advancedQueries;

/**
 * What a Deep run costs and how long it takes: an ESTIMATE, not a measurement (no live Deep run had been made when it
 * was written, 2026-11-13). Derived by scripts/measure-cost.mjs from its calibrated per-page token model of the 19
 * saved runs (it fails if these ranges stop covering what it computes):
 *   Claude ≈ $0.24: grouping of 50 pages (≈16.7k input, ≈2.3k output tokens), 3 judgment requests (≈43.6k input with
 *     their context pages, ≈8.4k output), the answer (≈$0.01). Standard: ≈$0.08.
 *   Tavily router: 12 basic + 4 advanced searches (20 credits) + 10 extract credits = 30 credits ≈ $0.24: ≈$0.48 a run.
 *   Telem router: 10 extract credits ($0.08) on Tavily; 16 Telem searches at 20 results per provider: $0.69 if every
 *     allowed provider answers every search (the reservation), about $0.32 if two or three do (~$0.02 a search):
 *     ≈$0.64-1.01 a run.
 *   Time: the 4 measured runs' stage medians scaled (16 searches in 5 rounds, 50 pages read, the grouping output
 *     scaled, judgment requests 3 at a time): ≈70 s, against 35-45 s for Standard.
 */
export const DEEP_ESTIMATE = {
  telem: { lowUsd: 0.6, highUsd: 1.1, telemHighUsd: 0.69 },
  tavily: { lowUsd: 0.4, highUsd: 0.6 },
  minutes: "1–2",
} as const;

/** The Deep option's tooltip, for the router this server searches with. */
export function deepSearchTooltip(router: "telem" | "tavily" | "misconfigured" | null | undefined): string {
  const range = router === "telem" ? DEEP_ESTIMATE.telem : DEEP_ESTIMATE.tavily;
  const searches = router === "telem"
    ? `at most ${DEEP_MAX_SEARCHES} Telem searches (20 results per engine; up to $${DEEP_ESTIMATE.telem.telemHighUsd.toFixed(2)} of Telem credit)`
    : `${DEEP_MAX_SEARCHES} searches of 20 results`;
  return `Deep search: ${searches}, reads up to ${DEEP_SEARCH.pagesRead} pages (Standard: 20) and judges them in batches. Estimate ≈$${range.lowUsd.toFixed(1)}–${range.highUsd.toFixed(1)} · ~${DEEP_ESTIMATE.minutes} min per run (Standard ≈$0.2 · under 1 min). This run only.`;
}
