import type { EchoAnalysis, EchoPage } from "./types";
import { STOP_WORDS } from "./wording";

// The origin layer (opt-in; see README "Origin layer"): an Echo Score, a type for each independent origin, how the
// claim's wording moved down each branch, and the two contexts of the token comparison. Everything in this file is
// computed from a saved trace with no model call and no network, so it works on every trace Echo has ever saved.
// The types are read from the page's address, title and saved passage: a heuristic, shown as such.

export type OriginType = "primary_document" | "original_reporting" | "official_statement" | "press_release" | "anonymous_source" | "social_post" | "unknown";

export const ORIGIN_TYPE_WEIGHTS: Record<OriginType, number> = {
  primary_document: 1,
  original_reporting: 0.8,
  official_statement: 0.6,
  anonymous_source: 0.3,
  press_release: 0.3,
  social_post: 0.2,
  unknown: 0.3,
};

export const ORIGIN_TYPE_LABELS: Record<OriginType, string> = {
  primary_document: "Primary document",
  original_reporting: "Original reporting",
  official_statement: "Official statement",
  press_release: "Press release",
  anonymous_source: "Anonymous source",
  social_post: "Social post",
  unknown: "Type unclear",
};

/** An origin whose saved passage shows no evidence of its own starts a chain in this trace, but it is an assertion. */
export const NO_EVIDENCE_WEIGHT = 0.05;
export const SCORE_SCALE = 1.5;

