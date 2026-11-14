import type { AnswerReview, AnswerStatement, EchoAnalysis, EchoPage, SearchQueryAudit, SourceAssessment } from "./types";
import { canonicalUrl } from "./url";

export function comparisonPageKey(page: EchoPage) {
  if (page.url) return canonicalUrl(page.url) ?? page.url;
  return `${page.domain}|${page.title}`.toLocaleLowerCase();
}

export interface RelationshipChange {
  page: EchoPage;
  previousPage: EchoPage;
  changes: string[];
}

export interface SearchCoverageChange {
  query: string;
  current: SearchQueryAudit | null;
  previous: SearchQueryAudit | null;
}

export function compareAnswerEvidence(current: EchoAnalysis, previous: EchoAnalysis) {
  const citedPages = (analysis: EchoAnalysis) => {
    const byId = new Map(analysis.pages.map((page) => [page.id, page] as const));
    return analysis.answerSourceIds.map((id) => byId.get(id)).filter((page): page is EchoPage => Boolean(page));
  };
  const currentCited = citedPages(current);
  const previousCited = citedPages(previous);
  const currentKeys = new Set(currentCited.map(comparisonPageKey));
  const previousKeys = new Set(previousCited.map(comparisonPageKey));
  return {
    answerChanged: current.answer !== previous.answer,
    statusChanged: current.answerStatus !== previous.answerStatus,
    citedSourcesAdded: currentCited.filter((page) => !previousKeys.has(comparisonPageKey(page))),
    citedSourcesRemoved: previousCited.filter((page) => !currentKeys.has(comparisonPageKey(page))),
  };
}

export interface AnswerReviewChange {
  statement: string;
  current: AnswerReview | null;
  previous: AnswerReview | null;
}

export function compareAnswerReviews(current: EchoAnalysis, previous: EchoAnalysis) {
  const entries = (analysis: EchoAnalysis) => {
    const pageById = new Map(analysis.pages.map((page) => [page.id, page] as const));
    const occurrences = new Map<string, number>();
    return (analysis.answerStatements ?? []).map((statement: AnswerStatement, index) => {
      const sourceKeys = statement.sourceIds.map((id) => {
        const page = pageById.get(id);
        return page ? comparisonPageKey(page) : id;
      }).sort();
      const baseKey = `${statement.text.trim().replace(/\s+/g, " ")}\u0000${sourceKeys.join("\u0000")}`;
      const occurrence = occurrences.get(baseKey) ?? 0;
      occurrences.set(baseKey, occurrence + 1);
      return { key: `${baseKey}\u0000${occurrence}`, statement: statement.text, review: analysis.answerReviews?.[index] ?? null };
    });
  };
  const currentEntries = entries(current);
  const previousEntries = entries(previous);
  const currentByKey = new Map(currentEntries.map((entry) => [entry.key, entry] as const));
  const previousByKey = new Map(previousEntries.map((entry) => [entry.key, entry] as const));
  const changed = [...new Set([...currentByKey.keys(), ...previousByKey.keys()])].flatMap((key): AnswerReviewChange[] => {
    const now = currentByKey.get(key);
    const then = previousByKey.get(key);
    const currentReview = now?.review ?? null;
    const previousReview = then?.review ?? null;
    if (!currentReview && !previousReview) return [];
    if (currentReview?.status === previousReview?.status && currentReview?.note === previousReview?.note) return [];
    return [{ statement: now?.statement ?? then?.statement ?? "", current: currentReview, previous: previousReview }];
  });
  return {
    currentReviewed: currentEntries.filter(({ review }) => review?.status).length,
    previousReviewed: previousEntries.filter(({ review }) => review?.status).length,
    currentTotal: currentEntries.length,
    previousTotal: previousEntries.length,
    changed,
  };
}

export interface SourceReviewChange {
  page: EchoPage;
  currentInspected: boolean;
  previousInspected: boolean;
  currentNote: string;
  previousNote: string;
  currentAssessment: SourceAssessment | null;
  previousAssessment: SourceAssessment | null;
}

