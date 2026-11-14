import { pageNames, upstreamHints } from "@/lib/echo/upstream";
import type { EchoAnalysis } from "@/lib/echo/types";
import styles from "./upstream-map.module.css";

// The spike, as one card: for each claim on the page, the name its pages keep pointing at when no page of the run
// comes from a site with that name. A rule over the saved passages (src/lib/echo/upstream.ts): no model call.

interface MapRun {
  key: string;
  label: string;
  analysis: EchoAnalysis;
}

function words(value: number): string {
  return ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"][value] ?? String(value);
}

export default function UpstreamMap({ runs }: { runs: MapRun[] }) {
  const rows = runs.map((run) => {
    const lead = pageNames(run.analysis).filter((name) => !name.amongPages)[0] ?? null;
    const shared = upstreamHints(run.analysis).filter((hint) => !hint.amongPages)[0] ?? null;
    return { run, lead, shared };
  });
  const pointing = rows.filter((row) => row.lead);
  if (!pointing.length) return null;
  return (
    <section aria-label="The source that is not in the results" className={styles.card} data-jump="missing">
      <p className={styles.kicker}>WHAT ONLY ECHO SHOWS</p>
      <h2 className={styles.title}>The source that is <em>not</em> in the results.</h2>
      <p className={styles.lede}>
        A tool that removes duplicates or checks facts can only look at the pages it was handed. Echo also reads what those pages keep pointing at. On {words(pointing.length)} of the {words(runs.length)} claims here, the pages name a source that no page of the run comes from.
      </p>
      <ul className={styles.rows}>
        {pointing.map(({ run, lead, shared }) => lead && (
          <li key={run.key}>
            <span className={styles.claim}>{run.label}<small>“{run.analysis.claim.replace(/\.$/, "")}”</small></span>
            <span aria-hidden="true" className={styles.arrow}>→</span>
            <span className={styles.name}>
              <b>{lead.name}</b>
              <small>named on {lead.sites} of the {lead.of} sites Echo kept{shared ? `, and by ${shared.origins} of the ${shared.of} origin publishers` : ""}; none of the pages is from it</small>
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.note}>Found by matching names across the saved passages, by rule, with no model call. It is a lead to go and look, not a finding: a name many pages share can be a person or a body the claim is about, not its source. The other {words(runs.length - pointing.length)} claims show no such name. When the origins themselves share the name, Echo can go looking for the document through Telem (see “Where Echo was wrong”).</p>
    </section>
  );
}
