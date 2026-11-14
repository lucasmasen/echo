import type { EchoPage } from "./types";
import { textOverlap } from "./wording";

// The same release posted on two sites the same day (a company newsroom and a
// wire service, for example) is one origin, not two independent ones. These
// helpers group such roots so the verdict does not overcount independence.

const CO_PUBLISHED_OVERLAP = 0.5;
const CO_PUBLISHED_MAX_DAYS = 3;
const TRUSTED_DATE_SOURCES = new Set(["page text", "URL date", "page metadata"]);

function dayNumber(date: string | null): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(value) ? null : value / 86_400_000;
}

/** The title without a trailing site name ("Title | Journal", "Title - Site"), lowercased, punctuation removed. */
/** Index sites that reproduce an article's abstract or record rather than publish it. */
export const INDEX_RECORD_HOSTS = /(?:^|\.)(?:pubmed\.ncbi\.nlm\.nih\.gov|europepmc\.org|semanticscholar\.org|researchgate\.net|scholar\.archive\.org)$/i;

export function coreTitle(title: string | undefined): string {
  const head = (title ?? "").split(/\s[|–—-]\s/)[0] ?? "";
  return head.toLocaleLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}'%]+/gu, " ").trim();
}

/**
 * The same work posted twice: a journal's full text and its PubMed abstract, say. Their passages differ, so the
 * text test misses them, but they carry the same distinctive title (five words or more) and either one cites the
 * other or they are dated within a year of each other.
 */
export function sameWork(first: EchoPage, second: EchoPage): boolean {
  const title = coreTitle(first.title);
  if (title.split(" ").length < 5 || title !== coreTitle(second.title)) return false;
  if (first.citations?.some((citation) => citation.pageId === second.id) || second.citations?.some((citation) => citation.pageId === first.id)) return true;
  const a = dayNumber(first.publishedDate);
  const b = dayNumber(second.publishedDate);
  return a !== null && b !== null && Math.abs(a - b) <= 366;
}

/** Groups (size ≥ 2) of root pages that are the same text published within a few days, or the same work posted twice. */
export function coPublishedRootGroups(rootPages: EchoPage[]): string[][] {
  const parent = new Map(rootPages.map((page) => [page.id, page.id] as const));
  const find = (id: string): string => {
    let current = id;
    while (parent.get(current) !== current) current = parent.get(current)!;
    return current;
  };
  for (const [index, first] of rootPages.entries()) {
    for (const second of rootPages.slice(index + 1)) {
      if (sameWork(first, second)) {
        parent.set(find(second.id), find(first.id));
        continue;
      }
      const a = dayNumber(first.publishedDate);
      const b = dayNumber(second.publishedDate);
      if (a === null || b === null || Math.abs(a - b) > CO_PUBLISHED_MAX_DAYS) continue;
      if (!TRUSTED_DATE_SOURCES.has(first.publishedDateSource ?? "") || !TRUSTED_DATE_SOURCES.has(second.publishedDateSource ?? "")) continue;
      if (Math.max(textOverlap(first.text, second.text), textOverlap(second.text, first.text)) < CO_PUBLISHED_OVERLAP) continue;
      parent.set(find(second.id), find(first.id));
    }
  }
  const groups = new Map<string, string[]>();
  for (const page of rootPages) {
    const key = find(page.id);
    groups.set(key, [...(groups.get(key) ?? []), page.id]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/** Origin counts after merging co-published roots. Without groups, equals the raw root counts. */
export function originCounts(roots: string[], verifiableRoots: string[], groups: string[][] = []) {
  const groupOf = new Map<string, number>();
  groups.forEach((group, index) => group.forEach((id) => groupOf.set(id, index)));
  const key = (id: string) => (groupOf.has(id) ? `group-${groupOf.get(id)}` : id);
  return {
    independent: new Set(roots.map(key)).size,
    verifiable: new Set(verifiableRoots.map(key)).size,
  };
}
