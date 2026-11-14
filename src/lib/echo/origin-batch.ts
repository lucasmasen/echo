import { originFlow } from "./origin-flow";
import { comparePrompts, originLayer, type ScoreLabel, type TokenComparison } from "./origin-layer";
import type { EchoAnalysis } from "./types";
import { upstreamHints } from "./upstream";

// Echo over a list of claims: one flat row per saved run, for a table and a CSV. Every figure comes from originLayer,
// originFlow, comparePrompts and upstreamHints on the saved trace. Nothing here reads a file, calls a model or touches the network,
// so a batch of any size costs nothing to tabulate.

export type BatchKind = "claim traced" | "links checked";
export type BatchSearch = "Telem" | "Tavily" | "links supplied, no search";

export interface BatchRun {
  /** The saved run's file name. It is the row's key: one claim can have several runs. */
  file: string;
  analysis: EchoAnalysis;
  /** A token comparison measured ahead of time, if the caller has one saved. Used only when it is of exactly this run. */
  comparison?: Pick<TokenComparison, "claim" | "traceCreatedAt" | "reductionPct"> | null;
}

export interface BatchRow {
  file: string;
  claim: string;
  kind: BatchKind;
  searchedThrough: BatchSearch;
  /** When the run was captured (ISO, UTC), from the trace. */
  captured: string;
  /** Pages Echo kept as about the claim. Always originPages + confirmedCopies + notTied. */
  pages: number;
  originPages: number;
  confirmedCopies: number;
  notTied: number;
  /** Of the notTied pages: those where Echo saw a possible link to an origin and could not confirm it. Not copies. */
  possibleLinks: number;
  origins: number;
  originsWithOwnEvidence: number;
  publishers: number;
  /** Rates the evidence base this run found (0 to 100). Not a truth rating. */
  echoScore: number;
  label: ScoreLabel;
  /**
   * Telem-routed runs only (null otherwise). Engines that answered a search of the run or were billed on it, by the
   * run's record. The trace keeps the engines that answered, not the engines Telem asked, so this is not "engines asked".
   */
  enginesAnswered: number | null;
  /** Telem-routed runs only. Engines that returned at least one page Echo kept: the "of M" beside enginesNeeded. */
  enginesWithKeptPage: number | null;
  /** Telem-routed runs only. Fewest engines whose pages together reach every origin (originFlow's needed). Hindsight on one run. */
  enginesNeeded: number | null;
  /**
   * The name at least half of the run's origins mention in the passage Echo saved, when no page of the run is that
   * source (upstreamHints' first hint with amongPages false). Null when there is none. A hint that the origins may
   * share a source, found by rule: then the origin count is an upper bound. Not a finding.
   */
  sharedName: string | null;
  /** With sharedName: origins, counted once per publisher, whose saved passage mentions it. Null without one. */
  sharedNameOrigins: number | null;
  /** With sharedName: publishers among the run's origins, the "of" beside sharedNameOrigins. Null without one. */
  sharedNameOf: number | null;
  /** Searches that ran (a links check runs none). */
  searchesRun: number;
  /** Length in characters of the prompt that carries every page, and of the one that carries one page per origin. */
  promptCharsEveryPage: number;
  promptCharsOriginsOnly: number;
  /** Whole percent fewer characters in the origins-only prompt. Null when the run has no origin to answer from. */
  promptShorterPct: number | null;
  /** Whole percent fewer input tokens, as measured by a saved comparison of exactly this run. Null when none is saved. */
  measuredTokenReductionPct: number | null;
}

/** Whole percent by which the origins-only prompt is shorter (negative when it is longer). */
export function promptShorterPct(everyPage: number, originsOnly: number): number {
  return everyPage > 0 ? Math.round(100 * (1 - originsOnly / everyPage)) : 0;
}

const ENGINE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** One serialisable row per run, in the order given. Pure: the same runs always give the same rows. */
export function batchRows(runs: BatchRun[]): BatchRow[] {
  return runs.map(({ file, analysis, comparison }) => {
    const layer = originLayer(analysis);
    const flow = originFlow(analysis);
    const prompts = comparePrompts(analysis);
    const audit = analysis.searchAudit ?? [];
    const routed = audit.some((entry) => entry.router === "telem");
    // Engine figures need the run's own record of which engine returned which page: only a Telem-routed run has one.
    const recorded = flow.engines.length > 0;
    const answered = new Set([
      ...audit.flatMap((entry) => (entry.router === "telem" ? (entry.providers ?? []).filter((name) => typeof name === "string" && ENGINE_NAME.test(name)) : [])),
      ...Object.keys(flow.bill?.runsByEngine ?? {}),
    ]);
    const shared = upstreamHints(analysis).find((hint) => !hint.amongPages) ?? null;
    const measured = comparison && comparison.claim === analysis.claim && comparison.traceCreatedAt === analysis.createdAt && Number.isFinite(comparison.reductionPct) ? comparison.reductionPct : null;
    return {
      file,
      claim: analysis.claim,
      kind: analysis.sourceCheck ? "links checked" : "claim traced",
      searchedThrough: analysis.sourceCheck ? "links supplied, no search" : routed ? "Telem" : "Tavily",
      captured: analysis.createdAt,
      pages: layer.results,
      originPages: layer.originPages,
      confirmedCopies: layer.copies,
      notTied: layer.unplaced,
      possibleLinks: flow.pages.filter((page) => page.possibleOriginId !== null).length,
      origins: layer.origins.length,
      originsWithOwnEvidence: layer.origins.filter((origin) => origin.ownEvidence).length,
      publishers: layer.entities,
      echoScore: layer.score,
      label: layer.label,
      enginesAnswered: recorded ? answered.size : null,
      enginesWithKeptPage: recorded ? flow.engines.length : null,
      enginesNeeded: flow.needed && flow.needed.needed > 0 ? flow.needed.needed : null,
      sharedName: shared ? shared.name : null,
      sharedNameOrigins: shared ? shared.origins : null,
      sharedNameOf: shared ? shared.of : null,
      searchesRun: audit.filter((entry) => entry.status === "searched").length,
      promptCharsEveryPage: prompts.naive.length,
      promptCharsOriginsOnly: prompts.echo.length,
      promptShorterPct: layer.origins.length ? promptShorterPct(prompts.naive.length, prompts.echo.length) : null,
      measuredTokenReductionPct: measured,
    };
  });
}

