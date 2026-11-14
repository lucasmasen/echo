"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { originFlow } from "@/lib/echo/origin-flow";
import { originLayer } from "@/lib/echo/origin-layer";
import type { EchoAnalysis } from "@/lib/echo/types";
import OriginGraphic from "../origin-graphic";
import { savedComparisonFor } from "../origin-saved";
import styles from "./origins.module.css";

export interface ShowcaseRun {
  key: string;
  label: string;
  analysis: EchoAnalysis;
  /** Shown as a banner at the top of the run, for a run Echo got wrong and keeps as a limit. */
  warning?: string;
}

function capturedOn(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
}

const SHOWN = 8;

const JUMPS: Array<{ id: string; label: string }> = [
  { id: "score", label: "Score" },
  { id: "flow", label: "Flow" },
  { id: "upstream", label: "Shared name" },
  { id: "engines", label: "Engines" },
  { id: "searches", label: "Searches" },
  { id: "wording", label: "Wording" },
  { id: "tokens", label: "Tokens" },
  { id: "scorecard", label: "All claims" },
  { id: "uses", label: "Where it applies" },
];

// Inline so the bar needs no rule in the page stylesheet. It sticks to the top of the window while a run is on screen.
const JUMP_BAR: CSSProperties = { position: "sticky", top: 0, zIndex: 5, display: "flex", flexWrap: "wrap", gap: 6, margin: "-10px -8px 14px", padding: "8px", borderRadius: 12, background: "rgba(255, 254, 250, 0.94)", backdropFilter: "blur(6px)" };
const JUMP_BUTTON: CSSProperties = { minHeight: 28, padding: "0 12px", border: "1px solid #d6e4da", borderRadius: 14, background: "#fffefa", color: "#35524a", fontSize: 12, fontWeight: 650, cursor: "pointer" };

