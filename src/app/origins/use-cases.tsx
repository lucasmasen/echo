import type { ReactNode } from "react";
import { originFlow } from "@/lib/echo/origin-flow";
import { comparePrompts, originLayer, ORIGIN_TYPE_LABELS } from "@/lib/echo/origin-layer";
import type { EchoAnalysis } from "@/lib/echo/types";
import { savedComparisonFor } from "../origin-saved";
import styles from "./use-cases.module.css";

// "Where the same check applies" on /origins: kinds of work the origin check fits, each shown with one figure from a
// saved run that is on this page. A server component: it reads the analyses it is handed and nothing else. It sends no
// request and cannot: the two libraries it imports are pure (no model call, no network). Every number below is computed
// from the saved runs in an expression; none is typed. A run that is missing leaves its card out.

export interface UseCaseRun {
  key: string;
  label: string;
  analysis: EchoAnalysis;
}

interface UseCard {
  key: string;
  /** The kind of work, in capitals. */
  kind: string;
  /** Who does that work. A guess at where the check fits: nobody has been asked. */
  who: string;
  /** When someone would reach for the check. */
  moment: string;
  /** What Echo hands back: one sentence around figures from a saved run. */
  back: ReactNode;
  /** The first sentence of what Echo itself wrote on the run (its answer, or its note when the origins are too thin). */
  quote?: EchoSaid;
  /** What the figure does and does not say. */
  fine: string;
  /** The tab label of each run the figure comes from. */
  seen: string[];
}

const SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** A small count as a word ("six"). Larger counts stay digits. */
function inWords(value: number): string {
  return SMALL_NUMBERS[value] ?? value.toLocaleString("en-US");
}

function num(value: number): string {
  return value.toLocaleString("en-US");
}

function count(value: number, one: string, many: string): string {
  return `${num(value)} ${value === 1 ? one : many}`;
}

/** The first sentence of a saved Echo answer, with its citation marks ("[1]") taken out. */
function firstSentence(answer: string): string {
  const clean = answer.replace(/\s*\((?:\[\d+\],?\s*)+\)|(?:\s*,?\s*\[\d+\])+/g, "").replace(/\s+/g, " ").trim();
  // A sentence ends at ". " before a capital, or at the end. A very short first piece ("U.S.") is not a sentence yet.
  for (const end of clean.matchAll(/[.!?]["”’)]?(?=\s+[\p{Lu}"“]|$)/gu)) {
    const stop = (end.index ?? 0) + end[0].length;
    if (stop >= 40) return clean.slice(0, stop);
  }
  return clean;
}

interface EchoSaid {
  label: string;
  text: string;
}

/** What Echo wrote on a run, as the trace saved it: the first sentence of its answer, or of its note when it would not answer. */
function echoSaid(analysis: EchoAnalysis): EchoSaid | undefined {
  const text = analysis.answerStatus === "generated" || analysis.answerStatus === "source-limited" ? firstSentence(analysis.answer) : "";
  if (!text) return undefined;
  return { label: analysis.answerStatus === "generated" ? "FIRST SENTENCE OF ECHO’S ANSWER, WRITTEN FROM THE ORIGINS ONLY" : "ECHO’S NOTE: THE ORIGINS ARE TOO THIN TO ANSWER FROM", text };
}

/** 1. An AI answer's citations: the saved "Check these sources" run (links pasted in, no search). */
function citationsCard(links: EchoAnalysis | null, label: string): UseCard | null {
  if (!links || !links.pages.length) return null;
  const layer = originLayer(links);
  const origins = layer.origins.length;
  const linkWord = layer.results === 1 ? "link" : "links";
  return {
    key: "citations",
    kind: "AI ANSWERS WITH CITATIONS",
    who: "Answer engines, support bots, research copilots",
    moment: "An answer shows a row of citations. Are they separate sources, or one source repeated?",
    back: origins
      ? <><b>{num(layer.results)}</b> pasted {linkWord}, <b>{num(origins)}</b> independent {origins === 1 ? "origin" : "origins"}.</>
      : <><b>{num(layer.results)}</b> pasted {linkWord}, and none that Echo could confirm as an independent origin.</>,
    fine: `No AI answer produced these links. They were pasted in by hand, the way you would paste the citations under an answer: ${count(layer.originPages, "origin page", "origin pages")}, ${count(layer.copies, "confirmed copy", "confirmed copies")}, ${num(layer.unplaced)} not tied to an origin.${layer.originPages > origins && origins > 0 ? " Pages that published the same text together count as one origin." : ""}`,
    seen: [label],
  };
}

