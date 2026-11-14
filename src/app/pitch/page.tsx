import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import { engineScorecard, originFlow, type EngineScorecard, type FlowKind, type OriginFlow } from "@/lib/echo/origin-flow";
import { ORIGIN_TYPE_LABELS, originLayer, scoreLabel } from "@/lib/echo/origin-layer";
import { parsePortableTrace } from "@/lib/echo/portable";
import type { EchoAnalysis } from "@/lib/echo/types";
import { upstreamHints, type UpstreamHint } from "@/lib/echo/upstream";
import { foldUpstream, type UpstreamFold, type UpstreamRecord } from "@/lib/echo/upstream-fold";
import { savedUpstreamFor } from "../origin-upstream";
import PitchDeck, { type PitchSlide } from "./pitch-deck";
import styles from "./pitch.module.css";

// The finalist slides, presented from the app. Not linked from anywhere and kept out of search indexes.
export const metadata: Metadata = {
  title: "Echo slides",
  description: "Echo's slides. Every number on them is computed from the saved runs when the page is built.",
  robots: { index: false, follow: false },
};

// The same saved Telem-routed runs /origins shows, read at build time. Opening this page sends no search or model
// request, and nothing in this folder can: it imports the trace reader, the pure origin libraries (flow, layer, the
// shared-name rule and the fold arithmetic) and the look-ups saved ahead of time in origin-upstream-saved.json.
const RUNS: Array<{ key: string; file: string }> = [
  { key: "phones", file: "telem-phones-2026-11-14.echo.json" },
  { key: "heat", file: "telem-body-heat-2026-11-14.echo.json" },
  { key: "brain", file: "telem-brain-2026-11-14.echo.json" },
  { key: "goldfish", file: "telem-goldfish-2026-11-14.echo.json" },
  { key: "startups", file: "telem-startups-2026-11-14.echo.json" },
  { key: "customer", file: "telem-customer-2026-11-14.echo.json" },
  { key: "habit", file: "telem-habit-2026-11-14.echo.json" },
  { key: "attention", file: "telem-attention-2026-11-14.echo.json" },
  { key: "unicorns", file: "telem-unicorns-2026-11-14.echo.json" },
  { key: "energy", file: "telem-chatgpt-energy-2026-11-14.echo.json" },
  { key: "social", file: "telem-social-media-2026-11-14.echo.json" },
  { key: "water", file: "telem-water-2026-11-14.echo.json" },
  { key: "hours", file: "telem-hours-2026-11-14.echo.json" },
  { key: "nonverbal", file: "telem-nonverbal-2026-11-14.echo.json" },
  { key: "dunbar", file: "telem-dunbar-2026-11-14.echo.json" },
  { key: "spiders", file: "telem-spiders-2026-11-14.echo.json" },
];

/** A saved "Check these sources" run (links pasted in, no search): the measured case of checking an answer's citations. */
const LINKS_FILE = "check-these-sources-phones.echo.json";

async function readRun(file: string): Promise<EchoAnalysis | null> {
  try {
    // Scoped to one folder, so the build traces that folder and not the whole project.
    return parsePortableTrace(JSON.parse(await fs.readFile(path.join(process.cwd(), "mcp", "traces", file), "utf8")));
  } catch {
    return null;
  }
}

async function readLinksRun(): Promise<EchoAnalysis | null> {
  try {
    const analysis = parsePortableTrace(JSON.parse(await fs.readFile(path.join(process.cwd(), "public", "demo-traces", LINKS_FILE), "utf8")));
    return analysis && analysis.mode === "live" && analysis.sourceCheck ? analysis : null;
  } catch {
    return null;
  }
}

/** The run Echo got wrong today, the one /origins shows as "A limit Echo hit today". It is outside the folders the other slides read. */
async function readLimitRun(): Promise<EchoAnalysis | null> {
  try {
    return parsePortableTrace(JSON.parse(await fs.readFile(path.join(process.cwd(), "evaluation", "known-limits", "telem-genai-pilots-2026-11-14.echo.json"), "utf8")));
  } catch {
    return null;
  }
}

