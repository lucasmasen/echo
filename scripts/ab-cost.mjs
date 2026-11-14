// Runs one of the deferred cost experiments as an A/B and prints a comparison table and a one-line verdict.
//   npm run ab:cost -- <experiment> [--trace file.echo.json ...] [--claim "Claim" ...] [--runs N] [--below N]
//                      [--control saved.echo.json] [--save dir] [--out table.md] [--json report.json] [--run]
// Experiments (arm A is today's default, arm B the switch):
//   thinking        rejudge saved traces as they are and with ECHO_THINKING_OFF=judgment (1 judge request a pass)
//   raw-content     one live trace:claim run per arm, without and with ECHO_SEARCH_RAW_CONTENT=1
//   haiku-grouping  regroup:trace on saved traces with claude-sonnet-5-5 (the noise floor) and claude-haiku-5-5
//   deep-search     one live run per arm on a thin claim, with the default trigger (20) and ECHO_DEEP_SEARCH_BELOW=N
//                   (--below, default 0: skip the advanced pass)
// Without --trace/--claim: thinking uses the bundled demo traces that have label sheets, haiku-grouping every saved
// trace, raw-content and deep-search the phones claim (slot 02, thin on every saved run).
//
// Money. A DRY RUN IS THE DEFAULT: it prints the plan, the requests each pass makes and a worst-case cost, checks that
// against what is left under today's cap, and sends nothing (it sizes judge prompts with a stubbed fetch that never
// leaves this process). --run is required to spend. Before the first paid request the script refuses when the worst
// case exceeds what is left under today's cap. Every request then goes through the same code as a live run
// (claudeJson and tavilyPost), so each is reserved before it is sent and settled from the provider's reported usage
// in Echo's ledger (.echo/ or the shared Redis store), exactly like trace:claim, rejudge:trace and regroup:trace. A
// ledger refusal mid-job ends the job. Nothing here raises the cap or turns the ledger off.
// Worst cases: a judge or grouping pass is sized from its exact prompt (150 + chars/2.5 tokens, +15%, the whole
// output limit). A live run cannot be sized before it searches, so it is bounded: 20 pages at the most each request
// can carry (LIVE_PROMPT_BOUNDS, checked against every saved trace by measure:cost), every query searched, the
// advanced pass included unless the arm skips it, 4 extract credits, and raw-content searches billed at 2 credits.
// --control saved.echo.json uses a saved live run (with its cost receipt) as arm A of a live experiment, so only arm B
// spends; use a run made on the same code (trace:claim) for a fair comparison.
//
// What it compares: label scores (eval:trace's scoreTrace: pages matching labels, wrong confident calls, unclear,
// exact parents), origins, receipt tokens, dollars and Tavily credits, and stage times. One pass per arm per run;
// on even runs arm B goes first, so drift over the session does not favour one arm.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { regroupTraces, worstCaseUsd, defaultTraceFiles, isSuppliedLinksRun } from "./regroup-trace.mjs";

const load = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(code, filename);
};

export const EXPERIMENTS = ["thinking", "raw-content", "haiku-grouping", "deep-search"];
export const JUDGE_MAX_TOKENS = 5200; // pipeline.ts judgePages
const ANSWER_MAX_TOKENS = 1200; // pipeline.ts synthesizeAnswer
const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";
// The most characters each live request can carry with 20 pages (12 answer roots): grouping sends 750 characters of
// text per page, the judge 1,200 plus metadata, citations (up to 8) and shared wording, the answer 1,000 per root
// (with metadata). measure:cost asserts every saved trace's replayed requests use under 70% of these (largest
// on 11/13: grouping 56%, judge 30%, answer 50%).
export const LIVE_PROMPT_BOUNDS = { maxPages: 20, groupingChars: 1_500 + 20 * 1_700, judgeChars: 10_000 + 20 * 6_000, answerChars: 3_000 + 12 * 2_500, schemaChars: { grouping: 400, judgment: 3_000, answer: 1_000 } };
// A live run's Tavily credits at most: every query basic, 3 advanced at 2, and 20 pages extracted in 2 batches of 10.
const ADVANCED_QUERIES = 3;
const MAX_EXTRACT_CREDITS = 4;

/** The decision rule each experiment's verdict applies; printed with the plan, before anything is spent. */
export const PASS_CRITERIA = {
  thinking: "PASS (turn ECHO_THINKING_OFF=judgment on) if, over the same passes, B makes no more wrong confident calls than A, matches labels within 1 page a pass, keeps exact parents within 1 and origins within 1 a pass, AND cuts the judge's mean cost or time by at least 15%. Quality worse: FAIL. Quality kept but under 15% saved: NO GAIN.",
  "raw-content": "PASS (turn ECHO_SEARCH_RAW_CONTENT=1 on) if B's searches still bill 1 credit each (basic) and 2 (advanced), B saves at least 2 Tavily credits a run, and B makes no more wrong calls, matches labels within 1 page, keeps exact parents within 1 and origins within 1. Searches billed more: FAIL. Quality worse: FAIL. Under 2 credits saved: NO GAIN.",
  "haiku-grouping": "PASS (set ANTHROPIC_GROUPING_MODEL=claude-haiku-5-5) if, against the saved groupings, Haiku moves at most 1 page a pass more than Sonnet's own rerun (the noise floor), breaks at most 0.5 parent links a pass more, and excludes no root page that Sonnet keeps, at a lower cost. Otherwise FAIL.",
  "deep-search": "PASS (lower ECHO_DEEP_SEARCH_BELOW to B's value) if A's advanced pass added no page that A judged an origin or that a label sheet calls an origin, and B makes no more wrong calls and finds no fewer origins than A. Any origin found only by the advanced pass: FAIL (keep 20). A's basic search reached the trigger (no advanced pass ran): INCONCLUSIVE, the claim is not thin today.",
};

