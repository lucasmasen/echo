"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type FormEvent, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { cloneDemoAnalysis } from "@/lib/echo/demo-data";
import { changedSearchCoverage, changedSourceRelationships, compareAnswerEvidence, compareAnswerReviews, compareSourceReviews, comparisonPageKey } from "@/lib/echo/compare";
import { coPublishedLeadOrder, groupDownstreamEchoes, hasReliableDate, summarizeTraceSignals } from "@/lib/echo/graph";
import { answerNumberGrounding } from "@/lib/echo/grounding";
import { unreadableAddressReason } from "@/lib/echo/public-address";
import { DEMO_SCORES } from "@/lib/echo/demo-scores";
import { makePortableTrace, MAX_PORTABLE_TRACE_BYTES, parsePortableTrace } from "@/lib/echo/portable";
import { edgeSentence, findSharedPhrases, searchClaimText, visibleEdgeSignals } from "@/lib/echo/wording";
import { BACKUP_POOL, LIVE_SLOT, PRESETS, SAVED_SOURCE_CHECK, traceSlug } from "./demo-slots";
import { scoreSentence } from "./explore/cards";
import { clockMs, costReceiptLine, datedSpanOf, pageBreakdownLine, plainSearchDetail, plainSearchHeadline, plainSearchLineage, plainSearchTooltip, reliablyDatedPages, verdictHeadline, withOwnEvidence } from "./trace-view";
import EchoSpread from "./echo-spread";
import OriginLayerPanel, { OriginLayerToggle } from "./origin-layer-panel";
import { howEchoChecked, routedByTelem, stageTimeLabel } from "./trace-view";
import { evidenceFunnel, evidenceFunnelHeadline, funnelNumber, pageDetails, runDetails, type DetailRow, type FunnelStage } from "./trace-view";
import { providerList, providerTags } from "../lib/echo/search-providers";
import { budgetLine, type DailyBudgetStatus } from "@/lib/echo/budget-line";
import { deepSearchTooltip, type SearchMode } from "@/lib/echo/search-mode";
import { draftUrls, EMPTY_SOURCE_DRAFT, PrintSourceLinks, SourceCheckOpenButton, SourceCheckPanel, SourceCheckSummary, StageSourcesClaim, unreadableDraftLinks, type SourceDraft } from "./source-check";
import { EMBED_RUN_BUTTON, EmbedClaim, EmbedClaimForm, EmbedError, EmbedResult, EmbedShell, EmbedStartNote } from "./embed-view";
import { useEmbedStart, useOpenerHandoff } from "./embed-bridge";
import { answerCitationNumbers, displayedAnswer, numbersFromParam, pageKey, sharedSourceText, sourceCheckHeadline, sourceCheckNoSearchLine, sourceCheckReportLines, sourceShareParams, suppliedNumbersByPageId, urlsFromParam, withCitationNumbers } from "@/lib/echo/supplied-urls";
import type { CopyCandidate, CopyHunt, CostReceipt, EchoAnalysis, EchoPage, PipelineProgress, SearchQueryAudit, SourceAssessment } from "@/lib/echo/types";

// Claims that have a saved, scored live run bundled with the app. A failed or stalled live run of one of these
// can switch to the saved run in one click, so the stage never ends on an error.
// "Is it true that goldfish have a 3-second memory?" matches the goldfish run too.
function savedRunFor(claim: string) {
  const keys = new Set([cacheKey(claim), cacheKey(searchClaimText(claim))]);
  const preset = PRESETS.find((entry) => entry.capturedTrace && keys.has(cacheKey(entry.claim)));
  if (preset) return { kind: "preset" as const, id: preset.id, claim: preset.claim };
  const backup = BACKUP_POOL.find((entry) => entry.capturedTrace && keys.has(cacheKey(entry.claim)));
  return backup ? { kind: "backup" as const, id: backup.claim, claim: backup.claim } : null;
}

// A Check these sources run of the saved check's links and sentence: the same pages in any order or numbering (as
// pageKey reads them: http/www and tracking parameters aside), and the sentence as savedRunFor reads a claim. A failed
// or stalled run of it can switch to the bundled saved run of those links in one click, as a search run can.
const SAVED_SOURCE_CHECK_SLUG = traceSlug(SAVED_SOURCE_CHECK.savedTrace);
const SAVED_CHECK_TITLE = "Open the saved live run of the example's 5 links (Check these sources, captured Nov 13, 2026). Runs nothing and spends nothing.";
function matchesSavedSourceCheck(run: { claim: string; urls: string[] } | null | undefined): boolean {
  if (!run?.urls.length) return false;
  if (!new Set([cacheKey(run.claim), cacheKey(searchClaimText(run.claim))]).has(cacheKey(SAVED_SOURCE_CHECK.claim))) return false;
  const pages = (urls: string[]) => [...new Set(urls.map(pageKey))].sort().join("\n");
  return pages(run.urls) === pages(SAVED_SOURCE_CHECK.urls);
}

// Failures that a second attempt can fix (a busy or rate-limited provider: Claude, Tavily or Telem; a garbled reply).
// Missing keys, the daily cap, an auth error, Telem's spent credit or an offline browser are not offered "Try again":
// the same click would fail the same way.
const RETRYABLE_ERRORS = new Set(["CLAUDE_OVERLOADED", "CLAUDE_RATE_LIMIT", "CLAUDE_ERROR", "CLAUDE_TOKEN_COUNT", "CLAUDE_FORMAT", "CLAUDE_EMPTY", "CLAUDE_INCOMPLETE", "CLAUDE_CITATIONS", "TAVILY_ERROR", "TAVILY_RATE_LIMIT", "TELEM_ERROR", "TELEM_RATE_LIMIT", "NO_EXTRACTS", "ANALYSIS_FAILED", "TIMEOUT"]);

/**
 * Keeps the address bar shareable: "?slot=02" while a demo slot is open, "?claim=…" after a live run, nothing on a
 * blank screen. A shared link never starts a paid run: ?slot opens a bundled trace, ?claim only fills the box.
 */
function setShareParams(params: Record<string, string> | null) {
  try {
    const url = new URL(window.location.href);
    url.search = "";
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // An address bar that cannot be updated only loses the shareable link.
  }
}

/**
 * The link for a shown result: a demo slot's claim opens by ?slot=, any other claim only fills the box (?claim=).
 * `bundled`: the result is a run bundled with Echo (opened from its button, not a file), so the saved Check these
 * sources run gets its own ?trace= link.
 */
function shareParamsFor(result: EchoAnalysis, bundled = false): Record<string, string> {
  // A supplied-sources run ("Check these sources"): the link fills that panel with its claim and links, nothing more.
  // The answer's own citation numbers ride along as ?nums= when they are not 1..N, so [2]–[6] reopen as [2]–[6].
  if (result.sourceCheck) {
    return bundled && matchesSavedSourceCheck({ claim: result.claim, urls: result.sourceCheck.urls }) ? { trace: SAVED_SOURCE_CHECK_SLUG } : sourceShareParams(result.claim, result.sourceCheck);
  }
  const preset = PRESETS.find((entry) => entry.capturedTrace && cacheKey(entry.claim) === cacheKey(result.claim));
  if (preset) return { slot: preset.slot };
  const backup = BACKUP_POOL.find((entry) => entry.capturedTrace && cacheKey(entry.claim) === cacheKey(result.claim));
  return backup?.capturedTrace ? { trace: traceSlug(backup.capturedTrace) } : { claim: result.claim };
}

/** The bundled backup run a ?trace= link names, by its file name; null for anything else. */
/** A ?trace= link may also name a demo slot's run by its file name; returns that slot's shortcut key. */
function sharedTraceSlotKey(value: string | null): string | null {
  const wanted = value?.trim().toLowerCase();
  const preset = wanted ? PRESETS.find((entry) => entry.capturedTrace && traceSlug(entry.capturedTrace) === wanted) : undefined;
  return preset ? String(Number(preset.slot)) : null;
}

// The server's own rule (claimHasWords in pipeline.ts): at least three letters or digits, one of them a letter.
// Checked here too, so "........" gets the plain message at once, with no request sent.
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function claimHasWords(claim: string): boolean {
  return (claim.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3 && /\p{L}/u.test(claim);
}

/** True for a ?trace= link naming the saved Check these sources run. */
function sharedSavedSourceCheck(value: string | null): boolean {
  return value?.trim().toLowerCase() === SAVED_SOURCE_CHECK_SLUG;
}

function sharedBackupClaim(value: string | null): string | null {
  const wanted = value?.trim().toLowerCase();
  return (wanted && BACKUP_POOL.find((entry) => entry.capturedTrace && traceSlug(entry.capturedTrace) === wanted)?.claim) || null;
}

/** The demo slot a shared link names: "02", "2" or "phones". */
function sharedSlotKey(value: string | null): string | null {
  const wanted = value?.trim().toLowerCase();
  if (!wanted) return null;
  const preset = PRESETS.find((entry) => entry.capturedTrace && (entry.id === wanted || (/^\d{1,2}$/.test(wanted) && Number(entry.slot) === Number(wanted))));
  return preset ? String(Number(preset.slot)) : null;
}


// A live stage with no progress event for this long is treated as stalled, so the presenter is offered the saved run.
const STALL_MS = 40_000;
const PINNED_CACHE_CLAIMS = [...PRESETS.map((preset) => preset.claim), ...BACKUP_POOL.map((preset) => preset.claim)];
const RECENT_TRACE_KEY = "echo-recent-traces:v8";
const MAX_RECENT_TRACES = 5;
// Every bundled saved run the offline readiness panel lists, keyed by its trace file (the saved check shares slot 02's
// claim). `claim` is set where a live run kept in this browser can stand in for the file; the saved check has none,
// since the browser never keeps a Check these sources result as a saved run.
const CACHED_SAVED_RUNS: Array<{ label: string; trace: string; claim: string | null }> = [
  ...[...PRESETS, ...BACKUP_POOL].flatMap(({ label, claim, capturedTrace }) => (capturedTrace ? [{ label, trace: capturedTrace, claim }] : [])),
  { label: SAVED_SOURCE_CHECK.label, trace: SAVED_SOURCE_CHECK.savedTrace, claim: null },
];
const subscribeToClient = () => () => undefined;
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;
const GLOSSARY = [
  ["Independent origin", "A source Echo judges independent of the other pages found. Pages published together (a press release and its wire copy) count as one origin. It is a best-supported starting point, not proof that it was the first source ever."],
  ["Root page", "A page at the top of the source tree, with no earlier page it repeats. Root pages are counted as pages; several root pages published together make one independent origin."],
  ["With own evidence", "An independent origin whose retrieved passage shows data, a study, or reporting of its own for the claim, rather than repeating the figure from elsewhere."],
  ["Echo", "A page that repeats an earlier page's claim without adding new facts."],
  // Its example figures are read from the bundled phones run when the glossary opens (GlossaryExample), never typed.
  ["Echo rate", "The share of pages judged to be confirmed echoes."],
  ["Derived edge", "An arrow from a likely source to a later copy. A dashed arrow means the link is uncertain."],
  ["Cluster", "A group of pages making the same or a closely related claim."],
  ["Fan-out", "Expanding one claim into about ten search versions so differently worded pages can be found."],
  ["Search query audit", "A record of which search phrases ran, how many pages they matched, and which new pages they found."],
  ["Shared wording", "A sequence of five or more matching words in two retrieved passages. It is a clue to inspect, not proof of copying."],
  ["Ghost stat", "A statistic that is repeated widely, but no independent origin shows evidence of its own."],
  ["Zombie stat", "A figure that keeps circulating after it was debunked or replaced, even by its own source."],
  ["Verdict banner", "The summary above the tree."],
  ["Preset chip", "A one-tap button that loads a prepared demo claim into Echo."],
  ["Cache", "Saved live results in this browser. Reopening one avoids another search; a fresh run still needs internet."],
  ["Trace coverage", "What Echo retrieved for this run: dated pages, extracted passages, source domains, unresolved links, and root evidence."],
  ["Pages to inspect", "A review list for pages with missing text or dates, uncertain links, or incomplete root evidence. Its flags are not another verdict."],
  ["Compare runs", "Load another saved trace for the same claim to see which page URLs, root pages and origin counts changed between searches."],
  ["Snippet-only page", "A search result where Echo could not retrieve an extracted passage; its source relationship may remain unclear."],
  ["Tree focus", "A view that highlights root pages, echoes, or unclear pages while leaving the rest of the family tree visible for context."],
  ["Source finder", "Search titles, domains, and retrieved passages in the family tree. Matching pages brighten while others stay visible for context."],
  ["Source path", "The chain of likely parent pages connecting a selected page back to its best-supported root page."],
  ["Downstream spread", "Pages below a selected source through links Echo judged as derived. Unclear links are excluded, and a missing page is not counted."],
  ["Root evidence ledger", "A compact list of root pages with their dates, whether each shows evidence of its own, and downstream pages in this trace."],
  ["Inspected page", "A page manually marked after its source was reviewed. The mark can travel with a saved trace and does not change Echo's judgment."],
];

// The glossary's worked examples, from the bundled phones run (slot 02) once it has loaded; nothing before that.
const GLOSSARY_EXAMPLE_TRACE = PRESETS.find((preset) => preset.id === "phones")?.capturedTrace;
function GlossaryExample({ term, example }: { term: string; example: EchoAnalysis | null }) {
  if (!example) return null;
  if (term === "Echo rate") {
    const echoes = example.pages.filter((page) => page.judgment.kind === "derived").length;
    return <> In the saved phones run (“{example.claim}”), {echoes} of its {example.summary.totalPages} pages are echoes: {example.summary.echoPercentage}%.</>;
  }
  if (term === "Verdict banner") return <> The saved phones run&apos;s banner reads “{verdictHeadline(example)}”.</>;
  return null;
}

// costReceipt: what a failed live run spent before it stopped (the route adds it when the pipeline knew); optional, as
// older servers and errors before any paid call send none.
type StreamError = { code?: string; message?: string; costReceipt?: CostReceipt };
class EchoClientError extends Error {
  code?: string;
  costReceipt?: CostReceipt;

  constructor(message: string, code?: string, costReceipt?: CostReceipt) {
    super(message);
    this.name = "EchoClientError";
    this.code = code;
    this.costReceipt = costReceipt;
  }
}
type ProviderConfiguration = {
  anthropicConfigured: boolean;
  tavilyConfigured: boolean;
  /** The search step's router, a name only (never a key): "misconfigured" when Telem is chosen but its key is missing or malformed. */
  searchRouter?: "telem" | "tavily" | "misconfigured";
  /** A presenter-locked deployment refuses this browser's live runs (403 PRESENTER_ONLY). */
  liveRunsLocked?: boolean;
  dailyBudget?: DailyBudgetStatus;
};
type NodePosition = { x: number; y: number };
type ClusterBand = { label: string; top: number };

/** "This run spent ≈$0.04 before it stopped (list-price estimate)", or null without a usable receipt. */
function failedRunSpend(receipt: CostReceipt | undefined): string | null {
  const total = receipt?.usd?.total;
  // A run stopped before anything was billed (a refused key, every search failed) names no spend at all.
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  return `This run spent ${total < 0.01 ? "under $0.01" : `≈$${total.toFixed(2)}`} before it stopped (list-price estimate)`;
}

/**
 * Scrolls the element matching selector into view once, after it renders, unless it is already fully on screen (at
 * 1920×1080 a live run's progress card already is, so the page stays put). It never scrolls again, so a presenter
 * who scrolls away during a run is left where they are.
 */
function revealOnce(selector: string, block: ScrollLogicalPosition) {
  let frames = 0;
  const step = () => {
    const node = document.querySelector<HTMLElement>(selector);
    if (!node) {
      if ((frames += 1) < 10) window.requestAnimationFrame(step);
      return;
    }
    const box = node.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= window.innerHeight) return;
    node.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block });
  };
  window.requestAnimationFrame(step);
}

/**
 * A live run's progress card: brought into view when it appears, scrolling only as far as its bottom (so the claim box
 * above stays on screen when both fit, and no empty screen is left below it), then kept in view as it grows (the sites
 * found so far, the stall note). A card taller than the screen shows its top instead. It stops for good once the
 * presenter scrolls (wheel, touch, scroll keys, the scrollbar), so it never fights them. At 1920×1080 the card already
 * shows, so the page stays put until the card grows past the bottom of the screen. Returns the cleanup.
 */
