import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { finishRemoteBudgetReservation, getRemoteBudgetUsage, remoteBudgetConfiguration, reserveRemoteBudget } from "./remote-budget";
import { searchRouter } from "./telem";

// Echo's spending guard, one cap per paid provider (Lucas's policy of 2026-11-13: Claude has no practical limit, Telem's
// prepaid credit is the money to be careful with):
//   claude: a generous runaway ceiling (default $50 a day) so a bug cannot loop forever; ECHO_CLAUDE_DAILY_CAP_USD.
//   tavily: searches and page reading (default $5 a day); ECHO_TAVILY_DAILY_CAP_USD.
//   telem:  searches routed by Telem (default $3 a day); ECHO_TELEM_DAILY_CAP_USD. Telem's spend is also kept as a
//           running total over every day, shown against ECHO_TELEM_CREDIT_USD (default $20, advisory: never a block).
// Every request still reserves its worst case before it is sent and settles (or releases) afterwards, per provider.
// ECHO_ANTHROPIC_DAILY_CAP_USD and ECHO_DAILY_CAP_OVERRIDE_USD (the old single $2 cap) are no longer read.
export type BudgetProvider = "claude" | "tavily" | "telem";
export const BUDGET_PROVIDERS: readonly BudgetProvider[] = ["claude", "tavily", "telem"];

const DEFAULT_DAILY_CAP_USD: Record<BudgetProvider, number> = { claude: 50, tavily: 5, telem: 3 };
/** A configured cap above this is held to it: the Claude ceiling cannot be switched off, nor Telem's set above its credit. */
const HARD_MAX_DAILY_CAP_USD: Record<BudgetProvider, number> = { claude: 200, tavily: 50, telem: 20 };
const CAP_VARIABLE: Record<BudgetProvider, string> = { claude: "ECHO_CLAUDE_DAILY_CAP_USD", tavily: "ECHO_TAVILY_DAILY_CAP_USD", telem: "ECHO_TELEM_DAILY_CAP_USD" };
const DEFAULT_TELEM_CREDIT_USD = 20;
const ACCOUNTING_TIME_ZONE = "America/Los_Angeles";
const LEDGER_PATH = path.join(process.cwd(), ".echo", "anthropic-daily-budget.json");
const LOCK_PATH = `${LEDGER_PATH}.lock`;
const FILE_LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

type ProviderUsage = {
  spentUsd: number;
  reservations: Record<string, number>;
};

type DayUsage = Partial<Record<BudgetProvider, ProviderUsage>>;

/**
 * Version 2 (2026-11-13): each day holds one entry per provider, and telemTotalUsd is Telem's spend over every day.
 * A version 1 ledger (one combined entry a day) still loads: its days become Claude's (the split is unknown, and most
 * of that spend was Claude), so Tavily's and Telem's caps and Telem's total count from the first run after the upgrade.
 */
type BudgetLedger = {
  version: 2;
  days: Record<string, DayUsage>;
  telemTotalUsd: number;
};

export type AnthropicBudgetReservation = { day: string; id: string; amountUsd: number; provider?: BudgetProvider; backend?: "redis" };
export type ProviderBudget = { capUsd: number; spentUsd: number; reservedUsd: number };
export type AnthropicBudgetSnapshot = {
  /** Claude's daily ceiling (what older readers of this snapshot called the cap). */
  capUsd: number;
  day: string;
  /** Today's spend and open reservations over every provider. */
  spentUsd: number;
  reservedUsd: number;
  available: boolean;
  storage: "local" | "shared" | "unavailable";
  providers: Record<BudgetProvider, ProviderBudget>;
  /** Telem's spend over every recorded day, and the prepaid credit it is shown against (advisory). */
  telem: { totalUsd: number; creditUsd: number };
};

let lockTail = Promise.resolve();

export class AnthropicBudgetError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AnthropicBudgetError";
    this.code = code;
  }
}

function todayInPacific() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ACCOUNTING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** A provider's daily cap: its variable when set to a non-negative number (held to the hard maximum), else the default. */
export function dailyCapUsd(provider: BudgetProvider): number {
  const raw = process.env[CAP_VARIABLE[provider]];
  const configured = Number(raw);
  if (raw?.trim() && Number.isFinite(configured) && configured >= 0) return Math.min(configured, HARD_MAX_DAILY_CAP_USD[provider]);
  return DEFAULT_DAILY_CAP_USD[provider];
}

/** The Telem credit the running total is shown against (ECHO_TELEM_CREDIT_USD, default $20). Advisory only. */
export function telemCreditUsd(): number {
  const raw = process.env.ECHO_TELEM_CREDIT_USD;
  const configured = Number(raw);
  return raw?.trim() && Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_TELEM_CREDIT_USD;
}

