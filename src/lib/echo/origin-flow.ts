import { originLayer, type LayerOrigin, type OriginLayer } from "./origin-layer";
import { providerDisplayName } from "./search-providers";
import type { EchoAnalysis, EchoPage } from "./types";

// The data behind the origin layer's flow graphic (origin-graphic.tsx): every page of a trace placed in one of three
// lanes (an origin's own page, a confirmed copy of an origin, or not tied to any origin), with the search engines that
// returned it when Telem routed the run. Computed from the trace alone: no model call, no network.

export type FlowKind = "origin" | "copy" | "unplaced";

export interface FlowPage {
  id: string;
  domain: string;
  title: string;
  url: string;
  date: string | null;
  kind: FlowKind;
  /** Lead page id of the origin this page is, or leads back to. Null for an unplaced page. */
  originId: string | null;
  /** Engines that returned this page (a Telem-routed run). Empty when the trace records none. */
  engines: string[];
  /** An unplaced page only: the origin Echo saw a possible link to and could not confirm. Never counted as a copy. */
  possibleOriginId: string | null;
  /** An unplaced page only: the domain of the page the possible link points at, when that page is a copy and not the origin itself. */
  possibleVia: string | null;
  /** An unplaced page that Echo judged a copy of another page which is itself not tied to any origin. */
  copyOfUnplaced: boolean;
  /** Echo's saved one-line reason for its verdict on this page (the judge's own words, from the trace). */
  note: string;
}

/** One search Echo sent, in the order it ran, and what it was the first to bring back. */
export interface FlowSearch {
  query: string;
  ran: boolean;
  /** Pages about the claim that this search was the first to return. */
  pages: number;
  /** Origins first reached by this search: one of its pages is the origin or leads back to it. */
  newOrigins: number;
  /** Names of those origins. */
  originNames: string[];
  /** A Telem-routed search only: the engines whose run ANSWERED it (the trace does not keep a failed run), and how many of this search's pages each returned. */
  routedTo: Array<{ engine: string; pages: number }>;
  /** "searched", "failed" or "not searched", as the trace saved it. */
  status: "searched" | "failed" | "not searched";
  /** True for the first search in the plan: the claim as it was asked. */
  first: boolean;
}

export interface FlowEngine {
  engine: string;
  pages: number;
  /** Of its pages: origin pages themselves, confirmed copies, and pages not tied to an origin. */
  own: number;
  copies: number;
  unplaced: number;
  /** Independent origins its pages are, or lead back to. */
  origins: number;
  /** Origins this engine's pages reach that no other engine's pages reach in this run (does not depend on list order). */
  onlyHere: number;
}

/** Hindsight on one run, among the engines Telem asked: the fewest engines whose pages together reach every origin. */
export interface EnginesNeeded {
  /** Smallest number of engines that reach every origin reached in this run. 0 when no engine reached an origin. */
  needed: number;
  /** Engines with at least one page Echo kept on this run (an engine that answered but had no page kept is not in this count). */
  of: number;
  /** Engines that reach every origin on their own (non-empty only when needed is 1). */
  alone: string[];
  /** For each origin, how many engines' pages are it or lead back to it (largest first). */
  perOrigin: number[];
}

/** What the run's searches cost through Telem, from the run's own receipt (list-price estimate, not an invoice). */
export interface SearchBill {
  /** Engine runs Telem billed: one per engine that answered a search. */
  runs: number;
  runsByEngine: Record<string, number>;
  searches: number;
  usd: number;
}

export interface OriginFlow {
  layer: OriginLayer;
  origins: LayerOrigin[];
  /** Origin pages first (with their copies under them, oldest first), then the unplaced pages. */
  pages: FlowPage[];
  /** Empty unless Telem routed the run and recorded each page's engines. */
  engines: FlowEngine[];
  counts: Record<FlowKind, number>;
  /** One true sentence about how many engines this claim needed, when there are at least two engines. Order-free. */
  marginal: string | null;
  /** Null unless Telem routed the run and recorded each page's engines. */
  needed: EnginesNeeded | null;
  /** Engines that answered a search or were billed on this run although Echo kept none of their pages. */
  idleEngines: Array<{ engine: string; runs: number }>;
  /** Origins none of whose pages has an engine on record (a search that was not routed by Telem). */
  unrecordedOrigins: number;
  /** The searches in the order they ran. Empty when the trace does not record which search first returned each page. */
  searches: FlowSearch[];
  /** One true sentence about what the follow-up searches added. Null when there are fewer than two searches that ran. */
  searchLine: string | null;
  /** Null unless the trace carries a receipt with Telem searches (live runs since 2026-11-13). */
  bill: SearchBill | null;
}

