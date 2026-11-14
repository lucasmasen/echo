import { claimCandidates } from "./claim-candidates";
import type { EchoAnalysis, EchoPage, SourceCheck } from "./types";
import { coPublishedLeadOrder } from "./graph";
import { canonicalUrl, pageKey } from "./url";
import { textOverlap } from "./wording";

/**
 * "Check these sources": the links a person supplies (an AI answer's citations, a pasted list) instead of a search.
 * Pure helpers shared by the browser (chips, the per-link result list) and the server (pipeline.ts suppliedSourceUrls,
 * the authority). No model call: everything here reads the pasted text or a finished trace.
 */
export const MAX_SUPPLIED_URLS = 20;
export const MAX_SUPPLIED_URL_LENGTH = 2_000;
/** Citation numbers Echo keeps: 1 to 999 (a year such as 2019 is never a citation number). */
const MAX_CITATION_NUMBER = 999;

/** Trailing characters that end a sentence or a markdown/citation wrapper, not the address. */
const TRAILING = /[.,;:!?'"’”»>\]*_]+$/;
// An IPv6 host is written in brackets ("http://[::1]/q"); brackets anywhere else end the address.
const ADDRESS = /https?:\/\/(?:\[[0-9a-f:.]+\](?::\d{1,5})?)?[^\s<>"'`\]\[{}|\\^]*/gi;
const BRACKETED_HOST = /^https?:\/\/\[[0-9a-f:.]+\](?::\d{1,5})?/i;

function trimAddress(raw: string): string {
  let url = raw.replace(TRAILING, "");
  // A closing parenthesis belongs to the address only when it opens one too (Wikipedia's "Foo_(bar)").
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1).replace(TRAILING, "");
  // The closing bracket of an IPv6 host ("http://[::1]") is the address's own, never trailing punctuation.
  const host = raw.match(BRACKETED_HOST)?.[0];
  return host && url.length < host.length ? host : url;
}

export { pageKey };

// The number an answer gives a link, read from just before the address:
//   right before it: "[2] https://…", "[2]: https://…", "[^2]: https://…" (a markdown footnote), "(2) https://…";
//   as a markdown link's whole text: "[2](https://…)", "[[2]](https://…)";
//   at the start of its line, when it is the line's first address: "2. https://…", "2) Title https://…", "- [2] Title — https://…".
const NUMBER_BEFORE = /(?:\[\^?(\d{1,3})\]\s*:?|\((\d{1,3})\))\s*$/;
const NUMBER_AS_LINK_TEXT = /\[\[?\^?(\d{1,3})\]?\]\($/;
const NUMBER_AT_LINE_START = /^\s*(?:[-*•+]\s+)?(?:\[\^?(\d{1,3})\]:?|\((\d{1,3})\)|(\d{1,3})[.)])(?:\s|$)/;

function numberBefore(text: string, index: number): number | null {
  const before = text.slice(Math.max(0, index - 12), index);
  const adjacent = before.match(NUMBER_AS_LINK_TEXT) ?? before.match(NUMBER_BEFORE);
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const line = text.slice(lineStart, index);
  const leading = !adjacent && !/https?:\/\//i.test(line) ? line.match(NUMBER_AT_LINE_START) : null;
  const found = (adjacent ?? leading)?.slice(1).find((group) => group !== undefined);
  const number = found === undefined ? NaN : Number(found);
  return Number.isInteger(number) && number >= 1 && number <= MAX_CITATION_NUMBER ? number : null;
}

export interface CitedUrl {
  url: string;
  /** The answer's own number for this link ("[2]"), or its place in the paste when the answer numbers none. */
  number: number;
}

/**
 * Every http(s) address in pasted text with its citation number, in order of first appearance, each in Echo's
 * canonical form (no #fragment, no utm_/fbclid tracking, no trailing slash) and listed once (http/https and www.
 * variants count as one page, keep the first number found for it, and use the https address when one is given). When the paste numbers none of its links they
 * are numbered 1..N in order. When it numbers some, an unnumbered link before the first numbered one gets the lowest
 * free number, and the others (and a second page given a number already taken) get the next free numbers after the
 * highest, in order, so no two links share a number. Not capped: the caller says how many were left out.
 */
export function citedUrlsInText(text: string): CitedUrl[] {
  const seen = new Map<string, { url: string; number: number | null }>();
  // "a.example/x,https://b.example/y" (a comma-joined list) is two addresses, not one with a comma in it. The comma
  // becomes a space, so every index still points into `text`.
  for (const match of text.replace(/,(?=https?:\/\/)/gi, " ").matchAll(ADDRESS)) {
    const url = canonicalUrl(trimAddress(match[0]));
    if (!url || url.length > MAX_SUPPLIED_URL_LENGTH) continue;
    const key = pageKey(url);
    const number = numberBefore(text, match.index ?? 0);
    const entry = seen.get(key);
    if (!entry) seen.set(key, { url, number });
    else {
      if (entry.number === null && number !== null) entry.number = number;
      // http and https copies of a page: keep the https address, whichever came first.
      if (/^http:/i.test(entry.url) && /^https:/i.test(url)) entry.url = url;
    }
  }
  const entries = [...seen.values()];
  if (entries.every((entry) => entry.number === null)) return entries.map((entry, index) => ({ url: entry.url, number: index + 1 }));
  const taken = new Set<number>();
  const kept = entries.map((entry) => (entry.number !== null && !taken.has(entry.number) && taken.add(entry.number) ? entry.number : null));
  // An unnumbered link before the first numbered one ("([asurion.com](…)) and ([2](…))") takes the lowest free number,
  // so it reads as [1]; one after them takes the next number after the highest ("[2] a, then b" gives b [3]).
  const firstNumbered = kept.findIndex((number) => number !== null);
  let low = 1;
  let next = Math.max(...taken) + 1;
  const free = (from: number) => {
    let number = from;
    while (taken.has(number)) number += 1;
    taken.add(number);
    return number;
  };
  return entries.map((entry, index) => {
    const own = kept[index];
    if (own !== null) return { url: entry.url, number: own };
    if (index < firstNumbered) return { url: entry.url, number: (low = free(low)) };
    return { url: entry.url, number: (next = free(next)) };
  });
}

/** Every http(s) address in pasted text, once, canonical, in order of first appearance (citedUrlsInText without the numbers). */
export function urlsInText(text: string): string[] {
  return citedUrlsInText(text).map((cited) => cited.url);
}

/** How many addresses in pasted text are longer than Echo reads (2,000 characters), so the panel can say they were left out. */
export function overlongUrlCount(text: string): number {
  let count = 0;
  for (const match of text.replace(/,(?=https?:\/\/)/gi, " ").matchAll(ADDRESS)) {
    const url = canonicalUrl(trimAddress(match[0]));
    if (url && url.length > MAX_SUPPLIED_URL_LENGTH) count += 1;
  }
  return count;
}

/**
 * A ?urls= value: addresses separated by spaces, commas or newlines (as Copy link writes them). Not capped: the panel
 * shows the first 20 and says how many more were left out.
 */
export function urlsFromParam(value: string | null): string[] {
  return value ? urlsInText(value) : [];
}

/**
 * A ?nums= value: the answer's citation numbers for the ?urls= links, comma-separated in the same order ("2,3,4").
 * Null unless it is exactly one distinct number from 1 to 999 per link, so a stale or edited link falls back to 1..N.
 */
export function numbersFromParam(value: string | null, count: number): number[] | null {
  if (!value || !count) return null;
  const numbers = value.split(",").map((part) => (/^\s*\d{1,3}\s*$/.test(part) ? Number(part) : NaN));
  if (numbers.length !== count || numbers.some((number) => !Number.isInteger(number) || number < 1 || number > MAX_CITATION_NUMBER) || new Set(numbers).size !== count) return null;
  return numbers;
}

/**
 * The share parameters of a supplied-sources run: its claim, its links and, when the answer numbered them other than
 * 1..N, their numbers (?nums=), so the link reopens the panel with the answer's own [2]–[6]. It only fills the panel.
 */
export function sourceShareParams(claim: string, check: SourceCheck): Record<string, string> {
  const numbers = citationNumbers(check);
  return { claim, urls: check.urls.join(" "), ...(isPlainNumbering(numbers) ? {} : { nums: numbers.join(",") }) };
}

/** The panel's text for links opened from a share link: "[2] https://…" per line with numbers, else one link per line. */
export function sharedSourceText(urls: string[], numbers: number[] | null): string {
  return urls.map((url, index) => (numbers ? `[${numbers[index]}] ${url}` : url)).join("\n");
}

/**
 * The links a paste would send: every address once, minus the removed pages (removal is by page, so an http or www
 * copy stays removed too), at most 20, each with its citation number. A removed link's number is not reused.
 */
export function pastedLinks(text: string, removed: string[]): { urls: string[]; numbers: number[]; leftOut: number; removedHere: number; overlong: number } {
  const gone = new Set(removed);
  const cited = citedUrlsInText(text);
  const kept = cited.filter((link) => !gone.has(pageKey(link.url)));
  const sent = kept.slice(0, MAX_SUPPLIED_URLS);
  return {
    urls: sent.map((link) => link.url),
    numbers: sent.map((link) => link.number),
    leftOut: Math.max(0, kept.length - MAX_SUPPLIED_URLS),
    removedHere: cited.length - kept.length,
    overlong: overlongUrlCount(text),
  };
}

/** Removals apply to the current paste only: a page no longer in the text is forgotten, so pasting it again brings it back. */
export function removalsStillPasted(text: string, removed: string[]): string[] {
  if (!removed.length) return removed;
  const present = new Set(citedUrlsInText(text).map((link) => pageKey(link.url)));
  return removed.filter((key) => present.has(key));
}

/** True when numbers are just 1..N in order, which a trace does not need to store. */
export function isPlainNumbering(numbers: number[]): boolean {
  return numbers.every((number, index) => number === index + 1);
}

/**
 * A finished supplied-sources result with the citation numbers the request was sent with, so they survive in the trace
 * file. The server never sees the numbers (its cache key is the links); they are attached only when the result's links
 * are the links sent, in the same order, and only when they are not plain 1..N.
 */
export function withCitationNumbers(result: EchoAnalysis, sent: { urls: string[]; numbers?: number[] } | null | undefined): EchoAnalysis {
  const check = result.sourceCheck;
  if (!check || !sent?.numbers || sent.numbers.length !== sent.urls.length || isPlainNumbering(sent.numbers)) return result;
  if (check.urls.length !== sent.urls.length || check.urls.some((url, index) => pageKey(url) !== pageKey(sent.urls[index]))) return result;
  return { ...result, sourceCheck: { ...check, numbers: [...sent.numbers] } };
}

/** The citation number of each supplied link, in supplied order: the trace's own numbers, or 1..N. */
export function citationNumbers(check: SourceCheck): number[] {
  return check.numbers && check.numbers.length === check.urls.length ? check.numbers : check.urls.map((_, index) => index + 1);
}

/**
 * The number each answer citation shows, in answerSourceIds order. The answer model numbers its sources 1..N in the
 * order it was given them; a supplied-sources result shows instead each source's supplied-link number (the [2] of the
 * pasted answer), so the answer, its cited-source list, the per-link list and Cite once agree. Search results, and a
 * supplied-sources answer whose sources cannot all be matched to a supplied link, keep 1..N. Display only: the stored
 * answer text and ids are unchanged.
 */
export function answerCitationNumbers(analysis: EchoAnalysis): number[] {
  const plain = analysis.answerSourceIds.map((_, index) => index + 1);
  const check = analysis.sourceCheck;
  if (!check) return plain;
  const numbers = citationNumbers(check);
  const numberByKey = new Map(check.urls.map((url, index) => [pageKey(url), numbers[index]] as const));
  const pageById = new Map(analysis.pages.map((page) => [page.id, page] as const));
  const mapped = analysis.answerSourceIds.map((id) => { const page = pageById.get(id); return page?.url ? numberByKey.get(pageKey(page.url)) : undefined; });
  return mapped.every((number): number is number => number !== undefined) && new Set(mapped).size === mapped.length ? mapped : plain;
}

/** The answer text as shown: each "[k]" marker of a cited source renumbered by answerCitationNumbers. */
export function displayedAnswer(analysis: EchoAnalysis): string {
  const numbers = answerCitationNumbers(analysis);
  return analysis.answer.replace(/\[(\d+)\]/g, (marker, digits: string) => {
    const index = Number(digits) - 1;
    return index >= 0 && index < numbers.length ? `[${numbers[index]}]` : marker;
  });
}

export type SourceLinkStatus ="origin" | "same origin" | "copy" | "possible copy" | "unclear" | "unread" | "off claim";

export interface SourceLinkRow {
  number: number;
  url: string;
  host: string;
  status: SourceLinkStatus;
  /** What Echo found for this link, in a few words: "independent origin", "copy of [2]", "could not be read". */
  verdict: string;
  /**
   * The supplied link this one points to, by citation number: the parent of a copy or possible copy, the first link of
   * a co-published group for "same origin". Absent when there is none, or when the parent is not a supplied link.
   */
  of?: number;
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Why an unresolved page with no proposed parent stays unclear, from the safety note pipeline.ts wrote into it.
function unclearReason(page: EchoPage, pages: EchoPage[]): string {
  const evidence = page.judgment.evidence ?? "";
  if (/not dated earlier than this page/.test(evidence)) {
    const sameText = pages.some((other) => other.id !== page.id && Math.max(textOverlap(page.text ?? "", other.text ?? ""), textOverlap(other.text ?? "", page.text ?? "")) >= 0.5);
    return sameText ? "same text, no earlier date" : "no earlier date";
  }
  if (/search-provider estimate/.test(evidence)) return "its date is only an estimate";
  if (/dates are unavailable/.test(evidence)) return "no date to order it";
  if (/loop of links/.test(evidence)) return "its links form a loop";
  if (/unsure this page is an independent origin/.test(evidence)) return "no data of its own";
  return "no confirmed link";
}

/**
 * One row per supplied link, in the order the person supplied them: its citation number, its site, and what the trace
 * says about it. Derived from the trace alone (sourceCheck, pages, judgment kind and parentId, roots, co-published
 * groups); no model call. A link that is not a trace page was either unread (sourceCheck.unreadUrls) or set aside by
 * grouping as not addressing the claim.
 */
/**
 * Each trace page's supplied-link number (the [2] of the pasted answer), by page id: the numbers the per-link list,
 * Cite once and the answer use, so a tree card can show the same one. Empty for a search result.
 */
export function suppliedNumbersByPageId(analysis: EchoAnalysis): Map<string, number> {
  const numberById = new Map<string, number>();
  const check = analysis.sourceCheck;
  if (!check) return numberById;
  const numbers = citationNumbers(check);
  const pageByKey = new Map(analysis.pages.map((page) => [pageKey(page.url), page]));
  check.urls.forEach((url, index) => { const page = pageByKey.get(pageKey(url)); if (page) numberById.set(page.id, numbers[index]); });
  return numberById;
}

export function sourceLinkRows(analysis: EchoAnalysis): SourceLinkRow[] {
  const check = analysis.sourceCheck;
  if (!check) return [];
  const numbers = citationNumbers(check);
  const pageByKey = new Map(analysis.pages.map((page) => [pageKey(page.url), page]));
  const numberById = suppliedNumbersByPageId(analysis);
  const unread = new Set((check.unreadUrls ?? []).map(pageKey));
  const verifiable = new Set(analysis.verifiableRoots ?? []);
  // Co-published roots count as one origin: the group's lead (coPublishedLeadOrder, the same page the tree tags ORIGIN)
  // is that origin, the others say so, whatever order the links were pasted in.
  const firstOfGroup = new Map<string, string>();
  for (const group of analysis.coPublishedRootGroups ?? []) {
    const ordered = coPublishedLeadOrder(analysis, group).filter((id) => numberById.has(id));
    for (const id of ordered.slice(1)) firstOfGroup.set(id, ordered[0]);
  }
  const ref = (id: string | null) => (id && numberById.has(id) ? `[${numberById.get(id)}]` : "another supplied page");
  const of = (id: string | null) => (id && numberById.has(id) ? { of: numberById.get(id) } : {});
  return check.urls.map((url, index) => {
    const base = { number: numbers[index], url, host: hostOf(url) };
    const page = pageByKey.get(pageKey(url));
    if (!page) return unread.has(pageKey(url)) ? { ...base, status: "unread" as const, verdict: "could not be read" } : { ...base, status: "off claim" as const, verdict: "not about this claim" };
    const { kind, parentId } = page.judgment;
    if (kind === "origin" || analysis.roots.includes(page.id)) {
      const first = firstOfGroup.get(page.id);
      if (first) return { ...base, status: "same origin" as const, verdict: `published together with ${ref(first)}, one origin`, ...of(first) };
      return { ...base, status: "origin" as const, verdict: verifiable.has(page.id) ? "independent origin, with its own evidence" : "independent origin" };
    }
    if (kind === "derived") return { ...base, status: "copy" as const, verdict: `copy of ${ref(parentId)}`, ...of(parentId) };
    if (parentId) return { ...base, status: "possible copy" as const, verdict: `possible copy of ${ref(parentId)}, link not confirmed`, ...of(parentId) };
    return { ...base, status: "unclear" as const, verdict: `unclear (${unclearReason(page, analysis.pages)})` };
  });
}

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/**
 * The supplied-sources headline: "5 supplied links → 1 independent origin". Zero origins is unresolved, not proven
 * dependent, so it reads "no confirmed independent origin"; a trace with no page says what happened to the links.
 */
export function sourceCheckHeadline(analysis: EchoAnalysis): { text: string; evidence: string | null } {
  const check = analysis.sourceCheck;
  if (!check) return { text: "", evidence: null };
  const supplied = check.urls.length;
  const links = supplied === 1 ? "the supplied link" : `the ${supplied} supplied links`;
  const unread = (check.unreadUrls ?? []).length;
  if (!analysis.pages.length) {
    const what = unread >= supplied ? (supplied === 1 ? "could not be read" : "could be read")
      : unread === 0 ? (supplied === 1 ? "is not about this claim" : "is about this claim")
        : (supplied === 1 ? "is not readable and about this claim" : "is readable and about this claim");
    return { text: supplied === 1 ? `${links[0].toUpperCase()}${links.slice(1)} ${what}` : `None of ${links} ${what}`, evidence: null };
  }
  const { independentOrigins: origins, verifiableOrigins: withEvidence } = analysis.summary;
  const head = `${count(supplied, "supplied link", "supplied links")} → `;
  if (origins === 0) return { text: `${head}no confirmed independent origin`, evidence: null };
  const evidence = withEvidence >= origins ? null : withEvidence === 0 ? `none with ${origins === 1 ? "its" : "their"} own evidence` : `${withEvidence} with ${withEvidence === 1 ? "its" : "their"} own evidence`;
  return { text: `${head}${count(origins, "independent origin", "independent origins")}`, evidence };
}

/**
 * What the run read and what its pages are, with no zero clauses, every page accounted for: "Echo read all 5 supplied
 * links and ran no web search. Of the 5 pages about this claim: 1 root page (1 independent origin), 2 confirmed copies
 * of another supplied page, 2 unclear." Root pages published together read "2 root pages published together (1
 * independent origin)", as the search result's page breakdown counts them. Present slide 1 lists each link beside it,
 * so it passes listUnread: false and the unread sites are not named twice.
 */
export function sourceCheckReadLine(analysis: EchoAnalysis, { listUnread = true }: { listUnread?: boolean } = {}): string {
  const check = analysis.sourceCheck;
  if (!check) return "";
  const supplied = check.urls.length;
  const unread = check.unreadUrls ?? [];
  const offClaim = analysis.excludedPageCount ?? 0;
  const read = supplied - unread.length;
  const pages = analysis.pages;
  const copies = pages.filter((page) => page.judgment.kind === "derived").length;
  const unclear = pages.filter((page) => page.judgment.kind === "unclear").length;
  const pageIds = new Set(pages.map((page) => page.id));
  const rootPages = analysis.roots.filter((id) => pageIds.has(id)).length;
  const origins = analysis.summary.independentOrigins;
  // As the search result's breakdown: "1 root page (1 independent origin)"; root pages published together are one origin.
  const rootClause = !rootPages ? ""
    : rootPages === origins ? `${count(rootPages, "root page", "root pages")} (${count(origins, "independent origin", "independent origins")})`
      : origins === 1 ? `${rootPages} root pages published together (1 independent origin)`
        : `${rootPages} root pages (${count(origins, "independent origin", "independent origins")}; pages published together count once)`;
  const opening = unread.length === 0
    ? (supplied === 1 ? "Echo read the supplied link and ran no web search." : `Echo read all ${supplied} supplied links and ran no web search.`)
    : `Echo read ${read} of the ${count(supplied, "supplied link", "supplied links")} and ran no web search.`;
  const clauses = [
    rootClause,
    copies ? `${count(copies, "confirmed copy", "confirmed copies")} of another supplied page` : "",
    unclear ? `${unclear} unclear` : "",
  ].filter(Boolean);
  const tree = pages.length > 1 && clauses.length ? `Of the ${pages.length} pages about this claim: ${clauses.join(", ")}.` : "";
  return [
    opening,
    unread.length ? `${count(unread.length, "link", "links")} could not be read${listUnread ? ` (${unread.map(hostOf).join(", ")})` : ""}.` : "",
    offClaim ? `${count(offClaim, "page does", "pages do")} not address this claim and ${offClaim === 1 ? "is" : "are"} left out of the count.` : "",
    tree,
  ].filter(Boolean).join(" ");
}

/** The one plain line under the per-link list: "Your answer's 5 citations trace back to 1 independent origin." */
export function sourceCheckPoint(analysis: EchoAnalysis): string {
  const check = analysis.sourceCheck;
  if (!check) return "";
  const supplied = check.urls.length;
  const { independentOrigins: origins, verifiableOrigins: withEvidence } = analysis.summary;
  const about = analysis.pages.length;
  // No page to trace: say plainly what happened to the links instead of "0 address this claim … no origin".
  if (about === 0) {
    const unread = Math.min(supplied, (check.unreadUrls ?? []).length);
    const yours = supplied === 1 ? "Your answer's citation" : `None of your answer's ${supplied} citations`;
    if (unread >= supplied) return `${yours} ${supplied === 1 ? "could not be read" : "could be read"}, so Echo has no origin to show.`;
    if (unread === 0) return `${yours} ${supplied === 1 ? "is not about this claim" : "is about this claim"}, so Echo has no origin to show.`;
    return `None of your answer's ${supplied} citations is readable and about this claim (${unread} could not be read), so Echo has no origin to show.`;
  }
  const evidence = origins === 0 ? ""
    : withEvidence >= origins ? (origins === 1 ? ", with its own evidence" : ", all with their own evidence")
      : withEvidence === 0 ? (origins === 1 ? ", without its own evidence" : ", none with their own evidence")
        : `, ${withEvidence} with ${withEvidence === 1 ? "its" : "their"} own evidence`;
  const target = origins === 0 ? "no confirmed independent origin among these links" : `${count(origins, "independent origin", "independent origins")}${evidence}`;
  if (about === supplied) return `Your answer's ${count(supplied, "citation", "citations")} ${supplied === 1 ? "traces" : "trace"} back to ${target}.`;
  return `Of your answer's ${count(supplied, "citation", "citations")}, ${about} ${about === 1 ? "addresses" : "address"} this claim, and ${about === 1 ? "it traces" : "they trace"} back to ${target}.`;
}

/**
 * The text report's section for a supplied-sources result (Copy report, Download report): the headline, what Echo
 * read, each link with its number, verdict and address, then the plain line. Empty for a search trace.
 */
export function sourceCheckReportLines(analysis: EchoAnalysis): string[] {
  if (!analysis.sourceCheck) return [];
  const headline = sourceCheckHeadline(analysis);
  return [
    "Checked supplied links (no web search):",
    `${headline.text}${headline.evidence ? ` (${headline.evidence})` : ""}`,
    // Each link is listed below, so the line does not name the unread sites too.
    sourceCheckReadLine(analysis, { listUnread: false }),
    ...sourceLinkRows(analysis).map((row) => `[${row.number}] ${row.host} — ${row.verdict}\n   ${row.url}`),
    sourceCheckPoint(analysis),
    sourceCiteOnce(analysis)?.line ?? "",
  ].filter(Boolean);
}

export interface CiteOnceOrigin {
  /** The citation number to keep: the origin's lead link (coPublishedLeadOrder; links published together with it follow it). */
  cite: number;
  url: string;
  host: string;
  /** The other supplied links published together with it (one origin). */
  publishedTogether: number[];
  /** Supplied links whose confirmed copy chain leads back to this origin, in supplied order. */
  repeatedBy: number[];
  /** Whether a page of this origin shows data of its own in its passage ("found"), none ("not found"), or it is unclear. */
  ownEvidence: "found" | "not found" | "unclear";
}

export interface CiteOnceResult {
  /** "Cite once: [1] asurion.com (also published as [2]). Repeats it: [3], [5]. Unclear: [4]." */
  line: string;
  origins: CiteOnceOrigin[];
  /** Each supplied link: its status, the supplied link it points to ("of"), and the origin its copy chain reaches. */
  citations: Array<{ n: number; url: string; status: SourceLinkStatus; of: number | null; origin: number | null }>;
}

const numberList = (numbers: number[]) => numbers.map((number) => `[${number}]`).join(", ");

/**
 * Which supplied links to cite once, read from the per-link rows alone (no model call): each independent origin with
 * the links published together with it and the links whose confirmed copies lead back to it, then the unclear links (a
 * possible copy is unclear: its link is not confirmed), confirmed copies of an unclear link, unread links and links not
 * about the claim. It only regroups what the trace already says; a citation identifies a supplied source, not proof.
 */
export function sourceCiteOnce(analysis: EchoAnalysis): CiteOnceResult | null {
  const rows = sourceLinkRows(analysis);
  if (!rows.length) return null;
  const byNumber = new Map(rows.map((row) => [row.number, row]));
  const verifiable = new Set(analysis.verifiableRoots ?? []);
  const pageByKey = new Map(analysis.pages.map((page) => [pageKey(page.url), page]));
  // Follow a link along its confirmed copies: it ends at an origin (or a link published with one), at the first link
  // that is not a confirmed copy (unclear, a possible copy: `via`), or nowhere (a loop, a parent outside the list).
  const chainEnd = (row: SourceLinkRow): { origin: number | null; via: number | null } => {
    const seen = new Set<number>();
    let current: SourceLinkRow | undefined = row;
    while (current && !seen.has(current.number)) {
      seen.add(current.number);
      if (current.status === "origin") return { origin: current.number, via: null };
      if (current.status === "same origin") return { origin: current.of ?? null, via: null };
      if (current.status !== "copy") return { origin: null, via: current === row ? null : current.number };
      current = current.of === undefined ? undefined : byNumber.get(current.of);
    }
    return { origin: null, via: null };
  };
  const ends = new Map(rows.map((row) => [row.number, chainEnd(row)]));
  const origins: CiteOnceOrigin[] = rows.filter((row) => row.status === "origin").map((row) => {
    const together = rows.filter((other) => other.status === "same origin" && other.of === row.number);
    const pages = [row, ...together].map((member) => pageByKey.get(pageKey(member.url))).filter((page): page is EchoPage => Boolean(page));
    return {
      cite: row.number,
      url: row.url,
      host: row.host,
      publishedTogether: together.map((other) => other.number),
      repeatedBy: rows.filter((other) => other.status === "copy" && ends.get(other.number)?.origin === row.number).map((other) => other.number),
      ownEvidence: pages.some((page) => verifiable.has(page.id)) ? "found" : pages[0]?.primaryEvidenceStatus === "not found" ? "not found" : "unclear",
    };
  });
  const unclear = rows.filter((row) => row.status === "unclear" || row.status === "possible copy").map((row) => row.number);
  // Confirmed copies whose chain stops at an unclear link, by that link (in supplied order), and those that end nowhere.
  const viaUnclear = new Map<number, number[]>(unclear.map((number) => [number, []]));
  const nowhere: number[] = [];
  for (const row of rows) {
    const end = ends.get(row.number);
    if (row.status !== "copy" || !end || end.origin !== null) continue;
    if (end.via !== null && viaUnclear.has(end.via)) viaUnclear.get(end.via)!.push(row.number);
    else nowhere.push(row.number);
  }
  const unread = rows.filter((row) => row.status === "unread").map((row) => row.number);
  const offClaim = rows.filter((row) => row.status === "off claim").map((row) => row.number);
  const named = (origin: CiteOnceOrigin) => {
    const notes = [
      origin.publishedTogether.length ? `also published as ${numberList(origin.publishedTogether)}` : "",
      origin.ownEvidence === "not found" ? "no own evidence identified" : origin.ownEvidence === "unclear" ? "own evidence unclear" : "",
    ].filter(Boolean);
    return `[${origin.cite}] ${origin.host}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  };
  const sentences = [
    origins.length === 0 ? "No supplied link is a confirmed independent origin, so there is none to cite once."
      : origins.length === 1 ? `Cite once: ${named(origins[0])}.`
        : `Cite once each: ${origins.map(named).join("; ")}.`,
    ...origins.filter((origin) => origin.repeatedBy.length).map((origin) => `${origins.length === 1 ? "Repeats it" : `Repeats [${origin.cite}]`}: ${numberList(origin.repeatedBy)}.`),
    unclear.length ? `Unclear: ${numberList(unclear)}.` : "",
    ...[...viaUnclear].filter(([, copies]) => copies.length).map(([via, copies]) => `Repeats [${via}]: ${numberList(copies)}.`),
    nowhere.length ? `Repeats another supplied link: ${numberList(nowhere)}.` : "",
    unread.length ? `Could not be read: ${numberList(unread)}.` : "",
    offClaim.length ? `Not about this claim: ${numberList(offClaim)}.` : "",
  ].filter(Boolean);
  return {
    line: sentences.join(" "),
    origins,
    citations: rows.map((row) => ({ n: row.number, url: row.url, status: row.status, of: row.of ?? null, origin: ends.get(row.number)?.origin ?? null })),
  };
}

/**
 * The same result as data, for tools that use citations: the claim, the cite-once line, the origins (each with the
 * citations published together with it and those that repeat it) and every citation. Valid JSON, one entry per line.
 */
export function sourceCiteOnceData(analysis: EchoAnalysis): string | null {
  const result = sourceCiteOnce(analysis);
  if (!result) return null;
  const entries = (items: unknown[]) => (items.length ? `[\n    ${items.map((item) => JSON.stringify(item)).join(",\n    ")}\n  ]` : "[]");
  return [
    "{",
    `  "claim": ${JSON.stringify(analysis.claim)},`,
    `  "checked": "supplied links only, no web search",`,
    `  "citeOnce": ${JSON.stringify(result.line)},`,
    `  "origins": ${entries(result.origins.map(({ cite, url, publishedTogether, repeatedBy, ownEvidence }) => ({ cite, url, publishedTogether, repeatedBy, ownEvidence })))},`,
    `  "citations": ${entries(result.citations)},`,
    `  "note": "A citation identifies a supplied source, not proof of the claim. Origins are counted among these links only."`,
    "}",
  ].join("\n");
}

/** Where a search trace's report has its query audit, a supplied-sources report says that no search ran. */
export function sourceCheckNoSearchLine(analysis: EchoAnalysis): string {
  const supplied = analysis.sourceCheck?.urls.length ?? 0;
  return `Web search: none ran. Echo read only the ${supplied === 1 ? "supplied link" : `${supplied} supplied links`}, so there is no search query audit.`;
}

// Citation markers and links inside an answer's prose, and a source list's own lines ("[1] https://…", "2. Title — https://…").
const MARKER = /\s*\[\^?\d{1,3}\](?!\()/g;
const MARKDOWN_LINK = /\[([^\]\n]{0,200})\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\))?[^\s)]*)\)/gi;
const SOURCE_LINE = /^\s*(?:[-*•+]\s+)?(?:\[\^?\d{1,3}\]:?|\(\d{1,3}\)|\d{1,3}[.)])\s.*https?:\/\//i;
const CITED = "";

/**
 * The sentence to check, picked from a pasted answer: the one carrying its citation markers or links, preferring one
 * that also states a figure, else the first that states a figure or credits a source (claim-candidates.ts). Markers
 * and links are taken out of the returned sentence. Null when nothing fits. Pure text work: it never starts a run.
 */
export function suggestedClaim(text: string): string | null {
  const prose = text
    .split("\n")
    .filter((line) => !SOURCE_LINE.test(line) && !/^\s*(?:sources?|references?|citations?)\s*:?\s*$/i.test(line))
    .join("\n")
    // "…a day.[1] Next" reads as "…a day [1]. Next", so the marker stays with its sentence.
    .replace(/([.!?])((?:\s*\[\^?\d{1,3}\](?!\())+)/g, "$2$1")
    .replace(MARKDOWN_LINK, (_, label: string) => (/^\[?\^?\d{1,3}\]?$/.test(label.trim()) || /^[\w.-]+\.[a-z]{2,}$/i.test(label.trim()) ? CITED : `${label}${CITED}`))
    .replace(MARKER, CITED)
    // A parenthesised number at a sentence's end is a marker too ("…96 times a day (1).").
    .replace(/\s*\(\d{1,3}\)(?=[^\S\n]*(?:[.!?,;:]|$))/gm, CITED)
    // An address keeps the punctuation after it ("(https://…)." ends its sentence).
    .replace(ADDRESS, (address: string) => `${CITED}${address.slice(trimAddress(address).length)}`)
    .replace(/\(\s*(?:\s*)+\)/g, CITED);
  // A cited sentence or one with a figure can be short ("Americans check phones 96 times a day.[^1]"): from 20
  // characters, like the browser extension's pick; any other sentence still needs the usual 40.
  const candidates = claimCandidates(prose, 50, { minLength: 20 })
    .filter((candidate) => candidate.text.replaceAll(CITED, "").trim().length >= 40 || candidate.text.includes(CITED) || candidate.reasons.includes("states a figure"));
  const score = (candidate: (typeof candidates)[number]) => (candidate.text.includes(CITED) ? 4 : 0) + (candidate.reasons.includes("states a figure") ? 2 : 0) + (candidate.reasons.includes("credits a source") ? 1 : 0);
  const best = candidates.reduce<(typeof candidates)[number] | null>((top, candidate) => (!top || score(candidate) > score(top) ? candidate : top), null);
  if (!best) return null;
  const sentence = best.text.replaceAll(CITED, " ").replace(/\s+([.,;:!?])/g, "$1").replace(/\s+/g, " ").replace(/\(\s*\)/g, "").trim();
  return sentence.length >= 8 ? sentence.slice(0, 500) : null;
}
