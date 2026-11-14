import { comparisonPageKey } from "./compare";
import { sameWork } from "./origins";
import type { EchoAnalysis, JudgmentKind } from "./types";

export const ECHO_LABEL_FORMAT = "echo-source-labels";

export interface SourceLabel {
  sourceKey: string;
  title: string;
  url: string;
  publishedDate: string | null;
  publishedDateSource: string | null;
  extractionSource: string | null;
  retrievedPassage: string;
  expectedKind: JudgmentKind | null;
  expectedParentKey: string | null;
  note: string;
}

export interface LabelSheet {
  format: typeof ECHO_LABEL_FORMAT;
  version: 1;
  claim: string;
  labels: SourceLabel[];
}

export function makeLabelSheet(analysis: EchoAnalysis): LabelSheet {
  const labels = analysis.pages.map((page): SourceLabel => ({
    sourceKey: comparisonPageKey(page),
    title: page.title,
    url: page.url,
    publishedDate: page.publishedDate,
    publishedDateSource: page.publishedDateSource ?? null,
    extractionSource: page.extractionSource ?? null,
    retrievedPassage: page.text,
    expectedKind: null,
    expectedParentKey: null,
    note: analysis.reviewNotesByPageId?.[page.id] ?? "",
  }));
  if (new Set(labels.map((label) => label.sourceKey)).size !== labels.length) throw new Error("Trace contains duplicate normalized source URLs; review it before labeling.");
  return { format: ECHO_LABEL_FORMAT, version: 1, claim: analysis.claim, labels };
}

export function parseLabelSheet(value: unknown): LabelSheet | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const sheet = value as Record<string, unknown>;
  if (sheet.format !== ECHO_LABEL_FORMAT || sheet.version !== 1 || typeof sheet.claim !== "string" || sheet.claim.length > 500 || !Array.isArray(sheet.labels) || sheet.labels.length > 200) return null;
  const labels: SourceLabel[] = [];
  for (const item of sheet.labels) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const label = item as Record<string, unknown>;
    if (typeof label.sourceKey !== "string" || !label.sourceKey || label.sourceKey.length > 4_000
      || typeof label.title !== "string" || label.title.length > 2_000
      || typeof label.url !== "string" || label.url.length > 4_000
      || (label.publishedDate !== null && (typeof label.publishedDate !== "string" || label.publishedDate.length > 100))
      || (label.publishedDateSource !== null && (typeof label.publishedDateSource !== "string" || label.publishedDateSource.length > 100))
      || (label.extractionSource !== null && (typeof label.extractionSource !== "string" || label.extractionSource.length > 100))
      || typeof label.retrievedPassage !== "string" || label.retrievedPassage.length > 20_000
      || (label.expectedKind !== null && !["origin", "derived", "unclear"].includes(String(label.expectedKind)))
      || (label.expectedParentKey !== null && (typeof label.expectedParentKey !== "string" || label.expectedParentKey.length > 4_000))
      || typeof label.note !== "string" || label.note.length > 2_000) return null;
    labels.push(label as unknown as SourceLabel);
  }
  const keys = new Set(labels.map((label) => label.sourceKey));
  if (keys.size !== labels.length) return null;
  if (labels.some((label) => label.expectedKind === "derived" ? !label.expectedParentKey || !keys.has(label.expectedParentKey) || label.expectedParentKey === label.sourceKey : label.expectedParentKey !== null)) return null;
  return sheet as unknown as LabelSheet;
}

function sameClaim(left: string, right: string) {
  const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  return normalize(left) === normalize(right);
}

export function scoreTrace(analysis: EchoAnalysis, sheet: LabelSheet) {
  if (!sameClaim(analysis.claim, sheet.claim)) throw new Error("The label sheet is for a different claim.");
  const pagesByKey = new Map(analysis.pages.map((page) => [comparisonPageKey(page), page] as const));
  if (pagesByKey.size !== analysis.pages.length) throw new Error("Trace contains duplicate normalized source URLs; it cannot be scored reliably.");
  const pagesById = new Map(analysis.pages.map((page) => [page.id, page] as const));
  const reviewed = sheet.labels.filter((label) => label.expectedKind !== null);
  const missingReviewed = reviewed.filter((label) => !pagesByKey.has(label.sourceKey)).map((label) => ({ sourceKey: label.sourceKey, title: label.title }));
  const matched = reviewed.filter((label) => pagesByKey.has(label.sourceKey));
  let exactKinds = 0;
  let settledMistakes = 0;
  let abstentions = 0;
  let derivedCorrect = 0;
  let derivedPredicted = 0;
  let derivedGold = 0;
  let exactEdges = 0;
  // Not exact, but the expected parent's own work at another address (its PubMed record, say); counted apart.
  let sameWorkEdges = 0;
  const disagreements: Array<{ sourceKey: string; title: string; expected: string; observed: string }> = [];
  for (const label of matched) {
    const page = pagesByKey.get(label.sourceKey)!;
    const observedKind = page.judgment.kind;
    const expectedKind = label.expectedKind!;
    const parent = page.judgment.parentId ? pagesById.get(page.judgment.parentId) : null;
    const observedParentKey = parent ? comparisonPageKey(parent) : null;
    if (observedKind === expectedKind) exactKinds += 1;
    if (observedKind !== "unclear" && observedKind !== expectedKind) settledMistakes += 1;
    if (observedKind === "unclear" && expectedKind !== "unclear") abstentions += 1;
    if (observedKind === "derived") derivedPredicted += 1;
    if (expectedKind === "derived") derivedGold += 1;
    if (observedKind === "derived" && expectedKind === "derived") {
      derivedCorrect += 1;
      if (observedParentKey === label.expectedParentKey) exactEdges += 1;
      else {
        const expectedParent = label.expectedParentKey ? pagesByKey.get(label.expectedParentKey) : undefined;
        if (parent && expectedParent && sameWork(parent, expectedParent)) sameWorkEdges += 1;
      }
    }
    if (observedKind !== expectedKind || (expectedKind === "derived" && observedKind === "derived" && observedParentKey !== label.expectedParentKey)) {
      disagreements.push({
        sourceKey: label.sourceKey,
        title: label.title,
        expected: `${expectedKind}${label.expectedParentKey ? ` ← ${label.expectedParentKey}` : ""}`,
        observed: `${observedKind}${observedParentKey ? ` ← ${observedParentKey}` : ""}`,
      });
    }
  }
  const reviewedKeys = new Set(reviewed.map((label) => label.sourceKey));
  return {
    claim: analysis.claim,
    mode: analysis.mode,
    reviewed: reviewed.length,
    matched: matched.length,
    missingReviewed,
    unreviewedTracePages: analysis.pages.filter((page) => !reviewedKeys.has(comparisonPageKey(page))).length,
    exactKinds,
    kindAccuracy: matched.length ? exactKinds / matched.length : null,
    settledMistakes,
    abstentions,
    derivedPredicted,
    derivedGold,
    derivedCorrect,
    derivedPrecision: derivedPredicted ? derivedCorrect / derivedPredicted : null,
    derivedRecall: derivedGold ? derivedCorrect / derivedGold : null,
    exactEdges,
    sameWorkEdges,
    disagreements,
  };
}
