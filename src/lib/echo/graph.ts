import type { EchoAnalysis, EchoPage } from "./types";
import { pageKey } from "./url";

/**
 * A date read off the page itself (page text, URL or metadata, never a search estimate, with its source recorded), as a
 * plain year or ISO date no later than two days after `nowMs` (the pipeline's limit, for time zones). The same rule as
 * reliablyDatedPages in src/app/trace-view.ts, so "dates to verify" here and "no reliable date" on screen agree.
 */
export function hasReliableDate(page: Pick<EchoPage, "publishedDate" | "publishedDateSource">, nowMs = Date.now()): boolean {
  const latest = new Date(nowMs + 2 * 86_400_000).toISOString().slice(0, 10);
  return Boolean(page.publishedDate && page.publishedDateSource && page.publishedDateSource !== "Tavily estimate"
    && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(page.publishedDate) && page.publishedDate <= latest);
}

export function summarizeTraceSignals(pages: EchoPage[], nowMs = Date.now()) {
  return {
    likelyEchoes: pages.filter((page) => page.judgment.kind === "derived").length,
    possiblePaths: pages.filter((page) => page.judgment.kind === "unclear" && Boolean(page.judgment.parentId)).length,
    /** Pages with no reliable date (hasReliableDate): none, a search estimate, or an odd or future one. */
    datesToVerify: pages.filter((page) => !hasReliableDate(page, nowMs)).length,
  };
}

export function downstreamEchoes(sourceId: string, pages: EchoPage[]): { direct: EchoPage[]; all: EchoPage[] } {
  const children = new Map<string, EchoPage[]>();
  for (const page of pages) {
    const parentId = page.judgment.parentId;
    if (page.judgment.kind !== "derived" || !parentId) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(page);
    children.set(parentId, siblings);
  }

  const direct = children.get(sourceId) ?? [];
  const all: EchoPage[] = [];
  const visited = new Set([sourceId]);
  const queue = [...direct];
  for (let index = 0; index < queue.length; index += 1) {
    const page = queue[index];
    if (visited.has(page.id)) continue;
    visited.add(page.id);
    all.push(page);
    queue.push(...(children.get(page.id) ?? []));
  }
  return { direct: direct.filter((page) => page.id !== sourceId), all };
}

/**
 * downstreamEchoes for a root published together with others (a coPublishedRootGroups group, counted as one
 * independent origin): the union of every group member's echoes, each page once, never a member itself. `partners`
 * lists the other members whose echoes add pages this root's own links do not reach (asurion.com, whose Fox 13 copy
 * hangs off its same-day PR Newswire release), so the screen can say whose are included. A root in no group, or a
 * page that is not a root of its group, gets its own downstreamEchoes and no partners. Display only.
 */
export function groupDownstreamEchoes(sourceId: string, pages: EchoPage[], groups: string[][] = []): { direct: EchoPage[]; all: EchoPage[]; partners: EchoPage[] } {
  const own = downstreamEchoes(sourceId, pages);
  const group = groups.find((members) => members.length > 1 && members.includes(sourceId));
  if (!group) return { ...own, partners: [] };
  const members = new Set(group);
  const direct: EchoPage[] = [];
  const all: EchoPage[] = [];
  const seenDirect = new Set<string>();
  const seenAll = new Set<string>();
  const partners: EchoPage[] = [];
  for (const id of [sourceId, ...group.filter((other) => other !== sourceId)]) {
    const reach = id === sourceId ? own : downstreamEchoes(id, pages);
    let added = false;
    for (const page of reach.direct) if (!members.has(page.id) && !seenDirect.has(page.id)) { seenDirect.add(page.id); direct.push(page); }
    for (const page of reach.all) if (!members.has(page.id) && !seenAll.has(page.id)) { seenAll.add(page.id); all.push(page); added = true; }
    const partner = pages.find((page) => page.id === id);
    if (id !== sourceId && added && partner) partners.push(partner);
  }
  return { direct, all, partners };
}

/**
 * The one rule for which page of roots published together (a coPublishedRootGroups group, counted as one independent
 * origin) leads it, used by every surface: the supplied-links list and Cite once, the tree's ORIGIN / SAME RELEASE
 * tags, the source detail's pair note, the reports and Present. The lead is the page with its own evidence
 * (verifiableRoots), then the one the answer cites (answerSourceIds), then the earliest reliable date, then the order
 * the links were supplied in (a search result: the trace's page order). So pasting the same links in another order
 * never moves the lead. Returns the group's ids that are trace pages, lead first, the others in the same order.
 */
export function coPublishedLeadOrder(analysis: Pick<EchoAnalysis, "pages" | "verifiableRoots" | "answerSourceIds" | "sourceCheck">, group: string[]): string[] {
  const pages = new Map(analysis.pages.map((page, index) => [page.id, { page, index }] as const));
  const verifiable = new Set(analysis.verifiableRoots ?? []);
  const cited = new Set(analysis.answerSourceIds ?? []);
  const supplied = analysis.sourceCheck ? analysis.sourceCheck.urls.map(pageKey) : null;
  const order = (id: string) => {
    const entry = pages.get(id)!;
    const at = supplied ? supplied.indexOf(pageKey(entry.page.url)) : -1;
    return at >= 0 ? at : (supplied?.length ?? 0) + entry.index;
  };
  const date = (id: string) => { const page = pages.get(id)!.page; return hasReliableDate(page) ? page.publishedDate! : "9999"; };
  return group.filter((id) => pages.has(id)).toSorted((a, b) => Number(verifiable.has(b)) - Number(verifiable.has(a))
    || Number(cited.has(b)) - Number(cited.has(a))
    || (date(a) < date(b) ? -1 : date(a) > date(b) ? 1 : 0)
    || order(a) - order(b));
}
