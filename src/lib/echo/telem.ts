// Telem (https://router.telem.ai): a web search router. One POST /v1/search sends a query to several search providers
// (Exa, Tavily, Brave, ...) and, with auto-routing on, Telem picks which ones answer it and says so in `routing`.
// Echo uses it for the search step only when TELEM_API_KEY is set (and ECHO_SEARCH_ROUTER is not "tavily"); page
// reading stays on Tavily. This file holds the pure parts (which router runs, prices, response parsing) so the checks
// can test them without a request; pipeline.ts sends the request through the daily budget (Telem's own daily cap).
//
// Request and response fields used (Telem docs, "API Reference: every operation" > Search, and "Search parameters" >
// Auto-routing / Tier / Where each field comes from):
//   request:  user_input.query; search.auto_routing = "accuracy"; search.providers.include (the set Telem may choose
//             from); search.num_results (per provider, 1-20); search.tier ("default" or "extended").
//   response: routing[0].providers (the providers Telem chose, best first; null without auto-routing);
//             preprocessor_runs[] with preprocessor_name, status, error and output_payload.results[] of
//             { url, title, rank, summary, publish_date? }; a failed run has error set and output_payload null.

import { isProviderName } from "./search-providers";

export type SearchRouter = "telem" | "tavily";

export const TELEM_SEARCH_URL = "https://router.telem.ai/v1/search";

/**
 * The providers auto-routing may choose from (search.providers.include). With an include list Telem chooses only from
 * it, so the most one query can cost is known before it is sent. All five have a published per-search price.
 */
export const TELEM_PROVIDERS = ["exa", "tavily", "brave", "parallel", "perplexity"] as const;

/**
 * List price of one search per provider, in US dollars, by tier (Telem docs, "Pricing" > Prices > Search, and "Choose a
 * tier": tavily and parallel cost more at `extended`). Telem charges each provider that answers at its own price, with
 * no markup; a failed provider run is free. Exa is billed "what exa charges for the call": Exa lists $0.005 a search of
 * up to 25 results plus about $0.001 a result for the text it returns, so $0.015 covers 10 results (an estimate).
 */
const PRICE_USD: Record<string, { default: number; extended: number }> = {
  exa: { default: 0.015, extended: 0.015 },
  tavily: { default: 0.005, extended: 0.01 },
  brave: { default: 0.005, extended: 0.005 },
  parallel: { default: 0.001, extended: 0.005 },
  perplexity: { default: 0.005, extended: 0.005 },
};
/** A provider outside the table (it should not run with the include list): priced as the dearest one, never as free. */
const UNKNOWN_PROVIDER_USD = 0.015;

export type TelemTier = "default" | "extended";

/**
 * A provider's list price for one search. Exa bills about $0.001 a returned result on top of its $0.005 a search, so
 * past the 10 results its table price covers (a Deep search asks for 20 per provider) it is priced by the results.
 */
export function providerPriceUsd(provider: string, tier: TelemTier, numResults = 10): number {
  if (provider === "exa") return Math.max(PRICE_USD.exa[tier], Math.round((0.005 + 0.001 * numResults) * 1e6) / 1e6);
  return PRICE_USD[provider]?.[tier] ?? UNKNOWN_PROVIDER_USD;
}

/**
 * What one Telem search is reserved at before it is sent: every allowed provider answering at its list price, since
 * auto-routing may pick any of them. Default tier $0.031, extended $0.040 (up to 10 results per provider); a Deep
 * search's 20 results: $0.041 and $0.050.
 */
export function telemReserveUsd(tier: TelemTier, numResults = 10): number {
  return Math.round(TELEM_PROVIDERS.reduce((sum, provider) => sum + providerPriceUsd(provider, tier, numResults), 0) * 1e6) / 1e6;
}

/**
 * Which router this server's search step uses. ECHO_SEARCH_ROUTER=tavily forces Tavily; ECHO_SEARCH_ROUTER=telem
 * forces Telem (a missing key is then a MISSING_KEYS error, not a silent fall back); otherwise Telem runs when
 * TELEM_API_KEY is set, and Tavily (today's behavior) when it is not.
 */
export function searchRouter(): SearchRouter {
  const configured = process.env.ECHO_SEARCH_ROUTER?.trim().toLowerCase();
  if (configured === "tavily") return "tavily";
  if (configured === "telem") return "telem";
  return process.env.TELEM_API_KEY?.trim() ? "telem" : "tavily";
}

/**
 * What GET /api/analyze tells the page about the search step, with no secret in it: "telem" or "tavily" for the router a
 * live run will use, or "misconfigured" when it would use Telem but the key is missing or malformed (a Telem key in
 * .env.local that is not one, or ECHO_SEARCH_ROUTER=telem with no key), so the run would stop at the search step.
 */
export function searchRouterStatus(): SearchRouter | "misconfigured" {
  const router = searchRouter();
  return router === "telem" && telemKeyProblem(process.env.TELEM_API_KEY) ? "misconfigured" : router;
}

/** A key that can be sent: Telem keys start with "tlm_". */
export function telemKeyProblem(key: string | undefined): string | null {
  const value = key?.trim();
  if (!value) return "Add TELEM_API_KEY to .env.local to search through Telem, or set ECHO_SEARCH_ROUTER=tavily to search with Tavily. The saved runs open without keys.";
  if (!/^tlm_[\x21-\x7e]{8,}$/.test(value)) return "TELEM_API_KEY in .env.local does not look like a Telem key (it starts with tlm_). Copy it again from the Telem console, or set ECHO_SEARCH_ROUTER=tavily to search with Tavily.";
  return null;
}