const ARMS = {
  thinking: { variable: "ECHO_THINKING_OFF", A: { label: "thinking on (today)", env: { ECHO_THINKING_OFF: undefined } }, B: { label: "ECHO_THINKING_OFF=judgment", env: { ECHO_THINKING_OFF: "judgment" } } },
  "raw-content": { variable: "ECHO_SEARCH_RAW_CONTENT", A: { label: "extract (today)", env: { ECHO_SEARCH_RAW_CONTENT: undefined } }, B: { label: "ECHO_SEARCH_RAW_CONTENT=1", env: { ECHO_SEARCH_RAW_CONTENT: "1" } } },
  "haiku-grouping": { variable: "grouping model", A: { label: "claude-sonnet-5-5 (noise floor)", model: "claude-sonnet-5-5" }, B: { label: "claude-haiku-5-5", model: "claude-haiku-5-5" } },
  "deep-search": { variable: "ECHO_DEEP_SEARCH_BELOW", A: { label: "trigger 20 (today)", env: { ECHO_DEEP_SEARCH_BELOW: undefined } }, B: (below) => ({ label: `ECHO_DEEP_SEARCH_BELOW=${below}`, env: { ECHO_DEEP_SEARCH_BELOW: String(below) } }) },
};
const OTHER_SWITCHES = ["ANTHROPIC_MODEL", "ANTHROPIC_CLASSIFIER_MODEL", "ANTHROPIC_ANSWER_MODEL", "ANTHROPIC_GROUPING_MODEL", "ECHO_THINKING_OFF", "ECHO_SEARCH_RAW_CONTENT", "ECHO_DEEP_SEARCH_BELOW", "ECHO_PROMPT_CACHE", "ECHO_SEARCH_CACHE", "ECHO_RETELLING_CHECK", "ECHO_HTML_LINKS", "ECHO_TAVILY_USD_PER_CREDIT", "ECHO_DAILY_CAP_OVERRIDE_USD", "ECHO_ANTHROPIC_DAILY_CAP_USD"];
// A stop of this kind ends the job (the ledger refused, or a key is wrong); any other failure is recorded and the job goes on.
const STOP_CODES = new Set(["DAILY_BUDGET_REACHED", "BUDGET_LEDGER_ERROR", "BUDGET_LOCK_ERROR", "BUDGET_LOCK_TIMEOUT", "BUDGET_STORE_ERROR", "BUDGET_STORAGE_UNAVAILABLE", "BUDGET_ESTIMATE_ERROR", "BUDGET_MODEL_UNSUPPORTED", "CLAUDE_AUTH", "TAVILY_AUTH", "MISSING_KEYS"]);

/** Same rule as pipeline.ts tavilyUsdPerCredit: what the ledger charges per Tavily credit. */
function tavilyUsdPerCredit() {
  const configured = Number(process.env.ECHO_TAVILY_USD_PER_CREDIT ?? 0.008);
  return Number.isFinite(configured) && configured > 0 ? configured : 0;
}

async function withEnv(env, work) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

/**
 * The exact count_tokens body a piece of pipeline work would send first, captured with a stubbed fetch that answers
 * 500 (so claudeJson stops before reserving anything) and refuses every other address. Nothing leaves this process.
 */
async function captureTokenCountBody(work) {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  let body = null;
  let other = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === COUNT_TOKENS_URL && !body) {
      body = JSON.parse(String(init?.body ?? "{}"));
      return new Response("{}", { status: 500 });
    }
    other += 1;
    throw new TypeError("ab:cost planning sends nothing");
  };
  if (!realKey) process.env.ANTHROPIC_API_KEY = "ab-cost-planning-only";
  try {
    await work();
  } catch {
    // Expected: the stubbed token count fails, so the work stops before any reservation or paid request.
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  }
  if (!body || other) throw new Error("ab:cost could not size a request offline; nothing was sent.");
  return body;
}

const promptChars = (body) => {
  const content = body.messages?.[0]?.content;
  return typeof content === "string" ? content.length : (content ?? []).reduce((total, block) => total + (block.text?.length ?? 0), 0);
};
const normalizeClaim = (claim) => claim.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
const unjudged = (pages) => pages.map((page) => {
  const copy = { ...page };
  for (const field of ["judgment", "hasPrimaryEvidence", "primaryEvidenceStatus", "primaryEvidenceReason"]) delete copy[field];
  return copy;
});