function byDate(a: Pick<EchoPage, "publishedDate">, b: Pick<EchoPage, "publishedDate">): number {
  return (a.publishedDate ?? "9999").localeCompare(b.publishedDate ?? "9999");
}

function enginesByPage(analysis: Pick<EchoAnalysis, "searchAudit">): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  for (const entry of analysis.searchAudit ?? []) {
    if (entry.router !== "telem") continue;
    for (const [pageId, names] of Object.entries(entry.pageProviders ?? {})) {
      const set = found.get(pageId) ?? new Set<string>();
      for (const name of names) if (typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) set.add(name);
      found.set(pageId, set);
    }
  }
  return new Map([...found].map(([id, names]) => [id, [...names].sort()]));
}

export function originFlow(analysis: Pick<EchoAnalysis, "pages" | "roots" | "coPublishedRootGroups" | "searchAudit" | "costReceipt">): OriginFlow {
  const layer = originLayer(analysis);
  const engineMap = enginesByPage(analysis);
  const originOf = new Map<string, string>();
  for (const origin of layer.origins) for (const id of origin.pageIds) originOf.set(id, origin.id);
  // Confirmed copies only: a page judged "derived" whose parent is an origin page or another confirmed copy.
  const copyIds = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const page of analysis.pages) {
      if (originOf.has(page.id) || page.judgment.kind !== "derived" || !page.judgment.parentId) continue;
      const origin = originOf.get(page.judgment.parentId);
      if (!origin) continue;
      originOf.set(page.id, origin);
      copyIds.add(page.id);
      grew = true;
    }
  }
  const toFlow = (page: EchoPage): FlowPage => ({
    id: page.id,
    domain: page.domain.replace(/^www\./, ""),
    title: page.title,
    url: page.url,
    date: page.publishedDate,
    kind: copyIds.has(page.id) ? "copy" : originOf.has(page.id) ? "origin" : "unplaced",
    originId: originOf.get(page.id) ?? null,
    engines: engineMap.get(page.id) ?? [],
    possibleOriginId: !originOf.has(page.id) && page.judgment.kind === "unclear" && page.judgment.parentId ? originOf.get(page.judgment.parentId) ?? null : null,
    possibleVia: (() => {
      if (originOf.has(page.id) || page.judgment.kind !== "unclear" || !page.judgment.parentId) return null;
      const parent = analysis.pages.find((entry) => entry.id === page.judgment.parentId);
      return parent && copyIds.has(parent.id) ? parent.domain.replace(/^www\./, "") : null;
    })(),
    copyOfUnplaced: !originOf.has(page.id) && page.judgment.kind === "derived",
    note: (page.judgment.evidence ?? "").trim(),
  });
  const pages: FlowPage[] = [];
  for (const origin of layer.origins) {
    const own = analysis.pages.filter((page) => origin.pageIds.includes(page.id)).sort((a, b) => Number(b.id === origin.id) - Number(a.id === origin.id) || byDate(a, b));
    const copies = analysis.pages.filter((page) => copyIds.has(page.id) && originOf.get(page.id) === origin.id).sort(byDate);
    pages.push(...own.map(toFlow), ...copies.map(toFlow));
  }
  pages.push(...analysis.pages.filter((page) => !originOf.has(page.id)).sort(byDate).map(toFlow));

  const rows = new Map<string, FlowEngine & { reached: Set<string> }>();
  for (const page of pages) {
    for (const engine of page.engines) {
      const row = rows.get(engine) ?? { engine, pages: 0, own: 0, copies: 0, unplaced: 0, origins: 0, onlyHere: 0, reached: new Set<string>() };
      row.pages += 1;
      row[page.kind === "origin" ? "own" : page.kind === "copy" ? "copies" : "unplaced"] += 1;
      if (page.originId) row.reached.add(page.originId);
      rows.set(engine, row);
    }
  }
  // For each origin, the engines whose pages are it or lead back to it. Everything below is order-free.
  const reachedBy = new Map<string, Set<string>>();
  for (const page of pages) {
    if (!page.originId || !page.engines.length) continue;
    const set = reachedBy.get(page.originId) ?? new Set<string>();
    for (const engine of page.engines) set.add(engine);
    reachedBy.set(page.originId, set);
  }
  const engines: FlowEngine[] = [...rows.values()]
    .sort((a, b) => b.pages - a.pages || a.engine.localeCompare(b.engine))
    .map(({ reached, ...row }) => ({
      ...row,
      origins: reached.size,
      onlyHere: [...reachedBy.values()].filter((set) => set.size === 1 && set.has(row.engine)).length,
    }));
  const needed = enginesNeeded(engines.map((row) => row.engine), reachedBy);
  const total = reachedBy.size;
  const all = total === 1 ? "the one origin" : total === 2 ? "both origins" : `all ${total} origins`;
  const names = (list: string[]) => {
    const shown = list.map(providerDisplayName);
    return shown.length < 2 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  };
  const unrecordedOrigins = layer.origins.length - total;
  const unrecordedNote = unrecordedOrigins > 0 ? ` ${plural(unrecordedOrigins, "more origin came", "more origins came")} from a search with no engine on record and ${unrecordedOrigins === 1 ? "is" : "are"} outside this count.` : "";
  const single = engines.reduce((sum, row) => sum + row.onlyHere, 0);
  const marginal = engines.length < 2 || !needed
    ? null
    : (total === 0
      ? `None of the ${engines.length} engines returned a page that Echo counted as an origin.`
      : needed.alone.length === engines.length
        ? `Every one of the ${engines.length} engines reached ${all}. Asking more engines added pages and no further origin Echo could confirm.`
        : needed.alone.length === 1
          ? `By this run’s record, only ${names(needed.alone)} reached ${all} on its own.`
          : needed.alone.length > 1
            ? `By this run’s record, ${names(needed.alone)} each reached ${all} on their own; the other ${plural(engines.length - needed.alone.length, "engine", "engines")} did not.`
            : `By this run’s record, no single engine reached ${all}. It took ${needed.needed} of the ${engines.length} engines, and ${plural(single, "origin has", "origins have")} only one engine on record.`) + unrecordedNote;

  // What each search added, in the order the searches really ran (so "first reached" is the run's own history).
  const audit = analysis.searchAudit ?? [];
  const recorded = audit.some((entry) => (entry.pageIds ?? []).length > 0);
  const reachedEarlier = new Set<string>();
  const searches: FlowSearch[] = !recorded ? [] : audit.map((entry) => {
    const mine = pages.filter((page) => (entry.pageIds ?? []).includes(page.id));
    const fresh = [...new Set(mine.flatMap((page) => (page.originId && !reachedEarlier.has(page.originId) ? [page.originId] : [])))];
    fresh.forEach((id) => reachedEarlier.add(id));
    const asked = entry.router === "telem" ? [...(entry.providers ?? []), ...Object.values(entry.pageProviders ?? {}).flat()].filter((name) => typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) : [];
    const routedTo = [...new Set(asked)].map((engine) => ({ engine, pages: mine.filter((page) => (entry.pageProviders?.[page.id] ?? []).includes(engine)).length })).sort((a, b) => b.pages - a.pages || a.engine.localeCompare(b.engine));
    return { query: entry.query, ran: entry.status === "searched", pages: mine.length, newOrigins: fresh.length, originNames: fresh.map((id) => layer.origins.find((origin) => origin.id === id)?.name ?? id), routedTo, status: entry.status, first: entry === audit[0] };
  });
  const ran = searches.filter((search) => search.ran);
  const reachedAll = reachedEarlier.size;
  const firstFound = ran[0]?.newOrigins ?? 0;
  const followPages = ran.slice(1).reduce((sum, search) => sum + search.pages, 0);
  const lead = ran[0]?.first ? "The claim as asked" : "The first search that ran";
  const allFound = reachedAll === 1 ? "the one origin" : reachedAll === 2 ? "both origins" : `all ${reachedAll} origins`;
  const searchLine = ran.length < 2
    ? null
    : reachedAll === 0
      ? `${ran.length} searches ran. None returned a page Echo could confirm as an origin.`
      : firstFound === reachedAll
        ? `${lead} reached ${allFound}. Echo’s ${plural(ran.length - 1, "other search", "other searches")} added ${plural(followPages, "page", "pages")} and no further origin Echo could confirm.`
        : firstFound === 0
          ? `${lead} reached no origin. Echo’s other ${ran.length - 1 === 1 ? "search" : "searches"} reached ${allFound}.`
          : `${lead} reached ${firstFound} of the ${reachedAll} origins. Echo’s other ${ran.length - 1 === 1 ? "search" : "searches"} reached the other ${reachedAll - firstFound === 1 ? "one" : reachedAll - firstFound}.`;

  const counts: Record<FlowKind, number> = { origin: 0, copy: 0, unplaced: 0 };
  for (const page of pages) counts[page.kind] += 1;
  const telem = analysis.costReceipt?.telem;
  const telemUsd = analysis.costReceipt?.usd.telem;
  const runsByEngine = telem ? Object.fromEntries(Object.entries(telem.providerRuns).filter(([, count]) => Number.isFinite(count) && count > 0)) : {};
  const runs = Object.values(runsByEngine).reduce((sum, count) => sum + count, 0);
  const bill: SearchBill | null = telem && runs > 0 && typeof telemUsd === "number" && telemUsd > 0 ? { runs, runsByEngine, searches: telem.searches, usd: telemUsd } : null;
  const answered = new Set<string>();
  for (const entry of audit) if (entry.router === "telem") for (const name of entry.providers ?? []) if (typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) answered.add(name);
  for (const name of Object.keys(bill?.runsByEngine ?? {})) answered.add(name);
  const idleEngines = engines.length ? [...answered].filter((name) => !engines.some((row) => row.engine === name)).sort().map((engine) => ({ engine, runs: bill?.runsByEngine[engine] ?? 0 })) : [];
  return { layer, origins: layer.origins, pages, engines, counts, marginal, needed, idleEngines, unrecordedOrigins: engines.length ? unrecordedOrigins : 0, searches, searchLine, bill };
}

