import fs from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { parsePortableTrace } from "@/lib/echo/portable";
import { providerList } from "@/lib/echo/search-providers";
import { MAX_SUPPLIED_URLS, sourceCheckHeadline, sourceCiteOnce } from "@/lib/echo/supplied-urls";
import type { EchoAnalysis, EchoPage } from "@/lib/echo/types";
import { bundledRunLink, PRESETS, SAVED_SOURCE_CHECK, traceSlug } from "../demo-slots";
import { datePrecision, dayNumberOf, plainSearchLineage, reliablyDatedPages, spreadDateLabel } from "../trace-view";
import styles from "./how.module.css";

export const metadata: Metadata = {
  title: "How Echo works",
  description: "Two ways in: trace a claim across the web in four steps (search, group, who copied whom, answer from the origins only), or check the links an AI answer cites.",
};

// Every figure, page and date on this page is read from the bundled phones run at build time, never typed in.
const EXAMPLE = PRESETS.find((preset) => preset.id === "phones");

async function readExample(): Promise<{ analysis: EchoAnalysis; link: string } | null> {
  const trace = EXAMPLE?.capturedTrace;
  const link = trace ? bundledRunLink(trace) : null;
  if (!trace || !link) return null;
  try {
    const analysis = parsePortableTrace(JSON.parse(await fs.readFile(path.join(process.cwd(), "public", trace), "utf8")));
    return analysis?.mode === "live" ? { analysis, link } : null;
  } catch {
    return null;
  }
}

/** The saved Check these sources run, read the same way, and the link that opens it; null when it does not load. */
async function readSavedCheck(): Promise<{ analysis: EchoAnalysis; link: string } | null> {
  try {
    const analysis = parsePortableTrace(JSON.parse(await fs.readFile(path.join(process.cwd(), "public", SAVED_SOURCE_CHECK.savedTrace), "utf8")));
    return analysis?.mode === "live" && analysis.sourceCheck ? { analysis, link: `/?trace=${traceSlug(SAVED_SOURCE_CHECK.savedTrace)}` } : null;
  } catch {
    return null;
  }
}

