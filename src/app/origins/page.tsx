import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { batchRows } from "@/lib/echo/origin-batch";
import { engineScorecard } from "@/lib/echo/origin-flow";
import { originLayer } from "@/lib/echo/origin-layer";
import { parsePortableTrace } from "@/lib/echo/portable";
import { upstreamHints } from "@/lib/echo/upstream";
import { foldUpstream } from "@/lib/echo/upstream-fold";
import { providerDisplayName } from "@/lib/echo/search-providers";
import type { EchoAnalysis } from "@/lib/echo/types";
import { savedComparisonFor } from "../origin-saved";
import { savedUpstreamFor } from "../origin-upstream";
import BatchTable from "./batch-table";
import UpstreamMap from "./upstream-map";
import UseCases from "./use-cases";
import batch from "./batch.module.css";
import OriginShowcase, { type ShowcaseRun } from "./origin-showcase";
import styles from "./origins.module.css";

export const metadata: Metadata = {
  title: "Echo origin layer",
  description: "Search engines count sources. Echo counts origins: how many independent origins stand behind a claim, what kind they are, which search engine found what, and how the wording changed along the way.",
};

// Saved live runs shown here, read at build time (the page is static; opening it sends no search or model request).
// Every one was searched through Telem, so each records which engine returned each page.
const RUNS: Array<{ key: string; label: string; file: string }> = [
  { key: "phones", label: "Phone checks", file: "telem-phones-2026-11-14.echo.json" },
  { key: "heat", label: "Body heat and the head", file: "telem-body-heat-2026-11-14.echo.json" },
  { key: "brain", label: "The brain myth", file: "telem-brain-2026-11-14.echo.json" },
  { key: "goldfish", label: "Goldfish memory", file: "telem-goldfish-2026-11-14.echo.json" },
  { key: "startups", label: "Startups failing", file: "telem-startups-2026-11-14.echo.json" },
  { key: "customer", label: "Cost of a new customer", file: "telem-customer-2026-11-14.echo.json" },
  { key: "habit", label: "Days to form a habit", file: "telem-habit-2026-11-14.echo.json" },
  { key: "attention", label: "Attention span", file: "telem-attention-2026-11-14.echo.json" },
  { key: "unicorns", label: "Becoming a unicorn", file: "telem-unicorns-2026-11-14.echo.json" },
  { key: "energy", label: "ChatGPT and a search", file: "telem-chatgpt-energy-2026-11-14.echo.json" },
  { key: "social", label: "Hours on social media", file: "telem-social-media-2026-11-14.echo.json" },
  { key: "water", label: "Glasses of water", file: "telem-water-2026-11-14.echo.json" },
  { key: "hours", label: "Hours to mastery", file: "telem-hours-2026-11-14.echo.json" },
  { key: "nonverbal", label: "Nonverbal communication", file: "telem-nonverbal-2026-11-14.echo.json" },
  { key: "dunbar", label: "Number of friendships", file: "telem-dunbar-2026-11-14.echo.json" },
  { key: "spiders", label: "Swallowing spiders", file: "telem-spiders-2026-11-14.echo.json" },
];

/** One more tab, kept out of every figure above the tabs: a saved "Check these sources" run (links pasted in, no search). */
const LINKS_RUN = { key: "links", label: "Check a list of links · Nov 13", file: "check-these-sources-phones.echo.json" };

async function readLinksRun(): Promise<EchoAnalysis | null> {
  try {
    const analysis = parsePortableTrace(JSON.parse(await fs.readFile(path.join(process.cwd(), "public", "demo-traces", LINKS_RUN.file), "utf8")));
    return analysis && analysis.mode === "live" && analysis.sourceCheck ? analysis : null;
  } catch {
    return null;
  }
}

/** A Nov 14 run Echo got wrong, shown as a limit. It is in evaluation/known-limits, outside the folders the tabs and the agent tool read. */
async function readLimitRun(): Promise<EchoAnalysis | null> {
  try {
    return parsePortableTrace(JSON.parse(await fs.readFile(path.join(process.cwd(), "evaluation", "known-limits", "telem-genai-pilots-2026-11-14.echo.json"), "utf8")));
  } catch {
    return null;
  }
}

