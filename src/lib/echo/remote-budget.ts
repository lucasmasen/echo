import { Redis } from "@upstash/redis";

// The shared ledger (Upstash Redis) for a deployment: one hash per provider per Pacific day, holding `spent` and one
// `r:<id>` field per open reservation, all in micro-dollars. Claude keeps the old single-cap key (so a day spent before
// the split counts against Claude's ceiling, as the local ledger does); Tavily and Telem have their own keys, and
// Telem's spend over every day is one more counter with no expiry.
type Provider = "claude" | "tavily" | "telem";
const KEY_PREFIX = "echo:anthropic-budget:v1:";
const KEY_TTL_SECONDS = 3 * 24 * 60 * 60;
const TELEM_TOTAL_KEY = `${KEY_PREFIX}telem:total`;

const READ_SCRIPT = `
local out = {}
for k = 1, 3 do
  local fields = redis.call('HGETALL', KEYS[k])
  local spent = 0
  local reserved = 0
  for i = 1, #fields, 2 do
    if fields[i] == 'spent' then
      spent = tonumber(fields[i + 1]) or 0
    elseif string.sub(fields[i], 1, 2) == 'r:' then
      reserved = reserved + (tonumber(fields[i + 1]) or 0)
    end
  end
  table.insert(out, spent)
  table.insert(out, reserved)
end
table.insert(out, tonumber(redis.call('GET', KEYS[4]) or '0') or 0)
return out
`;

const RESERVE_SCRIPT = `
local fields = redis.call('HGETALL', KEYS[1])
local spent = 0
local reserved = 0
for i = 1, #fields, 2 do
  if fields[i] == 'spent' then
    spent = tonumber(fields[i + 1]) or 0
  elseif string.sub(fields[i], 1, 2) == 'r:' then
    reserved = reserved + (tonumber(fields[i + 1]) or 0)
  end
end
local cap = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
if redis.call('HGET', KEYS[1], 'r:' .. ARGV[3]) then
  return {1, spent, reserved}
end
if spent + reserved + amount > cap then
  return {0, spent, reserved}
end
redis.call('HSET', KEYS[1], 'r:' .. ARGV[3], amount)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return {1, spent, reserved}
`;

// KEYS[2], when given, is Telem's running total: a settled cost is added to it too.
const SETTLE_SCRIPT = `
local field = 'r:' .. ARGV[1]
if not redis.call('HGET', KEYS[1], field) then
  return 0
end
redis.call('HDEL', KEYS[1], field)
local actual = tonumber(ARGV[2])
if actual > 0 then
  redis.call('HINCRBY', KEYS[1], 'spent', actual)
  if KEYS[2] then
    redis.call('INCRBY', KEYS[2], actual)
  end
end
return 1
`;

let redis: Redis | null = null;

function client() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("The shared budget store is not configured.");
  redis ??= new Redis({ url, token, enableAutoPipelining: false, signal: () => AbortSignal.timeout(5_000) });
  return redis;
}

function micros(usd: number) {
  return Math.round(usd * 1_000_000);
}

function key(day: string, provider: Provider) {
  return provider === "claude" ? `${KEY_PREFIX}${day}` : `${KEY_PREFIX}${provider}:${day}`;
}

export function remoteBudgetConfiguration() {
  const hasUrl = Boolean(process.env.UPSTASH_REDIS_REST_URL);
  const hasToken = Boolean(process.env.UPSTASH_REDIS_REST_TOKEN);
  return hasUrl && hasToken ? "ready" : hasUrl || hasToken ? "partial" : "missing";
}

export async function getRemoteBudgetUsage(day: string) {
  const values = await client().eval<string[], number[]>(READ_SCRIPT, [key(day, "claude"), key(day, "tavily"), key(day, "telem"), TELEM_TOTAL_KEY], []);
  const usd = (index: number) => (Number(values[index]) || 0) / 1_000_000;
  return {
    providers: {
      claude: { spentUsd: usd(0), reservedUsd: usd(1) },
      tavily: { spentUsd: usd(2), reservedUsd: usd(3) },
      telem: { spentUsd: usd(4), reservedUsd: usd(5) },
    },
    telemTotalUsd: usd(6),
  };
}

export async function reserveRemoteBudget(day: string, id: string, capUsd: number, amountUsd: number, provider: Provider = "claude") {
  const [approved, spent, reserved] = await client().eval<string[], [number, number, number]>(
    RESERVE_SCRIPT,
    [key(day, provider)],
    [String(micros(capUsd)), String(micros(amountUsd)), id, String(KEY_TTL_SECONDS)],
  );
  return { approved: approved === 1, remainingUsd: Math.max(0, capUsd - (spent + reserved) / 1_000_000) };
}

export async function finishRemoteBudgetReservation(day: string, id: string, actualUsd: number | null, provider: Provider = "claude") {
  await client().eval<string[], number>(SETTLE_SCRIPT, provider === "telem" ? [key(day, provider), TELEM_TOTAL_KEY] : [key(day, provider)], [id, String(micros(actualUsd ?? 0))]);
}