function followIntoView(selector: string): () => void {
  const margin = 16;
  let stopped = false;
  let frames = 0;
  let observer: ResizeObserver | null = null;
  const place = () => {
    const node = document.querySelector<HTMLElement>(selector);
    if (stopped || !node) return;
    const box = node.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= window.innerHeight) return;
    const delta = box.top < 0 || box.height + 2 * margin > window.innerHeight ? box.top - margin : box.bottom + margin - window.innerHeight;
    if (Math.abs(delta) >= 1) window.scrollBy({ top: delta, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const stop = () => {
    stopped = true;
    observer?.disconnect();
    window.removeEventListener("wheel", stop);
    window.removeEventListener("touchmove", stop);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("mousedown", onPointer);
  };
  const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
  // Keys typed in a field (or a button's Space) do not scroll the page.
  const onKey = (event: KeyboardEvent) => { if (scrollKeys.has(event.key) && (event.target === document.body || event.target === document.documentElement)) stop(); };
  // A press on the page's own scrollbar targets the root element.
  const onPointer = (event: MouseEvent) => { if (event.target === document.documentElement) stop(); };
  window.addEventListener("wheel", stop, { passive: true });
  window.addEventListener("touchmove", stop, { passive: true });
  window.addEventListener("keydown", onKey);
  window.addEventListener("mousedown", onPointer);
  const attach = () => {
    if (stopped) return;
    const node = document.querySelector<HTMLElement>(selector);
    if (!node) {
      if ((frames += 1) < 10) window.requestAnimationFrame(attach);
      return;
    }
    place();
    observer = new ResizeObserver(place);
    observer.observe(node);
  };
  window.requestAnimationFrame(attach);
  return stop;
}

function cacheKey(claim: string) {
  return `echo-analysis:v8:${claim.trim().toLocaleLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "")}`;
}

function isPinnedCacheClaim(claim: string) {
  return PINNED_CACHE_CLAIMS.some((candidate) => cacheKey(candidate) === cacheKey(claim));
}

function readCached(claim: string): EchoAnalysis | null {
  if (!isPinnedCacheClaim(claim)) return null;
  try {
    const raw = localStorage.getItem(cacheKey(claim));
    if (!raw) return null;
    const saved = parsePortableTrace({ format: "echo-trace", version: 1, exportedAt: "", analysis: JSON.parse(raw) as unknown });
    if (!saved || saved.mode !== "live" || saved.sourceCheck || cacheKey(saved.claim) !== cacheKey(claim)) return null;
    return { ...saved, cacheHit: true };
  } catch {
    return null;
  }
}

// The pinned key of a demo claim (the slots and backups) is what a slot falls back to if its bundled trace cannot
// load, and what typing that claim opens, so since the first build it holds only a complete run: every root
// assessed, an answer, and no page left unclear from a search snippet alone. Each of the 12 live runs of the four
// bundled claims recorded by Nov 13 leaves at least one such page, so in practice none is pinned or kept in this
// browser (recent traces skip demo claims too), and the slots open their bundled traces.
function meetsPinnedCacheRule(result: EchoAnalysis) {
  const hasUnassessedRoot = result.pages.some((page) => result.roots.includes(page.id) && page.primaryEvidenceStatus === "unclear");
  const hasUnresolvedSnippet = result.pages.some((page) => page.extractionSource === "Search snippet" && page.judgment.kind === "unclear");
  return result.answerStatus !== "unavailable" && !hasUnassessedRoot && !hasUnresolvedSnippet;
}

/** Whether saveCached or saveRecentTrace would keep this run (browser storage aside). */
function canKeepInBrowser(result: EchoAnalysis) {
  if (result.mode !== "live" || result.sourceCheck) return false;
  return isPinnedCacheClaim(result.claim) ? meetsPinnedCacheRule(result) : true;
}

function saveCached(result: EchoAnalysis) {
  if (result.mode !== "live" || result.sourceCheck || !isPinnedCacheClaim(result.claim) || !meetsPinnedCacheRule(result)) return false;
  try {
    localStorage.setItem(cacheKey(result.claim), JSON.stringify(result));
    return true;
  } catch {
    // Private browsing modes may disable local storage; the analysis still works in memory.
    return false;
  }
}

function readRecentTraces(): EchoAnalysis[] {
  try {
    const raw = localStorage.getItem(RECENT_TRACE_KEY);
    if (!raw) return [];
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.slice(0, MAX_RECENT_TRACES).map((entry) => parsePortableTrace({
      format: "echo-trace", version: 1, exportedAt: "", analysis: entry,
    })).filter((entry): entry is EchoAnalysis => Boolean(entry && entry.mode === "live" && !entry.sourceCheck && !isPinnedCacheClaim(entry.claim)));
  } catch {
    return [];
  }
}

function readRecentTrace(claim: string): EchoAnalysis | null {
  return readRecentTraces().find((entry) => cacheKey(entry.claim) === cacheKey(claim)) ?? null;
}

function saveRecentTrace(result: EchoAnalysis): boolean {
  // Recent traces are found by claim alone, so a supplied-sources run is not kept here (a trace file keeps it).
  if (result.mode !== "live" || result.sourceCheck || isPinnedCacheClaim(result.claim)) return false;
  const recent = [result, ...readRecentTraces().filter((entry) => cacheKey(entry.claim) !== cacheKey(result.claim))];
  for (let limit = MAX_RECENT_TRACES; limit > 0; limit -= 1) {
    try {
      localStorage.setItem(RECENT_TRACE_KEY, JSON.stringify(recent.slice(0, limit)));
      return true;
    } catch {
      // A full browser store can still keep the newest few traces.
    }
  }
  return false;
}

function removeRecentTrace(claim: string): boolean {
  try {
    localStorage.setItem(RECENT_TRACE_KEY, JSON.stringify(readRecentTraces().filter((entry) => cacheKey(entry.claim) !== cacheKey(claim))));
    return true;
  } catch {
    return false;
  }
}

/** A cited source's link label: its domain, plus a short title when another cited source shares that domain
 *  (two "asurion.com" buttons otherwise look identical). Labels only; the citation numbers stay as they are. */
function sourceLinkLabel(page: EchoPage, cited: (EchoPage | undefined)[]) {
  if (cited.filter((other) => other?.domain === page.domain).length < 2) return page.domain;
  const title = page.title.split(/\s[|–—-]\s/)[0].trim();
  if (!title) return page.domain;
  const max = 38;
  if (title.length <= max) return `${page.domain} · ${title}`;
  const space = title.slice(0, max + 1).lastIndexOf(" ");
  return `${page.domain} · ${title.slice(0, space > 12 ? space : max).trimEnd()}…`;
}

function formatDate(date: string | null) {
  if (!date) return "Date unclear";
  if (/^\d{4}$/.test(date)) return date;
  const parsed = new Date(`${date.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? "Date unclear" : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// The tree, the Present slides, the page comparison and the root ledger show a page's date only when it is reliable
// (hasReliableDate, the rule behind "no reliable date" and the spread slide's count), so no slide dates a page the
// spread leaves out. A search engine's guess is labeled "search estimate" instead.
const reliableDate = (page: EchoPage) => (hasReliableDate(page) ? formatDate(page.publishedDate) : null);
const isSearchEstimate = (page: EchoPage) => Boolean(page.publishedDate) && page.publishedDateSource === "Tavily estimate";

/** When a run was made (its createdAt timestamp), on the viewer's own calendar day rather than the UTC one. */
function formatRunDate(timestamp: string) {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? formatDate(timestamp) : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function safeFaviconUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// "Page HTML" is the stored value for text Echo read from the page itself; show it in plain words.
function textSourceLabel(source: EchoPage["extractionSource"]) {
  return source === "Page HTML" ? "Text read from the page" : source;
}

// The tree's row spacing. Present mode uses the compact one (shorter cards, closer rows), so a 720 px projector shows
// a whole story (the root, its copies and the pages that cite it) without scrolling the tree.
// nodeWidth is the widest a card is drawn in that tree (globals.css: .source-node 174 px; Present's .stage-tree-slide
// .source-node 194 px, 174 px on a phone). Columns are 226 px apart, so a Present card leaves only a 32 px gap.
const TREE_GEOMETRY = {
  regular: { firstRow: 58, rowPitch: 112, clusterGap: 80, bandAbove: 34, edgeY: 38, nodeWidth: 174 },
  compact: { firstRow: 36, rowPitch: 86, clusterGap: 58, bandAbove: 28, edgeY: 34, nodeWidth: 194 },
};

function buildLayout(result: EchoAnalysis, compact = false) {
  const geometry = compact ? TREE_GEOMETRY.compact : TREE_GEOMETRY.regular;
  const pageById = new Map<string, EchoPage>(result.pages.map((page) => [page.id, page] as const));
  const positions = new Map<string, NodePosition>();
  const bands: ClusterBand[] = [];
  let yOffset = geometry.firstRow;
  let maxDepth = 0;

  for (const cluster of result.clusters) {
    const pages = cluster.pageIds.map((id) => pageById.get(id)).filter((page): page is EchoPage => Boolean(page));
    if (!pages.length) continue;
    const pageSet = new Set(pages.map((page) => page.id));
    const depthById = new Map<string, number>();
    const visiting = new Set<string>();
    const depthOf = (page: EchoPage): number => {
      const known = depthById.get(page.id);
      if (known !== undefined) return known;
      if (visiting.has(page.id)) return 0;
      visiting.add(page.id);
      const parentId = page.judgment.parentId;
      const parent = parentId && pageSet.has(parentId) ? pageById.get(parentId) : undefined;
      const depth = parent ? depthOf(parent) + 1 : 0;
      visiting.delete(page.id);
      depthById.set(page.id, depth);
      return depth;
    };
    pages.forEach((page) => depthOf(page));
    const byDepth = new Map<number, EchoPage[]>();
    for (const page of pages) {
      const depth = depthById.get(page.id) ?? 0;
      maxDepth = Math.max(maxDepth, depth);
      byDepth.set(depth, [...(byDepth.get(depth) ?? []), page]);
    }
    const rows = Math.max(...[...byDepth.values()].map((items) => items.length));
    bands.push({ label: cluster.label, top: yOffset - geometry.bandAbove });
    // Put the story first: roots, then confirmed echoes, then unresolved pages,
    // oldest first, with each echo kept near its parent's row. Otherwise the
    // first screen of a projector can show unresolved posts instead of roots.
    const kindRank = (page: EchoPage) => (page.judgment.kind === "origin" ? 0 : page.judgment.kind === "derived" ? 1 : 2);
    const dateValue = (page: EchoPage) => (page.publishedDate ? Date.parse(page.publishedDate) || Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER);
    const rowById = new Map<string, number>();
    for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
      const items = [...(byDepth.get(depth) ?? [])].sort((a, b) => {
        const parentRow = (page: EchoPage) => (page.judgment.parentId ? rowById.get(page.judgment.parentId) ?? Number.MAX_SAFE_INTEGER : -1);
        return parentRow(a) - parentRow(b) || kindRank(a) - kindRank(b) || dateValue(a) - dateValue(b) || a.id.localeCompare(b.id);
      });
      items.forEach((page, row) => {
        rowById.set(page.id, row);
        positions.set(page.id, { x: 40 + depth * 226, y: yOffset + row * geometry.rowPitch });
      });
    }
    yOffset += Math.max(1, rows) * geometry.rowPitch + geometry.clusterGap;
  }

  return { positions, bands, width: 40 + (maxDepth + 1) * 226, height: yOffset };
}

/**
 * The page selected when a trace opens: the root drawn highest in the tree (first group, first row), so the detail
 * strip under Present's slide 3 describes a card in view. result.roots[0] can sit rows down: on slot 01 it is
 * MIT McGovern, below the tree's first three rows at 1280×720.
 */
function firstDrawnRoot(result: EchoAnalysis) {
  const { positions } = buildLayout(result, true);
  const drawn = result.roots.filter((id) => positions.has(id));
  drawn.sort((a, b) => (positions.get(a)?.y ?? 0) - (positions.get(b)?.y ?? 0) || (positions.get(a)?.x ?? 0) - (positions.get(b)?.x ?? 0));
  return drawn[0] ?? result.roots[0] ?? result.pages[0]?.id ?? null;
}

/**
 * Roots published together (coPublishedRootGroups) count as one independent origin. The group's lead
 * (coPublishedLeadOrder: own evidence, then cited by the answer, then earliest reliable date, then supplied order)
 * speaks for it and keeps the ORIGIN tag; the others are tagged SAME RELEASE. The supplied-links list and Cite once use
 * the same rule, so every surface names the same page. Maps each grouped root to its group's lead and its partners.
 */
function coPublishedRoles(result: EchoAnalysis): Map<string, { lead: EchoPage; partners: EchoPage[] }> {
  const roles = new Map<string, { lead: EchoPage; partners: EchoPage[] }>();
  const groups = result.coPublishedRootGroups ?? [];
  if (!groups.length) return roles;
  const pageById = new Map(result.pages.map((page) => [page.id, page] as const));
  for (const group of groups) {
    const ordered = coPublishedLeadOrder(result, group).map((id) => pageById.get(id)).filter((page): page is EchoPage => Boolean(page));
    if (ordered.length < 2) continue;
    for (const page of ordered) roles.set(page.id, { lead: ordered[0], partners: ordered.filter((other) => other.id !== page.id) });
  }
  return roles;
}

/** "(including prnewswire.com's, published together)": whose echoes a co-published root's downstream count includes. */
function togetherEchoesNote(partners: EchoPage[]): string {
  const owners = partners.map((page) => `${page.domain}'s`);
  return `(including ${owners.length > 1 ? `${owners.slice(0, -1).join(", ")} and ${owners.at(-1)}` : owners[0]}, published together)`;
}

/** "asurion.com", "asurion.com and prnewswire.com", "a.com, b.com and c.com". */
function domainList(pages: EchoPage[]): string {
  const domains = pages.map((page) => page.domain);
  return domains.length > 1 ? `${domains.slice(0, -1).join(", ")} and ${domains.at(-1)}` : domains[0] ?? "";
}

// Echo's own pair notes (pipeline.ts coPublishedEvidence and coPublishedPartnerNotes), on traces judged since they exist.
const ECHO_PAIR_EVIDENCE = /^Published (?:the same day as|within days of) \S+ with largely identical text[;,]/;

/**
 * For a root published together with others whose saved evidence does not already say so (a trace judged before the
 * partner note, such as the phones sources run, where Asurion's reads "the same-day press release is a copy"): Echo's
 * pair note, shown above that evidence and in reports, so the page and the verdict's count agree. Null otherwise.
 */
function coPublishedNote(page: EchoPage, roles: Map<string, { lead: EchoPage; partners: EchoPage[] }>): string | null {
  const role = page.judgment.kind === "origin" ? roles.get(page.id) : undefined;
  if (!role || ECHO_PAIR_EVIDENCE.test(page.judgment.evidence)) return null;
  return `Published together with ${domainList(role.partners)}: Echo counts them as one independent origin.`;
}

/**
 * The tree's key, worded the same in the result view and on Present slide 3. The percent line shows when the tree
 * labels a link with Claude's confidence (live runs with a confirmed link), using a figure from this tree.
 */
function TreeLegend({ result, stage = false }: { result: EchoAnalysis; stage?: boolean }) {
  const example = result.mode === "live" ? result.pages.find((page) => page.judgment.kind === "derived" && page.judgment.parentId)?.judgment.confidence : undefined;
  return (
    <div className={`tree-key${stage ? " tree-key-stage" : ""}`}>
      <div className={stage ? "stage-tree-legend" : "tree-legend"}><span><i className="legend-origin" />Root page</span><span><i className="legend-derived" />Likely echo</span><span><i className="legend-unclear" />Unclear relationship</span></div>
      {example !== undefined && <p className="tree-key-percent">{example}% on a link = Claude&apos;s confidence in it (its own estimate, not measured)</p>}
    </div>
  );
}

/**
 * The answer with each citation marker linked to its page. A supplied-sources result shows each marker with the
 * supplied link's own number (answerCitationNumbers), so "[1]" from the model reads "[2]" when asurion.com was [2].
 */
function formatCitationText(result: EchoAnalysis) {
  const numbers = answerCitationNumbers(result);
  const sourceByIndex = new Map<number, EchoPage | undefined>(result.answerSourceIds.map((id, index) => [index + 1, result.pages.find((page) => page.id === id)] as const));
  return result.answer.split(/(\[\d+\])/g).map((part, index) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (!match) return <span key={`copy-${index}`}>{part}</span>;
    const cited = Number(match[1]);
    const page = sourceByIndex.get(cited);
    const shown = cited >= 1 && cited <= numbers.length ? `[${numbers[cited - 1]}]` : part;
    if (!page?.url) return <span className="citation citation-muted" key={`cite-${index}`}>{shown}</span>;
    return (
      <a className="citation" href={page.url} key={`cite-${index}`} rel="noreferrer" target="_blank" title={page.title}>
        {shown}
      </a>
    );
  });
}

function BrandMark() {
  return (
    <svg aria-hidden="true" className="brand-mark" fill="none" viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="14.5" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="18" cy="18" r="6.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="18" cy="18" r="1.8" fill="currentColor" />
      <path d="M18 3.5V10M32.5 18H26M18 32.5V26M3.5 18H10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  );
}

// Adds newly found domains to the list in the order they arrived. Only short host names are kept (never page text).
function mergeDomains(current: string[], found: unknown[]) {
  const next = [...current];
  for (const domain of found) {
    if (typeof domain === "string" && /^[\w.-]{1,80}$/.test(domain) && !next.includes(domain) && next.length < 60) next.push(domain);
  }
  return next.length === current.length ? current : next;
}

/**
 * A live run's search plan: the variants built from the claim, and how many of them have finished. providers: on a
 * Telem run, the search providers each finished variant was routed to, by its place in the plan.
 */
type SearchPlan = { queries: string[]; done: number; providers?: Record<number, string[]> };

// The "queries" step's planned variants, kept as single short lines (the server sends the claim's own variants, never
// page text; this keeps anything else from stretching the card).
function planFrom(found: unknown): SearchPlan | null {
  if (!Array.isArray(found)) return null;
  const queries = found
    .filter((query): query is string => typeof query === "string")
    .map((query) => query.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((query) => (query.length > 120 ? `${query.slice(0, 119).trimEnd()}…` : query))
    .slice(0, 12);
  return queries.length ? { queries, done: 0 } : null;
}

// A Telem search step's routing: for each finished variant, the providers it went to. Only provider names (short,
// lowercase), at most five per variant, and only for variants in the plan; anything else is dropped. Never shrinks.
function routePlan(plan: SearchPlan | null, routed: unknown): SearchPlan | null {
  if (!plan || !routed || typeof routed !== "object" || Array.isArray(routed)) return plan;
  const next: Record<number, string[]> = { ...plan.providers };
  let changed = false;
  for (const [key, names] of Object.entries(routed as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= plan.queries.length || !Array.isArray(names)) continue;
    const kept = [...new Set(names.filter((name): name is string => typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)))].slice(0, 5);
    if (!kept.length || next[index]?.join() === kept.join()) continue;
    next[index] = kept;
    changed = true;
  }
  return changed ? { ...plan, providers: next } : plan;
}

// A search step's count of finished variants: only ever moves forward, and never past the plan.
function advancePlan(plan: SearchPlan | null, done: unknown): SearchPlan | null {
  if (!plan || typeof done !== "number" || !Number.isFinite(done)) return plan;
  const next = Math.min(plan.queries.length, Math.max(plan.done, Math.floor(done)));
  return next === plan.done ? plan : { ...plan, done: next };
}

const LOADING_DOMAINS_SHOWN = 12;
// Two rows of three at laptop widths: the first five variants and a "+N more" cell (a plan of six or fewer shows whole).
const LOADING_PLAN_SHOWN = 5;

function LoadingPanel({ progress, onCancel, stalled = false, onFallback, domains = [], claim, sourceCount, plan, telemFallback = false, deep = false }: { progress: PipelineProgress | null; onCancel: () => void; stalled?: boolean; onFallback?: () => void; domains?: string[]; claim?: string; sourceCount?: number; plan?: SearchPlan | null; telemFallback?: boolean; deep?: boolean }) {
  // A Check these sources run builds no queries and searches nothing: its first step is taking the supplied links.
  const stages: Array<{ id: string; ids: string[]; label: string }> = [
    ...(sourceCount
      ? [{ id: "supplied", ids: ["queries", "search"], label: "Take the supplied links" }, { id: "extract", ids: ["extract"], label: "Read the supplied pages" }]
      : [{ id: "queries", ids: ["queries"], label: "Build query variants" }, { id: "search", ids: ["search"], label: "Search and collect pages" }, { id: "extract", ids: ["extract"], label: "Extract source passages" }]),
    { id: "cluster", ids: ["cluster"], label: "Group matching claims" },
    { id: "judge", ids: ["judge"], label: "Trace source relationships" },
    { id: "answer", ids: ["answer"], label: "Answer from origins" },
  ];
  const activeIndex = Math.max(0, stages.findIndex((stage) => Boolean(progress?.stage && stage.ids.includes(progress.stage))));
  // The search plan's own clock: the search is over once the run reaches the extract step or later.
  const searchOver = Boolean(progress?.stage && !["queries", "search"].includes(progress.stage));
  // A visible clock on stage: a live run takes 30–55 s, so the room can see it is moving. Hidden for quick loads.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const showPlan = !sourceCount && plan && plan.queries.length > 0 ? plan : null;
  return (
    <section aria-live="polite" className={`loading-card${showPlan ? " has-plan" : ""}`}>
      <div className="loading-topline">
        <div className="loading-orbit"><span /><span /><span /></div>
        <div className="loading-text">
          <p className="eyebrow">ANALYSIS IN PROGRESS{deep && <span className="loading-deep-tag"> · DEEP SEARCH</span>}{elapsed >= 3 && <span aria-hidden="true" className="loading-elapsed"> · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</span>}</p>
          {/* One line; a long claim is cut with an ellipsis and shown whole on hover. */}
          {claim && <p className="loading-claim" title={claim}>{sourceCount ? `Checking ${sourceCount} supplied ${sourceCount === 1 ? "link" : "links"} for: ` : "Tracing: "}<span>“{claim}”</span></p>}
          <h2>{progress?.label || "Warming up the search"}</h2>
          <p className="loading-detail">{progress?.detail || "Echo is preparing the first queries."}</p>
          {/* Telem's own daily cap sent this run's searches to Tavily (daily-budget.ts); it stays said for the whole wait. */}
          {telemFallback && <p className="loading-router-note" role="status">Telem&apos;s daily cap reached, this run searched with Tavily</p>}
        </div>
        <button className="quiet-button stop-button" onClick={onCancel} type="button">Stop</button>
      </div>
      {/* The search plan built from the claim before any search, each variant ticked as it finishes. A Check these
          sources run has no search, so no plan. Once the search is over, variants it never needed show a dash. */}
      {showPlan && (() => {
        const total = showPlan.queries.length;
        const shown = total > LOADING_PLAN_SHOWN + 1 ? LOADING_PLAN_SHOWN : total;
        const skipped = searchOver ? total - showPlan.done : 0;
        const progressNote = [showPlan.done > 0 ? `${showPlan.done} SEARCHED` : "", skipped > 0 ? `${skipped} NOT NEEDED` : ""].filter(Boolean).join(" · ");
        return (
          <div aria-live="off" className="loading-plan">
            {/* Beside the list on a wide card (its count on a second line), above it on a phone. */}
            <span className="loading-domains-label loading-plan-label">
              <span>SEARCH PLAN · {total} {total === 1 ? "VARIANT" : "VARIANTS"}</span>
              {progressNote && <span className="loading-plan-count"><span className="loading-plan-sep"> · </span>{progressNote}</span>}
            </span>
            <ol aria-label="Search plan">
              {showPlan.queries.slice(0, shown).map((query, index) => {
                const state = index < showPlan.done ? "done" : searchOver ? "skipped" : "waiting";
                // A Telem run: the providers this variant was routed to, e.g. "Exa · Brave" (three at most, then "+N").
                const routed = state === "done" ? showPlan.providers?.[index] : undefined;
                return (
                  <li className={`is-${state}`} data-state={state} key={`${index}-${query}`} title={routed?.length ? `${query} (routed by Telem to ${providerList(routed)})` : query}>
                    <span aria-hidden="true" className="loading-plan-mark">{state === "done" ? "✓" : state === "skipped" ? "–" : ""}</span>
                    <span className="loading-plan-query">{query}</span>
                    {routed?.length ? <span className="loading-plan-providers"><span className="sr-only"> routed to </span>{providerTags(routed)}</span> : null}
                    {state !== "waiting" && <span className="sr-only">{state === "done" ? " (searched)" : " (not needed)"}</span>}
                  </li>
                );
              })}
              {shown < total && <li className="loading-plan-more">+{total - shown} more</li>}
            </ol>
          </div>
        );
      })()}
      {/* The sites found so far, growing during the search: domains only. Not re-announced as each one arrives. */}
      {domains.length > 0 && (
        <div aria-live="off" className="loading-domains">
          {/* A Check these sources run found nothing: these are the sites of the links it was given. */}
          <span className="loading-domains-label">{sourceCount ? "SUPPLIED" : "FOUND SO FAR"} · {domains.length} {domains.length === 1 ? "SITE" : "SITES"}</span>
          <ul aria-label={sourceCount ? "Sites of the supplied links" : "Sites found so far"}>
            {domains.slice(0, LOADING_DOMAINS_SHOWN).map((domain) => <li key={domain}>{domain}</li>)}
            {domains.length > LOADING_DOMAINS_SHOWN && <li className="loading-domains-more">+{domains.length - LOADING_DOMAINS_SHOWN} more</li>}
          </ul>
        </div>
      )}
      {stalled && (
        <div className="stall-notice" role="status">
          <span>This step is taking longer than usual. The live web can be slow; Echo is still waiting.</span>
          {onFallback && <button onClick={onFallback} type="button">Open the saved run instead</button>}
        </div>
      )}
      <div className={`progress-track${sourceCount ? " is-supplied" : ""}`} aria-label={`${activeIndex + 1} of ${stages.length} stages`}>
        {stages.map((stage, index) => (
          <div className={`progress-step ${index < activeIndex ? "is-done" : index === activeIndex ? "is-current" : ""}`} key={stage.id}>
            <span className="progress-dot">{index < activeIndex ? "✓" : String(index + 1).padStart(2, "0")}</span>
            <span>{stage.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceTree({ result, selectedId, onSelect, sourceQuery, onSourceQueryChange, compact = false }: { result: EchoAnalysis; selectedId: string | null; onSelect: (id: string) => void; sourceQuery: string; onSourceQueryChange: (value: string) => void; compact?: boolean }) {
  const [focus, setFocus] = useState<"all" | "origin" | "derived" | "unclear" | "challenged" | "path">("all");
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const layout = useMemo(() => buildLayout(result, compact), [result, compact]);
  const { edgeY, nodeWidth } = compact ? TREE_GEOMETRY.compact : TREE_GEOMETRY.regular;
  const pageById = useMemo(() => new Map<string, EchoPage>(result.pages.map((page) => [page.id, page] as const)), [result.pages]);
  const incoming = new Set(result.pages.filter((page) => page.judgment.kind === "derived").map((page) => page.id));
  const rootIds = new Set(result.roots);
  const roles = useMemo(() => coPublishedRoles(result), [result]);
  // A supplied-sources result's cards show each page's supplied-link number ([2]), as the per-link list does.
  const suppliedNumbers = useMemo(() => suppliedNumbersByPageId(result), [result]);
  // A thin bracket on the left joins roots published together that sit in one column (asurion.com over prnewswire.com).
  const brackets = [...new Set([...roles.values()].map((role) => role.lead))].flatMap((lead) => {
    const from = layout.positions.get(lead.id);
    if (!from) return [];
    const ys = [lead, ...(roles.get(lead.id)?.partners ?? [])].map((page) => layout.positions.get(page.id)).filter((place): place is NodePosition => Boolean(place && place.x === from.x)).map((place) => place.y + edgeY);
    return ys.length > 1 ? [{ key: lead.id, d: `M ${from.x - 3} ${Math.min(...ys)} H ${from.x - 9} V ${Math.max(...ys)} H ${from.x - 3}` }] : [];
  });
  const selectedPath = useMemo(() => {
    const ids = new Set<string>();
    let current = selectedId ? result.pages.find((page) => page.id === selectedId) : undefined;
    while (current && !ids.has(current.id)) {
      ids.add(current.id);
      current = current.judgment.parentId ? result.pages.find((page) => page.id === current?.judgment.parentId) : undefined;
    }
    return ids;
  }, [result.pages, selectedId]);
  const counts = {
    all: result.pages.length,
    origin: result.roots.length,
    derived: result.pages.filter((page) => page.judgment.kind === "derived").length,
    unclear: result.pages.filter((page) => page.judgment.kind === "unclear").length,
    challenged: result.pages.filter((page) => result.sourceAssessmentsByPageId?.[page.id] === "challenged").length,
    path: selectedPath.size,
  };
  const normalizedQuery = sourceQuery.trim().toLocaleLowerCase();
  const matchesQuery = (page: EchoPage) => !normalizedQuery || `${page.title} ${page.domain} ${page.text}`.toLocaleLowerCase().includes(normalizedQuery);
  const matchesRelationship = (page: EchoPage) => focus === "all"
    || (focus === "origin" ? rootIds.has(page.id) : focus === "path" ? selectedPath.has(page.id) : focus === "challenged" ? result.sourceAssessmentsByPageId?.[page.id] === "challenged" : page.judgment.kind === focus);
  const matchesFocus = (page: EchoPage) => matchesQuery(page) && matchesRelationship(page);
  const queryMatchCount = result.pages.filter(matchesFocus).length;
  useEffect(() => {
    if (!normalizedQuery) return;
    const firstMatch = result.pages.find((page) => {
      const matchesText = `${page.title} ${page.domain} ${page.text}`.toLocaleLowerCase().includes(normalizedQuery);
      const matchesKind = focus === "all" || (focus === "origin" ? result.roots.includes(page.id) : focus === "path" ? selectedPath.has(page.id) : focus === "challenged" ? result.sourceAssessmentsByPageId?.[page.id] === "challenged" : page.judgment.kind === focus);
      return matchesText && matchesKind;
    });
    const container = treeScrollRef.current;
    if (!firstMatch || !container) return;
    const node = [...container.querySelectorAll<HTMLElement>(".source-node")].find((item) => item.dataset.pageId === firstMatch.id);
    if (!node) return;
    const timer = window.setTimeout(() => node.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "center",
      inline: "nearest",
    }), 120);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, focus, result.pages, result.roots, result.sourceAssessmentsByPageId, selectedPath]);
  // One entry per drawn link: its curve, and where its caption sits: in the empty gap just left of the page it points
  // to, centred between the cards, level with the arrow's end (just above it), so it reads as that page's link. A link
  // back to an earlier column (a parent in another claim group) labels its end the same way, in the margin before the
  // card. (At the curve's midpoint, a link spanning rows put its caption beside another row's card: head heat's
  // WebMD → jamaicahospital "unclear" sat beside badgeraustralia on slide 3.)
  const edges = result.pages.flatMap((page) => {
    const parent = page.judgment.parentId ? pageById.get(page.judgment.parentId) : null;
    const from = parent ? layout.positions.get(parent.id) : undefined;
    const to = layout.positions.get(page.id);
    if (!from || !to || !parent) return [];
    const startX = from.x + 174;
    const startY = from.y + edgeY;
    const endX = to.x;
    const endY = to.y + edgeY;
    const controlX = (startX + endX) / 2;
    return [{
      key: `${parent.id}-${page.id}`,
      isUnclear: page.judgment.kind === "unclear",
      confidence: page.judgment.confidence,
      matches: focus === "all" || (focus === "path" ? selectedPath.has(page.id) && selectedPath.has(parent.id) : matchesFocus(page) || matchesFocus(parent)),
      d: `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`,
      delay: Math.min(650, Math.floor(to.x / 226) * 130 + 90),
      target: page.id,
      captionX: Math.max(20, endX - (226 - nodeWidth) / 2),
      captionY: endY - 7,
    }];
  });
  const filters = [
    { id: "all", label: "All pages" },
    { id: "origin", label: "Root pages" },
    { id: "derived", label: "Echoes" },
    { id: "unclear", label: "Unclear" },
    { id: "challenged", label: "Challenged" },
    { id: "path", label: "This path" },
  ] as const;
  return (
    <div className={`source-tree-explorer${compact ? " source-tree-compact" : ""}`}>
    <div aria-label="Find and focus source pages" className="tree-filterbar" role="group">
      <span>FOCUS</span>
      {filters.map((filter) => (
        <button aria-label={filter.id === "path" ? `Highlight selected page path, ${counts.path} pages` : undefined} aria-pressed={focus === filter.id} className={`${focus === filter.id ? "tree-filter-active" : ""} ${filter.id === "path" ? "tree-filter-path" : filter.id === "challenged" ? "tree-filter-challenged" : ""}`} disabled={counts[filter.id] === 0 && focus !== filter.id} key={filter.id} onClick={() => setFocus(filter.id)} type="button">
          {filter.label}<b>{counts[filter.id]}</b>
        </button>
      ))}
      <label className="tree-search"><span className="sr-only">Find a source by title, domain, or retrieved passage</span><input onChange={(event) => onSourceQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { const first = result.pages.find(matchesFocus); if (first) { event.preventDefault(); onSelect(first.id); } } }} placeholder="Find source or phrase…" type="search" value={sourceQuery} /></label>
      <small>{normalizedQuery ? `${queryMatchCount} matching page${queryMatchCount === 1 ? "" : "s"} highlighted${queryMatchCount ? " · Enter to inspect first match" : ""}.` : focus === "challenged" && counts.challenged === 0 ? "No challenged judgments remain. Choose All pages to restore the full tree." : focus === "path" ? "Following the selected page to its best-supported source." : selectedId ? "Search titles, domains, or passages; choose This path to follow the selected page." : "Search titles, domains, or passages; select a page to follow its source path."}</small>
    </div>
    <div className="tree-scroll" aria-label="Interactive source family tree; select a page for details" ref={treeScrollRef} role="region" tabIndex={0}>
      <div className="tree-canvas" style={{ height: layout.height, minWidth: layout.width, width: layout.width }}>
        <svg aria-hidden="true" className="tree-lines" height={layout.height} width={layout.width}>
          <defs>
            <marker id="arrow-solid" markerHeight="7" markerWidth="7" orient="auto" refX="5" refY="3.5">
              <path d="M0 0L6 3.5L0 7" fill="none" stroke="#648f8b" strokeWidth="1.2" />
            </marker>
          </defs>
          {brackets.map((bracket) => <path className="co-published-bracket" d={bracket.d} key={`bracket-${bracket.key}`} />)}
          {edges.map((edge) => (
            <path
              className={`${edge.isUnclear ? "edge-path edge-unclear" : "edge-path"} ${edge.matches ? "" : "edge-muted"}`}
              d={edge.d}
              key={edge.key}
              markerEnd={edge.isUnclear ? undefined : "url(#arrow-solid)"}
              style={{ animationDelay: `${edge.delay}ms` }}
            />
          ))}
          {/* Captions are drawn after every curve, each on a background pill (the halo in globals.css), so no other
              link's curve can strike through one ("60%" under the Asurion → KABC curve on slot 02's slide 3). */}
          <g className="edge-captions">
            {edges.map((edge) => (
              <text className={`edge-caption ${edge.isUnclear ? "edge-caption-unclear" : ""}`} data-target={edge.target} key={edge.key} x={edge.captionX} y={edge.captionY}>
                {result.mode === "demo" ? "demo" : edge.isUnclear ? "unclear" : `${edge.confidence}%`}
                {result.mode !== "demo" && !edge.isUnclear && <title>Claude&apos;s confidence in this link (self-reported, not measured)</title>}
              </text>
            ))}
          </g>
        </svg>
        {layout.bands.map((band) => (
          <div className="cluster-label" key={`${band.label}-${band.top}`} style={{ top: band.top }}>{band.label}</div>
        ))}
        {result.pages.map((page) => {
          const position = layout.positions.get(page.id);
          if (!position) return null;
          const isRoot = !incoming.has(page.id);
          const kindClass = page.judgment.kind === "unclear" ? "node-unclear" : isRoot ? "node-origin" : "node-derived";
          const challenged = result.sourceAssessmentsByPageId?.[page.id] === "challenged";
          const faviconUrl = safeFaviconUrl(page.favicon);
          const role = page.judgment.kind === "unclear" ? undefined : roles.get(page.id);
          const sameRelease = Boolean(role && role.lead.id !== page.id);
          const supplied = suppliedNumbers.get(page.id);
          const nodeDate = <span className="node-date" title={reliableDate(page) ? `Date source: ${page.publishedDateSource}` : isSearchEstimate(page) ? `Search estimate: ${formatDate(page.publishedDate)}, not read from the page` : "No reliable date found"}>{reliableDate(page) ?? (isSearchEstimate(page) ? "Search estimate" : "Date unclear")}</span>;
          return (
            <button
              aria-label={`${supplied !== undefined ? `Supplied link [${supplied}]: ` : ""}${page.title}, ${page.judgment.kind === "origin" ? "root page" : page.judgment.kind === "unclear" ? "relationship unclear" : "derived source"}${role ? `, published together with ${domainList(role.partners)}, counted as one origin` : ""}${challenged ? ", source judgment challenged by a reviewer" : ""}`}
              aria-pressed={selectedId === page.id}
              className={`source-node ${kindClass}${supplied !== undefined ? " node-supplied" : ""} ${challenged ? "node-challenged" : ""} ${selectedId === page.id ? "node-selected" : ""} ${matchesFocus(page) ? "" : "node-muted"}`}
              data-page-id={page.id}
              key={page.id}
              onClick={() => onSelect(page.id)}
              style={{ left: position.x, top: position.y, animationDelay: `${Math.min(650, Math.floor(position.x / 226) * 130)}ms` }}
              type="button"
            >
              {/* A supplied link's card carries its number and date on a top line of their own (the tag's line), so
                  the whole domain fits beside the icon: "[2] prnewswire.c…" read as truncated at every size. */}
              {supplied !== undefined && <span className="node-corner"><span aria-hidden="true" className="node-cite" title={`Supplied link [${supplied}]`}>[{supplied}]</span>{nodeDate}</span>}
              <span className="node-meta">
                <span aria-hidden="true" className="node-icon">
                  <span className={`node-mark ${page.judgment.kind === "unclear" ? "node-mark-unclear" : isRoot ? "" : "node-mark-derived"}`} />
                  {faviconUrl && <span className="node-favicon" style={{ backgroundImage: `url("${faviconUrl}")` }} />}
                </span>
                <span className="node-domain">{page.domain}</span>
                {supplied === undefined && nodeDate}
              </span>
              <span className="node-title">{page.title}</span>
              {challenged && <span className="node-review-flag">REVIEW CHALLENGED</span>}
              {isRoot && <span className={`node-tag${sameRelease ? " node-tag-same" : ""}`} title={role ? `Published together with ${domainList(role.partners)}: counted as one independent origin` : undefined}>{page.judgment.kind === "unclear" ? "UNCLEAR" : sameRelease ? "SAME RELEASE" : "ORIGIN"}</span>}
            </button>
          );
        })}
      </div>
    </div>
    </div>
  );
}

// compact (Present mode): the earlier/later labels share the view toggle's row, and the tree uses its compact spacing.
function SourceExplorer({ result, selectedId, onSelect, sourceQuery, onSourceQueryChange, compact = false }: { result: EchoAnalysis; selectedId: string | null; onSelect: (id: string) => void; sourceQuery: string; onSourceQueryChange: (value: string) => void; compact?: boolean }) {
  const [view, setView] = useState<"tree" | "timeline">("tree");
  const flowLabels = <div className="tree-flow-labels"><span>EARLIER / ORIGINS</span><span className="flow-line" /><span>LATER / ECHOES</span></div>;
  return (
    <div className="source-explorer">
      <div aria-label="Choose source view" className="explorer-view-toggle" role="group">
        <span>EXPLORE AS</span>
        <button aria-pressed={view === "tree"} className={view === "tree" ? "explorer-view-active" : ""} onClick={() => setView("tree")} type="button">Family tree</button>
        <button aria-pressed={view === "timeline"} className={view === "timeline" ? "explorer-view-active" : ""} onClick={() => setView("timeline")} type="button">Timeline</button>
        {compact && view === "tree" ? flowLabels : <small>{view === "tree" ? "Follow likely source relationships." : "Read pages in publication-date order."}</small>}
      </div>
      {view === "tree" ? (
        <>
          {!compact && flowLabels}
          <SourceTree compact={compact} onSelect={onSelect} onSourceQueryChange={onSourceQueryChange} result={result} selectedId={selectedId} sourceQuery={sourceQuery} />
        </>
      ) : <SourceTimeline onSelect={onSelect} result={result} selectedId={selectedId} />}
    </div>
  );
}

function SourceTimeline({ result, selectedId, onSelect }: { result: EchoAnalysis; selectedId: string | null; onSelect: (id: string) => void }) {
  const pageById = useMemo(() => new Map(result.pages.map((page) => [page.id, page] as const)), [result.pages]);
  const datedPages = result.pages.filter((page) => page.publishedDate)
    .toSorted((a, b) => Date.parse(a.publishedDate!) - Date.parse(b.publishedDate!));
  const undatedPages = result.pages.filter((page) => !page.publishedDate);
  const renderPage = (page: EchoPage) => {
    const challenged = result.sourceAssessmentsByPageId?.[page.id] === "challenged";
    const parent = page.judgment.parentId ? pageById.get(page.judgment.parentId) : null;
    const relationship = page.judgment.kind === "origin"
      ? "Root page"
      : page.judgment.kind === "unclear"
        ? "Relationship unclear"
        : parent
          ? `Likely follows ${parent.domain}`
          : "Likely derived; parent unknown";
    return (
      <li className="timeline-item" key={page.id}>
        <span className="timeline-date">{page.publishedDate ? formatDate(page.publishedDate) : "Date unclear"}<small>{page.publishedDateSource || "No date source"}</small></span>
        <span aria-hidden="true" className={`timeline-track-node timeline-${page.judgment.kind}`} />
        <button aria-label={`${page.title}, ${relationship}, ${page.publishedDate ? `published ${formatDate(page.publishedDate)}` : "date unclear"}${challenged ? ", source judgment challenged by a reviewer" : ""}`} aria-pressed={selectedId === page.id} className={`timeline-card ${challenged ? "timeline-card-challenged" : ""} ${selectedId === page.id ? "timeline-card-selected" : ""}`} onClick={() => onSelect(page.id)} type="button">
          <span className="timeline-card-top"><span className={`timeline-kind timeline-kind-${page.judgment.kind}`}>{page.judgment.kind === "origin" ? "ROOT" : page.judgment.kind === "derived" ? "ECHO" : "UNCLEAR"}</span><span>{page.domain}</span></span>
          <strong>{page.title}</strong>
          <span className="timeline-relationship">{relationship}</span>
          {challenged && <span className="timeline-review-flag">Reviewer challenged this judgment</span>}
          <small>{textSourceLabel(page.extractionSource) || "Source text unavailable"}{page.publishedDateSource === "Tavily estimate" ? " · approximate date" : ""}</small>
        </button>
      </li>
    );
  };

  return (
    <section aria-label="Source publication timeline" className="source-timeline">
      <div className="timeline-intro"><strong>{datedPages.length}/{result.pages.length} pages have a date</strong><span>Dates show publication order when available, not proof that one page copied another.</span></div>
      <ol className="timeline-list">
        {datedPages.map(renderPage)}
        {undatedPages.length > 0 && <li className="timeline-undated-heading"><span>DATE UNAVAILABLE</span><b>{undatedPages.length}</b></li>}
        {undatedPages.map(renderPage)}
      </ol>
    </section>
  );
}

function highlightSearchPhrase(text: string, query: string): ReactNode {
  const phrase = query.trim();
  if (phrase.length < 2) return text;
  const normalizedText = text.toLocaleLowerCase();
  const normalizedPhrase = phrase.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (let count = 0; count < 30; count += 1) {
    const match = normalizedText.indexOf(normalizedPhrase, cursor);
    if (match < 0) break;
    parts.push(text.slice(cursor, match));
    parts.push(<mark className="source-query-highlight" key={match}>{text.slice(match, match + phrase.length)}</mark>);
    cursor = match + phrase.length;
  }
  if (!parts.length) return text;
  parts.push(text.slice(cursor));
  return parts;
}

/**
 * A page's metadata (pageDetails in trace-view.ts): site and favicon, publisher date and its source, the text saved,
 * which search or supplied link found it, its citations and links within the trace, wording overlap with its parent,
 * Claude's confidence and its evidence status. Open on the result page's source detail; on Present's tree slide a
 * closed "Page details" that opens over the tree, so the slide never grows.
 */
function PageDetails({ rows, favicon, stage = false }: { rows: DetailRow[]; favicon: string | null; stage?: boolean }) {
  const shown = rows.map((row) => row.label === "Site" && favicon ? { ...row, favicon } : row);
  return (
    <details className={stage ? "stage-page-details" : "page-details"} open={stage ? undefined : true}>
      <summary>Page details</summary>
      <dl className="page-details-rows">
        {shown.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            {row.lines.map((line, index) => <dd className={index ? "detail-row-more" : undefined} key={`${index}-${line}`}>{!index && "favicon" in row && row.favicon ? <span aria-hidden="true" className="page-details-favicon" style={{ backgroundImage: `url("${row.favicon}")` }} /> : null}{line}</dd>)}
          </div>
        ))}
      </dl>
    </details>
  );
}

function SourceDetail({ page, pages, claim, pairNote = null, coPublishedGroups, details = null, onSelect, sourceQuery, inspected, reviewNote, assessment, nextReviewPage, uninspectedReviewCount, onToggleInspected, onReviewNoteChange, onAssessmentChange }: { page: EchoPage | null; pages: EchoPage[]; claim: string; pairNote?: string | null; coPublishedGroups?: string[][]; details?: DetailRow[] | null; onSelect: (id: string) => void; sourceQuery: string; inspected: boolean; reviewNote: string; assessment: SourceAssessment | null; nextReviewPage: EchoPage | null; uninspectedReviewCount: number; onToggleInspected: (id: string) => void; onReviewNoteChange: (id: string, note: string) => void; onAssessmentChange: (id: string, status: SourceAssessment | null) => void }) {
  if (!page) {
    return (
      <aside className="detail-card detail-empty">
        <div className="detail-empty-icon">↗</div>
        <h3>Select a page</h3>
        <p>Open a node to read its passage, date, and relationship evidence.</p>
      </aside>
    );
  }
  const parent = page.judgment.parentId ? pages.find((candidate) => candidate.id === page.judgment.parentId) : null;
  const edgeSignals = parent && page.extractionSource !== "Rehearsal fixture" ? visibleEdgeSignals(page, parent) : null;
  const linkedPages = (page.linkedPageIds ?? []).map((id) => pages.find((candidate) => candidate.id === id)).filter((candidate): candidate is EchoPage => Boolean(candidate));
  const citedPages = (page.citations ?? []).map((citation) => ({ citation, cited: pages.find((candidate) => candidate.id === citation.pageId) })).filter((entry): entry is { citation: NonNullable<EchoPage["citations"]>[number]; cited: EchoPage } => Boolean(entry.cited));
  // A root published together with others counts their echoes too (once each): the group is one independent origin.
  const reach = groupDownstreamEchoes(page.id, pages, coPublishedGroups);
  const isRehearsal = page.extractionSource === "Rehearsal fixture";
  const primaryEvidenceUnclear = page.primaryEvidenceStatus === "unclear";
  // What Echo saw on a confirmed derived edge, in plain words from the two pages' own facts (null for dashed links).
  const edgeFacts = parent && !isRehearsal ? edgeSentence(page, parent, { pages, claim }) : null;
  return (
    <aside className="detail-card" tabIndex={-1}>
      <div className="detail-heading">
        <span className="eyebrow">SOURCE DETAIL</span>
        <span className={`detail-kind ${page.judgment.kind}`}>{page.judgment.kind === "origin" ? "Root page" : page.judgment.kind === "derived" ? "Derived" : "Unclear"}</span>
      </div>
      <h3>{page.title}</h3>
      <div className="detail-domain">{page.domain} <span>·</span> {formatDate(page.publishedDate)}{page.publishedDateSource && <span className="date-source"> · {page.publishedDateSource}</span>}</div>
      {page.publishedDateEvidence && page.extractionSource !== "Rehearsal fixture" && <div className="date-evidence">Date from: {page.publishedDateEvidence}</div>}
      {/* The date's evidence already shows above ("Date from: …"), so the details keep only the date and its source. */}
      {details && <PageDetails favicon={safeFaviconUrl(page.favicon)} rows={details.map((row) => (row.label === "Publisher date" ? { ...row, lines: row.lines.slice(0, 1) } : row))} />}
      {edgeFacts &&<p className="edge-sentence"><span className="evidence-label">WHAT ECHO SAW ON THIS LINK</span>{edgeFacts}</p>}
      <div className="detail-passage">
        <span className="passage-label">{page.extractionSource === "Tavily extraction" ? "Extracted passage" : page.extractionSource === "Page HTML" ? "Text read from the page" : page.extractionSource || "Source passage"}</span>
        <p>“{highlightSearchPhrase(page.text, sourceQuery)}”</p>
      </div>
      <div className="detail-evidence">
        <span className="evidence-label">{parent ? `Compared with ${parent.domain}` : "Relationship note"}</span>
        {pairNote && <p className="co-published-note">{pairNote}</p>}
        <p>{page.judgment.evidence}</p>
        {parent && <div className="confidence-row"><span>{isRehearsal ? "Illustrative link" : page.judgment.kind === "unclear" ? "Source relationship" : "Claude's confidence (self-reported, not measured)"}</span><strong>{isRehearsal ? "demo" : page.judgment.kind === "unclear" ? "unresolved" : `${page.judgment.confidence}%`}</strong></div>}
        {edgeSignals && <div className="edge-signal-summary"><span className="evidence-label">VISIBLE CLUES ON THE PAGE</span><div><span className={edgeSignals.linkedParentUrl ? "edge-signal-present" : ""}>{edgeSignals.linkedParentUrl ? "Parent URL appears" : "No parent URL seen"}</span><span className={edgeSignals.sharedPhrases.length ? "edge-signal-present" : ""}>{edgeSignals.sharedPhrases.length ? `${edgeSignals.sharedPhrases.length} shared phrase${edgeSignals.sharedPhrases.length === 1 ? "" : "s"}` : "No distinctive shared phrase"}</span><span className={edgeSignals.textOverlap >= 0.2 ? "edge-signal-present" : ""}>{edgeSignals.textOverlap >= 0.2 ? `${Math.round(edgeSignals.textOverlap * 100)}% of passage matches parent` : "Little word-for-word overlap"}</span></div><small>These are inspection clues, not proof of copying. A paraphrase may share none of them in the saved passage, and a shared press release can explain high overlap.</small></div>}
      </div>
      <div className="source-reach">
        <span className="evidence-label">DOWNSTREAM SPREAD IN THIS TREE</span>
        <div className="source-reach-count"><strong>{reach.all.length}</strong><span>{isRehearsal ? "illustrative" : "likely"} downstream {reach.all.length === 1 ? "echo" : "echoes"}<small>{reach.direct.length} directly linked</small>{reach.partners.length > 0 && <small className="source-reach-together">{togetherEchoesNote(reach.partners)}</small>}</span></div>
        <p>Counts follow derived links only. Unclear links and pages outside this trace are excluded.</p>
        {reach.all.length > 0 && <details className="compare-relationship">
          <summary>Explore these {reach.all.length} {reach.all.length === 1 ? "page" : "pages"}</summary>
          <div className="linked-pages">
            {reach.all.map((echo) => <button className="linked-page-button" key={echo.id} onClick={() => onSelect(echo.id)} type="button"><strong>{echo.title}</strong><span>{echo.domain} ↗</span></button>)}
          </div>
        </details>}
      </div>
      {linkedPages.length > 0 && <details className="compare-relationship">
        <summary>Links to {linkedPages.length} retrieved {linkedPages.length === 1 ? "page" : "pages"}</summary>
        <div className="linked-pages">
          <small>These URLs appear in the extracted passage. A link may be navigation rather than a citation.</small>
          {linkedPages.map((linked) => <button className="linked-page-button" key={linked.id} onClick={() => onSelect(linked.id)} type="button"><strong>{linked.title}</strong><span>{linked.domain} ↗</span></button>)}
        </div>
      </details>}
      {citedPages.length > 0 && <details className="compare-relationship">
        <summary>Cites {citedPages.length} retrieved {citedPages.length === 1 ? "page" : "pages"}</summary>
        <div className="linked-pages">
          <small>Citations Echo verified on this page. A citation shows which page came first, not that the claim is true.</small>
          {citedPages.map(({ citation, cited }) => <button className="linked-page-button" key={`${cited.id}-${citation.how}`} onClick={() => onSelect(cited.id)} type="button"><strong>{cited.title}</strong><span>{citation.quote.startsWith("This page's HTML links to") ? "link in page HTML" : citation.how} · {cited.domain} ↗</span></button>)}
        </div>
      </details>}
      {parent && <PageComparison page={page} parent={parent} />}
      <div className={`primary-flag ${isRehearsal || primaryEvidenceUnclear ? "primary-unclear" : page.hasPrimaryEvidence ? "primary-yes" : "primary-no"}`}>
        <span className="primary-dot" />
        <div><strong>{isRehearsal ? "Evidence not assessed in rehearsal" : page.hasPrimaryEvidence ? "Own evidence found" : primaryEvidenceUnclear ? "Own evidence not verified" : "No own evidence identified"}</strong><small>{page.primaryEvidenceReason || "No study, dataset, or named source was found in this passage."}</small></div>
      </div>
      {!isRehearsal && <div className="human-review">
        <span className="evidence-label">MANUAL SOURCE REVIEW</span>
        <button aria-pressed={inspected} disabled={!page.url} onClick={() => onToggleInspected(page.id)} type="button">{inspected ? "✓ Marked inspected" : "Mark page inspected"}</button>
        <small>{inspected ? "This trace marks the page as inspected. The mark does not change Echo’s source judgment." : "Open the original page, then mark it here to track your review. This does not verify the claim."}</small>
        <span className="human-review-question">Does the original page support Echo’s relationship judgment?</span>
        <div className="human-review-choices">{(["supported", "challenged", "unclear"] as const).map((status) => <button aria-pressed={assessment === status} className={`human-review-${status}`} key={status} onClick={() => onAssessmentChange(page.id, status)} type="button">{status === "supported" ? "Supports" : status === "challenged" ? "Challenges" : "Cannot tell"}</button>)}{assessment && <button onClick={() => onAssessmentChange(page.id, null)} type="button">Clear</button>}</div>
        <small>This is a saved reviewer assessment, separate from Echo’s tree and verdict. Explain a challenge in the note below.</small>
        <label htmlFor={`review-note-${page.id}`}>Review note saved in this trace <span>{reviewNote.length}/600</span></label>
        <textarea id={`review-note-${page.id}`} maxLength={600} onChange={(event) => onReviewNoteChange(page.id, event.target.value)} placeholder="What did the original page actually show? Record a date, citation, or evidence gap." rows={3} value={reviewNote} />
        <small>Included in exports; imported notes may come from another reviewer. A note does not change Echo’s model judgment.</small>
        {nextReviewPage && <div className="human-review-next"><button onClick={() => { onSelect(nextReviewPage.id); window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".map-layout .detail-card")?.focus()); }} type="button">Next flagged source →</button><small>{uninspectedReviewCount} flagged {uninspectedReviewCount === 1 ? "page remains" : "pages remain"} uninspected · {nextReviewPage.title}</small></div>}
      </div>}
      {page.url && <a className="source-link" href={page.url} rel="noreferrer" target="_blank">Open source <span>↗</span></a>}
    </aside>
  );
}

function PageComparison({ page, parent }: { page: EchoPage; parent: EchoPage }) {
  const isRehearsal = page.extractionSource === "Rehearsal fixture" || parent.extractionSource === "Rehearsal fixture";
  const phrases = isRehearsal ? [] : findSharedPhrases(parent.text, page.text);
  return (
    <details className="compare-relationship">
      <summary>Compare the linked pages</summary>
      <div aria-label="Shared wording evidence" className="shared-wording">
        <span className="compare-page-label">SHARED WORDING IN RETRIEVED TEXT</span>
        {isRehearsal ? (
          <p className="shared-wording-empty">Synthetic rehearsal text does not provide live wording evidence.</p>
        ) : phrases.length ? (
          <ul>{phrases.map((phrase) => <li key={phrase}><q>{phrase}</q></li>)}</ul>
        ) : (
          <p className="shared-wording-empty">No exact run of five or more words appears in both retrieved passages.</p>
        )}
        <small>Word order is exact; punctuation and spacing are normalized. A match is a review clue, not proof of copying. Common wording or a shared source can also explain it.</small>
      </div>
      <div className="compare-pages">
        {[{ page: parent, label: "LINKED SOURCE" }, { page, label: "SELECTED PAGE" }].map(({ page: comparePage, label }) => (
          <article className="compare-page" key={comparePage.id}>
            <span className="compare-page-label">{label}</span>
            <h4>{comparePage.title}</h4>
            <p className="compare-meta">{comparePage.domain} · {reliableDate(comparePage) ?? (isSearchEstimate(comparePage) ? "date: search estimate" : "date unclear")} · {textSourceLabel(comparePage.extractionSource) || "text unavailable"}</p>
            <p className="compare-excerpt">“{highlightSharedPassage(comparePage.text, phrases)}”</p>
            {comparePage.url && <a href={comparePage.url} rel="noreferrer" target="_blank">Open page ↗</a>}
          </article>
        ))}
      </div>
      <p className="compare-caveat">This is Echo’s proposed source relationship. Similar wording and timing support a direction; they do not prove copying.</p>
    </details>
  );
}

function highlightSharedPassage(text: string, phrases: string[]): ReactNode {
  if (!phrases.length) return text;
  const tokenMatches = Array.from(text.matchAll(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*%?/gu));
  const phraseTokens = phrases.map((phrase) => phrase.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*%?/gu)?.map((word) => word.toLocaleLowerCase()) ?? [])
    .filter((words) => words.length >= 5)
    .sort((a, b) => b.length - a.length);
  const ranges: Array<{ start: number; end: number }> = [];
  let tokenIndex = 0;
  while (tokenIndex < tokenMatches.length) {
    const phrase = phraseTokens.find((words) => words.every((word, offset) => tokenMatches[tokenIndex + offset]?.[0].toLocaleLowerCase() === word));
    if (!phrase) {
      tokenIndex += 1;
      continue;
    }
    const first = tokenMatches[tokenIndex];
    const last = tokenMatches[tokenIndex + phrase.length - 1];
    if (first.index !== undefined && last.index !== undefined) {
      ranges.push({ start: first.index, end: last.index + last[0].length });
      tokenIndex += phrase.length;
    } else {
      tokenIndex += 1;
    }
  }
  if (!ranges.length) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, range] of ranges.entries()) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(<mark className="shared-word-highlight" key={`shared-${index}`}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function downloadPortableTrace(result: EchoAnalysis) {
  const blob = new Blob([JSON.stringify(makePortableTrace(result), null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const slug = result.claim.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "source-trace";
  link.href = url;
  link.download = `echo-${slug}.echo.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type ReviewReason = { label: string; priority: number };
type ReviewPage = { page: EchoPage; reasons: ReviewReason[]; priority: number };

function getReviewPages(result: EchoAnalysis): ReviewPage[] {
  if (result.mode === "demo") return [];
  const rootIds = new Set(result.roots);
  const pageById = new Map(result.pages.map((page) => [page.id, page] as const));
  return result.pages.map((page) => {
    const reasons: ReviewReason[] = [];
    if (result.sourceAssessmentsByPageId?.[page.id] === "challenged") reasons.push({ label: "Reviewer challenged judgment", priority: 6 });
    if (page.judgment.kind === "unclear") reasons.push({ label: "Source link unresolved", priority: 5 });
    if (rootIds.has(page.id) && (page.primaryEvidenceStatus === "unclear" || (page.primaryEvidenceStatus === undefined && !page.hasPrimaryEvidence))) reasons.push({ label: "Root evidence unverified", priority: 4 });
    if (rootIds.has(page.id) && page.primaryEvidenceStatus === "not found") reasons.push({ label: "No own evidence found", priority: 3 });
    if (page.extractionSource === "Search snippet") reasons.push({ label: "Snippet only", priority: 3 });
    if (page.judgment.kind === "derived" && page.judgment.confidence < 70) reasons.push({ label: "Low confidence link", priority: 2 });
    const parent = page.judgment.parentId ? pageById.get(page.judgment.parentId) : null;
    if (page.judgment.kind === "derived" && parent) {
      const signals = visibleEdgeSignals(page, parent);
      if (!signals.linkedParentUrl && !signals.sharedPhrases.length) reasons.push({ label: "No visible link or distinctive shared wording", priority: 3 });
      else if (!signals.linkedParentUrl) reasons.push({ label: "No direct URL to proposed parent in passage", priority: 2 });
    }
    if (!page.publishedDate) reasons.push({ label: "Date unavailable", priority: 1 });
    else if (page.publishedDateSource === "Tavily estimate") reasons.push({ label: "Date is estimated", priority: 1 });
    return { page, reasons, priority: Math.max(0, ...reasons.map((reason) => reason.priority)) };
  }).filter((item) => item.reasons.length).sort((a, b) => b.priority - a.priority || b.reasons.length - a.reasons.length || a.page.title.localeCompare(b.page.title));
}

/**
 * "How Echo checked this": one strip of what the run did at each step (plan, search, read, group, judge, verify,
 * answer), counted by howEchoChecked from the trace's own fields, so showing it calls nothing. It sits under the
 * echo-spread timeline, below the verdict and plain-search box a slot click scrolls to. Hovering a step says how it
 * is counted.
 */
function HowEchoChecked({ result }: { result: EchoAnalysis }) {
  const checked = howEchoChecked(result);
  if (!checked) return null;
  return (
    <section aria-label="How Echo checked this" className="how-checked">
      <div className="how-checked-head">
        <span className="eyebrow">HOW ECHO CHECKED THIS</span>
        <p>Counted from this trace’s own record; showing it runs no search or model call.{checked.totalMs !== undefined ? ` Stage times from the run’s receipt, ${stageTimeLabel(checked.totalMs)} in all.` : ""}</p>
      </div>
      <ol className="how-checked-steps">
        {checked.steps.map((step) => (
          <li key={step.step} title={`How this is counted: ${step.note}`}>
            <span className="how-checked-step">{step.step}{step.ms !== undefined && <span className="how-checked-time"> · {stageTimeLabel(step.ms)}</span>}</span>
            <strong>{step.value}</strong>
            <span className="how-checked-detail">{step.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** How long the funnel's numbers take to count up, and how far apart the stages start (milliseconds). */
const COUNT_UP_MS = 1100;
const COUNT_UP_STAGGER_MS = 90;

/**
 * The funnel's count-up: 0 → 1 over COUNT_UP_MS once the funnel is first in view (on a Present slide, at once). With
 * prefers-reduced-motion, or without the browser APIs it needs, it stays at 1, so the final numbers show from the start.
 */
function useCountUp(ref: RefObject<HTMLElement | null>, runKey: string, immediate: boolean, stages: number) {
  const [elapsed, setElapsed] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!node || reduce || typeof window.requestAnimationFrame !== "function" || (!immediate && typeof IntersectionObserver === "undefined")) return;
    const total = COUNT_UP_MS + COUNT_UP_STAGGER_MS * Math.max(0, stages - 1);
    let frame = 0;
    let start = 0;
    const tick = (now: number) => {
      start ||= now;
      const spent = Math.min(total, now - start);
      setElapsed(spent >= total ? null : spent);
      if (spent < total) frame = window.requestAnimationFrame(tick);
    };
    setElapsed(0);
    const run = () => { frame = window.requestAnimationFrame(tick); };
    let observer: IntersectionObserver | null = null;
    if (immediate) run();
    else {
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        run();
      }, { threshold: 0.35 });
      observer.observe(node);
    }
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [ref, runKey, immediate, stages]);
  /** The number a stage shows now: its final value, or part of it while counting (ease-out). */
  return (value: number, index: number) => {
    if (elapsed === null) return value;
    const t = Math.min(1, Math.max(0, (elapsed - index * COUNT_UP_STAGGER_MS) / COUNT_UP_MS));
    return Math.round(value * (1 - (1 - t) ** 3));
  };
}

const FUNNEL_PHASES: Record<FunnelStage["phase"], string> = { search: "SEARCH", supplied: "SUPPLIED", read: "READ", judge: "JUDGE" };

/**
 * The evidence funnel (evidenceFunnel in trace-view.ts): how much the run processed, from its search phrasings to its
 * independent origins, every number counted from the trace. On the result page it sits right under the verdict and the
 * plain-search box; Present shows it large on slide 2. Hovering or focusing a stage puts its note (what exactly it
 * counts) in the line under the stages. The numbers count up the first time the funnel is in view.
 */
function EvidenceFunnelView({ result, stage = false, runKind = "live run" }: { result: EchoAnalysis; stage?: boolean; runKind?: string }) {
  const funnel = useMemo(() => evidenceFunnel(result), [result]);
  const ref = useRef<HTMLElement | null>(null);
  const shown = useCountUp(ref, `${result.claim}|${result.createdAt}`, stage, funnel?.stages.length ?? 0);
  const [active, setActive] = useState<number | null>(null);
  const noteId = useId();
  if (!funnel) return null;
  const defaultNote = `${funnel.lead} Hover a stage to see exactly what it counts.`;
  return (
    <section aria-label="What Echo processed" className={`evidence-funnel${stage ? " evidence-funnel-stage" : ""}`} data-funnel-kind={funnel.kind} ref={ref}>
      {!stage && <div className="funnel-head"><span className="eyebrow">WHAT ECHO PROCESSED</span><p>From {funnel.kind === "sources" ? "the links you supplied" : "the first search"} to the independent origins, as this trace records it.</p></div>}
      <ol className="funnel-stages" style={{ ["--funnel-count" as string]: funnel.stages.length }}>
        {funnel.stages.map((entry, index) => {
          const firstOfPhase = index === 0 || funnel.stages[index - 1].phase !== entry.phase;
          const value = shown(entry.value, index);
          return (
            <li aria-describedby={noteId} aria-label={`${funnelNumber(entry.value)} ${entry.label}${entry.detail ? `, ${entry.detail}` : ""}`} className={`funnel-stage funnel-phase-${entry.phase}${entry.key === "origins" ? " funnel-final" : ""}${active === index ? " funnel-active" : ""}`} data-stage={entry.key} data-value={entry.value} key={entry.key} onBlur={() => setActive(null)} onFocus={() => setActive(index)} onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)} tabIndex={0}>
              <span aria-hidden="true" className="funnel-phase">{firstOfPhase ? FUNNEL_PHASES[entry.phase] : " "}</span>
              <strong aria-hidden="true" className={entry.value >= 1000 ? "funnel-long" : undefined}>{funnelNumber(value)}</strong>
              <span aria-hidden="true" className="funnel-label">{entry.label}</span>
              {entry.detail && <span aria-hidden="true" className="funnel-detail">{entry.detail}</span>}
            </li>
          );
        })}
      </ol>
      <p className="funnel-note" id={noteId}>{active !== null ? funnel.stages[active].note : defaultNote}</p>
      {funnel.facts.length > 0 && <ul aria-label="More counts from this trace" className="funnel-facts">{funnel.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul>}
      {!stage && <RunDetails result={result} runKind={runKind} />}
    </section>
  );
}

/** When a run was made, to the minute, in the viewer's time zone ("Nov 10, 2026, 8:52 PM PST"). */
function formatRunDateTime(timestamp: string) {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? formatDate(timestamp) : parsed.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

function DetailRows({ rows, className }: { rows: DetailRow[]; className: string }) {
  return (
    <dl className={className}>
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          {row.lines.map((line, index) => <dd className={index ? "detail-row-more" : undefined} key={`${index}-${line}`}>{line}</dd>)}
        </div>
      ))}
    </dl>
  );
}

/**
 * "Run details" (runDetails in trace-view.ts): closed by default, one summary line in view; open, every count and
 * setting the trace records for the run (router, engines, searches, results, pages, text, dates, citations, Claude,
 * stage times, the cost receipt). Nothing here is fetched or estimated.
 */
function RunDetails({ result, runKind }: { result: EchoAnalysis; runKind: string }) {
  const details = runDetails(result);
  if (!details) return null;
  const when = formatRunDateTime(result.createdAt);
  const kind = runKind;
  return (
    <details className="run-details">
      <summary><span className="run-details-label">RUN DETAILS</span><span className="run-details-summary">{[when, ...details.summary].join(" · ")}</span></summary>
      <DetailRows className="run-details-rows" rows={[{ label: "Run", lines: [`${when} · ${kind}`] }, ...details.rows]} />
    </details>
  );
}

function ResultView({ result, previousTrace, selectedId, onSelect, onUpdateResult, onReset, onOpenTrace, onSaveImported, isSavedHere, liveSeconds, isBundledRun }: { result: EchoAnalysis; previousTrace: EchoAnalysis | null; selectedId: string | null; onSelect: (id: string) => void; onUpdateResult: (analysis: EchoAnalysis) => void; onReset: () => void; onOpenTrace: () => void; onSaveImported: () => void; isSavedHere: boolean; liveSeconds?: number; isBundledRun: boolean }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [linkState, setLinkState] = useState<"idle" | "copied" | "error">("idle");
  const [badgeState, setBadgeState] = useState<"idle" | "copied" | "error">("idle");
  // A bundled run (not a fresh or imported one) can be embedded as a badge whose figures always match its link. Only the
  // run opened from Echo's own slots counts: an opened file with the same claim and date may have edited pages.
  const bundledTrace = isBundledRun && result.mode === "live" ? [...PRESETS, ...BACKUP_POOL].find((entry) => entry.capturedTrace && cacheKey(entry.claim) === cacheKey(result.claim) && DEMO_SCORES[entry.capturedTrace]?.traceCreatedAt === result.createdAt)?.capturedTrace : undefined;
  const [sourceQuery, setSourceQuery] = useState("");
  const [isPresenting, setIsPresenting] = useState(false);
  const [comparison, setComparison] = useState<{ baseKey: string; analysis: EchoAnalysis; filename: string } | null>(() => previousTrace && previousTrace.createdAt !== result.createdAt ? {
    baseKey: `${result.claim}|${result.createdAt}|${result.mode}`, analysis: previousTrace, filename: "Previous browser trace",
  } : null);
  const [comparisonError, setComparisonError] = useState<{ baseKey: string; message: string } | null>(null);
  const comparisonInput = useRef<HTMLInputElement | null>(null);
  // The toolbar's More disclosure: open state, its wrapper (for clicks outside) and button (focus returns there).
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const moreMenuId = useId();
  const closeMore = (returnFocus: boolean) => {
    setMoreOpen(false);
    if (returnFocus) moreButton.current?.focus();
  };
  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) setMoreOpen(false);
    };
    // Focus leaving the menu (Tab past its last item) closes it too.
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) setMoreOpen(false);
    };
    // Esc closes it from anywhere (Safari does not focus a clicked button) and puts focus back on More.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMoreOpen(false);
      moreButton.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen]);
  const portalReady = useSyncExternalStore(subscribeToClient, getClientSnapshot, getServerSnapshot);
  const comparisonBaseKey = `${result.claim}|${result.createdAt}|${result.mode}`;
  const activeComparison = comparison?.baseKey === comparisonBaseKey ? comparison : null;
  const activeComparisonError = comparisonError?.baseKey === comparisonBaseKey ? comparisonError.message : null;
  const pagesById = useMemo(() => new Map<string, EchoPage>(result.pages.map((page) => [page.id, page] as const)), [result.pages]);
  const selected = selectedId ? pagesById.get(selectedId) ?? null : null;
  const inspectedIds = new Set(result.inspectedPageIds ?? []);
  const reviewQueue = getReviewPages(result);
  const uninspectedReviewPages = reviewQueue.filter(({ page }) => !inspectedIds.has(page.id));
  const selectedReviewIndex = reviewQueue.findIndex(({ page }) => page.id === selectedId);
  const nextReviewPage = selectedReviewIndex < 0
    ? uninspectedReviewPages[0]?.page ?? null
    : [...reviewQueue.slice(selectedReviewIndex + 1), ...reviewQueue.slice(0, selectedReviewIndex)]
      .find(({ page }) => !inspectedIds.has(page.id))?.page ?? null;
  const isRehearsal = result.mode === "demo";
  const hasConfirmedOrigins = result.roots.length > 0;
  const unresolvedCount = result.pages.filter((page) => page.judgment.kind === "unclear").length;
  const traceSignals = summarizeTraceSignals(result.pages);
  // Pages without a date read off the page itself (none, a search estimate, or an odd one): the complement of the
  // reliably dated pages the strip's span counts, so the two always add up to the page total.
  const undatedPages = result.pages.length - reliablyDatedPages(result).length;
  const primaryEvidenceIncomplete = result.roots.some((id) => pagesById.get(id)?.primaryEvidenceStatus === "unclear");
  const isGhost = !isRehearsal && result.claimSlot === "ghost" && result.summary.verifiableOrigins === 0 && hasConfirmedOrigins && !primaryEvidenceIncomplete;
  const sourceLimited = result.answerStatus === "source-limited";
  const reviewedAnswerStatements = result.answerStatements?.filter((_, index) => Boolean(result.answerReviews?.[index]?.status)).length ?? 0;
  const unsupportedAnswerStatements = result.answerStatements?.filter((_, index) => result.answerReviews?.[index]?.status === "unsupported").length ?? 0;
  const numberGrounding = result.answerStatus === "generated" ? answerNumberGrounding(result) : [];
  const unmatchedAnswerNumbers = numberGrounding.reduce((total, entry) => total + entry.unmatchedNumbers.length, 0);
  const challengedSourceJudgments = Object.values(result.sourceAssessmentsByPageId ?? {}).filter((status) => status === "challenged").length;
  const rootsOmittedFromAnswer = Math.max(0, result.roots.length - 12);
  // The number each answer citation shows: a supplied-sources result uses the supplied links' own numbers.
  const answerNumbers = answerCitationNumbers(result);
  const suppliedRootsNotCited = result.answerStatus === "generated" ? Math.max(0, Math.min(result.roots.length, 12) - result.answerSourceIds.length) : 0;
  const noConfirmedOrigins = !hasConfirmedOrigins;
  const pageWord = result.summary.totalPages === 1 ? "page" : "pages";
  // A Check these sources result counts the supplied links Echo could read, not pages "found" (it ran no search).
  const linksRead = result.sourceCheck ? result.sourceCheck.urls.length - (result.sourceCheck.unreadUrls ?? []).length : 0;
  const originWord = result.summary.independentOrigins === 1 ? "origin" : "origins";
  const datedSpan = datedSpanOf(result);
  const derivedLabel = isRehearsal ? `${result.summary.echoPercentage}% sample echoes` : `${result.summary.echoPercentage}% echo`;
  const headline = verdictHeadline(result);
  const plainSearch = plainSearchLineage(result);
  const costReceipt = result.mode === "live" ? costReceiptLine(result) : null;
  const printModeLabel = result.mode === "demo" ? "ILLUSTRATIVE FIXTURE, NOT LIVE RESEARCH" : isBundledRun ? `SAVED LIVE RUN, CAPTURED ${formatRunDate(result.createdAt).toUpperCase()}` : result.importedAt ? "IMPORTED TRACE FILE" : result.cacheHit ? "CACHED LIVE TRACE" : "FRESH LIVE TRACE";
  const verdictText = isRehearsal
    ? "This synthetic graph lets you explore the interface. It is not a finding about the claim or its real sources."
    : isGhost
    ? "No independent origin shows evidence of its own for this claim in its retrieved passage."
    : primaryEvidenceIncomplete
      ? "Only search snippets were available for some root pages. Echo cannot confirm that those pages lack evidence of their own."
      : noConfirmedOrigins
        ? `No page was judged an independent origin; ${unresolvedCount} ${unresolvedCount === 1 ? "relationship remains" : "relationships remain"} unresolved.`
        : result.summary.verifiableOrigins === 0
          ? `No retrieved root passage shows confirmed evidence of its own; inspect the full root pages shown in the tree.${unresolvedCount ? ` ${unresolvedCount} ${unresolvedCount === 1 ? "relationship remains" : "relationships remain"} unresolved.` : ""}`
          : `Echo collapses repeated pages to their independent origins.${unresolvedCount ? ` ${unresolvedCount} ${unresolvedCount === 1 ? "relationship remains" : "relationships remain"} unresolved.` : ""}`;
  const toggleInspected = (pageId: string) => {
    const nextIds = new Set(result.inspectedPageIds ?? []);
    if (nextIds.has(pageId)) nextIds.delete(pageId);
    else nextIds.add(pageId);
    onUpdateResult({ ...result, inspectedPageIds: [...nextIds] });
  };
  const updateReviewNote = (pageId: string, note: string) => {
    const nextNotes = { ...result.reviewNotesByPageId };
    if (note.trim()) nextNotes[pageId] = note.slice(0, 600);
    else delete nextNotes[pageId];
    onUpdateResult({ ...result, reviewNotesByPageId: nextNotes });
  };
  const updateSourceAssessment = (pageId: string, status: SourceAssessment | null) => {
    const nextAssessments = { ...result.sourceAssessmentsByPageId };
    if (status) nextAssessments[pageId] = status;
    else delete nextAssessments[pageId];
    onUpdateResult({ ...result, sourceAssessmentsByPageId: nextAssessments });
  };
  const updateAnswerReview = (index: number, change: { status?: "supported" | "unsupported" | "unclear" | null; note?: string }) => {
    const nextReviews = { ...result.answerReviews };
    const next = { status: nextReviews[index]?.status ?? null, note: nextReviews[index]?.note ?? "", ...change };
    if (!next.status && !next.note.trim()) delete nextReviews[index];
    else nextReviews[index] = { ...next, note: next.note.slice(0, 600) };
    onUpdateResult({ ...result, answerReviews: nextReviews });
  };
  const buildReport = () => {
    const roots = result.roots
      .map((id) => pagesById.get(id))
      .filter((page): page is EchoPage => Boolean(page))
      .map((page, index) => `${index + 1}. ${page.title} — ${page.domain}${page.publishedDate ? ` · ${page.publishedDate}` : " · date unclear"}${page.url ? `\n   ${page.url}` : ""}`);
    const answerCitations = result.answerSourceIds.map((id, index) => {
      const page = pagesById.get(id);
      return page ? `[${answerNumbers[index]}] ${page.title} — ${page.domain}${page.url ? `\n   ${page.url}` : ""}\n   Saved passage: ${page.text.slice(0, 600) || "Not available in this trace."}` : `[${answerNumbers[index]}] Source page unavailable in this trace.`;
    });
    const queryAudit = result.searchAudit?.length
      ? result.searchAudit.map((entry, index) => `${index + 1}. [${entry.depth} · ${entry.status}${entry.router === "telem" ? ` · Telem${entry.providers?.length ? `: ${providerList(entry.providers)}` : ""}` : ""}] ${entry.query} — ${entry.matchingResults} relevant of ${entry.totalResults} results, ${entry.uniquePagesAdded} new ${entry.uniquePagesAdded === 1 ? "page" : "pages"}${entry.reason ? ` (${entry.reason})` : ""}`)
      : ["No search-query audit was saved in this trace."];
    const reviewNotes = getReviewPages(result).map(({ page, reasons }, index) => `${index + 1}. ${page.title} — ${page.domain}: ${reasons.map((reason) => reason.label).join(", ")}${page.url ? `\n   ${page.url}` : ""}`);
    const reportRoles = coPublishedRoles(result);
    const relationships = result.pages.map((page, index) => {
      const parent = page.judgment.parentId ? pagesById.get(page.judgment.parentId) : null;
      const signals = parent && result.mode === "live" ? visibleEdgeSignals(page, parent) : null;
      const parentLabel = parent ? `${parent.title} — ${parent.domain}${parent.url ? `\n   Parent URL: ${parent.url}` : ""}` : "none identified";
      const relationship = page.judgment.kind === "derived" ? `Likely parent: ${parentLabel}` : page.judgment.kind === "unclear" ? `Possible parent: ${parentLabel}` : "No parent identified in this trace";
      const confidence = result.mode === "live" && page.judgment.kind === "derived" ? ` · Claude's confidence ${page.judgment.confidence}% (self-reported, not measured)` : "";
      // As the tree tags it: the lead of roots published together (coPublishedLeadOrder) is the origin, the others name it.
      const role = page.judgment.kind === "origin" ? reportRoles.get(page.id) : undefined;
      const together = role && role.lead.id !== page.id ? ` · published together with ${role.lead.domain}` : "";
      return `${index + 1}. [${page.judgment.kind.toUpperCase()}${together}${confidence}${inspectedIds.has(page.id) ? " · marked inspected in trace" : ""}] ${page.title} — ${page.domain}\n   URL: ${page.url || "not saved"}\n   Date: ${page.publishedDate || "unclear"}${page.publishedDateSource ? ` (${page.publishedDateSource})` : ""}${page.publishedDateEvidence ? ` — ${page.publishedDateEvidence}` : ""}\n   Text: ${textSourceLabel(page.extractionSource) || "unknown"}\n   ${relationship}\n   Relationship evidence: ${coPublishedNote(page, reportRoles) ? `${coPublishedNote(page, reportRoles)} ` : ""}${page.judgment.evidence}${page.citations?.length ? `\n   Verified citations: ${page.citations.map((citation) => `${result.pages.find((other) => other.id === citation.pageId)?.domain ?? citation.pageId} (${citation.quote.startsWith("This page's HTML links to") ? "link in page HTML" : citation.how})`).join("; ")}` : ""}${signals ? `\n   Visible clues: parent URL ${signals.linkedParentUrl ? "seen" : "not seen"}; ${signals.sharedPhrases.length} distinctive shared phrase${signals.sharedPhrases.length === 1 ? "" : "s"} in retrieved text; ${Math.round(signals.textOverlap * 100)}% word-for-word overlap with parent passage` : ""}\n   Own evidence: ${page.primaryEvidenceStatus || "unclear"}${page.primaryEvidenceReason ? ` — ${page.primaryEvidenceReason}` : ""}${result.sourceAssessmentsByPageId?.[page.id] ? `\n   Manual relationship assessment: ${result.sourceAssessmentsByPageId[page.id]}` : ""}${result.reviewNotesByPageId?.[page.id] ? `\n   Manual review note: ${result.reviewNotesByPageId[page.id]}` : ""}`;
    });
    const statementReviews = result.answerStatements?.map((statement, index) => {
      const review = result.answerReviews?.[index];
      const sources = statement.sourceIds.map((id) => pagesById.get(id)?.url || id).join(", ");
      return `${index + 1}. ${statement.text}\n   Cited root pages: ${sources}\n   Manual check: ${review?.status ?? "not reviewed"}${review?.note ? `\n   Reviewer note: ${review.note}` : ""}`;
    }) ?? [];
    return [
      "Echo source trace",
      `Claim: ${result.claim}`,
      `Verdict: ${headline}`,
      plainSearch ? plainSearchHeadline(plainSearch) : "",
      // A supplied-sources result has no echo rate: it counts only confirmed copies, so it reads low when most links
      // trace to another supplied link or are unclear; its supplied-links section says which link is which.
      result.sourceCheck ? "" : `Echo rate: ${derivedLabel}`,
      datedSpan ? `Reliably dated pages span: ${datedSpan.from}–${datedSpan.to} (${datedSpan.count} pages; earliest: ${datedSpan.first.title})` : "",
      `Answer status: ${result.answerStatus || "not recorded in this trace"}`,
      rootsOmittedFromAnswer ? `Root pages omitted from the 12-source answer limit: ${rootsOmittedFromAnswer}` : "",
      suppliedRootsNotCited ? `Root pages supplied to the answer model but not cited: ${suppliedRootsNotCited}` : "",
      `Unresolved relationships: ${unresolvedCount}`,
      `Confirmed copies (dated or cited): ${traceSignals.likelyEchoes}`,
      `Possible copies, link not confirmed (not counted as echoes): ${traceSignals.possiblePaths}`,
      `Pages with no reliable date (none, or only a search estimate): ${undatedPages}`,
      `Pages marked inspected in this trace: ${inspectedIds.size}`,
      `Pages with manual review notes: ${Object.keys(result.reviewNotesByPageId ?? {}).length}`,
      `Source judgments challenged by reviewer: ${challengedSourceJudgments}`,
      result.excludedPageCount ? `Off-claim pages excluded: ${result.excludedPageCount}` : "",
      result.demoLabel ? `Data note: ${result.demoLabel}. This graph is a rehearsal fixture, not live research.` : "",
      costReceiptLine(result) ? `Run cost (list-price estimate, not an invoice): ${costReceiptLine(result)}` : "",
      result.importedAt ? (isBundledRun ? `Snapshot note: a saved live run bundled with Echo, captured ${formatRunDate(result.createdAt)}. This trace has not been refreshed.` : `Snapshot note: imported from a saved Echo file on ${result.importedAt}. This trace has not been refreshed.`) : "",
      "",
      // A supplied-sources run read only the pasted links: its section, and a line that no search ran.
      ...(result.sourceCheck ? [...sourceCheckReportLines(result), "", sourceCheckNoSearchLine(result)] : ["Search query audit:", ...queryAudit]),
      "",
      "Pages to inspect (review prompts, not a verdict):",
      ...(result.mode === "demo" ? ["This is a synthetic rehearsal fixture; no live pages were assessed."] : reviewNotes.length ? reviewNotes : ["No pages have the listed review flags in this trace."]),
      "",
      "Root pages (numbers here are not answer citations):",
      ...(roots.length ? roots : ["No confirmed root pages."]),
      "",
      "Page relationships (within this retrieved trace):",
      ...relationships,
      "",
      "Answer from independent origins:",
      displayedAnswer(result),
      "",
      "Answer citations and retrieved passages:",
      ...(answerCitations.length ? answerCitations : ["No root pages were cited in the answer."]),
      "",
      "Statement-by-statement manual checks:",
      ...(statementReviews.length ? statementReviews : ["No structured answer statements were saved in this trace."]),
      "",
      "How echoes were treated in the answer:",
      result.echoContribution,
      "",
      "Method: Source derivation judgments are probabilistic. Inspect marks can be saved or imported and do not change Echo’s verdict. Verify the linked pages before relying on the conclusion.",
    ].filter(Boolean).join("\n");
  };
  // The link to share, from the result on screen (not the address bar, which an earlier slot may have set): a demo
  // slot's ?slot= link, else a ?claim= link that fills the claim box (never runs it).
  // An HTML snippet for a blog or newsroom: the run's badge image, linking to that exact saved run.
  const copyBadge = async () => {
    try {
      const origin = window.location.origin;
      const link = new URL(window.location.pathname, origin);
      for (const [key, value] of Object.entries(shareParamsFor(result))) link.searchParams.set(key, value);
      const alt = `Echo trace: ${verdictHeadline(result)}`.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
      await navigator.clipboard.writeText(`<a href="${link.href}"><img src="${origin}/badge/${traceSlug(bundledTrace!)}" alt="${alt}" height="22"></a>`);
      setBadgeState("copied");
    } catch {
      setBadgeState("error");
    }
    window.setTimeout(() => setBadgeState("idle"), 2200);
  };
  const copyLink = async () => {
    try {
      const link = new URL(window.location.pathname, window.location.origin);
      for (const [key, value] of Object.entries(shareParamsFor(result, isBundledRun))) link.searchParams.set(key, value);
      await navigator.clipboard.writeText(link.href);
      setLinkState("copied");
    } catch {
      setLinkState("error");
    }
    window.setTimeout(() => setLinkState("idle"), 2200);
  };
  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(buildReport());
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    window.setTimeout(() => setCopyState("idle"), 2200);
  };
  const downloadReport = () => {
    const blob = new Blob([buildReport()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const slug = result.claim.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "source-trace";
    link.href = url;
    link.download = `echo-${slug}.txt`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const loadComparison = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > MAX_PORTABLE_TRACE_BYTES) {
      setComparisonError({ baseKey: comparisonBaseKey, message: "That file exceeds Echo’s 2 MB trace limit." });
      return;
    }
    try {
      const analysis = parsePortableTrace(JSON.parse(await file.text()) as unknown);
      if (!analysis) throw new Error("This is not a supported Echo trace file.");
      const normalized = (claim: string) => claim.trim().toLocaleLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
      if (normalized(analysis.claim) !== normalized(result.claim)) throw new Error("Choose a saved trace for this same claim.");
      if (analysis.mode !== result.mode) throw new Error("Compare two live traces or two rehearsal traces, rather than mixing them.");
      setComparison({ baseKey: comparisonBaseKey, analysis, filename: file.name });
      setComparisonError(null);
    } catch (caught) {
      setComparisonError({ baseKey: comparisonBaseKey, message: caught instanceof Error ? caught.message : "Echo could not compare that file." });
    }
  };
  return (
    <section className="result-stack">
      <p className="sr-only" role="status">{isRehearsal ? `Synthetic graph ready. ${result.summary.totalPages} sample ${pageWord} and ${result.summary.independentOrigins} sample ${originWord}.` : `Trace complete. ${result.sourceCheck ? `${linksRead} ${linksRead === 1 ? "link" : "links"} read` : `${result.summary.totalPages} ${pageWord} found`}, ${result.summary.independentOrigins} independent ${originWord}, ${unresolvedCount} unclear ${unresolvedCount === 1 ? "relationship" : "relationships"}.`}</p>
      <div className="result-controls">
        <span className="eyebrow">ANALYSIS RESULT</span>
        <span className={`result-mode-tag ${result.mode === "demo" ? "result-mode-demo" : result.importedAt ? "result-mode-imported" : result.cacheHit ? "result-mode-cached" : "result-mode-live"}`}>
          {result.mode === "demo" ? "ILLUSTRATIVE FIXTURE" : isBundledRun ? `SAVED LIVE RUN · captured ${formatRunDate(result.createdAt)}` : result.importedAt ? "IMPORTED TRACE FILE" : result.cacheHit ? "CACHED LIVE TRACE" : "FRESH LIVE TRACE"}
          {result.searchMode === "deep" && <span className="result-deep-tag"> · DEEP SEARCH</span>}
          {liveSeconds !== undefined && !costReceipt && !result.importedAt && !result.cacheHit && result.mode !== "demo" && <span className="result-run-time"> · {Math.floor(liveSeconds / 60)}:{String(liveSeconds % 60).padStart(2, "0")}</span>}
        </span>
        {costReceipt && <span className="cost-receipt-line" title="Counted tokens and search credits at list prices; an estimate, not an invoice.">{costReceipt}</span>}
        <Link className="result-origins-link" href="/origins">See the origin layer: saved live Telem runs →</Link>
        {/* Outside .result-actions on purpose: its first row stays Present, Copy link, More, New trace. */}
        <OriginLayerToggle result={result} />
        <div className="result-actions">
          <button aria-label="Start judge-facing presentation" className="present-button" onClick={() => setIsPresenting(true)} type="button"><span aria-hidden="true">▶</span> Present</button>
          <button aria-label="Copy a link to this claim" className="new-claim-button copy-link-button" onClick={() => void copyLink()} type="button">
            {linkState === "copied" ? "Link copied" : linkState === "error" ? "Copy unavailable" : "Copy link"}
          </button>
          {/* The rest of the actions sit behind a disclosure: Tab reaches its items; Esc, a click outside or focus leaving closes it. */}
          <div className="result-more" ref={moreRef}>
            <button aria-controls={moreMenuId} aria-expanded={moreOpen} className="new-claim-button result-more-button" onClick={() => setMoreOpen((open) => !open)} ref={moreButton} type="button">More <span aria-hidden="true">{moreOpen ? "▴" : "▾"}</span></button>
            {moreOpen && <div aria-label="More actions" className="result-more-menu" id={moreMenuId} role="group">
              <button aria-label="Copy this source trace as a text report" className="new-claim-button" onClick={() => void copyReport()} type="button">
                {copyState === "copied" ? "Report copied" : copyState === "error" ? "Copy unavailable" : "Copy report"}
              </button>
              <button aria-label="Download this source trace as a text report" className="new-claim-button" onClick={() => { downloadReport(); closeMore(true); }} type="button">Download report</button>
              <button aria-label="Print a one-page report of this trace" className="new-claim-button print-report-button" onClick={() => { closeMore(true); window.print(); }} type="button">Print report</button>
              {bundledTrace && <button aria-label="Copy an embeddable badge for this saved run" className="new-claim-button copy-badge-button" onClick={() => void copyBadge()} type="button">{badgeState === "copied" ? "Badge copied" : badgeState === "error" ? "Copy unavailable" : "Embed badge"}</button>}
              <button aria-label="Download this source trace as a portable JSON file" className="new-claim-button" onClick={() => { downloadPortableTrace(result); closeMore(true); }} type="button">Save trace file</button>
              <button aria-label="Open a saved Echo trace file" className="new-claim-button" onClick={() => { closeMore(true); onOpenTrace(); }} type="button">Open trace file</button>
              {/* Offered only for a trace this browser will keep: a demo claim's run must pass the pinned-cache rule, and
                  a Check these sources run is never kept (both are refused by saveCached and saveRecentTrace). */}
              {result.importedAt && !isBundledRun && canKeepInBrowser(result) && <button aria-label="Save this imported trace in this browser" className="new-claim-button" disabled={isSavedHere} onClick={onSaveImported} type="button">{isSavedHere ? "Saved here" : "Keep in browser"}</button>}
              <button aria-label="Compare this result with a saved Echo trace file" className="new-claim-button" onClick={() => { closeMore(true); comparisonInput.current?.click(); }} type="button">Compare runs</button>
              {previousTrace && previousTrace.createdAt !== result.createdAt && <button aria-label="Compare this result with the previous browser trace" className="new-claim-button" onClick={() => { closeMore(true); setComparison({ baseKey: comparisonBaseKey, analysis: previousTrace, filename: "Previous browser trace" }); }} type="button">Compare prior run</button>}
            </div>}
          </div>
          <input accept=".echo.json,.json,application/json" aria-label="Select a saved Echo trace to compare" className="sr-only" onChange={(event) => void loadComparison(event)} ref={comparisonInput} tabIndex={-1} type="file" />
          <button className="new-claim-button" onClick={onReset} type="button">New trace <span>↗</span></button>
        </div>
      </div>
      {/* A supplied-sources result has one verdict card, its own above this toolbar (SourceCheckSummary), which carries
          the tiles in links; the generic banner (and its echo rate) would repeat it in page words. */}
      {!result.sourceCheck && <div className={`verdict-banner ${isGhost ? "verdict-ghost" : ""}`}>
        <div className="verdict-copy">
            <div className="verdict-topline"><span className="verdict-icon">{isGhost ? "?" : "↳"}</span><span className="eyebrow">{isRehearsal ? "ILLUSTRATIVE GRAPH" : "SOURCE INDEPENDENCE VERDICT"}</span></div>
          <h2>{headline}</h2>
          <p>{verdictText}{result.excludedPageCount ? ` ${result.excludedPageCount} off-claim ${result.excludedPageCount === 1 ? "page was" : "pages were"} excluded.` : ""} <strong>{derivedLabel}</strong></p>
          {!isRehearsal && <p className="page-breakdown-line">{pageBreakdownLine(result)}</p>}
        </div>
        <div className="verdict-stats">
          <div><strong>{result.summary.totalPages}</strong><span>{isRehearsal ? `sample ${pageWord}` : `${pageWord} found`}</span></div>
          <div><strong>{result.summary.independentOrigins}</strong><span>{isRehearsal ? `sample ${originWord}` : `independent ${originWord}`}</span></div>
          <div><strong>{result.summary.verifiableOrigins}</strong><span>{isRehearsal ? "sample, with own evidence" : "with own evidence"}</span></div>
        </div>
      </div>}
      {plainSearch && <div className="plain-search-line" title={plainSearchTooltip(plainSearch)}><span className="plain-search-label">PLAIN SEARCH VS ECHO</span><span className="sr-only">: </span><p className="plain-search-primary">{plainSearchHeadline(plainSearch)}</p><p className="plain-search-detail">{plainSearchDetail(plainSearch)}</p></div>}
      <EvidenceFunnelView result={result} runKind={isBundledRun ? "saved live run bundled with Echo" : result.importedAt ? "imported trace file" : result.cacheHit ? "cached live trace (this view spent nothing)" : "fresh live run"} />
      {/* Opt-in (the toolbar's "Origin layer" button or Shift+O, kept in this browser): renders nothing otherwise. */}
      <OriginLayerPanel onSelect={onSelect} result={result} />

      {!isRehearsal && <div aria-label="Trace quality at a glance" className="trace-signal-strip">{datedSpan && <span className="trace-signal-span"><button onClick={() => { onSelect(datedSpan.first.id); window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".map-layout .detail-card")?.scrollIntoView({ behavior: "smooth", block: "start" })); }} title={`Open the earliest reliably dated page: ${datedSpan.first.title}`} type="button"><strong>{datedSpan.from}–{datedSpan.to}</strong></button> spanned by {datedSpan.count} reliably dated pages</span>}<span><strong>{traceSignals.likelyEchoes}</strong> confirmed {traceSignals.likelyEchoes === 1 ? "copy" : "copies"} (dated or cited)</span><span><strong>{traceSignals.possiblePaths}</strong> possible {traceSignals.possiblePaths === 1 ? "copy" : "copies"}, link not confirmed</span><span title="No date, or only a search engine's estimate"><strong>{undatedPages}</strong> {undatedPages === 1 ? "page has" : "pages have"} no reliable date</span>{challengedSourceJudgments > 0 && <span className="trace-signal-challenged"><strong>{challengedSourceJudgments}</strong> source {challengedSourceJudgments === 1 ? "judgment" : "judgments"} challenged by reviewer</span>}<small>A possible copy counts as an echo only once a date or a citation confirms the link. Your own review marks do not change this verdict.</small></div>}

      {activeComparisonError && <div className="comparison-error" role="alert">{activeComparisonError}<button aria-label="Dismiss comparison error" onClick={() => setComparisonError(null)} type="button">×</button></div>}
      {activeComparison && <TraceComparison current={result} filename={activeComparison.filename} onClose={() => setComparison(null)} onSelect={onSelect} previous={activeComparison.analysis} />}

      {!isRehearsal && <EchoSpread onSelect={(id) => { onSelect(id); window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".map-layout .detail-card")?.scrollIntoView({ behavior: "smooth", block: "start" })); }} result={result} selectedId={selectedId} />}
      <HowEchoChecked result={result} />
      <RootEvidenceLedger onSelect={onSelect} result={result} />
      <AccuracyCard result={result} />
      <CopyHuntPanel onUpdateResult={onUpdateResult} result={result} />
      <EvidenceCoverage onSelect={onSelect} result={result} />
      <SearchAudit onSelect={onSelect} result={result} />

      {result.demoLabel && <div className="demo-notice"><span>UI REHEARSAL</span><p>{result.demoLabel}. These placeholder edges are not pre-tested findings. Run this exact claim live to save a real cache on this device.</p></div>}
      {result.importedAt && <div className="imported-notice"><span>{isBundledRun ? "SAVED LIVE RUN" : "IMPORTED SNAPSHOT"}</span><p>{isBundledRun ? `A real Echo run captured on ${formatRunDate(result.createdAt)} and saved with the app.` : `This analysis was created on ${formatRunDate(result.createdAt)}.`} It is displayed as captured and has not been refreshed against current sources.</p></div>}

      <div className="map-layout">
        <section className="map-card">
          <div className="section-heading map-heading">
            <div><span className="eyebrow">THE SOURCE FAMILY TREE</span><h2>Where the story travels</h2></div>
            <TreeLegend result={result} />
          </div>
          <SourceExplorer onSelect={onSelect} onSourceQueryChange={setSourceQuery} result={result} selectedId={selectedId} sourceQuery={sourceQuery} />
          <div className="map-footnote">Solid arrows indicate a probable earlier source. Dashed lines and missing dates stay uncertain.</div>
        </section>
        <SourceDetail claim={result.claim} coPublishedGroups={result.coPublishedRootGroups} details={selected && result.mode === "live" ? pageDetails(result, selected, suppliedNumbersByPageId(result).get(selected.id)) : null} pairNote={selected ? coPublishedNote(selected, coPublishedRoles(result)) : null} assessment={selected ? result.sourceAssessmentsByPageId?.[selected.id] ?? null : null} inspected={Boolean(selected && inspectedIds.has(selected.id))} nextReviewPage={nextReviewPage} onAssessmentChange={updateSourceAssessment} onReviewNoteChange={updateReviewNote} onSelect={onSelect} onToggleInspected={toggleInspected} page={selected} pages={result.pages} reviewNote={selected ? result.reviewNotesByPageId?.[selected.id] ?? "" : ""} sourceQuery={sourceQuery} uninspectedReviewCount={uninspectedReviewPages.length} />
      </div>

      <section className="answer-card">
        <div className="answer-heading">
          <span className="answer-icon">✳</span>
          <div>
            <span className="eyebrow">{result.answerStatus === "unavailable" ? "SOURCE TREE COMPLETE" : sourceLimited ? "ROOT EVIDENCE LIMITED" : "ANSWER FROM THE ORIGINS"}</span>
            <h2>{result.answerStatus === "unavailable" ? "Review the source pages directly" : sourceLimited ? "What these origins cannot verify yet" : "What the independent sources support"}</h2>
          </div>
          <span className="origin-only-badge">{result.answerStatus === "unavailable" ? "ANSWER UNAVAILABLE" : sourceLimited ? "NO MODEL SYNTHESIS" : "ORIGINS ONLY"}</span>
        </div>
        <p className="answer-text">{formatCitationText(result)}</p>
        <div className="echo-note"><span>HOW ECHOES WERE TREATED</span><p>{result.echoContribution}</p></div>
        <div className="answer-sources">
          <span className="eyebrow">ORIGINS CITED IN THE ANSWER</span>
          <div className="source-chip-list">
            {result.answerSourceIds.length ? result.answerSourceIds.map((id, index) => {
              const page = pagesById.get(id);
              if (!page) return null;
              return page.url ? (
                <a className="source-chip" href={page.url} key={id} rel="noreferrer" target="_blank" title={page.title}><span>[{answerNumbers[index]}]</span>{sourceLinkLabel(page, result.answerSourceIds.map((other) => pagesById.get(other)))}<b>↗</b></a>
              ) : (
                <span className="source-chip source-chip-muted" key={id} title={page.title}><span>[{answerNumbers[index]}]</span>{sourceLinkLabel(page, result.answerSourceIds.map((other) => pagesById.get(other)))}</span>
              );
            }) : <span className="no-sources">No origin pages were available for the answer.</span>}
          </div>
        </div>
        {(rootsOmittedFromAnswer > 0 || suppliedRootsNotCited > 0) && <p className="answer-coverage-note">{rootsOmittedFromAnswer > 0 ? `${rootsOmittedFromAnswer} other root ${rootsOmittedFromAnswer === 1 ? "page was" : "pages were"} outside this answer’s 12-source limit. ` : ""}{suppliedRootsNotCited > 0 ? `${suppliedRootsNotCited} supplied root ${suppliedRootsNotCited === 1 ? "page was" : "pages were"} not cited in the generated answer. ` : ""}Inspect the root evidence ledger for the full set.</p>}
        {result.answerSourceIds.length > 0 && <details className="answer-evidence">
          <summary>Inspect cited passages <span>{result.answerSourceIds.length} {result.answerSourceIds.length === 1 ? "source" : "sources"}</span></summary>
          <p>These are the saved passages supplied to the answer model. Read the original page before treating a citation as proof.</p>
          <div className="answer-evidence-list">
            {result.answerSourceIds.map((id, index) => {
              const page = pagesById.get(id);
              if (!page) return null;
              return <section className="answer-evidence-item" key={id}>
                <div><strong>[{answerNumbers[index]}] {page.title}</strong><span>{page.domain} · {textSourceLabel(page.extractionSource) || "Extraction method unclear"}{page.publishedDate ? ` · ${page.publishedDate}` : " · date unclear"}</span></div>
                <blockquote>{page.text || "No passage was saved for this source."}</blockquote>
                {page.url && <a href={page.url} rel="noreferrer" target="_blank">Open original page ↗</a>}
              </section>;
            })}
          </div>
        </details>}
        {result.mode === "live" && result.answerStatus === "generated" && Boolean(result.answerStatements?.length) && <details className="answer-review">
          <summary>Review answer statements <span>{reviewedAnswerStatements}/{result.answerStatements?.length ?? 0} checked{unsupportedAnswerStatements ? ` · ${unsupportedAnswerStatements} marked unsupported` : ""}{unmatchedAnswerNumbers ? ` · ${unmatchedAnswerNumbers} ${unmatchedAnswerNumbers === 1 ? "number" : "numbers"} not in cited passages` : ""}</span></summary>
          <p>Open the original cited pages before marking a statement. These are your manual checks, saved in the trace; they do not change Echo’s automated verdict.</p>
          <ol>{result.answerStatements?.map((statement, index) => {
            const review = result.answerReviews?.[index];
            return <li key={index}>
              <strong>{statement.text}</strong>
              {numberGrounding[index]?.numbers.length ? <p className={`answer-number-check${numberGrounding[index].unmatchedNumbers.length ? " is-unmatched" : ""}`}>{numberGrounding[index].unmatchedNumbers.length ? `Not found in the cited passages: ${numberGrounding[index].unmatchedNumbers.join(", ")}. Check the original page before relying on this number.` : `Every number here (${numberGrounding[index].numbers.join(", ")}) appears in a cited passage. That does not prove the statement.`}</p> : null}
              <div className="answer-review-sources">{statement.sourceIds.map((id) => {
                const page = pagesById.get(id);
                const number = answerNumbers[result.answerSourceIds.indexOf(id)] ?? result.answerSourceIds.indexOf(id) + 1;
                return page?.url ? <a href={page.url} key={id} rel="noreferrer" target="_blank">[{number}] {page.domain} ↗</a> : <span key={id}>[{number}] source unavailable</span>;
              })}</div>
              <div className="answer-review-choices">{(["supported", "unsupported", "unclear"] as const).map((status) => <button aria-pressed={review?.status === status} className={`answer-review-choice-${status}`} key={status} onClick={() => updateAnswerReview(index, { status })} type="button">{status === "supported" ? "Supported" : status === "unsupported" ? "Not supported" : "Unclear"}</button>)}{review?.status && <button onClick={() => updateAnswerReview(index, { status: null })} type="button">Clear check</button>}</div>
              <label htmlFor={`answer-review-note-${index}`}>Review note <span>{review?.note.length ?? 0}/600</span></label>
              <textarea id={`answer-review-note-${index}`} maxLength={600} onChange={(event) => updateAnswerReview(index, { note: event.target.value })} placeholder="Which line of the source supports or challenges this statement?" rows={2} value={review?.note ?? ""} />
            </li>;
          })}</ol>
        </details>}
      </section>
      <p className="method-note"><span>METHOD NOTE</span> Derivation judgments are probabilistic. Search-engine dates can reflect updates; check the date source, and keep unknown chronology unclear. The answer uses confirmed origins only.</p>
      {portalReady ? createPortal(<PrintReport headline={headline} modeLabel={printModeLabel} result={result} verdictText={verdictText} />, document.body) : null}
      {isPresenting && portalReady ? createPortal(<StagePresentation isBundledRun={isBundledRun} onClose={() => setIsPresenting(false)} onSelect={onSelect} result={result} selectedId={selectedId} verdict={headline} verdictText={verdictText} />, document.body) : null}
    </section>
  );
}