/** Worst-case dollars for one live run of `claim` under the current environment (the arm's switches applied). */
export function liveRunWorstUsd(pipeline, claim, { rawContent, deepSearch }) {
  const env = process.env;
  const model = env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  const classifier = env.ANTHROPIC_CLASSIFIER_MODEL || model;
  const grouping = env.ANTHROPIC_GROUPING_MODEL?.trim() || classifier;
  const answer = env.ANTHROPIC_ANSWER_MODEL || model;
  const price = (name) => {
    const found = pipeline.modelPriceUsdPerMillion(name);
    if (!found) throw Object.assign(new Error(`Echo's budget guard has no price for ${name}; nothing was sent.`), { code: "BUDGET_MODEL_UNSUPPORTED" });
    return found;
  };
  const bounds = LIVE_PROMPT_BOUNDS;
  const claude = worstCaseUsd(bounds.groupingChars + claim.length, bounds.schemaChars.grouping, price(grouping), pipeline.GROUPING_MAX_TOKENS)
    + worstCaseUsd(bounds.judgeChars + claim.length, bounds.schemaChars.judgment, price(classifier), JUDGE_MAX_TOKENS)
    + worstCaseUsd(bounds.answerChars + claim.length, bounds.schemaChars.answer, price(answer), ANSWER_MAX_TOKENS);
  const queries = pipeline.generateQueries(claim).length;
  // Tavily lists no surcharge for include_raw_content, but that is what the experiment checks: assume 2 credits.
  const searchCredit = rawContent ? 2 : 1;
  const credits = queries * searchCredit + (deepSearch ? ADVANCED_QUERIES * 2 * searchCredit : 0) + MAX_EXTRACT_CREDITS;
  return { usd: claude + credits * tavilyUsdPerCredit(), claudeUsd: claude, credits, queries };
}

function scoreOf(evaluation, analysis, sheet) {
  const origins = analysis.pages.filter((page) => page.judgment?.kind === "origin").length;
  if (!sheet) return { origins, labeled: false };
  const score = evaluation.scoreTrace(analysis, sheet);
  return { origins, labeled: true, match: score.exactKinds, matched: score.matched, wrong: score.settledMistakes, unclear: score.abstentions, exactParents: score.exactEdges, derivedGold: score.derivedGold, sameWork: score.sameWorkEdges };
}

function receiptFields(receipt) {
  if (!receipt) return {};
  const sum = (key) => receipt.claude.reduce((total, entry) => total + (entry[key] ?? 0), 0);
  return {
    requests: receipt.claude.length,
    inputTokens: sum("inputTokens") + sum("cacheWriteTokens") + sum("cacheReadTokens"),
    outputTokens: sum("outputTokens"),
    thinkingTokens: receipt.claude.some((entry) => Number.isFinite(entry.thinkingTokens)) ? sum("thinkingTokens") : null,
    claudeUsd: receipt.usd.claude,
    credits: receipt.tavily.credits,
    basicSearches: receipt.tavily.basicSearches,
    advancedSearches: receipt.tavily.advancedSearches,
    extractRequests: receipt.tavily.extractRequests,
    extractedUrls: receipt.tavily.extractedUrls,
    // The ledger's dollars for this pass: Claude plus credits at this environment's price.
    usd: receipt.usd.claude + receipt.tavily.credits * tavilyUsdPerCredit(),
    stageMs: receipt.stageMs,
  };
}

/** What a live control run's advanced pass contributed: kept pages it alone found, with Echo's kind and the label. */
function advancedContribution(analysis, sheet, compare) {
  const audit = (analysis.searchAudit ?? []).filter((entry) => entry.depth === "advanced" && entry.status === "searched");
  const labels = new Map((sheet?.labels ?? []).map((label) => [label.sourceKey, label.expectedKind]));
  const ids = new Set(audit.flatMap((entry) => entry.pageIds ?? []));
  const pages = analysis.pages.filter((page) => ids.has(page.id)).map((page) => ({ domain: page.domain, kind: page.judgment.kind, label: labels.get(compare.comparisonPageKey(page)) ?? null }));
  return { ran: audit.length > 0, pages, origins: pages.filter((page) => page.kind === "origin" || page.label === "origin").length };
}

/**
 * Plans the experiment, checks the worst case against today's ledger, and (only with run: true) runs it. Returns the
 * report; throws before any request when the worst case does not fit. beforePass({ arm, target }) is a test hook.
 */