/** The two prompts comparePrompts builds for one run, by length. Null when the run has no origin or nothing gets shorter. */
function promptSize(run: UseCaseRun): { key: string; label: string; before: number; after: number; pct: number; pages: number; origins: number } | null {
  const prompts = comparePrompts(run.analysis);
  const before = prompts.naive.length;
  const after = prompts.echo.length;
  if (!prompts.echoPages || !before || after >= before) return null;
  return { key: run.key, label: run.label, before, after, pct: Math.round((1 - after / before) * 100), pages: prompts.naivePages, origins: prompts.echoPages };
}

/** 2. Context for a model: every page in the prompt, or one page per origin. Measured input tokens where a comparison is saved, else prompt size. */
function contextCard(runs: UseCaseRun[]): UseCard | null {
  // Measured comparisons (Claude's own usage figures, one measurement per run), saved by "npm run origin:compare".
  const measured = runs.flatMap((run) => {
    const saved = savedComparisonFor(run.analysis);
    return saved && saved.reductionPct > 0 ? [{ key: run.key, label: run.label, before: saved.naive.inputTokens, after: saved.echo.inputTokens, pct: saved.reductionPct, pages: saved.naive.pagesInContext, origins: saved.echo.pagesInContext }] : [];
  });
  if (measured.length) {
    const lead = measured.find((entry) => entry.key === "phones") ?? measured[0];
    const low = Math.min(...measured.map((entry) => entry.pct));
    const high = Math.max(...measured.map((entry) => entry.pct));
    return {
      key: "context",
      kind: "RAG AND AGENT CONTEXT",
      who: "Retrieval pipelines, agents that read search results",
      moment: "Search results are about to go into a model’s prompt. Which pages say something of their own?",
      back: low === high ? <><b>{high}%</b> fewer input tokens with one page per origin.</> : <><b>{low}%</b> to <b>{high}%</b> fewer input tokens with one page per origin.</>,
      fine: `Measured once on each of ${count(measured.length, "run", "runs")} here, with the model’s own token counts. ${lead.label}: ${num(lead.before)} input tokens for ${count(lead.pages, "page", "pages")}, ${num(lead.after)} for ${count(lead.origins, "origin", "origins")}. The shorter prompt leaves out the confirmed copies and the pages Echo could not tie to an origin, and it tells the model what Echo found, so this is not a blind test.`,
      seen: [lead.label],
    };
  }
  const sized = runs.flatMap((run) => promptSize(run) ?? []);
  const lead = sized.find((size) => size.key === "phones") ?? sized[0];
  if (!lead) return null;
  return {
    key: "context",
    kind: "RAG AND AGENT CONTEXT",
    who: "Retrieval pipelines, agents that read search results",
    moment: "Search results are about to go into a model’s prompt. Which pages say something of their own?",
    back: <>The prompt is <b>{lead.pct}%</b> shorter with one page per origin.</>,
    fine: `${lead.label}: ${num(lead.before)} characters for ${count(lead.pages, "page", "pages")}, ${num(lead.after)} for ${count(lead.origins, "origin", "origins")}. Prompt size in characters, not tokens.`,
    seen: [lead.label],
  };
}