/** A page date for the printed report, marked when it is only a search engine's estimate. */
function printedDate(page: EchoPage) {
  if (!page.publishedDate) return "date unclear";
  return `${formatDate(page.publishedDate)}${page.publishedDateSource === "Tavily estimate" ? " (search estimate)" : ""}`;
}

// A page has room for about this many of each; the rest are counted and left to the downloaded report.
const PRINTED_ROOTS = 10;
const PRINTED_COPIES = 10;

/**
 * The one-page printed report (Cmd+P or More → Print report): verdict, plain-search line, origins, confirmed copies
 * with what Echo saw on each link, the answer, the caveats and the trace date. Hidden on screen; in print it is the
 * only thing on the page (globals.css), so no control prints.
 */
function PrintReport({ result, headline, verdictText, modeLabel }: { result: EchoAnalysis; headline: string; verdictText: string; modeLabel: string }) {
  const pagesById = new Map(result.pages.map((page) => [page.id, page] as const));
  const isRehearsal = result.mode === "demo";
  const originWord = result.summary.independentOrigins === 1 ? "origin" : "origins";
  const plainSearch = plainSearchLineage(result);
  const coPublished = new Map<string, string[]>();
  for (const group of result.coPublishedRootGroups ?? []) for (const id of group) coPublished.set(id, group.filter((other) => other !== id).map((other) => pagesById.get(other)?.domain ?? other));
  const roots = result.roots.map((id) => pagesById.get(id)).filter((page): page is EchoPage => Boolean(page));
  const copies = result.pages.filter((page) => page.judgment.kind === "derived" && page.judgment.parentId && pagesById.has(page.judgment.parentId));
  const unclear = result.pages.filter((page) => page.judgment.kind === "unclear").length;
  const score = result.mode === "live" ? Object.values(DEMO_SCORES).find((entry) => entry.traceCreatedAt === result.createdAt) : undefined;
  const labels = score ? scoreSentence(result, score) : "";
  // A supplied-sources result is headed by its links ("5 supplied links → 1 independent origin") and says no search ran.
  const sourcesHeadline = result.sourceCheck ? sourceCheckHeadline(result) : null;
  return (
    <section aria-label="Printable trace report" className="print-report">
      <header className="print-head">
        <span>ECHO SOURCE TRACE · {modeLabel}{result.sourceCheck ? " · SUPPLIED LINKS, NO WEB SEARCH" : ""}</span>
        <h1>“{result.claim}”</h1>
      </header>
      <div className="print-verdict">
        <h2>{sourcesHeadline ? `${sourcesHeadline.text}${sourcesHeadline.evidence ? ` (${sourcesHeadline.evidence})` : ""}` : headline}</h2>
        <p>{verdictText} {!result.sourceCheck && <><b>{result.summary.echoPercentage}% echo</b> · </>}{result.summary.totalPages} {result.summary.totalPages === 1 ? "page" : "pages"} · {result.summary.independentOrigins} {isRehearsal ? "sample" : "independent"} {originWord}, {withOwnEvidence(result.summary.verifiableOrigins)}</p>
        {plainSearch && <p className="print-plain">{plainSearchHeadline(plainSearch)}</p>}
      </div>
      <PrintSourceLinks result={result} />
      <div className="print-columns">
        <section className="print-origins">
          <h3>{isRehearsal ? "Sample origins" : "Independent origins"}</h3>
          {roots.length > result.summary.independentOrigins && <p className="print-muted print-root-note">{roots.length} root pages; pages published together count as one origin.</p>}
          {roots.length ? <ol>{roots.slice(0, PRINTED_ROOTS).map((page) => <li key={page.id}><b>{page.domain}</b> · {printedDate(page)} · {isRehearsal ? "not assessed" : page.primaryEvidenceStatus === "found" ? "own evidence found" : page.primaryEvidenceStatus === "not found" ? "no own evidence identified" : "own evidence unclear"}{coPublished.has(page.id) ? ` · same publication as ${coPublished.get(page.id)!.join(", ")}` : ""}<small>{page.title}</small></li>)}</ol> : <p>No page was confirmed as an independent origin.</p>}
          {roots.length > PRINTED_ROOTS && <p className="print-muted">{roots.length - PRINTED_ROOTS} more root {roots.length - PRINTED_ROOTS === 1 ? "page is" : "pages are"} in the full report (More → Download report).</p>}
        </section>
        <section className="print-copies">
          <h3>{isRehearsal ? "Sample copies" : "Confirmed copies"}</h3>
          {copies.length ? <ol>{copies.slice(0, PRINTED_COPIES).map((page) => {
            const parent = pagesById.get(page.judgment.parentId!)!;
            const seen = isRehearsal ? null : edgeSentence(page, parent, result);
            return <li key={page.id}><b>{page.domain}</b> → <b>{parent.domain}</b><small className="print-edge">{seen ?? "Claude judged it a copy; no date order, citation or shared phrase is shown for this link."}</small></li>;
          })}</ol> : <p>No page was confirmed as a copy.</p>}
          {copies.length > PRINTED_COPIES && <p className="print-muted">{copies.length - PRINTED_COPIES} more confirmed {copies.length - PRINTED_COPIES === 1 ? "copy is" : "copies are"} in the full report (More → Download report).</p>}
          {unclear > 0 && <p className="print-muted">{unclear} {unclear === 1 ? "page stays" : "pages stay"} unclear (no confirmed link) and {unclear === 1 ? "is" : "are"} not listed.</p>}
        </section>
      </div>
      <section className="print-answer">
        <h3>Answer from the origins only</h3>
        <p>{displayedAnswer(result)}</p>
        {result.answerSourceIds.length > 0 && <p className="print-muted">{result.answerSourceIds.map((id, index) => { const page = pagesById.get(id); return `[${answerCitationNumbers(result)[index]}] ${page ? `${page.domain}, ${printedDate(page)}` : "source unavailable"}`; }).join(" · ")}</p>}
      </section>
      <footer className="print-caveat">
        <p><b>AI-made labels.</b> Which pages are origins and which are copies are Claude&apos;s judgments from dates, citations and shared wording. {labels ? `${labels} ` : "This run has not been checked against labels. "}The labels Echo is checked against were made by an AI from the full pages, not by a person.</p>
        <p>An origin is the best-supported starting point among {result.sourceCheck ? "the supplied links" : "the pages Echo found"}, not the first page on the whole web. A citation identifies a source a page names; it does not show the claim is true.</p>
        <p className="print-date">Trace date: {formatRunDate(result.createdAt)}{result.importedAt && !isRehearsal ? " · displayed as captured, not refreshed" : ""}</p>
      </footer>
    </section>
  );
}