export async function abCost({ experiment, files = [], claims = [], runs = 1, run = false, below = 0, controlFile = null, saveDir = null, log = (line) => process.stdout.write(`${line}\n`), beforePass = () => {} }) {
  if (!EXPERIMENTS.includes(experiment)) throw Object.assign(new Error(`Unknown experiment "${experiment}". Choose one of: ${EXPERIMENTS.join(", ")}.`), { code: "USAGE" });
  const pipeline = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  const { parsePortableTrace } = load(path.join(projectRoot, "src/lib/echo/portable.ts"));
  const evaluation = load(path.join(projectRoot, "src/lib/echo/evaluation.ts"));
  const compare = load(path.join(projectRoot, "src/lib/echo/compare.ts"));
  const { getAnthropicBudgetSnapshot } = load(path.join(projectRoot, "src/lib/echo/daily-budget.ts"));
  const { ReceiptDraft, runReceipt } = load(path.join(projectRoot, "src/lib/echo/cost-receipt.ts"));
  const readTrace = (file) => {
    const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!analysis) throw Object.assign(new Error(`${file} is not a valid Echo trace; nothing was sent.`), { code: "USAGE" });
    return analysis;
  };
  const sheets = fs.readdirSync(path.join(projectRoot, "evaluation")).filter((name) => name.endsWith(".labels.json")).map((name) => evaluation.parseLabelSheet(JSON.parse(fs.readFileSync(path.join(projectRoot, "evaluation", name), "utf8")))).filter(Boolean);
  const sheetFor = (claim) => sheets.find((sheet) => normalizeClaim(sheet.claim) === normalizeClaim(claim)) ?? null;
  const live = experiment === "raw-content" || experiment === "deep-search";
  const armA = ARMS[experiment].A;
  const armB = experiment === "deep-search" ? ARMS[experiment].B(Math.max(0, Math.min(19, Math.floor(below)))) : ARMS[experiment].B;
  runs = Math.max(1, Math.min(5, Math.floor(runs) || 1));

  // Targets: saved traces for the rejudge and regroup experiments, claims for the live ones.
  const phonesFile = path.join(projectRoot, "public/demo-traces/americans-check-phones-96-times.echo.json");
  let targets;
  if (live) {
    const fromFiles = files.map((file) => readTrace(file).claim);
    const list = [...claims, ...fromFiles];
    targets = (list.length ? list : [readTrace(phonesFile).claim]).map((claim) => ({ name: slug(claim), claim, sheet: sheetFor(claim) }));
  } else {
    const chosen = files.length ? files : experiment === "thinking"
      // A supplied-links run of a labeled claim (the saved Check these sources run shares slot 02's claim) is not one
      // of the labeled search runs this A/B rejudges.
      ? fs.readdirSync(path.join(projectRoot, "public/demo-traces")).filter((file) => file.endsWith(".echo.json")).sort().map((file) => path.join(projectRoot, "public/demo-traces", file)).filter((file) => !isSuppliedLinksRun(file) && sheetFor(readTrace(file).claim))
      : defaultTraceFiles(projectRoot);
    targets = chosen.map((file) => { const analysis = readTrace(file); return { name: path.basename(file).replace(/\.echo\.json$/, ""), file, claim: analysis.claim, analysis, sheet: sheetFor(analysis.claim) }; });
  }
  if (!targets.length) throw Object.assign(new Error("No traces or claims to run; nothing was sent."), { code: "USAGE" });
  const control = controlFile ? readTrace(controlFile) : null;
  if (control && !live) throw Object.assign(new Error("--control applies only to raw-content and deep-search; nothing was sent."), { code: "USAGE" });
  if (control && !control.costReceipt) throw Object.assign(new Error(`${controlFile} has no cost receipt; use a saved trace:claim run as the control. Nothing was sent.`), { code: "USAGE" });
  if (control && targets.some((target) => normalizeClaim(target.claim) !== normalizeClaim(control.claim))) throw Object.assign(new Error("--control is a run of a different claim; nothing was sent."), { code: "USAGE" });

  // Worst case of every pass, from the exact prompt where it can be built offline.
  const passes = [];
  for (let index = 1; index <= runs; index += 1) {
    for (const target of targets) {
      const order = index % 2 === 0 ? ["B", "A"] : ["A", "B"];
      for (const arm of order) {
        if (arm === "A" && control) continue;
        passes.push({ arm, run: index, target });
      }
    }
  }
  const worstOf = new Map();
  for (const target of targets) {
    for (const arm of ["A", "B"]) {
      const spec = arm === "A" ? armA : armB;
      let worst;
      if (experiment === "thinking") {
        const body = await withEnv(spec.env, () => captureTokenCountBody(() => pipeline.judgePages(target.claim, unjudged(target.analysis.pages), target.analysis.clusters)));
        const price = pipeline.modelPriceUsdPerMillion(body.model);
        if (!price) throw Object.assign(new Error(`Echo's budget guard has no price for ${body.model}; nothing was sent.`), { code: "BUDGET_MODEL_UNSUPPORTED" });
        worst = worstCaseUsd(promptChars(body), JSON.stringify(body.output_config ?? {}).length, price, JUDGE_MAX_TOKENS);
      } else if (experiment === "haiku-grouping") {
        const price = pipeline.modelPriceUsdPerMillion(spec.model);
        worst = worstCaseUsd(pipeline.groupingPrompt(target.claim, target.analysis.pages).length, LIVE_PROMPT_BOUNDS.schemaChars.grouping, price, pipeline.GROUPING_MAX_TOKENS);
      } else {
        worst = await withEnv(spec.env, async () => liveRunWorstUsd(pipeline, target.claim, { rawContent: process.env.ECHO_SEARCH_RAW_CONTENT === "1", deepSearch: (process.env.ECHO_DEEP_SEARCH_BELOW ?? "") === "" || Number(process.env.ECHO_DEEP_SEARCH_BELOW) > 0 })).then((bound) => bound.usd);
      }
      worstOf.set(`${target.name}|${arm}`, worst);
    }
  }
  for (const pass of passes) pass.worstUsd = worstOf.get(`${pass.target.name}|${pass.arm}`);
  const worstTotal = passes.reduce((total, pass) => total + pass.worstUsd, 0);

  const snapshot = await getAnthropicBudgetSnapshot();
  // One cap per provider (daily-budget.ts): a rejudge or regroup pass spends Claude only; a live pass spends Claude and
  // Tavily, so its whole worst case must fit under the smaller of what is left of each (a conservative bound).
  const capsUsed = live ? ["claude", "tavily"] : ["claude"];
  const remaining = Math.min(...capsUsed.map((name) => Math.max(0, snapshot.providers[name].capUsd - snapshot.providers[name].spentUsd - snapshot.providers[name].reservedUsd)));
  const perPass = experiment === "thinking" ? "1 judge request + 1 free token count; no search credits"
    : experiment === "haiku-grouping" ? "1 grouping request + 1 free token count; no search credits"
      : "a full live run: up to 10 basic searches (+3 advanced below the trigger), 1-2 extract requests, 3 Claude requests + 3 free token counts; page reads are direct and free";
  log(`ab:cost ${experiment}: A = ${armA.label}, B = ${armB.label}${control ? ` (A is the saved run ${path.basename(controlFile)}; only B spends)` : ""}`);
  log(`  ${targets.length} ${live ? (targets.length === 1 ? "claim" : "claims") : "traces"} x ${runs} ${runs === 1 ? "run" : "runs"} = ${passes.length} paid ${passes.length === 1 ? "pass" : "passes"}, each ${perPass}`);
  for (const target of targets) log(`  ${target.name.slice(0, 48).padEnd(49)}${target.sheet ? "labels" : "no label sheet"}${target.analysis ? `, ${target.analysis.pages.length} pages` : ""}; worst case A ${control ? "$0 (the saved run)" : `$${worstOf.get(`${target.name}|A`).toFixed(4)}`}, B $${worstOf.get(`${target.name}|B`).toFixed(4)} a pass`);
  const others = OTHER_SWITCHES.filter((name) => process.env[name] !== undefined && !(armA.env && name in armA.env));
  if (others.length) log(`  set in this environment, applied to both arms: ${others.map((name) => `${name}=${name.includes("KEY") ? "(set)" : process.env[name]}`).join(", ")}`);
  log(`  worst case $${worstTotal.toFixed(4)}; $${remaining.toFixed(4)} remains under today's ${capsUsed.map((name) => `${name === "claude" ? "Claude" : "Tavily"} $${snapshot.providers[name].capUsd.toFixed(2)}`).join(" and ")} ${capsUsed.length === 1 ? "cap" : "caps"} (${snapshot.storage} ledger, ${snapshot.day})`);
  log(`  pass rule: ${PASS_CRITERIA[experiment]}`);
  // deep-search: what the advanced pass already found on the saved live runs of each claim (free). An origin found
  // only by it on a saved run fails the rule before anything is spent; a paid run can confirm, not overturn, that.
  const savedEvidence = [];
  if (experiment === "deep-search") {
    for (const target of targets) {
      for (const file of defaultTraceFiles(projectRoot)) {
        const analysis = readTrace(file);
        if (normalizeClaim(analysis.claim) !== normalizeClaim(target.claim)) continue;
        const contribution = advancedContribution(analysis, target.sheet, compare);
        if (contribution.ran) savedEvidence.push({ target: target.name, run: path.basename(file).replace(/\.echo\.json$/, ""), ...contribution });
      }
      const mine = savedEvidence.filter((entry) => entry.target === target.name);
      const withOrigins = mine.filter((entry) => entry.origins > 0);
      log(`  saved runs of ${target.name.slice(0, 40)}: ${mine.length} ran the advanced pass; ${withOrigins.length ? `it alone found origins on ${withOrigins.length} (${withOrigins.map((entry) => `${entry.run}: ${entry.pages.filter((page) => page.kind === "origin" || page.label === "origin").map((page) => page.domain).join(", ")}`).join("; ")}), so the saved evidence already says FAIL (keep 20)` : "it found no origin on any of them"}`);
    }
  }
  if (!snapshot.available) throw Object.assign(new Error("The budget ledger is unavailable here, so no request was sent."), { code: "BUDGET_STORAGE_UNAVAILABLE" });
  if (worstTotal > remaining + 1e-9) {
    throw Object.assign(new Error(`The worst case ($${worstTotal.toFixed(4)}) is more than the $${remaining.toFixed(4)} left under today's cap; nothing was sent. Use fewer --runs, --trace or --claim, or --control.`), { code: "DAILY_BUDGET_REACHED" });
  }
  const plan = { experiment, arms: { A: armA.label, B: armB.label }, targets: targets.map((target) => target.name), runs, passes: passes.length, worstTotal, remaining, criteria: PASS_CRITERIA[experiment], ...(experiment === "deep-search" ? { savedEvidence } : {}) };
  if (!run) {
    log(`Dry run: nothing was sent. Add --run to spend up to $${worstTotal.toFixed(4)}.`);
    return { ...plan, dryRun: true, rows: [], spentUsd: 0 };
  }

  // The paid passes, one at a time.
  const rows = [];
  let stopped = null;
  if (control) {
    for (const target of targets) {
      rows.push({ arm: "A", run: 1, target: target.name, fromControl: true, ...receiptFields(control.costReceipt), ...scoreOf(evaluation, control, target.sheet), ...(experiment === "deep-search" ? { advanced: advancedContribution(control, target.sheet, compare) } : {}) });
    }
  }
  for (const pass of passes) {
    const spec = pass.arm === "A" ? armA : armB;
    const { target } = pass;
    const row = { arm: pass.arm, run: pass.run, target: target.name };
    beforePass({ arm: pass.arm, target });
    try {
      if (experiment === "thinking") {
        const draft = new ReceiptDraft(tavilyUsdPerCredit());
        const pages = await withEnv(spec.env, () => runReceipt.run(draft, () => draft.time("judgment", () => pipeline.judgePages(target.claim, unjudged(target.analysis.pages), target.analysis.clusters))));
        Object.assign(row, receiptFields(draft.finish()), scoreOf(evaluation, { ...target.analysis, pages }, target.sheet));
      } else if (experiment === "haiku-grouping") {
        const report = await regroupTraces({ files: [target.file], model: spec.model, runs: 1, log: () => {} });
        const result = report.rows[0];
        if (result?.error) throw Object.assign(new Error(result.error), { code: result.error.split(":")[0] });
        Object.assign(row, { requests: result.requests, inputTokens: result.inputTokens, outputTokens: result.outputTokens, claudeUsd: result.usd, usd: result.usd, credits: 0, stageMs: { grouping: result.ms }, moved: result.moved.length, excluded: result.excluded.length, excludedRootIds: result.excludedRoots, splitPairs: result.splitPairs, savedPairs: result.savedPairs, brokenLinks: result.brokenLinks.length, parentLinks: result.parentLinks, newGroups: result.newGroups, savedGroups: result.savedGroups });
      } else {
        const analysis = await withEnv(spec.env, () => pipeline.analyzeClaim(target.claim, () => {}, { forceFresh: true }));
        Object.assign(row, receiptFields(analysis.costReceipt), scoreOf(evaluation, analysis, target.sheet), { pages: analysis.pages.length });
        if (experiment === "deep-search") row.advanced = advancedContribution(analysis, target.sheet, compare);
        if (saveDir) {
          fs.mkdirSync(saveDir, { recursive: true });
          const out = path.join(saveDir, `${target.name}.${experiment}-${pass.arm}.${pass.run}.echo.json`);
          fs.writeFileSync(out, JSON.stringify({ format: "echo-trace", version: 1, exportedAt: new Date().toISOString(), analysis }, null, 2));
          row.saved = out;
        }
      }
    } catch (error) {
      row.error = `${error?.code ?? "ERROR"}: ${error instanceof Error ? error.message : String(error)}`;
      // A live run that failed after searching says what it spent.
      if (error?.costReceipt) Object.assign(row, receiptFields(error.costReceipt));
      if (STOP_CODES.has(error?.code) || STOP_CODES.has(row.error.split(":")[0])) stopped = row.error;
    }
    rows.push(row);
    log(row.error ? `  ${pass.arm} #${pass.run} ${target.name.slice(0, 40)} failed: ${row.error}` : `  ${pass.arm} #${pass.run} ${target.name.slice(0, 40).padEnd(41)}${passLine(experiment, row)}`);
    if (stopped) break;
  }
  const after = await getAnthropicBudgetSnapshot();
  const spentUsd = rows.filter((row) => !row.fromControl).reduce((total, row) => total + (row.usd ?? 0), 0);
  const summary = { A: summarize(rows.filter((row) => row.arm === "A" && !row.error)), B: summarize(rows.filter((row) => row.arm === "B" && !row.error)) };
  const verdict = verdictFor(experiment, summary);
  const table = comparisonTable(experiment, summary, { A: armA.label, B: armB.label });
  log("");
  for (const line of table) log(line);
  log(`\nVerdict (${experiment}): ${verdict.verdict}: ${verdict.reason}`);
  log(`spent $${spentUsd.toFixed(4)} over ${rows.filter((row) => !row.fromControl).length} passes${stopped ? ` (stopped: ${stopped})` : ""}; ledger today $${after.spentUsd.toFixed(4)} spent, $${after.reservedUsd.toFixed(4)} reserved, of $${after.capUsd.toFixed(2)}`);
  return { ...plan, dryRun: false, rows, summary, verdict, table, spentUsd, stopped, ledger: { before: snapshot, after } };
}

