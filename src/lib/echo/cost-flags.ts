// Cost switches for a live run. Every one except the search cache is OFF (today's behavior) unless its environment
// variable is set, because each either could change which pages Echo judges or only pays off in some usage patterns. Measured savings and the
// live A/B test each one still needs are in scripts/measure-cost.mjs and the cost round's report.

/** Today's trigger: an advanced search pass (3 queries, 6 credits) runs when basic searches found fewer than 20 pages. */
export const DEFAULT_DEEP_SEARCH_BELOW = 20;

/**
 * ECHO_DEEP_SEARCH_BELOW=N runs the advanced pass only when basic searches found fewer than N distinct pages
 * (0 skips it). Unset, empty or invalid keeps 20. Values above 20 are treated as 20: the switch can only spend less.
 */
export function deepSearchBelow(): number {
  const raw = process.env.ECHO_DEEP_SEARCH_BELOW;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DEEP_SEARCH_BELOW;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DEEP_SEARCH_BELOW;
  return Math.min(DEFAULT_DEEP_SEARCH_BELOW, Math.floor(value));
}

/**
 * ECHO_PROMPT_CACHE=1 marks the source-judgment prompt for Claude's 5-minute prompt cache. It never changes what
 * the model reads, only the bill: a first request pays 1.25x on its input, a repeat within 5 minutes pays about
 * 0.05x on the cached part. Worth it for rejudge:trace loops (the same prompt again and again, ~44% off) and
 * back-to-back live runs (the fixed instructions, ~$0.003 off each); a lone live run pays ~$0.004 more. Off by default.
 */
export function promptCacheEnabled(): boolean {
  return process.env.ECHO_PROMPT_CACHE === "1";
}

/**
 * The search cache, ON by default (ECHO_SEARCH_CACHE=0 turns it off): a run that is not "Run fresh" reuses this
 * server's completed Tavily searches from the last 15 minutes, as it already reuses extracts. It only matters when a
 * claim is traced again within 15 minutes without the analysis cache answering: after a failed run, or after a run
 * kept out of the analysis cache (a snippet-only page left unclear; 14 of 15 saved runs). It then saves 5-16 credits
 * ($0.04-0.13). Such a retry sees the same search results as the first try; "Run fresh" always searches again and
 * refreshes the cached results.
 */
export function searchCacheEnabled(): boolean {
  return process.env.ECHO_SEARCH_CACHE?.trim() !== "0";
}

/**
 * ECHO_THINKING_OFF=judgment (or grouping, answer, a comma list, or "all") turns Claude's thinking off for those
 * requests. Echo sends no `thinking` setting, and on claude-sonnet-5-5 and claude-haiku-5-5 that means adaptive
 * thinking is ON: thinking tokens are billed as output (they are in usage.output_tokens) though Echo never reads them.
 * The 11/13 receipts show ~1,300-1,400 judge output tokens and up to ~650 grouping tokens more than the JSON Echo kept,
 * which thinking would explain (not verified: see ECHO_LOG_USAGE). Off by default: thinking may be what makes the
 * judgments good. Sonnet 5.5 rejects {type: "disabled"}; its off switch is {type: "between_tools"} (effort high or
 * below, which Echo's default is). Haiku 5.5 takes {type: "disabled"} at its default effort.
 */
export function thinkingOffFor(step: string | undefined): boolean {
  const raw = process.env.ECHO_THINKING_OFF?.trim().toLowerCase();
  if (!raw || !step) return false;
  const steps = new Set(raw.split(/[\s,]+/).filter(Boolean));
  return steps.has("all") || steps.has(step);
}

/** The request field that turns thinking off on this model, or null when Echo knows no safe off switch for it. */
export function thinkingOffSetting(model: string): { type: "between_tools" } | { type: "disabled" } | null {
  if (model === "claude-sonnet-5-5") return { type: "between_tools" };
  if (model === "claude-haiku-5-5") return { type: "disabled" };
  return null;
}

/** ECHO_LOG_USAGE=1 prints each Claude request's token usage (including thinking tokens when reported) to stderr. */
export function logUsageEnabled(): boolean {
  return process.env.ECHO_LOG_USAGE === "1";
}

/**
 * ANTHROPIC_GROUPING_MODEL=claude-haiku-5-5 runs only the page-grouping request on that model (about 1/20 of Sonnet's
 * price; ~$0.009 a run saved) while the source judgment stays on the classifier model. Read per run. Unset keeps the
 * classifier model. Grouping decides which pages the judge compares, so it needs a live A/B before it becomes a default.
 */
export function groupingModel(fallback: string): string {
  return process.env.ANTHROPIC_GROUPING_MODEL?.trim() || fallback;
}

/**
 * ECHO_SEARCH_RAW_CONTENT=1 asks each Tavily search for its results' page text (include_raw_content: "markdown") and
 * uses that text for a selected page instead of extracting it, so only pages whose search result came back without
 * text are sent to /extract. Tavily's docs price a search by its depth alone ("Your search depth determines the cost
 * of your request": basic 1 credit, advanced 2, docs.tavily.com/documentation/api-credits) and list no surcharge for
 * raw content, so this should save the 2-3 extract credits of a run (~$0.02). Off by default: the judged text changes
 * (the whole page, not the extract's two claim-relevant chunks), and a live receipt must confirm searches still bill 1.
 */
export function searchRawContentEnabled(): boolean {
  return process.env.ECHO_SEARCH_RAW_CONTENT === "1";
}