export function compareSourceReviews(current: EchoAnalysis, previous: EchoAnalysis) {
  const previousByKey = new Map(previous.pages.map((page) => [comparisonPageKey(page), page] as const));
  const currentInspected = new Set(current.inspectedPageIds ?? []);
  const previousInspected = new Set(previous.inspectedPageIds ?? []);
  const changed = current.pages.flatMap((page): SourceReviewChange[] => {
    const previousPage = previousByKey.get(comparisonPageKey(page));
    if (!previousPage) return [];
    const nowMarked = currentInspected.has(page.id);
    const thenMarked = previousInspected.has(previousPage.id);
    const nowNote = current.reviewNotesByPageId?.[page.id] ?? "";
    const thenNote = previous.reviewNotesByPageId?.[previousPage.id] ?? "";
    const nowAssessment = current.sourceAssessmentsByPageId?.[page.id] ?? null;
    const thenAssessment = previous.sourceAssessmentsByPageId?.[previousPage.id] ?? null;
    if (nowMarked === thenMarked && nowNote === thenNote && nowAssessment === thenAssessment) return [];
    return [{ page, currentInspected: nowMarked, previousInspected: thenMarked, currentNote: nowNote, previousNote: thenNote, currentAssessment: nowAssessment, previousAssessment: thenAssessment }];
  });
  return { currentInspected: currentInspected.size, previousInspected: previousInspected.size, changed };
}

export function changedSearchCoverage(current: EchoAnalysis, previous: EchoAnalysis): SearchCoverageChange[] {
  const key = (entry: SearchQueryAudit) => `${entry.depth}|${entry.query.trim().toLocaleLowerCase().replace(/\s+/g, " ")}`;
  const currentByKey = new Map((current.searchAudit ?? []).map((entry) => [key(entry), entry] as const));
  const previousByKey = new Map((previous.searchAudit ?? []).map((entry) => [key(entry), entry] as const));
  return [...new Set([...currentByKey.keys(), ...previousByKey.keys()])].flatMap((queryKey) => {
    const now = currentByKey.get(queryKey) ?? null;
    const then = previousByKey.get(queryKey) ?? null;
    if (now && then && now.status === then.status && now.totalResults === then.totalResults && now.matchingResults === then.matchingResults && now.uniquePagesAdded === then.uniquePagesAdded) return [];
    return [{ query: now?.query ?? then?.query ?? queryKey, current: now, previous: then }];
  });
}

export function changedSourceRelationships(current: EchoAnalysis, previous: EchoAnalysis): RelationshipChange[] {
  const currentByKey = new Map(current.pages.map((page) => [comparisonPageKey(page), page] as const));
  const previousByKey = new Map(previous.pages.map((page) => [comparisonPageKey(page), page] as const));
  const currentById = new Map(current.pages.map((page) => [page.id, page] as const));
  const previousById = new Map(previous.pages.map((page) => [page.id, page] as const));
  const parentKey = (byId: Map<string, EchoPage>, page: EchoPage) => {
    const parent = page.judgment.parentId ? byId.get(page.judgment.parentId) : null;
    return parent ? comparisonPageKey(parent) : page.judgment.parentId ? `unresolved:${page.judgment.parentId}` : null;
  };
  const primaryStatus = (page: EchoPage) => page.primaryEvidenceStatus ?? (page.hasPrimaryEvidence ? "found" : "unclear");
  const currentRoots = new Set(current.roots);
  const previousRoots = new Set(previous.roots);

  return [...currentByKey].flatMap(([key, page]) => {
    const previousPage = previousByKey.get(key);
    if (!previousPage) return [];
    const changes: string[] = [];
    if (page.judgment.kind !== previousPage.judgment.kind) changes.push("classification");
    if (parentKey(currentById, page) !== parentKey(previousById, previousPage)) changes.push("proposed source");
    if (page.publishedDate !== previousPage.publishedDate || page.publishedDateSource !== previousPage.publishedDateSource) changes.push("publication date");
    if (page.extractionSource !== previousPage.extractionSource) changes.push("extraction method");
    if ((page.text ?? "").replace(/\s+/g, " ").trim() !== (previousPage.text ?? "").replace(/\s+/g, " ").trim()) changes.push("retrieved passage");
    if (primaryStatus(page) !== primaryStatus(previousPage)) changes.push("primary evidence");
    if (currentRoots.has(page.id) !== previousRoots.has(previousPage.id)) changes.push("root candidacy");
    return changes.length ? [{ page, previousPage, changes }] : [];
  });
}