function passLine(experiment, row) {
  const money = `${row.inputTokens ?? 0}/${row.outputTokens ?? 0} tok${row.thinkingTokens !== null && row.thinkingTokens !== undefined ? ` (thinking ${row.thinkingTokens})` : ""}, ${row.credits ?? 0} credits, $${(row.usd ?? 0).toFixed(4)}`;
  if (experiment === "haiku-grouping") return `moved ${row.moved} · excluded ${row.excluded} (${row.excludedRootIds.length} roots) · split pairs ${row.splitPairs}/${row.savedPairs} · links broken ${row.brokenLinks}/${row.parentLinks} · ${money} · ${(row.stageMs.grouping / 1000).toFixed(1)} s`;
  const score = row.labeled ? `${row.match}/${row.matched} match · ${row.wrong} wrong · ${row.unclear} unclear · exact parents ${row.exactParents}/${row.derivedGold} · ` : "";
  const time = experiment === "thinking" ? `judge ${(row.stageMs.judgment / 1000).toFixed(1)} s` : `${(row.stageMs.total / 1000).toFixed(1)} s`;
  const extra = experiment === "deep-search" && row.advanced ? ` · advanced pass ${row.advanced.ran ? `added ${row.advanced.pages.length} kept (${row.advanced.origins} origins)` : "did not run"}` : "";
  return `${score}${row.origins} origins · ${money} · ${time}${extra}`;
}

