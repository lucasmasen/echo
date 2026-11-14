import type { EchoAnalysis } from "./types";

// A deterministic, no-cost check on generated answers: every number an answer
// statement states should appear in a passage it cites. A match does not prove
// the statement; a miss is a strong prompt to inspect the original page.

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

export interface StatedNumber {
  /** Normalized value, e.g. "90" or "4000" or "1.5". */
  value: string;
  percent: boolean;
  /** The text as written, for display. */
  written: string;
  /** For "2.5 million": the figure before its scale word ("2.5"), so either way of writing it matches. */
  unscaled?: string;
}

const SCALES: Record<string, number> = { thousand: 1_000, million: 1_000_000, billion: 1_000_000_000, trillion: 1_000_000_000_000 };

function normalizeValue(raw: string): string {
  const cleaned = raw.replace(/,(?=\d{3}\b)/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? String(parsed) : cleaned;
}

const COMPOUND_NUMBER = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[-\s](one|two|three|four|five|six|seven|eight|nine)\b(?:\s*(%|percent\b|per\s+cent\b))?/giu;

export function statedNumbers(rawText: string): StatedNumber[] {
  const found: StatedNumber[] = [];
  // Compound number words ("ninety-six times") are specific figures, unlike filler such as "one study": keep them.
  const text = rawText.replace(COMPOUND_NUMBER, (written, tens: string, ones: string, percent: string | undefined) => {
    found.push({ value: String(NUMBER_WORDS[tens.toLowerCase()] + NUMBER_WORDS[ones.toLowerCase()]), percent: Boolean(percent), written: written.trim() });
    return " ".repeat(written.length);
  });
  const pattern = /(?<![\p{L}\p{N}.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:(%|percent\b|per\s+cent\b)|(thousand|million|billion|trillion)\b)?|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b(?:\s*(%|percent\b|per\s+cent\b))?/giu;
  for (const match of text.matchAll(pattern)) {
    const digits = match[1];
    const scale = match[3]?.toLowerCase();
    const word = match[4]?.toLowerCase();
    const percent = Boolean(match[2] || match[5]);
    // Spelled-out small numbers are common filler ("one study"); only keep them as percentages.
    if (word && !percent) continue;
    const value = digits ? normalizeValue(digits) : String(NUMBER_WORDS[word!]);
    // "2.5 million" is 2500000, as a page writing "2,500,000" states it.
    if (scale) found.push({ value: String(Math.round(Number(value) * SCALES[scale])), percent, written: match[0].trim(), unscaled: value });
    else found.push({ value, percent, written: match[0].trim() });
  }
  return found;
}

export interface StatementGrounding {
  statementIndex: number;
  text: string;
  sourceIds: string[];
  numbers: string[];
  unmatchedNumbers: string[];
}

/** For each answer statement, lists stated numbers that appear in none of its cited passages. */
export function answerNumberGrounding(analysis: Pick<EchoAnalysis, "answerStatements" | "pages">): StatementGrounding[] {
  const pageById = new Map(analysis.pages.map((page) => [page.id, page] as const));
  return (analysis.answerStatements ?? []).map((statement, statementIndex) => {
    const numbers = statedNumbers(statement.text);
    const cited = statement.sourceIds.map((id) => pageById.get(id)).filter((page) => page !== undefined);
    // A cited page's own publication year counts as stated by that page: only a date read off the page (its text, URL
    // or metadata), never a search estimate or a date with no recorded source.
    const ownYear = (page: (typeof cited)[number]) => (page.publishedDateSource && page.publishedDateSource !== "Tavily estimate" ? page.publishedDate?.slice(0, 4) ?? "" : "");
    const available = cited.flatMap((page) => statedNumbers(`${page.title} ${page.text} ${ownYear(page)}`));
    const forms = (number: StatedNumber) => [number.value, number.unscaled].filter(Boolean);
    // Two figures that both carry a scale word must be the same amount: "2.5 million" is not a page's "2.5 billion".
    const sameAmount = (number: StatedNumber, source: StatedNumber) => !(number.unscaled && source.unscaled) || number.value === source.value;
    const unmatched = numbers.filter((number) => !available.some((source) => forms(number).some((form) => forms(source).includes(form)) && sameAmount(number, source) && (!number.percent || source.percent)));
    return {
      statementIndex,
      text: statement.text,
      sourceIds: statement.sourceIds,
      numbers: [...new Set(numbers.map((number) => number.written))],
      unmatchedNumbers: [...new Set(unmatched.map((number) => number.written))],
    };
  });
}
