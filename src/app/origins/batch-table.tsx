"use client";

import { useMemo, useState } from "react";
import { batchCsv, type BatchRow } from "@/lib/echo/origin-batch";
import styles from "./batch.module.css";

type SortKey = "claim" | "searchedThrough" | "pages" | "origins" | "originsWithOwnEvidence" | "notTied" | "echoScore" | "enginesNeeded" | "sharedName" | "promptShorterPct" | "measuredTokenReductionPct";
type Direction = "ascending" | "descending";

const COLUMNS: Array<{ key: SortKey; label: string; text?: boolean; hint: string }> = [
  { key: "claim", label: "Claim", text: true, hint: "The claim that was traced, or the claim the pasted links were checked against" },
  { key: "searchedThrough", label: "Searched through", text: true, hint: "The search router the run used" },
  { key: "pages", label: "Pages", hint: "Pages Echo kept as about the claim" },
  { key: "origins", label: "Origins", hint: "Independent origins Echo counted among those pages" },
  { key: "originsWithOwnEvidence", label: "With own evidence", hint: "Origins whose saved passage shows evidence of its own" },
  { key: "notTied", label: "Not tied", hint: "Pages Echo could not tie to any origin: neither confirmed copies nor pages Echo counted as origins" },
  { key: "echoScore", label: "Echo Score", hint: "Rates the evidence base this run found, not whether the claim is true" },
  { key: "enginesNeeded", label: "Engines needed", hint: "Fewest engines whose pages together reach every origin of the run, by this run’s record" },
  { key: "sharedName", label: "Name most origins share", text: true, hint: "A name at least half of the run’s origins mention in the passage Echo saved, when no page of the run is that source. A hint that they may share a source, not a finding" },
  { key: "promptShorterPct", label: "Prompt shorter by", hint: "The origins-only prompt against the every-page prompt, counted in characters" },
  { key: "measuredTokenReductionPct", label: "Fewer input tokens, measured", hint: "From one saved comparison of this run: both prompts sent to Claude once and the input tokens counted" },
];

/** The Pacific day a run was captured, short ("Nov 14"). Fixed locale and time zone, so server and browser agree. */
function capturedOn(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
}

/** An empty cell: a dash to look at, words for a screen reader. */
function Blank({ why }: { why: string }) {
  return <><span aria-hidden="true">—</span><span className={styles.hidden}>{why}</span></>;
}

/**
 * Every saved run as one row. Click a column heading to sort. The two buttons hand the same rows over as a CSV file or
 * as JSON on the clipboard. Both are built in the browser from the rows on screen: nothing is requested or sent.
 */