const STAGES = ["search", "extract", "grouping", "judgment", "answer", "total"];
function summarize(rows) {
  const mean = (pick) => {
    const values = rows.map(pick).filter((value) => Number.isFinite(value));
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
  };
  const sum = (pick) => rows.reduce((total, row) => total + (Number.isFinite(pick(row)) ? pick(row) : 0), 0);
  return {
    passes: rows.length,
    labeled: rows.length > 0 && rows.every((row) => row.labeled),
    match: mean((row) => row.match), matched: mean((row) => row.matched), wrong: mean((row) => row.wrong), wrongTotal: sum((row) => row.wrong), unclear: mean((row) => row.unclear),
    exactParents: mean((row) => row.exactParents), derivedGold: mean((row) => row.derivedGold), origins: mean((row) => row.origins),
    inputTokens: mean((row) => row.inputTokens), outputTokens: mean((row) => row.outputTokens), thinkingTokens: mean((row) => row.thinkingTokens),
    claudeUsd: mean((row) => row.claudeUsd), credits: mean((row) => row.credits), usd: mean((row) => row.usd),
    basicSearches: mean((row) => row.basicSearches), advancedSearches: mean((row) => row.advancedSearches), extractRequests: mean((row) => row.extractRequests), extractedUrls: mean((row) => row.extractedUrls),
    stageMs: Object.fromEntries(STAGES.map((stage) => [stage, mean((row) => row.stageMs?.[stage])])),
    moved: mean((row) => row.moved), splitPairs: mean((row) => row.splitPairs), brokenLinks: mean((row) => row.brokenLinks), excludedRootIds: [...new Set(rows.flatMap((row) => (row.excludedRootIds ?? []).map((id) => `${row.target}:${id}`)))],
    advancedRan: rows.some((row) => row.advanced?.ran), advancedOrigins: sum((row) => row.advanced?.origins), advancedPages: rows.flatMap((row) => row.advanced?.pages ?? []),
    searchOverbilled: rows.some((row) => Number.isFinite(row.credits) && row.credits > row.basicSearches + 2 * row.advancedSearches + (row.extractRequests ? Math.ceil(row.extractedUrls / 5) + row.extractRequests - 1 : 0)),
  };
}