/** What a provider's cap covers, in words, for its messages. With Telem routing the searches, Tavily only reads pages. */
export function capWords(provider: BudgetProvider): string {
  if (provider === "claude") return "daily Claude cap";
  if (provider === "telem") return "daily Telem cap (searches)";
  return searchRouter() === "telem" ? "daily Tavily cap (page reading)" : "daily Tavily cap (searches and page reading)";
}

/** The error code a refusal carries: Telem's own, so a run can fall back to Tavily; the others' as before. */
function capCode(provider: BudgetProvider) {
  return provider === "telem" ? "TELEM_DAILY_CAP" : "DAILY_BUDGET_REACHED";
}

function capReachedError(provider: BudgetProvider, capUsd: number, remainingUsd: number) {
  return new AnthropicBudgetError(
    capCode(provider),
    `Echo’s $${capUsd.toFixed(2)} ${capWords(provider)} is reached, or too close for this request. About $${Math.max(0, remainingUsd).toFixed(2)} remains; it resets at midnight Pacific time.`,
  );
}

function emptyLedger(): BudgetLedger {
  return { version: 2, days: {}, telemTotalUsd: 0 };
}

function validUsage(entry: unknown): entry is ProviderUsage {
  if (!entry || typeof entry !== "object") return false;
  const { spentUsd, reservations } = entry as Partial<ProviderUsage>;
  if (!Number.isFinite(spentUsd) || Number(spentUsd) < 0 || !reservations || typeof reservations !== "object" || Array.isArray(reservations)) return false;
  return Object.values(reservations).every((amount) => Number.isFinite(amount) && amount >= 0);
}

async function readLedger(): Promise<BudgetLedger> {
  try {
    const parsed = JSON.parse(await readFile(LEDGER_PATH, "utf8")) as { version?: unknown; days?: unknown; telemTotalUsd?: unknown };
    if (!parsed.days || typeof parsed.days !== "object" || Array.isArray(parsed.days)) throw new Error("Invalid ledger shape");
    const days = parsed.days as Record<string, unknown>;
    if (parsed.version === 1) {
      const ledger = emptyLedger();
      for (const [day, entry] of Object.entries(days)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !validUsage(entry)) throw new Error("Invalid ledger day");
        ledger.days[day] = { claude: { spentUsd: entry.spentUsd, reservations: { ...entry.reservations } } };
      }
      return ledger;
    }
    if (parsed.version !== 2 || !Number.isFinite(parsed.telemTotalUsd) || Number(parsed.telemTotalUsd) < 0) throw new Error("Invalid ledger shape");
    for (const [day, entry] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid ledger day");
      for (const [provider, usage] of Object.entries(entry)) {
        if (!BUDGET_PROVIDERS.includes(provider as BudgetProvider) || !validUsage(usage)) throw new Error("Invalid ledger usage");
      }
    }
    return parsed as BudgetLedger;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyLedger();
    throw new AnthropicBudgetError("BUDGET_LEDGER_ERROR", "Echo could not read its budget ledger, so live calls are paused to protect your caps.");
  }
}