/** 3. Search routing: the fewest engines whose pages reach every origin of a run, on two runs that differ. */
function routingCard(runs: UseCaseRun[]): UseCard | null {
  const routed = runs.flatMap((run) => {
    const needed = originFlow(run.analysis).needed;
    return needed && needed.of > 1 && needed.needed > 0 ? [{ key: run.key, label: run.label, needed: needed.needed, of: needed.of }] : [];
  });
  const first = routed.find((row) => row.key === "phones") ?? routed[0];
  if (!first) return null;
  const rest = routed.filter((row) => row.key !== first.key);
  const second = rest.find((row) => row.key === "heat") ?? rest[0] ?? null;
  return {
    key: "routing",
    kind: "SEARCH ROUTING AND META-SEARCH",
    who: "The Telem case: a router that picks engines for each query",
    moment: "A router sent a claim’s searches to several engines. In hindsight, how many of them did the origins need?",
    back: second
      ? <><b>{first.needed} of {first.of}</b> engines needed for {first.label}. <b>{second.needed} of {second.of}</b> for {second.label}.</>
      : <><b>{first.needed} of {first.of}</b> engines needed for {first.label}.</>,
    fine: `By ${second ? "each" : "this"} run’s record, which credits an engine with a page only for the search that first returned it. Needed is the fewest engines whose pages together reach every origin Echo counted. One run per claim, so this does not rank the engines.`,
    seen: second ? [first.label, second.label] : [first.label],
  };
}

/** 4. A number that is everywhere: how many of the pages lead back to one origin, and what kind of page that origin is. */
function newsroomCard(runs: UseCaseRun[]): UseCard | null {
  const run = runs.find((entry) => entry.key === "phones");
  if (!run) return null;
  const layer = originLayer(run.analysis);
  if (!layer.origins.length) return null;
  const placed = layer.originPages + layer.copies;
  const only = layer.origins.length === 1 ? layer.origins[0] : null;
  const year = only?.date && /^\d{4}/.test(only.date) ? only.date.slice(0, 4) : null;
  const type = only && only.type !== "unknown" ? ORIGIN_TYPE_LABELS[only.type].toLowerCase() : "origin";
  const leftOut = layer.unplaced > 0 ? `Echo could not place the other ${num(layer.unplaced)}, and it says so. ` : "";
  return {
    key: "newsroom",
    kind: "NEWSROOMS, COMMS AND PR",
    who: "Reporters, editors, communications teams",
    moment: "A number is everywhere. Before repeating it: where did it start, and who published it?",
    back: only
      ? <><b>{num(placed)} of {num(layer.results)}</b> pages lead back to one {type}{year ? ` from ${year}` : ""} ({only.name}).</>
      : <><b>{num(placed)} of {num(layer.results)}</b> pages lead back to <b>{num(layer.origins.length)}</b> independent origins.</>,
    quote: echoSaid(run.analysis),
    fine: `${leftOut}${only ? "The origin’s type is read by rule from its address and passage." : "Origin types are read by rule from each page’s address and passage."}`,
    seen: [run.label],
  };
}

/** 5. A statistic on its way into a memo: the origins Echo confirmed, and how many show evidence of their own. */
function diligenceCard(runs: UseCaseRun[]): UseCard | null {
  // A business claim when the page has one (it is what goes in a memo), else the brain run.
  const run = runs.find((entry) => entry.key === "startups") ?? runs.find((entry) => entry.key === "customer") ?? runs.find((entry) => entry.key === "brain");
  if (!run) return null;
  const layer = originLayer(run.analysis);
  const origins = layer.origins.length;
  if (!origins) return null;
  const evidenced = layer.origins.filter((origin) => origin.ownEvidence).length;
  return {
    key: "diligence",
    kind: "ANALYSTS AND DUE DILIGENCE",
    who: "Research notes, investment memos, pitch decks",
    moment: "A statistic is about to go in a memo or a deck. How much stands behind it?",
    back: <>Echo counted <b>{num(origins)}</b> independent {origins === 1 ? "origin" : "origins"}, <b>{num(evidenced)}</b> with evidence of {evidenced === 1 ? "its" : "their"} own.</>,
    quote: echoSaid(run.analysis),
    fine: `Echo kept ${count(layer.results, "page", "pages")} about the claim${layer.unplaced > 0 ? ` and could not tie ${num(layer.unplaced)} of them to an origin` : ""}. Echo Score ${layer.score}, “${layer.label}”. The score rates what this run found, not whether the claim is true.`,
    seen: [run.label],
  };
}

