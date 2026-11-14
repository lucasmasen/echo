import type { EchoAnalysis, EchoPage, JudgmentKind } from "./types";
import { coreTitle, INDEX_RECORD_HOSTS, originCounts } from "./origins";
import { canonicalUrl } from "./url";
import { isProviderName } from "./search-providers";

export const PORTABLE_TRACE_FORMAT = "echo-trace";
export const PORTABLE_TRACE_VERSION = 1;
export const MAX_PORTABLE_TRACE_BYTES = 2 * 1024 * 1024;
const TRUSTED_DATE_SOURCES = new Set(["page text", "URL date", "page metadata"]);

type PortableTrace = {
  format: typeof PORTABLE_TRACE_FORMAT;
  version: typeof PORTABLE_TRACE_VERSION;
  exportedAt: string;
  analysis: EchoAnalysis;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown, maxLength = 20_000): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNullableString(value: unknown, maxLength = 20_000): value is string | null {
  return value === null || isString(value, maxLength);
}

/**
 * A page date as Echo writes it: a plain year, YYYY-MM, YYYY-MM-DD, or a full ISO timestamp, naming a real day. Free
 * text ("Spring 1999") is refused, so an imported file cannot show it as a date read from the page.
 */
function isPageDate(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?)?)?$/);
  if (!match) return false;
  const [, year, month = "01", day = "01", time] = match;
  const date = `${year}-${month}-${day}`;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date && (!time || Number.isFinite(Date.parse(value)));
}

function isStringArray(value: unknown, maxItems = 200): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => isString(item, 300));
}

function isPage(value: unknown): value is EchoPage {
  if (!isRecord(value) || !isRecord(value.judgment)) return false;
  const judgment = value.judgment;
  const kinds: JudgmentKind[] = ["origin", "derived", "unclear"];
  const dateSources = ["Tavily estimate", "URL date", "page text", "page metadata"];
  const extractionSources = ["Tavily extraction", "Page HTML", "Search snippet", "Rehearsal fixture"];
  return isString(value.id, 300)
    && isString(value.title, 2_000)
    && isString(value.url, 4_000)
    && isString(value.domain, 500)
    && isPageDate(value.publishedDate)
    && (value.publishedDateSource === undefined || dateSources.includes(String(value.publishedDateSource)))
    && (value.publishedDateEvidence === undefined || isString(value.publishedDateEvidence, 300))
    && (value.extractionSource === undefined || extractionSources.includes(String(value.extractionSource)))
    && isString(value.text)
    && (value.linkedPageIds === undefined || isStringArray(value.linkedPageIds, 30))
    && (value.citations === undefined || (Array.isArray(value.citations) && value.citations.length <= 30 && value.citations.every((citation) => isRecord(citation)
      && isString(citation.pageId, 300) && ["link", "title", "name and year", "named as source"].includes(String(citation.how)) && isString(citation.quote, 400))))
    && (value.favicon === undefined || value.favicon === null || isString(value.favicon, 4_000))
    && typeof value.hasPrimaryEvidence === "boolean"
    && (value.primaryEvidenceStatus === undefined || ["found", "not found", "unclear"].includes(String(value.primaryEvidenceStatus)))
    && (value.primaryEvidenceReason === undefined || isString(value.primaryEvidenceReason, 4_000))
    && kinds.includes(judgment.kind as JudgmentKind)
    && isNullableString(judgment.parentId, 300)
    && typeof judgment.confidence === "number"
    && Number.isFinite(judgment.confidence)
    && judgment.confidence >= 0
    && judgment.confidence <= 100
    && isString(judgment.evidence, 4_000);
}

