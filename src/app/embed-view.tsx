"use client";

import type { MouseEvent, ReactNode } from "react";
import { openFullResult, type EmbedStartState } from "./embed-bridge";
import { SourceCheckSummary } from "./source-check";
import { costReceiptLine, pageBreakdownLine, plainSearchDetail, plainSearchHeadline, plainSearchLineage, verdictHeadline } from "./trace-view";
import { displayedAnswer } from "@/lib/echo/supplied-urls";
import type { EchoAnalysis } from "@/lib/echo/types";
import styles from "./embed.module.css";

/**
 * The compact layout of /embed, the page the browser extension's side panel frames (360–480 px wide): the claim, the
 * live wait card, the verdict, the plain-search line, each supplied link's verdict for Check links, and "Open full
 * result". The workbench (echo-workbench.tsx, embed mode) owns the state and the run; these parts only draw it.
 */
export function EmbedShell({ children }: { children: ReactNode }) {
  return (
    <main className={styles.shell} id="main-content">
      <header className={styles.top}>
        <a aria-label="Open Echo in a new tab" className={styles.brand} href="/" rel="noopener" target="_blank">echo<span>.</span></a>
        <span className={styles.kicker}>SIDE PANEL</span>
      </header>
      {children}
    </main>
  );
}

/**
 * The claim box before a run. `action` is the workbench's submit button (it starts the run, so it lives there, where
 * check:links follows it to the click); Enter in the box presses it.
 */
export function EmbedClaimForm({ claim, onClaimChange, action }: { claim: string; onClaimChange: (claim: string) => void; action: ReactNode }) {
  return (
    <form className={styles.form} onSubmit={(event) => event.preventDefault()}>
      <label className={styles.label} htmlFor="claim-input">CLAIM TO TRACE</label>
      <div className={styles.row}>
        <input autoComplete="off" className={styles.claim} id="claim-input" maxLength={500} onChange={(event) => onClaimChange(event.target.value)} placeholder="Paste a statistic or a sentence…" value={claim} />
        {action}
      </div>
    </form>
  );
}

/** The claim (or the links' sentence) being traced, once a run started. */
export function EmbedClaim({ claim, links }: { claim: string; links: number }) {
  return <p className={styles.claimText}><span>{links ? `CHECKING ${links === 1 ? "1 LINK" : `${links} LINKS`} FOR` : "TRACING"}</span>{claim}</p>;
}

export const EMBED_RUN_BUTTON = styles.run;

const ERROR_TITLES: Record<string, string> = {
  SOURCES_INVALID: "Check the supplied links",
  MISSING_KEYS: "Live analysis is not configured yet",
  DAILY_BUDGET_REACHED: "Daily spending cap reached",
  BUDGET_STORAGE_UNAVAILABLE: "Live calls are paused to protect your cap",
  CLAIM_TOO_SHORT: "Write the claim to trace",
  CLAIM_NO_WORDS: "Write the claim to trace",
  PRESENTER_ONLY: "Live runs are reserved for the presenter",
  OFFLINE: "You are offline",
};

/** A failed or refused run, with the workbench's Try again button when one helps. */
export function EmbedError({ code, message, onDismiss, action }: { code?: string; message: string; onDismiss: () => void; action?: ReactNode }) {
  return (
    <div className="error-banner" role="alert">
      <span className="error-symbol">!</span>
      <div><strong>{ERROR_TITLES[code ?? ""] ?? "This run needs another try"}</strong><p>{message}</p>{action}</div>
      <button aria-label="Dismiss error" className="error-close" onClick={onDismiss} type="button">×</button>
    </div>
  );
}

/** Says why a run did not start by itself, and how to allow it; nothing when it did, or is about to. */
export function EmbedStartNote({ state, parent }: { state: EmbedStartState; parent: string | null }) {
  if (state !== "unlisted") return null;
  return (
    <p className={styles.note} role="status">
      Press the button to run it. To start runs from the extension with one click, add{" "}
      {parent?.startsWith("chrome-extension://") ? <code>{parent}</code> : "the extension's origin (shown on its options page)"} to{" "}
      <code>ECHO_EXTENSION_ORIGINS</code> in Echo&apos;s <code>.env.local</code> and restart Echo.
    </p>
  );
}

/** A finished result: Check links gets its per-link card; a traced claim gets the verdict, plain search and answer. */
export function EmbedResult({ result, fullHref, onReset }: { result: EchoAnalysis; fullHref: string; onReset: () => void }) {
  const lineage = result.sourceCheck ? null : plainSearchLineage(result);
  const receipt = result.mode === "live" ? costReceiptLine(result) : null;
  const answer = result.answerStatus === "generated" ? displayedAnswer(result).trim() : "";
  const openFull = (event: MouseEvent<HTMLAnchorElement>) => {
    if (openFullResult(fullHref, result)) event.preventDefault();
  };
  const { totalPages, independentOrigins, verifiableOrigins } = result.summary;
  return (
    <section aria-label="Echo result" className={styles.result}>
      {result.sourceCheck ? <SourceCheckSummary result={result} /> : (
        <div className={styles.verdict}>
          <span className={styles.eyebrow}>SOURCE INDEPENDENCE VERDICT</span>
          <h2>{verdictHeadline(result)}</h2>
          <p className={styles.breakdown}>{pageBreakdownLine(result)}</p>
          <div aria-label="Trace at a glance" className={styles.stats} role="group">
            <div><strong>{totalPages}</strong><span>{totalPages === 1 ? "page found" : "pages found"}</span></div>
            <div><strong>{independentOrigins}</strong><span>{independentOrigins === 1 ? "independent origin" : "independent origins"}</span></div>
            <div><strong>{verifiableOrigins}</strong><span>with own evidence</span></div>
          </div>
        </div>
      )}
      {lineage && (
        <div className={styles.plain}>
          <span className={styles.eyebrow}>PLAIN SEARCH VS ECHO</span>
          <p className={styles.plainPrimary}>{plainSearchHeadline(lineage)}</p>
          <p className={styles.plainDetail}>{plainSearchDetail(lineage)}</p>
        </div>
      )}
      {answer && !result.sourceCheck && (
        <div className={styles.answer}>
          <span className={styles.eyebrow}>ANSWER FROM THE ORIGINS</span>
          <p>{answer}</p>
        </div>
      )}
      {receipt && <p className={styles.receipt}>{receipt}</p>}
      <a className={styles.full} href={fullHref} onClick={openFull} rel="noopener" target="_blank">Open full result <span aria-hidden="true">↗</span></a>
      <button className={styles.again} onClick={onReset} type="button">New trace</button>
    </section>
  );
}
