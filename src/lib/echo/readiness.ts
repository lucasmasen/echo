import { summarizeTraceSignals } from "./graph";
import { answerNumberGrounding } from "./grounding";
import type { EchoAnalysis } from "./types";

export function auditTrace(analysis: EchoAnalysis) {
  const pages = analysis.pages;
  const pageIds = new Map(pages.map((page) => [page.id, page] as const));
  const signals = summarizeTraceSignals(pages);
  const fullExtracts = pages.filter((page) => page.extractionSource === "Tavily extraction" || page.extractionSource === "Page HTML").length;
  const pageOrUrlDates = pages.filter((page) => page.publishedDate && (page.publishedDateSource === "page text" || page.publishedDateSource === "page metadata" || page.publishedDateSource === "URL date")).length;
  const estimatedDates = pages.filter((page) => page.publishedDateSource === "Tavily estimate").length;
  const missingDates = pages.filter((page) => !page.publishedDate).length;
  const unknownDateSources = pages.filter((page) => page.publishedDate && !page.publishedDateSource).length;
  const rootPages = analysis.roots.map((id) => pageIds.get(id)).filter((page) => page !== undefined);
  const unverifiedRoots = rootPages.filter((page) => page.primaryEvidenceStatus !== "found").length;
  const failedQueries = (analysis.searchAudit ?? []).filter((entry) => entry.status === "failed").length;
  const inspectedPages = analysis.inspectedPageIds?.length ?? 0;
  const reviewNotePages = Object.keys(analysis.reviewNotesByPageId ?? {}).length;
  const sourceAssessments = Object.keys(analysis.sourceAssessmentsByPageId ?? {}).length;
  const challengedSourceJudgments = Object.values(analysis.sourceAssessmentsByPageId ?? {}).filter((status) => status === "challenged").length;
  const citedRoots = analysis.answerSourceIds.length;
  const answerStatements = analysis.answerStatements?.length ?? 0;
  const answerStatementsReviewed = Object.values(analysis.answerReviews ?? {}).filter((review) => review.status !== null).length;
  const answerStatementsUnsupported = Object.values(analysis.answerReviews ?? {}).filter((review) => review.status === "unsupported").length;
  const numberGrounding = analysis.answerStatus === "generated" ? answerNumberGrounding(analysis) : [];
  const answerNumbersChecked = numberGrounding.reduce((total, entry) => total + entry.numbers.length, 0);
  const answerNumbersUnmatched = numberGrounding.flatMap((entry) => entry.unmatchedNumbers.map((number) => ({ statementIndex: entry.statementIndex, number })));
  const rootsOmittedFromAnswer = Math.max(0, rootPages.length - 12);
  const suppliedRootsNotCited = analysis.answerStatus === "generated" ? Math.max(0, Math.min(rootPages.length, 12) - citedRoots) : 0;
  const notes: string[] = [];
  if (analysis.mode === "demo") notes.push("This is a synthetic rehearsal fixture, not a live research trace.");
  if (pages.length < 15) notes.push("Fewer than 15 retained pages; review whether search coverage is broad enough for this claim.");
  if (pages.length && pageOrUrlDates / pages.length < 0.6) notes.push("Fewer than 60% of pages have a date visible in page text or URL; directional links need careful review.");
  if (unknownDateSources) notes.push(`${unknownDateSources} dated page${unknownDateSources === 1 ? " has" : "s have"} no recorded date source.`);
  if (fullExtracts < pages.length) notes.push("Some pages use search snippets instead of extracted text; open them before relying on root evidence.");
  if (unverifiedRoots) notes.push(`${unverifiedRoots} candidate root${unverifiedRoots === 1 ? " lacks" : "s lack"} confirmed primary evidence in the retrieved passage.`);
  if (!signals.likelyEchoes && pages.length) notes.push("No likely derived links were established in this trace; do not claim an echo collapse.");
  if (signals.possiblePaths) notes.push(`${signals.possiblePaths} possible source ${signals.possiblePaths === 1 ? "path is" : "paths are"} excluded from the echo rate until chronology is supported.`);
  if (failedQueries) notes.push(`${failedQueries} search quer${failedQueries === 1 ? "y failed" : "ies failed"}; coverage may be incomplete.`);
  if (analysis.answerStatus === "unavailable") notes.push("Answer synthesis was unavailable; inspect the source tree and root passages directly.");
  if (rootsOmittedFromAnswer) notes.push(`${rootsOmittedFromAnswer} candidate root${rootsOmittedFromAnswer === 1 ? " was" : "s were"} outside the 12-source answer limit.`);
  if (suppliedRootsNotCited) notes.push(`${suppliedRootsNotCited} root${suppliedRootsNotCited === 1 ? " was" : "s were"} supplied to the answer model but not cited.`);
  if (answerStatementsUnsupported) notes.push(`${answerStatementsUnsupported} answer statement${answerStatementsUnsupported === 1 ? " was" : "s were"} marked unsupported by a reviewer; inspect the cited source pages.`);
  if (answerNumbersUnmatched.length) notes.push(`${answerNumbersUnmatched.length} number${answerNumbersUnmatched.length === 1 ? "" : "s"} in the generated answer (${answerNumbersUnmatched.map(({ number }) => number).slice(0, 4).join(", ")}) did not appear in the cited passages; check those statements against the original pages.`);
  if (challengedSourceJudgments) notes.push(`${challengedSourceJudgments} source judgment${challengedSourceJudgments === 1 ? " was" : "s were"} challenged by a reviewer; inspect the original pages and notes.`);

  return {
    claim: analysis.claim,
    createdAt: analysis.createdAt,
    mode: analysis.mode,
    pages: pages.length,
    domains: new Set(pages.map((page) => page.domain)).size,
    fullExtracts,
    pageOrUrlDates,
    estimatedDates,
    missingDates,
    unknownDateSources,
    likelyEchoes: signals.likelyEchoes,
    possiblePaths: signals.possiblePaths,
    roots: rootPages.length,
    rootsWithPrimaryEvidence: rootPages.length - unverifiedRoots,
    failedQueries,
    answerStatus: analysis.answerStatus ?? "not recorded",
    citedRoots,
    answerStatements,
    answerStatementsReviewed,
    answerStatementsUnsupported,
    answerNumbersChecked,
    answerNumbersUnmatched,
    rootsOmittedFromAnswer,
    suppliedRootsNotCited,
    inspectedPages,
    reviewNotePages,
    sourceAssessments,
    challengedSourceJudgments,
    notes,
  };
}
