export type JudgmentKind = "origin" | "derived" | "unclear";

export interface PageJudgment {
  kind: JudgmentKind;
  parentId: string | null;
  confidence: number;
  evidence: string;
}

export interface PageCitation {
  pageId: string;
  /** "named as source": credited by name without a year; only recorded for pages dated after the target, and never used to set direction for an undated page. */
  how: "link" | "title" | "name and year" | "named as source";
  quote: string;
}

export interface EchoPage {
  id: string;
  title: string;
  url: string;
  domain: string;
  publishedDate: string | null;
  publishedDateSource?: "Tavily estimate" | "URL date" | "page text" | "page metadata";
  publishedDateEvidence?: string;
  extractionSource?: "Tavily extraction" | "Page HTML" | "Search snippet" | "Rehearsal fixture";
  text: string;
  linkedPageIds?: string[];
  /** Pages in this trace that this page explicitly cites, found in its full extracted text. */
  citations?: PageCitation[];
  favicon?: string;
  hasPrimaryEvidence: boolean;
  primaryEvidenceStatus?: "found" | "not found" | "unclear";
  primaryEvidenceReason?: string;
  judgment: PageJudgment;
}

export interface EchoCluster {
  id: string;
  label: string;
  pageIds: string[];
}

export interface SearchQueryAudit {
  query: string;
  depth: "basic" | "advanced";
  status: "searched" | "failed" | "not searched";
  totalResults: number;
  matchingResults: number;
  uniquePagesAdded: number;
  pageIds?: string[];
  reason?: string;
  /** The search router that ran this query: "telem" (Telem's auto-routing). Absent: Tavily, as every older trace. */
  router?: "telem";
  /** Telem only: the providers whose runs answered this query, in Telem's routing order (failed runs are left out). */
  providers?: string[];
  /** Telem only: for each page in pageIds, the providers that returned it for this query. */
  pageProviders?: Record<string, string[]>;
}

export interface AnswerStatement {
  text: string;
  sourceIds: string[];
}

export interface AnswerReview {
  status: "supported" | "unsupported" | "unclear" | null;
  note: string;
}

export type SourceAssessment = "supported" | "challenged" | "unclear";

export type CopyTiming = "after root" | "same day" | "before root" | "date unknown";

export interface CopyCandidate {
  url: string;
  title: string;
  domain: string;
  publishedDate: string | null;
  publishedDateSource?: "Tavily estimate" | "URL date" | "page text" | "page metadata";
  /** Fingerprint phrases found verbatim in the search result's title or snippet. */
  matchedPhrases: string[];
  /** Where the phrase was found: the search engine's snippet, or the page itself (free direct fetch). */
  foundIn?: "search snippet" | "full page";
  snippet: string;
  timing: CopyTiming;
}

export interface CopyHuntQuery {
  phrase: string;
  status: "searched" | "failed";
  results: number;
  newMatches: number;
}

export interface CopyHunt {
  rootId: string;
  /** Distinctive wording the root shares with its confirmed copies, searched as exact phrases. */
  phrases: string[];
  searchedAt: string;
  queries: CopyHuntQuery[];
  candidates: CopyCandidate[];
  /** New search results Echo opened directly to look for the phrases. */
  pagesChecked?: number;
  /** Searched phrases also found on pages dated before the original: ordinary wording, so not counted as evidence. */
  commonPhrases?: string[];
}