function safeExternalUrl(value: string) {
  if (!value) return true;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function comparableDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

const COPY_TIMINGS = ["after root", "same day", "before root", "date unknown"];
const DATE_SOURCES = ["Tavily estimate", "URL date", "page text", "page metadata"];

/** Copy hunt results are possible copies outside the trace: they must not duplicate trace pages. */
function isCopyHunt(value: unknown, pageIds: Set<string>, roots: string[], pages: EchoPage[]): boolean {
  if (!isRecord(value) || !isString(value.rootId, 300) || !roots.includes(value.rootId)
    || !isString(value.searchedAt, 100)
    || !Array.isArray(value.phrases) || value.phrases.length < 1 || value.phrases.length > 3 || !value.phrases.every((phrase) => isString(phrase, 200) && phrase.trim())
    || !Array.isArray(value.queries) || value.queries.length > 3 || !value.queries.every((query) => isRecord(query)
      && isString(query.phrase, 200) && (value.phrases as unknown[]).includes(query.phrase)
      && ["searched", "failed"].includes(String(query.status)) && isFiniteNonNegative(query.results) && isFiniteNonNegative(query.newMatches))
    || (value.commonPhrases !== undefined && (!Array.isArray(value.commonPhrases) || !value.commonPhrases.every((phrase) => typeof phrase === "string" && (value.phrases as unknown[]).includes(phrase))))
    || (value.pagesChecked !== undefined && (!isFiniteNonNegative(value.pagesChecked) || value.pagesChecked > 30))
    || !Array.isArray(value.candidates) || value.candidates.length > 15) return false;
  // Compared as the copy hunt compares them (no #fragment, tracking parameters or trailing slash), so a file cannot
  // list a trace page, or one page twice, as possible copies outside the trace.
  const urlKey = (url: string) => canonicalUrl(url) ?? url;
  const knownUrls = new Set(pages.map((page) => urlKey(page.url)));
  const seen = new Set<string>();
  return pageIds.has(value.rootId) && value.candidates.every((candidate) => isRecord(candidate)
    && isString(candidate.url, 4_000) && safeExternalUrl(candidate.url) && /^https?:/.test(candidate.url)
    && !knownUrls.has(urlKey(candidate.url)) && !seen.has(urlKey(candidate.url)) && Boolean(seen.add(urlKey(candidate.url)))
    && isString(candidate.title, 300) && isString(candidate.domain, 500) && isString(candidate.snippet, 300)
    && isPageDate(candidate.publishedDate)
    && (candidate.publishedDateSource === undefined || DATE_SOURCES.includes(String(candidate.publishedDateSource)))
    && Array.isArray(candidate.matchedPhrases) && candidate.matchedPhrases.length >= 1
    && candidate.matchedPhrases.every((phrase) => typeof phrase === "string" && (value.phrases as unknown[]).includes(phrase))
    && (candidate.foundIn === undefined || ["search snippet", "full page"].includes(String(candidate.foundIn)))
    && COPY_TIMINGS.includes(String(candidate.timing)));
}

/**
 * A supplied-sources run ("Check these sources"): 1 to 20 distinct http(s) links, unread ones among them, every trace
 * page one of the read links, and no search audit (that run did not search). Citation numbers are optional (older
 * traces have none and show 1..N).
 */
function isSourceCheck(value: unknown, pages: EchoPage[], searchAudit: unknown): boolean {
  if (!isRecord(value) || searchAudit !== undefined || !Object.keys(value).every((key) => key === "urls" || key === "unreadUrls" || key === "numbers")) return false;
  const { urls, unreadUrls, numbers } = value;
  // Optional citation numbers, one per supplied link, each 1 to 999 and none repeated.
  if (numbers !== undefined && (!Array.isArray(numbers) || !Array.isArray(urls) || numbers.length !== urls.length || !numbers.every((number) => Number.isInteger(number) && number >= 1 && number <= 999) || new Set(numbers).size !== numbers.length)) return false;
  const urlKey = (url: string) => canonicalUrl(url) ?? url;
  if (!Array.isArray(urls) || urls.length < 1 || urls.length > 20 || !urls.every((url) => isString(url, 2_000) && /^https?:/i.test(url) && safeExternalUrl(url))) return false;
  const supplied = new Set((urls as string[]).map(urlKey));
  if (supplied.size !== urls.length) return false;
  if (unreadUrls !== undefined && (!Array.isArray(unreadUrls) || !unreadUrls.length || !unreadUrls.every((url) => typeof url === "string" && supplied.has(urlKey(url))) || new Set((unreadUrls as string[]).map(urlKey)).size !== unreadUrls.length)) return false;
  const unread = new Set(((unreadUrls as string[] | undefined) ?? []).map(urlKey));
  return pages.length + unread.size <= supplied.size && pages.every((page) => supplied.has(urlKey(page.url)) && !unread.has(urlKey(page.url)));
}

const RECEIPT_STEPS = ["grouping", "judgment", "answer"];
const MAX_RECEIPT_COUNT = 1_000;
const MAX_RECEIPT_TOKENS = 10_000_000;
const MAX_RECEIPT_USD = 100;
const MAX_RECEIPT_MS = 3_600_000;
/** Each dollar figure is rounded to a millionth, so sums can differ from their parts by a few millionths. */
const RECEIPT_USD_TOLERANCE = 1e-4;

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isBoundedNumber(value: unknown, max: number): value is number {
  return isFiniteNonNegative(value) && value <= max;
}

/**
 * A live run's cost receipt as pipeline.ts writes it: version 1, exactly its fields, every figure a finite,
 * non-negative number within sane bounds, at most 10 Claude calls from the three paid steps, and totals that add up.
 */
function isCostReceipt(value: unknown): boolean {
  // A run that searched through Telem also has a telem block, and usd.telem with it (one never without the other).
  const withTelem = isRecord(value) && Object.hasOwn(value, "telem");
  if (!hasExactKeys(value, ["version", "tavily", "claude", "stageMs", "usd", ...(withTelem ? ["telem"] : [])]) || value.version !== 1) return false;
  const { tavily, claude, stageMs, usd, telem } = value;
  if (!hasExactKeys(tavily, ["basicSearches", "advancedSearches", "extractRequests", "extractedUrls", "credits", "usdPerCredit"])
    || !["basicSearches", "advancedSearches", "extractRequests", "extractedUrls", "credits"].every((key) => isBoundedNumber(tavily[key], MAX_RECEIPT_COUNT))
    || !isBoundedNumber(tavily.usdPerCredit, 1)) return false;
  const claudeKeys = ["step", "model", "inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens", "usd"];
  if (!Array.isArray(claude) || claude.length > 10 || !claude.every((entry) =>
    // thinkingTokens is optional: the part of outputTokens that was thinking, so never more than outputTokens.
    (hasExactKeys(entry, claudeKeys) || (hasExactKeys(entry, [...claudeKeys, "thinkingTokens"]) && isFiniteNonNegative(entry.thinkingTokens) && isFiniteNonNegative(entry.outputTokens) && entry.thinkingTokens <= entry.outputTokens))
    && RECEIPT_STEPS.includes(String(entry.step))
    && isString(entry.model, 100) && entry.model.trim() !== ""
    && ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens"].every((key) => isBoundedNumber(entry[key], MAX_RECEIPT_TOKENS))
    && isBoundedNumber(entry.usd, MAX_RECEIPT_USD))) return false;
  const stages = ["search", "extract", "grouping", "judgment", "answer", "total"];
  if (!hasExactKeys(stageMs, stages) || !stages.every((key) => isBoundedNumber(stageMs[key], MAX_RECEIPT_MS))) return false;
  const usdKeys = ["claude", "tavily", ...(withTelem ? ["telem"] : []), "total"];
  if (!hasExactKeys(usd, usdKeys) || !usdKeys.every((key) => isBoundedNumber(usd[key], MAX_RECEIPT_USD))) return false;
  if (withTelem) {
    // Telem: completed searches (the deeper ones among them) and the provider runs that answered them, by provider.
    if (!hasExactKeys(telem, ["searches", "advancedSearches", "providerRuns"])
      || !isBoundedNumber(telem.searches, MAX_RECEIPT_COUNT) || !Number.isInteger(telem.searches) || telem.searches < 1
      || !isBoundedNumber(telem.advancedSearches, telem.searches) || !Number.isInteger(telem.advancedSearches)
      || !isRecord(telem.providerRuns)) return false;
    const runs = Object.entries(telem.providerRuns);
    if (!runs.length || runs.length > 20 || !runs.every(([name, count]) => isProviderName(name) && isBoundedNumber(count, telem.searches as number) && Number.isInteger(count) && count >= 1)) return false;
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= RECEIPT_USD_TOLERANCE;
  const claudeUsd = (claude as Array<{ usd: number }>).reduce((total, entry) => total + entry.usd, 0);
  return near(usd.total as number, (usd.claude as number) + (usd.tavily as number) + (withTelem ? (usd.telem as number) : 0))
    && near(usd.claude as number, claudeUsd)
    && near(usd.tavily as number, (tavily.credits as number) * (tavily.usdPerCredit as number));
}

const providerNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length >= 1 && value.length <= 12 && value.every(isProviderName) && new Set(value).size === value.length;

/**
 * A search audit entry's routing fields (pipeline.ts, Telem searches): router "telem" or absent (Tavily); providers,
 * the provider names that answered the query; pageProviders, for some of the entry's own pageIds, the providers that
 * returned that page. Neither appears without router "telem", and a query that was not searched has no providers.
 */
function isSearchRouting(entry: Record<string, unknown>): boolean {
  if (entry.router === undefined) return entry.providers === undefined && entry.pageProviders === undefined;
  if (entry.router !== "telem") return false;
  if (entry.providers !== undefined && (!providerNames(entry.providers) || entry.status !== "searched")) return false;
  if (entry.pageProviders === undefined) return true;
  const kept = new Set(Array.isArray(entry.pageIds) ? entry.pageIds : []);
  return isRecord(entry.pageProviders)
    && Object.entries(entry.pageProviders).every(([id, names]) => kept.has(id) && providerNames(names));
}

export function makePortableTrace(analysis: EchoAnalysis): PortableTrace {
  return {
    format: PORTABLE_TRACE_FORMAT,
    version: PORTABLE_TRACE_VERSION,
    exportedAt: new Date().toISOString(),
    analysis,
  };
}

export function parsePortableTrace(value: unknown): EchoAnalysis | null {
  if (!isRecord(value) || value.format !== PORTABLE_TRACE_FORMAT || value.version !== PORTABLE_TRACE_VERSION || !isRecord(value.analysis)) return null;
  const analysis = value.analysis;
  const validModes = ["live", "demo"];
  if (!isString(analysis.claim, 500)
    || !analysis.claim.trim()
    || !isString(analysis.createdAt, 100)
    // The UI prints this date ("created on …"); a file whose date does not parse would read "Invalid Date".
    || !Number.isFinite(Date.parse(analysis.createdAt))
    || !validModes.includes(String(analysis.mode))
    || (analysis.demoLabel !== undefined && !isString(analysis.demoLabel, 1_000))
    || (analysis.claimSlot !== undefined && !["ghost", "zombie", "live"].includes(String(analysis.claimSlot)))
    || !Array.isArray(analysis.pages)
    || analysis.pages.length > 200
    || !analysis.pages.every(isPage)
    || !Array.isArray(analysis.clusters)
    || analysis.clusters.length > 100
    || !isStringArray(analysis.roots)
    || !isStringArray(analysis.verifiableRoots)
    || !isStringArray(analysis.answerSourceIds)
    || (analysis.answerStatements !== undefined && (!Array.isArray(analysis.answerStatements) || analysis.answerStatements.length < 1 || analysis.answerStatements.length > 4))
    || (analysis.answerReviews !== undefined && !isRecord(analysis.answerReviews))
    || (analysis.inspectedPageIds !== undefined && !isStringArray(analysis.inspectedPageIds))
    || (analysis.reviewNotesByPageId !== undefined && !isRecord(analysis.reviewNotesByPageId))
    || (analysis.sourceAssessmentsByPageId !== undefined && !isRecord(analysis.sourceAssessmentsByPageId))
    || (analysis.excludedPageCount !== undefined && (!isFiniteNonNegative(analysis.excludedPageCount) || analysis.excludedPageCount > 200))
    || (analysis.answerStatus !== undefined && !["generated", "source-limited", "unavailable"].includes(String(analysis.answerStatus)))
    || (analysis.searchAudit !== undefined && (!Array.isArray(analysis.searchAudit) || analysis.searchAudit.length > 20 || !analysis.searchAudit.every((entry) =>
      isRecord(entry)
      && isString(entry.query, 500)
      && ["basic", "advanced"].includes(String(entry.depth))
      && ["searched", "failed", "not searched"].includes(String(entry.status))
      && isFiniteNonNegative(entry.totalResults)
      && isFiniteNonNegative(entry.matchingResults)
      && isFiniteNonNegative(entry.uniquePagesAdded)
      && (entry.pageIds === undefined || isStringArray(entry.pageIds, 30))
      && (entry.reason === undefined || isString(entry.reason, 1_000))
      && isSearchRouting(entry)
    )))
    || !isString(analysis.answer)
    || !isString(analysis.echoContribution)
    || !isRecord(analysis.summary)) return null;

  const pageIds = new Set(analysis.pages.map((page) => page.id));
  if (pageIds.size !== analysis.pages.length) return null;
  if (Array.isArray(analysis.inspectedPageIds) && (new Set(analysis.inspectedPageIds).size !== analysis.inspectedPageIds.length || !analysis.inspectedPageIds.every((id) => pageIds.has(id)))) return null;
  if (isRecord(analysis.reviewNotesByPageId) && (Object.keys(analysis.reviewNotesByPageId).length > pageIds.size || Object.entries(analysis.reviewNotesByPageId).some(([id, note]) => !pageIds.has(id) || !isString(note, 600) || !note.trim()))) return null;
  if (isRecord(analysis.sourceAssessmentsByPageId) && (Object.keys(analysis.sourceAssessmentsByPageId).length > pageIds.size || Object.entries(analysis.sourceAssessmentsByPageId).some(([id, status]) => !pageIds.has(id) || !["supported", "challenged", "unclear"].includes(String(status))))) return null;
  // The search audit adds up as the pipeline writes it: pages kept <= unique pages added <= matching results <=
  // results returned, whole numbers; each kept page is a trace page added by one query only; a failed or skipped
  // query returned nothing. A file that breaks this is refused, never repaired.
  const auditedPageIds = new Set<string>();
  if (Array.isArray(analysis.searchAudit) && !analysis.searchAudit.every((entry) => {
    if (!isRecord(entry)) return false;
    const kept = entry.pageIds === undefined ? [] : entry.pageIds;
    const counts = [entry.totalResults, entry.matchingResults, entry.uniquePagesAdded];
    if (!Array.isArray(kept) || !counts.every((count) => Number.isInteger(count))) return false;
    const [returned, matching, added] = counts as number[];
    if (kept.length > added || added > matching || matching > returned || (entry.status !== "searched" && returned !== 0)) return false;
    return kept.every((id) => typeof id === "string" && pageIds.has(id) && !auditedPageIds.has(id) && Boolean(auditedPageIds.add(id)));
  })) return null;
  for (const page of analysis.pages as EchoPage[]) {
    if (!safeExternalUrl(page.url) || (page.favicon && !safeExternalUrl(page.favicon))) return null;
    if (page.judgment.parentId && !pageIds.has(page.judgment.parentId)) return null;
    if (page.citations?.some((citation) => citation.pageId === page.id || !pageIds.has(citation.pageId))) return null;
    if (page.linkedPageIds && (new Set(page.linkedPageIds).size !== page.linkedPageIds.length || page.linkedPageIds.some((id) => id === page.id || !pageIds.has(id)))) return null;
    if (page.primaryEvidenceStatus === "found" && !page.hasPrimaryEvidence) return null;
    if (page.primaryEvidenceStatus && page.primaryEvidenceStatus !== "found" && page.hasPrimaryEvidence) return null;
  }
  const clusterIds = new Set<string>();
  const clusteredPageIds = new Set<string>();
  const clusterByPageId = new Map<string, string>();
  for (const cluster of analysis.clusters) {
    if (!isRecord(cluster)
      || !isString(cluster.id, 300)
      || clusterIds.has(cluster.id)
      || !isString(cluster.label, 1_000)
      || !isStringArray(cluster.pageIds)
      || !cluster.pageIds.every((id) => pageIds.has(id))) return null;
    clusterIds.add(cluster.id);
    for (const id of cluster.pageIds as string[]) {
      if (clusteredPageIds.has(id)) return null;
      clusteredPageIds.add(id);
      clusterByPageId.set(id, cluster.id);
    }
  }
  if (clusteredPageIds.size !== pageIds.size) return null;
  const pageById = new Map((analysis.pages as EchoPage[]).map((page) => [page.id, page] as const));
  for (const page of analysis.pages as EchoPage[]) {
    const parentId = page.judgment.parentId;
    if (page.judgment.kind === "origin" && parentId !== null) return null;
    if (page.judgment.kind === "derived" && !parentId) return null;
    if (!parentId) continue;
    if (parentId === page.id || clusterByPageId.get(parentId) !== clusterByPageId.get(page.id)) return null;
    if (analysis.mode === "live" && page.judgment.kind === "derived") {
      const parent = pageById.get(parentId);
      const parentDate = comparableDate(parent?.publishedDate ?? null);
      const childDate = comparableDate(page.publishedDate);
      // Mirrors the pipeline (safeJudgment, linkCitedUndatedPages, indexRecordsAsCopies): when exactly one side has a
      // trustworthy date, an explicit citation from the child to the parent sets the direction, since a page cannot
      // cite something published after it; and an index record (PubMed, say) of an article is a copy of it.
      const reliable = (candidate: EchoPage | undefined) => comparableDate(candidate?.publishedDate ?? null) !== null && TRUSTED_DATE_SOURCES.has(candidate?.publishedDateSource ?? "");
      const citedParent = Boolean(page.citations?.some((citation) => citation.pageId === parentId && citation.how !== "named as source"))
        && reliable(parent) !== reliable(page);
      const indexCopy = Boolean(parent) && INDEX_RECORD_HOSTS.test(page.domain) && !INDEX_RECORD_HOSTS.test(parent!.domain)
        && coreTitle(page.title).split(" ").length >= 5 && coreTitle(page.title) === coreTitle(parent!.title);
      if (!citedParent && !indexCopy && (parentDate === null || childDate === null || parentDate >= childDate)) return null;
    }
  }
  if (![...analysis.roots, ...analysis.verifiableRoots, ...analysis.answerSourceIds].every((id) => pageIds.has(id))) return null;
  const roots = analysis.roots as string[];
  const verifiableRoots = analysis.verifiableRoots as string[];
  const answerSourceIds = analysis.answerSourceIds as string[];
  if (new Set(roots).size !== roots.length
    || new Set(verifiableRoots).size !== verifiableRoots.length
    || new Set(answerSourceIds).size !== answerSourceIds.length) return null;
  const actualRoots = new Set((analysis.pages as EchoPage[]).filter((page) => page.judgment.kind === "origin").map((page) => page.id));
  if (roots.length !== actualRoots.size || !roots.every((id) => actualRoots.has(id))) return null;
  const actualVerifiableRoots = new Set((analysis.pages as EchoPage[]).filter((page) => actualRoots.has(page.id) && page.primaryEvidenceStatus === "found").map((page) => page.id));
  if (verifiableRoots.length !== actualVerifiableRoots.size || !verifiableRoots.every((id) => actualVerifiableRoots.has(id))) return null;
  if (!answerSourceIds.every((id) => actualRoots.has(id))) return null;
  const citationNumbers = [...(analysis.answer as string).matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  if (citationNumbers.some((number) => number < 1 || number > answerSourceIds.length)) return null;
  if (Array.isArray(analysis.answerStatements)) {
    if (analysis.answerStatus !== "generated") return null;
    const statements = analysis.answerStatements;
    if (!statements.every((statement) => isRecord(statement)
      && isString(statement.text, 700) && statement.text.trim() && !/\[\d+\]/.test(statement.text)
      && isStringArray(statement.sourceIds, 12) && statement.sourceIds.length > 0
      && new Set(statement.sourceIds).size === statement.sourceIds.length
      && statement.sourceIds.every((id) => answerSourceIds.includes(id)))) return null;
    const rebuilt = statements.map((statement) => {
      const entry = statement as { text: string; sourceIds: string[] };
      return `${entry.text} ${entry.sourceIds.map((id) => `[${answerSourceIds.indexOf(id) + 1}]`).join(" ")}.`;
    }).join(" ");
    if (rebuilt !== analysis.answer) return null;
  }
  if (isRecord(analysis.answerReviews)) {
    if (!Array.isArray(analysis.answerStatements) || Object.keys(analysis.answerReviews).length > analysis.answerStatements.length) return null;
    if (Object.entries(analysis.answerReviews).some(([index, review]) => !/^(0|[1-9]\d*)$/.test(index)
      || Number(index) >= (analysis.answerStatements as unknown[]).length
      || !isRecord(review)
      || (review.status !== null && !["supported", "unsupported", "unclear"].includes(String(review.status)))
      || !isString(review.note, 600))) return null;
  }
  let rootGroups: string[][] = [];
  if (analysis.coPublishedRootGroups !== undefined) {
    const groups = analysis.coPublishedRootGroups;
    const rootSet = new Set(roots);
    const seen = new Set<string>();
    if (!Array.isArray(groups) || groups.length > 100 || groups.some((group) => !Array.isArray(group) || group.length < 2
      || group.some((id) => typeof id !== "string" || !rootSet.has(id) || seen.has(id) || !seen.add(id)))) return null;
    rootGroups = groups as string[][];
  }
  const expectedOrigins = originCounts(roots, verifiableRoots, rootGroups);
  const summary = analysis.summary;
  const actualEchoPercentage = analysis.pages.length ? Math.round(((analysis.pages as EchoPage[]).filter((page) => page.judgment.kind === "derived").length / analysis.pages.length) * 100) : 0;
  if (!isFiniteNonNegative(summary.totalPages)
    || !isFiniteNonNegative(summary.independentOrigins)
    || !isFiniteNonNegative(summary.verifiableOrigins)
    || !isFiniteNonNegative(summary.echoPercentage)
    || summary.totalPages !== analysis.pages.length
    || summary.independentOrigins !== expectedOrigins.independent
    || summary.verifiableOrigins !== expectedOrigins.verifiable
    || summary.echoPercentage !== actualEchoPercentage
    || summary.independentOrigins > summary.totalPages
    || summary.verifiableOrigins > summary.independentOrigins
    || summary.echoPercentage > 100) return null;

  if (analysis.costReceipt !== undefined && !isCostReceipt(analysis.costReceipt)) return null;
  // Telem's daily cap sent a search run to Tavily: only that value, and never on a Check these sources run.
  if (analysis.searchFallback !== undefined && (analysis.searchFallback !== "telem-daily-cap" || analysis.sourceCheck !== undefined)) return null;
  // A Deep search run: only that value, and never on a Check these sources run (it searches nothing).
  if (analysis.searchMode !== undefined && (analysis.searchMode !== "deep" || analysis.sourceCheck !== undefined)) return null;
  if (analysis.copyHunt !== undefined && !isCopyHunt(analysis.copyHunt, pageIds, roots, analysis.pages as EchoPage[])) return null;
  if (analysis.sourceCheck !== undefined && !isSourceCheck(analysis.sourceCheck, analysis.pages as EchoPage[], analysis.searchAudit)) return null;

  let savedAnalysis: EchoAnalysis;
  // Unchecked fields can be nested deep enough to overflow the stack while copying; such a file is refused.
  try { savedAnalysis = structuredClone(analysis) as unknown as EchoAnalysis; } catch { return null; }
  savedAnalysis.searchAudit?.forEach((entry) => { entry.pageIds ??= []; });
  return savedAnalysis;
}
