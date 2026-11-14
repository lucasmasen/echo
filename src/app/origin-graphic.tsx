"use client";

import { useMemo, useState, type ReactNode } from "react";
import { claimMutation, comparePrompts, ORIGIN_TYPE_LABELS, SCORE_SCALE, type OriginType, type TokenComparison } from "@/lib/echo/origin-layer";
import { originFlow, type FlowKind, type FlowPage } from "@/lib/echo/origin-flow";
import { providerDisplayName, providerList } from "@/lib/echo/search-providers";
import type { EchoAnalysis } from "@/lib/echo/types";
import { upstreamHints } from "@/lib/echo/upstream";
import { foldUpstream } from "@/lib/echo/upstream-fold";
import { savedUpstreamFor } from "./origin-upstream";
import styles from "./origin-graphic.module.css";

// The origin layer as one graphic: the score with its meter, a flow diagram (search engines → pages → independent
// origins), what each engine added, the copy tree with each page's own wording, and the token comparison drawn to
// scale. Everything but the comparison is computed from the trace in the browser. Page kinds use three colors checked
// for color-vision separation and contrast on this surface (green origin, blue copy, amber outline for unplaced), and
// every mark also carries a text label, so no meaning rests on color alone.

const KIND_LABEL: Record<FlowKind, string> = { origin: "Origin page", copy: "Confirmed copy", unplaced: "Not tied to an origin" };

const TYPE_TONE: Record<OriginType, string> = {
  primary_document: styles.typeStrong,
  original_reporting: styles.typeStrong,
  official_statement: styles.typeMid,
  press_release: styles.typeWeak,
  anonymous_source: styles.typeWeak,
  social_post: styles.typeWeak,
  unknown: styles.typeUnknown,
};

function shortDate(date: string | null): string {
  return date ? date.slice(0, 10) : "undated";
}

/**
 * A page's date as the rest of Echo shows it: a search engine's own estimate is never printed as a date, only named
 * ("search estimate"), because it cannot order two pages.
 */
function dateLabeller(result: EchoAnalysis): (pageId: string, date: string | null) => string {
  const estimated = new Set(result.pages.filter((page) => page.publishedDate && page.publishedDateSource === "Tavily estimate").map((page) => page.id));
  return (pageId, date) => (estimated.has(pageId) ? "search estimate" : shortDate(date));
}

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