export type TelemHit = {
  url: string;
  title?: string;
  content?: string;
  published_date?: string | null;
  /** Echo's own ranking score from the providers' ranks (Telem has no cross-provider score). */
  score: number;
  /** Every provider that returned this URL for the query, in routing order. */
  providers: string[];
};

export type TelemSearchOutcome = {
  hits: TelemHit[];
  /** Providers whose run completed (and was billed), in routing order. */
  providers: string[];
  /** Providers Telem routed the query to (routing[0].providers), or the runs' names when routing is absent. */
  routed: string[];
  /** Providers whose run failed (free). */
  failed: string[];
  /** What the completed runs cost at list price (Exa's own reported cost when the run includes it). */
  usd: number;
};

type TelemRun = {
  preprocessor_name?: unknown;
  status?: unknown;
  error?: unknown;
  usage?: unknown;
  output_payload?: { results?: unknown; usage?: unknown } | null;
};

/** Exa's own cost for the call when the run reports it (output_payload.usage = Exa's costDollars, at `extended`). */
function reportedRunUsd(run: TelemRun): number | null {
  const usage = (run.output_payload?.usage ?? run.usage) as { total?: unknown } | undefined;
  const total = Number(usage?.total);
  return Number.isFinite(total) && total >= 0 && total <= 0.1 ? total : null;
}

/**
 * Reads a Telem search response into hits. Results are merged across providers: a URL two providers returned is one
 * hit naming both. Hits are interleaved by rank (each provider's first, then each one's second, ...), so no single
 * provider's list fills the page budget first, and each is scored from its best rank (1 for a first result, falling to
 * 1/numResults) plus 0.05 for each further provider that returned it.
 */
export function parseTelemSearch(payload: unknown, tier: TelemTier, numResults: number, canonical: (url: string | undefined) => string | null): TelemSearchOutcome {
  const body = (payload && typeof payload === "object" ? payload : {}) as { routing?: unknown; preprocessor_runs?: unknown };
  const runs: TelemRun[] = Array.isArray(body.preprocessor_runs) ? body.preprocessor_runs.filter((run): run is TelemRun => Boolean(run) && typeof run === "object") : [];
  const firstRouting = Array.isArray(body.routing) ? (body.routing[0] as { providers?: unknown } | undefined) : undefined;
  const routedRaw = Array.isArray(firstRouting?.providers) ? firstRouting.providers.filter(isProviderName) : [];
  const runName = (run: TelemRun) => (isProviderName(run.preprocessor_name) ? run.preprocessor_name : null);
  const runFailed = (run: TelemRun) => Boolean(run.error) || run.status === "failed" || !run.output_payload;
  const routed = routedRaw.length ? [...new Set(routedRaw)] : [...new Set(runs.map(runName).filter((name): name is string => Boolean(name)))];
  const order = (name: string) => {
    const index = routed.indexOf(name);
    return index < 0 ? routed.length : index;
  };
  const completed = runs.filter((run) => runName(run) && !runFailed(run)).sort((a, b) => order(runName(a)!) - order(runName(b)!));
  const providers = [...new Set(completed.map((run) => runName(run)!))];
  const failed = [...new Set(runs.filter((run) => runName(run) && runFailed(run)).map((run) => runName(run)!))].filter((name) => !providers.includes(name));
  let usd = 0;
  for (const run of completed) usd += reportedRunUsd(run) ?? providerPriceUsd(runName(run)!, tier, numResults);

  const lists = completed.map((run) => {
    const rows = Array.isArray(run.output_payload?.results) ? (run.output_payload!.results as Array<Record<string, unknown>>) : [];
    const ranked = rows
      .filter((row) => row && typeof row === "object" && typeof row.url === "string")
      .map((row, index) => ({ row, rank: Number.isFinite(Number(row.rank)) && Number(row.rank) > 0 ? Number(row.rank) : index + 1 }))
      .sort((a, b) => a.rank - b.rank);
    return { provider: runName(run)!, rows: ranked.map(({ row }) => row) };
  });
  const hits = new Map<string, TelemHit>();
  const depth = Math.max(0, ...lists.map((list) => list.rows.length));
  const slots = Math.max(1, numResults, depth);
  for (let position = 0; position < depth; position += 1) {
    for (const list of lists) {
      const row = list.rows[position];
      if (!row) continue;
      const url = canonical(row.url as string);
      if (!url) continue;
      const existing = hits.get(url);
      if (existing) {
        if (!existing.providers.includes(list.provider)) {
          existing.providers.push(list.provider);
          existing.score = Math.round((existing.score + 0.05) * 1e6) / 1e6;
        }
        if (!existing.content && typeof row.summary === "string") existing.content = row.summary;
        if (!existing.published_date && typeof row.publish_date === "string") existing.published_date = row.publish_date;
        continue;
      }
      hits.set(url, {
        url,
        ...(typeof row.title === "string" ? { title: row.title } : {}),
        ...(typeof row.summary === "string" ? { content: row.summary } : {}),
        ...(typeof row.publish_date === "string" ? { published_date: row.publish_date } : {}),
        score: Math.round(((slots - position) / slots) * 1e6) / 1e6,
        providers: [list.provider],
      });
    }
  }
  return { hits: [...hits.values()], providers, routed, failed, usd: Math.round(usd * 1e6) / 1e6 };
}

/** The message in a Telem error body: `detail` as a string, or its `code`/`reason`, or `error.message`. */
export function telemErrorDetail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const { detail, error } = body as { detail?: unknown; error?: { message?: unknown } };
  if (typeof detail === "string") return detail.slice(0, 200);
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const { code, reason } = detail as { code?: unknown; reason?: unknown };
    return [code, reason].filter((part) => typeof part === "string").join(": ").slice(0, 200);
  }
  if (typeof error?.message === "string") return error.message.slice(0, 200);
  return "";
}