function plural(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/** Smallest set of engines covering every origin, by trying every set (Telem asks a handful of engines, so this is tiny). */
function enginesNeeded(engines: string[], reachedBy: Map<string, Set<string>>): EnginesNeeded | null {
  if (!engines.length) return null;
  const origins = [...reachedBy.values()];
  const perOrigin = origins.map((set) => set.size).sort((a, b) => b - a);
  if (!origins.length) return { needed: 0, of: engines.length, alone: [], perOrigin };
  const alone = engines.filter((engine) => origins.every((set) => set.has(engine)));
  if (alone.length) return { needed: 1, of: engines.length, alone, perOrigin };
  const pool = engines.filter((engine) => origins.some((set) => set.has(engine)));
  if (pool.length > 12) return null;
  let best = pool.length;
  for (let mask = 1; mask < 1 << pool.length; mask += 1) {
    const chosen = pool.filter((_, index) => mask & (1 << index));
    if (chosen.length >= best) continue;
    if (origins.every((set) => chosen.some((engine) => set.has(engine)))) best = chosen.length;
  }
  return { needed: best, of: engines.length, alone: [], perOrigin };
}

// ---------------------------------------------------------------------------------------------------------------
// Engine scorecard: the same per-engine counts added up over several Telem-routed runs. It answers a question a search
// router cannot answer from its own logs: which engines' pages were origins, and which were copies or could not be placed.

export interface ScorecardRow {
  engine: string;
  /** Runs (claims) in which this engine returned at least one page Echo kept (it can be billed on a run and return none). */
  claims: number;
  /** Engine runs Telem billed for it, from the runs' receipts. */
  runs: number;
  pages: number;
  own: number;
  copies: number;
  unplaced: number;
  /** Origins its pages are, or lead back to, added up over the runs. */
  origins: number;
  /** Of those, origins that no other engine's pages reached in the same run. */
  onlyHere: number;
}

/** One claim's row in the "engines each origin needed" picture. */
export interface ScorecardClaim {
  claim: string;
  /** For each origin of the run, how many engines reached it (largest first). */
  perOrigin: number[];
  /** Fewest engines that reach every origin of the run, of the engines that answered. */
  needed: number;
  of: number;
}

export interface EngineScorecard {
  rows: ScorecardRow[];
  claimRows: ScorecardClaim[];
  /** Telem-routed runs counted. */
  claims: number;
  runs: number;
  usd: number;
  /** Independent origins confirmed, added up over the runs. */
  origins: number;
  /** Origins reached through exactly one engine: what a single-engine search could have missed. */
  singleEngineOrigins: number;
  /** Origins none of whose pages has an engine on record (a search that did not go through Telem): outside origins, the dots and every row. */
  unrecordedOrigins: number;
}

/** Null when no analysis was routed by Telem. Runs without engine data are skipped. */
export function engineScorecard(analyses: Array<Pick<EchoAnalysis, "claim" | "pages" | "roots" | "coPublishedRootGroups" | "searchAudit" | "costReceipt">>): EngineScorecard | null {
  const rows = new Map<string, ScorecardRow>();
  const claimRows: ScorecardClaim[] = [];
  const total = { claims: 0, runs: 0, usd: 0, origins: 0, singleEngineOrigins: 0, unrecordedOrigins: 0 };
  for (const analysis of analyses) {
    const flow = originFlow(analysis);
    if (!flow.engines.length) continue;
    total.claims += 1;
    if (flow.needed) claimRows.push({ claim: analysis.claim, perOrigin: flow.needed.perOrigin, needed: flow.needed.needed, of: flow.needed.of });
    total.runs += flow.bill?.runs ?? 0;
    total.usd += flow.bill?.usd ?? 0;
    total.unrecordedOrigins += flow.unrecordedOrigins;
    // For each origin of this run, the engines whose pages are it or lead back to it.
    const reachedBy = new Map<string, Set<string>>();
    for (const page of flow.pages) {
      if (!page.originId) continue;
      const set = reachedBy.get(page.originId) ?? new Set<string>();
      for (const engine of page.engines) set.add(engine);
      reachedBy.set(page.originId, set);
    }
    for (const engines of reachedBy.values()) {
      if (!engines.size) continue;
      total.origins += 1;
      if (engines.size === 1) total.singleEngineOrigins += 1;
    }
    for (const engine of flow.engines) {
      const row = rows.get(engine.engine) ?? { engine: engine.engine, claims: 0, runs: 0, pages: 0, own: 0, copies: 0, unplaced: 0, origins: 0, onlyHere: 0 };
      row.claims += 1;
      row.runs += flow.bill?.runsByEngine[engine.engine] ?? 0;
      row.pages += engine.pages;
      row.own += engine.own;
      row.copies += engine.copies;
      row.unplaced += engine.unplaced;
      row.origins += engine.origins;
      row.onlyHere += [...reachedBy.values()].filter((engines) => engines.size === 1 && engines.has(engine.engine)).length;
      rows.set(engine.engine, row);
    }
    // An engine Telem billed on this run although Echo kept none of its pages still has its runs counted.
    for (const [name, billed] of Object.entries(flow.bill?.runsByEngine ?? {})) {
      if (flow.engines.some((engine) => engine.engine === name)) continue;
      const row = rows.get(name) ?? { engine: name, claims: 0, runs: 0, pages: 0, own: 0, copies: 0, unplaced: 0, origins: 0, onlyHere: 0 };
      row.runs += billed;
      rows.set(name, row);
    }
  }
  if (!total.claims) return null;
  return { rows: [...rows.values()].sort((a, b) => b.pages - a.pages || a.engine.localeCompare(b.engine)), claimRows, ...total, usd: Math.round(total.usd * 1000) / 1000 };
}
