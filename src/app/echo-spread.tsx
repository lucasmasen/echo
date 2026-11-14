"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EchoAnalysis, JudgmentKind } from "@/lib/echo/types";
import { datePrecision, pageDateLabel, reliablyDatedPages, SPREAD_DOT as DOT, SPREAD_ROWS as ROWS, spreadDateLabel, spreadLayout } from "./trace-view";
import styles from "./echo-spread.module.css";

// "Watch the echo spread": every reliably dated page on a time axis, one row per judgment (independent origins, echoes,
// unclear), with each echo joined to the page it copied. Play sweeps the years and shows pages as they appeared.
// Search-estimated dates are never plotted, so the timeline shows only what the pages themselves say.

const WIDTH = 1000;
const MIN_WIDTH = 300;

/** A page title cut to a readable length for a tooltip or screen-reader label, never splitting a character. */
function shortTitle(title: string) {
  const characters = Array.from(title.trim());
  return characters.length > 140 ? `${characters.slice(0, 139).join("").trimEnd()}…` : characters.join("");
}
const HEIGHT = 222;

export default function EchoSpread({ result, onSelect, selectedId }: { result: EchoAnalysis; onSelect: (id: string) => void; selectedId: string | null }) {
  const dated = useMemo(() => reliablyDatedPages(result), [result]);
  // The chart is laid out about one unit per screen pixel below WIDTH, so on a phone the dots stay tappable and the
  // labels readable instead of shrinking with the whole drawing; wider screens scale the WIDTH-unit drawing up.
  const [width, setWidth] = useState(WIDTH);
  const measure = useCallback((svg: SVGSVGElement | null) => {
    if (!svg || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.round(entry.contentRect.width);
      if (measured > 0) setWidth(Math.min(WIDTH, Math.max(MIN_WIDTH, measured)));
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => (dated.length < 2 ? null : spreadLayout(dated, width)), [dated, width]);

  // What is plotted. A sweep belongs to the trace it started on: opening another trace mid-play stops it, while a
  // change that leaves the plotted pages alone (marking a page inspected, say) does not.
  const plotted = useMemo(() => `${result.claim}|${result.createdAt}|${dated.map((page) => `${page.id}@${page.publishedDate}:${page.judgment.kind}>${page.judgment.parentId ?? ""}`).join(",")}`, [result.claim, result.createdAt, dated]);
  // The sweep position as a day number; no sweep means fully drawn (the resting state).
  const [sweep, setSweep] = useState<{ plotted: string; day: number } | null>(null);
  const cursor = sweep?.plotted === plotted ? sweep.day : null;
  const frame = useRef<number | null>(null);
  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, [plotted]);

  if (!layout) return null;
  const byId = new Map(layout.placed.map((entry) => [entry.page.id, entry] as const));
  const undated = result.pages.length - dated.length;
  const coarse = dated.filter((page) => datePrecision(page.publishedDate!) !== "day").length;
  const shown = layout.placed.filter((entry) => cursor === null || entry.day <= cursor);
  const count = (kind: JudgmentKind) => shown.filter((entry) => entry.page.judgment.kind === kind).length;
  const cursorLabel = cursor === null ? null : layout.last - layout.first >= 730 ? String(new Date(cursor * 86_400_000).getUTCFullYear()) : spreadDateLabel(cursor, layout.fineDates);
  const cursorX = cursor === null ? null : layout.xOf(cursor);
  const firstYear = dated[0].publishedDate!.slice(0, 4);
  const lastYear = dated[dated.length - 1].publishedDate!.slice(0, 4);

  const play = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setSweep(null);
      return;
    }
    const years = (layout.last - layout.first) / 365.25;
    const duration = Math.min(9_000, Math.max(3_500, years * 550));
    const startedAt = performance.now();
    const tick = (now: number) => {
      // A frame's timestamp can precede startedAt; never sweep back before the first page.
      const progress = Math.max(0, Math.min(1, (now - startedAt) / duration));
      if (progress >= 1) {
        frame.current = null;
        setSweep(null);
        return;
      }
      setSweep({ plotted, day: layout.first + progress * (layout.last - layout.first) });
      frame.current = requestAnimationFrame(tick);
    };
    setSweep({ plotted, day: layout.first });
    frame.current = requestAnimationFrame(tick);
  };

  return (
    <section aria-label="Watch the echo spread" className={styles.card}>
      <div className={styles.head}>
        <div>
          <span className={styles.kicker}>WATCH THE ECHO SPREAD</span>
          <h3 className={styles.title}>
            {cursorLabel === null
              ? `${dated.length} dated pages, ${firstYear === lastYear ? `all from ${firstYear}` : `${firstYear}–${lastYear}`}`
              : `${cursorLabel}: ${shown.length} ${shown.length === 1 ? "page" : "pages"} so far`}
          </h3>
          {/* Silent while playing, so a screen reader is not read every page as it appears; it hears the totals at the end. */}
          <p aria-live={cursor === null ? "polite" : "off"} className={styles.counts}>
            {count("origin")} {count("origin") === 1 ? "root page" : "root pages"} · {count("derived")} {count("derived") === 1 ? "echo" : "echoes"} · {count("unclear")} unclear
          </p>
        </div>
        <button className={styles.play} onClick={play} type="button">{cursor === null ? "▶ Play the spread" : "↺ Restart"}</button>
      </div>
      <svg className={styles.chart} role="group" aria-label={`Timeline of ${dated.length} reliably dated pages`} ref={measure} viewBox={`0 0 ${width} ${HEIGHT}`}>
        {ROWS.map((row) => (
          <g key={row.kind}>
            <line className={styles.lane} x1={layout.left} x2={width - layout.right} y1={row.y} y2={row.y} />
            <text aria-hidden="true" className={styles.laneLabel} x={layout.left - 14} y={row.y + 4}>{row.label}</text>
          </g>
        ))}
        {layout.ticks.map((tick) => (
          <g key={tick.x}>
            <line className={styles.tick} x1={tick.x} x2={tick.x} y1={18} y2={HEIGHT - 26} />
            <text aria-hidden="true" className={styles.tickLabel} x={tick.x} y={HEIGHT - 8}>{tick.label}</text>
          </g>
        ))}
        {shown.map((entry) => {
          const parent = entry.page.judgment.kind === "derived" && entry.page.judgment.parentId ? byId.get(entry.page.judgment.parentId) : undefined;
          if (!parent || (cursor !== null && parent.day > cursor)) return null;
          const midY = (entry.y + parent.y) / 2;
          return <path className={styles.link} d={`M${parent.x},${parent.y} C${parent.x},${midY} ${entry.x},${midY} ${entry.x},${entry.y}`} key={`link-${entry.page.id}`} />;
        })}
        {cursorX !== null && <line className={styles.cursor} x1={cursorX} x2={cursorX} y1={12} y2={HEIGHT - 26} />}
        {shown.map((entry) => (
          <g className={styles.dotGroup} key={entry.page.id}>
            <circle
              aria-label={`${shortTitle(entry.page.title)} (${entry.page.domain}), ${pageDateLabel(entry.page.publishedDate!)}, ${entry.page.judgment.kind === "derived" ? "echo" : entry.page.judgment.kind}`}
              className={`${styles.dot} ${styles[entry.page.judgment.kind]} ${datePrecision(entry.page.publishedDate!) !== "day" ? styles.coarse : ""} ${entry.page.id === selectedId ? styles.selected : ""}`}
              cx={entry.x}
              cy={entry.y}
              onClick={() => onSelect(entry.page.id)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(entry.page.id); } }}
              r={DOT}
              role="button"
              tabIndex={0}
            >
              <title>{`${shortTitle(entry.page.title)} — ${entry.page.domain}, ${pageDateLabel(entry.page.publishedDate!)}`}</title>
            </circle>
          </g>
        ))}
        {cursor === null && layout.overflow.map((entry) => (
          <text aria-hidden="true" className={styles.more} key={`more-${entry.x}-${entry.y}`} x={entry.x + DOT + 4} y={entry.y - DOT + 2}>+{entry.count}</text>
        ))}
      </svg>
      <p className={styles.note}>
        Dates read from the pages themselves.{undated > 0 ? ` ${undated} ${undated === 1 ? "page has" : "pages have"} no such date and ${undated === 1 ? "is" : "are"} not shown.` : ""}{coarse > 0 ? ` ${coarse} hollow ${coarse === 1 ? "dot gives" : "dots give"} only a year or month, drawn at its start; ${coarse === 1 ? "its" : "their"} exact date is not known.` : ""} Lines join an echo to the page Echo judges it copied. Select a dot to inspect that page.
      </p>
    </section>
  );
}