export interface EchoAnalysis {
  claim: string;
  createdAt: string;
  mode: "live" | "demo";
  demoLabel?: string;
  claimSlot?: "ghost" | "zombie" | "live";
  cacheHit?: boolean;
  importedAt?: string;
  pages: EchoPage[];
  clusters: EchoCluster[];
  roots: string[];
  verifiableRoots: string[];
  /** Roots that are the same text published within a few days (counted as one origin). */
  coPublishedRootGroups?: string[][];
  answerSourceIds: string[];
  answerStatements?: AnswerStatement[];
  answerReviews?: Record<string, AnswerReview>;
  inspectedPageIds?: string[];
  reviewNotesByPageId?: Record<string, string>;
  sourceAssessmentsByPageId?: Record<string, SourceAssessment>;
  answerStatus?: "generated" | "source-limited" | "unavailable";
  searchAudit?: SearchQueryAudit[];
  excludedPageCount?: number;
  /** Optional follow-up search for copies outside this trace. Never changes pages, roots or summary. */
  copyHunt?: CopyHunt;
  /**
   * Present only on a "Check these sources" run: Echo skipped search and read exactly these links (canonical form,
   * in the order supplied). unreadUrls are supplied links whose text could not be read, so they are not trace pages.
   * Absent on search runs, so every older trace stays valid.
   */
  sourceCheck?: SourceCheck;
  /** What this live run spent, recorded as it ran. Absent on traces made before 2026-11-13 and on demo traces. */
  costReceipt?: CostReceipt;
  /**
   * "telem-daily-cap": Telem was this server's search router, but its own daily cap was reached, so the run's searches
   * (or the rest of them) went through Tavily. Absent on every other run and on every older trace.
   */
  searchFallback?: "telem-daily-cap";
  /**
   * "deep": the run was a Deep search (search-mode.ts: up to 16 searches of 20 results, up to 50 pages read, judged in
   * batches). Absent on a Standard run and on every older trace.
   */
  searchMode?: "deep";
  summary: {
    totalPages: number;
    independentOrigins: number;
    verifiableOrigins: number;
    echoPercentage: number;
  };
  answer: string;
  echoContribution: string;
}

/** A supplied-sources run: the links a person gave Echo instead of a search (at most 20). */
export interface SourceCheck {
  urls: string[];
  unreadUrls?: string[];
  /**
   * The pasted answer's own citation number for each link ("[2] https://…"), parallel to urls. Absent when the links
   * are simply numbered 1..N in order (every trace made before 2026-11-14), which is how they are then shown.
   */
  numbers?: number[];
}

/** Measured spend of one live run (pipeline.ts). Dollar figures are list-price estimates from the counts, not an invoice. */
export interface CostReceipt {
  version: 1;
  /** Tavily requests that completed, and the credits each response reported (published rates when one did not say). */
  tavily: { basicSearches: number; advancedSearches: number; extractRequests: number; extractedUrls: number; credits: number; usdPerCredit: number };
  /** One entry per paid Claude request that returned usage, in call order (a 429/529 retry that was rejected is not billed). */
  /** thinkingTokens, when the API reported it: how many of outputTokens were thinking (already billed as output). */
  claude: Array<{ step: "grouping" | "judgment" | "answer"; model: string; inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; usd: number; thinkingTokens?: number }>;
  /** Wall-clock milliseconds per stage; extract includes the direct page reads for dates and links. */
  stageMs: { search: number; extract: number; grouping: number; judgment: number; answer: number; total: number };
  /**
   * Searches sent through Telem (the search router; telem.ts), when the run searched that way: completed searches,
   * how many were the deeper pass, and how many provider runs answered them (each billed at that provider's price).
   * Absent on Tavily runs and on every older trace. Page reading stays on the tavily line.
   */
  telem?: { searches: number; advancedSearches: number; providerRuns: Record<string, number> };
  /** usd.telem (with a telem block only): the Telem searches at list price; total = claude + tavily + telem. */
  usd: { claude: number; tavily: number; total: number; telem?: number };
}

export interface PipelineProgress {
  stage: "queries" | "search" | "extract" | "cluster" | "judge" | "answer";
  label: string;
  detail: string;
  current?: number;
  total?: number;
  /** Search and extract steps: the domains of the pages found so far (never page text), shown while a live run waits. */
  domains?: string[];
  /**
   * The "queries" step: every search variant planned for the basic search, built from the claim alone before any
   * search (never page text), each one line of at most 120 characters. Absent on a Check these sources run.
   */
  queries?: string[];
  /** Basic search steps: how many of the planned variants have finished (searched, failed or reused), in plan order. */
  queriesDone?: number;
  /**
   * Basic search steps of a Telem run: for each finished variant, by its place in the plan, the providers Telem routed
   * it to and that answered (provider names only). Absent on Tavily runs.
   */
  queryProviders?: Record<number, string[]>;
  /** Telem's daily cap was reached, so this run's searches (from this event on) go through Tavily. */
  searchFallback?: "telem-daily-cap";
}

export type ProgressCallback = (progress: PipelineProgress) => void;