/** A run's echo rate in Compare runs: "—" for a supplied-links run, whose result deliberately shows none. */
function echoRateCell(analysis: EchoAnalysis): string {
  return analysis.sourceCheck ? "— (not shown for supplied links)" : `${analysis.summary.echoPercentage}%`;
}

function TraceComparison({ current, previous, filename, onClose, onSelect }: { current: EchoAnalysis; previous: EchoAnalysis; filename: string; onClose: () => void; onSelect: (id: string) => void }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const currentByKey = new Map(current.pages.map((page) => [comparisonPageKey(page), page] as const));
  const previousByKey = new Map(previous.pages.map((page) => [comparisonPageKey(page), page] as const));
  const onlyCurrent = [...currentByKey].filter(([key]) => !previousByKey.has(key)).map(([, page]) => page);
  const onlyPrevious = [...previousByKey].filter(([key]) => !currentByKey.has(key)).map(([, page]) => page);
  const sharedCount = [...currentByKey.keys()].filter((key) => previousByKey.has(key)).length;
  const rootPages = (analysis: EchoAnalysis) => {
    const byId = new Map(analysis.pages.map((page) => [page.id, page] as const));
    return analysis.roots.map((id) => byId.get(id)).filter((page): page is EchoPage => Boolean(page));
  };
  const currentRootPages = rootPages(current);
  const previousRootPages = rootPages(previous);
  const currentRoots = new Set(currentRootPages.map(comparisonPageKey));
  const previousRoots = new Set(previousRootPages.map(comparisonPageKey));
  const gainedRootPages = currentRootPages.filter((page) => !previousRoots.has(comparisonPageKey(page)));
  const lostRootPages = previousRootPages.filter((page) => !currentRoots.has(comparisonPageKey(page)));
  const relationshipChanges = changedSourceRelationships(current, previous);
  const answerComparison = compareAnswerEvidence(current, previous);
  const answerReviewComparison = compareAnswerReviews(current, previous);
  const sourceReviewComparison = compareSourceReviews(current, previous);
  const searchChanges = changedSearchCoverage(current, previous);
  const searchState = (entry: SearchQueryAudit | null) => entry ? `${entry.status} · ${entry.matchingResults}/${entry.totalResults} relevant · ${entry.uniquePagesAdded} new` : "not in trace";
  const answerReviewState = (review: { status: string | null; note: string } | null) => review ? `${review.status ?? "unchecked"}${review.note ? ` — ${review.note}` : ""}` : "no check saved";
  const sourceReviewState = (inspected: boolean, assessment: SourceAssessment | null, note: string) => `${inspected ? "marked inspected" : "not marked inspected"}${assessment ? ` · judgment ${assessment}` : ""}${note ? ` — ${note}` : ""}`;
  const sourceLabel = (analysis: EchoAnalysis, page: EchoPage) => {
    if (!page.judgment.parentId) return "none";
    const parent = analysis.pages.find((candidate) => candidate.id === page.judgment.parentId);
    return parent ? `${parent.title} (${parent.domain})` : "unresolved";
  };
  const relationshipState = (analysis: EchoAnalysis, page: EchoPage) => [
    page.judgment.kind,
    `source: ${sourceLabel(analysis, page)}`,
    `date: ${page.publishedDate ?? "unclear"}${page.publishedDateSource ? ` (${page.publishedDateSource})` : ""}`,
    `own evidence: ${page.primaryEvidenceStatus ?? (page.hasPrimaryEvidence ? "found" : "unclear")}`,
    `root page: ${analysis.roots.includes(page.id) ? "yes" : "no"}`,
  ].join(" · ");
  const metrics = [
    ["Pages", current.summary.totalPages, previous.summary.totalPages],
    ["Independent origins", current.summary.independentOrigins, previous.summary.independentOrigins],
    ["With own evidence", current.summary.verifiableOrigins, previous.summary.verifiableOrigins],
    // A supplied-links result shows no echo rate (it counts only confirmed copies among the links), so neither does this.
    ["Echo rate", echoRateCell(current), echoRateCell(previous)],
  ];
  const renderPageList = (pages: EchoPage[], emptyMessage: string) => pages.length ? <ul>{pages.map((page) => <li key={comparisonPageKey(page)}>{page.url ? <a href={page.url} rel="noreferrer" target="_blank">{page.title} ↗</a> : <span>{page.title}</span>}<small>{page.domain}</small></li>)}</ul> : <p>{emptyMessage}</p>;
  const inspectCurrent = (id: string) => {
    onSelect(id);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".map-layout .detail-card")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };
  // A web-search run and a supplied-links run (Check these sources) read different pages by design (QA #8).
  const modeNote = Boolean(current.sourceCheck) === Boolean(previous.sourceCheck) ? null
    : `${current.sourceCheck ? "The current run read only the supplied links (no web search); the saved run searched the web." : "The current run searched the web; the saved run read only the supplied links (no web search)."} Their pages and counts are not like for like.`;
  const copySummary = async () => {
    const list = (pages: EchoPage[]) => pages.length ? pages.map((page) => `- ${page.title} — ${page.url || page.domain}`) : ["- None"];
    const text = [
      "Echo trace comparison",
      `Claim: ${current.claim}`,
      `Current: ${current.createdAt}`,
      `Saved: ${previous.createdAt} (${filename})`,
      ...(modeNote ? [modeNote] : []),
      `Shared pages: ${sharedCount}`,
      `Only in current: ${onlyCurrent.length}`,
      `Only in saved: ${onlyPrevious.length}`,
      `New root pages: ${gainedRootPages.length}`,
      `Root pages absent now: ${lostRootPages.length}`,
      `Shared pages with changed source records: ${relationshipChanges.length}`,
      `Answer text changed: ${answerComparison.answerChanged ? "yes" : "no"}`,
      `Answer status: current ${current.answerStatus ?? "not recorded"}, saved ${previous.answerStatus ?? "not recorded"}`,
      `Cited sources added: ${answerComparison.citedSourcesAdded.length}`,
      `Cited sources removed: ${answerComparison.citedSourcesRemoved.length}`,
      `Answer statements checked: current ${answerReviewComparison.currentReviewed}/${answerReviewComparison.currentTotal}, saved ${answerReviewComparison.previousReviewed}/${answerReviewComparison.previousTotal}`,
      `Changed manual answer checks: ${answerReviewComparison.changed.length}`,
      `Pages marked inspected: current ${sourceReviewComparison.currentInspected}, saved ${sourceReviewComparison.previousInspected}`,
      `Changed source reviews on shared pages: ${sourceReviewComparison.changed.length}`,
      `Search variants with changed coverage: ${searchChanges.length}`,
      ...metrics.map(([label, now, then]) => `${label}: current ${now}, saved ${then}`),
      "",
      "Only in current run:", ...list(onlyCurrent),
      "",
      "Only in saved run:", ...list(onlyPrevious),
      "",
      "New root pages:", ...list(gainedRootPages),
      "",
      "Root pages absent now:", ...list(lostRootPages),
      "",
      "Answer in current run:", displayedAnswer(current),
      "Answer in saved run:", displayedAnswer(previous),
      "",
      "Newly cited sources:", ...list(answerComparison.citedSourcesAdded),
      "Previously cited sources no longer cited:", ...list(answerComparison.citedSourcesRemoved),
      "",
      "Changed manual answer checks:",
      ...(answerReviewComparison.changed.length ? answerReviewComparison.changed.flatMap(({ statement, current: now, previous: then }) => [
        `- ${statement}`,
        `  Current: ${answerReviewState(now)}`,
        `  Saved: ${answerReviewState(then)}`,
      ]) : ["- None"]),
      "",
      "Changed source reviews on shared pages:",
      ...(sourceReviewComparison.changed.length ? sourceReviewComparison.changed.flatMap(({ page, currentInspected, previousInspected, currentNote, previousNote, currentAssessment, previousAssessment }) => [
        `- ${page.title} — ${page.url || page.domain}`,
        `  Current: ${sourceReviewState(currentInspected, currentAssessment, currentNote)}`,
        `  Saved: ${sourceReviewState(previousInspected, previousAssessment, previousNote)}`,
      ]) : ["- None"]),
      "",
      "Changed source records on shared pages:",
      ...(relationshipChanges.length ? relationshipChanges.flatMap(({ page, previousPage, changes }) => [
        `- ${page.title} — ${page.url || page.domain} (${changes.join(", ")})`,
        `  Current: ${relationshipState(current, page)}`,
        `  Saved: ${relationshipState(previous, previousPage)}`,
        ...(changes.includes("retrieved passage") ? [`  Current passage (${page.extractionSource ?? "method unclear"}): ${page.text}`, `  Saved passage (${previousPage.extractionSource ?? "method unclear"}): ${previousPage.text}`] : []),
      ]) : ["- None"]),
      "",
      "Changed search coverage:",
      ...(searchChanges.length ? searchChanges.flatMap(({ query, current: now, previous: then }) => [
        `- ${query}`,
        `  Current: ${searchState(now)}`,
        `  Saved: ${searchState(then)}`,
      ]) : ["- None"]),
      "",
      "Changes in search coverage or source judgments do not alone establish that the claim changed.",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    window.setTimeout(() => setCopyState("idle"), 2200);
  };

  return (
    <section aria-label="Compare saved runs" className="trace-comparison">
      <div className="trace-comparison-heading"><div><span className="eyebrow">OFFLINE TRACE COMPARISON</span><h3>What changed between runs?</h3><p>Current: {formatRunDate(current.createdAt)} · Saved: {formatRunDate(previous.createdAt)} · {filename}</p>{modeNote && <p className="trace-comparison-mode-note">{modeNote}</p>}</div><div className="trace-comparison-actions"><button onClick={() => void copySummary()} type="button">{copyState === "copied" ? "Copied" : copyState === "error" ? "Copy unavailable" : "Copy comparison"}</button><button aria-label="Close trace comparison" onClick={onClose} type="button">×</button></div></div>
      <div className="trace-comparison-summary"><span><strong>{sharedCount}</strong> shared {sharedCount === 1 ? "page" : "pages"}</span><span><strong>{onlyCurrent.length}</strong> only in current</span><span><strong>{onlyPrevious.length}</strong> only in saved</span><span><strong>{gainedRootPages.length}</strong> new root {gainedRootPages.length === 1 ? "page" : "pages"}</span><span><strong>{lostRootPages.length}</strong> root {lostRootPages.length === 1 ? "page" : "pages"} absent now</span><span><strong>{relationshipChanges.length}</strong> changed source {relationshipChanges.length === 1 ? "record" : "records"}</span><span><strong>{answerComparison.answerChanged || answerComparison.statusChanged || answerComparison.citedSourcesAdded.length || answerComparison.citedSourcesRemoved.length ? "Changed" : "Same"}</strong> answer evidence</span><span><strong>{answerReviewComparison.changed.length}</strong> changed answer checks</span><span><strong>{sourceReviewComparison.changed.length}</strong> changed source reviews</span></div>
      <table className="trace-comparison-metrics"><thead><tr><th scope="col">Measure</th><th scope="col">Current</th><th scope="col">Saved</th></tr></thead><tbody>{metrics.map(([label, now, then]) => <tr key={label}><th scope="row">{label}</th><td>{now}</td><td>{then}</td></tr>)}</tbody></table>
      <section className="trace-comparison-answer"><h4>Answer and citations</h4><p>Answer text {answerComparison.answerChanged ? "changed" : "is unchanged"}; status {answerComparison.statusChanged ? "changed" : "is unchanged"}. Cited pages are matched by normalized URL, so new page IDs do not count as source changes.</p><div className="trace-comparison-lists"><div><h4>Current · {current.answerStatus ?? "status not recorded"}</h4><p>{displayedAnswer(current)}</p></div><div><h4>Saved · {previous.answerStatus ?? "status not recorded"}</h4><p>{displayedAnswer(previous)}</p></div></div><div className="trace-comparison-lists"><div><h4>Newly cited sources</h4>{renderPageList(answerComparison.citedSourcesAdded, "No newly cited sources.")}</div><div><h4>Sources no longer cited</h4>{renderPageList(answerComparison.citedSourcesRemoved, "No cited sources were removed.")}</div></div></section>
      {(answerReviewComparison.currentTotal || answerReviewComparison.previousTotal) ? <details className="trace-comparison-reviews"><summary>Manual answer checks <span>{answerReviewComparison.changed.length} changed · current {answerReviewComparison.currentReviewed}/{answerReviewComparison.currentTotal} checked · saved {answerReviewComparison.previousReviewed}/{answerReviewComparison.previousTotal} checked</span></summary><div>{answerReviewComparison.changed.length ? <ul>{answerReviewComparison.changed.map(({ statement, current: now, previous: then }, index) => <li key={`${statement}-${index}`}><strong>{statement}</strong><span><b>Current</b> {answerReviewState(now)}</span><span><b>Saved</b> {answerReviewState(then)}</span></li>)}</ul> : <p>No saved manual checks changed for matching answer statements.</p>}<small>Statements are matched by text and cited page URL. A changed answer may replace one statement with another.</small></div></details> : null}
      {(current.inspectedPageIds?.length || previous.inspectedPageIds?.length || Object.keys(current.reviewNotesByPageId ?? {}).length || Object.keys(previous.reviewNotesByPageId ?? {}).length || Object.keys(current.sourceAssessmentsByPageId ?? {}).length || Object.keys(previous.sourceAssessmentsByPageId ?? {}).length) ? <details className="trace-comparison-reviews"><summary>Manual source reviews <span>{sourceReviewComparison.changed.length} changed on shared pages · current {sourceReviewComparison.currentInspected} marked inspected · saved {sourceReviewComparison.previousInspected}</span></summary><div>{sourceReviewComparison.changed.length ? <ul>{sourceReviewComparison.changed.map(({ page, currentInspected, previousInspected, currentNote, previousNote, currentAssessment, previousAssessment }) => <li key={comparisonPageKey(page)}><strong>{page.url ? <a href={page.url} rel="noreferrer" target="_blank">{page.title} ↗</a> : page.title}</strong><span><b>Current</b> {sourceReviewState(currentInspected, currentAssessment, currentNote)}</span><span><b>Saved</b> {sourceReviewState(previousInspected, previousAssessment, previousNote)}</span></li>)}</ul> : <p>No inspection marks, assessments, or notes changed on shared pages.</p>}<small>These are saved reviewer records, not source verification. Added or removed pages appear separately above.</small></div></details> : null}
      <div className="trace-comparison-lists"><div><h4>Only in current run</h4>{renderPageList(onlyCurrent, "No new page URLs in this run.")}</div><div><h4>Only in saved run</h4>{renderPageList(onlyPrevious, "No page URLs disappeared from this run.")}</div></div>
      <div className="trace-comparison-lists"><div><h4>New root pages</h4>{renderPageList(gainedRootPages, "No new root pages.")}</div><div><h4>Root pages absent now</h4>{renderPageList(lostRootPages, "No former root pages are absent.")}</div></div>
      <div className="trace-comparison-changes"><h4>Source records on shared pages</h4>{relationshipChanges.length ? <ul>{relationshipChanges.map(({ page, previousPage, changes }) => <li key={comparisonPageKey(page)}><div className="trace-comparison-change-heading">{page.url ? <a href={page.url} rel="noreferrer" target="_blank">{page.title} ↗</a> : <strong>{page.title}</strong>}<span>{changes.join(" · ")}</span></div><p><b>Current</b> {relationshipState(current, page)}</p><p><b>Saved</b> {relationshipState(previous, previousPage)}</p>{changes.includes("retrieved passage") && <details className="trace-passage-diff"><summary>Compare saved passages</summary><div><section><strong>Current · {page.extractionSource ?? "method unclear"}</strong><blockquote>{page.text}</blockquote></section><section><strong>Saved · {previousPage.extractionSource ?? "method unclear"}</strong><blockquote>{previousPage.text}</blockquote></section></div></details>}<button onClick={() => inspectCurrent(page.id)} type="button">Inspect in current tree →</button></li>)}</ul> : <p>No source-record changes among shared pages.</p>}</div>
      {(current.searchAudit?.length || previous.searchAudit?.length) ? <details className="trace-comparison-search"><summary>Search coverage changes <span>{searchChanges.length} variants</span></summary><div>{searchChanges.length ? <ul>{searchChanges.map(({ query, current: now, previous: then }, index) => <li key={`${query}-${index}`}><strong>{query}</strong><span><b>Current</b> {searchState(now)}</span><span><b>Saved</b> {searchState(then)}</span></li>)}</ul> : <p>No recorded search-result counts changed.</p>}<small>Search engines can return different pages over time; this audit helps explain coverage, not the truth of the claim.</small></div></details> : null}
      <p className="trace-comparison-note">Two searches can cover different parts of the web. A changed count or root page does not, by itself, mean the claim changed. Synthetic traces remain illustrative.</p>
    </section>
  );
}

