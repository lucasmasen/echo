import { claimWordSet, dateFrom, EchoPipelineError, fetchPublicPage, fetchPublishedMetadataDetail, isFetchablePublicUrl, metadataDateDetail, samePageKey, stripTags, tagBlocks, tavilyPost } from "./pipeline";
import type { CopyCandidate, CopyHunt, CopyHuntQuery, CopyTiming, EchoAnalysis, EchoPage } from "./types";
import { canonicalUrl } from "./url";
import { findSharedPhrases } from "./wording";

/**
 * Copy hunt: after a trace, search the web for the exact wording an original's confirmed copies reused, to list
 * pages the first search never saw. Results are possible copies only: they are never added to the trace's pages,
 * roots or counts, and no model judges them. Cost: one basic Tavily search per phrase (at most 3), no Claude. Uses Tavily's exact_match option, so results must contain
 * the quoted phrase (without it, Tavily returned topically similar pages, not copies: 1 find in 30 results on 11/10).
 */

export const MAX_COPY_HUNT_PHRASES = 3;

/** Off by default: set ECHO_COPY_HUNT=1 in .env.local to enable. Spends up to 3 basic Tavily searches, no Claude. */
export function copyHuntEnabled() {
  return process.env.ECHO_COPY_HUNT === "1";
}
export const COPY_HUNT_MISSING_KEY_MESSAGE =
  "Copy hunt searches with Tavily: add TAVILY_API_KEY to .env.local. It makes no Claude calls, so it needs no Anthropic key. The trace is unchanged.";
const MAX_CANDIDATES = 15;
const MAX_PAGE_CHECKS = 30;
const PAGE_CHECK_CONCURRENCY = 8;
const PAGE_CHECK_TIMEOUT_MS = 8_000;
const PAGE_CHECK_MAX_BYTES = 1_500_000;
const MAX_PHRASE_WORDS = 12;
const TRUSTED_DATE_SOURCES = new Set(["page text", "URL date", "page metadata"]);

type TavilyResult = { title?: string; url?: string; content?: string; published_date?: string | null };

const normalize = (text: string) => ` ${(text.toLocaleLowerCase().match(/[\p{L}\p{N}]+%?/gu) ?? []).join(" ")} `;

function comparableDay(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) ? time : null;
}

/**
 * One key per page, as the search step dedupes them: the same article at another address (http vs https, www. or m.,
 * a tracking parameter, a trailing slash) is the same page, so a trace page is never listed as a copy outside it.
 */
function pageKeyOf(url: string): string {
  return samePageKey(url) ?? url;
}

/** Every derived page whose chain of parents reaches one of the given roots. */
function copiesOf(analysis: EchoAnalysis, rootIds: Set<string>): EchoPage[] {
  const byId = new Map(analysis.pages.map((page) => [page.id, page] as const));
  return analysis.pages.filter((page) => {
    const seen = new Set<string>();
    let current: EchoPage | undefined = page;
    while (current?.judgment.kind === "derived" && current.judgment.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      if (rootIds.has(current.judgment.parentId)) return true;
      current = byId.get(current.judgment.parentId);
    }
    return false;
  });
}

function rootGroup(analysis: EchoAnalysis, rootId: string): Set<string> {
  const group = analysis.coPublishedRootGroups?.find((ids) => ids.includes(rootId));
  return new Set(group ?? [rootId]);
}

/** The root with the most confirmed copies, or null when no root has any. */
export function defaultCopyHuntRoot(analysis: EchoAnalysis): string | null {
  let best: { id: string; copies: number } | null = null;
  for (const id of analysis.roots) {
    const copies = copiesOf(analysis, rootGroup(analysis, id)).length;
    if (copies && (!best || copies > best.copies)) best = { id, copies };
  }
  return best?.id ?? null;
}

/**
 * Fingerprints: distinctive phrases the root (or its co-published twin) shares verbatim with its confirmed copies,
 * most widely reused first. Phrases that mostly restate the claim are dropped: every page repeats those.
 */