/** A row of buttons that scroll to a section of the run on screen. It reads no address and changes none. */
function JumpBar({ runKey }: { runKey: string }) {
  const [present, setPresent] = useState<string[]>([]);
  // Which sections this run has (a run with one engine has no engine block, and so on), read after it is drawn.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setPresent(JUMPS.filter((jump) => document.querySelector(`[data-jump="${jump.id}"]`)).map((jump) => jump.id)));
    return () => cancelAnimationFrame(frame);
  }, [runKey]);
  if (present.length < 3) return null;
  return (
    <nav aria-label="Jump to a section" style={JUMP_BAR}>
      {JUMPS.filter((jump) => present.includes(jump.id)).map((jump) => (
        <button key={jump.id} onClick={() => document.querySelector(`[data-jump="${jump.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" })} style={JUMP_BUTTON} type="button">{jump.label}</button>
      ))}
    </nav>
  );
}

/** The run's Echo Score on its tab, so the contrast between claims shows before anything is clicked. */
function TabScore({ analysis }: { analysis: EchoAnalysis }) {
  const score = useMemo(() => originLayer(analysis).score, [analysis]);
  return <span className={score > 60 ? styles.tabScoreStrong : score > 30 ? styles.tabScoreMid : styles.tabScoreThin} title="Echo Score for this run: rates the evidence base this run found, not whether the claim is true">{score}</span>;
}

/** Echo's per-engine findings for one Telem-routed run, as the data a search router could take back. Nothing is sent. */
function RouterRecord({ analysis }: { analysis: EchoAnalysis }) {
  const flow = useMemo(() => originFlow(analysis), [analysis]);
  if (!flow.needed || flow.engines.length < 2) return null;
  const record = {
    claim: analysis.claim,
    independent_origins: flow.origins.length,
    engines_with_a_kept_page: flow.needed.of,
    engines_needed: flow.needed.needed,
    engines_answered_with_no_kept_page: flow.idleEngines.map((idle) => idle.engine),
    engines: flow.engines.map((row) => ({
      engine: row.engine,
      runs_billed: flow.bill?.runsByEngine[row.engine] ?? null,
      pages_kept: row.pages,
      returned_an_origin_page: row.own > 0,
      origins_reached: row.origins,
      origins_only_this_engine_reached: row.onlyHere,
    })),
    basis: "one run, hindsight; an engine is credited with a page only for the search that first returned it",
  };
  return (
    <details className={styles.record}>
      <summary>Show the record a search router could take back</summary>
      <pre>{JSON.stringify(record, null, 2)}</pre>
      <p>Computed in the browser from this saved run. It is not sent anywhere: this is the shape of what Echo could hand back to a router such as Telem.</p>
    </details>
  );
}

/** Before and after, for readers who skip diagrams: the flat list search hands an agent, and what Echo hands it instead. */
function BeforeAfter({ analysis }: { analysis: EchoAnalysis }) {
  const flow = useMemo(() => originFlow(analysis), [analysis]);
  const flat = [...analysis.pages].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const unplaced = flow.counts.unplaced;
  // Results the searches returned before Echo kept the pages about the claim (from the run's own search record).
  const results = (analysis.searchAudit ?? []).reduce((sum, entry) => sum + (entry.status === "searched" && Number.isFinite(entry.totalResults) ? entry.totalResults : 0), 0);
  return (
    <section aria-label="Before and after" className={styles.beforeAfter}>
      <div className={styles.before}>
        <span>{analysis.sourceCheck ? "THE LINKS PASTED IN" : "THE PAGES ABOUT THE CLAIM, AS A FLAT LIST"}</span>
        <b>{analysis.sourceCheck ? `${flat.length} supplied ${flat.length === 1 ? "link" : "links"}, each one looks like a separate source` : `${flat.length} ${flat.length === 1 ? "page" : "pages"} Echo kept${results > flat.length ? ` from ${results.toLocaleString("en-US")} search results` : ""}, each read as a separate source`}</b>
        <ol>
          {flat.slice(0, SHOWN).map((page) => <li key={page.id}>{page.domain.replace(/^www\./, "")}</li>)}
          {flat.length > SHOWN && <li className={styles.more}>and {flat.length - SHOWN} more</li>}
        </ol>
      </div>
      <span aria-hidden="true" className={styles.arrow}>→</span>
      <div className={styles.after}>
        <span>{analysis.sourceCheck ? "THE SAME LINKS, TRACED BY ECHO" : "THE SAME PAGES, TRACED BY ECHO"}</span>
        <b>{flow.origins.length} independent {flow.origins.length === 1 ? "origin" : "origins"}</b>
        <ol>
          {[...flow.origins].sort((a, b) => Number(b.ownEvidence) - Number(a.ownEvidence)).slice(0, SHOWN).map((origin) => {
            const behind = origin.pageIds.length - 1 + origin.echoes;
            return <li key={origin.id}>{origin.name}{origin.ownEvidence ? "" : " · no evidence of its own"}{behind > 0 && <em> · {behind} more {behind === 1 ? "page leads" : "pages lead"} back to it</em>}</li>;
          })}
          {flow.origins.length > SHOWN && <li className={styles.more}>and {flow.origins.length - SHOWN} more</li>}
          {!flow.origins.length && <li className={styles.more}>none Echo could confirm</li>}
        </ol>
        {unplaced > 0 && <p>{unplaced} {unplaced === 1 ? (analysis.sourceCheck ? "link" : "page") : analysis.sourceCheck ? "links" : "pages"} Echo could not tie to any origin, set aside and still listed in the graphic below.</p>}
      </div>
    </section>
  );
}

/** The saved runs as tabs, each drawn with the origin layer's graphic. Nothing here sends a request. */
export default function OriginShowcase({ runs }: { runs: ShowcaseRun[] }) {
  const [key, setKey] = useState(runs[0].key);
  const run = runs.find((entry) => entry.key === key) ?? runs[0];
  const routed = (run.analysis.searchAudit ?? []).some((entry) => entry.router === "telem");
  return (
    <>
      <div aria-label="Saved runs" className={runs.length > 9 ? `${styles.tabs} ${styles.tabsMany}` : styles.tabs} onKeyDown={(event) => {
        // Left and right arrows move between runs, as a tab list should (handy when presenting).
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        const at = runs.findIndex((entry) => entry.key === run.key);
        const next = runs[(at + (event.key === "ArrowRight" ? 1 : runs.length - 1)) % runs.length];
        setKey(next.key);
        event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[runs.indexOf(next)]?.focus();
        event.preventDefault();
      }} role="tablist">
        {runs.map((entry) => <button aria-selected={entry.key === run.key} className={entry.key === run.key ? styles.tabOn : styles.tab} key={entry.key} onClick={() => setKey(entry.key)} role="tab" tabIndex={entry.key === run.key ? 0 : -1} type="button">{entry.label}{entry.warning ? null : <TabScore analysis={entry.analysis} />}</button>)}
      </div>
      <p className={styles.runNote} style={{ margin: "-4px 0 12px", letterSpacing: 0, fontSize: 12, fontWeight: 500 }}>The number on each tab is that run’s Echo Score. It rates the evidence base the run found, not whether the claim is true.</p>
      <article className={styles.card} role="tabpanel">
        <JumpBar runKey={run.key} />
        {run.warning && <p role="note" style={{ margin: "0 0 14px", padding: "11px 15px", border: "1px solid #e9c4bd", borderLeft: "4px solid #b23b2e", borderRadius: 8, background: "#fbeeeb", color: "#6e2219", fontSize: 14, lineHeight: 1.5, fontWeight: 600 }}>{run.warning}</p>}
        <p className={styles.runNote}>SAVED LIVE RUN · captured {capturedOn(run.analysis.createdAt)} · {run.analysis.sourceCheck ? `${run.analysis.pages.length} supplied links read, no search` : `searched through ${routed ? "Telem" : "Tavily"}`} · not refreshed</p>
        <h2 className={styles.claim}>“{run.analysis.claim}”</h2>
        {run.analysis.sourceCheck && <p className={styles.runNote} style={{ margin: "-6px 0 14px", letterSpacing: 0, fontSize: 13, fontWeight: 500 }}>No AI answer produced these links. They were pasted into Echo by hand, the way you would paste the citations under an answer. Echo read each one and worked out how many independent origins they are.</p>}
        {/* Echo's own answer, as the trace saved it: written from the origin pages only, or its note when they are too thin. */}
        {run.analysis.answer.trim() && (
          <p className={styles.answer}><span>{run.analysis.answerStatus === "generated" ? "ECHO’S ANSWER, WRITTEN FROM THE ORIGINS ONLY" : "ECHO’S NOTE: THE ORIGINS ARE TOO THIN TO ANSWER FROM"}</span>{run.analysis.answer.replace(/\s*\((?:\[\d+\],?\s*)+\)|(?:\s*,?\s*\[\d+\])+/g, "").trim()}</p>
        )}
        <BeforeAfter analysis={run.analysis} />
        <OriginGraphic comparison={savedComparisonFor(run.analysis)} key={run.key} result={run.analysis} />
        <RouterRecord analysis={run.analysis} />
      </article>
    </>
  );
}