function RootEvidenceLedger({ result, onSelect }: { result: EchoAnalysis; onSelect: (id: string) => void }) {
  const pageById = new Map(result.pages.map((page) => [page.id, page] as const));
  const roots = result.roots.map((id) => pageById.get(id)).filter((page): page is EchoPage => Boolean(page));
  const coPublished = new Map<string, string[]>();
  for (const group of result.coPublishedRootGroups ?? []) for (const id of group) coPublished.set(id, group.filter((other) => other !== id).map((other) => pageById.get(other)?.domain ?? other));
  const inspect = (id: string) => {
    onSelect(id);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".map-layout .detail-card")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  return (
    <details className="evidence-coverage root-ledger">
      <summary><span>ROOT EVIDENCE LEDGER</span><b>{result.mode === "demo" ? `${roots.length} illustrative root pages` : `${roots.length} root ${roots.length === 1 ? "page" : "pages"} · ${result.summary.independentOrigins} independent ${result.summary.independentOrigins === 1 ? "origin" : "origins"} · ${result.summary.verifiableOrigins} with own evidence`}</b></summary>
      <div className="coverage-body">
        <p>{result.mode === "demo" ? "These are synthetic rehearsal records, not assessed sources." : "Root pages are the best-supported starting points in this retrieved tree; pages published together count as one independent origin. A root page is not proof of the earliest page on the web. Open each source to inspect its evidence."}</p>
        {roots.length ? <div className="root-ledger-list">{roots.map((page) => {
          const grouped = groupDownstreamEchoes(page.id, result.pages, result.coPublishedRootGroups);
          const reach = grouped.all.length;
          const evidence = result.mode === "demo" ? "Not assessed" : page.primaryEvidenceStatus === "found" ? "Own evidence found" : page.primaryEvidenceStatus === "not found" ? "No own evidence identified" : "Own evidence unclear";
          return <button aria-label={`Inspect root page ${page.title}`} key={page.id} onClick={() => inspect(page.id)} type="button">
            <span className="root-ledger-source"><strong>{page.title}</strong><small>{page.domain}{coPublished.has(page.id) ? ` · same publication as ${coPublished.get(page.id)!.join(", ")}` : ""}{result.inspectedPageIds?.includes(page.id) ? " · marked inspected" : ""}</small></span>
            <span><b>{reliableDate(page) ?? (isSearchEstimate(page) ? "Search estimate" : "Date unclear")}</b><small>{reliableDate(page) ? page.publishedDateSource : isSearchEstimate(page) ? `${formatDate(page.publishedDate)}, from search, not the page` : "No reliable date"}</small></span>
            <span><b>{evidence}</b><small>{reach} {result.mode === "demo" ? "illustrative" : "likely"} downstream {reach === 1 ? "echo" : "echoes"}</small>{grouped.partners.length > 0 && <small className="root-ledger-together">{togetherEchoesNote(grouped.partners)}</small>}</span>
            <span aria-hidden="true">↗</span>
          </button>;
        })}</div> : <p>No page could be confirmed as an independent origin in this trace. Inspect the unresolved pages in the tree.</p>}
      </div>
    </details>
  );
}

// Shown only on the bundled demo traces: their measured agreement with labeled pages (src/lib/echo/demo-scores.ts).
// "Every page in this saved trace was" only when it is true; otherwise "15 of its 18 pages were".
const labeledShare = (labeled: number, total: number) => (labeled >= total ? "Every page in this saved trace was" : `${labeled} of its ${total} pages were`);
const runMistakes = (runs: Array<{ settledMistakes: number }>) => runs.reduce((total, run) => total + run.settledMistakes, 0);