const fmt = (value, digits = 1) => (value === null || value === undefined ? "-" : Number(value).toFixed(digits));
function comparisonTable(experiment, summary, labels) {
  const header = experiment === "haiku-grouping"
    ? ["arm", "passes", "moved", "split pairs", "links broken", "roots excluded", "in tok", "out tok", "$ a pass", "grouping s"]
    : ["arm", "passes", "match", "wrong", "unclear", "exact parents", "origins", "in tok", "out tok", "Claude $", "credits", "$ a pass", ...(experiment === "thinking" ? ["judge s"] : ["search s", "extract s", "judge s", "total s"])];
  const line = (arm) => {
    const s = summary[arm];
    const seconds = (stage) => fmt(s.stageMs[stage] === null ? null : s.stageMs[stage] / 1000);
    if (experiment === "haiku-grouping") return [`${arm}: ${labels[arm]}`, s.passes, fmt(s.moved, 2), fmt(s.splitPairs, 2), fmt(s.brokenLinks, 2), s.excludedRootIds.length, fmt(s.inputTokens, 0), fmt(s.outputTokens, 0), fmt(s.usd, 5), seconds("grouping")];
    const score = s.labeled ? [`${fmt(s.match)}/${fmt(s.matched, 0)}`, fmt(s.wrong), fmt(s.unclear), `${fmt(s.exactParents)}/${fmt(s.derivedGold, 0)}`] : ["n/a", "n/a", "n/a", "n/a"];
    return [`${arm}: ${labels[arm]}`, s.passes, ...score, fmt(s.origins), fmt(s.inputTokens, 0), fmt(s.outputTokens, 0), fmt(s.claudeUsd, 4), fmt(s.credits), fmt(s.usd, 4), ...(experiment === "thinking" ? [seconds("judgment")] : [seconds("search"), seconds("extract"), seconds("judgment"), seconds("total")])];
  };
  const rows = [header, line("A"), line("B")];
  return [`| ${rows[0].join(" | ")} |`, `|${rows[0].map(() => " --- ").join("|")}|`, ...rows.slice(1).map((cells) => `| ${cells.join(" | ")} |`), "(means a pass; label columns from eval:trace's scoreTrace; $ is what the ledger was charged)"];
}