export function copyFingerprints(analysis: EchoAnalysis, rootId: string): string[] {
  const group = rootGroup(analysis, rootId);
  const roots = analysis.pages.filter((page) => group.has(page.id));
  const copies = copiesOf(analysis, group);
  const claimWords = claimWordSet(analysis.claim);
  const restatesClaim = (phrase: string) => {
    const content = (phrase.toLocaleLowerCase().match(/[\p{L}\p{N}]+%?/gu) ?? []).filter((word) => word.length > 3 || /\d/.test(word));
    return !content.length || content.filter((word) => claimWords.has(word)).length / content.length >= 0.6;
  };
  const tally = new Map<string, { phrase: string; copies: Set<string> }>();
  for (const copy of copies) {
    for (const root of roots) {
      for (const found of findSharedPhrases(root.text, copy.text)) {
        if (restatesClaim(found)) continue;
        const phrase = found.split(/\s+/).slice(0, MAX_PHRASE_WORDS).join(" ").replace(/[“”"]/g, "");
        const key = normalize(phrase);
        const entry = tally.get(key) ?? { phrase, copies: new Set<string>() };
        entry.copies.add(copy.id);
        tally.set(key, entry);
      }
    }
  }
  const ranked = [...tally.values()].sort((a, b) => b.copies.size - a.copies.size || b.phrase.length - a.phrase.length);
  const picked: string[] = [];
  for (const { phrase } of ranked) {
    // Skip a phrase contained in one already picked; it would find the same pages.
    if (picked.some((other) => normalize(other).includes(normalize(phrase)) || normalize(phrase).includes(normalize(other)))) continue;
    picked.push(phrase);
    if (picked.length === MAX_COPY_HUNT_PHRASES) break;
  }
  return picked;
}

/** Timing against the original needs a trustworthy date on both sides: a search estimate can be a later update. */
function timingFor(rootDate: string | null, rootSource: string | undefined, date: string | null, source: string | undefined): CopyTiming {
  const root = TRUSTED_DATE_SOURCES.has(rootSource ?? "") ? comparableDay(rootDate) : null;
  const day = TRUSTED_DATE_SOURCES.has(source ?? "") ? comparableDay(date) : null;
  if (root === null || day === null) return "date unknown";
  if (day > root) return "after root";
  return day === root ? "same day" : "before root";
}

type PageCheck = { text: string; date: { date: string; field: string } | null } | null;

/**
 * A fetched page's text for phrase matching: script, style and noscript blocks dropped, tags removed, common
 * entities decoded. The blocks are found in linear time (see tagBlocks), so unclosed tags cannot stall the server.
 */
export function pageTextForPhrases(html: string): string {
  let withoutBlocks = "";
  let position = 0;
  for (const block of tagBlocks(html, /<(script|style|noscript)/gi, (tag) => `</${tag}>`)) {
    withoutBlocks += html.slice(position, block.index) + " ";
    position = block.end;
  }
  return stripTags(withoutBlocks + html.slice(position))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&#8217;/g, "'").replace(/&quot;|&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"');
}

/**
 * Free direct fetch of a search result's page, so a phrase that is in the article but not in the search snippet
 * still counts. Same safety rules as the date fetcher: public http(s) hosts only (checked again after redirects),
 * HTML only, size and time limits. Any failure returns null.
 */
export async function fetchPageForPhrases(url: string, signal?: AbortSignal): Promise<PageCheck> {
  if (!isFetchablePublicUrl(url)) return null;
  const timeout = AbortSignal.timeout(PAGE_CHECK_TIMEOUT_MS);
  try {
    const fetched = await fetchPublicPage(url, {
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (compatible; EchoSourceTracer/0.1)" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!fetched) return null;
    const { response } = fetched;
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || (type && !/html/i.test(type)) || !response.body) {
      response.body?.cancel().catch(() => undefined);
      return null;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let bytes = 0;
    try {
      while (bytes < PAGE_CHECK_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        html += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
    return { text: pageTextForPhrases(html), date: metadataDateDetail(html) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/**
 * Pure step: keep new pages that contain a fingerprint phrase verbatim, first in the search title or snippet, then
 * (for pages fetched directly) anywhere in the page text.
 */
export function matchCopyCandidates(
  analysis: EchoAnalysis,
  resultsByPhrase: Array<{ phrase: string; results: TavilyResult[] }>,
  pageTextByUrl: Map<string, string> = new Map(),
) {
  const known = new Set(analysis.pages.map((page) => pageKeyOf(canonicalUrl(page.url) ?? page.url)));
  const byUrl = new Map<string, { result: TavilyResult; url: string; phrases: Set<string>; foundIn: "search snippet" | "full page" }>();
  const newMatches = new Map<string, number>();
  const fullText = new Map([...pageTextByUrl].map(([url, text]) => [url, normalize(text)] as const));
  for (const { phrase, results } of resultsByPhrase) {
    let count = 0;
    for (const result of results) {
      const url = canonicalUrl(result.url ?? "");
      if (!url || known.has(pageKeyOf(url))) continue;
      const inSnippet = normalize(`${result.title ?? ""} ${result.content ?? ""}`).includes(normalize(phrase));
      const inPage = !inSnippet && Boolean(fullText.get(url)?.includes(normalize(phrase)));
      if (!inSnippet && !inPage) continue;
      const entry = byUrl.get(pageKeyOf(url)) ?? { result, url, phrases: new Set<string>(), foundIn: inSnippet ? "search snippet" as const : "full page" as const };
      if (!entry.phrases.has(phrase)) count += 1;
      entry.phrases.add(phrase);
      byUrl.set(pageKeyOf(url), entry);
    }
    newMatches.set(phrase, count);
  }
  const matches = [...byUrl.values()].sort((a, b) => b.phrases.size - a.phrases.size);
  return { matches, newMatches };
}

/** New result URLs (not already in the trace), most often returned first. */
function newResultUrls(analysis: EchoAnalysis, resultsByPhrase: Array<{ results: TavilyResult[] }>): string[] {
  const known = new Set(analysis.pages.map((page) => pageKeyOf(canonicalUrl(page.url) ?? page.url)));
  const counts = new Map<string, number>();
  for (const { results } of resultsByPhrase) for (const result of results) {
    const url = canonicalUrl(result.url ?? "");
    if (url && !known.has(pageKeyOf(url))) counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([url]) => url).slice(0, MAX_PAGE_CHECKS);
}

async function mapLimited<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; out[index] = await task(items[index]); }
  }));
  return out;
}

export async function runCopyHunt(
  analysis: EchoAnalysis,
  options: {
    rootId?: string;
    signal?: AbortSignal;
    search?: (phrase: string, signal?: AbortSignal) => Promise<TavilyResult[]>;
    metadata?: typeof fetchPublishedMetadataDetail;
    fetchPage?: (url: string, signal?: AbortSignal) => Promise<PageCheck>;
  } = {},
): Promise<CopyHunt> {
  const rootId = options.rootId ?? defaultCopyHuntRoot(analysis);
  if (!rootId || !analysis.roots.includes(rootId)) {
    throw new EchoPipelineError("COPY_HUNT_NO_ROOT", "Copy hunt needs an original with at least one confirmed copy in this trace.");
  }
  const phrases = copyFingerprints(analysis, rootId);
  if (!phrases.length) {
    throw new EchoPipelineError("COPY_HUNT_NO_PHRASES", "This original shares no distinctive wording with its copies, so there is nothing specific to search for.");
  }
  // Copy hunt calls Tavily only (never Claude), so a missing key gets its own message rather than the live run's.
  if (!options.search && !process.env.TAVILY_API_KEY) {
    throw new EchoPipelineError("MISSING_KEYS", COPY_HUNT_MISSING_KEY_MESSAGE);
  }
  const search = options.search ?? (async (phrase: string, signal?: AbortSignal) => {
    const payload = await tavilyPost<{ results?: TavilyResult[] }>("search", { query: `"${phrase}"`, search_depth: "basic", max_results: 20, exact_match: true, include_published_date: true }, signal);
    return payload.results ?? [];
  });
  const metadata = options.metadata ?? fetchPublishedMetadataDetail;
  const fetchPage = options.fetchPage ?? fetchPageForPhrases;
  const queries: CopyHuntQuery[] = [];
  const resultsByPhrase: Array<{ phrase: string; results: TavilyResult[] }> = [];
  let budgetError: unknown = null;
  for (const phrase of phrases) {
    try {
      const results = await search(phrase, options.signal);
      resultsByPhrase.push({ phrase, results });
      queries.push({ phrase, status: "searched", results: results.length, newMatches: 0 });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // Stop on a spending cap or missing key; a single failed search only skips that phrase.
      if (error instanceof EchoPipelineError && /BUDGET|MISSING_KEYS|TAVILY_AUTH/.test(error.code)) { budgetError = error; break; }
      queries.push({ phrase, status: "failed", results: 0, newMatches: 0 });
    }
  }
  if (budgetError && !resultsByPhrase.length) throw budgetError;
  // Free: open each new result directly so wording outside the short search snippet still counts.
  const urls = newResultUrls(analysis, resultsByPhrase);
  const checked = await mapLimited(urls, PAGE_CHECK_CONCURRENCY, (url) => fetchPage(url, options.signal).catch(() => null));
  const pageTextByUrl = new Map<string, string>();
  const pageDateByUrl = new Map<string, { date: string; field: string }>();
  urls.forEach((url, index) => {
    const page = checked[index];
    if (page?.text) pageTextByUrl.set(url, page.text);
    if (page?.date) pageDateByUrl.set(url, page.date);
  });
  const { matches, newMatches } = matchCopyCandidates(analysis, resultsByPhrase, pageTextByUrl);
  for (const query of queries) query.newMatches = newMatches.get(query.phrase) ?? 0;
  const rootPage = analysis.pages.find((page) => page.id === rootId);
  const rootDate = rootPage?.publishedDate ?? null;
  // The original's own site (and its co-published twins) republishing the release is not a copy.
  const originDomains = new Set(analysis.pages.filter((page) => rootGroup(analysis, rootId).has(page.id)).map((page) => page.domain.replace(/^www\./, "")));
  const domainOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const external = matches.filter(({ url }) => !originDomains.has(domainOf(url)));
  const dated: CopyCandidate[] = await mapLimited(external, PAGE_CHECK_CONCURRENCY, async ({ result, url, phrases: matched, foundIn }) => {
    const content = result.content ?? "";
    let date = dateFrom(result.published_date, content, url);
    if (!date.date || date.source === "Tavily estimate") {
      const detail = pageDateByUrl.get(url) ?? await metadata(url, options.signal).catch(() => null);
      if (detail) date = { date: detail.date, source: "page metadata" };
    }
    const domain = domainOf(url);
    return {
      url,
      title: (result.title ?? domain).slice(0, 300),
      domain,
      publishedDate: date.date,
      ...(date.source ? { publishedDateSource: date.source } : {}),
      matchedPhrases: [...matched],
      foundIn,
      snippet: content.replace(/\s+/g, " ").trim().slice(0, 300),
      timing: timingFor(rootDate, rootPage?.publishedDateSource, date.date, date.source),
    };
  });
  // A phrase found on a page reliably dated before the original is ordinary wording, not the original's fingerprint.
  const commonPhrases = phrases.filter((phrase) => dated.some((candidate) => candidate.timing === "before root" && candidate.matchedPhrases.includes(phrase)));
  const distinctive = (candidate: CopyCandidate) => candidate.matchedPhrases.filter((phrase) => !commonPhrases.includes(phrase)).length;
  const timingRank: Record<CopyTiming, number> = { "after root": 0, "date unknown": 1, "same day": 2, "before root": 3 };
  const candidates = dated
    .filter((candidate) => distinctive(candidate) > 0)
    .sort((a, b) => distinctive(b) - distinctive(a) || timingRank[a.timing] - timingRank[b.timing])
    .slice(0, MAX_CANDIDATES);
  return { rootId, phrases, searchedAt: new Date().toISOString(), queries, candidates, pagesChecked: pageTextByUrl.size, ...(commonPhrases.length ? { commonPhrases } : {}) };
}