function AccuracyCard({ result }: { result: EchoAnalysis }) {
  const score = Object.values(DEMO_SCORES).find((entry) => entry.traceCreatedAt === result.createdAt);
  if (!score || result.mode !== "live") return null;
  return (
    <details className="evidence-coverage accuracy-card">
      <summary><span>ACCURACY CHECK</span><b>{score.exactKinds} of {score.matched} pages match AI-made labels · {score.settledMistakes} wrong {score.settledMistakes === 1 ? "call" : "calls"} · {score.abstentions} left unclear</b></summary>
      <div className="coverage-body">
        <p>{labeledShare(score.matched, result.summary.totalPages)} labeled from its full web page (origin, copy of which page, or unclear), then compared with what Echo decided. A <strong>wrong call</strong> is Echo choosing origin or copy when the label says otherwise. <strong>Left unclear</strong> means Echo declined to decide where the page settled it.</p>
        <ul className="accuracy-stats">
          <li><b>{score.exactKinds}/{score.matched}</b><small>pages match</small></li>
          <li><b>{score.settledMistakes}</b><small>wrong calls</small></li>
          <li><b>{score.derivedCorrect}/{score.derivedGold}</b><small>labeled copies found</small></li>
          <li><b>{score.exactEdges}/{score.derivedGold}</b><small>exact parent page</small></li>
        </ul>
        {score.runs.length > 1 && (
          <div className="accuracy-runs">
            <strong>Every live run of this claim, not just the one shown</strong>
            <ul>{score.runs.map((run) => <li className={run.bundled ? "is-shown" : ""} key={run.createdAt}><span>{new Date(run.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{run.bundled ? " · shown here" : ""}{run.earlierEcho ? " · earlier Echo" : ""}</span><b>{run.exactKinds}/{run.matched} match</b><b>{run.settledMistakes} wrong</b><b>{run.abstentions} unclear</b></li>)}</ul>
            <small>Each row is a separate live run of the same claim, scored against the same labels. Results vary with what the live web returns, and some runs leave more pages unclear.{score.runs.some((run) => run.earlierEcho) ? " Runs marked earlier Echo were made before the Nov 12 source-link and date fixes." : ""} Across all {score.runs.length} runs: {runMistakes(score.runs)} wrong {runMistakes(score.runs) === 1 ? "call" : "calls"}.</small>
          </div>
        )}
        {score.disagreements.length > 0 && <ul className="accuracy-disagreements">{score.disagreements.map((entry) => <li key={entry.title}><strong>{entry.title}</strong><small>Label: {entry.expected} · Echo: {entry.observed}</small></li>)}</ul>}
        <small>Labels were made by Claude (AI) from documented page evidence, not by a person{score.missingLabeled ? `; ${score.missingLabeled} labeled ${score.missingLabeled === 1 ? "page was" : "pages were"} not retrieved in this run` : ""}. One claim per slot: a consistency check, not a benchmark.</small>
      </div>
    </details>
  );
}

const COPY_TIMING_LABEL: Record<CopyCandidate["timing"], string> = {
  "after root": "Published after the original",
  "same day": "Same day as the original",
  "before root": "Dated before the original: check this",
  "date unknown": "Date unknown",
};

// Off by default (ECHO_COPY_HUNT=1). Searches the exact wording the confirmed copies reused, to list possible copies
// the first search missed. Results never change the tree, the origins or the echo percentage.
const COPY_HUNT_TOP = 5;

function CopyHuntPanel({ result, onUpdateResult }: { result: EchoAnalysis; onUpdateResult: (analysis: EchoAnalysis) => void }) {
  const [enabled, setEnabled] = useState(false);
  // A presenter-locked deployment refuses a visitor's hunt (403 PRESENTER_ONLY), so the paid button is not offered.
  const [locked, setLocked] = useState(false);
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [showAllCandidates, setShowAllCandidates] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    // Offline the check can only fail, so it waits for the "online" event (a saved hunt still shows meanwhile).
    const check = () => {
      if (navigator.onLine === false || controller.signal.aborted) return;
      void fetch("/api/analyze", { cache: "no-store", signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ copyHuntEnabled?: boolean; liveRunsLocked?: boolean }> : null)
        .then((configuration) => {
          if (controller.signal.aborted) return;
          setEnabled(Boolean(configuration?.copyHuntEnabled));
          setLocked(Boolean(configuration?.liveRunsLocked));
        })
        .catch(() => undefined);
    };
    check();
    window.addEventListener("online", check, { once: true });
    return () => {
      controller.abort();
      window.removeEventListener("online", check);
    };
  }, []);
  const hunt = result.copyHunt;
  if (result.mode !== "live" || ((!enabled || locked) && !hunt)) return null;
  const root = result.pages.find((page) => page.id === (hunt?.rootId ?? ""));
  const run = async () => {
    setStatus("running");
    setMessage(null);
    try {
      const response = await fetch("/api/copy-hunt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trace: makePortableTrace(result) }) });
      const payload = await response.json() as { copyHunt?: CopyHunt; error?: string };
      if (!response.ok || !payload.copyHunt) throw new Error(payload.error ?? "Copy hunt failed.");
      onUpdateResult({ ...result, copyHunt: payload.copyHunt });
      // A new hunt opens on its own strongest five, not on the previous hunt's "Show all".
      setShowAllCandidates(false);
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Copy hunt failed.");
    }
  };
  const later = hunt?.candidates.filter((candidate) => candidate.timing === "after root").length ?? 0;
  // Phrases also found on pages dated before the original are shown as "Not counted", so a candidate's count and its
  // rank leave them out too (as the hunt's own ranking does); the count still says how many of them it matched.
  const common = new Set(hunt?.commonPhrases ?? []);
  const countedPhrases = (hunt?.phrases ?? []).filter((phrase) => !common.has(phrase)).length;
  const counted = (candidate: CopyCandidate) => candidate.matchedPhrases.filter((phrase) => !common.has(phrase)).length;
  const matchLine = (candidate: CopyCandidate) => {
    if (!hunt || !common.size) return `Matches ${candidate.matchedPhrases.length} of ${hunt?.phrases.length ?? 0} phrases`;
    const uncounted = candidate.matchedPhrases.length - counted(candidate);
    return `Matches ${counted(candidate)} of ${countedPhrases} counted ${countedPhrases === 1 ? "phrase" : "phrases"}${uncounted ? `, plus ${uncounted} not counted` : ""}`;
  };
  // The strongest five first (most counted phrases matched; ties keep the hunt's order); the rest behind Show all.
  const ranked = [...(hunt?.candidates ?? [])].sort((a, b) => counted(b) - counted(a));
  const shownCandidates = showAllCandidates ? ranked : ranked.slice(0, COPY_HUNT_TOP);
  return (
    // Collapsed by default, like the cards around it: its first possible copies can be unrelated pages, and open it
    // pushed slot 02's tree about 600 px down. The summary line keeps the counts in view; one click opens the list.
    <details className="evidence-coverage copy-hunt">
      <summary><span>COPY HUNT · BETA</span><b>{hunt ? `${hunt.candidates.length} possible ${hunt.candidates.length === 1 ? "copy" : "copies"} outside this trace · ${later} dated after the original` : "Search for copies the first search missed"}</b></summary>
      <div className="coverage-body">
        <p>Echo takes the exact wording that confirmed copies reused from the original and searches the web for it. Matches are <strong>possible</strong> copies: Echo has not read them in full, and they do not change the tree, the origins or the echo percentage. Open each one to check.</p>
        {hunt ? <>
          <p className="copy-hunt-phrases">Searched for wording from <strong>{root?.domain ?? "the original"}</strong>{root?.publishedDate ? ` (${formatDate(root.publishedDate)})` : ""}: {hunt.phrases.map((phrase) => <q key={phrase}>{phrase}</q>)}</p>
          {hunt.commonPhrases?.length ? <p className="copy-hunt-phrases copy-hunt-phrases-common">Not counted, because the same wording appears on pages dated before the original: {hunt.commonPhrases.map((phrase) => <q key={phrase}>{phrase}</q>)}</p> : null}
          {hunt.candidates.length ? <ul className="copy-hunt-list">{shownCandidates.map((candidate) => <li key={candidate.url}>
            <a href={candidate.url} rel="noreferrer" target="_blank"><strong>{candidate.title}</strong> ↗</a>
            <small>{candidate.domain} · {candidate.publishedDate ? `${formatDate(candidate.publishedDate)} (${candidate.publishedDateSource ?? "date source unclear"})` : "no date found"} · {COPY_TIMING_LABEL[candidate.timing]}{candidate.foundIn === "full page" ? " · wording found in the page itself" : ""}</small>
            <small>{matchLine(candidate)}{candidate.snippet ? `: “${candidate.snippet.slice(0, 160)}…”` : ""}</small>
          </li>)}</ul> : <p>No new pages contained this wording. That does not prove there are no other copies.</p>}
          {ranked.length > COPY_HUNT_TOP && <button aria-expanded={showAllCandidates} className="new-claim-button copy-hunt-more" onClick={() => setShowAllCandidates((value) => !value)} type="button">{showAllCandidates ? `Show the top ${COPY_HUNT_TOP}` : `Show all ${ranked.length}`}</button>}
          <small>{hunt.queries.map((query) => `${query.status === "failed" ? "failed" : `${query.results} results, ${query.newMatches} new`}`).join(" · ")}{hunt.pagesChecked !== undefined ? ` · ${hunt.pagesChecked} new ${hunt.pagesChecked === 1 ? "page" : "pages"} opened directly (free)` : ""} · searched {new Date(hunt.searchedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</small>
        </> : null}
        {enabled && locked && <p className="copy-hunt-locked">A new copy hunt searches the web, so on this copy of Echo it is kept for the presenter. The list above was saved with this trace.</p>}
        {enabled && !locked && <button className="new-claim-button" disabled={status === "running"} onClick={() => void run()} type="button">{status === "running" ? "Searching…" : hunt ? "Search again" : "Hunt for more copies (up to 3 searches, about $0.02)"}</button>}
        {message && <p className="copy-hunt-error" role="alert">{message}</p>}
      </div>
    </details>
  );
}

function EvidenceCoverage({ result, onSelect }: { result: EchoAnalysis; onSelect: (id: string) => void }) {
  const [showAllReview, setShowAllReview] = useState(false);
  const total = result.pages.length;
  const dated = result.pages.filter((page) => Boolean(page.publishedDate)).length;
  // Text Echo read from the page itself is full text too, not a snippet.
  const extracted = result.pages.filter((page) => page.extractionSource === "Tavily extraction" || page.extractionSource === "Page HTML").length;
  const snippets = result.pages.filter((page) => page.extractionSource === "Search snippet").length;
  const domains = new Set(result.pages.filter((page) => page.url && page.domain).map((page) => page.domain.toLowerCase())).size;
  const unresolved = result.pages.filter((page) => page.judgment.kind === "unclear").length;
  const roots = result.roots.map((id) => result.pages.find((page) => page.id === id)).filter((page): page is EchoPage => Boolean(page));
  const evidenceRoots = roots.filter((page) => page.primaryEvidenceStatus === "found").length;
  const unclearRoots = roots.filter((page) => page.primaryEvidenceStatus === "unclear").length;
  const percentage = (value: number) => total ? Math.round((value / total) * 100) : 0;
  const reviewPages = getReviewPages(result);
  const inspectedIds = new Set(result.inspectedPageIds ?? []);
  const inspectedReviewCount = reviewPages.filter(({ page }) => inspectedIds.has(page.id)).length;
  const challengedReviewCount = Object.values(result.sourceAssessmentsByPageId ?? {}).filter((status) => status === "challenged").length;
  const nextUninspectedPage = reviewPages.find(({ page }) => !inspectedIds.has(page.id))?.page;
  const visibleReviewPages = showAllReview ? reviewPages : reviewPages.slice(0, 6);
  const inspectPage = (id: string) => {
    onSelect(id);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".map-layout .detail-card")?.focus());
  };

  return (
    <details className="evidence-coverage">
      <summary><span>TRACE COVERAGE &amp; LIMITS</span><b>{dated}/{total} dated · {extracted}/{total} extracted</b></summary>
      <div className="coverage-body">
        <p>Coverage describes what this run retrieved. Saved text is a claim-focused passage of up to 2,000 characters, even when extraction succeeds; open the original page for full context. Different sites or dates do not prove independent sourcing.</p>
        <div className="coverage-grid">
          <div className="coverage-metric">
            <div className="coverage-label"><span>PUBLICATION DATE KNOWN</span><strong>{dated}/{total}</strong></div>
            <div aria-label={`${percentage(dated)} percent of pages have a publication date`} className="coverage-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage(dated)}><i style={{ width: `${percentage(dated)}%` }} /></div>
            <small>{total - dated} page{total - dated === 1 ? "" : "s"} have no date available.</small>
          </div>
          <div className="coverage-metric">
            <div className="coverage-label"><span>EXTRACTED PASSAGE</span><strong>{extracted}/{total}</strong></div>
            <div aria-label={`${percentage(extracted)} percent of pages have an extracted passage`} className="coverage-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage(extracted)}><i style={{ width: `${percentage(extracted)}%` }} /></div>
            <small>{snippets} snippet-only page{snippets === 1 ? "" : "s"}; snippet-only root pages remain unverified.</small>
          </div>
          <div className="coverage-metric coverage-summary-metric"><span>DISTINCT DOMAINS</span><strong>{domains}</strong><small>Domain count is not a count of independent origins.</small></div>
          <div className="coverage-metric coverage-summary-metric"><span>UNRESOLVED LINKS</span><strong>{unresolved}</strong><small>These page relationships remain unclear.</small></div>
          <div className="coverage-metric coverage-summary-metric"><span>ROOT PAGES WITH OWN EVIDENCE</span><strong>{evidenceRoots}/{roots.length}</strong><small>{unclearRoots} root {unclearRoots === 1 ? "page has" : "pages have"} unclear evidence status.</small></div>
        </div>
        <div className="coverage-review">
          <div className="coverage-review-heading"><span>PAGES TO INSPECT</span><b>{result.mode === "demo" ? "REHEARSAL ONLY" : `${reviewPages.length} flagged · ${inspectedReviewCount} inspected${challengedReviewCount ? ` · ${challengedReviewCount} challenged` : ""}`}</b></div>
          {result.mode === "demo" ? <p>These pages are synthetic placeholders. Run a live trace to review source quality.</p> : reviewPages.length ? (
            <>
              <p>Flags point to missing evidence or uncertain relationships. They are prompts for human review, not another verdict.</p>
              {nextUninspectedPage && <button className="coverage-review-next" onClick={() => inspectPage(nextUninspectedPage.id)} type="button">Inspect next flagged page →</button>}
              <ul>{visibleReviewPages.map(({ page, reasons }) => <li key={page.id}>
                <button aria-label={`Inspect ${page.title}: ${reasons.map((reason) => reason.label).join(", ")}`} onClick={() => inspectPage(page.id)} type="button">
                  <span><strong>{page.title}</strong><small>{page.domain}{inspectedIds.has(page.id) ? " · marked inspected" : ""}</small></span><span className="coverage-review-reasons">{reasons.map((reason) => <em key={reason.label}>{reason.label}</em>)}</span><span aria-hidden="true">↗</span>
                </button>
              </li>)}</ul>
              {reviewPages.length > 6 && <button className="coverage-review-more" onClick={() => setShowAllReview((current) => !current)} type="button">{showAllReview ? "Show fewer" : `Show all ${reviewPages.length} pages`}</button>}
            </>
          ) : <p>No pages have the listed review flags in this trace. Source judgments still require checking the original pages.</p>}
        </div>
      </div>
    </details>
  );
}

function SearchAudit({ result, onSelect }: { result: EchoAnalysis; onSelect: (id: string) => void }) {
  const audit = result.searchAudit;
  if (!audit?.length) return null;
  const pageById = new Map(result.pages.map((page) => [page.id, page] as const));
  const attempted = audit.filter((entry) => entry.status !== "not searched").length;
  const failed = audit.filter((entry) => entry.status === "failed").length;
  const notSearched = audit.filter((entry) => entry.status === "not searched").length;
  const newPages = audit.reduce((sum, entry) => sum + entry.uniquePagesAdded, 0);

  return (
    <details className="query-audit">
      <summary><span>SEARCH QUERY AUDIT</span><b>{attempted}/{audit.length} variants run · {newPages} new {newPages === 1 ? "page" : "pages"}{failed ? ` · ${failed} failed` : ""}</b></summary>
      <div className="query-audit-body">
        <p>Echo builds these variants without another model call.{routedByTelem(result) ? " Telem routes each one to the search providers it picks; a page several providers return is one page." : ""} “New pages” counts URLs first discovered by that query; later queries can find the same page again. Up to 20 pages are extracted, balancing strong matches with distinct domains. {result.excludedPageCount ? `${result.excludedPageCount} off-claim ${result.excludedPageCount === 1 ? "page was" : "pages were"} excluded after grouping. ` : ""}{notSearched ? "Some variants were skipped after enough distinct pages were collected." : ""}</p>
        <ol>
          {audit.map((entry, index) => (
            <li className={`query-audit-item query-audit-${entry.status.replaceAll(" ", "-")}`} key={`${entry.depth}-${index}-${entry.query}`}>
              <div className="query-audit-item-top">
                <span className="query-audit-depth">{entry.depth === "advanced" ? "DEEP SEARCH" : "BASIC SEARCH"}</span>
                <span className="query-audit-status">{entry.status === "not searched" ? "Not run" : entry.status === "failed" ? "Request failed" : "Searched"}</span>
              </div>
              {entry.router === "telem" && entry.status === "searched" && <div className="query-audit-providers">{entry.providers?.length ? <>Routed by Telem to {providerList(entry.providers)}</> : "Routed by Telem"}</div>}
              <code>{entry.query}</code>
              <div className="query-audit-counts"><span>{entry.matchingResults} relevant / {entry.totalResults} results</span><span>{entry.uniquePagesAdded} new {entry.uniquePagesAdded === 1 ? "page" : "pages"}</span></div>
              {(entry.pageIds?.length ?? 0) > 0 && <div aria-label="New pages found by this query" className="query-audit-pages">
                {(entry.pageIds ?? []).map((pageId) => {
                  const page = pageById.get(pageId);
                  const foundBy = entry.pageProviders?.[pageId];
                  return page ? <button aria-label={`Inspect ${page.title}, found by query: ${entry.query}`} key={pageId} onClick={() => onSelect(pageId)} type="button"><span>{page.title}</span><small>{page.domain}{foundBy?.length ? ` · from ${providerList(foundBy)}` : ""} · inspect source</small></button> : null;
                })}
              </div>}
              {entry.reason && <small>{entry.reason}</small>}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

function StagePresentation({ result, selectedId, onSelect, onClose, verdict, verdictText, isBundledRun }: {
  isBundledRun: boolean;
  result: EchoAnalysis;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  verdict: string;
  verdictText: string;
}) {
  const [slide, setSlide] = useState(0);
  const [sourceQuery, setSourceQuery] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const presentationRef = useRef<HTMLDivElement>(null);
  const pageById = useMemo(() => new Map(result.pages.map((page) => [page.id, page] as const)), [result.pages]);
  const stageNumbers = answerCitationNumbers(result);
  const selected = selectedId ? pageById.get(selectedId) ?? null : null;
  const selectedParent = selected?.judgment.parentId ? pageById.get(selected.judgment.parentId) ?? null : null;
  const stagePairNote = selected ? coPublishedNote(selected, coPublishedRoles(result)) : null;
  const roots = result.roots.map((id) => pageById.get(id)).filter((page): page is EchoPage => Boolean(page));
  // One item per origin: roots published together (coPublishedRootGroups) share a numbered item, as they count once.
  const originGroups: EchoPage[][] = [];
  {
    const groupOf = new Map<string, number>();
    (result.coPublishedRootGroups ?? []).forEach((group, index) => group.forEach((id) => groupOf.set(id, index)));
    for (const page of roots) {
      const index = groupOf.get(page.id);
      const existing = index === undefined ? undefined : originGroups.find((group) => groupOf.get(group[0].id) === index);
      if (existing) existing.push(page);
      else originGroups.push([page]);
    }
    // Lead first, by the rule every other surface uses (coPublishedLeadOrder).
    originGroups.forEach((group, index) => {
      if (group.length < 2) return;
      const order = coPublishedLeadOrder(result, group.map((page) => page.id));
      originGroups[index] = group.toSorted((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    });
  }
  // Five or more origins: a compact two-column list that fits a 1280x720 projector.
  const many = originGroups.length > 4;
  const stageSpan = datedSpanOf(result);
  const sourceLabel = result.demoLabel ? "SYNTHETIC REHEARSAL" : isBundledRun ? `SAVED LIVE RUN · CAPTURED ${formatRunDate(result.createdAt).toUpperCase()}` : result.importedAt ? "IMPORTED SNAPSHOT" : result.cacheHit ? "CACHED LIVE TRACE" : "FRESH LIVE TRACE";
  const traceSignals = summarizeTraceSignals(result.pages);
  const stageUndated = result.pages.length - reliablyDatedPages(result).length;
  const accuracy = result.mode === "live" ? Object.values(DEMO_SCORES).find((entry) => entry.traceCreatedAt === result.createdAt) ?? null : null;
  // Slides are chosen by name, so adding one never shifts what the others show. "How it spread" needs two or more
  // reliably dated pages, as the timeline does.
  const hasSpread = result.mode === "live" && reliablyDatedPages(result).length >= 2;
  // Slide 2, the evidence funnel: "How Echo searched" for a search run, "What Echo read" for supplied links (or an
  // older trace without a search audit). A rehearsal has none (its numbers are sample data).
  const funnel = evidenceFunnel(result);
  const funnelSlide = funnel ? (funnel.kind === "search" ? "How Echo searched" : "What Echo read") : null;
  const slides = ["The claim", ...(funnelSlide ? [funnelSlide] : []), "The source tree", ...(hasSpread ? ["How it spread"] : []), "Check the origins", "The takeaway", ...(accuracy ? ["How we checked"] : [])];
  const slideName = slides[slide];
  const stagePlainSearch = plainSearchLineage(result);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const presentation = presentationRef.current;
    // The stage itself takes focus (it has tabIndex -1), not its first button, so no focus ring shows on the slides.
    presentation?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        onClose();
      } else if (event.key === "Tab" && presentation) {
        const focusable = [...presentation.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (document.activeElement === presentation) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      } else if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        setSlide((current) => Math.min(slides.length - 1, current + 1));
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        setSlide((current) => Math.max(0, current - 1));
      }
    };
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onClose, slides.length]);

  // On a phone the slide tabs are one sideways-scrolling row: keep the current one in view (a no-op on desktop).
  useEffect(() => {
    const active = presentationRef.current?.querySelector<HTMLElement>(".stage-progress-active");
    const row = active?.parentElement;
    if (!active || !row || row.scrollWidth <= row.clientWidth) return;
    const [tab, strip] = [active.getBoundingClientRect(), row.getBoundingClientRect()];
    row.scrollTo({ left: row.scrollLeft + tab.left - strip.left - (row.clientWidth - tab.width) / 2, behavior: "smooth" });
  }, [slide]);

  // A mouse click hands the focus back to the stage (QA round 6, S3-1): left on the button, the first arrow key made
  // Chrome draw the keyboard focus ring on "Exit full screen" through every slide. Enter or Space (a click with
  // detail 0) keeps the focus on the button, so a keyboard user stays where they were.
  const toggleFullscreen = async (fromPointer = false) => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.querySelector<HTMLElement>(".stage-presentation")?.requestFullscreen();
      setFullscreenError(false);
    } catch {
      setFullscreenError(true);
    }
    if (fromPointer) presentationRef.current?.focus({ preventScroll: true });
  };

  // A supplied-sources result leads with its links ("5 supplied links → 1 independent origin" and each link's verdict);
  // it ran no search, so it has no plain-search line.
  const slideContent = slideName === "The claim" && result.sourceCheck ? <StageSourcesClaim result={result} /> : slideName === "The claim" ? (
    <article aria-label="The claim and verdict" className="stage-claim-slide">
      <span className="stage-kicker">A CLAIM ENTERS THE ECHO CHAMBER</span>
      <h1>{result.claim}</h1>
      <div className="stage-hero-verdict"><span>{result.mode === "demo" ? "REHEARSAL GRAPH" : "THE TRACE SAYS"}</span><strong>{verdict}</strong><p>{verdictText}</p></div>
      <div className="stage-metrics">
        <div><strong>{result.summary.totalPages}</strong><span>{result.mode === "demo" ? "sample pages" : "pages examined"}</span></div>
        <div><strong>{result.summary.independentOrigins}</strong><span>{result.mode === "demo" ? `sample ${result.summary.independentOrigins === 1 ? "origin" : "origins"}` : `independent ${result.summary.independentOrigins === 1 ? "origin" : "origins"}`}</span></div>
        <div><strong>{result.summary.verifiableOrigins}</strong><span>{result.mode === "demo" ? "sample, with own evidence" : "with own evidence"}</span></div>
        <div><strong>{result.summary.echoPercentage}%</strong><span>{result.mode === "demo" ? "sample echo rate" : "estimated echo rate"}</span></div>
      </div>
      {result.mode === "live" && <p className="stage-breakdown-line">{pageBreakdownLine(result)}</p>}
      {stagePlainSearch && <div className="stage-plain-search" title={plainSearchTooltip(stagePlainSearch)}><span className="plain-search-label">PLAIN SEARCH VS ECHO</span><span className="sr-only">: </span><p className="plain-search-primary">{plainSearchHeadline(stagePlainSearch)}</p><p className="plain-search-detail">{plainSearchDetail(stagePlainSearch)}</p></div>}
      {result.mode === "live" && <p className="stage-signal-note">{stageSpan ? `Reliably dated pages span ${stageSpan.from}–${stageSpan.to}. ` : ""}{traceSignals.possiblePaths > 0 ? `${traceSignals.possiblePaths} possible ${traceSignals.possiblePaths === 1 ? "copy is" : "copies are"} not counted as echoes; ` : ""}{stageUndated} {stageUndated === 1 ? "page has" : "pages have"} no reliable date.</p>}
    </article>
  ) : funnel && slideName === funnelSlide ? (
    <article aria-label={funnelSlide} className="stage-funnel-slide">
      <div className="stage-section-title">
        <span className="stage-kicker">{funnel.kind === "sources" ? "WHAT ECHO READ · SUPPLIED LINKS, NO WEB SEARCH" : funnel.kind === "search" ? "HOW ECHO SEARCHED" : "WHAT ECHO READ"}</span>
        <h1>{evidenceFunnelHeadline(funnel) || funnelSlide}</h1>
        <p>Every number is counted from this run&apos;s own record. Hover a stage to see exactly what it counts.</p>
      </div>
      <EvidenceFunnelView result={result} stage />
    </article>
  ) : slideName === "The source tree" ? (
    <article aria-label="Interactive source family tree" className="stage-tree-slide">
      {/* The legend sits beside the heading, and the tree takes the rest of the slide's height (it scrolls inside). */}
      <div className="stage-tree-head">
        <div className="stage-section-title"><span className="stage-kicker">FOLLOW THE PUBLICATION TRAIL</span><h1>Where the story travels</h1><p>Select a page to inspect its relationship and evidence.</p></div>
        <TreeLegend result={result} stage />
      </div>
      <SourceExplorer compact onSelect={onSelect} onSourceQueryChange={setSourceQuery} result={result} selectedId={selectedId} sourceQuery={sourceQuery} />
      {selected && <div className="stage-selection"><strong>{selected.title}</strong><span>{selected.domain} · {selected.judgment.kind === "origin" ? "root page" : selected.judgment.kind === "derived" ? "likely derived" : "relationship unclear"}</span><p>{stagePairNote && <b className="co-published-note">{stagePairNote} </b>}{selected.judgment.evidence}</p>{result.mode === "live" && <PageDetails favicon={safeFaviconUrl(selected.favicon)} key={selected.id} rows={pageDetails(result, selected, suppliedNumbersByPageId(result).get(selected.id))} stage />}</div>}
      {selected && selectedParent && <PageComparison page={selected} parent={selectedParent} />}
    </article>
  ) : slideName === "How it spread" ? (
    <article aria-label="How the claim spread" className="stage-spread-slide">
      <div className="stage-section-title"><span className="stage-kicker">OVER TIME</span><h1>How the claim spread</h1><p>Every page with a date read from the page itself, oldest first. Press play to watch the echoes pile up.</p></div>
      <EchoSpread onSelect={onSelect} result={result} selectedId={selectedId} />
    </article>
  ) : slideName === "Check the origins" ? (
    <article aria-label="Origin review" className="stage-roots-slide">
      <div className="stage-section-title"><span className="stage-kicker">INDEPENDENT ORIGINS</span><h1>What counts as an origin?</h1><p>{result.sourceCheck ? "An origin is a source Echo judges independent of the other supplied links. That is a best-supported starting point among these links, not proof it was first on the entire web." : "An origin is a source Echo judges independent of the other pages found. That is a best-supported starting point, not proof it was first on the entire web."}</p></div>
      {originGroups.length ? <ol className={`stage-root-list${many ? " stage-root-list-many" : ""}`}>{originGroups.map((group, index) => {
        // The page that speaks for the group: its lead (sorted first above, the page the tree tags ORIGIN).
        const lead = group[0];
        const dates = [...new Set(group.map(reliableDate).filter((date): date is string => Boolean(date)))];
        const number = String(index + 1).padStart(2, "0");
        // With many origins the links float in the item's top corner, so the domain line and title wrap around them.
        const links = <span className="stage-root-links">{group.map((page) => page.url && <a aria-label={`Open ${group.length > 1 ? page.domain : `origin ${index + 1}`} in a new tab`} href={page.url} key={page.id} rel="noreferrer" target="_blank">{group.length > 1 ? `${page.domain} ↗` : "Open source ↗"}</a>)}</span>;
        return (
          <li key={lead.id}>
            <span className="stage-root-index">{number}</span>
            <div>{many && links}<span className="stage-root-domain">{group.map((page) => page.domain).join(" + ")}{dates.length ? ` · ${dates.join(" / ")}` : group.some(isSearchEstimate) ? " · date: search estimate" : " · date unknown"}{group.length > 1 ? " · published together, counted as one origin" : ""}</span><h2>{lead.title}</h2><p>{result.mode === "demo" ? "Synthetic sample page; no live evidence assessment was performed." : lead.primaryEvidenceStatus === "found" ? lead.primaryEvidenceReason : lead.primaryEvidenceStatus === "not found" ? `${many ? "No own evidence" : "No own evidence identified"}: ${lead.primaryEvidenceReason}` : `Evidence status unclear: ${lead.primaryEvidenceReason}`}</p></div>
            {!many && links}
          </li>
        );
      })}</ol> : <div className="stage-no-roots"><span>?</span><h2>No confirmed root in this trace.</h2><p>Some relationships remain uncertain. Echo keeps uncertainty visible instead of inventing a source trail.</p></div>}
    </article>
  ) : slideName === "How we checked" && accuracy ? (
    <article aria-label="How Echo was checked" className="stage-takeaway-slide stage-accuracy-slide">
      <span className="stage-kicker">HOW WE CHECKED ECHO</span>
      <h1>{accuracy.exactKinds} of {accuracy.matched} pages match AI-made labels</h1>
      <ul className="stage-accuracy-stats">
        <li><b>{accuracy.settledMistakes}</b><span>wrong {accuracy.settledMistakes === 1 ? "call" : "calls"}</span></li>
        <li><b>{accuracy.derivedCorrect}/{accuracy.derivedGold}</b><span>labeled copies found</span></li>
        <li><b>{accuracy.abstentions}</b><span>left unclear where a page settled it</span></li>
      </ul>
      {accuracy.disagreements.length > 0 && <div className="stage-echo-contribution"><span>{accuracy.disagreements.every((entry) => entry.expected.split(" ")[0] === entry.observed.split(" ")[0]) ? "SAME CALL, DIFFERENT PARENT" : "WHERE ECHO DISAGREES WITH THE LABELS"}</span><p>{accuracy.disagreements.slice(0, 4).map((entry) => `${entry.title.split(/\s[|–—-]\s/)[0]}: label ${entry.expected}, Echo ${entry.observed}`).join(" · ")}{accuracy.disagreements.length > 4 ? ` · and ${accuracy.disagreements.length - 4} more` : ""}</p></div>}
      {accuracy.runs.length > 1 && <p className="stage-runs-line">We ran this claim live {accuracy.runs.length} times{accuracy.runs.some((run) => run.earlierEcho) ? ` (${accuracy.runs.filter((run) => run.earlierEcho).length} on an earlier build)` : ""}{accuracy.runs.every((run) => run.exactKinds <= accuracy.exactKinds) ? " and show the best run" : ""}. Across all {accuracy.runs.length}: {runMistakes(accuracy.runs)} wrong {runMistakes(accuracy.runs) === 1 ? "call" : "calls"}, {Math.min(...accuracy.runs.map((run) => run.exactKinds))}–{Math.max(...accuracy.runs.map((run) => run.exactKinds))} pages matching per run.</p>}
      <p className="stage-caveat">{labeledShare(accuracy.matched, result.summary.totalPages)} labeled from its full web page (labels made with AI help from documented evidence, not by a person). One claim: a consistency check, not a benchmark.</p>
    </article>
  ) : (
    <article aria-label="Evidence-based takeaway" className="stage-takeaway-slide">
      <span className="stage-kicker">THE ANSWER, WITH ITS RECEIPTS</span>
      <h1>{result.answerStatus === "unavailable" ? "The tree is ready. The answer needs a human." : result.answerStatus === "source-limited" ? "What the origins cannot verify yet" : "What the independent sources support"}</h1>
      <p className="stage-answer" data-trace-text="">{formatCitationText(result)}</p>
      <div className="stage-echo-contribution"><span>WHAT THE ECHOES ADDED</span><p data-trace-text="">{result.echoContribution}</p></div>
      <div className="stage-source-links"><span>ORIGINS CITED</span>{result.answerSourceIds.length ? result.answerSourceIds.map((id, index) => {
        const page = pageById.get(id);
        if (!page) return null;
        const label = sourceLinkLabel(page, result.answerSourceIds.map((other) => pageById.get(other)));
        return page.url ? <a data-trace-text="" href={page.url} key={id} rel="noreferrer" target="_blank" title={page.title}>[{stageNumbers[index]}] {label} ↗</a> : <span data-trace-text="" key={id} title={page.title}>[{stageNumbers[index]}] {label}</span>;
      }) : <span>No origin cited in this answer</span>}</div>
      {/* Slide 6 shows source links but no page dates, so the caveat names only the links. */}
      <p className="stage-caveat">The links to the origins are shown for verification. Derivation judgments are probabilistic; inspect the evidence before relying on the conclusion.</p>
    </article>
  );

  return (
    <div aria-label="Echo judge-facing presentation" aria-modal="true" className="stage-presentation" ref={presentationRef} role="dialog" tabIndex={-1}>
      <header className="stage-toolbar">
        <div aria-label="Echo presentation" className="stage-brand"><BrandMark /><span>echo<span>.</span></span></div>
        <div className="stage-toolbar-center"><span className="stage-live-dot" />{sourceLabel}<span className="stage-toolbar-divider">/</span>{result.sourceCheck ? `${result.sourceCheck.urls.length} SUPPLIED ${result.sourceCheck.urls.length === 1 ? "LINK" : "LINKS"} · NO WEB SEARCH` : `${result.pages.length} PAGES`}</div>
        <div className="stage-toolbar-actions">
          {/* A plain link in a new tab: the slides keep their place, and the arrow keys still work (only Enter follows it). */}
          <a className="stage-how-link" href="/how" rel="noopener" target="_blank">How it works ↗</a>
          <button aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"} onClick={(event) => void toggleFullscreen(event.detail > 0)} type="button">{isFullscreen ? "Exit full screen" : "Full screen"}</button>
          <button aria-label="Close presentation" className="stage-close" onClick={onClose} type="button">Close <span aria-hidden="true">×</span></button>
        </div>
      </header>
      <div className="stage-main">
        <nav aria-label="Presentation slides" className="stage-progress">
          {slides.map((label, index) => <button aria-current={slide === index ? "step" : undefined} aria-label={`Slide ${index + 1}: ${label}`} className={slide === index ? "stage-progress-active" : ""} key={label} onClick={() => setSlide(index)} type="button"><span>0{index + 1}</span>{label}</button>)}
        </nav>
        {/* Only the slide change is announced ("Slide 4 of 7: How it spread"); a slide's own updates, like the spread
            heading counting years during Play, are not re-read every second. */}
        <p aria-live="polite" className="sr-only">{`Slide ${slide + 1} of ${slides.length}: ${slideName}`}</p>
        <section className="stage-content" key={slide}>{slideContent}</section>
      </div>
      <footer className="stage-footer">
        <span>{result.demoLabel ? "SYNTHETIC REHEARSAL · NOT LIVE FINDINGS" : isBundledRun ? "SAVED LIVE RUN · NOT REFRESHED" : result.importedAt ? "IMPORTED SNAPSHOT · NOT REFRESHED" : "TRACE THE ORIGINS · VERIFY THE SOURCES"}</span>
        <div className="stage-nav-buttons"><button disabled={slide === 0} onClick={() => setSlide((current) => Math.max(0, current - 1))} type="button">← Previous</button><span>0{slide + 1} / 0{slides.length}</span><button disabled={slide === slides.length - 1} onClick={() => setSlide((current) => Math.min(slides.length - 1, current + 1))} type="button">Next →</button></div>
        <span className="stage-key-hint">← → TO NAVIGATE · ESC TO EXIT{fullscreenError ? " · FULL SCREEN UNAVAILABLE" : ""}</span>
      </footer>
    </div>
  );
}

function OfflineReadiness({ cacheRevision }: { cacheRevision: number }) {
  const [cachedTraces, setCachedTraces] = useState<string[]>([]);
  const [shellCached, setShellCached] = useState<boolean | null>(null);
  const [shellAssetCount, setShellAssetCount] = useState(0);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      // Only a cache that holds the app shell ("/") can open anything offline: a partly failed install can leave the
      // traces in a cache with no shell, and those open nothing. Whatever version the worker is on (echo-shell-vN).
      const shellCaches: Cache[] = [];
      let assetCount = 0;
      if ("caches" in window) {
        try {
          for (const name of (await caches.keys()).filter((key) => key.startsWith("echo-shell-"))) {
            const shellCache = await caches.open(name);
            if (!(await shellCache.match(`${window.location.origin}/`))) continue;
            shellCaches.push(shellCache);
            assetCount = Math.max(0, (await shellCache.keys()).length - 1);
          }
        } catch {
          shellCaches.length = 0;
        }
      }
      const hasShell = shellCaches.length > 0;
      // A saved run opens offline when a shell cache holds its bundled file, or this browser kept a live run of it
      // (which still needs the shell to open).
      const inShellCache = async (path: string) => {
        const url = new URL(path, window.location.origin).toString();
        for (const shellCache of shellCaches) {
          try {
            if (await shellCache.match(url)) return true;
          } catch {
            // An unreadable cache holds nothing usable.
          }
        }
        return false;
      };
      const saved: string[] = [];
      if (hasShell) {
        for (const { trace, claim: savedClaim } of CACHED_SAVED_RUNS) {
          if (await inShellCache(trace) || (savedClaim !== null && readCached(savedClaim) !== null)) saved.push(trace);
        }
      }
      if (active) {
        setCachedTraces(saved);
        setShellCached(hasShell);
        setShellAssetCount(assetCount);
      }
    };
    const onStorage = () => void refresh();
    void refresh();
    window.addEventListener("storage", onStorage);
    window.addEventListener("online", onStorage);
    window.addEventListener("offline", onStorage);
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("controllerchange", onStorage);
    return () => {
      active = false;
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("online", onStorage);
      window.removeEventListener("offline", onStorage);
      if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("controllerchange", onStorage);
    };
  }, [cacheRevision]);

  const shellStatus = process.env.NODE_ENV !== "production"
    ? "Production build only"
    : shellCached === null
      ? "Unavailable"
      : shellCached
        ? `Cached · ${shellAssetCount} app files`
        : "Not cached yet";

  return (
    <details className="offline-readiness">
      <summary><span>OFFLINE DEMO READINESS</span><b>{cachedTraces.length} / {CACHED_SAVED_RUNS.length} saved runs ready offline</b></summary>
      <div className="readiness-body">
        <p>Echo ships with {CACHED_SAVED_RUNS.length} saved live runs. After one online visit to the production app, this browser keeps them, and the app itself, for offline use. Fresh custom claims can be reopened from Recent live traces.</p>
        <div className="readiness-checks">
          <div><span>App shell</span><strong>{shellStatus}</strong></div>
          <div><span>Rehearsal fixtures</span><strong>2 bundled</strong></div>
          <div><span>Live searches</span><strong>Internet required</strong></div>
        </div>
        <div className="readiness-cache-list">
          {CACHED_SAVED_RUNS.map(({ label, trace }) => {
            const isCached = cachedTraces.includes(trace);
            return <div key={trace}><span>{label}</span><strong className={isCached ? "cache-ready" : "cache-empty"}>{isCached ? "Ready offline" : "Online only for now"}</strong></div>;
          })}
        </div>
        <small>Offline status is checked in this browser profile. Open the production app once while online to cache its app shell.</small>
      </div>
    </details>
  );
}

