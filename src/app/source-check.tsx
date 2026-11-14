"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { EchoAnalysis } from "@/lib/echo/types";
import { hostOf, MAX_SUPPLIED_URL_LENGTH, MAX_SUPPLIED_URLS, pageKey, pastedLinks, removalsStillPasted, sourceCheckHeadline, sourceCheckPoint, sourceCheckReadLine, sourceCiteOnce, sourceCiteOnceData, sourceLinkRows, suggestedClaim } from "@/lib/echo/supplied-urls";
import { unreadableAddressReason } from "@/lib/echo/public-address";
import styles from "./source-check.module.css";

/**
 * "Check these sources": paste an AI answer (or any list of links) and the sentence to check; Echo reads exactly those
 * links, with no web search, and counts how many independent origins they come from. This file is the panel and the
 * result headline only. The button that starts the paid run is the workbench's own (handed in as `action`), so every
 * paid request stays a click on a button in echo-workbench.tsx (scripts/check-links.mjs follows them there).
 */
export type SourceDraft = {
  /** What the person pasted: an answer with links, or links one per line. */
  text: string;
  /**
   * Pages the person removed from the chips (by page, so http/www copies go too). Removal applies to this paste only:
   * a page no longer in the text is forgotten, so pasting it again brings its chip back.
   */
  removed: string[];
  claim: string;
  /** The sentence Echo picked from the pasted answer, while the sentence box still holds it unchanged. */
  claimFilled?: string;
};

export const EMPTY_SOURCE_DRAFT: SourceDraft = { text: "", removed: [], claim: "" };

/**
 * "Try an example": a sample answer, written for Echo and labelled as one (it imitates no product), citing the five
 * phones links that Echo traced live on 2026-11-13 to 1 independent origin. Pressing it only fills the panel; the
 * person still presses Check 5 sources, which is a live run like any other.
 */
export const SAMPLE_SOURCES_CLAIM = "Americans check their phones 96 times a day";
export const SAMPLE_SOURCES_ANSWER = `Sample answer, written for this example:

Americans check their phones 96 times a day, or about once every 10 minutes, according to a 2019 survey by Asurion [1][2]. News sites repeated the figure in 2021 [3][4], and blogs still quote it [5].

Sources
[1] https://www.asurion.com/press-releases/americans-check-their-phones-96-times-a-day
[2] https://www.prnewswire.com/news-releases/americans-check-their-phones-96-times-a-day-300962643.html
[3] https://www.fox13seattle.com/news/americans-check-their-smartphones-96-times-a-day-survey-says
[4] https://www.kabc.com/2021/10/03/reality-check-you-check-your-phone-96-times-a-day-96-times-a-day
[5] https://www.churchandculture.org/blog/2021/10/28/96-times-a-day`;

/**
 * The draft with new pasted text. An empty sentence box, or one still holding Echo's own unchanged pick, gets the
 * answer's best sentence (the one carrying its citations, or a figure); a sentence the person typed is never replaced.
 * Filling the box never starts a run.
 */
export function withPastedText(draft: SourceDraft, text: string): SourceDraft {
  const removed = removalsStillPasted(text, draft.removed);
  const picked = !draft.claim.trim() || (draft.claimFilled !== undefined && draft.claim === draft.claimFilled);
  if (!picked) return { ...draft, text, removed, claimFilled: undefined };
  const sentence = suggestedClaim(text);
  if (sentence) return { ...draft, text, removed, claim: sentence, claimFilled: sentence };
  // The answer was cleared or has no checkable sentence left: Echo's own pick goes with it.
  return { ...draft, text, removed, ...(draft.claimFilled !== undefined ? { claim: "", claimFilled: undefined } : {}) };
}

/**
 * The links a draft would send: every address in the text, once, minus the removed ones, at most 20, each with the
 * citation number the pasted answer gave it ("[2] https://…"; 1..N when it numbers none). A removed link's number is
 * not reused, so the chips keep the answer's own numbering.
 */
