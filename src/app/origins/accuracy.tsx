import { DEMO_SCORES, type DemoRun } from "@/lib/echo/demo-scores";
import { BACKUP_POOL, PRESETS } from "../demo-slots";
import styles from "./accuracy.module.css";

// "How often is Echo right, as measured" on /origins. A server component: it reads DEMO_SCORES (saved traces scored
// offline against label sheets by `npm run eval:demo-scores`) and the claim text in demo-slots, and nothing else. It
// sends no request and cannot. Every number below is computed from DEMO_SCORES in an expression; none is typed. With
// no scores it renders nothing.

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
/** A small count as a word; a larger one as digits. */
const word = (count: number) => WORDS[count] ?? String(count);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const sum = <Row,>(rows: Row[], pick: (row: Row) => number) => rows.reduce((total, row) => total + pick(row), 0);
/** When a run was made, in Pacific time (the page is rendered on the server, so the zone is fixed here). */
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The claim a saved trace checked, from the demo slots; the file name in words if the slot is gone. */
function claimFor(trace: string) {
  const slot = [...PRESETS, ...BACKUP_POOL].find((entry) => entry.capturedTrace === trace);
  return slot?.claim ?? (trace.split("/").pop() ?? trace).replace(/\.echo\.json$/, "").replace(/-/g, " ");
}

/** Matched, left unclear, wrong: one bar, each part as wide as its count. */
function Bar({ matched, unclear, wrong, label }: { matched: number; unclear: number; wrong: number; label?: string }) {
  return (
    <span aria-hidden={label ? undefined : true} aria-label={label} className={styles.bar} role={label ? "img" : undefined}>
      {matched > 0 && <span className={styles.segMatched} style={{ flexGrow: matched }} />}
      {unclear > 0 && <span className={styles.segUnclear} style={{ flexGrow: unclear }} />}
      {wrong > 0 && <span className={styles.segWrong} style={{ flexGrow: wrong }} />}
    </span>
  );
}

