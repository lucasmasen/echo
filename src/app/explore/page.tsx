import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { DEMO_SCORES } from "@/lib/echo/demo-scores";
import { sourceCheckHeadline } from "@/lib/echo/supplied-urls";
import { datedSpanOf, plainSearchHeadline, plainSearchLineage, plainSearchTooltip, verdictHeadline } from "../trace-view";
import { bundledCards, savedCheckCard, scoreSentence } from "./cards";
import styles from "./explore.module.css";

export const metadata: Metadata = {
  title: "Explore real Echo traces",
  description: "Viral claims traced to their sources: how many independent origins each has, and how many pages only repeat it. Plus one saved check of the links an AI answer cites.",
};

function capturedOn(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
}

export default async function Explore() {
  // Read at build time; the page is static.
  const readTrace = (trace: string) => fs.readFile(path.join(process.cwd(), "public", trace), "utf8");
  const [cards, check] = await Promise.all([bundledCards(readTrace), savedCheckCard(readTrace)]);
  const checkHeadline = check ? sourceCheckHeadline(check.analysis) : null;
  return (
    <main className={styles.page}>
      <Link className={styles.back} href="/">← Echo</Link>
      <p className={styles.kicker}>EXPLORE REAL TRACES</p>
      <h1 className={styles.title}>Many pages, few sources: viral claims traced back.</h1>
      <p className={styles.lede}>
        Each card is a real Echo run, captured from the live web: how many pages repeat the claim, how many are
        independent origins, and how many of those show evidence of their own. Open one to see the whole source tree. The
        last card is different: a saved check of the links an AI answer cites, with no web search.
      </p>
      <ul className={styles.grid}>
        {cards.map(({ label, trace, link, analysis }) => {
          const span = datedSpanOf(analysis);
          const score = scoreSentence(analysis, DEMO_SCORES[trace]);
          const plainSearch = plainSearchLineage(analysis);
          return (
            <li className={styles.card} key={trace}>
              <span className={styles.label}>{label.toUpperCase()}</span>
              <h2 className={styles.claim}>“{analysis.claim}”</h2>
              <p className={styles.verdict}>{verdictHeadline(analysis)}</p>
              {plainSearch && <p className={styles.plainSearch} title={plainSearchTooltip(plainSearch)}>{plainSearchHeadline(plainSearch)}</p>}
              <dl className={styles.stats}>
                <div><dt>pages</dt><dd>{analysis.summary.totalPages}</dd></div>
                <div><dt>independent origins</dt><dd>{analysis.summary.independentOrigins}</dd></div>
                <div><dt>with own evidence</dt><dd>{analysis.summary.verifiableOrigins}</dd></div>
                <div><dt>echo rate</dt><dd>{analysis.summary.echoPercentage}%</dd></div>
              </dl>
              <p className={styles.meta}>
                {span ? `Dated pages span ${span.from}–${span.to}. ` : ""}Live run captured {capturedOn(analysis.createdAt)}.
                {score ? ` ${score}` : ""}
              </p>
              <Link aria-label={`Open the trace of “${analysis.claim}”`} className={styles.open} href={link}>Open this trace →</Link>
            </li>
          );
        })}
        {check && checkHeadline?.text && (
          // A supplied-links check: counted in links, not pages, and never given an echo rate (it ran no search).
          <li className={styles.card} key={check.trace}>
            <span className={styles.label}>{check.label.toUpperCase()}</span>
            <h2 className={styles.claim}>“{check.analysis.claim}”</h2>
            <p className={styles.verdict}>{checkHeadline.text}{checkHeadline.evidence ? ` (${checkHeadline.evidence})` : ""}</p>
            <p className={styles.plainSearch}>Five supplied links that repeat this claim, checked the way an AI answer’s citations would be. Echo read only them and ran no web search.</p>
            <dl className={`${styles.stats} ${styles.statsThree}`}>
              <div><dt>supplied links</dt><dd>{check.analysis.sourceCheck!.urls.length}</dd></div>
              <div><dt>independent origins</dt><dd>{check.analysis.summary.independentOrigins}</dd></div>
              <div><dt>with own evidence</dt><dd>{check.analysis.summary.verifiableOrigins}</dd></div>
            </dl>
            <p className={styles.meta}>Origins are counted among the supplied links only. Live check captured {capturedOn(check.analysis.createdAt)}.</p>
            <Link aria-label={`Open the saved check of “${check.analysis.claim}”`} className={styles.open} href={check.link}>Open this check →</Link>
          </li>
        )}
      </ul>
      {!cards.length && <p className={styles.lede}>No saved traces are available in this build. Trace a claim of your own instead.</p>}
      <div className={styles.cta}>
        <Link className={styles.primary} href="/">Trace your own claim</Link>
        <Link className={styles.secondary} href="/anywhere">Trace from any page</Link>
        <Link className={styles.secondary} href="/how">How Echo works</Link>
      </div>
      <p className={styles.note}>
        Echo uses Claude (AI) to judge which pages copied which, from dates, citations and shared wording. An origin is the best-supported
        starting point among the pages found, not proof it was first on the whole web. The labels these runs are
        checked against were made by an AI from the full pages, not by a person.
      </p>
    </main>
  );
}