/** The one-line verdict, from PASS_CRITERIA. */
export function verdictFor(experiment, { A, B }) {
  if (!A.passes || !B.passes) return { verdict: "INCONCLUSIVE", reason: `an arm has no completed pass (A ${A.passes}, B ${B.passes})` };
  const quality = () => {
    const problems = [];
    if (A.labeled && B.labeled) {
      if (B.wrong > A.wrong + 1e-9) problems.push(`wrong calls ${fmt(A.wrong)} -> ${fmt(B.wrong)} a pass`);
      if (B.match < A.match - 1) problems.push(`label matches ${fmt(A.match)} -> ${fmt(B.match)}`);
      if (B.exactParents < A.exactParents - 1) problems.push(`exact parents ${fmt(A.exactParents)} -> ${fmt(B.exactParents)}`);
    }
    if (Math.abs(B.origins - A.origins) > 1) problems.push(`origins ${fmt(A.origins)} -> ${fmt(B.origins)}`);
    return problems;
  };
  const labelNote = A.labeled && B.labeled ? "" : " (no label sheet: origins only)";
  if (experiment === "thinking") {
    const problems = quality();
    if (problems.length) return { verdict: "FAIL", reason: `keep thinking on: ${problems.join("; ")}${labelNote}` };
    const costCut = 1 - B.claudeUsd / A.claudeUsd;
    const timeCut = 1 - B.stageMs.judgment / A.stageMs.judgment;
    if (costCut < 0.15 && timeCut < 0.15) return { verdict: "NO GAIN", reason: `quality kept, but the judge is only ${Math.round(costCut * 100)}% cheaper and ${Math.round(timeCut * 100)}% faster (need 15%)${labelNote}` };
    return { verdict: "PASS", reason: `quality kept${labelNote}; judge ${Math.round(costCut * 100)}% cheaper ($${fmt(A.claudeUsd, 4)} -> $${fmt(B.claudeUsd, 4)}), ${Math.round(timeCut * 100)}% faster (${fmt(A.stageMs.judgment / 1000)} -> ${fmt(B.stageMs.judgment / 1000)} s)` };
  }
  if (experiment === "raw-content") {
    if (B.searchOverbilled) return { verdict: "FAIL", reason: "searches with page text billed more than 1 credit (basic) or 2 (advanced)" };
    const problems = quality();
    if (problems.length) return { verdict: "FAIL", reason: `keep extracting: ${problems.join("; ")}${labelNote}` };
    const saved = A.credits - B.credits;
    if (saved < 2) return { verdict: "NO GAIN", reason: `quality kept, but only ${fmt(saved)} credits saved a run (need 2)${labelNote}` };
    return { verdict: "PASS", reason: `quality kept${labelNote}; ${fmt(saved)} credits ($${fmt(A.usd - B.usd, 4)}) and ${fmt((A.stageMs.extract - B.stageMs.extract) / 1000)} s of extract saved a run` };
  }
  if (experiment === "haiku-grouping") {
    const sonnetRoots = new Set(A.excludedRootIds);
    const newRoots = B.excludedRootIds.filter((id) => !sonnetRoots.has(id));
    const problems = [];
    if (B.moved > A.moved + 1) problems.push(`moves ${fmt(B.moved, 2)} pages a pass vs Sonnet's ${fmt(A.moved, 2)}`);
    if (B.brokenLinks > A.brokenLinks + 0.5) problems.push(`breaks ${fmt(B.brokenLinks, 2)} parent links a pass vs ${fmt(A.brokenLinks, 2)}`);
    if (newRoots.length) problems.push(`excludes roots Sonnet keeps (${newRoots.join(", ")})`);
    if (!(B.usd < A.usd)) problems.push("is not cheaper");
    if (problems.length) return { verdict: "FAIL", reason: `keep Sonnet: Haiku ${problems.join("; ")}` };
    return { verdict: "PASS", reason: `Haiku within Sonnet's noise floor (moved ${fmt(B.moved, 2)} vs ${fmt(A.moved, 2)}, links broken ${fmt(B.brokenLinks, 2)} vs ${fmt(A.brokenLinks, 2)}, no extra roots excluded) at $${fmt(B.usd, 5)} vs $${fmt(A.usd, 5)} a pass` };
  }
  // deep-search
  if (!A.advancedRan) return { verdict: "INCONCLUSIVE", reason: "A's basic search reached the trigger, so no advanced pass ran: the claim is not thin today" };
  if (A.advancedOrigins > 0) {
    const found = A.advancedPages.filter((page) => page.kind === "origin" || page.label === "origin").map((page) => page.domain);
    return { verdict: "FAIL", reason: `keep 20: the advanced pass alone found ${A.advancedOrigins} origin${A.advancedOrigins === 1 ? "" : "s"} (${[...new Set(found)].join(", ")})` };
  }
  const problems = [];
  if (A.labeled && B.labeled && B.wrong > A.wrong + 1e-9) problems.push(`wrong calls ${fmt(A.wrong)} -> ${fmt(B.wrong)}`);
  if (B.origins < A.origins - 1e-9) problems.push(`origins ${fmt(A.origins)} -> ${fmt(B.origins)}`);
  if (problems.length) return { verdict: "FAIL", reason: `keep 20: ${problems.join("; ")}${labelNote}` };
  const pages = A.advancedPages.map((page) => `${page.domain} ${page.kind}`).join(", ") || "none kept";
  return { verdict: "PASS", reason: `the advanced pass added no origin (${pages})${labelNote}; B saves ${fmt(A.credits - B.credits)} credits and ${fmt((A.stageMs.search - B.stageMs.search) / 1000)} s of search a run` };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const values = (name) => args.flatMap((arg, index) => (arg === `--${name}` && args[index + 1] !== undefined ? [args[index + 1]] : []));
  const option = (name, fallback) => values(name).at(-1) ?? fallback;
  const usage = "Usage: npm run ab:cost -- <thinking|raw-content|haiku-grouping|deep-search> [--trace file.echo.json ...] [--claim \"Claim\" ...] [--runs N] [--below N] [--control saved.echo.json] [--save dir] [--out table.md] [--json report.json] [--run]\nA dry run (the default) prints the plan and worst case and sends nothing; --run spends, through Echo's daily ledger.\n";
  const valued = new Set(["--trace", "--claim", "--runs", "--below", "--control", "--save", "--out", "--json"]);
  const experiment = args.find((arg, index) => !arg.startsWith("--") && !valued.has(args[index - 1]));
  if (args.includes("--help") || !experiment) {
    process.stdout.write(usage);
    process.exit(experiment || args.includes("--help") ? 0 : 1);
  }
  const base = process.env.INIT_CWD ?? process.cwd();
  const resolve = (file) => path.resolve(base, file);
  const run = args.includes("--run") && !args.includes("--dry-run");
  if (run && (!process.env.ANTHROPIC_API_KEY || ((experiment === "raw-content" || experiment === "deep-search") && !process.env.TAVILY_API_KEY))) {
    process.stdout.write("The API keys are not set (this script reads .env.local through the npm script); nothing was sent.\n");
    process.exit(1);
  }
  const outPath = option("out", null);
  const jsonPath = option("json", null);
  const saveDir = option("save", null);
  const controlFile = option("control", null);
  process.chdir(projectRoot); // the budget ledger lives in .echo/ under the project, as for every paid script
  try {
    const report = await abCost({ experiment, files: values("trace").map(resolve), claims: values("claim"), runs: Number(option("runs", 1)), below: Number(option("below", 0)), run, controlFile: controlFile ? resolve(controlFile) : null, saveDir: saveDir ? resolve(saveDir) : null });
    if (outPath && report.table) fs.writeFileSync(resolve(outPath), `# ab:cost ${experiment}\n\n${report.table.join("\n")}\n\nVerdict: ${report.verdict.verdict}: ${report.verdict.reason}\n\nPass rule: ${report.criteria}\n`);
    if (jsonPath) fs.writeFileSync(resolve(jsonPath), JSON.stringify(report, null, 2));
    if (report.stopped) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
