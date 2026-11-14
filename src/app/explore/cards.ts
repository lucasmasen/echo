import type { DemoScore } from "@/lib/echo/demo-scores";
import { parsePortableTrace } from "@/lib/echo/portable";
import type { EchoAnalysis } from "@/lib/echo/types";
import { BACKUP_POOL, bundledRunLink, PRESETS, SAVED_SOURCE_CHECK, traceSlug } from "../demo-slots";

export type ExploreCard = { label: string; trace: string; link: string; analysis: EchoAnalysis };

/**
 * Every bundled run, read and validated with the same import check the app uses. A missing or unreadable trace is
 * left out of the gallery (preflight reports it), so a card is never shown for a run that would not open.
 */
export async function bundledCards(readTrace: (publicPath: string) => Promise<string>): Promise<ExploreCard[]> {
  const entries = [...PRESETS, ...BACKUP_POOL].filter((entry) => entry.capturedTrace);
  const cards: ExploreCard[] = [];
  for (const entry of entries) {
    const trace = entry.capturedTrace!;
    const link = bundledRunLink(trace);
    try {
      const analysis = parsePortableTrace(JSON.parse(await readTrace(trace)));
      if (analysis && link) cards.push({ label: entry.label, trace, link, analysis });
    } catch {
      // Left out; see above.
    }
  }
  return cards;
}

/**
 * The saved Check these sources run, as its own card: it read only the links an AI answer supplied, so it is counted
 * in supplied links and independent origins, never as an echo rate or a page count. Null when the file is missing,
 * invalid or not a supplied-sources run (then the gallery simply has no such card).
 */
export async function savedCheckCard(readTrace: (publicPath: string) => Promise<string>): Promise<ExploreCard | null> {
  const trace = SAVED_SOURCE_CHECK.savedTrace;
  try {
    const analysis = parsePortableTrace(JSON.parse(await readTrace(trace)));
    return analysis?.mode === "live" && analysis.sourceCheck ? { label: "Saved check · an AI answer's links", trace, link: `/?trace=${traceSlug(trace)}`, analysis } : null;
  } catch {
    return null;
  }
}

/**
 * The label check for one card, worded like the trace page's accuracy card: matches, wrong calls and pages left
 * unclear, out of the pages that have a label. Empty when the score belongs to a different run than the bundled
 * trace (a replaced trace whose scores were not regenerated), exactly as the trace page then shows no score.
 */
export function scoreSentence(analysis: EchoAnalysis, score: DemoScore | undefined): string {
  if (!score || analysis.mode !== "live" || score.traceCreatedAt !== analysis.createdAt) return "";
  const labelled = score.matched === analysis.summary.totalPages
    ? `all ${score.matched} pages`
    : `${score.matched} of its ${analysis.summary.totalPages} pages`;
  return `AI-made labels for ${labelled}: ${score.exactKinds} match Echo, ${score.settledMistakes} wrong ${score.settledMistakes === 1 ? "call" : "calls"}, ${score.abstentions} left unclear.`;
}