export function draftUrls(draft: SourceDraft): { urls: string[]; numbers: number[]; leftOut: number; removedHere: number; overlong: number } {
  return pastedLinks(draft.text, draft.removed);
}

/**
 * How many of a draft's links Echo will not read (a private or local address, an IPv6 address, a username or password),
 * judged from their text with the server's own rules. While any is listed the Check button stays disabled, so a list
 * the server would refuse is never sent.
 */
export function unreadableDraftLinks(draft: SourceDraft): number {
  return draftUrls(draft).urls.filter((url) => unreadableAddressReason(url) !== null).length;
}

function shortAddress(url: string): string {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
    // The host keeps its port ("[2606:4700::1111]:8443"), so the chip shows the address that will be refused.
    return `${parsed.host.replace(/^www\./, "")}${rest.length > 34 ? `${rest.slice(0, 33)}…` : rest}`;
  } catch {
    return url;
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function SourceCheckPanel({ draft, onChange, onClose, action, saved, disabled = false, focusText = false }: {
  draft: SourceDraft;
  onChange: (draft: SourceDraft) => void;
  onClose: () => void;
  /** The workbench's run button. */
  action: ReactNode;
  /** The saved run of the example's links ("Saved check: 5 links → 1 origin"): opens the bundled result, runs nothing. */
  saved?: { label: string; title: string; onOpen: () => void };
  disabled?: boolean;
  /** Opened from its button: the paste box takes the focus as it appears (a ?urls= link leaves the focus alone). */
  focusText?: boolean;
}) {
  const { urls, numbers, leftOut, removedHere, overlong } = draftUrls(draft);
  // Links Echo will not read (a private or local address, a username or password), judged from the text with the
  // server's own rules; the server still decides when the button is pressed.
  const unreadable = urls.map(unreadableAddressReason);
  const unreadableCount = unreadable.filter(Boolean).length;
  const panel = useRef<HTMLElement>(null);
  // Opened from a ?urls= link (no focus asked for), the panel scrolls into view so its sentence and button are on
  // screen. It takes no focus and runs nothing.
  useEffect(() => {
    if (!focusText) panel.current?.scrollIntoView?.({ block: "nearest" });
    // Once, as the panel appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section aria-label="Check these sources" className={styles.panel} id="source-check" ref={panel}>
      <div className={styles.head}>
        <span className={styles.label}><span>02</span> CHECK THESE SOURCES</span>
        <button aria-label="Close Check these sources" className={styles.close} onClick={onClose} type="button">×</button>
      </div>
      <p className={styles.note}>Paste an AI answer with its links, or a list of links. Echo reads only those pages (no web search) and shows how many independent origins they come from. Nothing runs until you press the button.</p>
      <div className={styles.fieldRow}>
        <label className={styles.fieldLabel} htmlFor="source-check-text">Answer or links</label>
        {/* Only into an empty box, so it never replaces what someone pasted; it fills the panel and runs nothing. */}
        <span className={styles.fieldActions}>
          {!draft.text.trim() && <button className={styles.example} disabled={disabled} onClick={() => onChange({ text: SAMPLE_SOURCES_ANSWER, removed: [], claim: SAMPLE_SOURCES_CLAIM })} type="button">Try an example (a sample answer)</button>}
          {/* Always offered: it opens the saved result of the example's links, whatever the boxes hold, and runs nothing. */}
          {saved && <button className={`${styles.example} ${styles.savedCheck}`} disabled={disabled} onClick={saved.onOpen} title={saved.title} type="button">{saved.label} <span aria-hidden="true">↗</span></button>}
        </span>
      </div>
      <textarea
        autoFocus={focusText}
        className={styles.text}
        disabled={disabled}
        id="source-check-text"
        onChange={(event) => onChange(withPastedText(draft, event.target.value))}
        placeholder={"Paste the answer here, links included…\nhttps://example.com/article-one\nhttps://example.org/article-two"}
        rows={4}
        value={draft.text}
      />
      {urls.length > 0 ? (
        <ul aria-label="Links Echo will read" className={styles.chips}>
          {urls.map((url, index) => (
            <li className={unreadable[index] ? `${styles.chip} ${styles.chipWarn}` : styles.chip} data-unreadable={unreadable[index] ?? undefined} key={url} title={url}>
              <b className={styles.number}>[{numbers[index]}]</b>
              <span>{shortAddress(url)}</span>
              {unreadable[index] && <small className={styles.chipNote}>{unreadable[index] === "credentials" ? "has a username or password — Echo won't read it" : unreadable[index] === "ipv6" ? "an IPv6 address — Echo won't read it" : "not a public address — Echo won't read it"}</small>}
              <button aria-label={`Remove [${numbers[index]}] ${hostOf(url)}`} disabled={disabled} onClick={() => onChange({ ...draft, removed: [...draft.removed, pageKey(url)] })} type="button">×</button>
            </li>
          ))}
        </ul>
      ) : !removedHere && <p className={styles.empty}>{draft.text.trim() ? "No http or https links found in the pasted text yet." : "Links you paste show here; remove any you do not want checked."}</p>}
      {removedHere > 0 && <p className={styles.empty}>{plural(removedHere, "link", "links")} removed from this paste. <button className={styles.undo} disabled={disabled} onClick={() => onChange({ ...draft, removed: [] })} type="button">Undo</button></p>}
      {unreadableCount > 0 && <p className={styles.warn}>Echo won&apos;t read {unreadableCount === 1 ? "1 of these links" : `${unreadableCount} of these links`}: it reads only public web addresses without a username or password, and refuses a list that includes such a link.{unreadable.includes("ipv6") ? " It does not read links to an IPv6 address either." : ""} Remove {unreadableCount === 1 ? "it" : "them"} to check the rest.</p>}
      {leftOut > 0 && <p className={styles.warn}>Echo reads at most {MAX_SUPPLIED_URLS} links at once; {plural(leftOut, "more link was", "more links were")} left out. Remove some to include them.</p>}
      {overlong > 0 && <p className={styles.warn}>{plural(overlong, "link is", "links are")} longer than {MAX_SUPPLIED_URL_LENGTH.toLocaleString("en-US")} characters and left out; paste the page&apos;s own address instead.</p>}
      <label className={styles.fieldLabel} htmlFor="source-check-claim">The sentence to check</label>
      <div className={styles.row}>
        <input
          autoComplete="off"
          className={styles.claim}
          disabled={disabled}
          id="source-check-claim"
          maxLength={500}
          onChange={(event) => onChange({ ...draft, claim: event.target.value })}
          placeholder="The claim the answer makes, e.g. “Americans check their phones 96 times a day”"
          value={draft.claim}
        />
        {action}
      </div>
      {draft.claimFilled !== undefined && draft.claim === draft.claimFilled && <p className={styles.picked}>Picked from the pasted answer. Edit it to check another sentence.</p>}
      {/* Links pasted but no sentence picked from them (or a sentence too short to check): say what the button waits for. */}
      {urls.length > 0 && draft.claim.trim().length < 8 && <p className={styles.picked} role="status">Type the sentence to check; the button waits for it.</p>}
      {/* A link Echo will not read keeps the button disabled (the server would refuse the whole list): say so. */}
      {unreadableCount > 0 && <p className={styles.picked} role="status">Remove the {unreadableCount === 1 ? "link" : `${unreadableCount} links`} Echo won&apos;t read; the button waits for that.</p>}
      <p className={styles.fine}>A citation shows where an answer got a claim; it is not proof the claim is true. Echo judges which of these pages copied which; pages outside this list are not searched.</p>
    </section>
  );
}

/**
 * The home page's second action, beside the claim box's label: a bordered button that opens the panel (or, when it is
 * already open, puts the focus in its paste box). It never runs anything.
 */
export function SourceCheckOpenButton({ onOpen, open = false }: { onOpen: () => void; open?: boolean }) {
  return (
    <button aria-controls={open ? "source-check" : undefined} aria-expanded={open} className={styles.open} id="source-check-open" onClick={onOpen} title="Paste an AI answer or a list of links: Echo reads only those pages, with no web search. Nothing runs until you press Check." type="button">
      Check an AI answer&apos;s links <span aria-hidden="true">{open ? "↓" : "→"}</span>
    </button>
  );
}

/**
 * The one verdict card of a supplied-sources result (the generic verdict banner is not shown for one): the headline
 * "5 supplied links → 1 independent origin" with its three tiles in supplied-links words (links read, independent
 * origins, with own evidence), what Echo read, each link's verdict, the plain line and which links to cite once.
 */
export function SourceCheckSummary({ result }: { result: EchoAnalysis }) {
  if (!result.sourceCheck) return null;
  const headline = sourceCheckHeadline(result);
  const supplied = result.sourceCheck.urls.length;
  const read = supplied - (result.sourceCheck.unreadUrls ?? []).length;
  const { independentOrigins: origins, verifiableOrigins: withEvidence } = result.summary;
  return (
    <section aria-label="Supplied sources result" className={styles.summary}>
      <div className={styles.summaryHead}>
        <div className={styles.summaryCopy}>
          <p className={styles.label}><span>CHECK THESE SOURCES</span></p>
          <h2 className={styles.headline}>
            {headline.text}
            {headline.evidence && <small>{headline.evidence}</small>}
          </h2>
        </div>
        <div aria-label="Supplied links at a glance" className={styles.tiles} role="group">
          <div><strong>{read}</strong><span>{read === supplied ? (supplied === 1 ? "link read" : "links read") : `of ${supplied} links read`}</span></div>
          <div><strong>{origins}</strong><span>{origins === 1 ? "independent origin" : "independent origins"}</span></div>
          <div><strong>{withEvidence}</strong><span>with own evidence</span></div>
        </div>
      </div>
      <p className={styles.note}>{sourceCheckReadLine(result)}</p>
      <SourceLinkList result={result} />
      <p className={styles.fine}>A citation identifies a supplied source, not proof of the claim. Independent origins are counted among these links only; the trace below shows each judgment.</p>
    </section>
  );
}

/**
 * "Cite once: [1] asurion.com (also published as [2]). Repeats it: [3], [5]. Unclear: [4]." under the per-link list,
 * with Copy (that line) and Show as data (the same result as JSON). Built from the per-link rows; it changes nothing.
 */
function CiteOnce({ result }: { result: EchoAnalysis }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [showData, setShowData] = useState(false);
  const dataId = useId();
  const cite = sourceCiteOnce(result);
  const data = sourceCiteOnceData(result);
  if (!cite || !data) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cite.line);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    window.setTimeout(() => setCopyState("idle"), 1_800);
  };
  return (
    <div aria-label="Which links to cite once" className={styles.cite} role="group">
      <div className={styles.citeRow}>
        <p className={styles.citeLine}>{cite.line}</p>
        <div className={styles.citeActions}>
          <button aria-label="Copy the cite-once line" className={styles.citeButton} onClick={() => void copy()} type="button">{copyState === "copied" ? "Copied" : copyState === "error" ? "Copy unavailable" : "Copy"}</button>
          <button aria-controls={dataId} aria-expanded={showData} className={styles.citeButton} onClick={() => setShowData((open) => !open)} type="button">{showData ? "Hide data" : "Show as data"}</button>
        </div>
      </div>
      {showData && (
        <div className={styles.citeData} id={dataId}>
          <p>The same result as data, for tools that use citations</p>
          <pre tabIndex={0}>{data}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * Each supplied link in the order it was pasted, with its citation number and what the trace found for it ("[3]
 * fox13seattle.com — copy of [2]"), then the one line that makes the point. Read from the trace alone.
 */
function SourceLinkList({ result }: { result: EchoAnalysis }) {
  const rows = sourceLinkRows(result);
  if (!rows.length) return null;
  return (
    <>
      <ol aria-label="Each supplied link" className={styles.links}>
        {rows.map((row) => (
          <li data-status={row.status} key={row.url}>
            <b className={styles.number}>[{row.number}]</b>
            <a href={row.url} rel="noreferrer" target="_blank" title={row.url}>{row.host}</a>
            <span aria-hidden="true" className={styles.dash}>—</span>
            <span className={styles.verdict}>{row.verdict}</span>
          </li>
        ))}
      </ol>
      <p className={styles.point}>{sourceCheckPoint(result)}</p>
      <CiteOnce result={result} />
    </>
  );
}

/**
 * Present slide 1 for a supplied-sources result: the claim, "5 supplied links → 1 independent origin", every link with
 * its citation number and verdict (two columns from six links), the one plain line, and under it the Cite once line
 * (sourceCiteOnce: which links to cite once, the same words as the result page). On a short screen (a 720p
 * projector with the browser bar showing) a list of more than STAGE_SHORT_LINKS keeps its first STAGE_SHORT_LINKS - 1
 * and says how many more, so the slide never scrolls. Read from the trace alone, like the card on the result page.
 */
const STAGE_SHORT_LINKS = 14;

export function StageSourcesClaim({ result }: { result: EchoAnalysis }) {
  if (!result.sourceCheck) return null;
  const headline = sourceCheckHeadline(result);
  const rows = sourceLinkRows(result);
  const cite = sourceCiteOnce(result);
  const collapse = rows.length > STAGE_SHORT_LINKS;
  const keep = STAGE_SHORT_LINKS - 1;
  return (
    <article aria-label="The claim and the supplied links" className={`stage-claim-slide ${styles.stage}`}>
      <span className="stage-kicker">CHECK THESE SOURCES · SUPPLIED LINKS, NO WEB SEARCH</span>
      <h1 title={result.claim}>{result.claim}</h1>
      <div className="stage-hero-verdict">
        <span>WHAT THE SUPPLIED LINKS SHOW</span>
        <strong>{headline.text}{headline.evidence && <small className={styles.stageEvidence}>{headline.evidence}</small>}</strong>
        <p>{sourceCheckReadLine(result, { listUnread: false })}</p>
      </div>
      {rows.length > 0 && <ol aria-label="Supplied links on this slide" className={styles.stageLinks} data-columns={rows.length > 5 ? "2" : "1"}>
        {rows.map((row, index) => (
          <li className={collapse && index >= keep ? styles.stageExtra : undefined} data-status={row.status} key={row.url} title={`[${row.number}] ${row.url} — ${row.verdict}`}>
            <b className={styles.number}>[{row.number}]</b><span className={styles.stageHost}>{row.host}</span><span aria-hidden="true" className={styles.dash}>—</span><span className={styles.verdict}>{row.verdict}</span>
          </li>
        ))}
      </ol>}
      {collapse && <p className={styles.stageMore}>+{rows.length - keep} more supplied links (all of them are on the result page and in the report)</p>}
      <p className={styles.stagePoint}>{sourceCheckPoint(result)}</p>
      {cite && <p className={styles.stageCite} data-cite-once="">{cite.line}</p>}
    </article>
  );
}

/**
 * The printed report's section for a supplied-sources result: what Echo read (no web search), each link with its
 * number, verdict and address, and the plain line. It sits under the printed verdict.
 */
export function PrintSourceLinks({ result }: { result: EchoAnalysis }) {
  if (!result.sourceCheck) return null;
  const rows = sourceLinkRows(result);
  return (
    <section aria-label="Checked supplied links" className={styles.print}>
      <h3>Checked supplied links (no web search)</h3>
      <p className={styles.printRead}>{sourceCheckReadLine(result, { listUnread: false })}</p>
      {rows.length > 0 && <ol className={styles.printLinks} data-columns={rows.length > 6 ? "2" : "1"}>
        {rows.map((row) => <li key={row.url}><b>[{row.number}] {row.host}</b> — {row.verdict}<small>{row.url}</small></li>)}
      </ol>}
      <p className={styles.printPoint}>{sourceCheckPoint(result)}</p>
    </section>
  );
}
