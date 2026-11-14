import type { EchoAnalysis, EchoPage } from "./types";

function rehearsalPages(prefix: string, claim: string, count: number, rootCount: number, rootTitle: string): EchoPage[] {
  const roots = Array.from({ length: rootCount }, (_, index) => `${prefix}-${index + 1}`);
  return Array.from({ length: count }, (_, index) => {
    const id = `${prefix}-${index + 1}`;
    const isRoot = index < rootCount;
    const parentId = isRoot ? null : roots[(index - rootCount) % roots.length];
    return {
      id,
      title: isRoot ? `${rootTitle} · illustrative record ${index + 1}` : `Illustrative repeat ${index + 1}`,
      url: "",
      domain: `Rehearsal page ${String(index + 1).padStart(2, "0")}`,
      publishedDate: null,
      extractionSource: "Rehearsal fixture",
      text: `Synthetic rehearsal record for “${claim}.” It contains no live web extraction and is included only to rehearse the source-tree interface.`,
      hasPrimaryEvidence: false,
      primaryEvidenceStatus: "not found",
      primaryEvidenceReason: "Synthetic rehearsal record; it contains no study, dataset, or primary source.",
      judgment: {
        kind: isRoot ? "origin" : "derived",
        parentId,
        confidence: isRoot ? 100 : 90,
        evidence: isRoot
          ? "Illustrative root used to rehearse the tree layout; it is not a live source judgment."
          : "Illustrative repeat edge used to rehearse the tree layout; it is not a live source judgment.",
      },
    };
  });
}

const brainClaim = "Humans use only 10% of their brains";
const startupClaim = "90% of startups fail";
const brainPages = rehearsalPages("brain", brainClaim, 10, 2, "Unverified repost cluster");
const startupPages = rehearsalPages("startup", startupClaim, 5, 1, "Unverified statistic attribution");

export const DEMO_ANALYSES: Record<string, EchoAnalysis> = {
  brain: {
    claim: brainClaim,
    createdAt: "2026-11-08T12:00:00.000Z",
    mode: "demo",
    demoLabel: "Synthetic rehearsal graph · not live research",
    claimSlot: "ghost",
    pages: brainPages,
    clusters: [{ id: "brain-cluster-1", label: "10% brain myth", pageIds: brainPages.map((page) => page.id) }],
    roots: ["brain-1", "brain-2"],
    verifiableRoots: [],
    answerSourceIds: ["brain-1", "brain-2"],
    summary: { totalPages: 10, independentOrigins: 2, verifiableOrigins: 0, echoPercentage: 80 },
    answer: "This synthetic rehearsal graph contains no traceable original study or dataset for the 10% claim. It demonstrates the interface only; use a live trace before treating this as a research finding.",
    echoContribution: "The synthetic repeat pages add no independent evidence. Their edges are placeholders for rehearsal.",
  },
  startup: {
    claim: startupClaim,
    createdAt: "2026-11-08T12:00:00.000Z",
    mode: "demo",
    demoLabel: "Synthetic rehearsal graph · verify the live source trail",
    claimSlot: "zombie",
    pages: startupPages,
    clusters: [{ id: "startup-cluster-1", label: "90% startup failure statistic", pageIds: startupPages.map((page) => page.id) }],
    roots: ["startup-1"],
    verifiableRoots: [],
    answerSourceIds: ["startup-1"],
    summary: { totalPages: 5, independentOrigins: 1, verifiableOrigins: 0, echoPercentage: 80 },
    answer: "This synthetic rehearsal graph models a repeated 90% startup-failure statistic with no underlying dataset attached. It is a UI placeholder, not a live conclusion about the statistic's origin or accuracy.",
    echoContribution: "The synthetic repeat pages add no independent evidence. Their edges are placeholders for rehearsal.",
  },
};

export function cloneDemoAnalysis(id: string): EchoAnalysis | null {
  const analysis = DEMO_ANALYSES[id];
  if (!analysis) return null;
  const copy = structuredClone(analysis);
  copy.pages = copy.pages.map((page) => ({
    ...page,
    extractionSource: "Rehearsal fixture",
    primaryEvidenceStatus: page.hasPrimaryEvidence ? "found" : "not found",
  }));
  return copy;
}
