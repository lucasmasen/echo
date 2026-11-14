/**
 * "Trace an article": the sentences in an article's text most worth checking — the ones that state a specific figure
 * or credit a study, survey or report. Pure text work, no model call: a reader picks one, and only then may they start
 * a (paid) trace of it. Order follows the article, so the list reads like the page.
 */

export const MAX_CANDIDATES = 6;
const MIN_LENGTH = 40;
const MAX_LENGTH = 240;

// A specific figure: 96 times, 10%, 2.5 million, $4 billion, 1 in 5, "ninety percent".
const FIGURE = /(?<![\p{L}\p{N}])\d[\d,.]*\s*(?:%|percent\b|per cent\b|times\b|million\b|billion\b|thousand\b|people\b|years?\b|hours?\b|minutes?\b|days?\b)|\b\d+\s+(?:in|out of)\s+\d+\b|[$€£]\s?\d|\b(?:ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\s+percent\b/iu;
// Sentences that credit a source.
const SOURCED = /\b(?:study|studies|survey|surveys|report|reports|research|researchers|scientists|experts|poll|data|analysis|according to|found that|finds that|shows that|showed that|estimated?|journal|university|institute)\b/i;
// Boilerplate that is never the claim.
const BOILERPLATE = /\b(?:cookie|cookies|subscribe|newsletter|sign up|log in|all rights reserved|privacy policy|terms of (?:use|service)|advertisement|click here|share this|read more|related articles?)\b/i;

// A publisher describing itself (an "About" box or footer), never the claim: "Pew Research Center does research to
// inform the public…", "… is a nonpartisan, nonadvocacy fact tank …", "The Center conducts public opinion polling…",
// "It does not take policy positions." Narrow on purpose: a sentence reporting what a study or survey found still passes.
const SELF_DESCRIPTION = [
  /\binforms? the public\b/i,
  /\b(?:is|are) an? (?:[\w-]+,?\s+){0,3}?(?:fact tank|think tank|non-?profit|not-for-profit|non-?partisan|non-?advocacy)\b/i,
  /\bdoes not take (?:policy )?positions\b/i,
  /\b(?:is a|wholly owned) subsidiary of\b/i,
  /\b(?:our|its) mission is\b/i,
  /^(?:(?:The|Our)\s+)?(?:\p{Lu}[\p{L}&.'’-]*\s+){1,6}(?:conducts|does|carries out)\s+(?:public opinion polling|research|surveys)\b/u,
  /^We (?:conduct|do|carry out) (?:public opinion polling|research|surveys)\b/,
];

export interface ClaimCandidate {
  text: string;
  /** Why it was picked, for the reader: "states a figure", "credits a source", or both. */
  reasons: string[];
}

// A sentence does not end after a title, a month or an initialism: "Dr. Smith", "Jan. 5", "Smith et al. 2019", "the
// U.S. National Institute", "e.g. this".
const ABBREVIATION = /(?:\b(?:Dr|Mr|Mrs|Ms|Prof|St|Sr|Jr|vs|Inc|Ltd|Co|No|Fig|Gen|Gov|Sen|Rep|etc|al|approx|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.|\b(?:e\.g|i\.e)\.|(?:\b[A-Z]\.){2,})$/;

function sentences(text: string): string[] {
  // A blank line ends a paragraph (or list item), so a caption or bullet without a full stop never runs into the next
  // one. Headings ("# Why we can't put our phones down") are titles, not claims: those lines are dropped. A heading
  // marker is hashes then a space, so "#1 cause of death: …" or a "#MeToo" sentence is still read.
  return text.split(/\n[^\S\n]*\n\s*/).flatMap((paragraph) => {
    const body = paragraph.split(/\n+/).filter((line) => !/^\s*#+(?:\s|$)/.test(line)).join(" ").replace(/\s+/g, " ").trim();
    // Split after . ! ? (and closing quotes) followed by a capital letter or digit, then re-join any piece that ended
    // on an abbreviation.
    const pieces = body.split(/(?<=[.!?]["”’)]?)\s+(?=["“‘(]?[\p{Lu}\p{N}])/u);
    // Pieces are gathered in lists and joined once: only the previous piece is tested (an abbreviation never spans a
    // space), because re-testing or slicing the growing sentence would be quadratic on a page of "Dr. Smith Dr. Smith …".
    const joined: string[][] = [];
    let previous = "";
    for (const piece of pieces) {
      if (joined.length && ABBREVIATION.test(previous)) joined[joined.length - 1].push(piece);
      else joined.push([piece]);
      previous = piece;
    }
    return joined.map((parts) => parts.join(" ").trim()).filter(Boolean);
  });
}

/**
 * The article's checkable sentences, at most `max`, in page order. `minLength` lowers the 40-character floor for a
 * pasted AI answer (supplied-urls.ts suggestedClaim), whose cited sentences can be short.
 */
export function claimCandidates(text: string, max = MAX_CANDIDATES, { minLength = MIN_LENGTH }: { minLength?: number } = {}): ClaimCandidate[] {
  const seen = new Set<string>();
  const scored: Array<ClaimCandidate & { index: number; score: number }> = [];
  sentences(text).forEach((sentence, index) => {
    if (sentence.length < minLength || sentence.length > MAX_LENGTH) return;
    if (/\?["”’)]?$/.test(sentence) || BOILERPLATE.test(sentence) || SELF_DESCRIPTION.some((pattern) => pattern.test(sentence))) return;
    if ((sentence.match(/\p{L}/gu)?.length ?? 0) < 20) return;
    const key = sentence.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (seen.has(key)) return;
    seen.add(key);
    const reasons: string[] = [];
    if (FIGURE.test(sentence)) reasons.push("states a figure");
    if (SOURCED.test(sentence)) reasons.push("credits a source");
    if (!reasons.length) return;
    scored.push({ text: sentence, reasons, index, score: reasons.length * 2 + (reasons.includes("states a figure") ? 1 : 0) });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, max))
    .sort((a, b) => a.index - b.index)
    .map(({ text: candidate, reasons }) => ({ text: candidate, reasons }));
}
