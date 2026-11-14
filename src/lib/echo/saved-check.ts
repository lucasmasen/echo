// echo_check answered from saved runs only: which saved run, if any, answers a claim, and the reply an agent gets.
// Pure: no file access, no network, no setting read. The callers hand in the runs they read from disk (the HTTP route
// src/app/api/echo-check/route.ts and the command line mcp/echo-cli.mjs). The matching rule is the one the MCP tool
// uses (savedMatch in mcp/echo-mcp.mjs), ported word for word; scripts/check-echo-api.mjs holds the two to the same
// answers and the same refusals.
import { echoCheck, type EchoCheck } from "./origin-layer";
import type { EchoAnalysis } from "./types";
import { upstreamHints } from "./upstream";

/** A saved run as its caller read it: the file name and the parsed trace. */
export interface SavedRun {
  file: string;
  analysis: EchoAnalysis;
}

/** How the run got its pages: a Telem-routed search, a Tavily search (every older run), or links someone pasted in. */
export type RoutedBy = "telem" | "tavily" | "links supplied";

/** A name at least half of a run's origins mention in the passage Echo saved, when no page of the run is that source. */
export interface SharedName {
  name: string;
  /** Origins, counted once per publisher, whose saved passage mentions the name. */
  origins_naming_it: number;
  /** Publishers among the run's origins: the "of" beside origins_naming_it. */
  of_origin_publishers: number;
  /** Those origins' names. */
  origin_names: string[];
}

/** What shared_names means, in one sentence. It travels with the field, so a reader who sees a name sees the limit. */
export const SHARED_NAMES_NOTE = "When at least half of a run's origins mention the same name and no page of the run is that source, those origins may share a source that is not among the pages, so num_origins may be too high; the names are found by rule from the saved passages and are a hint to check, not a finding.";

/**
 * The shared-name fields of a reply: shared_names and its note, or nothing when the run has no such name. Only names
 * with no page of the run as their source are listed (upstreamHints' amongPages false). By rule, from the saved text.
 */
export function sharedNames(analysis: Pick<EchoAnalysis, "claim" | "pages" | "roots" | "coPublishedRootGroups">): { shared_names?: SharedName[]; shared_names_note?: string } {
  const names = upstreamHints(analysis)
    .filter((hint) => !hint.amongPages)
    .map((hint) => ({ name: hint.name, origins_naming_it: hint.origins, of_origin_publishers: hint.of, origin_names: hint.originNames }));
  return names.length ? { shared_names: names, shared_names_note: SHARED_NAMES_NOTE } : {};
}

/** What a caller gets for a claim a saved run answers: the echoCheck result plus where it came from. */
export interface SavedCheck extends EchoCheck {
  /** Present when at least half of the origins share a name that no page of the run is the source of: they may share a source. */
  shared_names?: SharedName[];
  /** Present with shared_names: what the field means and what it does not show. */
  shared_names_note?: string;
  /** The claim as the caller worded it. `claim` is the claim the saved run traced. */
  asked: string;
  /** Present when the caller's wording differs from the traced claim by one key word. */
  wording_note?: string;
  /** Present on a links run: it read the supplied links only and searched nothing. */
  scope_note?: string;
  source: "saved run";
  /** When the run was captured (the trace's own timestamp). A saved run is never refreshed. */
  captured: string;
  routed_by: RoutedBy;
  file: string;
}

// Words that do not change which claim is meant: articles, auxiliaries, pronouns and question padding.
const STOP = new Set("a an and are as at be by do does did for from has have how in is it its of on or that the their they them this to was we were what when which who why with you your our my i me he she his her really actually just only true false fact myth".split(" "));

// Number words up to ninety-nine count as their digits ("three-second" = "3-second", "ninety-six" = "96"), so a
// spelled-out figure meets the same-figure rule below. A lone "one" stays a word ("does one lose..."), and so does a
// number word before hundred/thousand/million, which is a different figure.
const SMALL: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const BIG = "(?![\\s-]+(?:hundred|thousand|million|billion|trillion))";
const NUMBER_WORDS = new RegExp(`\\b(${Object.keys(TENS).join("|")})(?:[\\s-]+(${Object.keys(SMALL).slice(0, 9).join("|")}))?\\b${BIG}|\\b(${Object.keys(SMALL).slice(1).join("|")})\\b${BIG}`, "g");

