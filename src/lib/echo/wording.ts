import type { EchoAnalysis, EchoPage } from "./types";
import { hasReliableDate } from "./graph";
import { canonicalUrl } from "./url";

export const STOP_WORDS = new Set(["a", "about", "after", "again", "also", "an", "and", "are", "as", "at", "been", "being", "between", "by", "could", "does", "each", "for", "from", "had", "has", "have", "in", "into", "is", "it", "more", "most", "of", "on", "one", "or", "other", "over", "same", "some", "such", "than", "that", "the", "their", "there", "these", "they", "this", "those", "through", "to", "under", "very", "was", "were", "what", "when", "where", "which", "while", "with", "would"]);

const CLAIM_FRAMING = /^(?:(?:is\s+it|it\s+is|it's)\s+true\s+that|is\s+it\s+true|did\s+you\s+know(?:\s+that)?|i\s+(?:heard|read)(?:\s+that)?|(?:people|they)\s+say(?:\s+that)?|(?:fact[-\s]?check|claim)\s*:)\s*[:,–—-]?\s*/i;
const QUESTION_LEAD = /^(?:do|does|did|is|are|was|were|can|could|will|would|has|have|had)\s+/i;

/**
 * The claim's own words, for searching: a judge may type "Is it true that goldfish have a 3-second memory?" or
 * "Do we use only 10% of our brains?". Pages state the claim, not the question, so drop the framing, a question's
 * leading verb and the question mark. The displayed claim and the judge prompts keep what was typed.
 */
// "Saw this on twitter: …", "I read on Reddit that …": where the judge met the claim, not the claim. Only places
// people meet claims count, so "Found on Mars: water ice…" keeps Mars.
const SEEN_ON_FRAMING = /^(?:i\s+)?(?:saw|read|found|heard|seen)\s+(?:this|it)?\s*(?:on|in)\s+(?:(?:the|a|an|some)\s+)?(?:twitter|x|facebook|fb|instagram|insta|ig|tiktok|reddit|youtube|threads|bluesky|linkedin|whatsapp|telegram|snapchat|quora|news|internet|web|online|social media|group chat|podcast|radio|tv|television|book|article|blog|post|tweet|video|reel|meme|forum|newsletter|email|text)\b\s*(?:[:,–—-]\s*|\s+(?:that|saying|says|claims?)\s+)/iu;
// A pasted link names where the claim was seen; its path words ("status 123") would only pollute the searches.
const PASTED_LINK = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

export function searchClaimText(claim: string): string {
  const typed = claim.trim().replace(/\s+/g, " ");
  const question = /\?["”’)]*$/.test(typed);
  let text = typed.replace(PASTED_LINK, " ").replace(/\p{Extended_Pictographic}\uFE0F?/gu, " ").replace(/\s+/g, " ").trim().replace(SEEN_ON_FRAMING, "").replace(CLAIM_FRAMING, "").replace(/^(?:(?:that|says|claims?)\s+)/i, "").replace(/[?\s]+$/, "");
  if (question) text = text.replace(QUESTION_LEAD, "");
  text = text.trim();
  return text.length >= 8 ? text : typed;
}

export function findSharedPhrases(sourceText: string, comparedText: string): string[] {
  const tokenize = (text: string) => text.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*%?/gu) ?? [];
  const sourceWords = tokenize(sourceText);
  const comparedWords = tokenize(comparedText);
  const sourceNormalized = ` ${sourceWords.map((word) => word.toLocaleLowerCase()).join(" ")} `;
  const candidates: Array<{ start: number; length: number; phrase: string }> = [];

  for (let start = 0; start <= comparedWords.length - 5; start += 1) {
    const longestLength = Math.min(16, comparedWords.length - start);
    for (let length = longestLength; length >= 5; length -= 1) {
      const words = comparedWords.slice(start, start + length);
      const contentWordCount = words.filter((word) => !STOP_WORDS.has(word.toLocaleLowerCase())).length;
      if (contentWordCount < 3) continue;
      const phrase = words.join(" ");
      if (!sourceNormalized.includes(` ${phrase.toLocaleLowerCase()} `)) continue;
      candidates.push({ start, length, phrase });
      break;
    }
  }

  candidates.sort((a, b) => b.length - a.length || a.start - b.start);
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (selected.some((match) => candidate.start < match.start + match.length && match.start < candidate.start + candidate.length)) continue;
    selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected.sort((a, b) => a.start - b.start).map(({ phrase }) => phrase);
}

const OVERLAP_SHINGLE_WORDS = 6;

function shingles(text: string, ignore?: (words: string[]) => boolean): Set<string> {
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+%?/gu) ?? [];
  const result = new Set<string>();
  for (let index = 0; index + OVERLAP_SHINGLE_WORDS <= words.length; index += 1) {
    const window = words.slice(index, index + OVERLAP_SHINGLE_WORDS);
    if (ignore?.(window)) continue;
    result.add(window.join(" "));
  }
  return result;
}

/**
 * Share (0 to 1, two decimals) of `text`'s six-word sequences that also occur
 * in `other`. High values suggest copied or syndicated text. Returns 0 for
 * passages too short to measure reliably. `ignore` drops sequences (for
 * example, ones that merely restate the claim) from both sides.
 */
export function textOverlap(text: string, other: string, ignore?: (words: string[]) => boolean): number {
  const own = shingles(text, ignore);
  if (own.size < 8) return 0;
  const theirs = shingles(other, ignore);
  let shared = 0;
  for (const shingle of own) if (theirs.has(shingle)) shared += 1;
  return Math.round((shared / own.size) * 100) / 100;
}

export function visibleEdgeSignals(child: EchoPage, parent: EchoPage) {
  const parentUrl = canonicalUrl(parent.url);
  const visibleUrls = parentUrl ? [...child.text.matchAll(/https?:\/\/[^\s)\]>"']+/gi)].map((match) => canonicalUrl(match[0].replace(/[.,;:!?]+$/, ""))) : [];
  return {
    linkedParentUrl: Boolean(child.linkedPageIds?.includes(parent.id) || (parentUrl && visibleUrls.includes(parentUrl))
      // A link Echo found in the page's own HTML (search text had dropped it) is just as visible on the page.
      || child.citations?.some((citation) => citation.pageId === parent.id && citation.how === "link")),
    sharedPhrases: findSharedPhrases(parent.text, child.text),
    textOverlap: textOverlap(child.text, parent.text),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Where a page's own date came from. Only a reliable date (hasReliableDate, the rule behind "no reliable date" on
// screen) is shown or ordered: a search engine's estimate, a date with no recorded source, an odd format or one in
// the future is left out of the sentence and never compared (as the copy hunt gives such pages no timing).
const DATE_SOURCE_WORDS: Partial<Record<NonNullable<EchoPage["publishedDateSource"]>, string>> = {
  "page metadata": "from page metadata",
  "page text": "from the page text",
  "URL date": "from its URL",
};
const ownDate = (page: EchoPage) => (hasReliableDate(page) ? page.publishedDate : null);

/** A page date as written on screen: "Sep 28, 2021", "Nov 2019" or "2019", read in UTC so the day never shifts. */
function shownDate(value: string): string | null {
  const match = value.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  if (!match) return null;
  const [, year, month, day] = match;
  const name = month ? MONTHS[Number(month) - 1] : undefined;
  if (month && !name) return null;
  return day ? `${name} ${Number(day)}, ${year}` : name ? `${name} ${year}` : year;
}

function dayValue(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const time = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(time) ? time : null;
}

/**
 * One plain sentence for a confirmed derived edge (child copies parent), built only from facts already on the two
 * pages: their domains, their own dates (never a search estimate) and where each came from, how the child cites the
 * parent, a visible link,
 * and the distinctive phrases the two share. No model text and no new claim: it says what Echo saw, never that the
 * child copied. Null for anything but a derived edge to that parent within `analysis` (an uncertain, dashed link is
 * not described as confirmed), or when there is nothing concrete to say. For example: "fox13seattle.com (Sep 28,
 * 2021, from page metadata) is dated after asurion.com (Nov 21, 2019, from page metadata) and shares 2 distinctive
 * phrases with it."
 */
export function edgeSentence(child: EchoPage, parent: EchoPage, analysis: Pick<EchoAnalysis, "pages" | "claim">): string | null {
  if (child.judgment.kind !== "derived" || child.judgment.parentId !== parent.id || child.id === parent.id) return null;
  if (!analysis.pages.some((page) => page.id === child.id) || !analysis.pages.some((page) => page.id === parent.id)) return null;
  const name = (page: EchoPage) => page.domain.replace(/^www\./, "").trim();
  if (!name(child) || !name(parent)) return null;
  const dated = (page: EchoPage) => {
    const date = ownDate(page);
    const shown = date ? shownDate(date) : null;
    if (!shown) return "";
    const source = page.publishedDateSource ? DATE_SOURCE_WORDS[page.publishedDateSource] : undefined;
    return ` (${shown}${source ? `, ${source}` : ""})`;
  };
  // The parent is named, with its date, the first time; after that it is "it".
  let parentNamed = false;
  const parentRef = () => {
    if (parentNamed) return "it";
    parentNamed = true;
    return `${name(parent)}${dated(parent)}`;
  };
  const clauses: string[] = [];
  const childDay = dayValue(ownDate(child));
  const parentDay = dayValue(ownDate(parent));
  if (childDay !== null && parentDay !== null && childDay > parentDay) clauses.push(`is dated after ${parentRef()}`);
  const citation = child.citations?.find((entry) => entry.pageId === parent.id);
  const signals = visibleEdgeSignals(child, parent);
  if (signals.linkedParentUrl) clauses.push(`links to ${parentRef()}`);
  else if (citation?.how === "title") clauses.push(`cites ${parentRef()} by its title`);
  else if (citation?.how === "name and year") clauses.push(`cites ${parentRef()} by name and year`);
  else if (citation?.how === "named as source") clauses.push(`names ${parentRef()} as a source`);
  // A phrase that mostly restates the claim is on every page about it, so it is not counted as distinctive (as in
  // the copy hunt's fingerprints). findSharedPhrases keeps at most three, so three may mean more.
  const claimWords = new Set(analysis.claim.toLocaleLowerCase().match(/[\p{L}\p{N}]+%?/gu) ?? []);
  for (const word of [...claimWords]) if (word.endsWith("%")) claimWords.add(word.slice(0, -1)).add("percent").add("cent");
  const restatesClaim = (phrase: string) => {
    const content = (phrase.toLocaleLowerCase().match(/[\p{L}\p{N}]+%?/gu) ?? []).filter((word) => word.length > 3 || /\d/.test(word));
    return !content.length || content.filter((word) => claimWords.has(word)).length / content.length >= 0.6;
  };
  const phrases = signals.sharedPhrases.filter((phrase) => !restatesClaim(phrase)).length;
  if (phrases) clauses.push(`shares ${signals.sharedPhrases.length === 3 ? `at least ${phrases}` : phrases} distinctive phrase${phrases === 1 ? "" : "s"} with ${parentRef()}`);
  if (!clauses.length) return null;
  const joined = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
  return `${name(child)}${dated(child)} ${joined}.`;
}
