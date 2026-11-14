// Relative, not "@/": the offline checks load this file without the path alias.
import { summarizeTraceSignals } from "../lib/echo/graph";
import { answerNumberGrounding } from "../lib/echo/grounding";
import { isProviderName, providerDisplayName, providerList } from "../lib/echo/search-providers";
import { visibleEdgeSignals } from "../lib/echo/wording";
import type { EchoAnalysis, EchoPage } from "@/lib/echo/types";

// How a trace's verdict and dated span read, shared by the workbench and the Explore gallery so a gallery card can
// never say something the trace page does not.

/** Wall-clock milliseconds, for timing a live run and for the future-date check in datedSpanOf. */
export function clockMs() {
  return Date.now();
}

/**
 * Pages whose date was read off the page itself (page text, URL or metadata; never a search estimate), as a plain year
 * or ISO date no later than two days ahead (the pipeline's own limit, for time zones), oldest first. A hand-edited or
 * damaged trace's odd or future dates are left out.
 */
export function reliablyDatedPages(result: EchoAnalysis): EchoPage[] {
  const latest = new Date(clockMs() + 2 * 86_400_000).toISOString().slice(0, 10);
  return result.pages
    .filter((page) => page.publishedDate && page.publishedDateSource && page.publishedDateSource !== "Tavily estimate"
      && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(page.publishedDate) && page.publishedDate <= latest)
    .sort((a, b) => a.publishedDate!.localeCompare(b.publishedDate!));
}

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2019", "2019-05" or "2019-05-03" as a UTC day number (a year alone is its January 1). */
export function dayNumberOf(date: string): number {
  const [year, month = "01", day = "01"] = date.split("-");
  return Date.UTC(Number(year), Number(month) - 1, Number(day)) / DAY_MS;
}

/** How much of a page date is known: "2019" is a year, "2019-05" a month, "2019-05-03" a day. */
export function datePrecision(date: string): "year" | "month" | "day" {
  return date.length === 4 ? "year" : date.length === 7 ? "month" : "day";
}

/** The last day a date can mean: December 31 for a year alone, the month's last day for a month, else the day itself. */
export function lastDayOf(date: string): number {
  const [year, month = 1] = date.split("-").map(Number);
  const precision = datePrecision(date);
  if (precision === "year") return Date.UTC(year + 1, 0, 1) / DAY_MS - 1;
  if (precision === "month") return Date.UTC(year, month, 1) / DAY_MS - 1;
  return dayNumberOf(date);
}

/** A page date as a reader should see it: "2019 (year only)", "May 2019 (month only)", or the full date as given. */
export function pageDateLabel(date: string): string {
  const precision = datePrecision(date);
  if (precision === "year") return `${date} (year only)`;
  if (precision === "month") return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)} (month only)`;
  return date;
}

/**
 * The page that is surely no later than any other: the one whose date can mean the earliest last day, and on a tie the
 * more precise date. So "2019 (year only)" never wins "earliest" over "May 3, 2019" (it may be from December), while
 * "2018 (year only)" still beats it.
 */
export function earliestDatedPage(dated: EchoPage[]): EchoPage {
  const rank = { day: 0, month: 1, year: 2 };
  return [...dated].sort((a, b) => lastDayOf(a.publishedDate!) - lastDayOf(b.publishedDate!)
    || rank[datePrecision(a.publishedDate!)] - rank[datePrecision(b.publishedDate!)])[0];
}

/** A day number as "May 2021" (coarse) or "May 3, 2021" (fine), for the spread's sweep heading. */
export function spreadDateLabel(day: number, fine: boolean): string {
  const date = new Date(day * DAY_MS);
  return fine ? `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}` : `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export const SPREAD_ROWS: Array<{ kind: EchoPage["judgment"]["kind"]; label: string; y: number }> = [
  { kind: "origin", label: "Origins", y: 46 },
  { kind: "derived", label: "Echoes", y: 112 },
  { kind: "unclear", label: "Unclear", y: 178 },
];
export const SPREAD_DOT = 7;
const STACK_LEVELS = 4;
const TICK_GAP = 56;

/**
 * Where the echo-spread timeline draws each page, in SVG units of a chart `width` wide (the chart is drawn about one
 * unit per screen pixel, so labels stay readable on a phone). Pages on one row closer than a dot apart stack upward,
 * up to four high; any more at that spot are counted in `overflow`, shown as "+N", so no page is hidden silently.
 * Ticks are years, months or days depending on the span, spaced so their labels never crowd.
 */
export function spreadLayout(dated: EchoPage[], width: number) {
  const left = width < 560 ? 66 : 92;
  const right = 24;
  const first = dayNumberOf(dated[0].publishedDate!);
  const last = dayNumberOf(dated[dated.length - 1].publishedDate!);
  // A trace whose pages all share one day is drawn around that day rather than against the left edge.
  const from = last > first ? first : first - 1;
  const to = last > first ? last : last + 1;
  const xOf = (day: number) => left + ((day - from) / (to - from)) * (width - left - right);
  const placed: Array<{ page: EchoPage; day: number; x: number; y: number }> = [];
  const overflow: Array<{ x: number; y: number; count: number }> = [];
  const levels: number[] = [];
  for (const page of dated) {
    const row = SPREAD_ROWS.find((entry) => entry.kind === page.judgment.kind) ?? SPREAD_ROWS[2];
    const day = dayNumberOf(page.publishedDate!);
    const x = xOf(day);
    const near = placed.map((other, index) => ({ other, index })).filter(({ other }) => other.page.judgment.kind === row.kind && Math.abs(other.x - x) < SPREAD_DOT * 2);
    const taken = new Set(near.map(({ index }) => levels[index]));
    const level = [0, 1, 2, 3].find((candidate) => !taken.has(candidate)) ?? STACK_LEVELS;
    if (level >= STACK_LEVELS) {
      // Drawn under the top of the nearest stack and counted there.
      const top = near.filter(({ index }) => levels[index] === STACK_LEVELS - 1).sort((a, b) => Math.abs(a.other.x - x) - Math.abs(b.other.x - x))[0]?.other ?? near[near.length - 1].other;
      const badge = overflow.find((entry) => entry.x === top.x && entry.y === top.y);
      if (badge) badge.count += 1;
      else overflow.push({ x: top.x, y: top.y, count: 1 });
      placed.push({ page, day, x: top.x, y: top.y });
      levels.push(STACK_LEVELS - 1);
      continue;
    }
    placed.push({ page, day, x, y: row.y - level * (SPREAD_DOT * 1.6) });
    levels.push(level);
  }
  const room = Math.max(1, Math.floor((width - left - right) / TICK_GAP));
  const ticks: Array<{ label: string; x: number }> = [];
  const span = last - first;
  if (span >= 730) {
    const firstYear = new Date(first * DAY_MS).getUTCFullYear();
    const lastYear = new Date(last * DAY_MS).getUTCFullYear();
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((candidate) => (lastYear - firstYear) / candidate <= room) ?? 1000;
    for (let year = Math.ceil(firstYear / step) * step; year <= lastYear; year += step) {
      const day = Date.UTC(year, 0, 1) / DAY_MS;
      if (day >= first) ticks.push({ label: String(year), x: xOf(day) });
    }
  } else if (span >= 60) {
    const step = [1, 2, 3, 6, 12].find((candidate) => span / 30.4 / candidate <= room) ?? 12;
    const start = new Date(first * DAY_MS);
    for (let month = start.getUTCFullYear() * 12 + start.getUTCMonth(); ; month += 1) {
      const day = Date.UTC(Math.floor(month / 12), month % 12, 1) / DAY_MS;
      if (day > last) break;
      if (day < first || (month % 12) % step) continue;
      ticks.push({ label: month % 12 === 0 ? String(month / 12) : MONTHS[month % 12], x: xOf(day) });
    }
  } else {
    const step = [1, 2, 7, 14, 30].find((candidate) => Math.max(span, 1) / candidate <= room) ?? 30;
    for (let day = Math.ceil(from); day <= to; day += step) {
      if (day < first || day > last) continue;
      const date = new Date(day * DAY_MS);
      ticks.push({ label: `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`, x: xOf(day) });
    }
  }
  return { placed, overflow, ticks, first, last, left, right, xOf, fineDates: span < 60 };
}