async function writeLedger(ledger: BudgetLedger) {
  await mkdir(path.dirname(LEDGER_PATH), { recursive: true });
  const tempPath = `${LEDGER_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, LEDGER_PATH);
}

async function withLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = lockTail;
  let release = () => {};
  lockTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  let releaseFileLock: (() => Promise<void>) | null = null;
  try {
    releaseFileLock = await acquireFileLock();
    return await operation();
  } finally {
    try {
      if (releaseFileLock) await releaseFileLock();
    } finally {
      release();
    }
  }
}

async function acquireFileLock() {
  await mkdir(path.dirname(LEDGER_PATH), { recursive: true });
  const token = randomUUID();
  const lockValue = JSON.stringify({ pid: process.pid, token, createdAt: Date.now() });
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const handle = await open(LOCK_PATH, "wx", 0o600);
      try {
        await handle.writeFile(lockValue, "utf8");
      } finally {
        await handle.close();
      }
      return async () => {
        try {
          if (await readFile(LOCK_PATH, "utf8") === lockValue) await unlink(LOCK_PATH);
        } catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") {
        throw new AnthropicBudgetError("BUDGET_LOCK_ERROR", "Echo could not lock its budget ledger, so live calls are paused to protect your caps.");
      }
      await removeDeadStaleLock();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new AnthropicBudgetError("BUDGET_LOCK_TIMEOUT", "Another Echo run is updating the daily budget. Wait a moment and retry; no paid request was sent.");
}

async function removeDeadStaleLock() {
  try {
    const original = await readFile(LOCK_PATH, "utf8");
    const info = await stat(LOCK_PATH);
    if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return;
    let ownerPid: number | null = null;
    try {
      const owner = JSON.parse(original) as { pid?: unknown };
      if (Number.isInteger(owner.pid) && Number(owner.pid) > 0) ownerPid = Number(owner.pid);
    } catch {
      ownerPid = null;
    }
    if (ownerPid !== null) {
      try {
        process.kill(ownerPid, 0);
        return;
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") return;
      }
    }
    // Recheck the unique contents so a stale observer cannot delete a newer lock.
    if (await readFile(LOCK_PATH, "utf8") === original) await unlink(LOCK_PATH);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") return;
  }
}

function ensureUsage(ledger: BudgetLedger, day: string, provider: BudgetProvider) {
  ledger.days[day] ??= {};
  ledger.days[day][provider] ??= { spentUsd: 0, reservations: {} };
  return ledger.days[day][provider]!;
}

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function snapshotFrom(day: string, storage: AnthropicBudgetSnapshot["storage"], available: boolean, usage: Record<BudgetProvider, { spentUsd: number; reservedUsd: number }>, telemTotalUsd: number): AnthropicBudgetSnapshot {
  const providers = Object.fromEntries(BUDGET_PROVIDERS.map((provider) => [provider, {
    capUsd: dailyCapUsd(provider),
    spentUsd: roundUsd(usage[provider].spentUsd),
    reservedUsd: roundUsd(usage[provider].reservedUsd),
  }])) as Record<BudgetProvider, ProviderBudget>;
  return {
    capUsd: providers.claude.capUsd,
    day,
    spentUsd: roundUsd(BUDGET_PROVIDERS.reduce((sum, provider) => sum + providers[provider].spentUsd, 0)),
    reservedUsd: roundUsd(BUDGET_PROVIDERS.reduce((sum, provider) => sum + providers[provider].reservedUsd, 0)),
    available,
    storage,
    providers,
    telem: { totalUsd: roundUsd(telemTotalUsd), creditUsd: telemCreditUsd() },
  };
}

const NOTHING = (): Record<BudgetProvider, { spentUsd: number; reservedUsd: number }> => ({ claude: { spentUsd: 0, reservedUsd: 0 }, tavily: { spentUsd: 0, reservedUsd: 0 }, telem: { spentUsd: 0, reservedUsd: 0 } });

export async function getAnthropicBudgetSnapshot(): Promise<AnthropicBudgetSnapshot> {
  const remote = remoteBudgetConfiguration();
  if (remote === "ready") {
    const day = todayInPacific();
    try {
      const usage = await getRemoteBudgetUsage(day);
      return snapshotFrom(day, "shared", true, usage.providers, usage.telemTotalUsd);
    } catch {
      throw new AnthropicBudgetError("BUDGET_STORE_ERROR", "Echo could not reach its shared budget store, so live calls are paused to protect your caps.");
    }
  }
  if (remote === "partial") {
    throw new AnthropicBudgetError("BUDGET_STORE_ERROR", "Echo needs both Upstash Redis environment variables for its shared budget store; live calls are paused.");
  }
  if (process.env.VERCEL === "1") {
    return snapshotFrom(todayInPacific(), "unavailable", false, NOTHING(), 0);
  }
  return withLedgerLock(async () => {
    const day = todayInPacific();
    const ledger = await readLedger();
    const usage = NOTHING();
    for (const provider of BUDGET_PROVIDERS) {
      const entry = ledger.days[day]?.[provider];
      if (entry) usage[provider] = { spentUsd: entry.spentUsd, reservedUsd: Object.values(entry.reservations).reduce((sum, amount) => sum + amount, 0) };
    }
    return snapshotFrom(day, "local", true, usage, ledger.telemTotalUsd);
  });
}

/** What is left under a provider's cap today (cap - spent - reserved), never below zero. */
export function headroomUsd(snapshot: AnthropicBudgetSnapshot, provider: BudgetProvider): number {
  const entry = snapshot.providers[provider];
  return Math.max(0, entry.capUsd - entry.spentUsd - entry.reservedUsd);
}

const TOO_LITTLE: Record<BudgetProvider, string> = {
  claude: "That is too little to reserve the source-judgment output, so Echo stopped before spending search credits.",
  tavily: "That is too little for this run's searches and page reading, so Echo stopped before spending search credits.",
  telem: "That is too little for this run's Telem searches.",
};

/**
 * Before a run spends anything: each named provider must have at least that much left under its own cap. A number is
 * Claude's minimum (the old single-cap call). A provider at or over its cap is "reached for today".
 */
export async function assertAnthropicBudgetHeadroom(minimum: number | Partial<Record<BudgetProvider, number>> = 0) {
  const minimums = typeof minimum === "number" ? { claude: minimum } : minimum;
  const snapshot = await getAnthropicBudgetSnapshot();
  if (!snapshot.available) {
    throw new AnthropicBudgetError("BUDGET_STORAGE_UNAVAILABLE", "Live analysis is paused on this deployment because Echo's daily spending caps need shared persistent storage.");
  }
  for (const provider of BUDGET_PROVIDERS) {
    const needed = minimums[provider];
    if (needed === undefined) continue;
    const entry = snapshot.providers[provider];
    if (entry.spentUsd + entry.reservedUsd >= entry.capUsd) {
      throw new AnthropicBudgetError(capCode(provider), `Echo’s $${entry.capUsd.toFixed(2)} ${capWords(provider)} is reached for today. It resets at midnight Pacific time.`);
    }
    if (entry.spentUsd + entry.reservedUsd + needed > entry.capUsd + 1e-9) {
      throw new AnthropicBudgetError(capCode(provider), `About $${headroomUsd(snapshot, provider).toFixed(2)} remains under Echo’s $${entry.capUsd.toFixed(2)} ${capWords(provider)}. ${TOO_LITTLE[provider]}`);
    }
  }
}

/** Reserves one request's worst case against its provider's cap (Claude when no provider is named). */
export async function reserveAnthropicBudget(amountUsd: number, provider: BudgetProvider = "claude"): Promise<AnthropicBudgetReservation> {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new AnthropicBudgetError("BUDGET_ESTIMATE_ERROR", "Echo could not estimate this request's cost safely, so it was stopped before sending it.");
  }
  const remote = remoteBudgetConfiguration();
  if (remote === "ready") {
    const day = todayInPacific();
    const id = randomUUID();
    const estimate = roundUsd(amountUsd);
    const capUsd = dailyCapUsd(provider);
    try {
      const reservation = await reserveRemoteBudget(day, id, capUsd, estimate, provider);
      if (!reservation.approved) throw capReachedError(provider, capUsd, reservation.remainingUsd);
      return { day, id, amountUsd: estimate, provider, backend: "redis" };
    } catch (error) {
      if (error instanceof AnthropicBudgetError) throw error;
      throw new AnthropicBudgetError("BUDGET_STORE_ERROR", "Echo could not reserve this request in its shared budget store, so nothing was sent.");
    }
  }
  if (remote === "partial") {
    throw new AnthropicBudgetError("BUDGET_STORE_ERROR", "Echo needs both Upstash Redis environment variables for its shared budget store; nothing was sent.");
  }
  if (process.env.VERCEL === "1") {
    throw new AnthropicBudgetError("BUDGET_STORAGE_UNAVAILABLE", "Live calls are paused on this deployment because Echo's daily spending caps need shared persistent storage. Use the local app or connect a durable budget store first.");
  }

  return withLedgerLock(async () => {
    const day = todayInPacific();
    const ledger = await readLedger();
    const usage = ensureUsage(ledger, day, provider);
    const reservedUsd = Object.values(usage.reservations).reduce((sum, amount) => sum + amount, 0);
    const capUsd = dailyCapUsd(provider);
    const estimate = roundUsd(amountUsd);
    if (usage.spentUsd + reservedUsd + estimate > capUsd + 1e-9) throw capReachedError(provider, capUsd, capUsd - usage.spentUsd - reservedUsd);
    const id = randomUUID();
    usage.reservations[id] = estimate;
    await writeLedger(ledger);
    return { day, id, amountUsd: estimate, provider };
  });
}

export async function settleAnthropicBudget(reservation: AnthropicBudgetReservation, actualUsd: number) {
  return updateReservation(reservation, actualUsd);
}

export async function releaseAnthropicBudget(reservation: AnthropicBudgetReservation) {
  return updateReservation(reservation, null);
}

async function updateReservation(reservation: AnthropicBudgetReservation, actualUsd: number | null) {
  const provider = reservation.provider ?? "claude";
  if (reservation.backend === "redis") {
    try {
      await finishRemoteBudgetReservation(reservation.day, reservation.id, actualUsd, provider);
      return;
    } catch {
      throw new AnthropicBudgetError("BUDGET_STORE_ERROR", "Echo could not reconcile a reservation in its shared budget store. Live calls remain guarded by the outstanding reservation.");
    }
  }
  return withLedgerLock(async () => {
    const ledger = await readLedger();
    const usage = ledger.days[reservation.day]?.[provider];
    if (!usage || !(reservation.id in usage.reservations)) return;
    delete usage.reservations[reservation.id];
    if (actualUsd !== null && Number.isFinite(actualUsd) && actualUsd >= 0) {
      usage.spentUsd = roundUsd(usage.spentUsd + actualUsd);
      if (provider === "telem") ledger.telemTotalUsd = roundUsd(ledger.telemTotalUsd + actualUsd);
    }
    await writeLedger(ledger);
  });
}