const SOCIAL_HOSTS = /(?:^|\.)(?:facebook\.com|x\.com|twitter\.com|reddit\.com|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|linkedin\.com|quora\.com|threads\.net|pinterest\.com|tumblr\.com)$/i;
/** Sites where many unrelated authors publish: two pages there are not one entity. */
const PLATFORM_HOSTS = /(?:^|\.)(?:facebook\.com|x\.com|twitter\.com|reddit\.com|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|linkedin\.com|quora\.com|threads\.net|medium\.com|substack\.com|wordpress\.com|blogspot\.com|tumblr\.com|github\.io)$/i;
const WIRE_HOSTS = /(?:^|\.)(?:prnewswire\.com|businesswire\.com|globenewswire\.com|prweb\.com|einpresswire\.com|accesswire\.com|newswire\.com|newswire\.ca|prlog\.org)$/i;
const PRESS_PATH = /\/(?:press(?:-?releases?|room)?|news-?releases?|newsroom|media-?(?:center|centre|room|releases?))(?:\/|$)/i;
const PAPER_HOSTS = /(?:^|\.)(?:pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|europepmc\.org|sciencedirect\.com|doi\.org|arxiv\.org|biorxiv\.org|medrxiv\.org|jstor\.org|springer\.com|link\.springer\.com|wiley\.com|onlinelibrary\.wiley\.com|tandfonline\.com|plos\.org|journals\.plos\.org|nejm\.org|thelancet\.com|bmj\.com|jamanetwork\.com|science\.org|pnas\.org|cell\.com|frontiersin\.org|mdpi\.com|ssrn\.com|nber\.org|sec\.gov|courtlistener\.com|census\.gov|bls\.gov|data\.gov)$/i;
const PAPER_PATH = /\.pdf(?:$|[?#])|\/(?:doi|abs|article\/pii|articles\/(?:s|PMC)\d|filings?)\//i;
const OFFICIAL_HOSTS = /\.(?:gov|mil)$|\.gov\.[a-z]{2}$|(?:^|\.)(?:who\.int|europa\.eu|un\.org|oecd\.org|worldbank\.org|imf\.org)$/i;
const ANONYMOUS = /\b(?:people|person|sources?|officials?) (?:familiar with|close to|with knowledge of)\b|\b(?:anonymous|unnamed) (?:sources?|officials?)\b|\bsources? (?:say|said|tell|told)\b|\bon condition of anonymity\b/i;
const TWO_PART_SUFFIX = /\.(?:co|com|org|net|ac|gov|edu)\.[a-z]{2}$/i;

function hostOf(page: Pick<EchoPage, "url" | "domain">): string {
  try {
    return new URL(page.url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return page.domain.replace(/^www\./, "").toLowerCase();
  }
}

function pathOf(page: Pick<EchoPage, "url">): string {
  try {
    return new URL(page.url).pathname;
  } catch {
    return "";
  }
}

/** asurion.com for newsroom.asurion.com; bbc.co.uk for www.bbc.co.uk. An approximation, no public-suffix list. */
export function registrableDomain(host: string): string {
  const labels = host.split(".");
  const keep = TWO_PART_SUFFIX.test(host) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

function hasOwnEvidence(page: EchoPage): boolean {
  return page.primaryEvidenceStatus ? page.primaryEvidenceStatus === "found" : page.hasPrimaryEvidence;
}

/** The type of one origin page, from its address, title and saved passage. Order matters: the first test that fits wins. */
export function originTypeOf(page: EchoPage): OriginType {
  const host = hostOf(page);
  const path = pathOf(page);
  if (SOCIAL_HOSTS.test(host)) return "social_post";
  // A press release is named by its address, its title, or a wire dateline at the top of its text. A page that only
  // mentions "press release" in its body (an article about one) is not one.
  if (WIRE_HOSTS.test(host) || PRESS_PATH.test(path) || /\bpress release\b/i.test(page.title) || /\/PRNewswire\/|\(BUSINESS WIRE\)|GLOBE NEWSWIRE/.test(page.text.slice(0, 300))) return "press_release";
  if (PAPER_HOSTS.test(host) || PAPER_PATH.test(path)) return OFFICIAL_HOSTS.test(host) && !/pubmed|ncbi|sec\.gov|census|bls|data\.gov/i.test(host) ? "official_statement" : "primary_document";
  if (OFFICIAL_HOSTS.test(host)) return "official_statement";
  if (ANONYMOUS.test(page.text)) return "anonymous_source";
  if (hasOwnEvidence(page)) return "original_reporting";
  return "unknown";
}

export interface LayerOrigin {
  /** The lead page of the origin (a co-published group counts once, under the page with its own evidence, then the earliest). */
  id: string;
  pageIds: string[];
  name: string;
  title: string;
  url: string;
  date: string | null;
  type: OriginType;
  ownEvidence: boolean;
  /** What this origin adds to the score: its type's weight, or NO_EVIDENCE_WEIGHT without evidence of its own. */
  weight: number;
  /** The publisher this origin is counted under. Two origins of one publisher count once (the earlier one). */
  entity: string;
  /** False when an earlier origin of the same publisher already counted. */
  counted: boolean;
  /** Pages confirmed as copies of this origin, direct or through another copy. */
  echoes: number;
}

/** The labels describe the evidence base behind a claim, for or against it. They do not say the claim is true. */
export type ScoreLabel = "Thin evidence base" | "Moderate evidence base" | "Strong evidence base";

export interface OriginLayer {
  score: number;
  label: ScoreLabel;
  results: number;
  origins: LayerOrigin[];
  /** Distinct publishers among the origins. */
  entities: number;
  weightSum: number;
  /** The publisher's name when every origin is the same one, e.g. a company's own releases. */
  sameEntity: string | null;
  warning: string | null;
  /** Where the trace's pages stand: origin pages, pages confirmed as copies of an origin, and pages tied to neither. */
  originPages: number;
  copies: number;
  unplaced: number;
}

export function scoreLabel(score: number): ScoreLabel {
  return score <= 30 ? "Thin evidence base" : score <= 60 ? "Moderate evidence base" : "Strong evidence base";
}

function byDate(a: { date: string | null }, b: { date: string | null }): number {
  return (a.date ?? "9999").localeCompare(b.date ?? "9999");
}

/** Pages confirmed as derived from any page in `ids`, directly or through another confirmed copy. */
function confirmedEchoes(ids: string[], pages: EchoPage[]): EchoPage[] {
  const seen = new Set(ids);
  const found: EchoPage[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const page of pages) {
      if (seen.has(page.id) || page.judgment.kind !== "derived" || !page.judgment.parentId || !seen.has(page.judgment.parentId)) continue;
      seen.add(page.id);
      found.push(page);
      grew = true;
    }
  }
  return found;
}

/**
 * The Echo Score: 100 × (1 − e^(−W / 1.5)), where W adds one weight per independent publisher among the origins.
 * It scores how independently the claim is sourced in this trace, not whether the claim is true.
 */
export function originLayer(analysis: Pick<EchoAnalysis, "pages" | "roots" | "coPublishedRootGroups">): OriginLayer {
  const byId = new Map(analysis.pages.map((page) => [page.id, page] as const));
  const rootPages = analysis.roots.map((id) => byId.get(id)).filter((page): page is EchoPage => Boolean(page) && page!.judgment.kind === "origin");
  const grouped = new Set<string>();
  const groups: EchoPage[][] = [];
  for (const group of analysis.coPublishedRootGroups ?? []) {
    const members = group.map((id) => rootPages.find((page) => page.id === id)).filter((page): page is EchoPage => Boolean(page));
    if (members.length < 2) continue;
    members.forEach((page) => grouped.add(page.id));
    groups.push(members);
  }
  for (const page of rootPages) if (!grouped.has(page.id)) groups.push([page]);

  const origins: LayerOrigin[] = groups.map((members) => {
    const lead = [...members].sort((a, b) => Number(hasOwnEvidence(b)) - Number(hasOwnEvidence(a)) || (a.publishedDate ?? "9999").localeCompare(b.publishedDate ?? "9999"))[0];
    const types = members.map(originTypeOf);
    // The same text on a company newsroom and a wire service is a press release, whatever the newsroom page looks like alone.
    const type = types.includes("press_release") ? "press_release" : types.sort((a, b) => ORIGIN_TYPE_WEIGHTS[b] - ORIGIN_TYPE_WEIGHTS[a])[0];
    const ownEvidence = members.some(hasOwnEvidence);
    // A wire service only carries a company's release: count the group under its non-wire member (the company).
    const host = hostOf(WIRE_HOSTS.test(hostOf(lead)) ? members.find((page) => !WIRE_HOSTS.test(hostOf(page))) ?? lead : lead);
    // Two pages on one platform, wire service or paper index are not one publisher: each counts on its own.
    const shared = PLATFORM_HOSTS.test(host) || WIRE_HOSTS.test(host) || PAPER_HOSTS.test(host);
    return {
      id: lead.id,
      pageIds: members.map((page) => page.id),
      name: lead.domain.replace(/^www\./, ""),
      title: lead.title,
      url: lead.url,
      date: lead.publishedDate,
      type,
      ownEvidence,
      weight: ownEvidence ? ORIGIN_TYPE_WEIGHTS[type] : NO_EVIDENCE_WEIGHT,
      entity: shared ? `${host}#${lead.id}` : registrableDomain(host),
      counted: true,
      echoes: confirmedEchoes(members.map((page) => page.id), analysis.pages).length,
    };
  }).sort(byDate);

  // One publisher counts once, as its earliest origin: a company's second release is not a second independent source.
  const firstOfEntity = new Map<string, LayerOrigin>();
  for (const origin of origins) {
    if (firstOfEntity.has(origin.entity)) origin.counted = false;
    else firstOfEntity.set(origin.entity, origin);
  }
  const weightSum = [...firstOfEntity.values()].reduce((sum, origin) => sum + origin.weight, 0);
  const score = Math.round(100 * (1 - Math.exp(-weightSum / SCORE_SCALE)));
  const entities = firstOfEntity.size;
  const only = entities === 1 && origins.length > 1 ? origins[0] : null;
  const sameEntity = only && !only.entity.includes("#") ? only.entity : null;
  const evidenced = origins.filter((origin) => origin.ownEvidence).length;
  const originPages = origins.reduce((sum, origin) => sum + origin.pageIds.length, 0);
  const copies = origins.reduce((sum, origin) => sum + origin.echoes, 0);
  const unplaced = analysis.pages.length - originPages - copies;
  const unplacedNote = unplaced > 0 ? ` ${unplaced} of the ${analysis.pages.length} pages could not be tied to any origin.` : "";
  const warning = !origins.length
    ? "No page in this trace was confirmed as an independent origin."
    : sameEntity
      ? `Every origin is ${sameEntity}: ${origins.length} origins, one publisher.${unplacedNote}`
      : !evidenced
        ? origins.length === 1 ? "The one origin shows no evidence of its own in its saved passage." : origins.length === 2 ? "Neither of the 2 origins shows evidence of its own in its saved passage." : `None of the ${origins.length} origins shows evidence of its own in its saved passage.`
        : origins.length === 1
          ? `${unplaced > 0 ? "Every page Echo could place" : "Every page in this trace"} leads back to one origin (${origins[0].name}, ${ORIGIN_TYPE_LABELS[origins[0].type].toLowerCase()}).${unplacedNote}`
          : origins.every((origin) => origin.type === "press_release")
            ? "Every origin is a press release."
            : null;
  return { score, label: scoreLabel(score), results: analysis.pages.length, origins, entities, weightSum: Math.round(weightSum * 100) / 100, sameEntity, warning, originPages, copies, unplaced };
}

// ---------------------------------------------------------------------------------------------------------------
// Across search engines: a Telem-routed run records which engines returned each page. Counting origins per engine shows
// whether asking more engines found more sources or more copies of the same ones.

export interface EngineRow {
  /** Provider name as the trace stores it ("exa", "brave"). */
  engine: string;
  /** Pages of this trace that the engine returned. */
  pages: number;
  /** Independent origins those pages are, or lead back to. */
  origins: number;
  /** Of its pages, those confirmed as copies of an origin. */
  copies: number;
  /** Of its pages, those Echo could not tie to an origin. */
  unplaced: number;
  originIds: string[];
  /** Origins this engine's pages reach that no other engine's pages reach in this run. Does not depend on list order. */
  onlyHere: number;
}

export interface EngineBreakdown {
  engines: EngineRow[];
  /** Pages with a recorded engine. */
  pages: number;
  /** Origins reached by at least one engine's pages. */
  origins: number;
  /** For each origin (lead page id), the engines whose pages are it or lead back to it. */
  foundBy: Record<string, string[]>;
  /**
   * Hindsight on one run, among the engines that returned a kept page: `needed` is the fewest engines whose pages
   * (an origin page itself, or a confirmed copy leading back to it) together reach every origin reached in the run,
   * `of` is how many engines there were, and `alone` names the engines that reach every origin on their own.
   * The same figure as originFlow(...).needed, computed here because origin-flow.ts imports this file.
   */
  needed: { needed: number; of: number; alone: string[] };
  /** Order-free: no figure or wording in it depends on the order the engines or searches are listed in. */
  headline: string;
}

/** The fewest engines that reach every origin, by trying every set of them (Telem asks a handful, so this is tiny). */
function fewestEngines(names: string[], reach: Set<string>[]): number {
  if (!reach.length) return 0;
  const pool = names.slice(0, 12);
  let best = pool.length;
  for (let mask = 1; mask < 1 << pool.length; mask += 1) {
    const chosen = pool.filter((_, index) => mask & (1 << index));
    if (chosen.length >= best) continue;
    if (reach.every((set) => chosen.some((engine) => set.has(engine)))) best = chosen.length;
  }
  return best;
}

/** Null on a run that was not routed by Telem (no engine is recorded per page). */
export function engineBreakdown(analysis: Pick<EchoAnalysis, "pages" | "roots" | "coPublishedRootGroups" | "searchAudit">): EngineBreakdown | null {
  const enginesOf = new Map<string, Set<string>>();
  for (const entry of analysis.searchAudit ?? []) {
    if (entry.router !== "telem") continue;
    for (const [pageId, names] of Object.entries(entry.pageProviders ?? {})) {
      const set = enginesOf.get(pageId) ?? new Set<string>();
      for (const name of names) if (typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) set.add(name);
      enginesOf.set(pageId, set);
    }
  }
  const known = new Set(analysis.pages.map((page) => page.id));
  for (const id of [...enginesOf.keys()]) if (!known.has(id) || !enginesOf.get(id)!.size) enginesOf.delete(id);
  if (!enginesOf.size) return null;
  const layer = originLayer(analysis);
  const originOf = new Map<string, string>();
  const copyIds = new Set<string>();
  for (const origin of layer.origins) {
    for (const id of origin.pageIds) originOf.set(id, origin.id);
    for (const page of confirmedEchoes(origin.pageIds, analysis.pages)) {
      originOf.set(page.id, origin.id);
      copyIds.add(page.id);
    }
  }
  const rows = new Map<string, EngineRow>();
  const foundBy = new Map<string, Set<string>>();
  for (const [pageId, names] of enginesOf) {
    for (const engine of names) {
      const row = rows.get(engine) ?? { engine, pages: 0, origins: 0, copies: 0, unplaced: 0, originIds: [], onlyHere: 0 };
      row.pages += 1;
      const origin = originOf.get(pageId);
      if (!origin) row.unplaced += 1;
      else {
        if (copyIds.has(pageId)) row.copies += 1;
        if (!row.originIds.includes(origin)) row.originIds.push(origin);
        foundBy.set(origin, (foundBy.get(origin) ?? new Set<string>()).add(engine));
      }
      row.origins = row.originIds.length;
      rows.set(engine, row);
    }
  }
  const engines = [...rows.values()].sort((a, b) => b.pages - a.pages || a.engine.localeCompare(b.engine));
  const origins = foundBy.size;
  const count = engines.length;
  // Everything from here on is order-free: it is read from which engines reach which origin, never from list order.
  const reach = [...foundBy.values()];
  for (const row of engines) row.onlyHere = reach.filter((set) => set.size === 1 && set.has(row.engine)).length;
  const alone = origins ? engines.map((row) => row.engine).filter((engine) => reach.every((set) => set.has(engine))).sort() : [];
  const needed = { needed: alone.length ? 1 : fewestEngines(engines.map((row) => row.engine), reach), of: count, alone };
  // Origins that came through exactly one engine: what asking a single engine could have missed.
  const single = reach.filter((set) => set.size === 1).length;
  // Counts are of the pages Echo kept for this claim, not of every result the engines returned.
  const kept = enginesOf.size;
  const loose = [...enginesOf.keys()].filter((id) => !originOf.has(id)).length;
  const keptPages = kept === 1 ? "the one page Echo kept" : `the ${kept} pages Echo kept`;
  const noOrigin = kept === 1 ? "that page was not confirmed as an origin" : "none of those pages was confirmed as an origin";
  const looseNote = loose ? `; ${loose} of those pages could not be tied to any origin` : "";
  const all = origins === 1 ? "the one origin" : origins === 2 ? "both origins" : `all ${origins} origins`;
  const singleNote = single ? ` ${single} ${single === 1 ? "origin" : "origins"} came through one engine only.` : "";
  // An origin none of whose pages has an engine on record (a search that was not routed) is outside every count here.
  const offRecord = layer.origins.length - origins;
  const offNote = offRecord > 0 ? ` ${offRecord} ${offRecord === 1 ? "origin of this run has" : "origins of this run have"} no engine on record and ${offRecord === 1 ? "is" : "are"} not counted here.` : "";
  const reached = alone.length === count
    ? `${count === 2 ? "Both engines" : `Every one of the ${count} engines`} reached ${all}: any one of them alone would have reached ${origins === 1 ? "it" : "them"}.`
    : alone.length === 1
      ? `One of the ${count} engines (${alone[0]}) reached ${all} on its own; no other engine did.${singleNote}`
      : alone.length
        ? `${alone.length} of the ${count} engines (${alone.join(", ")}) each reached ${all} on their own; the other ${count - alone.length === 1 ? "one" : count - alone.length} did not.${singleNote}`
        : `No single engine reached ${all}; it took ${needed.needed} of the ${count}.${singleNote}`;
  const headline = count < 2
    ? origins === 0
      ? `One engine returned ${keptPages} on this run, and ${noOrigin}.${offNote}`
      : `One engine returned ${keptPages} on this run${looseNote}. Its pages reached ${origins} independent ${origins === 1 ? "origin" : "origins"}.${offNote}`
    : origins === 0
      ? `${count} engines returned ${keptPages}, and ${noOrigin}.${offNote}`
      : `${count} engines returned ${keptPages}${looseNote}. By this run's record: ${reached}${offNote} An engine is credited with a page only for the search that first returned it. One run, in hindsight: this does not rank the engines.`;
  return { engines, pages: enginesOf.size, origins, foundBy: Object.fromEntries([...foundBy].map(([id, names]) => [id, [...names].sort()])), needed, headline };
}

// ---------------------------------------------------------------------------------------------------------------
// Claim mutation: how the claim's wording moved from each origin down its confirmed copies.

const NUMBER_WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", half: "50%", third: "33%", quarter: "25%" };
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

function words(text: string): string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’%.,-]*[\p{L}\p{N}%]|[\p{L}\p{N}]/gu) ?? []).map((word) => word.replace(/[’']s$/, "").replace(/,/g, ""));
}

function contentWords(text: string): Set<string> {
  const kept = new Set<string>();
  for (const word of words(text)) {
    for (const part of word.split("-")) {
      if (part.length < 2 && !/\d/.test(part)) continue;
      if (STOP_WORDS.has(part)) continue;
      kept.add(NUMBER_WORDS[part] ?? part.replace(/(?:es|s)$/, (end) => (part.length > 4 ? "" : end)));
    }
  }
  return kept;
}

function numbersIn(text: string): string[] {
  const found = (text.match(NUMBER) ?? []).map((value) => value.replace(/,/g, ""));
  for (const word of words(text)) if (NUMBER_WORDS[word]) found.push(NUMBER_WORDS[word].replace("%", ""));
  return [...new Set(found)];
}

/** A numbered reference list ("1 2 3 4 5 …") or a run of footnote marks is not a statement of the claim. */
const REFERENCE_RUN = /(?:\b\d{1,3}\b[\s.,;)\]]+){4,}/;