function RecentTraces({ revision, isRunning, onOpen, onRefresh, onRemove }: {
  revision: number;
  isRunning: boolean;
  onOpen: (analysis: EchoAnalysis) => void;
  onRefresh: (claim: string) => void;
  onRemove: (claim: string) => void;
}) {
  const [recent, setRecent] = useState<EchoAnalysis[]>([]);
  useEffect(() => {
    const refresh = () => setRecent(readRecentTraces());
    refresh();
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [revision]);
  if (!recent.length) return null;
  return <details className="recent-traces">
    <summary><span>RECENT LIVE TRACES</span><b>{recent.length} saved in this browser</b></summary>
    <div className="recent-traces-body">
      <p>Reopen a saved result without using search or model credits. A fresh run searches the web again.</p>
      {recent.map((entry) => <div className="recent-trace-row" key={cacheKey(entry.claim)}>
        <div><strong>{entry.claim}</strong><small>{formatRunDate(entry.createdAt)} · {entry.summary.totalPages} {entry.summary.totalPages === 1 ? "page" : "pages"} · {entry.summary.independentOrigins} independent {entry.summary.independentOrigins === 1 ? "origin" : "origins"}{entry.answerStatus === "unavailable" ? " · answer unavailable" : ""}</small></div>
        <div className="recent-trace-actions">
          <button disabled={isRunning} onClick={() => onOpen(entry)} type="button">Open saved</button>
          <button disabled={isRunning} onClick={() => onRefresh(entry.claim)} type="button">Run fresh</button>
          <button aria-label={`Remove saved trace for ${entry.claim}`} disabled={isRunning} onClick={() => onRemove(entry.claim)} type="button">×</button>
        </div>
      </div>)}
    </div>
  </details>;
}

/** `embed`: the compact side-panel layout of /embed (src/app/embed/page.tsx), started by a click or the extension. */
export default function EchoWorkbench({ embed = false }: { embed?: boolean } = {}) {
  const clientReady = useSyncExternalStore(subscribeToClient, getClientSnapshot, getServerSnapshot);
  const [isOnline, setIsOnline] = useState(true);
  const [providerStatus, setProviderStatus] = useState<"checking" | "ready" | "missing" | "misconfigured" | "locked" | "unavailable">("checking");
  const [searchRouter, setSearchRouter] = useState<"telem" | "tavily" | null>(null);
  // Null until /api/analyze's status answers: a default here would print a spend Echo never read.
  const [dailyBudget, setDailyBudget] = useState<DailyBudgetStatus | null>(null);
  const [claim, setClaim] = useState("");
  // "Trace an article": a pasted page address is read (free, no model call) for sentences worth tracing.
  const [articleScan, setArticleScan] = useState<{ status: "loading" | "done" | "error"; url: string; title?: string; finalUrl?: string; candidates?: Array<{ text: string; reasons: string[] }>; message?: string } | null>(null);
  const isUrlInput = /^https?:\/\/\S+$/i.test(claim.trim());
  const [result, setResult] = useState<EchoAnalysis | null>(null);
  // The importedAt stamp given to a run bundled with Echo (a slot or saved backup), so it is labelled a saved live run;
  // a trace file the visitor opens gets its own stamp and stays "imported".
  const [bundledImportedAt, setBundledImportedAt] = useState<string | null>(null);
  const [glossaryExample, setGlossaryExample] = useState<EchoAnalysis | null>(null);
  const [previousTrace, setPreviousTrace] = useState<EchoAnalysis | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [forceFresh, setForceFresh] = useState(false);
  // Standard (the default) or Deep (search-mode.ts), chosen in the claim box for the next run only: it goes back to
  // Standard once a Deep run finishes, and nothing outside this toggle (no link, no URL parameter) can set it.
  const [searchMode, setSearchMode] = useState<SearchMode>("standard");
  const [liveDeep, setLiveDeep] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [error, setError] = useState<StreamError | null>(null);
  const [liveClaim, setLiveClaim] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  // The sites a live run has found so far (domains only), shown growing on the loading card.
  const [liveDomains, setLiveDomains] = useState<string[]>([]);
  const [livePlan, setLivePlan] = useState<SearchPlan | null>(null);
  // The server said Telem's daily cap sent this run's searches to Tavily (a progress event's searchFallback).
  const [liveTelemFallback, setLiveTelemFallback] = useState(false);
  // How long the last fresh live run took, shown on its result tag ("FRESH LIVE TRACE · 0:42"); browser-only.
  const [liveRunTime, setLiveRunTime] = useState<{ createdAt: string; seconds: number } | null>(null);
  // "Check these sources": the paste panel's draft, whether it is open, and the supplied-sources run last started (so
  // Try again repeats that run, not a search).
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>(EMPTY_SOURCE_DRAFT);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceFocus, setSourceFocus] = useState(false);
  const [lastSourceRun, setLastSourceRun] = useState<{ claim: string; urls: string[]; numbers?: number[] } | null>(null);
  const lastProgressAt = useRef(0);
  const [cacheRevision, setCacheRevision] = useState(0);
  const [importMessage, setImportMessage] = useState("");
  const traceFileInput = useRef<HTMLInputElement | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const savedForInput = clientReady && !forceFresh && searchMode !== "deep" && claim.trim().length >= 8
    ? readCached(claim) ?? readRecentTrace(claim)
    : null;
  // Try again reruns what the screen shows now: after a failed Check these sources run, the panel's links and sentence
  // as they stand (edited or not), like its own button; with the panel closed, the run that failed. After a failed
  // search, the claim box.
  const retrySources = lastSourceRun ? (sourceOpen ? { claim: sourceDraft.claim, ...draftUrls(sourceDraft) } : lastSourceRun) : undefined;
  // Like the panel's own button, Try again is not offered for a list with a link Echo will not read.
  const canRetry = retrySources ? retrySources.urls.length > 0 && retrySources.claim.trim().length >= 8 && retrySources.urls.every((url) => unreadableAddressReason(url) === null) : claim.trim().length >= 8;

  const openTraceFile = () => {
    setImportMessage("");
    traceFileInput.current?.click();
  };

  useEffect(() => () => activeRequest.current?.abort(), []);

  const importTraceFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > MAX_PORTABLE_TRACE_BYTES) {
      setImportMessage("That file is larger than Echo’s 2 MB trace-file limit.");
      return;
    }
    try {
      const analysis = parsePortableTrace(JSON.parse(await file.text()) as unknown);
      if (!analysis) throw new Error("This file is not a supported Echo trace or its source links are invalid.");
      activeRequest.current?.abort();
      setIsRunning(false);
      setProgress(null);
      setForceFresh(false);
      setImportMessage("");
      acceptResult({ ...analysis, importedAt: new Date().toISOString(), cacheHit: false }, false);
      scrollToResult();
    } catch (caught) {
      setImportMessage(caught instanceof Error ? caught.message : "Echo could not open that file.");
    }
  };

  useEffect(() => {
    const updateNetworkStatus = () => setIsOnline(navigator.onLine);
    updateNetworkStatus();
    window.addEventListener("online", updateNetworkStatus);
    window.addEventListener("offline", updateNetworkStatus);
    return () => {
      window.removeEventListener("online", updateNetworkStatus);
      window.removeEventListener("offline", updateNetworkStatus);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = () => {
      if (controller.signal.aborted || document.visibilityState === "hidden" || pending) return;
      // Offline, the check cannot reach the server: say so without sending a request that can only fail (the status
      // reads as a failed check did), and check again on the "online" event.
      if (navigator.onLine === false) { setProviderStatus("unavailable"); return; }
      pending = true;
      void fetch("/api/analyze", { cache: "no-store", signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error("Provider status unavailable.");
          return response.json() as Promise<ProviderConfiguration>;
        })
        .then((configuration) => {
          if (controller.signal.aborted) return;
          setProviderStatus(configuration.liveRunsLocked ? "locked" : !configuration.anthropicConfigured || !configuration.tavilyConfigured ? "missing" : configuration.searchRouter === "misconfigured" ? "misconfigured" : "ready");
          setSearchRouter(configuration.searchRouter === "telem" || configuration.searchRouter === "tavily" ? configuration.searchRouter : null);
          if (configuration.dailyBudget) setDailyBudget(configuration.dailyBudget);
        })
        .catch(() => {
          if (!controller.signal.aborted) setProviderStatus("unavailable");
        })
        .finally(() => { pending = false; });
    };
    refresh();
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const acceptResult = (nextResult: EchoAnalysis, persist = true, priorTrace: EchoAnalysis | null = null) => {
    setResult(nextResult);
    setPreviousTrace(priorTrace?.createdAt === nextResult.createdAt ? null : priorTrace);
    setSelectedId(firstDrawnRoot(nextResult));
    setClaim(nextResult.claim);
    setError(null);
    setProgress(null);
    setIsRunning(false);
    setLiveClaim(null);
    setStalled(false);
    activeRequest.current = null;
    if (persist && nextResult.mode === "live" && (saveCached(nextResult) || saveRecentTrace(nextResult))) setCacheRevision((revision) => revision + 1);
    setForceFresh(false);
    // Every way a result opens (slot, backup, trace file, saved run, live run) keeps the address bar on that claim.
    setShareParams(shareParamsFor(nextResult));
  };

  // Brings a just-opened result into view, as the trace-file import does: at 1280×720 a slot's verdict otherwise opens
  // below the fold and the click looks like it did nothing. Waits a few frames for the result to render.
  // focusHeading: also move the focus to the result's heading (the button pressed sits in a panel that closes, or off
  // screen), so a keyboard or screen-reader user lands on the result the page scrolled to.
  const scrollToResult = (focusHeading = false) => {
    let frames = 0;
    const step = () => {
      // A "Check these sources" result starts with its own headline card ("5 supplied links → 1 independent origin").
      const stack = document.querySelector('[aria-label="Supplied sources result"]') ?? document.querySelector(".result-stack");
      if (stack) {
        stack.scrollIntoView({ behavior: "smooth", block: "start" });
        const heading = focusHeading ? stack.querySelector<HTMLElement>("h2, h1") : null;
        if (heading) {
          if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
          heading.focus({ preventScroll: true });
        }
      } else if ((frames += 1) < 10) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  };

  // A live run's progress card (and the stall note inside it) and a failed run's error banner render below the claim
  // panel, which at 1366×768 and smaller is below the fold. The card is followed as it grows; the banner is revealed once.
  const liveRunShown = isRunning && Boolean(liveClaim);
  useEffect(() => {
    if (liveRunShown) return followIntoView(".loading-card");
  }, [liveRunShown, liveClaim]);
  useEffect(() => {
    if (error) revealOnce(".error-banner", "center");
  }, [error]);

  const updateResult =(nextResult: EchoAnalysis) => {
    setResult(nextResult);
    const savedImported = Boolean(nextResult.importedAt && (readCached(nextResult.claim)?.createdAt === nextResult.createdAt || readRecentTrace(nextResult.claim)?.createdAt === nextResult.createdAt));
    if (nextResult.mode === "live" && (!nextResult.importedAt || savedImported) && (saveCached(nextResult) || saveRecentTrace(nextResult))) setCacheRevision((revision) => revision + 1);
  };

  useEffect(() => {
    if (!isRunning || !liveClaim) return;
    lastProgressAt.current = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - lastProgressAt.current > STALL_MS) setStalled(true);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [isRunning, liveClaim]);

  /** scroll: false for a ?trace= link on first load, where the page should open at the top. */
  const runDemo = async (presetId: string, scroll = true) => {
    const preset = PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    const accept = (nextResult: EchoAnalysis, persist?: boolean) => {
      acceptResult(nextResult, persist);
      if (scroll) scrollToResult();
    };
    setShareParams({ slot: preset.slot });
    // The bundled, scored trace always wins so a later practice run can never replace the demo on stage.
    // A browser's own live run is only a fallback (it stays reachable from the recent-traces list).
    const liveCache = preset.capturedTrace ? null : readCached(preset.claim);
    if (liveCache) {
      accept(liveCache);
      return;
    }
    activeRequest.current?.abort();
    setIsRunning(true);
    setForceFresh(false);
    setResult(null);
    setError(null);
    setClaim(preset.claim);
    if (preset.capturedTrace) {
      setProgress({ stage: "search", label: "Opening a captured live trace", detail: "Loading a real Echo trace saved with the app. No API keys or credits are used." });
      try {
        const response = await fetch(preset.capturedTrace);
        const captured = response.ok ? parsePortableTrace(await response.json()) : null;
        if (captured) {
          const importedAt = new Date().toISOString();
          setBundledImportedAt(importedAt);
          accept({ ...captured, importedAt, cacheHit: false }, false);
          return;
        }
      } catch {
        // Fall through to this browser's live run, then the synthetic fixture, when the bundled trace is unavailable.
      }
      const fallback = readCached(preset.claim);
      if (fallback) {
        accept(fallback);
        return;
      }
    }
    const demo = cloneDemoAnalysis(presetId);
    if (!demo) {
      setIsRunning(false);
      setProgress(null);
      setError({ code: "DEMO_UNAVAILABLE", message: "The captured trace for this preset could not be loaded. Open it with Open trace file, or run the claim live." });
      return;
    }
    setProgress({ stage: "search", label: "Opening cached demo snapshot", detail: "Loading the preset graph stored with Echo. No API keys or network calls are used." });
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    accept(demo);
  };

  const selectBackup = async (backupClaim: string, scroll = true) => {
    const backup = BACKUP_POOL.find((entry) => entry.claim === backupClaim);
    const accept = (nextResult: EchoAnalysis, persist?: boolean) => {
      // A live run started while the saved run loaded is cancelled, as runDemo does: otherwise it keeps spending with
      // no Cancel button, and its result later lands on top of the saved run.
      activeRequest.current?.abort();
      acceptResult(nextResult, persist);
      if (scroll) scrollToResult();
    };
    if (backup?.capturedTrace) {
      try {
        const response = await fetch(backup.capturedTrace);
        const captured = response.ok ? parsePortableTrace(await response.json()) : null;
        if (captured) {
          setClaim(backupClaim);
          const importedAt = new Date().toISOString();
          setBundledImportedAt(importedAt);
          accept({ ...captured, importedAt, cacheHit: false }, false);
          return;
        }
      } catch {
        // Fall back to this browser's live run or an empty claim box.
      }
    }
    const liveCache = readCached(backupClaim);
    if (liveCache) {
      accept(liveCache);
      return;
    }
    activeRequest.current?.abort();
    activeRequest.current = null;
    setForceFresh(false);
    setClaim(backupClaim);
    setResult(null);
    setSelectedId(null);
    setError(null);
    setProgress(null);
    setIsRunning(false);
    document.getElementById("claim-input")?.focus();
  };

  // The saved Check these sources run (SAVED_SOURCE_CHECK): opened from its button in the panel, its chip under MORE
  // SAVED RUNS, a ?trace= link, or a failed or stalled run of the same links. It reads the bundled file only (a GET,
  // offline-cached): nothing is spent. A live run still going is cancelled first, as selectBackup does.
  const openSavedSourceCheck = async (scroll = true, focusHeading = false) => {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setLiveClaim(null);
    setStalled(false);
    setProgress({ stage: "search", label: "Opening a saved run", detail: "Loading a real Echo run of these links saved with the app. No API keys or credits are used." });
    try {
      const response = await fetch(SAVED_SOURCE_CHECK.savedTrace);
      const captured = response.ok ? parsePortableTrace(await response.json()) : null;
      if (captured?.sourceCheck) {
        const importedAt = new Date().toISOString();
        setBundledImportedAt(importedAt);
        acceptResult({ ...captured, importedAt, cacheHit: false }, false);
        setShareParams({ trace: SAVED_SOURCE_CHECK_SLUG });
        if (scroll) scrollToResult(focusHeading);
        return;
      }
    } catch {
      // Said below; the trace file is still in scripts/fixtures for Open trace file.
    }
    setIsRunning(false);
    setProgress(null);
    setShareParams(null);
    setError({ code: "DEMO_UNAVAILABLE", message: "The saved check of these links could not be loaded. Open it with Open trace file (scripts/fixtures/sources-phones-live-2026-11-13-v2.echo.json)." });
  };

  const hasSavedRun = (text: string) => Boolean(savedRunFor(text) || readCached(text) || readRecentTrace(text));

  // Leave a failed or stalled live run for the bundled saved run of the same claim, or this browser's last run of it.
  const openSavedRun = (text: string) => {
    const saved = savedRunFor(text);
    activeRequest.current?.abort();
    activeRequest.current = null;
    setLiveClaim(null);
    setStalled(false);
    if (saved?.kind === "preset") {
      void runDemo(saved.id);
      return;
    }
    if (saved?.kind === "backup") {
      void selectBackup(saved.claim);
      return;
    }
    const local = readCached(text) ?? readRecentTrace(text);
    if (local) {
      acceptResult({ ...local, cacheHit: true });
      scrollToResult();
    }
  };

  // Presenter shortcuts on the claim screen: 1 and 2 open the demo slots, 3 readies a fresh live run. Ignored
  // while typing, during a run, with a modifier key held, or with a dialog (the presentation) open.
  const shortcut = useRef<(key: string, scroll?: boolean) => boolean>(() => false);
  useEffect(() => {
    shortcut.current = (key: string, scroll = true) => {
      if (isRunning) return false;
      const preset = PRESETS.find((entry) => String(Number(entry.slot)) === key);
      if (preset) {
        void runDemo(preset.id, scroll);
        return true;
      }
      if (key !== String(Number(LIVE_SLOT.slot))) return false;
      setForceFresh(true);
      document.getElementById("claim-input")?.focus();
      return true;
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']") || document.querySelector('[role="dialog"]')) return;
      if (shortcut.current(event.key)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Opens a bundled backup run from a ?trace= link (kept current each render, read once on mount below).
  const openBackup = useRef<(claim: string) => void>(() => undefined);
  const openSavedCheck = useRef<() => void>(() => undefined);
  useEffect(() => {
    openBackup.current = (backupClaim: string) => void selectBackup(backupClaim, false);
    openSavedCheck.current = () => void openSavedSourceCheck(false);
  });

  // A shared link: ?slot=02 or ?trace=<bundled run> opens that saved trace; ?claim=… fills the claim box and waits for
  // a click. None of them starts a paid run.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const slotParam = sharedSlotKey(params.get("slot"));
    const slotKey = slotParam ?? sharedTraceSlotKey(params.get("trace"));
    if (slotKey) {
      // A ?slot= link scrolls its verdict into view, as the slot button does (at 1280×720 it otherwise opens below
      // the fold). A ?trace= link naming a slot's run still opens at the top. Neither starts a run.
      shortcut.current(slotKey, Boolean(slotParam));
      return;
    }
    const backupClaim = sharedBackupClaim(params.get("trace"));
    if (backupClaim) {
      openBackup.current(backupClaim);
      return;
    }
    if (sharedSavedSourceCheck(params.get("trace"))) {
      openSavedCheck.current();
      return;
    }
    const shared = params.get("claim")?.replace(/\s+/g, " ").trim().slice(0, 500);
    // ?urls=… (with ?claim=…) fills the Check these sources panel and waits for a click, like ?claim= alone.
    const sharedUrls = urlsFromParam(params.get("urls"));
    if (sharedUrls.length) {
      // ?nums= carries the answer's citation numbers, written back as "[2] https://…" lines the panel reads.
      const sharedNumbers = numbersFromParam(params.get("nums"), sharedUrls.length);
      const timer = window.setTimeout(() => {
        setSourceDraft({ text: sharedSourceText(sharedUrls, sharedNumbers), removed: [], claim: shared ?? "" });
        setSourceOpen(true);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    // A link naming a run that is not bundled (a typo, an old link) leaves the address bar clean instead of
    // showing a ?slot= or ?trace= that opens nothing.
    if (!shared && (params.has("slot") || params.has("trace"))) setShareParams(null);
    if (!shared) return;
    // The address bar is outside React: read it once after hydration, then fill the box from a callback.
    const timer = window.setTimeout(() => setClaim((current) => current || shared), 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Reads the pasted page for checkable sentences; never starts a trace.
  const findClaims = async () => {
    const url = claim.trim();
    if (!navigator.onLine) {
      setArticleScan({ status: "error", url, message: "You are offline. Copy the claim from the page and paste it here." });
      return;
    }
    setArticleScan({ status: "loading", url });
    try {
      const response = await fetch("/api/claims", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
      const body = await response.json().catch(() => ({})) as { title?: string; finalUrl?: string; candidates?: Array<{ text: string; reasons: string[] }>; error?: string };
      if (!response.ok) setArticleScan({ status: "error", url, message: body.error ?? "Echo could not read that page. Copy the claim and paste it instead." });
      else setArticleScan({ status: "done", url, title: body.title, finalUrl: body.finalUrl, candidates: body.candidates ?? [] });
    } catch {
      setArticleScan({ status: "error", url, message: "Echo could not read that page. Copy the claim and paste it instead." });
    }
  };

  // startClaim: the claim to trace when it is not (yet) the box's state (the side panel's start message, /embed).
  const runLive = async (event?: FormEvent<HTMLFormElement>, sources?: { claim: string; urls: string[]; numbers?: number[] }, startClaim?: string) => {
    event?.preventDefault();
    if (isRunning || activeRequest.current) return;
    const requestedClaim = (sources ? sources.claim : startClaim ?? claim).trim();
    setLastSourceRun(sources ? { claim: requestedClaim, urls: sources.urls, numbers: sources.numbers } : null);
    if (requestedClaim.length < 8) {
      setError({ code: "CLAIM_TOO_SHORT", message: "Enter a claim of at least 8 characters." });
      return;
    }
    if (!claimHasWords(requestedClaim)) {
      setError({ code: "CLAIM_NO_WORDS", message: "Write the claim in words, for example “Goldfish have a 3-second memory”." });
      return;
    }
    if (sources && !sources.urls.length) {
      setError({ code: "SOURCES_INVALID", message: "Paste at least one http or https link to check." });
      return;
    }
    // A supplied-sources run is never answered from the browser's saved search runs, which are found by claim alone.
    const shouldForceFresh = sources ? false : forceFresh;
    // A Deep run is never answered from the browser's saved runs (they are Standard ones); the server keeps its own.
    const deepRun = !sources && searchMode === "deep";
    const cached = shouldForceFresh || sources || deepRun ? null : readCached(requestedClaim) ?? readRecentTrace(requestedClaim);
    if (cached) {
      acceptResult({ ...cached, cacheHit: true });
      scrollToResult();
      return;
    }
    if (!navigator.onLine) {
      setError({ code: "OFFLINE", message: `Your browser reports no network connection. The saved runs (the demo slots, the backups and the saved check of five links) and traces saved in this browser still open offline; ${sources ? "reading the supplied links" : "a live search"} needs internet.` });
      return;
    }
    // The server would refuse it (403 PRESENTER_ONLY); say so without sending the request.
    if (providerStatus === "locked") {
      setError({ code: "PRESENTER_ONLY", message: "Live runs on this copy of Echo are reserved for the presenter. Open a saved run to explore Echo." });
      return;
    }

    const priorTrace = shouldForceFresh ? readCached(requestedClaim) ?? readRecentTrace(requestedClaim) ?? (result?.mode === "live" && cacheKey(result.claim) === cacheKey(requestedClaim) ? result : null) : null;

    const controller = new AbortController();
    activeRequest.current = controller;
    setIsRunning(true);
    setResult(null);
    setSelectedId(null);
    setError(null);
    setProgress(sources
      ? { stage: "search", label: "Using the links you supplied", detail: `Reading ${sources.urls.length === 1 ? "1 link" : `${sources.urls.length} links`}; no web search.` }
      : { stage: "queries", label: "Building search variants", detail: "Starting the source search." });
    setLiveDomains([]);
    setLivePlan(null);
    setLiveTelemFallback(false);
    setLiveDeep(deepRun);
    setLiveClaim(requestedClaim);
    setStalled(false);

    const startedAt = clockMs();
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(sources ? { claim: requestedClaim, urls: sources.urls, forceFresh: shouldForceFresh } : deepRun ? { claim: requestedClaim, forceFresh: shouldForceFresh, searchMode: "deep" } : { claim: requestedClaim, forceFresh: shouldForceFresh }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { code?: string; error?: string };
        throw new EchoClientError(body.error || `Request failed (${response.status}).`, body.code);
      }
      if (!response.body) throw new Error("The analysis stream was empty. Please try again.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;

      const processFrame = (frame: string) => {
        const lines = frame.split("\n");
        const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        const dataLine = lines.find((line) => line.startsWith("data:"))?.slice(5).trim();
        if (!eventName || !dataLine) return;
        const data = JSON.parse(dataLine) as EchoAnalysis | PipelineProgress | StreamError;
        if (eventName === "progress") {
          lastProgressAt.current = Date.now();
          setStalled(false);
          setProgress(data as PipelineProgress);
          if ((data as PipelineProgress).searchFallback === "telem-daily-cap") setLiveTelemFallback(true);
          const found = (data as PipelineProgress).domains;
          if (Array.isArray(found) && found.length) setLiveDomains((current) => mergeDomains(current, found));
          // The search plan (a search run only: Check these sources reads the links and never searches).
          if (!sources) {
            const planned = planFrom((data as PipelineProgress).queries);
            if (planned) setLivePlan(planned);
            const queriesDone = (data as PipelineProgress).queriesDone;
            if (queriesDone !== undefined) setLivePlan((current) => advancePlan(current, queriesDone));
            const routed = (data as PipelineProgress).queryProviders;
            if (routed !== undefined) setLivePlan((current) => routePlan(current, routed));
          }
        }
        if (eventName === "result") {
          // The answer's citation numbers stay in the browser (the server and its cache key see only the links).
          acceptResult(withCitationNumbers(data as EchoAnalysis, sources), true, priorTrace);
          setLiveRunTime({ createdAt: (data as EchoAnalysis).createdAt, seconds: Math.round((clockMs() - startedAt) / 1000) });
          // Deep is for one run: the next run is Standard unless Deep is chosen again (a failed Deep run keeps it, so
          // Try again repeats it).
          if (deepRun) setSearchMode("standard");
          // The finished trace replaces the progress card: bring its verdict into view, as opening a slot does.
          scrollToResult();
          completed = true;
        }
        if (eventName === "error") {
          const streamError = data as StreamError;
          throw new EchoClientError(streamError.message || "The analysis could not finish.", streamError.code, streamError.costReceipt);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          processFrame(frame);
          boundary = buffer.indexOf("\n\n");
        }
        if (done) break;
      }
      if (!completed) throw new Error("The analysis ended before the result arrived.");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError({
        code: caught instanceof EchoClientError ? caught.code || "ANALYSIS_FAILED" : "ANALYSIS_FAILED",
        message: caught instanceof Error ? caught.message : "Echo could not finish this analysis.",
        costReceipt: caught instanceof EchoClientError ? caught.costReceipt : undefined,
      });
      setIsRunning(false);
      setProgress(null);
      setLiveClaim(null);
      setStalled(false);
      activeRequest.current = null;
    }
  };

  const cancelAnalysis = () => {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setIsRunning(false);
    setProgress(null);
    setLiveClaim(null);
    setStalled(false);
  };

  const clearResult = () => {
    activeRequest.current?.abort();
    setShareParams(null);
    setResult(null);
    setPreviousTrace(null);
    setSelectedId(null);
    setError(null);
    setProgress(null);
    setClaim("");
    setForceFresh(false);
    setSearchMode("standard");
    setIsRunning(false);
    setLiveClaim(null);
    setStalled(false);
    setLastSourceRun(null);
    // Home is a clean page: the Check these sources panel closes and forgets its links (QA round 6, S2: it stayed open
    // with the sample answer between the claim box and the next run's wait card). Copy link and ?urls= still refill it.
    setSourceOpen(false);
    setSourceFocus(false);
    setSourceDraft(EMPTY_SOURCE_DRAFT);
    setArticleScan(null);
    activeRequest.current = null;
    window.requestAnimationFrame(() => document.getElementById("claim-input")?.focus());
  };

  // Which kind of live run is in progress, so each button's busy label names only its own kind ("Tracing" for a
  // search, "Checking" for supplied links); the other button is just disabled. Opening a saved run is neither.
  const liveRunKind = isRunning && liveClaim ? (lastSourceRun ? "sources" : "search") : null;

  // /embed: the browser extension's start message (embed-bridge.ts: an allowlisted extension origin and this page's
  // one-time nonce) starts one run, exactly as its button would. Nothing else in a message, a link or a timer can.
  const embedStart = useEmbedStart(embed, (job) => {
    if (job.urls) {
      setSourceDraft({ text: sharedSourceText(job.urls, null), removed: [], claim: job.claim });
      setSourceOpen(true);
      void runLive(undefined, { claim: job.claim, urls: job.urls });
      return;
    }
    setClaim(job.claim);
    void runLive(undefined, undefined, job.claim);
  });
  // A tab the side panel opened with "Open full result": the trace it hands over opens like a saved run (no spend).
  useOpenerHandoff(!embed, (analysis) => {
    acceptResult({ ...analysis, cacheHit: true });
    scrollToResult();
  });

  if (embed) {
    const draft = draftUrls(sourceDraft);
    return (
      <EmbedShell>
        {!isRunning && !result && (sourceOpen ? (
          <SourceCheckPanel
            action={(
              <button className="trace-button" disabled={isRunning || !draft.urls.length || sourceDraft.claim.trim().length < 8 || unreadableDraftLinks(sourceDraft) > 0} onClick={() => { const { urls, numbers } = draftUrls(sourceDraft); void runLive(undefined, { claim: sourceDraft.claim, urls, numbers }); }} type="button">
                <span>{!draft.urls.length ? "Add links to check" : `Check ${draft.urls.length === 1 ? "1 source" : `${draft.urls.length} sources`}`}</span><span aria-hidden="true">↗</span>
              </button>
            )}
            disabled={isRunning}
            draft={sourceDraft}
            onChange={setSourceDraft}
            onClose={() => setSourceOpen(false)}
          />
        ) : (
          <EmbedClaimForm
            action={(
              <button className={EMBED_RUN_BUTTON} disabled={isRunning || claim.trim().length < 8} onClick={() => void runLive()} type="submit">
                {savedForInput ? "Open saved trace" : "Trace sources"}
              </button>
            )}
            claim={claim}
            onClaimChange={setClaim}
          />
        ))}
        {/* The wait card names its claim itself; a result gets it here. */}
        {result && !isRunning && <EmbedClaim claim={result.claim} links={result.sourceCheck?.urls.length ?? 0} />}
        <EmbedStartNote parent={embedStart.parent} state={embedStart.state} />
        {error && <EmbedError action={RETRYABLE_ERRORS.has(error.code ?? "") && isOnline && canRetry ? <button className="error-fallback" onClick={() => void runLive(undefined, retrySources && { claim: retrySources.claim, urls: retrySources.urls, numbers: retrySources.numbers })} type="button">Try again</button> : undefined} code={error.code} message={error.message ?? ""} onDismiss={() => setError(null)} />}
        {isRunning && <LoadingPanel claim={liveClaim ?? undefined} domains={liveClaim ? liveDomains : []} key={liveClaim ?? "saved-run"} onCancel={cancelAnalysis} plan={liveClaim && !lastSourceRun ? livePlan : null} progress={progress} sourceCount={liveClaim && lastSourceRun ? lastSourceRun.urls.length : undefined} stalled={stalled} />}
        {result && !isRunning && <EmbedResult fullHref={`/?${new URLSearchParams(shareParamsFor(result))}`} onReset={clearResult} result={result} />}
      </EmbedShell>
    );
  }

  return (
    <>
    <a className="skip-link" href="#claim-input">Skip to claim input</a>
    <main className="page-shell" id="main-content">
      <input accept=".json,application/json" aria-label="Open saved Echo trace file" className="visually-hidden-input" onChange={importTraceFile} ref={traceFileInput} type="file" />
      <header className="topbar">
        {/* The app is already at "/", so a plain click resets the workbench; a modified click still opens a new tab. */}
        <Link aria-label="Echo home" className="brand" href="/" onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          clearResult();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}>
          <BrandMark />
          <span>echo<span className="brand-period">.</span></span>
        </Link>
        <div className="topbar-center"><span className="topbar-rule" />INDEPENDENCE LAYER FOR AI SEARCH</div>
        {/* Said only when it matters: online is the normal case. The live region stays mounted so going offline is announced. */}
        <div aria-live="polite" className={`topbar-status ${isOnline ? "network-online" : "network-offline"}`}>
          {!isOnline && <><span className="status-light" />OFFLINE · SAVED RUNS STILL OPEN</>}
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow hero-eyebrow">SOURCE INTELLIGENCE / 01</p>
          <h1>Many pages can still be <em>one rumor.</em></h1>
          <p className="hero-description">Echo traces a claim through the pages that repeat it, or checks the links an AI answer cites, then finds the independent origins and answers from those origins only.</p>
          <Link className="hero-how-link" href="/how">How Echo works, in four steps →</Link>
          <Link className="hero-how-link" href="/origins">See the origin layer: saved live Telem runs →</Link>
        </div>
        <div className="hero-stamp" aria-hidden="true"><span>TRACE</span><BrandMark /><span>THE ORIGIN</span></div>
      </section>

      <section className="claim-panel">
        {!isOnline && <div className="offline-notice" role="status"><strong>Offline mode</strong><span>{`The saved live runs (slots ${PRESETS.map((preset) => preset.slot).join(" and ")}, the backups and the saved check of five links) still open, as do traces saved in this browser. Live searches need a connection.`}</span></div>}
        <form onSubmit={(event) => {
          if (isUrlInput) {
            event.preventDefault();
            void findClaims();
            return;
          }
          void runLive(event);
        }}>
          <div className="claim-head">
            <label className="claim-label" htmlFor="claim-input"><span>01</span> WHAT CLAIM DO YOU WANT TO TRACE?</label>
            <SourceCheckOpenButton onOpen={() => {
              if (sourceOpen) { const box = document.getElementById("source-check-text"); box?.scrollIntoView?.({ block: "nearest" }); box?.focus(); return; }
              setSourceFocus(true); setSourceOpen(true);
            }} open={sourceOpen} />
          </div>
          <div className="claim-row">
            <input
              autoComplete="off"
              id="claim-input"
              maxLength={500}
              onChange={(event) => setClaim(event.target.value)}
              placeholder="Paste a statistic, headline or sentence — or an article's link…"
              value={claim}
            />
            {/* Standard (today's run, the default) or Deep (more searches' results, up to 50 pages, batched judging) for
                the next run only. A plain toggle: nothing runs until Trace sources is pressed. */}
            {!isUrlInput && (
              <div aria-label="Search depth for the next run" className="search-mode-toggle" role="radiogroup">
                {(["standard", "deep"] as const).map((mode) => (
                  <button aria-checked={searchMode === mode} className={searchMode === mode ? "is-selected" : ""} data-mode={mode} disabled={isRunning} key={mode} onClick={() => setSearchMode(mode)} role="radio" title={mode === "deep" ? deepSearchTooltip(providerStatus === "misconfigured" ? "misconfigured" : searchRouter) : "Standard search: up to 13 searches, the 20 best pages read and judged (≈$0.2 · under 1 min)."} type="button">
                    {mode === "deep" ? "Deep" : "Standard"}
                  </button>
                ))}
              </div>
            )}
            <button className="trace-button" disabled={isRunning || claim.trim().length < 8 || articleScan?.status === "loading"} type="submit">
              <span>{isUrlInput ? (articleScan?.status === "loading" ? "Reading the page" : "Find claims in this page") : liveRunKind === "search" ? "Tracing" : savedForInput ? "Open saved trace" : forceFresh ? "Run fresh search" : "Trace sources"}</span><span aria-hidden="true">↗</span>
            </button>
          </div>
          {articleScan && (
            <div aria-live="polite" className="article-scan">
              <div className="article-scan-head">
                <span>{articleScan.status === "loading" ? "Reading the page…" : articleScan.status === "error" ? "Could not read that page" : articleScan.title || hostOf(articleScan.finalUrl ?? articleScan.url)}</span>
                <button aria-label="Close the article's suggestions" onClick={() => setArticleScan(null)} type="button">×</button>
              </div>
              {articleScan.status === "error" && <p className="article-scan-note">{articleScan.message}</p>}
              {articleScan.status === "done" && (articleScan.candidates?.length ? (
                <>
                  <p className="article-scan-note">Pick the sentence to trace. Nothing runs until you press Trace sources.</p>
                  <ul className="article-scan-list">
                    {articleScan.candidates.map((candidate) => (
                      <li key={candidate.text}>
                        <button onClick={() => { setClaim(candidate.text.slice(0, 500)); window.requestAnimationFrame(() => document.getElementById("claim-input")?.focus()); }} type="button">
                          <span>{candidate.text}</span><small>{candidate.reasons.join(" · ")}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : <p className="article-scan-note">No sentence with a figure or a named source found on this page. Copy the claim from the page and paste it here.</p>)}
            </div>
          )}
          {savedForInput && <p className="saved-input-note">Saved live result from {formatRunDate(savedForInput.createdAt)} · opens without search or model credits.</p>}
          <div className="claim-footer">
            <div className="claim-slot-row">
              <div className="preset-list">
                <span className="preset-label">DEMO SLOTS</span>
                {PRESETS.map((preset) => (
                  <button aria-keyshortcuts={String(Number(preset.slot))} className={`preset-chip preset-${preset.id}`} disabled={isRunning} key={preset.id} onClick={() => void runDemo(preset.id)} title={`Open slot ${preset.slot} (press ${Number(preset.slot)})`} type="button">
                    <span className="preset-number">{preset.slot}</span>{preset.label}<span className="preset-arrow">↗</span>
                  </button>
                ))}
                <button aria-keyshortcuts={String(Number(LIVE_SLOT.slot))} className="preset-chip preset-live" disabled={isRunning} onClick={() => { setForceFresh(true); document.getElementById("claim-input")?.focus(); }} title={`Slot ${LIVE_SLOT.slot} always runs a fresh search (press ${Number(LIVE_SLOT.slot)})`} type="button">
                  <span className="preset-number">{LIVE_SLOT.slot}</span>{LIVE_SLOT.label}<span className="preset-arrow">↗</span>
                </button>
              </div>
              <span className={`key-note provider-note-${providerStatus}`}>
                <span>{providerStatus === "ready"
                  ? `Provider keys configured${searchRouter ? ` · Search: ${searchRouter === "telem" ? "Telem" : "Tavily"}` : ""} · Slot 03 always fresh`
                  : providerStatus === "locked"
                    ? "Live runs are reserved for the presenter here · open a saved run"
                    : providerStatus === "missing"
                      ? "Live search isn't set up on this copy · saved runs still open"
                      : providerStatus === "misconfigured"
                        ? "Search is set to Telem, but its key is missing or is not a Telem key · fix the key, or set ECHO_SEARCH_ROUTER=tavily in .env.local and restart · saved runs still open"
                      : providerStatus === "unavailable"
                        ? "Could not check live setup · saved runs still open"
                        : "Checking live search setup…"}</span>
                {providerStatus !== "locked" && providerStatus !== "missing" && dailyBudget && <small className={dailyBudget.available ? "" : "provider-note-unavailable"}>
                  {/* One cap per provider (daily-budget.ts): Telem's with its running total, Claude's ceiling, Tavily's. */}
                  {budgetLine(dailyBudget, providerStatus === "misconfigured" ? "misconfigured" : searchRouter)}
                </small>}
              </span>
            </div>
            <div className="backup-row">
              <span className="preset-label">MORE SAVED RUNS</span>
              {BACKUP_POOL.map((backup) => (
                <button className="preset-chip backup-chip" disabled={isRunning} key={backup.claim} onClick={() => void selectBackup(backup.claim)} title={backup.capturedTrace ? `${backup.claim} (saved live run)` : `${backup.claim} (untested: fills the claim box for a live run)`} type="button">
                  {backup.label}<span className="preset-arrow">{backup.capturedTrace ? "↗" : "＋"}</span>
                </button>
              ))}
              <button className="preset-chip backup-chip saved-check-chip" disabled={isRunning} onClick={() => void openSavedSourceCheck()} title={SAVED_CHECK_TITLE} type="button">
                {SAVED_SOURCE_CHECK.label}<span className="preset-arrow">↗</span>
              </button>
            </div>
          </div>
        </form>
      </section>
      {sourceOpen && (
        <SourceCheckPanel
          action={(
            <button className="trace-button" disabled={isRunning || !draftUrls(sourceDraft).urls.length || sourceDraft.claim.trim().length < 8 || unreadableDraftLinks(sourceDraft) > 0} onClick={() => { const { urls, numbers } = draftUrls(sourceDraft); void runLive(undefined, { claim: sourceDraft.claim, urls, numbers }); }} type="button">
              <span>{liveRunKind === "sources" ? "Checking" : !draftUrls(sourceDraft).urls.length ? "Add links to check" : `Check ${draftUrls(sourceDraft).urls.length === 1 ? "1 source" : `${draftUrls(sourceDraft).urls.length} sources`}`}</span><span aria-hidden="true">↗</span>
            </button>
          )}
          disabled={isRunning}
          draft={sourceDraft}
          // The panel closes and the focus moves to the result's heading: the panel's button would be left focused off
          // screen, with the panel still open above the result (QA round 5, S3-10).
          saved={{ label: SAVED_SOURCE_CHECK.label, title: SAVED_CHECK_TITLE, onOpen: () => { setSourceOpen(false); void openSavedSourceCheck(true, true); } }}
          focusText={sourceFocus}
          onChange={(next) => {
            // A refusal of the links ("localhost is not a public web address…") goes once the links it was about change.
            if (error?.code === "SOURCES_INVALID" && draftUrls(next).urls.join(" ") !== draftUrls(sourceDraft).urls.join(" ")) setError(null);
            setSourceDraft(next);
          }}
          onClose={() => {
            setSourceOpen(false);
            // The panel and its × go away: the focus returns to the button that opens it, not to the page body.
            window.requestAnimationFrame(() => document.getElementById("source-check-open")?.focus());
          }}
        />
      )}

      {/* A presenter's check, not a visitor's: hidden on a locked deployment (and until the status check answers),
          always shown offline, where it says what still opens. */}
      {(!isOnline || (providerStatus !== "locked" && providerStatus !== "checking")) && <OfflineReadiness cacheRevision={cacheRevision} />}
      <RecentTraces
        isRunning={isRunning}
        onOpen={(analysis) => { acceptResult({ ...analysis, cacheHit: true }, false); scrollToResult(); }}
        onRefresh={(savedClaim) => { setClaim(savedClaim); setForceFresh(true); setResult(null); setError(null); window.requestAnimationFrame(() => document.getElementById("claim-input")?.focus()); }}
        onRemove={(savedClaim) => { if (removeRecentTrace(savedClaim)) setCacheRevision((revision) => revision + 1); }}
        revision={cacheRevision}
      />

      {importMessage && <div className="import-error" role="alert">{importMessage}<button aria-label="Dismiss file error" onClick={() => setImportMessage("")} type="button">×</button></div>}

      {error && (
        <div className="error-banner" role="alert">
          <span className="error-symbol">!</span>
          <div><strong>{error.code === "SOURCES_INVALID" ? "Check the supplied links" : error.code === "MISSING_KEYS" ? "Live analysis is not configured yet" : error.code === "TELEM_CREDIT" ? "Telem's search credit ran out" : error.code === "TELEM_AUTH" ? "Telem rejected the key" : error.code === "CLAUDE_ACCOUNT_LIMIT" ? "Claude account limit reached" : error.code === "DAILY_BUDGET_REACHED" || error.code === "TELEM_DAILY_CAP" ? "Daily spending cap reached" : error.code === "BUDGET_STORAGE_UNAVAILABLE" ? "Live calls are paused to protect your cap" : error.code === "CLAIM_TOO_SHORT" || error.code === "CLAIM_NO_WORDS" ? "Write the claim to trace" : error.code === "PRESENTER_ONLY" ? "Live runs are reserved for the presenter" : error.code === "OFFLINE" ? "You are offline" : "This run needs another try"}</strong><p>{error.message}</p>{failedRunSpend(error.costReceipt) && <p className="error-spend">{failedRunSpend(error.costReceipt)}</p>}{RETRYABLE_ERRORS.has(error.code ?? "") && isOnline && canRetry && <button className="error-fallback" onClick={() => void runLive(undefined, retrySources && { claim: retrySources.claim, urls: retrySources.urls, numbers: retrySources.numbers })} type="button">Try again</button>}{error.code !== "CLAIM_TOO_SHORT" && error.code !== "CLAIM_NO_WORDS" && !lastSourceRun && hasSavedRun(claim) && <button className="error-fallback" onClick={() => openSavedRun(claim)} type="button">Open the saved run of this claim</button>}{error.code !== "DEMO_UNAVAILABLE" && matchesSavedSourceCheck(lastSourceRun) && <button className="error-fallback" onClick={() => void openSavedSourceCheck()} type="button">Open the saved run of these links</button>}</div>
          <button aria-label="Dismiss error" className="error-close" onClick={() => setError(null)} type="button">×</button>
        </div>
      )}

      {/* Keyed by the live claim, so leaving a stalled run for its saved trace starts a fresh card (clock at 0:00).
          A live card names the claim it traces, since at 1366×768 and smaller the claim box can scroll off screen. */}
      {isRunning && <LoadingPanel claim={liveClaim ?? undefined} domains={liveClaim ? liveDomains : []} key={liveClaim ?? "saved-run"} onCancel={cancelAnalysis} onFallback={liveClaim && !lastSourceRun && hasSavedRun(liveClaim) ? () => openSavedRun(liveClaim) : liveClaim && matchesSavedSourceCheck(lastSourceRun) ? () => void openSavedSourceCheck() : undefined} plan={liveClaim && !lastSourceRun ? livePlan : null} progress={progress} sourceCount={liveClaim && lastSourceRun ? lastSourceRun.urls.length : undefined} stalled={stalled} telemFallback={Boolean(liveClaim) && liveTelemFallback} deep={Boolean(liveClaim) && liveDeep} />}
      {result?.sourceCheck && !isRunning && <SourceCheckSummary result={result} />}
      {result && !isRunning && <ResultView isBundledRun={Boolean(result.importedAt && result.importedAt === bundledImportedAt)} liveSeconds={liveRunTime?.createdAt === result.createdAt ? liveRunTime.seconds : undefined} isSavedHere={Boolean(savedForInput && savedForInput.createdAt === result.createdAt)} key={`${result.mode}:${result.claim}:${result.createdAt}`} onOpenTrace={openTraceFile} onReset={clearResult} onSaveImported={() => { if (saveCached(result) || saveRecentTrace(result)) setCacheRevision((revision) => revision + 1); else setImportMessage("This imported trace is incomplete or browser storage is unavailable, so Echo could not keep it here. You can still save a trace file."); }} onSelect={setSelectedId} onUpdateResult={updateResult} previousTrace={previousTrace} result={result} selectedId={selectedId} />}
      {!result && !isRunning && !error && (
        <section className="empty-state">
          <div className="empty-art" aria-hidden="true">
            <span className="art-node art-root">A</span><span className="art-link art-link-one" /><span className="art-node art-copy-one">B</span>
            <span className="art-link art-link-two" /><span className="art-node art-copy-two">C</span><span className="art-link art-link-three" /><span className="art-node art-copy-three">D</span>
            <span className="art-cross">×</span>
          </div>
          <div className="empty-copy"><span className="eyebrow">FOLLOW THE SOURCE, NOT THE CROWD</span><h2>Start with one claim.</h2><p>Open a saved run, or paste a claim and Echo traces it across the web.</p><button className="empty-open-file" onClick={openTraceFile} type="button">Open a saved trace file <span>↗</span></button></div>
          <div className="empty-bottom"><span>01 <b>SEARCH</b></span><span>02 <b>CLUSTER</b></span><span>03 <b>TRACE</b></span><span>04 <b>ANSWER</b></span></div>
        </section>
      )}

      <details className="glossary" id="glossary" onToggle={(event) => {
        if (!event.currentTarget.open || glossaryExample || !GLOSSARY_EXAMPLE_TRACE) return;
        void fetch(GLOSSARY_EXAMPLE_TRACE).then((response) => (response.ok ? response.json() : null)).then((body) => {
          const parsed = body ? parsePortableTrace(body) : null;
          if (parsed) setGlossaryExample(parsed);
        }).catch(() => undefined);
      }}>
        <summary><span>PLAIN-LANGUAGE GLOSSARY</span><b>{GLOSSARY.length} terms</b></summary>
        <dl className="glossary-grid">
          {GLOSSARY.map(([term, definition]) => (
            <div className="glossary-entry" key={term}>
              <dt>{term}</dt>
              <dd>{definition}<GlossaryExample example={glossaryExample} term={term} /></dd>
            </div>
          ))}
        </dl>
      </details>

      <footer className="page-footer">
        <span>© ECHO · SOURCE INDEPENDENCE PROTOTYPE · <Link className="footer-link" href="/explore">EXPLORE REAL TRACES ↗</Link> · <Link className="footer-link" href="/anywhere">TRACE FROM ANY PAGE ↗</Link></span>
        <span>{result?.importedAt ? (result.importedAt === bundledImportedAt ? "SAVED LIVE RUN" : "IMPORTED SNAPSHOT") : result?.cacheHit ? "CACHED ANALYSIS" : result?.mode === "demo" ? "LOCAL DEMO DATA" : "PROBABILISTIC BY DESIGN"}</span>
      </footer>
    </main>
    </>
  );
}
