import { originNames, stabilityPairs, stabilitySummary, type StabilityOrigin, type StabilityRun } from "@/lib/echo/origin-stability";
import type { EchoAnalysis } from "@/lib/echo/types";
import styles from "./stability.module.css";

// "How stable is a score?" on /origins: every claim that has two saved runs, with both runs side by side. A server
// component: it reads the analyses it is handed and nothing else. It sends no request and cannot: the library it
// imports is pure (no model call, no network). Every number below is computed from the saved runs in an expression;
// none is typed. With no claim traced twice, it renders nothing.

export interface StabilityRunFile {
  /** The saved run's file name. */
  file: string;
  analysis: EchoAnalysis;
}

const SMALL_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** A small count as a word ("four"), so a sentence can open with it. Larger counts stay digits. */
function inWords(value: number): string {
  return SMALL_NUMBERS[value] ?? value.toLocaleString("en-US");
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
}

/** The claim inside quotation marks: its own closing full stop is dropped so the sentence around it can end. */
function quoted(claim: string): string {
  return `“${claim.replace(/[.\s]+$/, "")}”`;
}

/** The Pacific calendar day a run was captured ("Nov 14"), from the run's own timestamp. */
function shortDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

/** The same three tones as the score chips on the tabs, picked by the score's own label. */
function tone(run: StabilityRun): string {
  return run.label === "Thin evidence base" ? styles.scoreThin : run.label === "Moderate evidence base" ? styles.scoreMid : styles.scoreStrong;
}

function names(origins: StabilityOrigin[]): string {
  return origins.length ? originNames(origins) : "none";
}

function Run({ run, which }: { run: StabilityRun; which: string }) {
  const day = shortDay(run.captured);
  return (
    <div className={styles.run}>
      <span className={styles.runTag}>{which}{day ? ` · ${day.toUpperCase()}` : ""} · THROUGH {run.searchedThrough.toUpperCase()}</span>
      <span className={styles.scoreLine}>
        <b aria-label={`Echo Score ${run.score}`} className={tone(run)}>{run.score}</b>
        <em>{run.label}</em>
      </span>
      <small>{count(run.pages, "page", "pages")} kept · {count(run.origins, "origin", "origins")} · {run.originsWithOwnEvidence.toLocaleString("en-US")} with own evidence</small>
    </div>
  );
}

export default function Stability({ runs }: { runs: StabilityRunFile[] }) {
  const pairs = stabilityPairs(runs);
  const summary = stabilitySummary(pairs);
  if (!summary) return null;

  const runsEach = pairs.every((pair) => pair.savedRuns === pairs[0].savedRuns) ? inWords(pairs[0].savedRuns) : "two or more";
  const { widest, narrowest } = summary;
  const points = (gap: number) => count(gap, "point", "points");
  const heading = summary.claims === 1
    ? `One claim has ${runsEach} saved runs. ${widest.gap === 0 ? `It scored ${widest.later.score} both times.` : `Its scores are ${points(widest.gap)} apart.`}`
    : [
        `${capital(inWords(summary.claims))} claims have ${runsEach} saved runs each.`,
        widest.gap === narrowest.gap
          ? (widest.gap === 0 ? "Each scored the same both times." : `Each pair of scores is ${points(widest.gap)} apart.`)
          : `The widest score gap is ${points(widest.gap)}, on ${quoted(widest.claim)}.`,
        widest.gap === narrowest.gap ? "" : narrowest.gap === 0 ? `${quoted(narrowest.claim)} scored ${narrowest.later.score} both times.` : `The narrowest is ${points(narrowest.gap)}, on ${quoted(narrowest.claim)}.`,
      ].filter(Boolean).join(" ");

  return (
    <section aria-label="How stable is a score" className={styles.card} data-jump="stability">
      <p className={styles.kicker}>HOW STABLE IS A SCORE</p>
      <h2 className={styles.title}>{heading}</h2>
      <p className={styles.lede}>The same claim, traced on two occasions. Each row puts the two saved runs side by side: what each run kept, what the two share, and which origins one run counted and the other did not. In every pair the day and the search route both differ, so no row says which route is better.</p>
      <ul className={styles.rows}>
        {pairs.map((pair) => (
          <li className={styles.row} key={`${pair.earlier.file}-${pair.later.file}`}>
            <div className={styles.claimLine}>
              <span className={styles.claim}>{quoted(pair.claim)}</span>
              <span className={styles.gap}>{pair.gap === 0 ? "the same score both times" : <><b>{pair.gap.toLocaleString("en-US")}</b> {pair.gap === 1 ? "point apart" : "points apart"}</>}</span>
            </div>
            <div className={styles.pair}>
              <Run run={pair.earlier} which="EARLIER RUN" />
              <span aria-hidden="true" className={styles.arrow}>→</span>
              <Run run={pair.later} which="LATER RUN" />
              <dl className={styles.shared}>
                <div>
                  <dt>PAGES IN BOTH RUNS</dt>
                  <dd><b>{pair.sharedPages.toLocaleString("en-US")}</b> out of the {pair.earlier.pages.toLocaleString("en-US")} the earlier run kept and the {pair.later.pages.toLocaleString("en-US")} the later run kept</dd>
                </div>
                <div>
                  <dt>ORIGINS IN BOTH RUNS</dt>
                  <dd><b>{pair.sharedOrigins.length.toLocaleString("en-US")}</b>{pair.sharedOrigins.length ? `: ${names(pair.sharedOrigins)}` : ""}</dd>
                </div>
                <div>
                  <dt>ORIGINS ORIGINS ONLY THE EARLIER RUN COUNTED COUNTED</dt>
                  <dd><b>{pair.onlyEarlier.length.toLocaleString("en-US")}</b>{pair.onlyEarlier.length ? `: ${names(pair.onlyEarlier)}` : ""}</dd>
                </div>
                <div>
                  <dt>ORIGINS ORIGINS ONLY THE LATER RUN COUNTED COUNTED</dt>
                  <dd><b>{pair.onlyLater.length.toLocaleString("en-US")}</b>{pair.onlyLater.length ? `: ${names(pair.onlyLater)}` : ""}</dd>
                </div>
              </dl>
            </div>
            <p className={styles.why}>
              <span>{pair.gap === 0 ? "WHY THE SCORE HELD" : "WHY THE SCORE MOVED"}</span>
              {pair.why}
              {pair.sisterNote && <small>{pair.sisterNote}</small>}
            </p>
          </li>
        ))}
      </ul>
      <p className={styles.note}>
        A score rates what one run retrieved. A different day or a different search route keeps different pages, so one claim can score differently from run to run. That is why this page never calls a score a rating of the claim.
        {summary.dayAndRouteBothChanged ? ` In ${summary.claims === 1 ? "this pair" : "every pair here"} both the day and the route changed. Echo’s own rules also changed between some of these runs, and a model judges each page afresh on every run, so the card cannot say what moved a score.` : ""}
        {" "}{capital(runsEach)} runs per claim is far too few to say which route is better, and this card does not. Pages are matched by address, with tracking parameters dropped. Origins are matched by publisher, or by page on a site many publishers share.
      </p>
    </section>
  );
}