function sentencesOf(text: string): string[] {
  return text
    // Extraction joins passages with "[...]" and keeps headings as "## Heading": both end a sentence.
    .replace(/\s*\[(?:\.\.\.|…)\]\s*/g, ". ")
    .replace(/\s+#+\s+(?:Summary\s+)?/g, ". ")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[\p{Lu}"“(\d#])/u)
    .map((sentence) => sentence.replace(/^(?:#+\s*(?:Summary\s+)?|\(Undated\)\s*[—–-]\s*|Share on Pinterest\s+|\[\d+:\d+\]\s*)+/i, "").replace(/\s*\[\d+:\d+\]/g, "").trim())
    .filter((sentence) => sentence.length >= 25 && sentence.length <= 600 && !REFERENCE_RUN.test(sentence));
}

/** The sentence of a page's saved passage that states the claim most directly, or its title when no sentence does. */
export function claimSentence(page: Pick<EchoPage, "text" | "title">, claim: string): string {
  const claimWords = contentWords(claim);
  // Pronouns in the claim ("You lose most of your body heat…") are not what a page has to say to state it.
  for (const pronoun of ["you", "your", "we", "our", "my", "i"]) claimWords.delete(pronoun);
  const claimNumbers = new Set(numbersIn(claim));
  let best = "";
  let bestScore = 0;
  for (const sentence of sentencesOf(page.text)) {
    const own = contentWords(sentence);
    let score = 0;
    for (const word of claimWords) if (own.has(word)) score += claimNumbers.has(word) ? 2 : 1;
    // A shorter sentence that says the same thing is the better quote.
    score -= Math.min(0.9, sentence.length / 1200);
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
    }
  }
  // No sentence states it: the title, without a trailing site name ("Title | Site").
  // The trailing replace drops the one "." that joining passages can leave after a "?", "!" or closing quote.
  const quote = (bestScore >= Math.max(1.5, claimWords.size * 0.4) ? best : (page.title.split(/\s[|–—]\s/)[0] || page.title)).replace(/(?<!\.)([.!?]["”’)]?)\.$/, "$1");
  return quote.length > 240 ? `${quote.slice(0, 237).replace(/\s+\S*$/, "")}…` : quote;
}

/** 0 = same content words, 1 = none shared. */
export function wordingDrift(from: string, to: string): number {
  const a = contentWords(from);
  const b = contentWords(to);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return Math.round((1 - shared / (a.size + b.size - shared)) * 100) / 100;
}

export interface MutationStep {
  pageId: string;
  parentId: string | null;
  domain: string;
  date: string | null;
  sentence: string;
  /** Wording drift from the page it copied (0–1). 0 for the origin itself. */
  drift: number;
  /** Figures in this sentence that the page it copied does not state. */
  newFigures: string[];
}

export interface MutationChain {
  originId: string;
  originName: string;
  steps: MutationStep[];
  /** Index into steps of the copy whose wording moved furthest from its parent, when one moved at all. */
  biggest: number | null;
  note: string | null;
}

export interface FigureVariant {
  figure: string;
  pages: Array<{ id: string; domain: string; kind: EchoPage["judgment"]["kind"] }>;
}

export interface ClaimMutation {
  chains: MutationChain[];
  /** The claim's own figure with its unit ("96 times"), when it has one. */
  claimFigure: string | null;
  /** Other figures stated for the same quantity anywhere in the trace, most pages first. */
  variants: FigureVariant[];
}

function unitPattern(claim: string): { figure: string; pattern: RegExp } | null {
  const match = /(\d[\d,]*(?:\.\d+)?)\s?(%|percent|per cent)|(\d[\d,]*(?:\.\d+)?)[\s-]([\p{L}]{3,})/u.exec(claim);
  if (!match) return null;
  if (match[2]) return { figure: `${match[1]}%`, pattern: /(\d[\d,]*(?:\.\d+)?)\s?(?:%|percent|per cent)/gi };
  const unit = match[4].toLocaleLowerCase().replace(/s$/, "");
  return { figure: `${match[3]} ${match[4].toLocaleLowerCase()}`, pattern: new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)[\\s-]${unit}s?\\b`, "gi") };
}

const PERCENT = /(\d[\d,]*(?:\.\d+)?)\s?(?:%|percent|per cent)/gi;

/** Figures a text states for the claim's own quantity ("352 times" for a "96 times" claim); percentages (and "half") when the claim has no figure. */
function quantityFigures(text: string, unit: ReturnType<typeof unitPattern>): string[] {
  const pattern = unit ? unit.pattern : PERCENT;
  const found: string[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) found.push(unit ? unit.figure.replace(/^[\d.,]+/, match[1].replace(/,/g, "")) : `${match[1].replace(/,/g, "")}%`);
  if (!unit || unit.figure.endsWith("%")) {
    if (/\bhalf\b/i.test(text)) found.push("half");
    if (/\b(?:a|one)[ -]third\b/i.test(text)) found.push("a third");
  }
  return [...new Set(found)];
}

/** Whether a text states this figure in any form: "half" is also "50%" or "50 percent", "45%" is also "45 percent". */
function statesFigure(text: string, figure: string): boolean {
  if (figure === "half") return /\bhalf\b|\b50\s?(?:%|percent|per cent)/i.test(text);
  if (figure === "a third") return /\b(?:a|one)[ -]third\b|\b33\s?(?:%|percent|per cent)/i.test(text);
  const number = figure.replace(/[^\d.]/g, "");
  if (figure.endsWith("%") && number === "50" && /\bhalf\b/i.test(text)) return true;
  return number ? new RegExp(`(?<![\\d.])${number.replace(".", "\\.")}(?![\\d])`).test(text) : false;
}

export function claimMutation(analysis: Pick<EchoAnalysis, "pages" | "roots" | "coPublishedRootGroups" | "claim">): ClaimMutation {
  const unit = unitPattern(analysis.claim);
  const layer = originLayer(analysis);
  const sentenceOf = new Map(analysis.pages.map((page) => [page.id, claimSentence(page, analysis.claim)] as const));
  const byId = new Map(analysis.pages.map((page) => [page.id, page] as const));
  const chains: MutationChain[] = [];
  for (const origin of layer.origins) {
    const copies = confirmedEchoes(origin.pageIds, analysis.pages).sort((a, b) => (a.publishedDate ?? "9999").localeCompare(b.publishedDate ?? "9999"));
    if (!copies.length) continue;
    const originSentence = sentenceOf.get(origin.id)!;
    const steps: MutationStep[] = [{ pageId: origin.id, parentId: null, domain: origin.name, date: origin.date, sentence: originSentence, drift: 0, newFigures: [] }];
    for (const page of copies) {
      // A copy of a co-published partner is compared with the origin's lead page: they are the same text.
      const parentId = page.judgment.parentId && !origin.pageIds.includes(page.judgment.parentId) ? page.judgment.parentId : origin.id;
      const parentSentence = sentenceOf.get(parentId) ?? originSentence;
      const sentence = sentenceOf.get(page.id)!;
      const parentText = `${parentSentence} ${byId.get(parentId)?.title ?? ""} ${byId.get(parentId)?.text ?? ""}`;
      steps.push({
        pageId: page.id,
        parentId,
        domain: page.domain.replace(/^www\./, ""),
        date: page.publishedDate,
        sentence,
        drift: wordingDrift(parentSentence, sentence),
        newFigures: quantityFigures(sentence, unit).filter((value) => !statesFigure(parentText, value)),
      });
    }
    let biggest: number | null = null;
    steps.forEach((step, index) => {
      if (index && step.drift >= 0.5 && (biggest === null || step.drift > steps[biggest].drift || (step.drift === steps[biggest].drift && step.newFigures.length > steps[biggest].newFigures.length))) biggest = index;
    });
    const moved = biggest === null ? null : steps[biggest];
    chains.push({
      originId: origin.id,
      originName: origin.name,
      steps,
      biggest,
      note: moved
        ? `${moved.domain} keeps the least of the wording of the page it copied (${byId.get(moved.parentId ?? "")?.domain.replace(/^www\./, "") ?? origin.name}): ${Math.round((1 - moved.drift) * 100)}% shared.`
        : null,
    });
  }

  // Other figures stated for the same quantity, anywhere in the trace (a claim without a figure: percentages).
  const claimNumber = unit ? unit.figure.replace(/[^\d.]/g, "") : null;
  // A percentage (or any figure of a claim that states none) has no unit word to anchor on, so it counts only when
  // one of the claim's own words follows it closely ("100 percent of our brains", "45 percent of body heat"). A figure
  // followed by something else ("10–15% is critical for survival functions") is about another quantity.
  const anchors = [...contentWords(analysis.claim)].filter((word) => !/\d/.test(word) && word.length >= 4 && !["percent", "only", "most", "your", "their", "have", "that"].includes(word));
  const needsAnchor = !unit || unit.figure.endsWith("%");
  const anchored = (text: string, at: number, length: number) => {
    if (!needsAnchor) return true;
    const after = contentWords(text.slice(at + length, at + length + 48));
    return anchors.some((word) => after.has(word));
  };
  const variants = new Map<string, FigureVariant>();
  for (const page of analysis.pages) {
    const seen = new Set<string>();
    const text = `${page.title}. ${sentenceOf.get(page.id) ?? ""}`;
    const pattern = unit ? unit.pattern : PERCENT;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const value = match[1].replace(/,/g, "");
      if (value === claimNumber || seen.has(value) || !anchored(text, match.index, match[0].length)) continue;
      seen.add(value);
      const figure = unit ? unit.figure.replace(/^[\d.,]+/, value) : `${value}%`;
      const entry = variants.get(figure) ?? { figure, pages: [] };
      entry.pages.push({ id: page.id, domain: page.domain.replace(/^www\./, ""), kind: page.judgment.kind });
      variants.set(figure, entry);
    }
  }
  return { chains, claimFigure: unit?.figure ?? null, variants: [...variants.values()].sort((a, b) => b.pages.length - a.pages.length).slice(0, 8) };
}

// ---------------------------------------------------------------------------------------------------------------
// Token comparison: the same question with every result in context, and with one page per independent origin.

export interface CompareSide {
  answer: string;
  confidence: "high" | "medium" | "low";
  /** How many independent sources the model says support its answer. */
  supportingSources: number;
  /** usage.input_tokens (plus cache tokens) as the API reported them for this request. */
  inputTokens: number;
  outputTokens: number;
  pagesInContext: number;
}

export interface TokenComparison {
  version: 1;
  claim: string;
  traceCreatedAt: string;
  model: string;
  createdAt: string;
  naive: CompareSide;
  echo: CompareSide;
  /** Whole percent fewer input tokens in the Echo context. */
  reductionPct: number;
  usd: number;
}

export const COMPARE_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    supportingSources: { type: "integer" },
  },
  required: ["answer", "confidence", "supportingSources"],
  additionalProperties: false,
};

const COMPARE_TASK = [
  "Answer from the search results below only.",
  "Return JSON: answer (at most three sentences: is the claim accurate, and what is it based on), confidence (high, medium or low: how confident you are in that answer), and supportingSources (how many independent sources among these results support your answer; count a source and the pages that merely repeat it once, as far as you can tell from what is shown).",
].join(" ");

function pageBlock(page: EchoPage, index: number, extra = ""): string {
  return `[${index + 1}] ${page.title} | ${page.domain} | ${page.publishedDate ?? "undated"}${extra}\n${page.text}`;
}

/** The two contexts. Pure: the same trace always gives the same prompts. */
export function comparePrompts(analysis: Pick<EchoAnalysis, "pages" | "roots" | "coPublishedRootGroups" | "claim">): { naive: string; echo: string; naivePages: number; echoPages: number } {
  const layer = originLayer(analysis);
  const byId = new Map(analysis.pages.map((page) => [page.id, page] as const));
  const question = `Claim to check: "${analysis.claim}"`;
  const naive = `${question}\n\n${COMPARE_TASK}\n\nSearch results (${analysis.pages.length}):\n\n${analysis.pages.map((page, index) => pageBlock(page, index)).join("\n\n")}`;
  const placed = new Set(layer.origins.flatMap((origin) => origin.pageIds));
  for (const origin of layer.origins) for (const page of confirmedEchoes(origin.pageIds, analysis.pages)) placed.add(page.id);
  const unplaced = analysis.pages.length - placed.size;
  const blocks = layer.origins.map((origin, index) => pageBlock(byId.get(origin.id)!, index, ` | origin type: ${ORIGIN_TYPE_LABELS[origin.type].toLowerCase()} | ${origin.ownEvidence ? "shows evidence of its own" : "no evidence of its own in this passage"} | repeated by ${origin.echoes} other ${origin.echoes === 1 ? "result" : "results"}${origin.counted ? "" : " | same publisher as an earlier origin"}`));
  const echo = `${question}\n\n${COMPARE_TASK}\n\nA source-tracing step has already reduced ${analysis.pages.length} search results to their ${layer.origins.length} independent ${layer.origins.length === 1 ? "origin" : "origins"} (${layer.entities} ${layer.entities === 1 ? "publisher" : "publishers"}). Pages that only repeat an origin were removed and are counted on its line.${unplaced ? ` ${unplaced} other ${unplaced === 1 ? "result" : "results"} could not be tied to an origin and ${unplaced === 1 ? "is" : "are"} left out.` : ""}\n\nIndependent origins (${layer.origins.length}):\n\n${blocks.join("\n\n") || "(none confirmed)"}`;
  return { naive, echo, naivePages: analysis.pages.length, echoPages: layer.origins.length };
}

// ---------------------------------------------------------------------------------------------------------------
// echo_check: the small result an agent gets before it answers (the MCP tool and "Show as data").

export interface EchoCheck {
  claim: string;
  echo_score: number;
  label: ScoreLabel;
  num_results: number;
  num_origins: number;
  num_publishers: number;
  /** Where the num_results pages stand. Only origin pages and confirmed copies lead back to an origin. */
  pages: { origin_pages: number; confirmed_copies: number; not_tied_to_an_origin: number };
  /** One sentence that states the split, so a reader cannot round "every placed page" up to "every page". */
  summary: string;
  origins: Array<{ name: string; type: OriginType; url: string; date: string | null; own_evidence: boolean; repeated_by: number }>;
  warning: string | null;
  /** Echo's own answer, written from the origin pages only, when the trace has one. */
  echo_answer?: string;
  /** Telem-routed runs only: what each search engine's pages led back to. Listed by pages kept; the order ranks nothing. */
  engines?: Array<{ engine: string; pages: number; origins: number; origins_only_this_engine_reached: number }>;
  /**
   * Telem-routed runs only: the fewest engines whose pages (an origin page, or a confirmed copy leading back to it)
   * together reach every origin reached in this run, of the engines that returned a kept page. Hindsight on one run.
   */
  engines_needed?: { needed: number; of: number };
  /** Telem-routed runs only: the engines-needed finding in plain words. Order-free. */
  engines_summary?: string;
  note: string;
}

export function echoCheck(analysis: Pick<EchoAnalysis, "pages" | "roots" | "coPublishedRootGroups" | "claim" | "searchAudit"> & Partial<Pick<EchoAnalysis, "answer">>): EchoCheck {
  const layer = originLayer(analysis);
  const engines = engineBreakdown(analysis);
  const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;
  const summary = layer.origins.length
    ? `Of ${count(layer.results, "page", "pages")} about this claim, ${count(layer.originPages, "is an origin page", "are origin pages")} (${count(layer.origins.length, "independent origin", "independent origins")}, ${count(layer.entities, "publisher", "publishers")}), ${count(layer.copies, "is a confirmed copy", "are confirmed copies")} of an origin, and ${layer.unplaced} could not be tied to any origin.`
    : `None of the ${count(layer.results, "page", "pages")} about this claim was confirmed as an independent origin.`;
  return {
    claim: analysis.claim,
    echo_score: layer.score,
    label: layer.label,
    num_results: layer.results,
    num_origins: layer.origins.length,
    num_publishers: layer.entities,
    pages: { origin_pages: layer.originPages, confirmed_copies: layer.copies, not_tied_to_an_origin: layer.unplaced },
    summary,
    origins: layer.origins.map((origin) => ({ name: origin.name, type: origin.type, url: origin.url, date: origin.date, own_evidence: origin.ownEvidence, repeated_by: origin.echoes })),
    warning: layer.warning,
    ...(typeof analysis.answer === "string" && analysis.answer.trim() ? { echo_answer: analysis.answer.trim() } : {}),
    ...(engines
      ? {
          engines: engines.engines.map((row) => ({ engine: row.engine, pages: row.pages, origins: row.origins, origins_only_this_engine_reached: row.onlyHere })),
          engines_needed: { needed: engines.needed.needed, of: engines.needed.of },
          engines_summary: engines.headline,
        }
      : {}),
    note: "The score (0-100) rates the evidence base behind this claim among the retrieved pages: independent origins with evidence of their own, whichever way they point. It is not a truth rating: a debunked claim can have a strong evidence base. Pages not tied to an origin are neither confirmed copies nor confirmed origins. Origin types are read by rule from each page's address, title and passage; an origin no rule names is called original reporting when the judging model found evidence of its own in the passage, and type unclear when it did not.",
  };
}
