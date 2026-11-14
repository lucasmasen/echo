"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { originLayer, type TokenComparison } from "@/lib/echo/origin-layer";
import { makePortableTrace } from "@/lib/echo/portable";
import type { EchoAnalysis } from "@/lib/echo/types";
import OriginGraphic from "./origin-graphic";
import { savedComparisonFor } from "./origin-saved";
import styles from "./origin-layer.module.css";

// The origin layer on a result page (opt-in): the origin graphic (origin-graphic.tsx: Echo Score, the flow from search
// engines to pages to independent origins, what each engine added, the copy tree with each page's wording, and the
// token comparison) under the evidence funnel. Off unless this browser has switched it on: click the result toolbar's
// "Origin layer: off" button (OriginLayerToggle below) or press Shift+O on a result (either one again switches it
// off), or build with NEXT_PUBLIC_ECHO_ORIGIN_LAYER=1. With it off the panel renders nothing; the toolbar button is
// the only thing this file adds to the result page. No address can switch it on (check:links keeps the address bar to
// the workbench's one mount effect). Everything but the comparison is computed from the trace in the browser: no request,
// no cost. The same graphic, always on, shows the saved runs at /origins.

const SWITCH_KEY = "echo:origin-layer";
/** The panel's element id: the toolbar button scrolls to it when the layer turns on. */
const PANEL_ID = "origin-layer";
/** Every mounted panel's re-read callback: flipping the switch tells them directly (no synthetic browser event). */
const listeners = new Set<() => void>();

function readSwitch(): boolean {
  try {
    const stored = window.localStorage.getItem(SWITCH_KEY);
    if (stored === "1" || stored === "0") return stored === "1";
  } catch {
    // Storage blocked: fall through to the build default.
  }
  return process.env.NEXT_PUBLIC_ECHO_ORIGIN_LAYER === "1";
}

function flipSwitch() {
  try {
    window.localStorage.setItem(SWITCH_KEY, readSwitch() ? "0" : "1");
  } catch {
    return;
  }
  for (const notify of listeners) notify();
}

function onSwitchKey(event: KeyboardEvent) {
  if (event.key.toUpperCase() !== "O" || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  flipSwitch();
}

function subscribeSwitch(notify: () => void) {
  if (!listeners.size) window.addEventListener("keydown", onSwitchKey);
  listeners.add(notify);
  window.addEventListener("storage", notify);
  return () => {
    listeners.delete(notify);
    window.removeEventListener("storage", notify);
    if (!listeners.size) window.removeEventListener("keydown", onSwitchKey);
  };
}

export function useOriginLayer(): boolean {
  return useSyncExternalStore(subscribeSwitch, readSwitch, () => false);
}

/** The visible switch in the result toolbar: the same flip as Shift+O (same state, same saved value). When it turns
 *  the layer on, the panel is scrolled into view. Shown only where the panel can render (a live trace). */
export function OriginLayerToggle({ result }: { result: EchoAnalysis }) {
  const on = useOriginLayer();
  if (result.mode !== "live") return null;

  function toggle() {
    flipSwitch();
    if (!readSwitch()) return;
    // The panel is in the page by the next frame (the flip re-renders it before the browser paints).
    window.requestAnimationFrame(() => document.getElementById(PANEL_ID)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
  }

  return <button aria-pressed={on} className="origin-layer-toggle" onClick={toggle} title="Show or hide the origin layer for this result. Shift+O does the same." type="button">Origin layer: {on ? "on" : "off"}</button>;
}

/** Shown where a trace has no saved comparison: one button that asks the server for it (two Claude calls). */
function RunComparison({ result, onDone }: { result: EchoAnalysis; onDone: (comparison: TokenComparison) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trace: makePortableTrace(result) }) });
      const payload = (await response.json().catch(() => null)) as { comparison?: TokenComparison; error?: string } | null;
      if (!response.ok || !payload?.comparison) setError(payload?.error ?? "The comparison could not run. The trace is unchanged.");
      else onDone(payload.comparison);
    } catch {
      setError("The comparison could not reach Echo's server. The trace is unchanged.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <span className="eyebrow">SAME QUESTION, TWO CONTEXTS</span>
        <p>Ask Claude the same question with every page Echo kept in context, and with one page per independent origin.</p>
      </div>
      <div className={styles.compareEmpty}>
        <button className={styles.runButton} disabled={busy} onClick={run} type="button">{busy ? "Asking twice…" : "Run the comparison"}</button>
        <span>Two Claude calls on this trace&apos;s saved passages (a few cents). No new search.</span>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </div>
    </div>
  );
}

export default function OriginLayerPanel({ result, onSelect }: { result: EchoAnalysis; onSelect: (id: string) => void }) {
  const on = useOriginLayer();
  const [live, setLive] = useState<TokenComparison | null>(null);
  const saved = useMemo(() => (on ? savedComparisonFor(result) : null), [on, result]);
  // With no confirmed origin there is no origins-only context, so no comparison is offered (the server refuses it too).
  const hasOrigins = useMemo(() => (on ? originLayer(result).origins.length > 0 : false), [on, result]);
  if (!on || result.mode !== "live") return null;
  const comparison = saved ?? live;

  return (
    <section aria-label="Origin layer" className={styles.panel} id={PANEL_ID}>
      <OriginGraphic compareSlot={!comparison && hasOrigins ? <RunComparison onDone={setLive} result={result} /> : null} comparison={comparison} onSelect={onSelect} result={result} />
    </section>
  );
}