/** "Nov 21, 2019", "Nov 2019" or "2019", as precise as the page's own date; null without a reliable one. */
function shownDate(page: EchoPage, reliable: Set<string>): string | null {
  if (!page.publishedDate || !reliable.has(page.id)) return null;
  const precision = datePrecision(page.publishedDate);
  return precision === "year" ? page.publishedDate : spreadDateLabel(dayNumberOf(page.publishedDate), precision === "day");
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const bareDomain = (page: EchoPage) => page.domain.replace(/^www\./, "");

function PageLine({ page, reliable }: { page: EchoPage; reliable: Set<string> }) {
  const date = shownDate(page, reliable);
  return <><b>{bareDomain(page)}</b> <span className={styles.date}>{date ?? "no reliable date"}</span></>;
}

export default async function How() {
  const [example, savedCheck] = await Promise.all([readExample(), readSavedCheck()]);
  if (!example) {
    return (
      <main className={styles.page}>
        <Link className={styles.back} href="/">← Echo</Link>
        <h1 className={styles.title}>How Echo works</h1>
        <p className={styles.lede}>The saved example run is not available in this build. Open Echo and trace a claim to see each step.</p>
      </main>
    );
  }
  const { analysis, link } = example;
  const pagesById = new Map(analysis.pages.map((page) => [page.id, page] as const));
  const reliable = new Set(reliablyDatedPages(analysis).map((page) => page.id));
  const plain = plainSearchLineage(analysis);
  const searched = (analysis.searchAudit ?? []).filter((entry) => entry.status === "searched").length;
  const routedByTelem = (analysis.searchAudit ?? []).some((entry) => entry.status === "searched" && entry.router === "telem");
  // The pages the first search (the claim as typed) returned and Echo kept, in its own order.
  const firstPages = [...new Set(analysis.searchAudit?.[0]?.pageIds ?? [])].map((id) => pagesById.get(id)).filter((page): page is EchoPage => Boolean(page));
  const groups = [...analysis.clusters].sort((a, b) => b.pageIds.length - a.pageIds.length);
  // Confirmed copies, reliably dated ones first and oldest first, so the list reads as the claim spreading.
  const datedOrder = new Map(reliablyDatedPages(analysis).map((page, index) => [page.id, index] as const));
  const copies = analysis.pages
    .filter((page) => page.judgment.kind === "derived" && page.judgment.parentId && pagesById.has(page.judgment.parentId))
    .sort((a, b) => (datedOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (datedOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const unclear = analysis.pages.filter((page) => page.judgment.kind === "unclear").length;
  // The rows past the first three, so each step's list adds up to the trace's own totals.
  const moreGroups = groups.slice(3);
  const moreGroupPages = moreGroups.reduce((total, group) => total + group.pageIds.length, 0);
  const moreCopies = copies.slice(3);
  // How a confirmed copy's link was settled: the page cites its parent, or it is dated after it.
  const linkBasis = (page: EchoPage) => (page.citations ?? []).some((citation) => citation.pageId === page.judgment.parentId) ? "linked by citation" : reliable.has(page.id) && reliable.has(page.judgment.parentId ?? "") ? "dated after it" : null;
  // Roots published together count once, as in the trace.
  const groupOf = new Map<string, number>();
  (analysis.coPublishedRootGroups ?? []).forEach((group, index) => group.forEach((id) => groupOf.set(id, index)));
  const origins: EchoPage[][] = [];
  for (const id of analysis.roots) {
    const page = pagesById.get(id);
    if (!page) continue;
    const index = groupOf.get(id);
    const existing = index === undefined ? undefined : origins.find((origin) => origin.some((other) => groupOf.get(other.id) === index));
    if (existing) existing.push(page);
    else origins.push([page]);
  }
  const firstStatement = analysis.answerStatements?.[0];
  const cited = (firstStatement?.sourceIds ?? []).map((id) => pagesById.get(id)).filter((page): page is EchoPage => Boolean(page));
  const quoted = (text: string) => text.trim().replace(/[.。]+$/, "");
  const checkHeadline = savedCheck ? sourceCheckHeadline(savedCheck.analysis) : null;
  const checkCiteOnce = savedCheck ? sourceCiteOnce(savedCheck.analysis) : null;
  const captured = new Date(analysis.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });

  return (
    <main className={styles.page}>
      <Link className={styles.back} href="/">← Echo</Link>
      <p className={styles.kicker}>HOW ECHO WORKS</p>
      <h1 className={styles.title}>Many pages, few sources, in four steps.</h1>
      <p className={styles.lede}>
        Echo traces a claim across the web, or checks the links an AI answer cites. Below, a trace in four steps, read from one real
        saved run: “{quoted(analysis.claim)}”, captured {captured}.
      </p>
      <ol className={styles.steps}>
        <li className={styles.step}>
          <span className={styles.number}>01 · SEARCH</span>
          <h2>Find the pages that repeat it</h2>
          <p>
            Echo searches the claim and reworded variants (routed by Telem across search engines when a Telem key is set, by Tavily otherwise; this run: {routedByTelem ? "Telem" : "Tavily"}), then reads each page.
            The first search is the claim as typed{plain ? <>. It returned {plural(plain.returned, "result", "results")}, and Echo kept {plain.kept === 1 ? "this one" : `these ${plain.kept}`}</> : null}:
          </p>
          <ul className={styles.list}>
            {firstPages.map((page) => <li key={page.id}><PageLine page={page} reliable={reliable} /></li>)}
            <li className={styles.muted}>{searched > 1 ? `${plural(searched - 1, "more search brings", "more searches bring")} the trace to ` : "The trace has "}{plural(analysis.summary.totalPages, "page", "pages")} about the claim</li>
          </ul>
          <Link className={styles.open} href={link}>See the searches in the trace →</Link>
        </li>
        <li className={styles.step}>
          <span className={styles.number}>02 · GROUP</span>
          <h2>Group pages that say the same thing</h2>
          <p>Claude groups the pages by the assertion they make, so each repeat is compared with the pages saying the same thing.</p>
          <ul className={styles.list}>
            {groups.slice(0, 3).map((group) => <li key={group.id}><b>{plural(group.pageIds.length, "page", "pages")}</b> “{group.label}”</li>)}
            {moreGroups.length > 0 && <li className={styles.muted}>+{plural(moreGroups.length, "more group", "more groups")} ({plural(moreGroupPages, "page", "pages")})</li>}
          </ul>
          <Link className={styles.open} href={link}>See the pages in the trace →</Link>
        </li>
        <li className={styles.step}>
          <span className={styles.number}>03 · WHO COPIED WHOM</span>
          <h2>Link each copy to an earlier page</h2>
          <p>From dates, citations and shared wording, Claude proposes which page each one repeats. Fixed rules keep a link only when the copy cites its parent or is reliably dated after it.</p>
          <ul className={styles.list}>
            {copies.slice(0, 3).map((page) => {
              const parent = pagesById.get(page.judgment.parentId!)!;
              return <li key={page.id}><PageLine page={page} reliable={reliable} /> <span className={styles.arrow}>repeats</span> <PageLine page={parent} reliable={reliable} /></li>;
            })}
            {moreCopies.length > 0 && <li className={styles.muted}>+{plural(moreCopies.length, "more copy", "more copies")} ({moreCopies.map((page) => [bareDomain(page), linkBasis(page)].filter(Boolean).join(", ")).join("; ")})</li>}
            {unclear > 0 && <li className={styles.muted}>{plural(unclear, "page stays", "pages stay")} unclear: no confirmed link (dashed in the tree)</li>}
          </ul>
          <Link className={styles.open} href={link}>See the family tree →</Link>
        </li>
        <li className={styles.step}>
          <span className={styles.number}>04 · ANSWER FROM ORIGINS ONLY</span>
          <h2>Answer from the origins, not the crowd</h2>
          <p>
            {plural(analysis.summary.totalPages, "page", "pages")} come down to {plural(analysis.summary.independentOrigins, "independent origin", "independent origins")}. Only those are given to the answer; the copies are left out. Each number it states is checked against the passages it cites.
          </p>
          <ul className={styles.list}>
            {origins.map((group) => <li key={group[0].id}>{group.map((page, index) => <span key={page.id}>{index ? " + " : ""}<PageLine page={page} reliable={reliable} /></span>)}{group.length > 1 ? <span className={styles.muted}> (published together, counted once)</span> : null}</li>)}
          </ul>
          {firstStatement && <blockquote className={styles.quote}>“{firstStatement.text}.”{cited.length ? <cite> {cited.map(bareDomain).join(", ")}</cite> : null}</blockquote>}
          <Link className={styles.open} href={link}>Read the answer in the trace →</Link>
        </li>
      </ol>
      <section aria-labelledby="check" className={styles.check}>
        <span className={styles.number}>THE OTHER WAY IN · CHECK THESE SOURCES</span>
        <h2 id="check">Check an AI answer’s links</h2>
        <ul>
          <li><b>Only the links you paste.</b> Paste an AI answer with its links (up to {MAX_SUPPLIED_URLS}) and the sentence to check. Echo reads those pages and runs no new search.</li>
          <li><b>A verdict per link.</b> Each link keeps the answer’s citation number: independent origin, published together, copy, possible copy, or could not be read.</li>
          <li><b>Cite once.</b> One line says which links to cite and which only repeat them.</li>
        </ul>
        {savedCheck && checkHeadline?.text ? (
          <p className={styles.checkExample}>
            Saved check of the same claim: <b>{checkHeadline.text}</b>{checkHeadline.evidence ? ` (${checkHeadline.evidence})` : ""}.{checkCiteOnce ? ` ${checkCiteOnce.line}` : ""}{" "}
            <Link className={styles.open} href={savedCheck.link}>Open the saved check →</Link>
          </p>
        ) : null}
      </section>
      <section aria-labelledby="limits" className={styles.limits}>
        <h2 id="limits">What Echo does not claim</h2>
        <ul>
          <li><b>A citation is not proof.</b> It identifies the source a page names or links, or a link an answer supplies; it does not show the claim is true.</li>
          <li><b>A “possible copy” is not a confirmed copy.</b> Claude saw a likely link, but no citation or reliable date order confirms it, so it stays dashed.</li>
          <li><b>Origins are scoped to the pages Echo found</b> (or the links you supplied). An independent origin is the best-supported starting point among them, not the first page on the whole web.</li>
          <li><b>Results vary between runs.</b> Searches return different pages and Claude can judge them differently; each saved run is one capture.</li>
          <li><b>The labels are AI-made.</b> The runs Echo is checked against were labelled by an AI reading the full pages, not by a person.</li>
          <li><b>No comparison with Google.</b> “Plain search” means {plain?.router === "telem" ? <>the first search for the claim as typed, routed by Telem{plain.providers?.length ? ` to ${providerList(plain.providers)}` : ""}</> : "Tavily’s first search for the claim as typed"}{plain ? <>: “{quoted(plain.query)}”</> : null}. It is one search, not Google’s results or every search engine.</li>
        </ul>
      </section>
      <div className={styles.cta}>
        <Link className={styles.primary} href={link}>Open this trace</Link>
        <Link className={styles.secondary} href="/explore">Explore more saved runs</Link>
        <Link className={styles.secondary} href="/">Trace your own claim</Link>
      </div>
    </main>
  );
}