/** The years a claim has been repeated across reliablyDatedPages; null with fewer than two or all in one year. */
export function datedSpanOf(result: EchoAnalysis): { first: EchoPage; from: string; to: string; count: number } | null {
  const dated = reliablyDatedPages(result);
  if (dated.length < 2) return null;
  const from = dated[0].publishedDate!.slice(0, 4);
  const to = dated[dated.length - 1].publishedDate!.slice(0, 4);
  return from === to ? null : { first: earliestDatedPage(dated), from, to, count: dated.length };
}


/**
 * How the page count adds up, from the trace's own fields, e.g. "13 pages = 3 root pages (2 independent origins; pages
 * published together count once) + 4 confirmed copies + 6 unclear". Copies are the trace strip's "confirmed copies"
 * count. Root pages are a page count; independent origins count pages published together once.
 */
export function pageBreakdownLine(result: EchoAnalysis): string {
  const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const total = result.summary.totalPages;
  const ids = new Set(result.pages.map((page) => page.id));
  const rootPages = result.roots.filter((id) => ids.has(id)).length;
  const origins = result.summary.independentOrigins;
  const copies = summarizeTraceSignals(result.pages).likelyEchoes;
  const unclear = result.pages.filter((page) => page.judgment.kind === "unclear").length;
  const rest = total - rootPages - copies - unclear;
  const together = rootPages === origins ? "" : "; pages published together count once";
  const rootPart = `${counted(rootPages, "root page", "root pages")} (${counted(origins, "independent origin", "independent origins")}${together})`;
  const parts = [rootPart, counted(copies, "confirmed copy", "confirmed copies"), `${unclear} unclear`, ...(rest > 0 ? [`${rest} not yet judged`] : [])];
  return `${counted(total, "page", "pages")} = ${parts.join(" + ")}`;
}

/**
 * How Echo names origins whose passages show data, a study or reporting of their own (summary.verifiableOrigins):
 * "none with its own evidence", "1 with its own evidence", "2 with their own evidence".
 */
export function withOwnEvidence(count: number): string {
  return `${count === 0 ? "none" : count} with ${count > 1 ? "their" : "its"} own evidence`;
}

/**
 * The ghost slot's headline: independent origins exist, but none shows evidence of its own. "0 independent origins with
 * their own evidence — this stat is a ghost." wraps to two lines on Present slide 1 at 1280×720 and makes the slide
 * scroll, so the headline uses the shorter form; the tiles beside it still say "independent origins".
 */
export const GHOST_HEADLINE = "No origin with its own evidence — this stat is a ghost.";

/** The verdict banner's headline, e.g. "13 pages → 2 independent origins" or GHOST_HEADLINE. */
export function verdictHeadline(result: EchoAnalysis): string {
  const isRehearsal = result.mode === "demo";
  const pagesById = new Map(result.pages.map((page) => [page.id, page] as const));
  const hasConfirmedOrigins = result.roots.length > 0;
  const primaryEvidenceIncomplete = result.roots.some((id) => pagesById.get(id)?.primaryEvidenceStatus === "unclear");
  const isGhost = !isRehearsal && result.claimSlot === "ghost" && result.summary.verifiableOrigins === 0 && hasConfirmedOrigins && !primaryEvidenceIncomplete;
  const pageWord = result.summary.totalPages === 1 ? "page" : "pages";
  const originWord = result.summary.independentOrigins === 1 ? "origin" : "origins";
  return isRehearsal
    ? `${result.summary.totalPages} sample ${pageWord} → ${result.summary.independentOrigins} sample ${originWord}`
    : isGhost
    ? GHOST_HEADLINE
    : primaryEvidenceIncomplete
      ? `${result.summary.totalPages} ${pageWord} → root evidence still unverified`
      : !hasConfirmedOrigins
      ? `${result.summary.totalPages} ${pageWord} → no confirmed independent origins`
      : `${result.summary.totalPages} ${pageWord} → ${result.summary.independentOrigins} independent ${result.summary.independentOrigins === 1 ? "origin" : "origins"}`;
}


/**
 * The search providers a trace's searches actually used (Telem's routing: the providers that answered), most-used
 * first, ties in order of first use. Empty for a Tavily trace (no routing recorded) and for every older trace.
 */