function digits(text: string): string {
  return text.replace(NUMBER_WORDS, (_match: string, tens?: string, unit?: string, small?: string) => String(tens ? TENS[tens] + (unit ? SMALL[unit] : 0) : SMALL[small ?? ""]));
}

/** The words that say which claim is meant: lower case, number words as digits, padding words dropped, plurals folded. */
export function keyWords(text: string): Set<string> {
  return new Set((digits(text.toLowerCase()).replace(/(\d)%/g, "$1 percent").match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !STOP.has(word)).map((word) => (word.length > 4 ? word.replace(/(?:es|s)$/, "") : word)));
}

/**
 * The runs that may answer, newest first. A search question is answered by live search runs only: a "Check these
 * sources" run covers only the links someone supplied, so it answers only a caller who asks for the links run.
 */
function candidates(runs: readonly SavedRun[], kind: "search" | "links"): SavedRun[] {
  return runs
    .filter((run) => run.analysis.mode === "live" && Boolean(run.analysis.sourceCheck) === (kind === "links"))
    .sort((a, b) => b.analysis.createdAt.localeCompare(a.analysis.createdAt));
}

/**
 * A saved run answers a claim only when it is the same claim: the same figures, and the same key words give or take
 * one word that one side leaves out ("we use 10% of our brain" for "Humans use only 10% of their brains"). A claim
 * with a word swapped ("3-month memory", "through your feet", "96 times an hour") shares neither side's full set, so
 * it is refused: a different claim must never be answered from this run's score. Of the runs that match, the closest
 * wording wins, and of those the newest.
 */
export function savedMatch(claim: string, runs: readonly SavedRun[], kind: "search" | "links" = "search"): (SavedRun & { distance: number }) | null {
  const asked = keyWords(claim);
  if (asked.size < 2) return null;
  const numbers = (words: Set<string>) => [...words].filter((word) => /^\d/.test(word));
  let best: (SavedRun & { distance: number }) | null = null;
  for (const entry of candidates(runs, kind)) {
    const have = keyWords(entry.analysis.claim);
    if (numbers(asked).some((number) => !have.has(number)) || numbers(have).some((number) => !asked.has(number))) continue;
    const missingFromAsked = [...have].filter((word) => !asked.has(word)).length;
    const extraInAsked = [...asked].filter((word) => !have.has(word)).length;
    // One side must contain the other, and the smaller side may lack at most one word.
    if ((missingFromAsked && extraInAsked) || missingFromAsked + extraInAsked > 1) continue;
    const distance = missingFromAsked + extraInAsked;
    if (!best || distance < best.distance) best = { ...entry, distance };
  }
  return best;
}

/** How a run got its pages, read from the run itself. A run with any Telem-routed search counts as Telem's. */
export function routedBy(analysis: Pick<EchoAnalysis, "searchAudit" | "sourceCheck">): RoutedBy {
  if (analysis.sourceCheck) return "links supplied";
  return (analysis.searchAudit ?? []).some((entry) => entry.router === "telem") ? "telem" : "tavily";
}

/**
 * The saved run that answers this claim, as the reply an agent gets, or null when no saved run is the same claim.
 * Nothing is searched and nothing is spent: null means "no saved run", never "go and run one".
 */
export function savedCheck(claim: string, runs: readonly SavedRun[], kind: "search" | "links" = "search"): SavedCheck | null {
  const saved = savedMatch(claim, runs, kind);
  if (!saved) return null;
  return {
    ...echoCheck(saved.analysis),
    ...sharedNames(saved.analysis),
    asked: claim,
    ...(saved.distance ? { wording_note: `The saved run traced "${saved.analysis.claim}". Your wording differs by one key word; say which claim was checked.` } : {}),
    ...(kind === "links" ? { scope_note: "This run read only the links someone supplied. It searched nothing, so the counts describe those links and no other page." } : {}),
    source: "saved run",
    captured: saved.analysis.createdAt,
    routed_by: routedBy(saved.analysis),
    file: saved.file,
  };
}

/** The claims a saved run can answer, one wording per claim (the newest run's), for the "no saved run" reply. */
export function savedClaims(runs: readonly SavedRun[], kind: "search" | "links" = "search"): string[] {
  const byWords = new Map<string, string>();
  for (const run of candidates(runs, kind)) {
    const key = [...keyWords(run.analysis.claim)].sort().join(" ");
    if (!byWords.has(key)) byWords.set(key, run.analysis.claim);
  }
  return [...byWords.values()];
}
