import { dateFrom, isContinuouslyEditedPage, metadataDate, relevantPassage, sharedWordingSignals, tagBlocks } from "./pipeline";
import type { EchoPage } from "./types";

// Free, offline-analysis helpers for choosing demo claims: given raw HTML for
// pages that repeat a claim, estimate whether a trace could show directional
// copy links. No search or model calls; the caller supplies the HTML.

export interface ScoutInput {
  url: string;
  html: string | null;
  status?: string;
}

export interface ScoutPage {
  id: string;
  url: string;
  status: string;
  date: string | null;
  dateSource: "URL date" | "page metadata" | null;
  mentionsClaim: boolean;
  passage: string;
}

export interface ScoutLink {
  childId: string;
  parentId: string;
  overlap: number;
  phrases: string[];
  /** True when both pages have usable dates and the parent is strictly earlier. */
  directional: boolean;
}

export interface ScoutReport {
  pages: ScoutPage[];
  fetched: number;
  relevant: number;
  usableDates: number;
  links: ScoutLink[];
  directionalLinks: number;
  pagesWithDirectionalParent: number;
  /** Pages sharing at least half their passage with another page, regardless of date. */
  pagesInCopyGroups: number;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };

/** Drops `<!-- … -->` comments in one left-to-right pass (a lazy expression rescans on unclosed comments). */
function withoutComments(text: string): string {
  let out = "";
  let position = 0;
  for (let start = text.indexOf("<!--"); start >= 0; start = text.indexOf("<!--", position)) {
    const end = text.indexOf("-->", start + 4);
    if (end < 0) break;
    out += `${text.slice(position, start)} `;
    position = end + 3;
  }
  return out + text.slice(position);
}

// The same text as the lazy expressions this replaced, in linear time on hostile HTML (unclosed blocks, runs of "<").
export function htmlToText(html: string): string {
  let withoutBlocks = "";
  let position = 0;
  for (const block of tagBlocks(html, /<(script|style|noscript|svg|template|iframe|nav|header|footer|form|aside)\b/gi, (tag) => `</${tag}>`)) {
    withoutBlocks += `${html.slice(position, block.index)} `;
    position = block.end;
  }
  withoutBlocks += html.slice(position);
  const text = withoutComments(withoutBlocks);
  // Text after the last ">" holds no tag; leaving it out keeps "<…" scans from running to the end each time.
  const cut = text.lastIndexOf(">") + 1;
  return (text.slice(0, cut).replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, ". ").replace(/<[^>]+>/g, " ") + text.slice(cut))
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : " ";
      }
      return ENTITY[code.toLowerCase()] ?? match;
    })
    .replace(/\s*\.\s*(?:\.\s*)+/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

function claimTerms(claim: string): string[] {
  const stop = new Set(["that", "this", "with", "from", "their", "there", "they", "your", "have", "only", "into", "about", "than", "were", "what", "when", "which"]);
  return [...new Set(claim.toLowerCase().match(/[\p{L}\p{N}]+%?/gu) ?? [])].filter((word) => (word.length > 3 || /\d/.test(word)) && !stop.has(word));
}

/** True when most of the claim's content words (and every number) appear in the passage. */
export function mentionsClaim(passage: string, claim: string): boolean {
  const terms = claimTerms(claim);
  if (!terms.length) return false;
  const words = new Set(passage.toLowerCase().match(/[\p{L}\p{N}]+%?/gu) ?? []);
  const numbers = terms.filter((term) => /\d/.test(term));
  if (numbers.some((number) => !words.has(number) && !words.has(number.replace(/%$/, "")))) return false;
  return terms.filter((term) => words.has(term) || words.has(term.replace(/%$/, ""))).length / terms.length >= 0.6;
}

export function scoutPages(inputs: ScoutInput[], claim: string): ScoutReport {
  const pages: ScoutPage[] = inputs.map((input, index) => {
    const id = `p${index + 1}`;
    if (!input.html) return { id, url: input.url, status: input.status ?? "not fetched", date: null, dateSource: null, mentionsClaim: false, passage: "" };
    const urlDate = dateFrom(null, "", input.url);
    const meta = isContinuouslyEditedPage(input.url) ? null : metadataDate(input.html);
    const date = urlDate.date ?? meta;
    const dateSource = urlDate.date ? "URL date" as const : meta ? "page metadata" as const : null;
    const passage = relevantPassage(htmlToText(input.html), claim);
    return { id, url: input.url, status: input.status ?? "ok", date, dateSource, mentionsClaim: mentionsClaim(passage, claim), passage };
  });
  const relevant = pages.filter((page) => page.mentionsClaim);
  const byId = new Map(pages.map((page) => [page.id, page] as const));
  const signals = sharedWordingSignals(relevant.map((page) => ({ id: page.id, text: page.passage, publishedDate: page.date }) as EchoPage), claim);
  const links: ScoutLink[] = [];
  const seen = new Set<string>();
  for (const [childId, matches] of signals) {
    for (const match of matches) {
      if (match.overlap < 0.3 && !match.phrases.length) continue;
      const child = byId.get(childId)!;
      const parent = byId.get(match.pageId)!;
      // Report each pair once, oriented earlier → later when dates allow.
      const key = [childId, match.pageId].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const ordered = child.date && parent.date && child.date !== parent.date;
      const [later, earlier] = ordered && child.date! < parent.date! ? [parent, child] : [child, parent];
      links.push({ childId: later.id, parentId: earlier.id, overlap: match.overlap, phrases: match.phrases, directional: Boolean(ordered) });
    }
  }
  links.sort((a, b) => Number(b.directional) - Number(a.directional) || b.overlap - a.overlap);
  return {
    pages,
    fetched: pages.filter((page) => page.status === "ok").length,
    relevant: relevant.length,
    usableDates: relevant.filter((page) => page.date).length,
    links,
    directionalLinks: links.filter((link) => link.directional).length,
    pagesWithDirectionalParent: new Set(links.filter((link) => link.directional).map((link) => link.childId)).size,
    pagesInCopyGroups: new Set(links.filter((link) => link.overlap >= 0.5).flatMap((link) => [link.childId, link.parentId])).size,
  };
}
