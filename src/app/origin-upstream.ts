import type { EchoAnalysis } from "@/lib/echo/types";
import type { UpstreamRecord } from "@/lib/echo/upstream-fold";
import savedUpstream from "./origin-upstream-saved.json";

// "Echo went looking" results saved ahead of time for runs whose origins share a name (npm run origin:upstream writes
// origin-upstream-saved.json). In the build, so they show offline and cost nothing to display.
const SAVED = Object.values(savedUpstream as unknown as Record<string, UpstreamRecord>);

/** The saved look-up of exactly this trace (same claim, same capture time), or null. */
export function savedUpstreamFor(result: Pick<EchoAnalysis, "claim" | "createdAt">): UpstreamRecord | null {
  return SAVED.find((entry) => entry.traceCreatedAt === result.createdAt && entry.claim === result.claim) ?? null;
}
