// The claim box's spending line, from GET /api/analyze's dailyBudget (daily-budget.ts getAnthropicBudgetSnapshot).
// Pure and client-safe: no server module is imported, so the shapes are restated here.

type ProviderLine = { capUsd: number; spentUsd: number; reservedUsd: number };
export type DailyBudgetStatus = {
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
  available: boolean;
  storage?: "local" | "shared" | "unavailable";
  /** Per provider (servers from 2026-11-13 on); an older server sends only the combined figures above. */
  providers?: { claude: ProviderLine; tavily: ProviderLine; telem: ProviderLine };
  telem?: { totalUsd: number; creditUsd: number };
};

const money = (usd: number) => `$${usd.toFixed(2)}`;
/** A whole-dollar credit reads "$20", any other "$12.50". */
const credit = (usd: number) => (Number.isInteger(usd) ? `$${usd}` : money(usd));
const atCap = (entry: ProviderLine) => entry.spentUsd + entry.reservedUsd >= entry.capUsd - 1e-9;
const used = (entry: ProviderLine) => `${money(entry.spentUsd)}${entry.reservedUsd > 0.005 ? ` (+${money(entry.reservedUsd)} reserved)` : ""} / ${money(entry.capUsd)}`;

/**
 * "Telem today $0.42 / $3.00 · total $1.10 of $20 credit · Claude $0.31 / $50.00 · Tavily $0.08 / $5.00 · local ledger ·
 * resets midnight Pacific" with Telem routing the searches; "Claude today … · Tavily …" without it. A router that is
 * misconfigured names no search provider. Each cap says when it is reached: Telem's sends searches to Tavily, Claude's
 * or Tavily's pauses live runs. The Telem total is advisory (Telem's console has the real balance).
 */
export function budgetLine(budget: DailyBudgetStatus, router: "telem" | "tavily" | "misconfigured" | null | undefined): string {
  if (!budget.available) return "Daily API cap tracking is unavailable here; live analysis is paused.";
  const tail = `${budget.storage === "shared" ? "shared ledger" : "local ledger"} · resets midnight Pacific`;
  const providers = budget.providers;
  if (!providers || router === "misconfigured") {
    // An older server's single combined figure, or a router that is not set up: no provider is named.
    return `Echo API today (Claude + search): ${money(budget.spentUsd)} spent${budget.reservedUsd > 0.005 ? ` · ${money(budget.reservedUsd)} reserved` : ""} · ${tail}`;
  }
  const parts: string[] = [];
  if (router === "telem") {
    const telem = providers.telem;
    parts.push(`Telem today ${used(telem)}`);
    if (budget.telem) parts.push(`total ${money(budget.telem.totalUsd)} of ${credit(budget.telem.creditUsd)} credit${budget.telem.totalUsd >= budget.telem.creditUsd - 1e-9 ? " (may be used up; check Telem's console)" : ""}`);
    if (atCap(telem)) parts.push("Telem cap reached: searches use Tavily until midnight");
    parts.push(`Claude ${used(providers.claude)}`);
  } else {
    parts.push(`Claude today ${used(providers.claude)}`);
  }
  parts.push(`Tavily ${used(providers.tavily)}`);
  const paused = [atCap(providers.claude) ? "Claude" : "", atCap(providers.tavily) ? "Tavily" : ""].filter(Boolean);
  if (paused.length) parts.push(`${paused.join(" and ")} cap reached, live runs paused (saved runs still open)`);
  parts.push(tail);
  return parts.join(" · ");
}