// Flow diagram geometry, in viewBox units (the SVG scales to its container).
const VIEW_WIDTH = 1000;
const ROW = 27;
const PILL_HEIGHT = 21;
const GROUP_GAP = 12;
const TOP = 34;
const ENGINE_BOX = { width: 156, height: 36 };
const ORIGIN_BOX = { width: 252, height: 60 };

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const mid = (x1 + x2) / 2;
  return `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
}

function FlowDiagram({ result, active, onActive, onSelect }: { result: EchoAnalysis; active: string | null; onActive: (id: string | null) => void; onSelect?: (id: string) => void }) {
  // The judge's notes name pages by their id in the run ("page-12"); on screen that id means nothing, so show the site.
  const readable = (note: string) => note.replace(/\bpage-\d+\b/g, (id) => result.pages.find((page) => page.id === id)?.domain.replace(/^www\./, "") ?? "another page in this run");
  const flow = useMemo(() => originFlow(result), [result]);
  const dateOf = useMemo(() => dateLabeller(result), [result]);
  const [engineFocus, setEngineFocus] = useState<string | null>(null);
  const hasEngines = flow.engines.length > 0;
  const pillX = hasEngines ? 318 : 150;
  const pillWidth = 236;
  const originX = VIEW_WIDTH - ORIGIN_BOX.width;

  // Vertical places: pages in order, with a gap where the origin group changes and before the unplaced pages.
  const pageY = new Map<string, number>();
  let y = TOP;
  let previousGroup: string | null | undefined;
  let groupStart = TOP;
  for (const page of flow.pages) {
    const group = page.originId;
    if (previousGroup !== undefined && group !== previousGroup) {
      // A group with an origin is at least as tall as its origin box, so each box sits level with its own pages.
      y = Math.max(y + GROUP_GAP, previousGroup ? groupStart + ORIGIN_BOX.height + 10 : 0);
      groupStart = y;
    }
    pageY.set(page.id, y + PILL_HEIGHT / 2);
    y += ROW;
    previousGroup = group;
  }
  const pagesBottom = y;
  // Each origin sits level with the middle of its own pages and copies, never overlapping the origin above it.
  const originY = new Map<string, number>();
  let floor = TOP + ORIGIN_BOX.height / 2;
  for (const origin of flow.origins) {
    const ys = flow.pages.filter((page) => page.originId === origin.id).map((page) => pageY.get(page.id)!);
    const centre = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : floor;
    const at = Math.max(centre, floor);
    originY.set(origin.id, at);
    floor = at + ORIGIN_BOX.height + 10;
  }
  const originsBottom = flow.origins.length ? floor - 10 - ORIGIN_BOX.height / 2 : TOP;
  const enginesHeight = flow.engines.length * (ENGINE_BOX.height + 14);
  const height = Math.max(pagesBottom, originsBottom, TOP + enginesHeight) + 10;
  const engineY = new Map<string, number>();
  flow.engines.forEach((row, index) => {
    const band = (height - TOP - 10) / flow.engines.length;
    engineY.set(row.engine, TOP + band * (index + 0.5));
  });
  const unplaced = flow.pages.filter((page) => page.kind === "unplaced");
  const unplacedMid = unplaced.length ? (pageY.get(unplaced[0].id)! + pageY.get(unplaced[unplaced.length - 1].id)!) / 2 : 0;
  const activePage = active ? flow.pages.find((page) => page.id === active) ?? null : null;
  const lit = (page: FlowPage) => (activePage ? activePage.id === page.id || (activePage.originId !== null && activePage.originId === page.originId) : engineFocus ? page.engines.includes(engineFocus) : true);

  return (
    <figure className={styles.flow}>
      <svg aria-label={`Flow diagram: ${hasEngines ? `${plural(flow.engines.length, "search engine", "search engines")}, ` : ""}${plural(flow.pages.length, "page", "pages")} Echo kept about the claim, of which ${plural(flow.counts.origin, "is an origin page", "are origin pages")}, ${plural(flow.counts.copy, "is a confirmed copy", "are confirmed copies")} and ${flow.counts.unplaced} not tied to an origin, leading to ${plural(flow.origins.length, "independent origin", "independent origins")}.`} className={styles.flowSvg} role="img" viewBox={`0 0 ${VIEW_WIDTH} ${height}`}>
        {hasEngines && <text className={styles.columnHead} x={0} y={14}>ENGINES VIA TELEM · PAGES KEPT</text>}
        <text className={styles.columnHead} x={pillX} y={14}>{flow.pages.length} {result.sourceCheck ? "LINKS READ" : "PAGES ABOUT THE CLAIM"}</text>
        <text className={styles.columnHead} x={originX} y={14}>{flow.origins.length} {flow.layer.entities === flow.origins.length ? "INDEPENDENT " : ""}{flow.origins.length === 1 ? "ORIGIN" : "ORIGINS"}{flow.layer.entities === flow.origins.length ? "" : ` · ${flow.layer.entities} ${flow.layer.entities === 1 ? "PUBLISHER" : "PUBLISHERS"}`}</text>

        {/* Links first, so the pills and boxes sit on top of them. */}
        {hasEngines && flow.pages.flatMap((page) => page.engines.map((engine) => {
          const on = engineFocus ? engineFocus === engine : activePage ? activePage.id === page.id : false;
          const quiet = (engineFocus !== null || activePage !== null) && !on;
          return <path className={`${styles.linkEngine} ${on ? styles.linkOn : ""} ${quiet ? styles.linkQuiet : ""}`} d={curve(ENGINE_BOX.width, engineY.get(engine)!, pillX, pageY.get(page.id)!)} key={`${engine}-${page.id}`} pathLength={1} />;
        }))}
        {flow.pages.filter((page) => page.originId).map((page) => (
          <path className={`${page.kind === "origin" ? styles.linkOrigin : styles.linkCopy} ${lit(page) ? "" : styles.linkQuiet}`} d={curve(pillX + pillWidth, pageY.get(page.id)!, originX, originY.get(page.originId!)!)} key={`to-origin-${page.id}`} pathLength={1} />
        ))}

        {/* Possible links Echo could not confirm: dashed, and never counted as copies. */}
        {flow.pages.filter((page) => page.possibleOriginId && originY.has(page.possibleOriginId)).map((page) => (
          <path className={`${styles.linkMaybe} ${activePage ? (activePage.id === page.id ? styles.linkMaybeOn : styles.linkQuiet) : engineFocus && !page.engines.includes(engineFocus) ? styles.linkQuiet : ""}`} d={curve(pillX + pillWidth, pageY.get(page.id)!, originX, originY.get(page.possibleOriginId!)!)} key={`maybe-${page.id}`} />
        ))}

        {flow.engines.map((row) => {
          const at = engineY.get(row.engine)!;
          return (
            <g className={`${styles.engineNode} ${engineFocus === row.engine ? styles.engineOn : ""}`} key={row.engine} onBlur={() => setEngineFocus(null)} onFocus={() => setEngineFocus(row.engine)} onMouseEnter={() => setEngineFocus(row.engine)} onMouseLeave={() => setEngineFocus(null)} tabIndex={0}>
              <title>{`${providerDisplayName(row.engine)}: ${plural(row.pages, "page", "pages")} kept; ${row.own + row.copies === 0 ? "none of them is or leads back to an origin, by this run’s record" : `${row.own + row.copies} of them ${row.own + row.copies === 1 ? "is or leads" : "are or lead"} back to ${plural(row.origins, "origin", "origins")}`}`}</title>
              <rect height={ENGINE_BOX.height} rx={8} width={ENGINE_BOX.width} x={0} y={at - ENGINE_BOX.height / 2} />
              <text className={styles.engineName} x={12} y={at + 4.5}>{providerDisplayName(row.engine)}</text>
              <text className={styles.engineCount} textAnchor="end" x={ENGINE_BOX.width - 12} y={at + 4.5}>{row.pages}</text>
            </g>
          );
        })}

        {flow.pages.map((page) => {
          const at = pageY.get(page.id)!;
          return (
            <g aria-label={`${page.domain}, ${KIND_LABEL[page.kind].toLowerCase()}`} className={`${styles.pill} ${styles[`pill_${page.kind}`]} ${lit(page) ? "" : styles.pillQuiet} ${active === page.id ? styles.pillOn : ""}`} key={page.id} onBlur={() => onActive(null)} onClick={() => onSelect?.(page.id)} onFocus={() => onActive(page.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect?.(page.id); } }} onMouseEnter={() => onActive(page.id)} onMouseLeave={() => onActive(null)} role="button" tabIndex={0}>
              <rect height={PILL_HEIGHT + 6} width={pillWidth} x={pillX} y={at - PILL_HEIGHT / 2 - 3} className={styles.pillHit} />
              <rect height={PILL_HEIGHT} rx={PILL_HEIGHT / 2} width={pillWidth} x={pillX} y={at - PILL_HEIGHT / 2} />
              <text x={pillX + 12} y={at + 4}>{clip(page.domain, 27)}</text>
              <text className={styles.pillDate} textAnchor="end" x={pillX + pillWidth - 10} y={at + 4}>{page.date && dateOf(page.id, page.date) !== "search estimate" ? page.date.slice(0, 4) : ""}</text>
            </g>
          );
        })}

        {unplaced.length > 0 && <text className={styles.laneNote} x={pillX + pillWidth + 16} y={unplacedMid + 4}>{`${unplaced.length} not tied to an origin`}</text>}

        {flow.origins.map((origin) => {
          const at = originY.get(origin.id)!;
          return (
            <g className={`${styles.originNode} ${activePage && activePage.originId === origin.id ? styles.originOn : ""}`} key={origin.id} onClick={() => onSelect?.(origin.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect?.(origin.id); } }} role="button" tabIndex={0}>
              <title>{`${origin.name}: ${ORIGIN_TYPE_LABELS[origin.type]}, ${origin.ownEvidence ? "shows evidence of its own" : "no evidence of its own"}, repeated by ${plural(origin.echoes, "page", "pages")}`}</title>
              <rect height={ORIGIN_BOX.height} rx={10} width={ORIGIN_BOX.width} x={originX} y={at - ORIGIN_BOX.height / 2} />
              <text className={styles.originName} x={originX + 14} y={at - 8}>{clip(origin.name, 26)}</text>
              <text className={styles.originMeta} x={originX + 14} y={at + 11}>{`${ORIGIN_TYPE_LABELS[origin.type]} · ${dateOf(origin.id, origin.date)}`}</text>
              <text className={styles.originMeta} x={originX + 14} y={at + 24}>{`${origin.ownEvidence ? "own evidence" : "no evidence of its own"} · ${plural(origin.echoes, "copy", "copies")}`}</text>
            </g>
          );
        })}
        {flow.origins.length === 0 && <text className={styles.laneNote} x={originX} y={TOP + 24}>No page was confirmed as an origin.</text>}
      </svg>

      <figcaption className={styles.flowFoot}>
        <ul className={styles.legend}>
          <li><span className={`${styles.swatch} ${styles.swatchOrigin}`} />Origin page ({flow.counts.origin})</li>
          <li><span className={`${styles.swatch} ${styles.swatchCopy}`} />Confirmed copy ({flow.counts.copy})</li>
          <li><span className={`${styles.swatch} ${styles.swatchUnplaced}`} />Not tied to an origin ({flow.counts.unplaced})</li>
          {flow.pages.some((page) => page.possibleOriginId) && <li><span className={styles.swatchMaybe} />Possible link, not confirmed ({flow.pages.filter((page) => page.possibleOriginId).length})</li>}
        </ul>
        <p aria-live="polite" className={styles.readout}>
          {activePage
            ? <><b>{activePage.domain}</b> · {dateOf(activePage.id, activePage.date)} · {activePage.kind === "origin" ? "an origin page" : activePage.kind === "copy" ? `a confirmed copy leading back to ${flow.origins.find((origin) => origin.id === activePage.originId)?.name ?? "an origin"}` : activePage.possibleOriginId ? `not tied to any origin: Echo saw a possible link to ${flow.origins.find((origin) => origin.id === activePage.possibleOriginId)?.name ?? "an origin"} ${activePage.possibleVia ? ` (through ${activePage.possibleVia}, itself a confirmed copy)` : ""} and could not confirm it` : activePage.copyOfUnplaced ? "a copy of a page Echo could not tie to an origin" : "not tied to any origin (no confirmed link)"}{activePage.engines.length ? ` · returned by ${providerList(activePage.engines)}` : ""}<span>{clip(activePage.title, 110)}</span>{activePage.note && <span className={styles.readoutNote}>The judge&apos;s saved note: {readable(activePage.note)}</span>}</>
            : <span>{hasEngines ? "Point at a page or an engine to trace its lines." : "Point at a page to trace its line."}{onSelect ? " Click a page to open its details." : ""}</span>}
        </p>
      </figcaption>

      <details className={styles.table}>
        <summary>Show the same data as a table</summary>
        <table>
          <thead><tr><th scope="col">Page</th><th scope="col">Date</th><th scope="col">Echo&apos;s verdict</th><th scope="col">Leads back to</th>{hasEngines && <th scope="col">Returned by</th>}<th scope="col">The judge&apos;s saved note</th></tr></thead>
          <tbody>
            {flow.pages.map((page) => <tr key={page.id}><td><a href={page.url} rel="noreferrer" target="_blank">{page.domain}</a></td><td>{dateOf(page.id, page.date)}</td><td>{KIND_LABEL[page.kind]}</td><td>{page.kind === "origin" ? "itself" : flow.origins.find((origin) => origin.id === page.originId)?.name ?? "no confirmed origin"}</td>{hasEngines && <td>{page.engines.length ? providerList(page.engines) : "not recorded"}</td>}<td>{page.note ? readable(page.note) : "none saved"}</td></tr>)}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function EngineList({ result }: { result: EchoAnalysis }) {
  const flow = useMemo(() => originFlow(result), [result]);
  if (!flow.engines.length) return null;
  const most = Math.max(...flow.engines.map((row) => row.pages));
  const needed = flow.needed;
  return (
    <section className={styles.block} data-jump="engines">
      <header className={styles.blockHead}>
        <span className="eyebrow">WHAT EACH ENGINE ADDED · ROUTED BY TELEM</span>
        <h3>{flow.marginal ?? `${providerDisplayName(flow.engines[0].engine)} answered this run: ${plural(flow.engines[0].pages, "page", "pages")}, ${plural(flow.engines[0].origins, "origin", "origins")}.`}</h3>
      </header>
      {flow.bill && (
        <dl className={styles.bill}>
          <div><dt>Searches sent through Telem</dt><dd>{flow.bill.searches}</dd></div>
          <div><dt>Engine runs Telem billed</dt><dd>{flow.bill.runs}</dd></div>
          <div><dt>Search cost, list price</dt><dd>${flow.bill.usd.toFixed(2)}</dd></div>
          <div className={styles.billResult}><dt>Independent origins Echo counted in those pages</dt><dd>{flow.origins.length}</dd></div>
        </dl>
      )}
      {needed && flow.engines.length > 1 && needed.needed > 0 && (
        <p className={styles.hindsight}><b>Engines this claim needed: {needed.needed} of {needed.of}.</b> That is the fewest engines whose pages together reach every origin Echo counted{flow.unrecordedOrigins > 0 ? " that has an engine on record" : ""}, found by trying every set against this run&apos;s record of which engine returned each page. It is hindsight on one run, among the engines whose pages Echo kept, and it is the signal Echo can hand back to a search router: whether a claim needs one engine or several.</p>
      )}
      <ul className={styles.engineRows}>
        {flow.engines.map((row) => (
          <li key={row.engine}>
            <span className={styles.engineRowName}>{providerDisplayName(row.engine)}</span>
            <span aria-hidden="true" className={styles.segments} style={{ width: `${Math.max(8, (row.pages / most) * 100)}%` }} title={`${row.own} origin ${row.own === 1 ? "page" : "pages"}, ${plural(row.copies, "copy", "copies")}, ${row.unplaced} not tied to an origin`}>
              {row.own > 0 && <i className={styles.segOrigin} style={{ flexGrow: row.own }} />}
              {row.copies > 0 && <i className={styles.segCopy} style={{ flexGrow: row.copies }} />}
              {row.unplaced > 0 && <i className={styles.segUnplaced} style={{ flexGrow: row.unplaced }} />}
            </span>
            <span className={styles.engineRowFigure}><b>{row.pages}</b> {row.pages === 1 ? "page" : "pages"} → <b>{row.origins}</b> {row.origins === 1 ? "origin" : "origins"}</span>
            <span className={styles.engineRowNew}>{flow.bill?.runsByEngine[row.engine] ? `${plural(flow.bill.runsByEngine[row.engine], "run", "runs")} · ` : ""}{row.onlyHere > 0 ? `${row.onlyHere} only here` : row.origins > 0 ? "none only here" : "no origin"}</span>
          </li>
        ))}
      </ul>
      {flow.idleEngines.length > 0 && <p className={styles.fine}>Also answered, with no page Echo kept: {flow.idleEngines.map((idle) => `${providerDisplayName(idle.engine)}${idle.runs > 0 ? ` (${plural(idle.runs, "run", "runs")} billed)` : ""}`).join(", ")}. “Needed” counts only engines with a kept page.</p>}
      <p className={styles.fine}>Counts are of the {flow.pages.length} pages Echo kept for this claim, not of every result the engines returned. Bars are split into origin pages, confirmed copies and pages not tied to an origin, in that order. “Only here” counts origins that no other engine’s pages reached in this run, so it does not depend on the order of the list. The record credits an engine with a page for the search that first returned that page; an engine that returned the same page only in a later search is not credited, so “only here” and “needed” are what this run recorded, not a limit on what an engine could find. Telem recorded which engine returned each page{flow.bill ? " and billed each engine run; the cost is this run’s receipt at list price, an estimate" : ""}. One run, not an average.</p>
    </section>
  );
}

/** Names most of the run's origins share: a sign they may all draw on one document that search did not return. */
function SharedNames({ result }: { result: EchoAnalysis }) {
  const hints = useMemo(() => upstreamHints(result).filter((hint) => !hint.amongPages), [result]);
  // What Echo saved after one more search for that name (npm run origin:upstream). Null when it has not looked.
  const looked = useMemo(() => {
    const record = savedUpstreamFor(result);
    return record ? { record, fold: foldUpstream(originFlow(result).layer, record) } : null;
  }, [result]);
  if (!hints.length) return null;
  const [first, ...rest] = hints;
  return (
    <section className={styles.block} data-jump="upstream">
      <header className={styles.blockHead}>
        <span className="eyebrow">A NAME THE ORIGINS SHARE</span>
        <h3>{first.origins === first.of ? `All ${first.of}` : `${first.origins} of the ${first.of}`} origin publishers mention “{first.name}” in the passage Echo saved. No page in this run comes from a site with that name.</h3>
      </header>
      <ul className={styles.sharedNames}>
        {hints.map((hint) => <li key={hint.name}><b>{hint.name}</b><span>{hint.origins} of {hint.of}: {hint.originNames.join(", ")}</span></li>)}
      </ul>
      {looked && (
        <div className={styles.wentLooking}>
          <span className="eyebrow">ECHO WENT LOOKING</span>
          <p className={styles.wentLead}>
            One more search through Telem for “{looked.record.name}”{looked.record.engines.length ? `, answered by ${providerList(looked.record.engines)}` : ""}.{" "}
            {looked.record.upstream
              ? <>It found <a href={looked.record.upstream.url} rel="noreferrer" target="_blank">{looked.record.upstream.title || looked.record.upstream.domain}</a> ({looked.record.upstream.domain}).</>
              : "It found no page that is that document."}
            {looked.record.upstreamReason ? <span> The model’s reason: {looked.record.upstreamReason.replace(/\b[Cc]andidate (\d+)\b/g, (whole, index) => looked.record.candidates[Number(index)]?.domain ?? "one page found")}</span> : null}
          </p>
          <ul className={styles.wentRows}>
            {looked.record.origins.map((origin) => {
              const folds = origin.cites === "yes" && !origin.independent;
              return (
                <li className={folds ? styles.wentFolds : undefined} key={origin.id}>
                  <b>{origin.name}</b>
                  <em>{folds ? "rests on it: folds in" : origin.cites === "yes" ? "names it, and rests on more than it: kept" : origin.cites === "no" ? "does not rest on it: kept" : "unclear: kept"}</em>
                  <span>{origin.reason}</span>
                </li>
              );
            })}
          </ul>
          <p className={styles.wentResult}>
            {looked.fold.folded.length > 0
              ? <>Origins: <b>{looked.fold.before.origins}</b> → <b>{looked.fold.after.origins}</b>. Echo Score: <b>{looked.fold.before.score}</b> → <b>{looked.fold.after.score}</b>.</>
              : <>Nothing folds: the origins stay at <b>{looked.fold.before.origins}</b> and the Echo Score at <b>{looked.fold.before.score}</b>.</>}
          </p>
          <p className={styles.fine}>One search and one model call, saved once on {looked.record.createdAt.slice(0, 10)}. A model judged which origins rest on the document, so read its reasons. An origin folds in only when its saved passage attributes the claim to the document and brings no evidence that comes from anywhere else; an origin that names the document as where the claim began and then reports other evidence is kept.{looked.fold.folded.length > 0 ? (looked.record.upstream ? (looked.record.upstreamShowsFigure ? " The found page counts as one origin at its type’s weight." : " The text Echo got from the found page does not state the figure itself, so that page counts as one origin with no evidence of its own.") : " The document counts as one origin with no evidence of its own, because Echo did not retrieve it.") : ""} This is a second look, new today: the score at the top of this run is what the run found on its own.</p>
        </div>
      )}
      <p className={styles.fine}>Echo traces copying between the pages search returned. When the document a claim goes back to was not returned, each page that discusses it can look like an origin of its own. A name most origins share is the sign of that: if {rest.length ? "these names point at" : "it is"} one document, the origins above may all draw on it, and the count of independent origins may be too high. Found by matching names across the saved passages, by rule, with no model call. It is a hint to go and look, not a finding.</p>
    </section>
  );
}

function SearchList({ result }: { result: EchoAnalysis }) {
  const flow = useMemo(() => originFlow(result), [result]);
  const ran = flow.searches.filter((search) => search.ran);
  if (ran.length < 2 || !flow.searchLine) return null;
  const skipped = flow.searches.filter((search) => search.status === "not searched").length;
  const failed = flow.searches.filter((search) => search.status === "failed").length;
  const routedAny = ran.some((search) => search.routedTo.length > 0);
  const most = Math.max(1, ...ran.map((search) => search.pages));
  return (
    <section className={styles.block} data-jump="searches">
      <header className={styles.blockHead}>
        <span className="eyebrow">WHAT EACH SEARCH ADDED</span>
        <h3>{flow.searchLine}</h3>
      </header>
      <ol className={styles.searchRows}>
        {ran.map((search, index) => (
          <li className={search.newOrigins > 0 ? styles.searchHit : undefined} key={`${index}-${search.query}`}>
            <span className={styles.searchQuery}><i>{search.first ? "The claim as asked" : "Echo’s own query"}</i>{search.query}{search.routedTo.length > 0 && <span className={styles.routed}><em>Engines that answered</em>{search.routedTo.map((route) => <b className={route.pages > 0 ? styles.routeHit : styles.routeMiss} key={route.engine} title={`${providerDisplayName(route.engine)} returned ${plural(route.pages, "page", "pages")} of this search’s new pages about the claim`}>{providerDisplayName(route.engine)} {route.pages}</b>)}</span>}</span>
            <span aria-hidden="true" className={styles.searchBar}><i style={{ width: `${(search.pages / most) * 100}%` }} /></span>
            <span className={styles.searchFigure}><b>{search.pages}</b> {search.pages === 1 ? "page" : "pages"}</span>
            <span className={styles.searchNew}>{search.newOrigins > 0 ? <><b>+{search.newOrigins}</b> {search.newOrigins === 1 ? "origin" : "origins"}: {search.originNames.join(", ")}</> : "no new origin"}</span>
          </li>
        ))}
      </ol>
      <p className={styles.fine}>Searches are listed in the order Echo planned them; it sends them together. “Pages” are the pages about the claim credited to the first search in that order that returned them; an origin is credited to the first search that returned the origin or a page leading back to it.{routedAny ? " The chips are the engines that answered each search through Telem (a run that failed is not listed), with how many of that search’s new pages each one returned." : ""}{skipped > 0 ? ` ${plural(skipped, "more search was", "more searches were")} planned and not run.` : ""}{failed > 0 ? ` ${plural(failed, "search", "searches")} failed.` : ""} One run, not an average.</p>
    </section>
  );
}

function CopyTree({ result, onSelect }: { result: EchoAnalysis; onSelect?: (id: string) => void }) {
  const mutation = useMemo(() => claimMutation(result), [result]);
  const dateOf = useMemo(() => dateLabeller(result), [result]);
  if (!mutation.chains.length && !mutation.variants.length) return null;
  return (
    <section className={styles.block} data-jump="wording">
      <header className={styles.blockHead}>
        <span className="eyebrow">HOW THE CLAIM TRAVELLED</span>
        <h3>{mutation.chains.length ? "The sentence on each origin that has a confirmed copy, and on every page confirmed as copying it." : "No page in this trace was confirmed as a copy, so there is no chain to draw."}</h3>
      </header>
      {mutation.chains.map((chain) => {
        // Each copy is indented under the page it copied (the origin, or another copy), and names that page.
        const depthOf = new Map<string, number>([[chain.steps[0].pageId, 0]]);
        for (const step of chain.steps.slice(1)) depthOf.set(step.pageId, Math.min(3, (depthOf.get(step.parentId ?? "") ?? 0) + 1));
        const domainOf = new Map(chain.steps.map((step) => [step.pageId, step.domain] as const));
        return (
          <ol className={styles.tree} key={chain.originId}>
            {chain.steps.map((step, index) => {
              const Row = onSelect ? "button" : "div";
              return (
                <li className={`${index === 0 ? styles.treeOrigin : styles.treeCopy} ${index === chain.biggest ? styles.treeDrift : ""}`} key={step.pageId} style={{ marginLeft: `${(depthOf.get(step.pageId) ?? 1) * 28}px` }}>
                  <Row className={styles.treeRow} {...(onSelect ? { onClick: () => onSelect(step.pageId), type: "button" as const } : {})}>
                    <span className={styles.treeHead}><b>{step.domain}</b><span>{dateOf(step.pageId, step.date)}</span><em>{index === 0 ? "ORIGIN" : index === chain.biggest ? "COPY · KEEPS THE LEAST WORDING" : "COPY"}</em></span>
                    <span className={styles.treeQuote}>“{step.sentence}”</span>
                    {index > 0 && <span className={styles.treeMeta}><span aria-hidden="true" className={styles.shareTrack}><i style={{ width: `${Math.round((1 - step.drift) * 100)}%` }} /></span>{Math.round((1 - step.drift) * 100)}% of this sentence&apos;s wording is shared with {domainOf.get(step.parentId ?? "") ?? chain.originName}, the page it copied{step.newFigures.length ? ` · gives a figure that page does not state: ${step.newFigures.slice(0, 2).join(", ")}` : ""}</span>}
                  </Row>
                </li>
              );
            })}
          </ol>
        );
      })}
      {mutation.variants.length > 0 && (
        <div className={styles.variants}>
          <span className={styles.variantsLabel}>{mutation.claimFigure ? `The claim says ${mutation.claimFigure}. Other figures pages in this trace give for the same thing:` : "Figures pages in this trace give for this claim:"}</span>
          <ul>{mutation.variants.map((variant) => <li key={variant.figure}><b>{variant.figure}</b><span>{variant.pages.slice(0, 2).map((page) => page.domain).join(", ")}{variant.pages.length > 2 ? ` +${variant.pages.length - 2}` : ""}</span></li>)}</ul>
        </div>
      )}
    </section>
  );
}

/** For a run with no measured comparison: the size of the two prompts Claude would be sent, in characters. No model call. */
function PromptSizeBars({ result }: { result: EchoAnalysis }) {
  const sizes = useMemo(() => {
    const prompts = comparePrompts(result);
    return { plain: prompts.naive.length, echo: prompts.echo.length, plainPages: prompts.naivePages, echoPages: prompts.echoPages };
  }, [result]);
  if (!sizes.echoPages || sizes.plain <= 0) return null;
  const most = Math.max(sizes.plain, sizes.echo, 1);
  const smaller = Math.round((1 - sizes.echo / sizes.plain) * 100);
  const sides = [
    { key: "plain", label: "Every page", detail: `${plural(sizes.plainPages, "page", "pages")} Echo kept, in context`, size: sizes.plain, tone: styles.barPlain },
    { key: "echo", label: "Origins only", detail: `${plural(sizes.echoPages, "origin", "origins")} in context`, size: sizes.echo, tone: styles.barEcho },
  ];
  return (
    <section className={styles.block} data-jump="tokens">
      <header className={styles.blockHead}>
        <span className="eyebrow">SAME QUESTION, TWO CONTEXTS · PROMPT SIZE, NOT YET MEASURED IN TOKENS</span>
        <h3>{smaller > 0 ? `The prompt is ${smaller}% shorter when it carries one page per origin instead of every page Echo kept.` : "With this many origins, the origins-only prompt is no shorter than the full one."}</h3>
      </header>
      <div className={styles.tokens}>
        <div className={styles.bars}>
          {sides.map(({ key, label, detail, size, tone }) => (
            <div className={styles.barRow} key={key}>
              <span className={styles.barLabel}><b>{label}</b><small>{detail}</small></span>
              <span className={styles.barTrack}><i className={tone} style={{ width: `calc((100% - 160px) * ${Math.max(0.012, size / most).toFixed(4)})` }} /><span className={styles.barValue}>{size.toLocaleString("en-US")} characters</span></span>
            </div>
          ))}
        </div>
        <div className={styles.saving}><strong>{smaller > 0 ? "−" : "+"}{Math.abs(smaller)}%</strong><span>prompt characters</span></div>
      </div>
      <p className={styles.fine}>These are the two prompts Echo builds for this run, counted in characters in your browser. Nothing was sent to a model, so there are no token counts or answers to compare for this run; the phone-checks run has both, measured.</p>
    </section>
  );
}

function TokenBars({ comparison, leftOut }: { comparison: TokenComparison; leftOut: { copies: number; unplaced: number; twins: number } }) {
  const most = Math.max(comparison.naive.inputTokens, comparison.echo.inputTokens, 1);
  // "Every page Echo kept", not "plain search": the result page already uses that name for the trace's first search.
  const sides = [
    { key: "plain", label: "Every page", detail: `${plural(comparison.naive.pagesInContext, "page", "pages")} Echo kept, in context`, side: comparison.naive, tone: styles.barPlain },
    { key: "echo", label: "Origins only", detail: `${plural(comparison.echo.pagesInContext, "origin", "origins")} in context`, side: comparison.echo, tone: styles.barEcho },
  ];
  return (
    <section className={styles.block} data-jump="tokens">
      <header className={styles.blockHead}>
        <span className="eyebrow">SAME QUESTION, TWO CONTEXTS</span>
        <h3>{comparison.reductionPct > 0 ? `${comparison.reductionPct}% fewer input tokens when Claude reads one page per origin instead of every page Echo kept.` : "Claude read one page per origin instead of every page Echo kept."}</h3>
      </header>
      <div className={styles.tokens}>
        <div className={styles.bars}>
          {sides.map(({ key, label, detail, side, tone }) => (
            <div className={styles.barRow} key={key}>
              <span className={styles.barLabel}><b>{label}</b><small>{detail}</small></span>
              <span className={styles.barTrack}><i className={tone} style={{ width: `calc((100% - 132px) * ${Math.max(0.012, side.inputTokens / most).toFixed(4)})` }} /><span className={styles.barValue}>{side.inputTokens.toLocaleString("en-US")} tokens</span></span>
            </div>
          ))}
        </div>
        <div className={styles.saving}><strong>{comparison.reductionPct > 0 ? "−" : "+"}{Math.abs(comparison.reductionPct)}%</strong><span>input tokens</span></div>
      </div>
      <div className={styles.answers}>
        {sides.map(({ key, label, side }) => (
          <article className={key === "echo" ? styles.answerEcho : styles.answerPlain} key={key}>
            <span className={styles.answerLabel}>WITH {label.toUpperCase()} IN CONTEXT, CLAUDE ANSWERED</span>
            <p>{side.answer}</p>
            <dl>
              <div><dt>Stated confidence</dt><dd>{side.confidence}</dd></div>
              <div><dt>Sources it says support it</dt><dd>{side.supportingSources}</dd></div>
            </dl>
          </article>
        ))}
      </div>
      <p className={styles.fine}>{comparison.model} answered both, {comparison.createdAt.slice(0, 10)}. Token counts are the API&apos;s own usage figures for each request; one measurement. Left out of the origins-only context: {plural(leftOut.copies, "confirmed copy", "confirmed copies")}{leftOut.twins > 0 ? `, ${plural(leftOut.twins, "second page", "second pages")} of a co-published origin` : ""} and {plural(leftOut.unplaced, "page", "pages")} Echo could not tie to an origin. That context also tells Claude what Echo found (each origin&apos;s type, whether it shows evidence of its own, how many pages repeat it), so a difference in stated confidence shows what Echo tells the model. It is not a blind test of the model.</p>
    </section>
  );
}

export default function OriginGraphic({ result, comparison, onSelect, compareSlot }: { result: EchoAnalysis; comparison: TokenComparison | null; onSelect?: (id: string) => void; compareSlot?: ReactNode }) {
  const flow = useMemo(() => originFlow(result), [result]);
  const [active, setActive] = useState<string | null>(null);
  const { layer } = flow;
  const tone = layer.score <= 30 ? styles.toneLow : layer.score <= 60 ? styles.toneMid : styles.toneHigh;
  const typeCounts = new Map<OriginType, number>();
  for (const origin of layer.origins) typeCounts.set(origin.type, (typeCounts.get(origin.type) ?? 0) + 1);
  // The count is of pages Echo kept (the result page's "pages about the claim"), not of raw search results.
  const subject = result.sourceCheck ? (layer.results === 1 ? "link read" : "links read") : layer.results === 1 ? "page" : "pages";

  return (
    <div className={styles.graphic}>
      <header className={`${styles.verdict} ${tone}`} data-jump="score">
        <div className={styles.score}>
          <span className={styles.scoreLabel}>ECHO SCORE</span>
          <p className={styles.scoreValue}><strong>{layer.score}</strong><span>/ 100</span></p>
          <div aria-label={`Echo Score ${layer.score} out of 100: ${layer.label}`} className={styles.meter} role="img">
            <i style={{ width: `${Math.max(2, layer.score)}%` }} />
            <b style={{ left: "30%" }} />
            <b style={{ left: "60%" }} />
          </div>
          <div aria-hidden="true" className={styles.meterScale}><span>Thin</span><span>Moderate</span><span>Strong evidence base</span></div>
        </div>
        <div className={styles.verdictMain}>
          <span className={styles.verdictLabel}>{layer.label}</span>
          <h2 className={styles.funnel}>
            {flow.engines.length > 1 && <><b>{flow.engines.length}</b> engines <span aria-hidden="true">→</span> </>}
            <b>{layer.results}</b> {subject} <span aria-hidden="true">→</span> <b>{layer.origins.length}</b> independent {layer.origins.length === 1 ? "origin" : "origins"}
            {layer.entities !== layer.origins.length && <> <span aria-hidden="true">→</span> <b>{layer.entities}</b> {layer.entities === 1 ? "publisher" : "publishers"}</>}
          </h2>
          {layer.warning && <p className={styles.warning}>{layer.warning}</p>}
          <div aria-label={`Of the ${flow.pages.length} ${subject}: ${flow.counts.origin} origin ${flow.counts.origin === 1 ? "page" : "pages"}, ${plural(flow.counts.copy, "confirmed copy", "confirmed copies")}, ${flow.counts.unplaced} not tied to an origin`} className={styles.shareBar} role="img">
            {flow.counts.origin > 0 && <i className={styles.segOrigin} style={{ flexGrow: flow.counts.origin }} />}
            {flow.counts.copy > 0 && <i className={styles.segCopy} style={{ flexGrow: flow.counts.copy }} />}
            {flow.counts.unplaced > 0 && <i className={styles.segUnplaced} style={{ flexGrow: flow.counts.unplaced }} />}
          </div>
          <ul className={styles.chips}>
            {[...typeCounts.entries()].map(([type, count]) => <li className={`${styles.chip} ${TYPE_TONE[type]}`} key={type}>{count} × {ORIGIN_TYPE_LABELS[type]}</li>)}
            <li className={styles.chipPlain}>{plural(flow.counts.copy, "confirmed copy", "confirmed copies")}</li>
            <li className={styles.chipPlain}>{flow.counts.unplaced} not tied to an origin</li>
          </ul>
          {layer.origins.length > 0 && (
            <details className={styles.scoreBuild}>
              <summary>How this score was built</summary>
              <ol>
                {layer.origins.map((origin) => (
                  <li key={origin.id}>
                    <b>{origin.name}</b> · {ORIGIN_TYPE_LABELS[origin.type]} · {origin.ownEvidence ? "shows evidence of its own" : "no evidence of its own"}
                    <span>{origin.counted ? `adds ${origin.weight}` : "adds nothing: an earlier origin of the same publisher already counted"}</span>
                  </li>
                ))}
              </ol>
              <p>The weights add up to <b>{layer.weightSum}</b>. Score = 100 × (1 − e<sup>−sum ÷ {SCORE_SCALE}</sup>) = <b>{layer.score}</b>, so the higher the sum already is, the less one more origin moves the score. Copies and pages Echo could not place add nothing. The score rates the evidence base, whichever way it points.</p>
            </details>
          )}
        </div>
      </header>

      <section className={styles.block} data-jump="flow">
        <header className={styles.blockHead}>
          <span className="eyebrow">{result.sourceCheck ? "WHERE THE LINKS LEAD" : "WHERE THE RESULTS LEAD"}</span>
          <h3>{flow.origins.length ? `Follow any page to the right: ${flow.counts.copy + flow.counts.origin} of ${flow.pages.length} ${flow.pages.length === 1 ? "page" : "pages"} ${flow.counts.copy + flow.counts.origin === 1 ? "ends" : "end"} at ${plural(flow.origins.length, "origin", "origins")}; ${flow.counts.unplaced} could not be tied to one.` : `None of the ${flow.pages.length} pages was confirmed as an origin.`}</h3>
        </header>
        <FlowDiagram active={active} onActive={setActive} onSelect={onSelect} result={result} />
      </section>

      <SharedNames result={result} />
      <EngineList result={result} />
      <SearchList result={result} />
      <CopyTree onSelect={onSelect} result={result} />
      {comparison ? <TokenBars comparison={comparison} leftOut={{ copies: flow.counts.copy, unplaced: flow.counts.unplaced, twins: flow.counts.origin - flow.origins.length }} /> : compareSlot ?? <PromptSizeBars result={result} />}

      <p className={styles.fine}>The Echo Score rates the evidence base behind this claim among the pages Echo kept: independent origins with evidence of their own, whichever way they point. It does not say the claim is true; the origins may support it or contradict it. One publisher counts once, and an origin with no evidence of its own counts for almost nothing. Origin types are read by rule from each page&apos;s address, title and saved passage; an origin no rule names is called Original reporting when the judging model found evidence of its own in the passage, and Type unclear when it did not. Pages “not tied to an origin” are ones Echo could not trace back to an origin; a few are copies of a page that is itself not tied to one. One run: another run of the same claim can keep other pages and score differently.</p>
    </div>
  );
}
