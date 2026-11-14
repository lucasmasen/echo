import { dateFrom, fetchPublishedMetadata } from "./pipeline";
import type { EchoPage } from "./types";

export type DateSource = NonNullable<EchoPage["publishedDateSource"]>;

export interface DateCoverageRow {
  url: string;
  date: string | null;
  source: DateSource | null;
}

export interface DateCoverage {
  rows: DateCoverageRow[];
  /** Dates from page text, the URL path, or publisher metadata: usable for direction. */
  trusted: number;
  /** Only a search-provider estimate, which can be a later update. */
  estimated: number;
  missing: number;
}

const TRUSTED: DateSource[] = ["page text", "URL date", "page metadata"];

export function isTrustedDateSource(source: DateSource | null | undefined): boolean {
  return Boolean(source && TRUSTED.includes(source));
}

/**
 * Resolves the best available date for search results the same way a live
 * trace does: page text, then URL path, then publisher metadata fetched
 * directly from the page (no provider credits), then the search estimate.
 */
export async function resolveDateCoverage(
  items: Array<{ url: string; publishedDate?: string | null; text?: string }>,
  options: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<DateCoverage> {
  const rows: DateCoverageRow[] = items.map((item) => {
    const resolved = dateFrom(item.publishedDate ?? null, item.text ?? "", item.url);
    return { url: item.url, date: resolved.date, source: resolved.source ?? null };
  });
  const pending = rows.filter((row) => !isTrustedDateSource(row.source));
  const concurrency = Math.max(1, options.concurrency ?? 8);
  for (let offset = 0; offset < pending.length; offset += concurrency) {
    await Promise.all(pending.slice(offset, offset + concurrency).map(async (row) => {
      const date = await fetchPublishedMetadata(row.url, options.signal);
      if (date) Object.assign(row, { date, source: "page metadata" as const });
    }));
  }
  return {
    rows,
    trusted: rows.filter((row) => isTrustedDateSource(row.source)).length,
    estimated: rows.filter((row) => row.source === "Tavily estimate").length,
    missing: rows.filter((row) => !row.date).length,
  };
}