export default function BatchTable({ rows }: { rows: BatchRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; direction: Direction } | null>(null);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  const shown = useMemo(() => {
    if (!sort) return rows;
    const column = COLUMNS.find((entry) => entry.key === sort.key);
    const sign = sort.direction === "ascending" ? 1 : -1;
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const left = a.row[sort.key];
        const right = b.row[sort.key];
        // A row with no figure in this column goes last, whichever way the column is sorted.
        if (left === null || right === null) return left === right ? a.index - b.index : left === null ? 1 : -1;
        const order = column?.text ? String(left).localeCompare(String(right), "en", { sensitivity: "base" }) : Number(left) - Number(right);
        return order * sign || a.index - b.index;
      })
      .map((entry) => entry.row);
  }, [rows, sort]);

  const sortBy = (key: SortKey, text: boolean) => {
    setSort((current) => (current?.key === key ? { key, direction: current.direction === "ascending" ? "descending" : "ascending" } : { key, direction: text ? "ascending" : "descending" }));
  };

  const download = () => {
    const blob = new Blob([batchCsv(shown)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "echo-saved-runs.csv";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(shown, null, 2));
      setCopied("done");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied("idle"), 2200);
  };

  const measured = rows.filter((row) => row.measuredTokenReductionPct !== null).length;
  const routed = rows.filter((row) => row.enginesNeeded !== null).length;
  const sharing = rows.filter((row) => row.sharedName !== null).length;

  return (
    <>
      <div className={styles.actions}>
        <button className={styles.actionMain} onClick={download} type="button">Download as CSV</button>
        <button className={styles.action} onClick={copy} type="button">{copied === "done" ? "Copied" : copied === "failed" ? "Could not copy" : "Copy as JSON"}</button>
        <span className={styles.actionNote}>{count(rows.length, "row", "rows")}, built in your browser. Nothing is sent.</span>
        <span aria-live="polite" className={styles.hidden}>{copied === "done" ? "The rows were copied as JSON." : copied === "failed" ? "The rows could not be copied." : ""}</span>
      </div>
      <div className={styles.wrap}>
        <table className={styles.table}>
          <caption className={styles.hidden}>Every saved run, one row each. Each column heading is a button that sorts the table.</caption>
          <thead>
            <tr>
              {COLUMNS.map((column) => {
                const active = sort?.key === column.key ? sort.direction : null;
                return (
                  <th aria-sort={active ?? "none"} className={column.text ? styles.textCol : undefined} key={column.key} scope="col">
                    <button className={active ? styles.sortOn : styles.sort} onClick={() => sortBy(column.key, Boolean(column.text))} title={column.hint} type="button">
                      {column.label}
                      <span aria-hidden="true" className={styles.arrow}>{active === "ascending" ? "▲" : active === "descending" ? "▼" : "↕"}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.file}>
                <th className={styles.claim} scope="row">
                  {row.claim}
                  <small>{capital(row.kind)} · captured {capturedOn(row.captured)}</small>
                </th>
                <td className={styles.textCol}>{capital(row.searchedThrough)}</td>
                <td>{row.pages}</td>
                <td className={styles.origins}>{row.origins}</td>
                <td>{row.originsWithOwnEvidence}</td>
                <td>{row.notTied}</td>
                <td>
                  <span className={row.echoScore > 60 ? styles.scoreStrong : row.echoScore > 30 ? styles.scoreMid : styles.scoreThin} title={`${row.label}. The score rates the evidence base this run found, not whether the claim is true.`}>{row.echoScore}</span>
                  <small className={styles.scoreWord}>{row.label.split(" ")[0].toLowerCase()}</small>
                </td>
                <td>{row.enginesNeeded !== null && row.enginesWithKeptPage !== null ? <>{row.enginesNeeded} of {row.enginesWithKeptPage}</> : <Blank why="no engine record" />}</td>
                <td className={styles.textCol}>{row.sharedName !== null && row.sharedNameOrigins !== null && row.sharedNameOf !== null ? <span title={`${row.sharedNameOrigins} of ${count(row.sharedNameOf, "origin publisher", "origin publishers")} mention this name in the passage Echo saved. No page of the run is that source, so they may share a source. A hint found by rule, not a finding.`}>{row.sharedName}<small className={styles.scoreWord}>{row.sharedNameOrigins} of {row.sharedNameOf}</small></span> : <Blank why="no name most origins share" />}</td>
                <td>{row.promptShorterPct === null ? <Blank why="no origin to answer from" /> : row.promptShorterPct >= 0 ? <>{row.promptShorterPct}%</> : <>{-row.promptShorterPct}% longer</>}</td>
                <td>{row.measuredTokenReductionPct === null ? <Blank why="not measured" /> : row.measuredTokenReductionPct >= 0 ? <>{row.measuredTokenReductionPct}%</> : <>{-row.measuredTokenReductionPct}% more</>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>
        Echo Score rates the evidence base one run found, not whether the claim is true. “Not tied” pages are neither confirmed copies nor pages Echo counted as origins.
        {routed > 0 && <> “Engines needed” is the fewest engines whose pages together reach every origin of that run, out of the engines with a page Echo kept, by this run’s record: hindsight on one run per claim, so it ranks no engine.</>}
        {sharing > 0 && <> “Name most origins share” is a name that at least half of a run’s origins mention in the passage Echo saved, when no page of that run is the source. Those origins may share a source that search did not return, so the count of independent origins may then be too high. It is found by rule from the saved passages, with no model call: a hint to go and look, not a finding.</>}
        {" "}“Prompt shorter by” compares two prompts for the same question, counted in characters: one carrying every page, one carrying one page per origin. No model was called for that column.
        {measured > 0 && <> “Fewer input tokens, measured” is filled for {measured === rows.length ? "every run" : count(measured, "run", "runs")}: the every-page and origins-only prompts for that run were sent to Claude once, earlier, and the input tokens counted. That is one measurement per run and not a blind test, since the origins-only prompt tells the model what Echo found.</>}
        {" "}The CSV and the JSON carry every column of a run, including the ones this table leaves out.
      </p>
    </>
  );
}