async function readRun(file: string): Promise<EchoAnalysis | null> {
  try {
    // Scoped to one folder, so the build traces that folder and not the whole project.
    return parsePortableTrace(JSON.parse(await fs.readFile(path.join(process.cwd(), "mcp", "traces", file), "utf8")));
  } catch {
    return null;
  }
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

/**
 * Telem's routing across the runs, from each search's saved list of the engines that answered it (searchAudit[].providers;
 * an engine whose run failed is left out of that list, so this counts engines that answered, not engines asked).
 */
function routingOf(analyses: EchoAnalysis[]): { searches: number; min: number; max: number; engines: number } | null {
  const answered = analyses.flatMap((analysis) => (analysis.searchAudit ?? []).flatMap((entry) => (entry.router === "telem" && entry.status === "searched" && entry.providers?.length ? [[...new Set(entry.providers)]] : [])));
  if (!answered.length) return null;
  const sizes = answered.map((providers) => providers.length);
  return { searches: answered.length, min: Math.min(...sizes), max: Math.max(...sizes), engines: new Set(answered.flat()).size };
}

// The ways into Echo shown at the foot of the page. The heading counts this list.
const WAYS: Array<{ key: string; tag: string; title: string; text: string; code?: string; note?: string }> = [
  { key: "app", tag: "THE APP", title: "Trace a claim", text: "Type a claim. Echo traces it through the pages that repeat it, finds the independent origins and answers from those origins only." },
  { key: "links", tag: "AN AI ANSWER", title: "Check its links", text: "Paste an AI answer, or just its links, into Check these sources on the home page. Echo reads exactly those pages and counts the independent origins behind them." },
  {
    key: "mcp",
    tag: "ANY AGENT",
    title: "Call echo_check",
    text: "An MCP tool: an agent asks for a claim’s independent origins before it answers. This line adds it to Claude Code:",
    code: "claude mcp add --scope user echo -- node ~/Projects/echo/mcp/echo-mcp.mjs",
    note: "Run this on the machine in front of you. A claim with a saved run answers offline, at no cost. Any other claim runs only when live mode is switched on, and that run spends.",
  },
  {
    key: "http",
    tag: "ANY FRAMEWORK",
    title: "One HTTP request",
    text: "A plain GET address returns the same check as JSON, so anything that can fetch a web address can call Echo. A JSON-Schema tool definition for function-calling frameworks sits next to it in the repo.",
    code: "GET /api/echo-check?claim={claim+}",
    note: "Add it to the address Echo is running at. This local setup is not deployed. Free and read-only: it answers from saved runs and nothing else, and it cannot start a search or call a model.",
  },
  {
    key: "cli",
    tag: "A TERMINAL",
    title: "One command",
    text: "The same check from the command line, as readable text or as JSON. Handy in a script or a test.",
    code: "node mcp/echo-cli.mjs \"{claim}\"",
    note: "Saved runs only, offline, at no cost.",
  },
];

export default async function Origins() {
  const loaded = await Promise.all(RUNS.map(async (run) => ({ ...run, analysis: await readRun(run.file) })));
  const runs: ShowcaseRun[] = loaded.flatMap(({ key, label, analysis }) => (analysis && analysis.mode === "live" ? [{ key, label, analysis }] : []));
  const card = engineScorecard(runs.map((run) => run.analysis));
  const linksRun = await readLinksRun();
  const limitRun = await readLimitRun();
  const limit = limitRun ? { claim: limitRun.claim, layer: originLayer(limitRun), pages: limitRun.pages.length, shared: upstreamHints(limitRun).filter((hint) => !hint.amongPages)[0] ?? null, looked: (() => {
    // What Echo saved when it went looking for the shared name on this run (npm run origin:upstream), if it has.
    const record = savedUpstreamFor(limitRun);
    return record ? { record, fold: foldUpstream(originLayer(limitRun), record), unrelated: record.origins.filter((origin) => origin.cites === "no").length } : null;
  })() } : null;
  // The claim shown in the HTTP and command-line examples: a saved run, so the line works as printed.
  const exampleClaim = (runs.find((run) => run.key === "habit") ?? runs[0])?.analysis.claim ?? "";
  // The run Echo got wrong is the last tab, marked as such, and stays out of every figure on the page.
  const limitTab: ShowcaseRun[] = limitRun && limitRun.mode === "live" ? [{ key: "limit", label: "Where Echo was wrong", analysis: limitRun, warning: "Echo got this run wrong at first, and it is kept here as a limit. Most of the origins below are separate write-ups of one report that was not among the pages Echo kept, so the score overstates how independent the evidence is. Scroll to “A name the origins share” to see the rule that flags it and what Echo found when it went looking." }] : [];
  const tabs: ShowcaseRun[] = [...runs, ...(linksRun ? [{ key: LINKS_RUN.key, label: LINKS_RUN.label, analysis: linksRun }] : []), ...limitTab];

  // This table is the Nov 14 Telem cohort only. Earlier bundled demos remain available elsewhere with their real dates.
  const batchRuns = loaded.flatMap(({ file, analysis }) => (analysis && analysis.mode === "live" ? [{ file, analysis }] : []));
  const rows = batchRows(batchRuns.map((run) => ({ ...run, comparison: savedComparisonFor(run.analysis) })));
  const batchLede = "One saved Telem run per claim in the Nov 14 cohort. Each row describes what that run found; these are not repeat measurements or a benchmark of engine quality.";

  // The opening sentence: how many runs loaded, whether Telem routed every one, and the day(s) they were captured.
  const stamps = runs.map((run) => run.analysis.createdAt).filter((iso) => capturedDay(iso)).sort();
  const firstDay = stamps.length ? capturedDay(stamps[0]) : null;
  const lastDay = stamps.length ? capturedDay(stamps[stamps.length - 1]) : null;
  const when = !firstDay ? "" : firstDay === lastDay ? ` on ${firstDay}` : ` between ${firstDay} and ${lastDay}`;
  const allTelem = runs.every((run) => (run.analysis.searchAudit ?? []).some((entry) => entry.router === "telem"));
  const opening = `${capital(inWords(runs.length))} ${runs.length === 1 ? "claim people repeat, traced live" : "claims people repeat, each traced live"}${allTelem ? " through Telem" : ""}${when}.`;

  // The saved runs in numbers. Every figure is added up from the loaded traces; none is typed here.
  const layers = runs.map((run) => originLayer(run.analysis));
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const pages = sum(layers.map((layer) => layer.results));
  const originPages = sum(layers.map((layer) => layer.originPages));
  const copies = sum(layers.map((layer) => layer.copies));
  const unplaced = sum(layers.map((layer) => layer.unplaced));
  const origins = sum(layers.map((layer) => layer.origins.length));
  const evidenced = sum(layers.map((layer) => layer.origins.filter((origin) => origin.ownEvidence).length));
  const routing = routingOf(runs.map((run) => run.analysis));
  const billed = card && card.runs > 0 ? card : null;
  const figures: Array<{ key: string; value: number; label: string; note: string; tone?: string }> = [
    { key: "claims", value: runs.length, label: runs.length === 1 ? "claim traced" : "claims traced", note: runs.length === 1 ? "one live run" : "one live run each" },
    ...(billed ? [{ key: "runs", value: billed.runs, label: billed.runs === 1 ? "engine run Telem billed" : "engine runs Telem billed", note: routing ? `for ${count(routing.searches, "search", "searches")}` : "" }] : []),
    { key: "pages", value: pages, label: pages === 1 ? "page about the claims" : "pages about the claims", note: `${count(originPages, "origin page", "origin pages")} · ${count(copies, "confirmed copy", "confirmed copies")} · ${unplaced.toLocaleString("en-US")} not tied to an origin` },
    { key: "origins", value: origins, label: origins === 1 ? "independent origin" : "independent origins", note: `${evidenced.toLocaleString("en-US")} with own evidence`, tone: styles.figureOrigin },
    ...(billed ? [{ key: "lone", value: billed.singleEngineOrigins, label: billed.singleEngineOrigins === 1 ? "origin with one engine on record" : "origins with one engine on record", note: "by these runs’ record: an engine is credited with a page only for the search that first returned it", tone: styles.figureLone }] : []),
  ];

  // One sentence on Telem's routing for the scorecard note.
  const routingLine = routing
    ? `Telem chose the engines for every search: ${routing.min === routing.max ? count(routing.min, "engine", "engines") : `${routing.min} to ${routing.max} engines`} answered ${routing.searches === 1 ? "the one search" : `each of the ${routing.searches} searches`}, ${count(routing.engines, "engine", "engines")} in all. `
    : "";

  // The receipt at the foot: each run's own total (search, page reading and Claude at list price), only when every run has one.
  const totals = runs.map((run) => run.analysis.costReceipt?.usd.total).filter((usd): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd > 0);
  const spent = runs.length > 0 && totals.length === runs.length ? sum(totals) : null;
  const runsBehind = runs.length === 1 ? "The one Telem run behind it" : `The ${inWords(runs.length)} Telem runs behind it`;
  return (
    <main className={styles.page}>
      <Link className={styles.back} href="/">← Echo</Link>
      <p className={styles.kicker}>THE ORIGIN LAYER</p>
      <h1 className={styles.title}>Search engines count sources. <em>Echo counts origins.</em></h1>
      {runs.length > 0 && <p className={styles.lede}>{opening}</p>}
      <ol aria-label="How Echo fits with Telem" className={styles.steps}>
        <li><span>TELEM ROUTES</span><b>Where to look</b><p>Telem picks the search engines for each question and records which engine returned each page. Echo prices each engine run at Telem’s list price.</p></li>
        <li><span>ECHO TRACES</span><b>What was really found</b><p>Echo reads the pages and works out which ones only repeat another, back to the pages it cannot trace to any other page in the run: its independent origins. It re-ranks the results by independence, not relevance: origins first, confirmed copies folded under them, pages it could not place set aside.</p></li>
        <li><span>YOUR AGENT ANSWERS</span><b>From origins, not echoes</b><p>Claude reads one page per origin instead of every page. Fewer tokens, and it can say how much really stands behind the claim.</p></li>
      </ol>
      <p className={styles.oneLine}>Telem tells you which engines answered. <b>Echo tells you whether they told you anything new.</b></p>
      {runs.length > 0 && (
        <ul aria-label="The saved runs in numbers" className={styles.numbers}>
          {figures.map((figure) => (
            <li className={figure.tone} key={figure.key}>
              <b>{figure.value.toLocaleString("en-US")}</b>
              <span>{figure.label}</span>
              {figure.note && <small>{figure.note}</small>}
            </li>
          ))}
        </ul>
      )}
      {runs.length > 0 && <UpstreamMap runs={runs} />}
      {runs.length ? <OriginShowcase runs={tabs} /> : <p className={styles.lede}>No saved run could be loaded.</p>}

      {card && card.claims > 1 && (
        <section aria-label="Engine scorecard" className={styles.scorecard} data-jump="scorecard">
          <p className={styles.kicker}>ENGINE SCORECARD · {card.claims} CLAIMS ROUTED BY TELEM</p>
          <h2 className={styles.scoreTitle}>Across {count(card.claims, "claim", "claims")}, Telem billed {count(card.runs, "engine run", "engine runs")} (about ${card.usd.toFixed(2)} of search) and Echo counted {count(card.origins, "independent origin", "independent origins")}. {count(card.singleEngineOrigins, "of them has", "of them have")} only one engine on record.</h2>
          <p className={styles.lede}>A search router knows which engine answered and what it cost. Echo adds what was in the answers: how many engines reached each independent origin, and how many engines the claim needed. Sometimes more engines return more pages and no further origin Echo could confirm (the phone claim); sometimes an origin shows up through a single engine only (the body-heat claim). Echo can tell a router which case it is in.</p>
          <ul aria-label="How many engines reached each origin" className={styles.reach}>
            {card.claimRows.map((row, index) => (
              <li key={`${index}-${row.claim}`}>
                <span className={styles.reachClaim}>{row.claim}</span>
                <span className={styles.reachDots}>
                  {row.perOrigin.length
                    ? row.perOrigin.map((engines, index) => <i className={engines === 1 ? styles.dotLone : styles.dot} key={index} title={`${count(engines, "engine", "engines")} reached this origin`}>{engines}</i>)
                    : <em>no origin</em>}
                </span>
                <span className={styles.reachNeeded}><b>{row.needed}</b> of {row.of} {row.of === 1 ? "engine" : "engines"} needed</span>
              </li>
            ))}
          </ul>
          <p className={styles.scoreNote}>One dot per independent origin; the number is how many engines returned a page that is the origin or leads back to it. Amber dots have only one engine on record. “Needed” is the fewest engines whose pages together reach every origin of that run, found by trying every set: hindsight on one run, among the engines whose pages Echo kept. The record credits an engine with a page for the search that first returned it, so these figures are what each run recorded, not a limit on what an engine could find.{card.unrecordedOrigins > 0 ? ` ${count(card.unrecordedOrigins, "more origin has", "more origins have")} no engine on record, from a search that did not go through Telem, and ${card.unrecordedOrigins === 1 ? "is" : "are"} not counted or drawn here.` : ""}</p>
          <details className={styles.tableDetails}>
          <summary>Show the per-engine table</summary>
          <div className={styles.tableWrap}>
            <table className={styles.scoreTable}>
              <thead>
                <tr><th scope="col">Engine</th><th scope="col">Claims with a kept page</th><th scope="col">Runs billed</th><th scope="col">Pages Echo kept</th><th scope="col">Origin pages</th><th scope="col">Confirmed copies</th><th scope="col">Not tied to an origin</th><th scope="col">Origins reached</th><th scope="col">Only this engine on record</th></tr>
              </thead>
              <tbody>
                {card.rows.map((row) => (
                  <tr key={row.engine}><th scope="row">{providerDisplayName(row.engine)}</th><td>{row.claims}</td><td>{row.runs}</td><td>{row.pages}</td><td>{row.own}</td><td>{row.copies}</td><td>{row.unplaced}</td><td>{row.origins}</td><td>{row.onlyHere}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          </details>
          <p className={styles.scoreNote}>{routingLine}One live run per claim, all on the same day. That is far too few to rank engines, and the table does not: it shows the measurement Echo adds on top of Telem&apos;s per-engine record. Counts are of the pages Echo kept as about each claim; a page returned by two engines counts for both. “Origins reached” adds up, per claim, the origins an engine&apos;s pages are or lead back to. Costs are the runs&apos; receipts at list price.</p>
        </section>
      )}

      {rows.length > 0 && (
        <section aria-label="November 14 Telem runs" className={batch.card}>
          <p className={batch.kicker}>NOV 14 TELEM RUNS</p>
          <h2 className={batch.title}>{capital(inWords(rows.length))} saved {rows.length === 1 ? "run, one row" : "runs, one row each"}</h2>
          <p className={batch.lede}>{batchLede}</p>
          <p className={batch.lede}>Earlier captures from Nov 10–13 are kept with their original dates in the <Link href="/explore">historical trace gallery</Link>. They are outside this cohort.</p>
          <BatchTable rows={rows} />
        </section>
      )}

      {limit && (
        <section aria-label="A limit Echo hit on November 14" className={styles.scorecard}>
          <p className={styles.kicker}>A LIMIT ECHO HIT · NOV 14</p>
          <h2 className={styles.scoreTitle}>On one more claim, Echo counted origins it should have folded together.</h2>
          <p className={styles.lede}>“{limit.claim}”: from {count(limit.pages, "page", "pages")}, Echo counted {count(limit.layer.origins.length, "independent origin", "independent origins")} and scored the run {limit.layer.score}. Reading the judge’s saved notes, most of those pages are separate write-ups of one report, and that report was not among the {limit.pages} pages Echo kept. With no page to trace them back to, each write-up looked like an origin, so that score overstates how independent the evidence is. Echo’s own answer for the run does name the one report.</p>
          <p className={styles.scoreNote}>This run has its own tab, marked as a limit, and is kept out of every aggregate figure above; the saved run is in evaluation/known-limits. {limit.shared ? ` Echo now flags runs like this by rule: here ${limit.shared.origins} of the ${limit.shared.of} publishers behind those ${limit.layer.origins.length} origins mention “${limit.shared.name}” in the passage Echo saved, and no page in the run comes from a site with that name.` : ""}{limit.looked && limit.looked.fold.folded.length > 0
            ? ` Echo then went looking: one more search through Telem ${limit.looked.record.upstream ? `found a copy of the document at ${limit.looked.record.upstream.domain}` : "found no page that is the document"}, ${limit.looked.fold.folded.length} of the ${limit.looked.fold.before.origins} origins fold into ${limit.looked.record.upstream ? "it" : "one document"}, and the score moves from ${limit.looked.fold.before.score} to ${limit.looked.fold.after.score}. A model judged which origins rest on the document.${limit.looked.unrelated > 0 ? ` It is a first version: ${count(limit.looked.unrelated, "origin it left standing is a page", "origins it left standing are pages")} the model found no mention of the document in, so the adjusted score is still too high.` : " It is a first version."}`
            : " The full fix is to fetch the document those pages cite and trace to it. That is not built yet."}</p>
        </section>
      )}
      <UseCases links={linksRun} linksLabel={LINKS_RUN.label} runs={runs} />
      <section aria-label="Ways to use Echo" className={styles.ways}>
        <p className={styles.kicker}>USE IT</p>
        <h2 className={styles.waysTitle}>{capital(inWords(WAYS.length))} ways into Echo</h2>
        <ul>
          {WAYS.map((way) => (
            <li key={way.key}>
              <span>{way.tag}</span>
              <b>{way.title}</b>
              <p>{way.text}</p>
              {way.code ? <code className={styles.install}>{way.code.replace("{claim+}", encodeURIComponent(exampleClaim).replace(/%20/g, "+")).replace("{claim}", exampleClaim)}</code> : <Link className={styles.wayLink} href="/">Open Echo →</Link>}
              {way.note && <small>{way.note}</small>}
            </li>
          ))}
        </ul>
      </section>

      <p className={styles.receipt}>
        This page sent no search and no model request.
        {spent !== null
          ? ` ${runsBehind} cost about $${spent.toFixed(2)} in all: search${allTelem ? " through Telem" : ""}, page reading and Claude, at list price from each run’s own receipt.`
          : billed
            ? ` The Telem searches of the saved runs behind it cost about $${billed.usd.toFixed(2)} at list price. That is the search cost only.`
            : ""}
      </p>
    </main>
  );
}