/** Everything the limit slide shows, computed from the limit run and its saved look-up. */
interface LimitCase {
  claim: string;
  hint: UpstreamHint;
  record: UpstreamRecord;
  fold: UpstreamFold;
  /** True when the score after the fold is still in the top band. */
  stillStrong: boolean;
  /** Origins left standing in whose saved passage the model found no mention of the document. /origins calls the score still too high on the same count. */
  unrelated: number;
  /** Saved look-ups on the deck's other runs that folded no origin. */
  foldedNothing: number;
}

interface DeckRun {
  key: string;
  analysis: EchoAnalysis;
  flow: OriginFlow;
}

function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
}

const SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** A small count as a word ("four"), so a sentence can open with it. Larger counts stay digits. */
function inWords(value: number): string {
  return SMALL_NUMBERS[value] ?? value.toLocaleString("en-US");
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The Pacific calendar day a run was captured, in words, from the run's own timestamp. */
function capturedDay(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
}

/** The year of a page's saved publish date, or null when the run saved none. */
function yearOf(date: string | null): string | null {
  return /^(\d{4})/.exec(date ?? "")?.[1] ?? null;
}

/** The first sentence of Echo's saved answer, with its citation marks ("[1]") taken out. */
function firstSentence(answer: string): string {
  const clean = answer.replace(/\s*\((?:\[\d+\],?\s*)+\)|(?:\s*,?\s*\[\d+\])+/g, "").replace(/\s+/g, " ").trim();
  return /^.*?[.!?](?=\s+["“(]?[A-Z]|$)/.exec(clean)?.[0] ?? clean;
}

const KIND_LABEL: Record<FlowKind, string> = { origin: "Origin page", copy: "Confirmed copy", unplaced: "Not tied to an origin" };
const PILL: Record<FlowKind, string> = { origin: styles.pillOrigin, copy: styles.pillCopy, unplaced: styles.pillUnplaced };

function scoreTone(score: number): string {
  return score > 60 ? styles.toneStrong : score > 30 ? styles.toneMid : styles.toneThin;
}

/** One pill per page the run kept: origin pages first, then confirmed copies, then pages not tied to an origin. */
function PillRow({ flow }: { flow: OriginFlow }) {
  const { counts, pages } = flow;
  return (
    <div className={styles.pillBlock}>
      <div aria-label={`Of the ${count(pages.length, "page", "pages")}: ${count(counts.origin, "origin page", "origin pages")}, ${count(counts.copy, "confirmed copy", "confirmed copies")}, ${counts.unplaced} not tied to an origin`} className={styles.pills} role="img">
        {pages.map((page) => <i className={PILL[page.kind]} key={page.id} title={`${page.domain} · ${KIND_LABEL[page.kind]}`} />)}
      </div>
      <ul aria-hidden="true" className={styles.legend}>
        <li><i className={styles.pillOrigin} />{KIND_LABEL.origin} ({counts.origin})</li>
        <li><i className={styles.pillCopy} />{KIND_LABEL.copy} ({counts.copy})</li>
        <li><i className={styles.pillUnplaced} />{KIND_LABEL.unplaced} ({counts.unplaced})</li>
      </ul>
    </div>
  );
}

function Missing({ what }: { what: string }) {
  return <p className={styles.missing}>The saved {what} run could not be loaded.</p>;
}

/** Slide 1: the tagline and the one line about Telem. */
function TitleSlide({ opening }: { opening: string | null }) {
  return (
    <>
      <p className={styles.kicker}>ECHO · SEARCHHACK</p>
      <h1 className={styles.title}>Search engines count sources. <em>Echo counts origins.</em></h1>
      <p className={styles.oneLine}>Telem tells you which engines answered. <b>Echo tells you whether they told you anything new.</b></p>
      {opening && <p className={styles.foot}>{opening}</p>}
    </>
  );
}

/** Slide 2: the problem, on the phones run. Many pages about a claim, few independent origins behind them. */
function ProblemSlide({ run }: { run: DeckRun }) {
  const layer = run.flow.layer;
  const routed = (run.analysis.searchAudit ?? []).some((entry) => entry.router === "telem");
  const placed = layer.originPages + layer.copies;
  const only = layer.origins.length === 1 ? layer.origins[0] : null;
  const originNote = only ? [only.name, ORIGIN_TYPE_LABELS[only.type], yearOf(only.date)].filter(Boolean).join(" · ") : null;
  return (
    <>
      <p className={styles.kicker}>THE PROBLEM · ONE LIVE RUN{routed ? " THROUGH TELEM" : ""}</p>
      <p className={styles.claim}>“{run.analysis.claim.replace(/\.$/, "")}”</p>
      <h2 className={styles.headline}><b>{layer.results}</b> {layer.results === 1 ? "page" : "pages"} about the claim. <em>{capital(inWords(layer.origins.length))} independent {layer.origins.length === 1 ? "origin" : "origins"}.</em></h2>
      <PillRow flow={run.flow} />
      <ul className={styles.facts}>
        <li className={`${styles.fact} ${styles.toneOrigin}`}>
          <b className={styles.factValue}>{placed}</b>
          <span className={styles.factLabel}>{only ? (placed === 1 ? "page is that origin" : "pages are that origin or lead back to it") : placed === 1 ? "page is an origin" : "pages are an origin or lead back to one"}</span>
          {originNote && <small className={styles.factNote}>{originNote}</small>}
        </li>
        <li className={`${styles.fact} ${styles.toneUnplaced}`}>
          <b className={styles.factValue}>{layer.unplaced}</b>
          <span className={styles.factLabel}>{layer.unplaced === 1 ? "page" : "pages"} Echo could not place</span>
          <small className={styles.factNote}>Echo shows them, and never counts them as copies</small>
        </li>
        <li className={`${styles.fact} ${scoreTone(layer.score)}`}>
          <b className={styles.factValue}>{layer.score}</b>
          <span className={styles.factLabel}>Echo Score</span>
          <small className={styles.factNote}>{layer.label}</small>
        </li>
      </ul>
    </>
  );
}

/** Slide 3: the contrast, on the body-heat run. A strong evidence base, and what that evidence says. */
function ContrastSlide({ run, kicker = "THE CONTRAST · THE SAME CHECK ON ANOTHER CLAIM", punch = <>The score rates the evidence, <em>not the truth.</em></> }: { run: DeckRun; kicker?: string; punch?: React.ReactNode }) {
  const layer = run.flow.layer;
  const evidenced = layer.origins.filter((origin) => origin.ownEvidence).length;
  const sentence = firstSentence(run.analysis.answer);
  // The answer's own opening words, up to its first colon, set in bold. The words are the trace's, unchanged.
  const colon = sentence.indexOf(": ");
  const lead = colon > 0 && colon < 60 ? sentence.slice(0, colon + 1) : "";
  return (
    <>
      <p className={styles.kicker}>{kicker}</p>
      <p className={styles.claim}>“{run.analysis.claim.replace(/\.$/, "")}”</p>
      <div className={styles.split}>
        <div>
          <ul className={styles.facts}>
            <li className={`${styles.fact} ${scoreTone(layer.score)}`}>
              <b className={styles.factValue}>{layer.score}</b>
              <span className={styles.factLabel}>Echo Score</span>
              <small className={styles.factNote}>{layer.label}</small>
            </li>
            <li className={`${styles.fact} ${styles.toneOrigin}`}>
              <b className={styles.factValue}>{layer.origins.length}</b>
              <span className={styles.factLabel}>independent {layer.origins.length === 1 ? "origin" : "origins"}</span>
            </li>
            <li className={`${styles.fact} ${styles.toneOrigin}`}>
              <b className={styles.factValue}>{evidenced}</b>
              <span className={styles.factLabel}>with evidence of {evidenced === 1 ? "its" : "their"} own</span>
            </li>
          </ul>
          <PillRow flow={run.flow} />
        </div>
        {sentence && (
          <blockquote className={styles.answer}>
            <span className={styles.answerLabel}>{run.analysis.answerStatus === "generated" ? "ECHO’S ANSWER, WRITTEN FROM THE ORIGINS ONLY" : "ECHO’S NOTE ON THE ORIGINS"}</span>
            {lead ? <><b>{lead}</b>{sentence.slice(lead.length)}</> : sentence}
          </blockquote>
        )}
      </div>
      <p className={styles.punch}>{punch}</p>
    </>
  );
}

/** The Telem slide: what Telem's per-engine record makes possible. One row per claim, one dot per origin. */
function TelemSlide({ card }: { card: EngineScorecard }) {
  return (
    <>
      <p className={styles.kicker}>WHAT TELEM MAKES POSSIBLE</p>
      <h2 className={styles.headlineSmall}>Telem records which engine returned each page. <em>So Echo can count the engines each claim needed.</em></h2>
      <ul aria-label="How many engines reached each origin" className={card.claimRows.length > 9 ? `${styles.reach} ${styles.reachDense} ${styles.reachTight}` : card.claimRows.length > 5 ? `${styles.reach} ${styles.reachDense}` : styles.reach}>
        {card.claimRows.map((row, at) => (
          <li className={styles.reachRow} key={`${at}-${row.claim}`}>
            <span className={styles.reachClaim}>{row.claim.replace(/\.$/, "")}</span>
            <span className={styles.reachDots}>
              {row.perOrigin.length
                ? row.perOrigin.map((engines, index) => <i className={engines === 1 ? styles.dotLone : styles.dot} key={index} title={`${count(engines, "engine", "engines")} reached this origin`}>{engines}</i>)
                : <em className={styles.reachNone}>no origin</em>}
            </span>
            <span className={styles.reachNeeded}><b>{row.needed}</b> of {row.of} {row.of === 1 ? "engine" : "engines"} needed</span>
          </li>
        ))}
      </ul>
      <p className={styles.totals}>
        <b>{card.claims}</b> {card.claims === 1 ? "claim" : "claims"} · <b>{card.runs}</b> engine {card.runs === 1 ? "run" : "runs"} Telem billed · <b>{card.origins}</b> independent {card.origins === 1 ? "origin" : "origins"} · <b>{card.singleEngineOrigins}</b> with only one engine on record
      </p>
      <p className={styles.note}>One dot per independent origin. The number is how many engines reached it, and amber means only one engine is on record for it. By each run’s record, one run per claim: far too few to rank engines.</p>
    </>
  );
}

/** The limit slide: the run Echo over-counted, the rule that flagged it, and what one more search changed. */
function LimitSlide({ limit }: { limit: LimitCase }) {
  const { fold, hint, record } = limit;
  const folded = fold.folded.length;
  return (
    <>
      <p className={styles.kicker}>WHERE IT BROKE · AND WHAT ECHO DID</p>
      <p className={styles.claim}>“{limit.claim.replace(/\.$/, "")}”</p>
      <ol className={`${styles.facts} ${styles.steps}`}>
        <li className={`${styles.fact} ${styles.toneThin}`}>
          <span className={styles.stepTag}>IT BROKE</span>
          <b className={styles.factValue}>{fold.before.score}</b>
          <span className={styles.factLabel}>Echo counted {count(fold.before.origins, "origin", "origins")} and scored it {fold.before.score}</span>
          <small className={styles.factNote}>Most are write-ups of one report that was not among the pages Echo kept</small>
        </li>
        <li className={`${styles.fact} ${styles.toneUnplaced}`}>
          <span className={styles.stepTag}>A RULE FLAGGED IT</span>
          <b className={styles.factValue}>{hint.origins}<span className={styles.stepOf}> of </span>{hint.of}</b>
          <span className={styles.factLabel}>A rule flagged it: {hint.origins} of {hint.of} publishers mention “{hint.name}”</span>
          <small className={styles.factNote}>No model call</small>
        </li>
        <li className={`${styles.fact} ${styles.toneOrigin}`}>
          <span className={styles.stepTag}>ECHO WENT LOOKING</span>
          <b className={styles.factValue}>{folded}<span className={styles.stepOf}> of </span>{fold.before.origins}</b>
          <span className={styles.factLabel}>Echo went looking through Telem: {folded} of {fold.before.origins} origins fold into the document</span>
          <small className={styles.factNote}>Origins {fold.before.origins} → {fold.after.origins} · score {fold.before.score} → {fold.after.score}</small>
        </li>
      </ol>
      {limit.stillStrong && limit.unrelated > 0 && <p className={styles.punch}>Still too high, <em>and Echo says so.</em></p>}
      <p className={styles.note}>
        {capital(inWords(record.queries.length))} more {record.queries.length === 1 ? "search" : "searches"} and one model call, measured once. The model decides which origins fold.
        {limit.unrelated > 0 ? ` The ${inWords(limit.unrelated)} ${limit.unrelated === 1 ? "origin it left standing is a page" : "origins it left standing are pages"} where the model found no mention of the document.` : ""}
        {record.upstream ? ` The search found a copy of the document at ${record.upstream.domain}.` : ""}
        {limit.foldedNothing > 0 ? ` On the ${inWords(limit.foldedNothing)} other ${limit.foldedNothing === 1 ? "run" : "runs"} with a shared name, the look-up folded nothing.` : ""}
      </p>
    </>
  );
}

// Where the check can be called from today: the echo_check MCP tool, HTTP (GET /api/echo-check) and a command line.
// All three read the same saved runs and refuse a claim that has none; the note under the chips says so.
const CALLS: Array<{ key: string; label: string }> = [
  { key: "mcp", label: "MCP tool" },
  { key: "http", label: "HTTP" },
  { key: "cli", label: "Command line" },
];

// Where the same check fits. Only the first is measured (the saved links check); the slide says so under the chips.
const FITS: Array<{ key: string; label: string }> = [
  { key: "answers", label: "AI answers with citations" },
  { key: "rag", label: "RAG context" },
  { key: "routing", label: "Search routing" },
];

/** The last slide: where the same check goes, who might pay (a guess), and the ask. */
function AskSlide({ links }: { links: { supplied: number; origins: number } | null }) {
  return (
    <>
      <p className={styles.kicker}>ONE CHECK, MORE PLACES</p>
      <h2 className={styles.headlineSmall}>Where it goes, and the ask.</h2>
      <div className={styles.goes}>
        <ul className={styles.lines}>
          <li className={styles.line}>
            <span className={styles.lineTag}>CALL IT</span>
            <b className={styles.lineText}>An agent on this machine can call it today.</b>
            <span className={styles.chips}>{CALLS.map((call) => <span className={styles.chip} key={call.key}>{call.label}</span>)}</span>
            <small className={styles.lineNote}>All three answer a claim that has a saved run, offline, at no cost, and refuse any other claim. A new claim needs a live run in the app, and that spends. Not deployed yet.</small>
          </li>
          <li className={styles.line}>
            <span className={styles.lineTag}>USE IT ON</span>
            <b className={styles.lineText}>The same check applies to any set of pages.</b>
            <span className={styles.chips}>{FITS.map((fit) => <span className={styles.chip} key={fit.key}>{fit.label}</span>)}</span>
            <small className={styles.lineNote}>
              {links ? `Shown on one saved check of ${count(links.supplied, "link", "links")} pasted in by hand: ${count(links.origins, "independent origin", "independent origins")}. Not yet run on a real AI answer’s citations. ` : ""}
              For RAG context, input tokens with one page per origin are measured once on each saved Telem run. Whether a router wants the signal is a question for Telem.
            </small>
          </li>
          <li className={styles.line}>
            <span className={styles.lineTag}>WHO MIGHT PAY</span>
            <b className={styles.lineText}>Who might pay is a guess.</b>
            <small className={styles.lineNote}>My first guess: teams shipping AI answers with citations. Their product shows a row of citations that can be one source, and they cannot tell today. Pricing guess: per check, like the search APIs it sits on. The edge: it needs per-engine provenance, which a router like Telem records. Nobody has been asked yet. That is next week.</small>
          </li>
        </ul>
        <div className={styles.ask}>
          <span className={styles.askTag}>THE ASK</span>
          <p className={styles.askMain}>If you know a team that ships AI answers with citations, introduce me, so I can ask them.</p>
          <p className={styles.askSecond}>And to Telem: would a per-engine origin signal be useful to your router?</p>
          <p className={styles.signoff}>Echo counts origins.</p>
        </div>
      </div>
    </>
  );
}

export default async function Pitch() {
  const loaded = await Promise.all(RUNS.map(async (run) => ({ key: run.key, analysis: await readRun(run.file) })));
  const runs: DeckRun[] = loaded.flatMap(({ key, analysis }) => (analysis && analysis.mode === "live" ? [{ key, analysis, flow: originFlow(analysis) }] : []));
  const phones = runs.find((run) => run.key === "phones") ?? null;
  const heat = runs.find((run) => run.key === "heat") ?? null;
  const startups = runs.find((run) => run.key === "startups") ?? null;
  const card = engineScorecard(runs.map((run) => run.analysis));
  const linksRun = await readLinksRun();
  const supplied = linksRun?.sourceCheck?.urls.length ?? 0;
  const linksCheck = linksRun && supplied > 0 ? { supplied, origins: originFlow(linksRun).origins.length } : null;

  // The limit slide. Left out when the run, the shared name or the saved look-up cannot be read, or nothing folded.
  const limitRun = await readLimitRun();
  const limitHint = limitRun ? upstreamHints(limitRun).filter((hint) => !hint.amongPages)[0] ?? null : null;
  const limitRecord = limitRun ? savedUpstreamFor(limitRun) : null;
  const limitFold = limitRun && limitRecord ? foldUpstream(originLayer(limitRun), limitRecord) : null;
  const foldedNothing = runs.filter((run) => {
    const record = savedUpstreamFor(run.analysis);
    return record !== null && foldUpstream(run.flow.layer, record).folded.length === 0;
  }).length;
  const limit: LimitCase | null = limitRun && limitHint && limitRecord && limitFold && limitFold.folded.length > 0
    ? { claim: limitRun.claim, hint: limitHint, record: limitRecord, fold: limitFold, stillStrong: scoreLabel(limitFold.after.score) === "Strong evidence base", unrelated: limitRecord.origins.filter((origin) => origin.cites === "no").length, foldedNothing }
    : null;

  // The line under the title: how many runs loaded, whether Telem routed every one, and the day(s) they were captured.
  const stamps = runs.map((run) => run.analysis.createdAt).filter((iso) => capturedDay(iso)).sort();
  const firstDay = stamps.length ? capturedDay(stamps[0]) : null;
  const lastDay = stamps.length ? capturedDay(stamps[stamps.length - 1]) : null;
  const when = !firstDay ? "" : firstDay === lastDay ? ` on ${firstDay}` : ` between ${firstDay} and ${lastDay}`;
  const allTelem = runs.length > 0 && runs.every((run) => (run.analysis.searchAudit ?? []).some((entry) => entry.router === "telem"));
  const opening = runs.length ? `${capital(inWords(runs.length))} ${runs.length === 1 ? "claim people repeat, traced live" : "claims people repeat, each traced live"}${allTelem ? " through Telem" : ""}${when}.` : null;

  const slides: PitchSlide[] = [
    { key: "title", label: "Echo counts origins", node: <TitleSlide opening={opening} /> },
    { key: "problem", label: "The problem", node: phones ? <ProblemSlide run={phones} /> : <Missing what="phones" /> },
    { key: "contrast", label: "The contrast", node: heat ? <ContrastSlide run={heat} /> : <Missing what="body heat" /> },
    ...(startups ? [{ key: "repeat", label: "One you may have repeated", node: <ContrastSlide kicker="ONE YOU MAY HAVE REPEATED · TRACED LIVE THROUGH TELEM" punch={<>Echo answers from the origins, <em>not from every page that repeats it.</em></>} run={startups} /> }] : []),
    { key: "telem", label: "What Telem makes possible", node: card && card.claimRows.length ? <TelemSlide card={card} /> : <Missing what="Telem" /> },
    ...(limit ? [{ key: "limit", label: "Where it broke, and what Echo did", node: <LimitSlide limit={limit} /> }] : []),
    { key: "ask", label: "Where it goes, and the ask", node: <AskSlide links={linksCheck} /> },
  ];
  return (
    <main>
      <PitchDeck slides={slides} />
    </main>
  );
}