export function searchProvidersUsed(result: EchoAnalysis): string[] {
  const counts = new Map<string, number>();
  for (const entry of result.searchAudit ?? []) {
    if (entry.router !== "telem" || entry.status !== "searched") continue;
    for (const name of entry.providers ?? []) if (isProviderName(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

/** Whether a trace's searches went through Telem (its search audit names the router). */
export function routedByTelem(result: EchoAnalysis): boolean {
  return (result.searchAudit ?? []).some((entry) => entry.router === "telem");
}

/**
 * What the plain search (searchAudit[0]: the trace's first search, the claim as typed) returned, and where Echo
 * traces those pages: each copy is followed up its confirmed parents to a root, co-published roots count once, and a
 * page whose chain ends on an unclear relationship counts as unclear. Only this trace's own search results are
 * counted. "About this claim" means the search result mentions the claim's terms, not that it agrees with the claim.
 */
export interface PlainSearchLineage {
  query: string;
  /** "telem" when Telem routed the first search; absent for Tavily (every trace before Telem). */
  router?: "telem";
  /** Telem only: the providers that answered the first search. */
  providers?: string[];
  /** Results the plain search returned. */
  returned: number;
  /** Of those, results about this claim (they mention its terms); they may support or debunk it. */
  matching: number;
  /** Of those, the pages Echo kept and traced (some can drop out: selection cap, unreadable, off-claim). */
  kept: number;
  /** Independent origins the kept pages lead to (co-published roots once). */
  origins: number;
  /** Of those origins, how many have evidence of their own for the claim in their passages (primary evidence). */
  verifiable: number;
  /** Kept pages that are themselves a root, and the distinct origins they make (co-published roots once). */
  rootPages: number;
  rootOrigins: number;
  /** Kept pages that are confirmed copies, followed up to a root; and whether every such root is a kept page too. */
  copies: number;
  copiesOfKeptRoots: boolean;
  /** Kept pages whose own relationship, or one up their chain, is unclear (no confirmed link). */
  unclear: number;
  /** The whole trace, for comparison: searches that ran, independent origins, and those with their own evidence. */
  searched: number;
  traceOrigins: number;
  traceVerifiable: number;
}

/** Null without a searched first query or with none of its pages left in the trace (rehearsals, old or failed runs). */
export function plainSearchLineage(result: EchoAnalysis): PlainSearchLineage | null {
  const first = result.searchAudit?.[0];
  if (result.mode !== "live" || !first || first.status !== "searched" || !(first.totalResults > 0)) return null;
  const pagesById = new Map(result.pages.map((page) => [page.id, page] as const));
  const kept = [...new Set(first.pageIds ?? [])].filter((id) => pagesById.has(id));
  if (!kept.length) return null;
  const keptIds = new Set(kept);
  const groupOf = new Map<string, string>();
  (result.coPublishedRootGroups ?? []).forEach((group, index) => group.forEach((id) => groupOf.set(id, `group-${index}`)));
  // As originCounts does: a co-published origin has primary evidence when any page of its group does, even if the
  // plain search kept only another page of that group.
  const verifiableKeys = new Set(result.verifiableRoots.map((id) => groupOf.get(id) ?? id));
  const origins = new Set<string>();
  const rootOrigins = new Set<string>();
  const verifiable = new Set<string>();
  let rootPages = 0;
  let copies = 0;
  let copiesOfKeptRoots = true;
  let unclear = 0;
  for (const id of kept) {
    let page = pagesById.get(id)!;
    const seen = new Set<string>();
    while (page.judgment.kind === "derived" && page.judgment.parentId && pagesById.has(page.judgment.parentId) && !seen.has(page.id)) {
      seen.add(page.id);
      page = pagesById.get(page.judgment.parentId)!;
    }
    if (page.judgment.kind !== "origin") {
      unclear += 1;
      continue;
    }
    const key = groupOf.get(page.id) ?? page.id;
    origins.add(key);
    if (verifiableKeys.has(key)) verifiable.add(key);
    if (page.id === id) {
      rootPages += 1;
      rootOrigins.add(key);
    } else {
      copies += 1;
      if (!keptIds.has(page.id)) copiesOfKeptRoots = false;
    }
  }
  const providers = first.router === "telem" ? (first.providers ?? []).filter(isProviderName) : [];
  return {
    query: first.query,
    ...(first.router === "telem" ? { router: "telem" as const, ...(providers.length ? { providers } : {}) } : {}),
    returned: first.totalResults,
    matching: Math.max(first.matchingResults ?? 0, kept.length),
    kept: kept.length,
    origins: origins.size,
    verifiable: verifiable.size,
    rootPages,
    rootOrigins: rootOrigins.size,
    copies,
    copiesOfKeptRoots,
    unclear,
    searched: (result.searchAudit ?? []).filter((entry) => entry.status === "searched").length,
    traceOrigins: result.summary.independentOrigins,
    traceVerifiable: result.summary.verifiableOrigins,
  };
}

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// The one name for the independence count, on every surface (workbench, text report, Explore, Present slide 1).
const originsText = (count: number) => counted(count, "independent origin", "independent origins");

/**
 * The primary line, e.g. "Plain search: 10 results, 5 about this claim. Behind those 5: 1 independent origin; 1 page
 * unclear." The evidence clause is left out when every origin has its own evidence, the unclear clause when none is.
 */
export function plainSearchHeadline(lineage: PlainSearchLineage): string {
  const { returned, matching, kept, origins, verifiable, unclear } = lineage;
  const results = counted(returned, "result", "results");
  const all = kept === returned && kept > 1;
  const head = kept < matching
    ? `Plain search: ${results}; Echo traced ${kept} of them.`
    : `Plain search: ${results}, ${all ? "all" : kept} about this claim.`;
  const behind = all ? "Behind them" : kept === 1 ? "Behind it" : `Behind those ${kept}`;
  const evidence = origins && verifiable < origins ? `, ${withOwnEvidence(verifiable)} for it` : "";
  const roots = origins ? `${originsText(origins)}${evidence}` : "no confirmed independent origin";
  const unclearText = unclear ? `; ${counted(unclear, "page", "pages")} unclear` : "";
  return `${head} ${behind}: ${roots}${unclearText}.`;
}

/**
 * The breakdown, e.g. "Of those 5: 2 root pages published together, counted as 1 origin, 2 confirmed copies of them,
 * 1 unclear (no confirmed link). Echo's full trace (13 searches) finds 2 independent origins, both with their own
 * evidence." The parts add up to the pages traced.
 */
export function plainSearchDetail(lineage: PlainSearchLineage): string {
  const { kept, rootPages, rootOrigins, copies, copiesOfKeptRoots, unclear, searched, traceOrigins, traceVerifiable } = lineage;
  const rootText = !rootPages
    ? ""
    : rootPages > rootOrigins
      ? rootOrigins === 1
        ? `${rootPages} root pages published together, counted as 1 origin`
        : `${rootPages} root pages, those published together counted once (${rootOrigins} origins)`
      : counted(rootPages, "root page", "root pages");
  // One copy among several origins copies one of them, not all.
  const copyOf = rootPages === 1 ? " of it" : copies === 1 && rootOrigins > 1 ? " of one of them" : " of them";
  const copyText = copies ? `${counted(copies, "confirmed copy", "confirmed copies")}${rootPages && copiesOfKeptRoots ? copyOf : ""}` : "";
  const unclearText = unclear ? `${unclear} unclear (no confirmed link)` : "";
  const parts = [rootText, copyText, unclearText].filter(Boolean).join(", ");
  const evidence = !traceOrigins
    ? ""
    : traceVerifiable >= traceOrigins
      ? traceOrigins === 1 ? ", with its own evidence" : traceOrigins === 2 ? ", both with their own evidence" : ", all with their own evidence"
      : traceVerifiable === 0
        ? ", none with its own evidence for the claim"
        : `, ${withOwnEvidence(traceVerifiable)}`;
  const trace = `Echo's full trace (${counted(searched, "search", "searches")}) finds ${traceOrigins ? originsText(traceOrigins) : "no confirmed independent origin"}${evidence}.`;
  return `${kept === 1 ? "That page" : `Of those ${kept}`}: ${parts}. ${trace}`;
}

/** The hover text: what "plain search" means here, named by the router that ran it. */
export function plainSearchTooltip(lineage: PlainSearchLineage): string {
  if (lineage.router === "telem") {
    return `Plain search is the trace's first search, the claim as typed, routed by Telem${lineage.providers?.length ? ` to ${providerList(lineage.providers)}` : ""}: “${lineage.query}”`;
  }
  return `Plain search is the trace's first Tavily search, the claim as typed: “${lineage.query}”`;
}

/**
 * One line for a live run's cost receipt (pipeline.ts fills it on fresh live runs), e.g. "38 s · ≈$0.15 list-price
 * estimate (Claude $0.04, search $0.11) · 13 searches (16 credits) · 3 Claude calls". Dollars are list-price estimates
 * from the counted tokens and credits, not an invoice. A cache hit or an opened file describes the original run, not new spend. Null
 * without a receipt (bundled traces, older runs).
 */
export function costReceiptLine(result: EchoAnalysis): string | null {
  const receipt = result.costReceipt;
  if (!receipt) return null;
  const money = (usd: number) => `$${usd.toFixed(2)}`;
  const seconds = Math.round(receipt.stageMs.total / 1000);
  const time = seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  const searches = receipt.tavily.basicSearches + receipt.tavily.advancedSearches;
  const calls = receipt.claude.length;
  const credits = `${receipt.tavily.credits} ${receipt.tavily.credits === 1 ? "credit" : "credits"}`;
  // Searched through Telem: search is the Telem line, and Tavily's credits paid for reading the pages (extract).
  const telem = receipt.telem && typeof receipt.usd.telem === "number" ? receipt.telem : null;
  if (telem) {
    const runs = Object.values(telem.providerRuns).reduce((sum, count) => sum + count, 0);
    const telemParts = [
      time,
      `≈${money(receipt.usd.total)} list-price estimate (Claude ${money(receipt.usd.claude)}, search ${money(receipt.usd.telem ?? 0)} via Telem, page reading ${money(receipt.usd.tavily)})`,
      `${telem.searches} ${telem.searches === 1 ? "search" : "searches"} via Telem (${runs} provider ${runs === 1 ? "run" : "runs"}) · ${receipt.tavily.credits} extract ${receipt.tavily.credits === 1 ? "credit" : "credits"}`,
      `${calls} Claude ${calls === 1 ? "call" : "calls"}`,
    ];
    return `${result.cacheHit || result.importedAt ? "Saved run: cost of the original run, not new spend · " : ""}${telemParts.join(" · ")}`;
  }
  // A Check these sources run searches nothing: its Tavily credits paid for reading the supplied pages (extract).
  const noSearch = Boolean(result.sourceCheck) && searches === 0;
  const parts = [
    time,
    `≈${money(receipt.usd.total)} list-price estimate (Claude ${money(receipt.usd.claude)}, ${noSearch ? "page reading" : "search"} ${money(receipt.usd.tavily)})`,
    noSearch ? `no web search · ${receipt.tavily.credits} extract ${receipt.tavily.credits === 1 ? "credit" : "credits"}` : `${searches} ${searches === 1 ? "search" : "searches"} (${credits})`,
    `${calls} Claude ${calls === 1 ? "call" : "calls"}`,
  ];
  // A cache hit or an opened trace file shows what the original run spent; this view spent nothing.
  return `${result.cacheHit || result.importedAt ? "Saved run: cost of the original run, not new spend · " : ""}${parts.join(" · ")}`;
}

/** One step of "How Echo checked this": what the run did at that stage, counted from the trace's own fields. */
export interface CheckStep {
  step: "Plan" | "Search" | "Plan · Search" | "Read" | "Group" | "Judge" | "Verify" | "Answer";
  /** The headline count, e.g. "13 searches run (3 deeper)". */
  value: string;
  /** The short line under it, e.g. "124 results · 15 distinct pages found". */
  detail: string;
  /** How the numbers are counted, for the hover note. */
  note: string;
  /** Wall-clock milliseconds of this stage from the run's cost receipt, when the trace has one. */
  ms?: number;
}

/**
 * "How Echo checked this": the run's plan, search, read, group, judge, verify and answer steps as counts, built only
 * from fields every saved trace already has (searchAudit, pages, clusters, excludedPageCount, summary, answer
 * statements and, when present, costReceipt.stageMs). No model call and nothing new in the pipeline. A field missing
 * from an older trace drops that number or step rather than guessing it. Rule vetoes are not recorded in traces, so
 * they are not counted. A "Check these sources" run built no queries and ran no search, so Plan and Search are one
 * "skipped" step. Null for a rehearsal (its numbers are sample data, not a run).
 */
export function howEchoChecked(result: EchoAnalysis): { steps: CheckStep[]; totalMs?: number } | null {
  if (result.mode !== "live") return null;
  const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const stageMs = result.costReceipt?.stageMs;
  const time = (key: keyof CostReceiptStages) => (stageMs && isNumber(stageMs[key]) && stageMs[key] > 0 ? { ms: stageMs[key] } : {});
  const pagesById = new Map(result.pages.map((page) => [page.id, page] as const));
  const steps: CheckStep[] = [];
  const supplied = result.sourceCheck;
  const excluded = isNumber(result.excludedPageCount) ? result.excludedPageCount : null;
  const kept = result.pages.length;
  // Pages read: those kept about the claim plus those grouping excluded as off-claim (they were read first).
  const read = kept + (excluded ?? 0);

  if (supplied) {
    steps.push({
      step: "Plan · Search",
      value: "Skipped",
      detail: `read ${counted(supplied.urls.length, "supplied link", "supplied links")}; no web search`,
      note: "A Check these sources run reads exactly the links it was given: it builds no search phrasings and runs no web search.",
    });
  } else if (result.searchAudit?.length) {
    const audit = result.searchAudit;
    const variants = new Set(audit.map((entry) => entry.query)).size;
    steps.push({
      step: "Plan",
      value: counted(variants, "query variant", "query variants"),
      detail: "built from the claim's wording, no model call",
      note: "Echo writes these search phrasings itself from the claim (the claim as typed, quoted phrases, \"original source\", \"study finds\" and so on). Planning makes no model call.",
    });
    const searched = audit.filter((entry) => entry.status === "searched");
    const deeper = searched.filter((entry) => entry.depth === "advanced").length;
    const failed = audit.filter((entry) => entry.status === "failed").length;
    const notRun = audit.filter((entry) => entry.status === "not searched").length;
    const results = searched.every((entry) => isNumber(entry.totalResults)) ? searched.reduce((sum, entry) => sum + entry.totalResults, 0) : null;
    const distinct = distinctPagesFound(result);
    // Telem routed the searches: say so, and name only the providers that answered (from the trace's own audit).
    const telem = routedByTelem(result);
    const providers = telem ? searchProvidersUsed(result) : [];
    steps.push({
      step: "Search",
      value: `${counted(searched.length, "search", "searches")} ${telem ? "routed by Telem" : "run"}${deeper ? ` (${deeper} deeper)` : ""}`,
      detail: [
        providers.length ? `across ${providerList(providers)}` : "",
        results !== null ? counted(results, "result", "results") : "",
        distinct !== null ? `${counted(distinct, "distinct page", "distinct pages")} found` : "",
        notRun ? `${counted(notRun, "variant", "variants")} not run (enough pages found)` : "",
        failed ? `${failed} failed` : "",
      ].filter(Boolean).join(" · "),
      note: telem
        ? `Web searches routed by Telem, one per query variant, plus deeper searches when few pages turn up: Telem's auto-routing sends each variant to the search providers it picks${providers.length ? ` (here ${providerList(providers)})` : ""}, and Echo merges their results. A result is kept when it mentions the claim's terms, which can mean it debunks it; Group then sets aside the pages that are off the claim. Each page is counted once, whichever providers returned it.`
        : "Web searches (Tavily), one per query variant, plus deeper searches when few pages turn up. A result is kept when it mentions the claim's terms, which can mean it debunks it; Group then sets aside the pages that are off the claim. Each page is counted once.",
      ...time("search"),
    });
  }

  const dated = reliablyDatedPages(result).length;
  const snippetOnly = result.pages.filter((page) => page.extractionSource === "Search snippet").length;
  // A run reads at most MAX_PAGES_READ of the pages its searches kept (pipeline.ts, selectPagesForAnalysis).
  const found = supplied ? null : distinctPagesFound(result);
  steps.push({
    step: "Read",
    value: supplied ? `${read} of ${counted(supplied.urls.length, "supplied link", "supplied links")} read` : counted(read, "page read", "pages read"),
    detail: [
      found !== null && found > read && read >= maxPagesRead(result) ? `of ${found} found (at most ${maxPagesRead(result)} per run)` : "",
      `${dated} with a reliable date`,
      snippetOnly ? `${snippetOnly} only from ${snippetOnly === 1 ? "its" : "their"} search snippet` : "",
    ].filter(Boolean).join(" · "),
    note: `Echo extracts each page's text and reads its date off the page itself (its text, address or metadata); a search engine's date estimate is not counted as reliable. Dates and snippet-only pages are counted on the ${counted(kept, "page", "pages")} kept about the claim.`,
    ...time("extract"),
  });

  const groups = result.clusters.filter((cluster) => cluster.pageIds.some((id) => pagesById.has(id))).length;
  steps.push({
    step: "Group",
    value: counted(groups, "claim group", "claim groups"),
    detail: [
      `${counted(kept, "page", "pages")} about the claim`,
      excluded === null ? "" : excluded ? `${counted(excluded, "off-claim page", "off-claim pages")} excluded` : "none off-claim",
    ].filter(Boolean).join(" · "),
    note: "Claude sorts the pages by the assertion they make. Pages that only share words or numbers with the claim are excluded from the verdict.",
    ...time("grouping"),
  });

  const origins = result.summary.independentOrigins;
  const rootPages = result.roots.filter((id) => pagesById.has(id)).length;
  const copies = summarizeTraceSignals(result.pages).likelyEchoes;
  const unclear = result.pages.filter((page) => page.judgment.kind === "unclear").length;
  steps.push({
    step: "Judge",
    value: origins ? originsText(origins) : "No confirmed independent origin",
    detail: [
      rootPages !== origins ? `from ${counted(rootPages, "root page", "root pages")}` : "",
      `${counted(copies, "confirmed copy", "confirmed copies")} (by date or citation)`,
      `${unclear} unclear`,
    ].filter(Boolean).join(" · "),
    note: "Claude proposes each page's parent; a copy link counts as confirmed only when a date or a citation backs it. Unclear links stay dashed and are not counted as copies. Root pages published together count as one origin.",
    ...time("judgment"),
  });

  if (result.answerStatus === "generated" && result.answerStatements?.length) {
    const grounding = answerNumberGrounding(result);
    const figures = grounding.reduce((sum, entry) => sum + entry.numbers.length, 0);
    const missingCount = grounding.reduce((sum, entry) => sum + entry.unmatchedNumbers.length, 0);
    const missing = [...new Set(grounding.flatMap((entry) => entry.unmatchedNumbers))];
    steps.push({
      step: "Verify",
      value: figures ? `${figures - missingCount} of ${counted(figures, "answer figure", "answer figures")}` : "No figures to check",
      detail: !figures ? "the answer states no numbers" : missing.length ? `found in the passages they cite; not found: ${missing.join(", ")}` : "found in the passages they cite",
      note: "A no-cost check, statement by statement: each number an answer statement states is looked for in the passages that statement cites. A match does not prove the statement; a miss means open the original page.",
    });
  }

  if (result.answerStatus) {
    const groupOf = new Map<string, string>();
    (result.coPublishedRootGroups ?? []).forEach((group, index) => group.forEach((id) => groupOf.set(id, `group-${index}`)));
    const rootIds = new Set(result.roots);
    const cited = new Set(result.answerSourceIds.filter((id) => rootIds.has(id)).map((id) => groupOf.get(id) ?? id)).size;
    const answer = result.answerStatus === "generated"
      ? {
        value: `Written from ${originsText(origins)}`,
        detail: `${cited < origins ? `cites ${cited} of them; ` : "root pages only; "}copies and unclear pages left out${rootPages > 12 ? " (first 12 root pages)" : ""}`,
      }
      : result.answerStatus === "source-limited"
        ? { value: "No answer written", detail: `${origins === 1 ? "the independent origin shows no" : `none of the ${origins} independent origins shows`} evidence of its own, so Echo lists ${origins === 1 ? "it" : "them"} (no model call)` }
        : { value: "No answer written", detail: rootPages ? "the answer step did not complete; the source tree stands" : "no confirmed independent origin to write from" };
    steps.push({
      step: "Answer",
      ...answer,
      note: "The answer is written only from the root pages' passages; confirmed copies and unclear pages are left out, so repetition never counts as support. When no origin shows evidence of its own, Echo writes no answer and lists the origins instead.",
      ...time("answer"),
    });
  }

  return { steps, ...(stageMs && isNumber(stageMs.total) && stageMs.total > 0 ? { totalMs: stageMs.total } : {}) };
}

type CostReceiptStages = NonNullable<EchoAnalysis["costReceipt"]>["stageMs"];

/** The most pages one run reads (pipeline.ts: selectPagesForAnalysis(records, 20)). */
const MAX_PAGES_READ = 20;
/** Deep search reads up to 50 pages (pipeline.ts); Standard reads up to 20. */
const maxPagesRead = (result: { searchMode?: string }) => (result.searchMode === "deep" ? 50 : MAX_PAGES_READ);

/**
 * Distinct pages a run's searches found (each kept once): each search's uniquePagesAdded counts only pages no earlier
 * search had found, so their sum counts every page once. Null without a search audit or when a search lacks the count.
 */
function distinctPagesFound(result: EchoAnalysis): number | null {
  const searched = (result.searchAudit ?? []).filter((entry) => entry.status === "searched");
  if (!searched.length || !searched.every((entry) => typeof entry.uniquePagesAdded === "number" && Number.isFinite(entry.uniquePagesAdded))) return null;
  return searched.reduce((sum, entry) => sum + entry.uniquePagesAdded, 0);
}

/** A stage time for the strip: "0.9 s", "7.9 s", "14 s", "1 min 5 s"; under a tenth of a second, "<0.1 s". */
export function stageTimeLabel(ms: number): string {
  if (ms < 100) return "<0.1 s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The strip as plain text, one step per line ("Plan: 10 query variants — built from …"), for checks. */
export function howEchoCheckedText(steps: CheckStep[]): string[] {
  return steps.map((step) => `${step.step}: ${step.value} — ${step.detail}${step.ms !== undefined ? ` (${stageTimeLabel(step.ms)})` : ""}`);
}

const thousands = (count: number) => count.toLocaleString("en-US");

/** How a page's text reached the trace, in plain words. */
const TEXT_SOURCE_WORDS: Record<NonNullable<EchoPage["extractionSource"]>, string> = {
  "Tavily extraction": "extracted by Tavily",
  "Page HTML": "read from the page's own HTML",
  "Search snippet": "search snippet only",
  "Rehearsal fixture": "rehearsal fixture",
};

/** Where a page's publisher date came from, in plain words ("Tavily estimate" is a search engine's guess, never reliable). */
const DATE_SOURCE_WORDS: Record<NonNullable<EchoPage["publishedDateSource"]>, string> = {
  "page metadata": "page metadata",
  "URL date": "the URL",
  "page text": "the page text",
  "Tavily estimate": "a search estimate",
};

/** "7 from page metadata, 2 from the URL": the reliably dated pages by where their date came from, most first. */
function dateSourcesText(dated: EchoPage[]): string {
  const counts = new Map<string, number>();
  for (const page of dated) {
    const words = DATE_SOURCE_WORDS[page.publishedDateSource!] ?? page.publishedDateSource!;
    counts.set(words, (counts.get(words) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([source, count]) => `${count} from ${source}`).join(", ");
}

/** How a verified citation names the page it cites, in plain words ("by a link in the page HTML", "by title"). */
function citationHowWords(citation: NonNullable<EchoPage["citations"]>[number]): string {
  if (citation.quote.startsWith("This page's HTML links to")) return "by a link in the page HTML";
  return citation.how === "named as source" ? "naming it as the source" : `by ${citation.how}`;
}

/** A page date for the details rows: "Sep 28, 2021", "May 2019 (month only)" or "2019 (year only)". */
function detailDateLabel(date: string): string {
  if (datePrecision(date) !== "day" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return pageDateLabel(date);
  return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}, ${date.slice(0, 4)}`;
}

/** Citations between pages of this trace (each page's verified citations of another page it holds), and links. */
function citationCounts(result: EchoAnalysis) {
  const ids = new Set(result.pages.map((page) => page.id));
  const recorded = result.pages.some((page) => Array.isArray(page.citations) || Array.isArray(page.linkedPageIds));
  const citations = result.pages.flatMap((page) => (page.citations ?? []).filter((citation) => ids.has(citation.pageId) && citation.pageId !== page.id));
  const links = result.pages.reduce((sum, page) => sum + (page.linkedPageIds ?? []).filter((id) => ids.has(id) && id !== page.id).length, 0);
  const byHow = new Map<string, number>();
  for (const citation of citations) {
    const how = citationHowWords(citation);
    byHow.set(how, (byHow.get(how) ?? 0) + 1);
  }
  return { recorded, citations: citations.length, links, byHow: [...byHow.entries()].sort((a, b) => b[1] - a[1]) };
}

/** Tokens a receipt's Claude calls reported (input, output and prompt-cache tokens), and the models used. */
function claudeUsage(result: EchoAnalysis) {
  const calls = result.costReceipt?.claude ?? [];
  if (!calls.length) return null;
  const sum = (key: "inputTokens" | "outputTokens" | "cacheWriteTokens" | "cacheReadTokens") => calls.reduce((total, call) => total + (Number.isFinite(call[key]) ? call[key] : 0), 0);
  const input = sum("inputTokens");
  const output = sum("outputTokens");
  const cacheWrite = sum("cacheWriteTokens");
  const cacheRead = sum("cacheReadTokens");
  const thinking = calls.reduce((total, call) => total + (typeof call.thinkingTokens === "number" && Number.isFinite(call.thinkingTokens) ? call.thinkingTokens : 0), 0);
  return { calls: calls.length, steps: calls.map((call) => call.step), models: [...new Set(calls.map((call) => call.model))], input, output, cacheWrite, cacheRead, thinking, total: input + output + cacheWrite + cacheRead };
}

/** One stage of the evidence funnel: a count from the trace, what it is called, one short line and its hover note. */
export interface FunnelStage {
  key: "variants" | "searches" | "results" | "distinct" | "supplied" | "read" | "groups" | "about" | "calls" | "origins";
  /** The phase the stage belongs to, for the heading above it. */
  phase: "search" | "supplied" | "read" | "judge";
  value: number;
  label: string;
  /** One short line under the label ("" when there is none). */
  detail: string;
  /** Exactly what the number counts, for the hover note. */
  note: string;
}

export interface EvidenceFunnel {
  /** "search": a search run with its audit; "sources": a Check these sources run; "pages": an older trace without an audit. */
  kind: "search" | "sources" | "pages";
  stages: FunnelStage[];
  /** Further counts from the trace, one short line each (search engines, publisher dates, citations, passage text). */
  facts: string[];
  /** The line under the stages until one is hovered: what the first counts mean (results are not sources). */
  lead: string;
}

/**
 * The evidence funnel: how much a run processed, stage by stage, from the claim's search phrasings to its independent
 * origins, e.g. "10 query variants → 13 searches (3 deeper) → 124 search results scanned → 15 distinct pages → …".
 * Every number is counted from the trace's own fields (searchAudit, pages, clusters, excludedPageCount, summary and,
 * when the run kept one, costReceipt); a stage whose data the trace lacks is left out rather than guessed. Search
 * results are results, not sources: a page two searches returned counts once per search there, and once among the
 * distinct pages. Null for a rehearsal (sample data, not a run).
 */
export function evidenceFunnel(result: EchoAnalysis): EvidenceFunnel | null {
  if (result.mode !== "live" || !result.pages.length) return null;
  const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const pagesById = new Map(result.pages.map((page) => [page.id, page] as const));
  const supplied = result.sourceCheck;
  const audit = supplied ? [] : result.searchAudit ?? [];
  const stages: FunnelStage[] = [];
  const facts: string[] = [];
  const excluded = isNumber(result.excludedPageCount) ? result.excludedPageCount : null;
  const kept = result.pages.length;
  const read = supplied ? Math.max(0, supplied.urls.length - (supplied.unreadUrls ?? []).length) : kept + (excluded ?? 0);
  const telem = !supplied && routedByTelem(result);

  if (supplied) {
    stages.push({
      key: "supplied", phase: "supplied", value: supplied.urls.length,
      label: supplied.urls.length === 1 ? "supplied link" : "supplied links",
      detail: "no web search",
      note: "The links pasted into Check these sources. Echo ran no web search: it read exactly these links and nothing else.",
    });
  } else if (audit.length) {
    const variants = new Set(audit.map((entry) => entry.query)).size;
    stages.push({
      key: "variants", phase: "search", value: variants,
      label: variants === 1 ? "query variant" : "query variants",
      detail: "written from the claim",
      note: "Search phrasings Echo wrote itself from the claim's wording (the claim as typed, its quoted phrases, \"original source\", \"study finds\" and so on). Writing them makes no model call.",
    });
    const searched = audit.filter((entry) => entry.status === "searched");
    const deeper = searched.filter((entry) => entry.depth === "advanced").length;
    const failed = audit.filter((entry) => entry.status === "failed").length;
    const notRun = audit.filter((entry) => entry.status === "not searched").length;
    const providers = telem ? searchProvidersUsed(result) : [];
    const skipped = notRun ? ` ${counted(notRun, "variant was", "variants were")} not searched: enough distinct pages had turned up.` : "";
    stages.push({
      key: "searches", phase: "search", value: searched.length,
      label: searched.length === 1 ? "search" : "searches",
      detail: [deeper ? `${deeper} deeper` : "", telem ? "via Telem" : "", notRun ? `${counted(notRun, "variant", "variants")} not needed` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" · "),
      note: telem
        ? `Web searches sent through Telem, one per query variant, plus deeper searches when few pages turn up. Telem's auto-routing chose the search engines for each one${providers.length ? ` (in this run ${providerList(providers)})` : ""}.${skipped}`
        : `Web searches (Tavily), one per query variant, plus deeper searches when few pages turn up.${skipped}`,
    });
    if (searched.length && searched.every((entry) => isNumber(entry.totalResults))) {
      const results = searched.reduce((sum, entry) => sum + entry.totalResults, 0);
      const matching = searched.every((entry) => isNumber(entry.matchingResults)) ? searched.reduce((sum, entry) => sum + entry.matchingResults, 0) : null;
      stages.push({
        key: "results", phase: "search", value: results,
        label: results === 1 ? "search result scanned" : "search results scanned",
        detail: matching !== null ? `${thousands(matching)} mention the claim's terms` : "",
        note: `Every result the searches returned, counted search by search, so a page two searches returned counts twice here${telem ? " (within one search, a page several engines returned counts once)" : ""}. A result is kept only when it mentions the claim's terms, which can mean it debunks the claim. Results are not sources.`,
      });
    }
    const distinct = distinctPagesFound(result);
    if (distinct !== null) {
      stages.push({
        key: "distinct", phase: "search", value: distinct,
        label: distinct === 1 ? "distinct page" : "distinct pages",
        detail: distinct > read && read >= MAX_PAGES_READ ? `at most ${MAX_PAGES_READ} read per run` : "each counted once",
        note: "The different pages among those results that mention the claim's terms: each address counted once, however many searches returned it (the same article at another address counts once).",
      });
    }
  }

  const dated = reliablyDatedPages(result);
  const snippetOnly = result.pages.filter((page) => page.extractionSource === "Search snippet").length;
  const dateSources = dateSourcesText(dated);
  stages.push({
    key: "read", phase: "read", value: read,
    label: supplied ? (read === 1 ? "link read" : "links read") : read === 1 ? "page read" : "pages read",
    detail: `${dated.length} with a reliable publisher date`,
    note: `Echo extracted each page's text and looked for its publisher date on the page itself${dated.length ? ` (here ${dateSources})` : ""}; a search engine's date estimate is not counted as reliable. Dates are counted on the ${counted(kept, "page", "pages")} kept about the claim${snippetOnly ? `, ${snippetOnly} of them only from ${snippetOnly === 1 ? "its" : "their"} search snippet` : ""}.`,
  });

  const groups = result.clusters.filter((cluster) => cluster.pageIds.some((id) => pagesById.has(id))).length;
  stages.push({
    key: "groups", phase: "judge", value: groups,
    label: groups === 1 ? "claim group" : "claim groups",
    detail: excluded === null ? "" : excluded ? `${excluded} off-claim set aside` : "none off-claim",
    note: "Claude sorts the pages by the assertion they make. Pages that only share words or numbers with the claim are set aside and left out of the verdict.",
  });

  const copies = summarizeTraceSignals(result.pages).likelyEchoes;
  const unclear = result.pages.filter((page) => page.judgment.kind === "unclear").length;
  stages.push({
    key: "about", phase: "judge", value: kept,
    label: kept === 1 ? "page about the claim" : "pages about the claim",
    detail: `${counted(copies, "confirmed copy", "confirmed copies")} · ${unclear} unclear`,
    note: "The pages left after grouping, each judged against the others in its group. A copy link counts as confirmed only when a date or a citation backs it; unclear links stay dashed and are not counted as copies.",
  });

  const usage = claudeUsage(result);
  if (usage) {
    stages.push({
      key: "calls", phase: "judge", value: usage.calls,
      label: usage.calls === 1 ? "Claude call" : "Claude calls",
      detail: `${thousands(usage.total)} tokens`,
      note: `The paid Claude requests this run made (${usage.steps.join(", ")}; ${usage.models.join(", ")}), with the tokens the API reported for them: ${thousands(usage.input)} input and ${thousands(usage.output)} output${usage.cacheWrite || usage.cacheRead ? `, plus ${thousands(usage.cacheWrite + usage.cacheRead)} prompt-cache tokens` : ""}.`,
    });
  }

  const origins = result.summary.independentOrigins;
  const verifiable = result.summary.verifiableOrigins;
  const rootPages = result.roots.filter((id) => pagesById.has(id)).length;
  stages.push({
    key: "origins", phase: "judge", value: origins,
    label: origins === 1 ? "independent origin" : "independent origins",
    detail: !origins ? "none confirmed" : verifiable >= origins ? (origins === 1 ? "with its own evidence" : origins === 2 ? "both with their own evidence" : "all with their own evidence") : withOwnEvidence(verifiable),
    note: `Pages no other page in this trace explains, counted once per origin${rootPages !== origins ? ` (here ${counted(rootPages, "root page", "root pages")}; pages published together count once)` : ""}. An origin is the best-supported starting point among ${supplied ? "these links" : "these pages"}, not proof it was first on the web.`,
  });

  if (telem) {
    const providers = searchProvidersUsed(result);
    if (providers.length) facts.push(`Search engines (via Telem): ${providerList(providers)}`);
  }
  if (dated.length) facts.push(`Publisher dates: ${dateSources}`);
  const cites = citationCounts(result);
  if (cites.citations) facts.push(`${counted(cites.citations, "citation", "citations")} found between pages`);
  if (cites.links) facts.push(`${counted(cites.links, "link", "links")} between pages in their passages`);
  const characters = result.pages.reduce((sum, page) => sum + page.text.length, 0);
  if (characters) facts.push(`${thousands(characters)} characters of page passages saved`);
  const totalMs = result.costReceipt?.stageMs?.total;
  if (isNumber(totalMs) && totalMs > 0) facts.push(`${stageTimeLabel(totalMs)} from start to finish`);

  const resultsStage = stages.find((stage) => stage.key === "results");
  const searchesStage = stages.find((stage) => stage.key === "searches");
  const distinctStage = stages.find((stage) => stage.key === "distinct");
  const lead = supplied
    ? `Echo read only the ${counted(supplied.urls.length, "link", "links")} supplied, with no web search.`
    : resultsStage && searchesStage && distinctStage
      ? `Search results are not sources: ${thousands(resultsStage.value)} counts every result of the ${counted(searchesStage.value, "search", "searches")}, a page two searches returned counting twice; ${thousands(distinctStage.value)} counts each page once.`
      : "Counted from this run's own record.";
  return { kind: supplied ? "sources" : audit.length ? "search" : "pages", stages, facts, lead };
}

/** The funnel as one line, e.g. "10 query variants → 13 searches (3 deeper) → 124 search results scanned (…) → …". */
export function evidenceFunnelText(funnel: EvidenceFunnel): string {
  return funnel.stages.map((stage) => `${thousands(stage.value)} ${stage.label}${stage.detail ? ` (${stage.detail})` : ""}`).join(" → ");
}

/**
 * The funnel's headline on Present slide 2, its first and last counts: "From 124 search results to 2 independent
 * origins", "From 5 supplied links to 1 independent origin", or (no search counts) "From 15 pages read to …".
 */
export function evidenceFunnelHeadline(funnel: EvidenceFunnel): string {
  const first = funnel.stages.find((stage) => stage.key === "results" || stage.key === "supplied") ?? funnel.stages.find((stage) => stage.key === "read");
  const last = funnel.stages.find((stage) => stage.key === "origins");
  if (!first || !last) return "";
  const firstWords = first.key === "results" ? (first.value === 1 ? "search result" : "search results") : first.label;
  return `From ${thousands(first.value)} ${firstWords} to ${thousands(last.value)} ${last.label}`;
}

/** A count as the funnel and the run details print it: "1,234". */
export function funnelNumber(count: number): string {
  return thousands(count);
}

export interface DetailRow {
  label: string;
  lines: string[];
}

/**
 * "Run details": what a run did and used, row by row, from the trace's own fields (the run's date is added by the
 * screen, in the viewer's time zone). Rows the trace has no data for are left out; without a cost receipt the Claude
 * row says the calls were not recorded. `summary` is the one line shown while the panel is closed.
 */
export function runDetails(result: EchoAnalysis): { summary: string[]; rows: DetailRow[] } | null {
  if (result.mode !== "live") return null;
  const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const rows: DetailRow[] = [];
  const summary: string[] = [];
  const supplied = result.sourceCheck;
  const audit = supplied ? [] : result.searchAudit ?? [];
  const telem = !supplied && routedByTelem(result);
  const excluded = isNumber(result.excludedPageCount) ? result.excludedPageCount : null;
  const kept = result.pages.length;
  const keptIds = new Set(result.pages.map((page) => page.id));
  const receipt = result.costReceipt;

  if (supplied) {
    rows.push({ label: "Search", lines: [`None: Check these sources read the ${counted(supplied.urls.length, "supplied link", "supplied links")}, with no web search`] });
    summary.push("no web search", counted(supplied.urls.length, "supplied link", "supplied links"));
  } else if (audit.length) {
    const searched = audit.filter((entry) => entry.status === "searched");
    const deeper = searched.filter((entry) => entry.depth === "advanced").length;
    const failed = audit.filter((entry) => entry.status === "failed").length;
    const notRun = audit.filter((entry) => entry.status === "not searched").length;
    const variants = new Set(audit.map((entry) => entry.query)).size;
    rows.push({ label: "Search router", lines: [telem ? "Telem (its auto-routing chooses the engines for each search); Tavily reads the pages" : "Tavily"] });
    summary.push(telem ? "Telem" : "Tavily");
    if (telem) {
      const lines = searchProvidersUsed(result).map((name) => {
        const answered = searched.filter((entry) => entry.router === "telem" && (entry.providers ?? []).includes(name)).length;
        const pages = new Set(searched.flatMap((entry) => Object.entries(entry.pageProviders ?? {}).filter(([id, names]) => keptIds.has(id) && names.includes(name)).map(([id]) => id))).size;
        return `${providerDisplayName(name)}: answered ${answered} of the ${counted(searched.length, "search", "searches")}; returned ${counted(pages, "page", "pages")} of the ${kept} kept`;
      });
      if (lines.length) rows.push({ label: "Search engines", lines: [...lines, "Each engine's own result count is not recorded: Telem merges their results, one entry per address."] });
      const runs = receipt?.telem?.providerRuns;
      if (runs && Object.keys(runs).length) rows.push({ label: "Engine runs billed", lines: [Object.entries(runs).sort((a, b) => b[1] - a[1]).map(([name, count]) => `${providerDisplayName(name)} ${count}`).join(" · ")] });
    }
    rows.push({ label: "Query variants", lines: [`${variants}, written from the claim's wording (no model call)`] });
    rows.push({ label: "Searches", lines: [[`${searched.length} run`, deeper ? `${searched.length - deeper} basic, ${deeper} deeper` : "", notRun ? `${notRun} not needed (enough pages)` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(" · ")] });
    summary.push(counted(searched.length, "search", "searches"));
    if (searched.length && searched.every((entry) => isNumber(entry.totalResults))) {
      const results = searched.reduce((sum, entry) => sum + entry.totalResults, 0);
      const matching = searched.every((entry) => isNumber(entry.matchingResults)) ? searched.reduce((sum, entry) => sum + entry.matchingResults, 0) : null;
      rows.push({ label: "Search results scanned", lines: [`${thousands(results)}${matching !== null ? ` (${thousands(matching)} mention the claim's terms)` : ""}, counted search by search`] });
      summary.push(`${thousands(results)} search results`);
    }
    const distinct = distinctPagesFound(result);
    if (distinct !== null) {
      rows.push({ label: "Distinct pages found", lines: [String(distinct)] });
      summary.push(counted(distinct, "distinct page", "distinct pages"));
    }
  }

  const read = supplied ? Math.max(0, supplied.urls.length - (supplied.unreadUrls ?? []).length) : kept + (excluded ?? 0);
  rows.push({ label: supplied ? "Links read" : "Pages read", lines: [`${read}${excluded === null ? "" : `: ${kept} about the claim, ${excluded} off-claim`}${supplied?.unreadUrls?.length ? ` (${supplied.unreadUrls.length} could not be read)` : ""}`] });
  summary.push(`${read} read`);
  const bySource = new Map<string, number>();
  for (const page of result.pages) {
    const words = page.extractionSource ? TEXT_SOURCE_WORDS[page.extractionSource] ?? page.extractionSource : "source not recorded";
    bySource.set(words, (bySource.get(words) ?? 0) + 1);
  }
  const characters = result.pages.reduce((sum, page) => sum + page.text.length, 0);
  rows.push({ label: "Page text", lines: [
    [...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([words, count]) => `${count} ${words}`).join(" · "),
    `${thousands(characters)} characters of passages saved (the part of each page about the claim)`,
  ] });
  const dated = reliablyDatedPages(result);
  const estimated = result.pages.filter((page) => page.publishedDate && page.publishedDateSource === "Tavily estimate").length;
  const undated = kept - dated.length - estimated;
  rows.push({ label: "Publisher dates", lines: [[`${dated.length} reliable${dated.length ? ` (${dateSourcesText(dated)})` : ""}`, estimated ? `${estimated} only a search estimate (not counted)` : "", undated > 0 ? `${undated} none found` : ""].filter(Boolean).join(" · ")] });
  const cites = citationCounts(result);
  if (cites.recorded) {
    rows.push({ label: "Citations between pages", lines: [`${cites.citations}${cites.byHow.length ? ` (${cites.byHow.map(([how, count]) => `${count} ${how}`).join(", ")})` : ""}${cites.links ? ` · ${counted(cites.links, "link", "links")} in passages` : ""}`] });
  }
  const groups = result.clusters.filter((cluster) => cluster.pageIds.some((id) => keptIds.has(id))).length;
  rows.push({ label: "Claim groups", lines: [String(groups)] });

  const usage = claudeUsage(result);
  if (usage) {
    rows.push({ label: "Claude", lines: [
      `${usage.models.join(", ")} · ${counted(usage.calls, "call", "calls")} (${usage.steps.join(", ")})`,
      `${thousands(usage.input)} input + ${thousands(usage.output)} output tokens${usage.cacheWrite || usage.cacheRead ? ` · ${thousands(usage.cacheWrite)} cache write, ${thousands(usage.cacheRead)} cache read` : ""}${usage.thinking ? ` (${thousands(usage.thinking)} of the output were thinking)` : ""}`,
    ] });
    summary.push(counted(usage.calls, "Claude call", "Claude calls"));
  } else {
    rows.push({ label: "Claude", lines: ["Calls and tokens not recorded: this trace was saved before Echo kept a cost receipt"] });
  }
  if (receipt) {
    const tavily = receipt.tavily;
    const searches = tavily.basicSearches + tavily.advancedSearches;
    rows.push({ label: "Tavily", lines: [[searches ? `${tavily.basicSearches} basic + ${tavily.advancedSearches} advanced ${searches === 1 ? "search" : "searches"}` : "", `${counted(tavily.extractRequests, "extract request", "extract requests")} (${counted(tavily.extractedUrls, "page", "pages")})`, counted(tavily.credits, "credit", "credits")].filter(Boolean).join(" · ")] });
    const stage = receipt.stageMs;
    const names: Array<[keyof typeof stage, string]> = [["search", "search"], ["extract", "read"], ["grouping", "group"], ["judgment", "judge"], ["answer", "answer"]];
    const times = names.filter(([key]) => isNumber(stage[key]) && stage[key] > 1).map(([key, name]) => `${name} ${stageTimeLabel(stage[key])}`);
    if (times.length) rows.push({ label: "Stage times", lines: [`${times.join(" · ")}${isNumber(stage.total) && stage.total > 0 ? ` · total ${stageTimeLabel(stage.total)}` : ""}`] });
    const line = costReceiptLine(result);
    if (line) rows.push({ label: "Cost receipt", lines: [line, "List-price estimates from the counted tokens and credits, not an invoice."] });
  }
  return { summary, rows };
}

/**
 * A page's metadata as the source detail shows it, from the trace only: its site, publisher date and where the date
 * came from, its text, which search (and, with Telem, which engines) first found it or its supplied number, the pages
 * of this trace it cites or links to, its wording overlap with its parent, Claude's confidence and its evidence status.
 */
export function pageDetails(result: EchoAnalysis, page: EchoPage, suppliedNumber?: number): DetailRow[] {
  const rows: DetailRow[] = [];
  const pagesById = new Map(result.pages.map((entry) => [entry.id, entry] as const));
  const rehearsal = page.extractionSource === "Rehearsal fixture";
  rows.push({ label: "Site", lines: [page.domain] });
  const reliable = reliablyDatedPages(result).some((entry) => entry.id === page.id);
  const dateLine = !page.publishedDate
    ? "None found"
    : reliable
      ? `${detailDateLabel(page.publishedDate)} · from ${DATE_SOURCE_WORDS[page.publishedDateSource!] ?? page.publishedDateSource}`
      : page.publishedDateSource === "Tavily estimate"
        ? `${page.publishedDate} · a search engine's estimate, not counted as reliable`
        : `${page.publishedDate} · not counted as reliable`;
  rows.push({ label: "Publisher date", lines: [dateLine, ...(page.publishedDateEvidence && !rehearsal ? [page.publishedDateEvidence] : [])] });
  rows.push({ label: "Text", lines: [`${page.extractionSource ? TEXT_SOURCE_WORDS[page.extractionSource] ?? page.extractionSource : "Source not recorded"} · ${thousands(page.text.length)} characters of passage saved`] });
  if (result.sourceCheck) {
    if (suppliedNumber !== undefined) rows.push({ label: "Supplied as", lines: [`Link [${suppliedNumber}] of the ${counted(result.sourceCheck.urls.length, "supplied link", "supplied links")}`] });
  } else {
    const searched = (result.searchAudit ?? []).filter((entry) => entry.status === "searched");
    const index = searched.findIndex((entry) => (entry.pageIds ?? []).includes(page.id));
    if (index >= 0) {
      const entry = searched[index];
      const engines = (entry.pageProviders?.[page.id] ?? []).filter(isProviderName);
      rows.push({ label: "First found by", lines: [
        `Search ${index + 1} of ${searched.length}${entry.depth === "advanced" ? " (deeper)" : ""}: “${entry.query}”`,
        ...(entry.router === "telem" && engines.length ? [`Returned by ${providerList(engines)} (via Telem)`] : []),
      ] });
    }
  }
  const cited = (page.citations ?? []).filter((citation) => citation.pageId !== page.id && pagesById.has(citation.pageId));
  if (cited.length) rows.push({ label: "Cites in this trace", lines: cited.map((citation) => `${pagesById.get(citation.pageId)!.domain}, ${citationHowWords(citation)}`) });
  const linked = (page.linkedPageIds ?? []).filter((id) => id !== page.id && pagesById.has(id));
  if (linked.length) rows.push({ label: "Links in passage", lines: linked.map((id) => pagesById.get(id)!.domain) });
  const parent = page.judgment.parentId ? pagesById.get(page.judgment.parentId) : undefined;
  if (parent && !rehearsal) {
    const signals = visibleEdgeSignals(page, parent);
    rows.push({ label: "Wording vs parent", lines: [`${Math.round(signals.textOverlap * 100)}% of its passage matches ${parent.domain} word for word · ${counted(signals.sharedPhrases.length, "distinctive shared phrase", "distinctive shared phrases")}${signals.linkedParentUrl ? " · links to it" : ""}`] });
  }
  if (!rehearsal) {
    rows.push({ label: "Claude's confidence", lines: [page.judgment.kind === "unclear" ? "Relationship unresolved" : `${page.judgment.confidence}% (its own estimate, not measured)`] });
    rows.push({ label: "Own evidence", lines: [page.primaryEvidenceStatus === "found" || (!page.primaryEvidenceStatus && page.hasPrimaryEvidence) ? "Found in its passage" : page.primaryEvidenceStatus === "not found" ? "None identified in its passage" : "Not verified"] });
  }
  return rows;
}