/** A claim that was traced in more than one run, with the lowest and highest score those runs gave it. */
export interface BatchSpread {
  claim: string;
  runs: number;
  low: number;
  high: number;
}

/**
 * The traced claim whose runs disagree most on the score, or null when no claim has two runs with different scores.
 * Runs are matched on the claim's words (case and punctuation aside). A links check is not a trace and is left out.
 */
export function batchSpread(rows: BatchRow[]): BatchSpread | null {
  const groups = new Map<string, BatchRow[]>();
  for (const row of rows) {
    if (row.kind !== "claim traced") continue;
    const key = row.claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  let best: BatchSpread | null = null;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const scores = group.map((row) => row.echoScore);
    const low = Math.min(...scores);
    const high = Math.max(...scores);
    if (high > low && (!best || high - low > best.high - best.low)) best = { claim: group[0].claim, runs: group.length, low, high };
  }
  return best;
}

/** What a sentence above the table may say about the rows: counts only, each one added up from the rows. */
export interface BatchSummary {
  runs: number;
  telem: number;
  tavily: number;
  links: number;
  /** True when every Tavily-searched run was captured on an earlier Pacific day than every Telem-routed run. */
  tavilyEarlier: boolean;
  /** Runs with a measured token comparison saved. */
  measured: number;
  spread: BatchSpread | null;
}

/** The Pacific calendar day of a timestamp as YYYY-MM-DD (sorts as text), or "" when it does not parse. */
function pacificDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function batchSummary(rows: BatchRow[]): BatchSummary {
  const days = (search: BatchSearch) => rows.filter((row) => row.searchedThrough === search).map((row) => pacificDay(row.captured));
  const telemDays = days("Telem");
  const tavilyDays = days("Tavily");
  const firstTelem = [...telemDays].sort()[0];
  return {
    runs: rows.length,
    telem: telemDays.length,
    tavily: tavilyDays.length,
    links: rows.filter((row) => row.kind === "links checked").length,
    tavilyEarlier: tavilyDays.length > 0 && telemDays.length > 0 && Boolean(firstTelem) && tavilyDays.every((day) => day !== "" && day < firstTelem),
    measured: rows.filter((row) => row.measuredTokenReductionPct !== null).length,
    spread: batchSpread(rows),
  };
}

// The CSV's columns, in order. The headers are plain snake_case so the file loads straight into a notebook.
export const BATCH_COLUMNS: Array<{ key: keyof BatchRow; header: string }> = [
  { key: "file", header: "run_file" },
  { key: "claim", header: "claim" },
  { key: "kind", header: "kind" },
  { key: "searchedThrough", header: "searched_through" },
  { key: "captured", header: "captured_utc" },
  { key: "pages", header: "pages" },
  { key: "originPages", header: "origin_pages" },
  { key: "confirmedCopies", header: "confirmed_copies" },
  { key: "notTied", header: "not_tied_to_an_origin" },
  { key: "possibleLinks", header: "possible_links_not_confirmed" },
  { key: "origins", header: "independent_origins" },
  { key: "originsWithOwnEvidence", header: "origins_with_own_evidence" },
  { key: "publishers", header: "publishers" },
  { key: "echoScore", header: "echo_score" },
  { key: "label", header: "label" },
  { key: "enginesAnswered", header: "engines_answered" },
  { key: "enginesWithKeptPage", header: "engines_with_a_kept_page" },
  { key: "enginesNeeded", header: "engines_needed" },
  { key: "sharedName", header: "name_most_origins_share" },
  { key: "sharedNameOrigins", header: "origins_naming_it" },
  { key: "sharedNameOf", header: "of_origin_publishers" },
  { key: "searchesRun", header: "searches_run" },
  { key: "promptCharsEveryPage", header: "prompt_chars_every_page" },
  { key: "promptCharsOriginsOnly", header: "prompt_chars_origins_only" },
  { key: "promptShorterPct", header: "prompt_shorter_pct" },
  { key: "measuredTokenReductionPct", header: "measured_input_token_reduction_pct" },
];

/**
 * One CSV cell. Null is an empty cell; a number is written as it is. Text that holds a comma, a quote or a line break
 * is quoted, with each quote doubled. Text that starts like a spreadsheet formula (= + - @, a tab or a return) gets a
 * leading apostrophe, so a claim somebody typed cannot run as a formula when the file is opened.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The rows as CSV text: a header line, then one record per row, separated by CRLF (RFC 4180). No trailing line break. */
export function batchCsv(rows: BatchRow[]): string {
  const header = BATCH_COLUMNS.map((column) => csvCell(column.header)).join(",");
  return [header, ...rows.map((row) => BATCH_COLUMNS.map((column) => csvCell(row[column.key])).join(","))].join("\r\n");
}
