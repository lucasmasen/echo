import { AsyncLocalStorage } from "node:async_hooks";
import type { CostReceipt } from "./types";

type ClaudeEntry = CostReceipt["claude"][number];
type Stage = keyof Omit<CostReceipt["stageMs"], "total">;

/** The receipt a live run fills in while it runs. Only analyzeClaim opens one, so rejudge and copy hunt record nothing. */
export class ReceiptDraft {
  private readonly startedAt = Date.now();
  private readonly tavily = { basicSearches: 0, advancedSearches: 0, extractRequests: 0, extractedUrls: 0, credits: 0 };
  private readonly claude: ClaudeEntry[] = [];
  private readonly telem = { searches: 0, advancedSearches: 0, providerRuns: {} as Record<string, number>, usd: 0 };
  private readonly stageMs: Record<Stage, number> = { search: 0, extract: 0, grouping: 0, judgment: 0, answer: 0 };

  constructor(private readonly usdPerCredit: number) {}

  tavilyRequest(endpoint: "search" | "extract", depth: unknown, urls: number, credits: number) {
    if (endpoint === "search") {
      if (depth === "advanced") this.tavily.advancedSearches += 1;
      else this.tavily.basicSearches += 1;
    } else {
      this.tavily.extractRequests += 1;
      this.tavily.extractedUrls += urls;
    }
    this.tavily.credits += credits;
  }

  /** A completed Telem search: the providers whose runs answered (each billed once) and what they cost at list price. */
  telemRequest(advanced: boolean, providers: string[], usd: number) {
    this.telem.searches += 1;
    if (advanced) this.telem.advancedSearches += 1;
    for (const provider of providers) this.telem.providerRuns[provider] = (this.telem.providerRuns[provider] ?? 0) + 1;
    this.telem.usd += usd;
  }

  claudeRequest(entry: ClaudeEntry) {
    this.claude.push(entry);
  }

  addStage(stage: Stage, ms: number) {
    this.stageMs[stage] += ms;
  }

  /** Times one stage; a stage that runs more than once (none today) adds up. */
  async time<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await work();
    } finally {
      this.stageMs[stage] += Date.now() - start;
    }
  }

  finish(): CostReceipt {
    const round = (value: number) => Math.round(value * 1e6) / 1e6;
    const claudeUsd = this.claude.reduce((total, entry) => total + entry.usd, 0);
    const tavilyUsd = this.tavily.credits * this.usdPerCredit;
    // A Telem block only when a search went through Telem: a Tavily run's receipt keeps exactly its old fields.
    const telem = this.telem.searches > 0 ? this.telem : null;
    const telemUsd = telem ? round(telem.usd) : 0;
    return {
      version: 1,
      tavily: { ...this.tavily, usdPerCredit: this.usdPerCredit },
      claude: this.claude.map((entry) => ({ ...entry, usd: round(entry.usd) })),
      stageMs: { ...this.stageMs, total: Date.now() - this.startedAt },
      ...(telem ? { telem: { searches: telem.searches, advancedSearches: telem.advancedSearches, providerRuns: { ...telem.providerRuns } } } : {}),
      usd: { claude: round(claudeUsd), tavily: round(tavilyUsd), ...(telem ? { telem: telemUsd } : {}), total: telem ? round(claudeUsd + tavilyUsd + telem.usd) : round(claudeUsd + tavilyUsd) },
    };
  }
}

export const runReceipt = new AsyncLocalStorage<ReceiptDraft>();

/**
 * Puts a failed run's receipt on whatever it threw. EchoPipelineError has a costReceipt field; any other object (a
 * DOMException TimeoutError from a provider's time limit, a TypeError) gets the same property, non-enumerable so it
 * stays out of logs and JSON. A thrown non-object, or one that cannot take the property, is left as it is.
 */
export function attachCostReceipt(error: unknown, receipt: CostReceipt): void {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    Object.defineProperty(error, "costReceipt", { value: receipt, enumerable: false, writable: true, configurable: true });
  } catch {
    // A frozen or non-extensible error keeps no receipt; the route then sends the old error shape.
  }
}

/** The receipt analyzeClaim put on a thrown error, or undefined. */
export function costReceiptOf(error: unknown): CostReceipt | undefined {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return undefined;
  const receipt = (error as { costReceipt?: unknown }).costReceipt;
  return receipt && typeof receipt === "object" && (receipt as { version?: unknown }).version === 1 ? (receipt as CostReceipt) : undefined;
}