export default function Accuracy() {
  const claims = Object.entries(DEMO_SCORES).map(([trace, score]) => {
    // Every scored run of the claim, oldest first; a score with no run list is its one bundled run.
    const runs: DemoRun[] = score.runs?.length ? score.runs : [{ createdAt: score.traceCreatedAt, bundled: true, earlierEcho: false, matched: score.matched, exactKinds: score.exactKinds, settledMistakes: score.settledMistakes, abstentions: score.abstentions }];
    return { trace, score, claim: claimFor(trace), labeled: score.matched + score.missingLabeled, runs };
  });
  const runs = claims.flatMap((entry) => entry.runs.map((run) => ({ ...run, claim: entry.claim })));
  const compared = sum(runs, (run) => run.matched);
  if (!claims.length || !compared) return null;

  const matched = sum(runs, (run) => run.exactKinds);
  const unclear = sum(runs, (run) => run.abstentions);
  const wrong = sum(runs, (run) => run.settledMistakes);
  const labeled = sum(claims, (entry) => entry.labeled);
  const cleanRuns = runs.filter((run) => run.settledMistakes === 0).length;
  const worst = runs.reduce((worse, run) => (run.settledMistakes > worse.settledMistakes ? run : worse), runs[0]);
  const hasEarlier = runs.some((run) => run.earlierEcho);
  // Copies and their parent pages are scored on the run the app shows for each claim only.
  const copiesLabeled = sum(claims, (entry) => entry.score.derivedGold);
  const copiesFound = sum(claims, (entry) => entry.score.derivedCorrect);
  const parentsExact = sum(claims, (entry) => entry.score.exactEdges);
  // Today's Telem runs are in mcp/traces; a scored one would show up here as a key naming it.
  const telemScored = Object.keys(DEMO_SCORES).some((trace) => trace.toLowerCase().includes("telem"));

  return (
    <section aria-label="How often Echo agrees with a model’s labels" className={styles.card} data-jump="accuracy">
      <p className={styles.kicker}>HOW OFTEN ECHO AGREES WITH A MODEL’S LABELS</p>
      <h2 className={styles.title}>Measured on {word(claims.length)} {plural(claims.length, "claim", "claims")} only, against labels a model wrote.</h2>
      <p className={styles.lede}>
        Across {word(runs.length)} saved {plural(runs.length, "run", "runs")} of {plural(claims.length, "that claim", "those claims")}, Echo&rsquo;s verdict on a page matched the label {matched} times out of {compared}, about {share(matched, compared)}%. Echo left {unclear} unclear where the label had an answer. It was wrong on {wrong}. A verdict is what Echo calls one page: an origin, a copy of a named page, or unclear.
      </p>

      <ul className={styles.stats}>
        <li className={styles.statMatched}><b>{matched}</b><span>matched the label</span><small>of {compared} page verdicts compared</small></li>
        <li className={styles.statUnclear}><b>{unclear}</b><span>left unclear</span><small>Echo declined to decide where the label had an answer</small></li>
        <li className={styles.statWrong}><b>{wrong}</b><span>wrong</span><small>Echo said origin or copy and the label says otherwise</small></li>
      </ul>
      <Bar label={`${matched} matched, ${unclear} left unclear, ${wrong} wrong`} matched={matched} unclear={unclear} wrong={wrong} />

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Saved run</th>
              <th scope="col">Pages compared</th>
              <th scope="col">Matched</th>
              <th scope="col">Left unclear</th>
              <th scope="col">Wrong</th>
              <th className={styles.barHead} scope="col">
                <span className={styles.legend}><i className={styles.keyMatched} />matched<i className={styles.keyUnclear} />unclear<i className={styles.keyWrong} />wrong</span>
              </th>
            </tr>
          </thead>
          {claims.map((entry) => (
            <tbody key={entry.trace}>
              <tr className={styles.claimRow}>
                <th colSpan={6} scope="colgroup">
                  &ldquo;{entry.claim}&rdquo;
                  <span>{entry.labeled} pages labeled · {word(entry.runs.length)} saved {plural(entry.runs.length, "run", "runs")}</span>
                </th>
              </tr>
              {entry.runs.map((run) => (
                <tr key={run.createdAt}>
                  <th scope="row">
                    {when(run.createdAt)}
                    {run.bundled && <em className={styles.tagShown}>shown in the app</em>}
                    {run.earlierEcho && <em className={styles.tag}>earlier Echo</em>}
                  </th>
                  <td>{run.matched}</td>
                  <td>{run.exactKinds}</td>
                  <td>{run.abstentions}</td>
                  <td className={run.settledMistakes ? styles.wrong : undefined}>{run.settledMistakes}</td>
                  <td className={styles.barCell}><Bar matched={run.exactKinds} unclear={run.abstentions} wrong={run.settledMistakes} /></td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      <ul className={styles.fine}>
        <li><b>Who made the labels.</b> A model (Claude) wrote them after reading each full page: origin, copy of which page, or unclear. A person has not spot-checked them yet, so this is agreement with a model&rsquo;s labels.</li>
        <li><b>Not a benchmark.</b> {capital(word(claims.length))} {plural(claims.length, "claim", "claims")}, {labeled} labeled pages, {word(runs.length)} saved {plural(runs.length, "run", "runs")}. A page found by more than one run is counted once per run, and a labeled page a run did not find is left out of that run. This does not measure whether a claim is true.</li>
        <li><b>Unclear before a guess.</b> Echo is built to say unclear when it cannot place a page. Here that is {unclear} of {compared} verdicts, about {share(unclear, compared)}%.</li>
        <li>
          <b>The bad runs stay on the card.</b> {capital(word(cleanRuns))} of the {word(runs.length)} runs {plural(cleanRuns, "has", "have")} no wrong verdict.
          {worst.settledMistakes > 0 && <> The worst one, {when(worst.createdAt)} on &ldquo;{worst.claim}&rdquo;, has {worst.settledMistakes} wrong of {worst.matched}.</>}
          {hasEarlier && <> Rows marked earlier Echo were run before later changes to how Echo reads source links and dates, where a later run of the same claim exists to compare with. An unmarked row can be just as old, and the later runs are not free of wrong verdicts. All rows are counted in the totals.</>}
        </li>
        {copiesLabeled > 0 && <li><b>Kind first, parent second.</b> A match means the kind of page agrees. On the {word(claims.length)} {plural(claims.length, "run", "runs")} shown in the app, the labels mark {copiesLabeled} pages as copies. Echo called {copiesFound} of them copies and named the exact parent page for {parentsExact}.</li>}
        {!telemScored && <li><b>Today&rsquo;s Telem runs.</b> Not in these figures. No label sheet has been made for them yet.</li>}
      </ul>
    </section>
  );
}