/** 6. Content review: the score rates the evidence base, and Echo's own answer says which way that evidence points. */
function reviewCard(runs: UseCaseRun[]): UseCard | null {
  const run = runs.find((entry) => entry.key === "heat");
  if (!run) return null;
  const layer = originLayer(run.analysis);
  const origins = layer.origins.length;
  if (!origins) return null;
  const evidenced = layer.origins.filter((origin) => origin.ownEvidence).length;
  return {
    key: "review",
    kind: "HEALTH AND POLICY CONTENT REVIEW",
    who: "Health, science and policy writing before it goes out",
    moment: "A familiar claim is about to be published. Is there real evidence on it, and which way does it point?",
    back: <>Echo Score <b>{layer.score}</b>: <b>{num(origins)}</b> independent {origins === 1 ? "origin" : "origins"}, <b>{num(evidenced)}</b> with evidence of {evidenced === 1 ? "its" : "their"} own.</>,
    quote: echoSaid(run.analysis),
    fine: layer.label === "Strong evidence base"
      ? "A strong evidence base can point against a claim. The score rates the evidence, whichever way it points. It is not a truth rating."
      : `“${layer.label}” describes the evidence, whichever way it points. The score is not a truth rating.`,
    seen: [run.label],
  };
}

/**
 * The section. `runs` are the Telem-routed runs of the page (found by key: "phones", "heat", "brain", "goldfish"),
 * `links` is the saved links check or null, and `linksLabel` is the name of its tab.
 */
export default function UseCases({ runs, links, linksLabel = "Check an answer’s links" }: { runs: UseCaseRun[]; links: EchoAnalysis | null; linksLabel?: string }) {
  // A links check handed in with the runs is not a search run: it has its own card and stays out of the others.
  const searched = runs.filter((run) => !run.analysis.sourceCheck);
  const cards = [citationsCard(links, linksLabel), contextCard(searched), routingCard(searched), newsroomCard(searched), diligenceCard(searched), reviewCard(searched)].filter((card): card is UseCard => card !== null);
  if (!cards.length) return null;
  return (
    <section aria-label="Where the same check applies" className={styles.uses} data-jump="uses">
      <p className={styles.kicker}>WHERE THE SAME CHECK APPLIES</p>
      <h2 className={styles.title}>One check, {inWords(cards.length)} {cards.length === 1 ? "kind" : "kinds"} of work.</h2>
      <p className={styles.lede}>The check is the same every time: take a set of pages, work out which ones only repeat another, and count the independent origins that are left. Each card shows what that gave on a saved run from this page.</p>
      <ul className={styles.grid}>
        {cards.map((card) => (
          <li className={styles.card} key={card.key}>
            <span className={styles.kind}>{card.kind}</span>
            <small className={styles.who}>{card.who}</small>
            <p className={styles.moment}><span>THE MOMENT</span>{card.moment}</p>
            <div className={styles.back}>
              <span>WHAT ECHO HANDS BACK</span>
              <p className={styles.figure}>{card.back}</p>
              {card.quote && <blockquote className={styles.quote}><span>{card.quote.label}</span>{card.quote.text}</blockquote>}
              <p className={styles.fine}>{card.fine}</p>
            </div>
            <p className={styles.seen}>Seen above in {card.seen.map((label) => <b key={label}>{label}</b>)}</p>
          </li>
        ))}
      </ul>
      <p className={styles.note}>These are the kinds of work I think this check applies to. Each one is shown with a real saved run from this page, and every figure is computed from that run. Nobody has been asked to pay for it yet.</p>
    </section>
  );
}
