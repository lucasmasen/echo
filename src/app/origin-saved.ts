import type { TokenComparison } from "@/lib/echo/origin-layer";
import type { EchoAnalysis } from "@/lib/echo/types";
import savedComparisons from "./origin-layer-saved.json";

// Token comparisons measured ahead of time for saved runs (npm run origin:compare writes origin-layer-saved.json).
// In the build, so they show offline and cost nothing to display.
const SAVED = Object.values(savedComparisons as unknown as Record<string, TokenComparison>);

/** The saved comparison of exactly this trace (same claim, same capture time), or null. */
export function savedComparisonFor(result: Pick<EchoAnalysis, "claim" | "createdAt">): TokenComparison | null {
  return SAVED.find((entry) => entry.traceCreatedAt === result.createdAt && entry.claim === result.claim) ?? null;
}
