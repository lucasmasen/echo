// Measures where a live Echo run's money goes, offline: no Tavily or Anthropic call (not even count_tokens) is made.
//   npm run measure:cost [-- --details] [--trace fresh-run.echo.json ...]
// For every saved trace (public/demo-traces and evaluation/runs) it replays the real pipeline code with mocked
// providers and records each request body Echo would send:
//   - analyzeClaim end to end, with Tavily answering from the trace's own pages and Claude answering with the
//     trace's own clusters, judgments and answer, so the grouping, judging and answer requests are the real ones;
//   - judgePages on the trace's saved pages and claim groups (what rejudge:trace sends), which keeps the saved
//     dates, citations and HTML links the live judge saw.
// Tokens are ESTIMATES, calibrated 11/13 against the first two live cost receipts (evaluation/runs/*2026-11-13-run1):
// input ≈ 150 + chars/2.8 per request (fits all three requests of the brain run within 1%); output is the JSON
// rebuilt from the saved trace, scaled per step by real/estimated output over every trace with a receipt (the trace
// keeps Echo's cleaned result, not what Claude wrote). The fit is in-sample on 2 runs: re-check as receipts accrue.
// Tavily credits come from each trace's recorded search audit (basic 1, advanced 2) plus 1 extract credit per 5
// SUCCESSFUL extractions (the receipts: 2 credits for 18 URLs sent, 3 for 20).
// Prices: claude-sonnet-5-5 $2 in / $10 out per million tokens (pipeline.ts), cache write 1.25x, cache read $0.10;
// Tavily $0.008 per credit (ECHO_TAVILY_USD_PER_CREDIT default).
//
// Measured 2026-11-12 with 4 chars/token (superseded): Claude ≈ $0.044, Tavily ≈ $0.106, "Tavily ~71%". That was
// about 2x low on Claude: input tokenizes at ~2.8 chars/token (JSON keys, quotes, ids, dates, domains, numbers) plus
// ~150 tokens per request, and output was ~2.3x low because the saved trace does not hold Claude's raw output.
// Extract credits were also overstated (4 assumed, 2-3 billed).
// Recalibrated 2026-11-13 on 17 saved traces: per run Claude ≈ $0.082, Tavily ≈ $0.103, total ≈ $0.185, Tavily ~56%
//   (the two live receipts: $0.220 and $0.252, Tavily 66% and 60%; both ran the advanced pass, older runs often not).
//   grouping ≈ 6,000 in + 600 out ($0.018); judge ≈ 11,600 + 3,400 ($0.057, the biggest Claude call, 60% of it output,
//   22-24 s of a 45 s run); answer ≈ 2,900 + 240 ($0.008). The judge's fixed instructions are ≈ 2,300 tokens.
//   Advanced searches (6 credits) ran on 5 of 15 runs and added 0-3 kept pages, none of them a root.
//   Re-checked 11/13 after the query fix: those 5 runs had 12-14 basic pages (so any ECHO_DEEP_SEARCH_BELOW from 15
//   to 20 behaves the same, 10 skips all 5); of the 8 kept pages they added, 7 ended unclear and 1 was a correct
//   labeled copy (KABC -> Asurion, 11/10 phones run). The two 11/13 live runs (figures-kept queries) changed the
//   picture: basic 14 and 19 pages, and the advanced pass added 4 and 6 kept pages including 1 and 3 ORIGINS
//   (asurion.com, the phones claim's own source, came only from it). Keep the default 20. The second 11/13 query fix
//   (filler at any length, negations kept, adjacent quoted words) changes 7-8 of 10 queries again for every saved
//   claim, so basic counts today are unknown offline.
//   The three requests in a run share no prefix, so prompt caching only pays across runs (rejudge loops: ~44% off).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dnsPromises from "node:dns/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(code, filename);
};
const details = process.argv.includes("--details");

// Never touch the real budget ledger or any provider: fake keys, a throwaway working directory, no DNS, no network.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "echo-measure-cost-"));
process.chdir(scratch);
process.env.ANTHROPIC_API_KEY = "offline-measurement";
process.env.TAVILY_API_KEY = "offline-measurement";
for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_CLASSIFIER_MODEL", "ANTHROPIC_ANSWER_MODEL", "VERCEL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "ECHO_DAILY_CAP_OVERRIDE_USD", "ECHO_PROMPT_CACHE", "ECHO_SEARCH_CACHE", "ECHO_DEEP_SEARCH_BELOW", "ANTHROPIC_GROUPING_MODEL", "ECHO_THINKING_OFF", "ECHO_LOG_USAGE", "ECHO_SEARCH_RAW_CONTENT", "TELEM_API_KEY", "ECHO_SEARCH_ROUTER"]) delete process.env[name];
// One cap per provider (daily-budget.ts), all $2 on the throwaway ledger; the retired single-cap settings are unset.
for (const name of ["ECHO_ANTHROPIC_DAILY_CAP_USD", "ECHO_TELEM_CREDIT_USD"]) delete process.env[name];
const CAP_VARIABLES = ["ECHO_CLAUDE_DAILY_CAP_USD", "ECHO_TAVILY_DAILY_CAP_USD", "ECHO_TELEM_DAILY_CAP_USD"];
const setCaps = (usd) => { for (const name of CAP_VARIABLES) process.env[name] = String(usd); };
setCaps(2);
process.env.ECHO_TAVILY_USD_PER_CREDIT = "0"; // mocked credits are not charged to the throwaway ledger
dnsPromises.lookup = async () => { throw Object.assign(new Error("offline measurement: no DNS"), { code: "ENOTFOUND" }); };

const PRICE = { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 };
const TAVILY_USD = 0.008;
// Calibrated 11/13 against the first live cost receipts (evaluation/runs/*2026-11-13-run1): on the brain run, whose
// replayed requests are exactly what was sent (no excluded pages), all three requests fit 150 + chars / 2.8 tokens
// within 1%. The old 4 chars per token was ~1.45x low on input.
const CHARS_PER_TOKEN = 2.8;
const REQUEST_OVERHEAD_TOKENS = 150; // per request, beyond the prompt and schema characters (structured-output wrapping)
const tokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);
const requestTokens = (chars) => REQUEST_OVERHEAD_TOKENS + tokens(chars);
const usd =(inputTokens, outputTokens) => (inputTokens * PRICE.input + outputTokens * PRICE.output) / 1_000_000;

let current = null; // the trace being replayed: { analysis, idMap (saved id -> new id), reverse }
const captured = []; // { endpoint, body }
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
// Usage is billed as 0 tokens (nothing reaches the throwaway ledger) except in the receipt check, which bills an estimate.
let billUsage = false;
const mockInputTokens = (body) => tokens(JSON.stringify(body).length);
// usageOverride, when set, is the usage every model response reports (the prompt-cache billing check).
let usageOverride = null;
// groupingOverride, when set, answers the grouping request instead of the saved clusters (the regroup:trace check);
// onModelCall runs before each model response.
let groupingOverride = null;
let onModelCall = null;
let rejectModel = false;
// Pages whose search result comes back without page text when a search asks for it (the ECHO_SEARCH_RAW_CONTENT check).
let rawMissing = new Set();
// Credits a search that asks for page text bills (Tavily's docs say no surcharge; ab:cost's raw-content rule checks it).
let rawSearchCredits = 1;
const model = (value, body) => json({ content: [{ type: "text", text: JSON.stringify(value) }], usage: usageOverride ?? (billUsage ? { input_tokens: mockInputTokens(body), output_tokens: tokens(JSON.stringify(value).length) } : { input_tokens: 0, output_tokens: 0 }), stop_reason: "end_turn" });

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (url === "https://api.tavily.com/search") {
    captured.push({ endpoint: "tavily search", body });
    // Every query returns the trace's pages, so the run collects exactly them (scores keep their saved order).
    return json({ results: current.analysis.pages.map((page, index) => ({ url: page.url, title: page.title, content: page.text.slice(0, 600), published_date: page.publishedDate, score: 1 - index / 1000, ...(body.include_raw_content && !rawMissing.has(page.url) ? { raw_content: page.text } : {}) })), usage: { credits: (body.search_depth === "advanced" ? 2 : 1) * (body.include_raw_content ? rawSearchCredits : 1) } });
  }
  if (url === "https://api.tavily.com/extract") {
    captured.push({ endpoint: "tavily extract", body });
    const byUrl = new Map(current.analysis.pages.map((page) => [page.url, page]));
    return json({ results: body.urls.map((address) => ({ url: address, raw_content: byUrl.get(address)?.text ?? "" })), usage: { credits: Math.ceil(body.urls.length / 5) } });
  }
  if (url === "https://api.anthropic.com/v1/messages/count_tokens") {
    captured.push({ endpoint: "count_tokens", body });
    return json({ input_tokens: tokens(JSON.stringify(body).length) });
  }
  if (url === "https://api.anthropic.com/v1/messages") {
    captured.push({ endpoint: "messages", body });
    // rejectModel: Claude refuses the request (400), so a run fails after paying for its searches.
    if (rejectModel) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }), { status: 400 });
    onModelCall?.(body);
    if (groupingOverride && promptText(body).startsWith("Group these")) return model({ clusters: groupingOverride(promptText(body)) }, body);
    return model(modelAnswer(body), body);
  }
  throw new TypeError(`offline measurement: no network for ${url}`);
};

function promptText(body) {
  const content = body.messages?.[0]?.content;
  return typeof content === "string" ? content : (content ?? []).map((block) => block.text ?? "").join("");
}

/** The saved trace's own model output, renamed to the page ids this replay assigned. */
function modelOutputs(analysis, rename) {
  const clusters = analysis.clusters.map((cluster) => ({ label: cluster.label, pageIds: cluster.pageIds.map(rename), matchesClaim: true }));
  const judgements = analysis.pages.map((page) => ({
    pageId: rename(page.id),
    kind: page.judgment.kind,
    parentId: page.judgment.parentId ? rename(page.judgment.parentId) : null,
    confidence: page.judgment.confidence,
    evidence: page.judgment.evidence,
    hasPrimaryEvidence: page.hasPrimaryEvidence === true,
    primaryEvidenceReason: page.primaryEvidenceReason ?? "",
    originBasis: page.judgment.kind === "origin" ? "firsthand" : page.judgment.kind === "unclear" ? "not-origin" : "not-origin",
  }));
  const claims = (analysis.answerStatements?.length ? analysis.answerStatements : [{ text: analysis.answer, sourceIds: analysis.answerSourceIds.slice(0, 1) }])
    .map((statement) => ({ text: statement.text, sourceNumbers: [1] }));
  return { clusters, judgements, claims };
}

function modelAnswer(body) {
  const prompt = promptText(body);
  const outputs = modelOutputs(current.analysis, (id) => current.idMap.get(id) ?? id);
  if (prompt.startsWith("Group these")) return { clusters: outputs.clusters };
  if (prompt.startsWith("You are a cautious")) return { judgements: outputs.judgements };
  if (prompt.startsWith("Answer the")) {
    const sources = (prompt.match(/"sourceNumber":(\d+)/g) ?? []).length;
    return { claims: outputs.claims.map((claim) => ({ ...claim, sourceNumbers: [Math.min(1, sources) || 1] })) };
  }
  throw new Error("offline measurement: unexpected prompt");
}

/** Splits a prompt into its fixed instructions (before "Claim: ") and the per-run data, and the data's parts. */
function anatomy(prompt, kind) {
  const claimAt = prompt.indexOf("\n\nClaim: ");
  const instructions = claimAt >= 0 ? prompt.slice(0, claimAt) : prompt;
  const dataStart = kind === "judge" ? prompt.indexOf("Clusters: ") + "Clusters: ".length : kind === "cluster" ? prompt.indexOf("Pages: ") + "Pages: ".length : prompt.indexOf("Origin pages: ") + "Origin pages: ".length;
  const data = JSON.parse(prompt.slice(dataStart));
  const pages = kind === "judge" ? data.flatMap((cluster) => cluster.pages) : data;
  const sum = (pick) => pages.reduce((total, page) => total + pick(page), 0);
  const text = sum((page) => JSON.stringify(page.text ?? "").length);
  const cited = sum((page) => (page.citedPages ? JSON.stringify(page.citedPages).length : 0));
  const wording = sum((page) => (page.sharedWording ? JSON.stringify(page.sharedWording).length : 0));
  const emptyArrays = sum((page) => ["citedPages", "sharedWording", "linkedPageIds"].filter((key) => Array.isArray(page[key]) && page[key].length === 0).reduce((n, key) => n + key.length + 6, 0));
  const dataChars = prompt.length - dataStart;
  return { total: prompt.length, instructions: instructions.length, dataChars, text, cited, wording, meta: dataChars - text - cited - wording, emptyArrays, pages: pages.length };
}

const { analyzeClaim, judgePages } = load(path.join(root, "src/lib/echo/pipeline.ts"));
const { parsePortableTrace } = load(path.join(root, "src/lib/echo/portable.ts"));

// --trace file.echo.json (repeatable) adds a trace kept elsewhere, e.g. a fresh live run saved by trace:claim.
const extraTraces = process.argv.slice(2).flatMap((arg, index, args) => (arg === "--trace" && args[index + 1] ? [path.relative(root, path.resolve(process.env.INIT_CWD ?? root, args[index + 1]))] : []));
// A saved Check these sources run (analysis.sourceCheck, e.g. the bundled check-these-sources-phones) searched nothing,
// so replaying it as a search run would measure a run that never happened: it is left out, as regroup:trace leaves it.
const files = [
  ...fs.readdirSync(path.join(root, "public/demo-traces")).map((file) => `public/demo-traces/${file}`),
  ...fs.readdirSync(path.join(root, "evaluation/runs")).map((file) => `evaluation/runs/${file}`),
].filter((file) => file.endsWith(".echo.json") && !JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).analysis?.sourceCheck);
const savedTraceCount = files.length;
files.push(...extraTraces);

const rows = [];
for (const file of files) {
  const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
  if (!analysis) { process.stdout.write(`UNREADABLE ${file}\n`); continue; }
  // The replay numbers pages page-1.. in the trace's saved order.
  const idMap = new Map(analysis.pages.map((page, index) => [page.id, `page-${index + 1}`]));
  current = { analysis, idMap };

  captured.length = 0;
  await analyzeClaim(analysis.claim, () => {}, { forceFresh: true });
  const live = captured.filter((entry) => entry.endpoint === "messages").map((entry) => entry.body);
  const countTokenCalls = captured.filter((entry) => entry.endpoint === "count_tokens").length;
  const find = (prefix) => live.find((body) => promptText(body).startsWith(prefix));

  // The judge request from the saved pages (dates, citations, links as the live judge saw them).
  current = { analysis, idMap: new Map(analysis.pages.map((page) => [page.id, page.id])) };
  captured.length = 0;
  const blank = analysis.pages.map((page) => ({ ...page, judgment: { kind: "origin", parentId: null, confidence: 0, evidence: "Awaiting source comparison." }, hasPrimaryEvidence: false }));
  await judgePages(analysis.claim, blank, analysis.clusters);
  const savedJudge = captured.find((entry) => entry.endpoint === "messages")?.body;

  const outputs = modelOutputs(analysis, (id) => id);
  const searched = (analysis.searchAudit ?? []).filter((entry) => entry.status !== "not searched");
  const searchCredits = searched.reduce((total, entry) => total + (entry.depth === "advanced" ? 2 : 1), 0);
  // Tavily bills basic extraction per 5 SUCCESSFUL pages: the 11/13 receipts charged 2 credits for 18 sent URLs (12+
  // extracted) and 3 for 20 (16 extracted), not one per 5 sent per batch (4). Excluded pages are not in the file, so
  // they are assumed to succeed at the kept pages' rate.
  const extractedKept = analysis.pages.filter((page) => page.extractionSource === "Tavily extraction").length;
  const successRate = extractedKept / Math.max(1, analysis.pages.length);
  const extractCredits = Math.floor((extractedKept + (analysis.excludedPageCount ?? 0) * successRate) / 5);
  const calls = {
    cluster: { body: find("Group these"), kind: "cluster", out: JSON.stringify({ clusters: outputs.clusters }).length },
    judge: { body: savedJudge, kind: "judge", out: JSON.stringify({ judgements: outputs.judgements }).length },
    answer: { body: find("Answer the"), kind: "answer", out: analysis.answerStatus === "generated" ? JSON.stringify({ claims: outputs.claims }).length : 0 },
  };
  const row = { name: path.basename(file).replace(/\.echo\.json$/, ""), pages: analysis.pages.length, searchCredits, extractCredits, countTokenCalls, calls: {}, receipt: analysis.costReceipt ?? null, excluded: analysis.excludedPageCount ?? 0 };
  for (const [name, call] of Object.entries(calls)) {
    if (!call.body) { row.calls[name] = null; continue; }
    const prompt = promptText(call.body);
    const schemaChars = JSON.stringify(call.body.output_config ?? {}).length;
    row.calls[name] = { ...anatomy(prompt, call.kind), schemaChars, maxTokens: call.body.max_tokens, outChars: call.out };
  }
  rows.push(row);
}

const pad = (value, width) => String(value).padEnd(width);
const num = (value) => (value === null || value === undefined ? "-" : Math.round(value).toLocaleString("en-US"));

// Output tokens cannot be read off a saved trace: it keeps Echo's cleaned result, not what Claude wrote. Each step's
// output estimate is scaled by real / estimated output over every trace that carries a live cost receipt.
const STEP_OF_CALL = { cluster: "grouping", judge: "judgment", answer: "answer" };
const outputFactor = {};
const calibration = [];
for (const name of Object.keys(STEP_OF_CALL)) {
  let real = 0;
  let estimated = 0;
  for (const row of rows) {
    const entry = row.receipt?.claude.find((item) => item.step === STEP_OF_CALL[name]);
    const call = row.calls[name];
    if (!entry || !call || !call.outChars) continue;
    real += entry.outputTokens;
    estimated += tokens(call.outChars);
  }
  outputFactor[name] = estimated ? real / estimated : 1;
}
const outputEstimate = (name, call) => Math.round(tokens(call.outChars) * outputFactor[name]);
for (const row of rows.filter((item) => item.receipt)) {
  for (const name of Object.keys(STEP_OF_CALL)) {
    const entry = row.receipt.claude.find((item) => item.step === STEP_OF_CALL[name]);
    const call = row.calls[name];
    if (!entry || !call) continue;
    calibration.push({ row: row.name, name, estIn: requestTokens(call.total + call.schemaChars), realIn: entry.inputTokens, oldIn: Math.round((call.total + call.schemaChars) / 4), estOut: outputEstimate(name, call), oldOut: Math.round(call.outChars / 4), realOut: entry.outputTokens, realUsd: entry.usd });
  }
}

process.stdout.write(`Echo cost measurement (offline; input ≈ ${REQUEST_OVERHEAD_TOKENS} + chars/${CHARS_PER_TOKEN} tokens, output scaled to ${rows.filter((row) => row.receipt).length} live receipts)\n\n`);
process.stdout.write(`${pad("trace", 46)}${pad("pages", 6)}${pad("cluster in/out", 16)}${pad("judge in/out", 16)}${pad("answer in/out", 15)}${pad("Claude $", 10)}${pad("Tavily cr", 10)}${pad("Tavily $", 9)}run $\n`);
const totals = { claude: 0, tavily: 0, n: 0, calls: { cluster: { in: 0, out: 0, n: 0 }, judge: { in: 0, out: 0, n: 0 }, answer: { in: 0, out: 0, n: 0 } } };
for (const row of rows) {
  let claude = 0;
  const cells = [];
  for (const name of ["cluster", "judge", "answer"]) {
    const call = row.calls[name];
    if (!call) { cells.push("-"); continue; }
    const input = requestTokens(call.total + call.schemaChars);
    const output = outputEstimate(name, call);
    claude += usd(input, output);
    totals.calls[name].in += input;
    totals.calls[name].out += output;
    totals.calls[name].n += 1;
    cells.push(`${num(input)}/${num(output)}`);
  }
  const tavily = (row.searchCredits + row.extractCredits) * TAVILY_USD;
  totals.claude += claude;
  totals.tavily += tavily;
  totals.n += 1;
  process.stdout.write(`${pad(row.name.slice(0, 45), 46)}${pad(row.pages, 6)}${pad(cells[0], 16)}${pad(cells[1], 16)}${pad(cells[2], 15)}${pad(claude.toFixed(4), 10)}${pad(`${row.searchCredits}+${row.extractCredits}`, 10)}${pad(tavily.toFixed(3), 9)}${(claude + tavily).toFixed(3)}\n`);
}
const avg = (value) => value / Math.max(1, totals.n);
process.stdout.write(`\nAverage per run over ${totals.n} traces: Claude ≈ $${avg(totals.claude).toFixed(4)}, Tavily ≈ $${avg(totals.tavily).toFixed(3)}, total ≈ $${avg(totals.claude + totals.tavily).toFixed(3)} (Tavily ${Math.round((100 * totals.tavily) / (totals.claude + totals.tavily))}% of it).\n`);
for (const name of ["cluster", "judge", "answer"]) {
  const call = totals.calls[name];
  if (!call.n) continue;
  const share = usd(call.in / call.n, call.out / call.n);
  process.stdout.write(`  ${pad(name, 8)} avg ≈ ${num(call.in / call.n)} input + ${num(call.out / call.n)} output tokens ≈ $${share.toFixed(4)} per call (${call.n} of ${totals.n} runs make it; output ${Math.round((100 * (call.out / call.n) * PRICE.output) / 1e6 / share)}% of its cost)\n`);
}

// The estimate against every live receipt: what the old 4 chars/token rule said, what this one says, what was billed.
if (calibration.length) {
  process.stdout.write(`\nAgainst live cost receipts (tokens: old 4-chars estimate / this estimate / real; output factors ${Object.entries(outputFactor).map(([name, factor]) => `${name} x${factor.toFixed(2)}`).join(", ")}):\n`);
  for (const item of calibration) {
    process.stdout.write(`  ${pad(item.row.slice(0, 45), 46)}${pad(item.name, 8)} in ${num(item.oldIn)} / ${num(item.estIn)} / ${num(item.realIn)} (${((100 * item.estIn) / item.realIn - 100).toFixed(0)}%) · out ${num(item.oldOut)} / ${num(item.estOut)} / ${num(item.realOut)} · real $${item.realUsd.toFixed(4)}\n`);
  }
  for (const row of rows.filter((item) => item.receipt)) {
    const estimatedClaude = ["cluster", "judge", "answer"].reduce((total, name) => total + (row.calls[name] ? usd(requestTokens(row.calls[name].total + row.calls[name].schemaChars), outputEstimate(name, row.calls[name])) : 0), 0);
    const receipt = row.receipt;
    const judgment = receipt.claude.find((item) => item.step === "judgment");
    process.stdout.write(`  ${pad(row.name.slice(0, 45), 46)}Claude est $${estimatedClaude.toFixed(4)} vs real $${receipt.usd.claude.toFixed(4)}; Tavily est ${row.searchCredits}+${row.extractCredits} vs real ${receipt.tavily.credits} credits (${receipt.tavily.extractedUrls} URLs extracted); real total $${receipt.usd.total.toFixed(3)}, Tavily ${Math.round((100 * receipt.usd.tavily) / receipt.usd.total)}%; judge ${(receipt.stageMs.judgment / 1000).toFixed(1)} s of ${(receipt.stageMs.total / 1000).toFixed(1)} s, $${judgment?.usd.toFixed(4)} (${judgment ? Math.round((100 * judgment.outputTokens * PRICE.output) / 1e6 / judgment.usd) : 0}% output)${row.excluded ? `; replay lacks ${row.excluded} excluded pages` : ""}\n`);
  }
}

// Receipt plausibility: a saved live receipt whose stage times or bill cannot be right (stages that add up to more
// than the run, a Claude step with no time, dollars that do not follow from the tokens and credits, more extract
// credits than the URLs sent can cost) is flagged here before anyone calibrates from it. Flags, not failures: the
// file is what a live run wrote.
const { modelPriceUsdPerMillion, REUSED_SEARCH_REASON: REUSED_REASON } = load(path.join(root, "src/lib/echo/pipeline.ts"));
const STEP_MAX_TOKENS = { grouping: 1800, judgment: 5200, answer: 1200 }; // pipeline.ts: clusterPages, judgePages, synthesizeAnswer
const STAGE_OF_STEP = { grouping: "grouping", judgment: "judgment", answer: "answer" };
function receiptFlags(analysis) {
  const receipt = analysis.costReceipt;
  if (!receipt) return [];
  const flags = [];
  const near = (a, b, tolerance = 2e-6) => Math.abs(a - b) <= tolerance;
  const stages = ["search", "extract", "grouping", "judgment", "answer"];
  const ms = receipt.stageMs ?? {};
  if (![...stages, "total"].every((stage) => Number.isFinite(ms[stage]) && ms[stage] >= 0)) flags.push("a stage time is missing or negative");
  else {
    const sum = stages.reduce((total, stage) => total + ms[stage], 0);
    if (sum > ms.total + 50) flags.push(`stages add up to ${(sum / 1000).toFixed(1)} s, more than the run's ${(ms.total / 1000).toFixed(1)} s`);
    if (ms.total > 300_000) flags.push(`the run took ${(ms.total / 1000).toFixed(0)} s (over 5 minutes)`);
    if (receipt.claude.length && ms.total < 1_000) flags.push(`a run with ${receipt.claude.length} Claude requests took under 1 s`);
    if (receipt.tavily.basicSearches + receipt.tavily.advancedSearches + (receipt.telem?.searches ?? 0) > 0 && ms.search === 0) flags.push("searches were billed but the search stage took 0 ms");
    if (ms.judgment > 125_000) flags.push(`the judge took ${(ms.judgment / 1000).toFixed(0)} s, past two 60 s request timeouts`);
    for (const entry of receipt.claude) if (STAGE_OF_STEP[entry.step] && ms[STAGE_OF_STEP[entry.step]] === 0) flags.push(`a ${entry.step} request was billed but its stage took 0 ms`);
  }
  const steps = receipt.claude.map((entry) => entry.step);
  if (new Set(steps).size !== steps.length) flags.push(`a Claude step is billed twice (${steps.join(", ")})`);
  const order = steps.map((step) => ["grouping", "judgment", "answer"].indexOf(step));
  if (order.some((index, position) => index < 0 || (position > 0 && index < order[position - 1]))) flags.push(`Claude steps out of order (${steps.join(", ")})`);
  if (analysis.answerStatus === "generated" && !steps.includes("answer")) flags.push("the answer is marked generated but no answer request was billed");
  let claudeUsd = 0;
  for (const entry of receipt.claude) {
    const tier = modelPriceUsdPerMillion(entry.model);
    if (!tier) { flags.push(`${entry.step}: no price for ${entry.model}`); continue; }
    const price = tier.over100k && entry.inputTokens > 100_000 ? tier.over100k : tier;
    const expected = (entry.inputTokens * price.input + entry.cacheWriteTokens * price.input * 1.25 + entry.cacheReadTokens * price.cacheRead + entry.outputTokens * price.output) / 1e6;
    if (!near(entry.usd, expected, 1e-5)) flags.push(`${entry.step}: billed $${entry.usd.toFixed(6)} but its tokens cost $${expected.toFixed(6)}`);
    if (entry.inputTokens + entry.cacheWriteTokens + entry.cacheReadTokens <= 0) flags.push(`${entry.step}: no input tokens`);
    if (entry.outputTokens > (STEP_MAX_TOKENS[entry.step] ?? Infinity)) flags.push(`${entry.step}: ${entry.outputTokens} output tokens, over its ${STEP_MAX_TOKENS[entry.step]} limit`);
    claudeUsd += entry.usd;
  }
  const tavily = receipt.tavily;
  if (!near(receipt.usd.claude, claudeUsd)) flags.push(`Claude total $${receipt.usd.claude} is not the sum of its requests ($${claudeUsd.toFixed(6)})`);
  if (!near(receipt.usd.tavily, tavily.credits * tavily.usdPerCredit)) flags.push(`Tavily $${receipt.usd.tavily} is not ${tavily.credits} credits x $${tavily.usdPerCredit}`);
  // A run that searched through Telem (telem.ts) has a telem block and usd.telem: the total adds it.
  const telem = receipt.telem;
  if (Boolean(telem) !== (receipt.usd.telem !== undefined)) flags.push("a Telem block without usd.telem, or usd.telem without a Telem block");
  if (!near(receipt.usd.total, receipt.usd.claude + receipt.usd.tavily + (receipt.usd.telem ?? 0))) flags.push(telem ? "the total is not Claude + Tavily + Telem" : "the total is not Claude + Tavily");
  if (telem) {
    const runs = Object.values(telem.providerRuns ?? {}).reduce((sum, count) => sum + count, 0);
    if (runs < telem.searches) flags.push(`${telem.searches} Telem searches but only ${runs} provider runs answered them`);
    // Each Telem search costs at most every allowed provider at list price ($0.031 default, $0.040 extended).
    const most = (telem.searches - telem.advancedSearches) * 0.031 + telem.advancedSearches * 0.04;
    if (receipt.usd.telem > most + 1e-6) flags.push(`Telem $${receipt.usd.telem} is more than ${telem.searches} searches can cost ($${most.toFixed(3)})`);
  }
  const searchCredits = tavily.basicSearches + 2 * tavily.advancedSearches;
  const maxExtractCredits = tavily.extractRequests ? Math.ceil(tavily.extractedUrls / 5) + tavily.extractRequests - 1 : 0;
  if (tavily.credits < searchCredits) flags.push(`${tavily.credits} credits is less than its searches alone cost (${searchCredits})`);
  if (tavily.credits > searchCredits + maxExtractCredits) flags.push(`${tavily.credits} credits is more than its searches and ${tavily.extractedUrls} extracted URLs can cost (${searchCredits + maxExtractCredits})`);
  if (tavily.extractRequests > 0 && tavily.extractedUrls === 0) flags.push("extract requests with no URLs");
  // Each search the receipt counts is a completed, non-reused search in the audit (failed and reused ones cost nothing).
  if (analysis.searchAudit?.length) {
    const paid = (depth, router) => analysis.searchAudit.filter((entry) => entry.depth === depth && entry.status === "searched" && entry.reason !== REUSED_REASON && (entry.router ?? "tavily") === router).length;
    if (paid("basic", "tavily") !== tavily.basicSearches || paid("advanced", "tavily") !== tavily.advancedSearches) flags.push(`the search audit has ${paid("basic", "tavily")} basic + ${paid("advanced", "tavily")} advanced paid searches, the receipt ${tavily.basicSearches} + ${tavily.advancedSearches}`);
    const telemPaid = paid("basic", "telem") + paid("advanced", "telem");
    if (telemPaid !== (telem?.searches ?? 0) || paid("advanced", "telem") !== (telem?.advancedSearches ?? 0)) flags.push(`the search audit has ${telemPaid} paid Telem searches (${paid("advanced", "telem")} deeper), the receipt ${telem?.searches ?? 0} (${telem?.advancedSearches ?? 0})`);
  }
  const extractedKept = analysis.pages.filter((page) => page.extractionSource === "Tavily extraction").length;
  if (!analysis.cacheHit && extractedKept > tavily.extractedUrls) flags.push(`${extractedKept} kept pages have Tavily text but only ${tavily.extractedUrls} URLs were extracted (possible only if extracts were reused from the cache or came with ECHO_SEARCH_RAW_CONTENT)`);
  return flags;
}
{
  const withReceipts = files.map((file) => [file, parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")))]).filter(([, analysis]) => analysis?.costReceipt);
  // The checker itself: a real receipt doctored in each way must be flagged.
  if (withReceipts.length) {
    const [, sample] = withReceipts[0];
    const doctor = (change) => { const copy = structuredClone(sample); change(copy.costReceipt, copy); return receiptFlags(copy); };
    assert.ok(doctor((receipt) => { receipt.stageMs.total = 1000; }).some((flag) => /add up to/.test(flag)), "stages longer than the run are flagged");
    assert.ok(doctor((receipt) => { receipt.stageMs.judgment = 0; }).some((flag) => /judgment request was billed but its stage took 0 ms/.test(flag)), "a billed step with no time is flagged");
    assert.ok(doctor((receipt) => { receipt.claude[0].usd *= 2; }).some((flag) => /its tokens cost/.test(flag)), "dollars that do not follow from the tokens are flagged");
    assert.ok(doctor((receipt) => { receipt.tavily.credits += 40; }).some((flag) => /more than its searches/.test(flag)), "too many credits are flagged");
    assert.ok(doctor((receipt) => { receipt.tavily.basicSearches -= 1; }).some((flag) => /search audit has/.test(flag)), "a receipt that disagrees with the search audit is flagged");
    // A Telem receipt (search through the router) whose parts do not add up is flagged too.
    const telemOnly = (change) => doctor((receipt, copy) => {
      copy.searchAudit = copy.searchAudit.map((entry) => ({ ...entry, router: "telem" }));
      const searched = copy.searchAudit.filter((entry) => entry.status === "searched" && entry.reason !== REUSED_REASON);
      const deeper = searched.filter((entry) => entry.depth === "advanced").length;
      receipt.tavily.credits -= receipt.tavily.basicSearches + 2 * receipt.tavily.advancedSearches;
      receipt.tavily.basicSearches = 0;
      receipt.tavily.advancedSearches = 0;
      receipt.usd.tavily = receipt.tavily.credits * receipt.tavily.usdPerCredit;
      receipt.telem = { searches: searched.length, advancedSearches: deeper, providerRuns: { exa: searched.length, brave: searched.length } };
      receipt.usd.telem = searched.length * 0.02;
      receipt.usd.total = receipt.usd.claude + receipt.usd.tavily + receipt.usd.telem;
      change(receipt, copy);
    });
    assert.deepEqual(telemOnly(() => {}).filter((flag) => /Telem|total|search audit/.test(flag)), [], "a consistent Telem receipt raises no Telem flag");
    assert.ok(telemOnly((receipt) => { receipt.usd.total -= receipt.usd.telem; }).some((flag) => /Claude \+ Tavily \+ Telem/.test(flag)), "a total that leaves Telem out is flagged");
    assert.ok(telemOnly((receipt) => { receipt.telem.searches += 1; }).some((flag) => /paid Telem searches/.test(flag)), "a Telem count that disagrees with the audit is flagged");
    assert.ok(telemOnly((receipt) => { receipt.usd.telem = 9; receipt.usd.total = receipt.usd.claude + receipt.usd.tavily + 9; }).some((flag) => /more than .* searches can cost/.test(flag)), "Telem dollars above the reserved worst case are flagged");
  }
  process.stdout.write(`\nReceipt plausibility (${withReceipts.length} saved live receipts; stage times, dollars from tokens and credits, credits against searches, extracted URLs and the search audit):\n`);
  let flagged = 0;
  for (const [file, analysis] of withReceipts) {
    const flags = receiptFlags(analysis);
    if (flags.length) flagged += 1;
    process.stdout.write(`  ${flags.length ? "FLAG" : "ok  "} ${path.basename(file).replace(/\.echo\.json$/, "")}${flags.length ? `: ${flags.join("; ")}` : ""}\n`);
  }
  if (!withReceipts.length) process.stdout.write("  (no saved trace carries a receipt yet)\n");
  else if (!flagged) process.stdout.write("  every receipt is plausible\n");
}

// Latency per stage over every saved live receipt, so a quoted run time is a measured one: median and max per stage
// (a cache hit repeats its original run's receipt, so it is skipped). "other" is the run's time outside the five
// timed stages (building queries, progress events, the answer's fallbacks). Runs on older code are included: the
// per-run lines say which run is which.
{
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  assert.equal(median([4, 1, 3, 2]), 2.5, "an even count's median is the mean of the middle two");
  assert.equal(median([5, 1, 3]), 3);
  const timed = ["search", "extract", "grouping", "judgment", "answer"];
  const live = files.map((file) => [path.basename(file).replace(/\.echo\.json$/, ""), parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")))])
    .filter(([, analysis]) => analysis?.costReceipt && !analysis.cacheHit)
    .map(([name, analysis]) => {
      const ms = analysis.costReceipt.stageMs;
      return { name, ms: { ...ms, other: Math.max(0, ms.total - timed.reduce((total, stage) => total + ms[stage], 0)) } };
    });
  const seconds = (ms) => (ms / 1000).toFixed(1);
  process.stdout.write(`\nLatency per stage over ${live.length} saved live receipts (seconds; cache hits skipped):\n`);
  if (live.length) {
    const totalMedian = median(live.map((run) => run.ms.total));
    for (const stage of [...timed, "other", "total"]) {
      const values = live.map((run) => run.ms[stage]);
      const slowest = live.reduce((best, run) => (run.ms[stage] > best.ms[stage] ? run : best));
      process.stdout.write(`  ${pad(stage, 10)}median ${pad(seconds(median(values)), 6)}max ${pad(seconds(Math.max(...values)), 6)}min ${pad(seconds(Math.min(...values)), 6)}${stage === "total" ? "" : `${pad(`${Math.round((100 * median(values)) / totalMedian)}% of the median run`, 24)}`}slowest: ${slowest.name}\n`);
    }
    for (const run of live) process.stdout.write(`  ${pad(run.name, 58)}${[...timed, "other"].map((stage) => `${stage} ${seconds(run.ms[stage])}`).join(" · ")} · total ${seconds(run.ms.total)} s\n`);
  } else process.stdout.write("  (no saved trace carries a receipt yet)\n");
}

// Deep search (src/lib/echo/search-mode.ts): what a Deep run would cost and take, from this measurement's own model
// (the same chars-per-token input rule and receipt-scaled output, per page, over every saved run) and the receipts'
// stage medians. An ESTIMATE: no live Deep run had been made when it was written. The claim box's tooltip
// (DEEP_ESTIMATE) must cover what this computes, or this check fails.
{
  const { DEEP_SEARCH, DEEP_ESTIMATE, DEEP_MAX_SEARCHES } = load(path.join(root, "src/lib/echo/search-mode.ts"));
  const { telemReserveUsd } = load(path.join(root, "src/lib/echo/telem.ts"));
  const mean = (list) => list.reduce((total, value) => total + value, 0) / Math.max(1, list.length);
  const perStep = (name) => {
    const list = rows.filter((row) => row.calls[name] && row.calls[name].pages);
    return {
      fixedChars: mean(list.map((row) => row.calls[name].instructions + row.calls[name].schemaChars)),
      charsPerPage: mean(list.map((row) => (row.calls[name].total - row.calls[name].instructions) / row.calls[name].pages)),
      outPerPage: mean(list.map((row) => outputEstimate(name, row.calls[name]) / row.calls[name].pages)),
    };
  };
  const cluster = perStep("cluster");
  const judge = perStep("judge");
  const answers = rows.filter((row) => row.calls.answer);
  const answerUsd = mean(answers.map((row) => usd(requestTokens(row.calls.answer.total + row.calls.answer.schemaChars), outputEstimate("answer", row.calls.answer))));
  const pages = DEEP_SEARCH.pagesRead;
  const groupingIn = requestTokens(cluster.fixedChars + pages * cluster.charsPerPage);
  const groupingOut = Math.round(pages * cluster.outPerPage);
  // Judgment: 50 pages in one claim group (the worst case for context) are 3 requests of 20, 20 and 10 judged pages;
  // the last two carry 20 context pages each (400 characters of text plus ~250 of metadata and keys).
  const parts = [20, 20, 10];
  const contextChars = 650;
  const judgeIn = parts.reduce((total, size, index) => total + requestTokens(judge.fixedChars + size * judge.charsPerPage + (index ? 20 * contextChars : 0)), 0);
  const judgeOut = Math.round(pages * judge.outPerPage);
  const claudeUsd = usd(groupingIn, groupingOut) + usd(judgeIn, judgeOut) + answerUsd * 1.5;
  const tavilySearchCredits = DEEP_SEARCH.basicQueries + 2 * DEEP_SEARCH.advancedQueries;
  const extractCredits = Math.ceil(pages / 5);
  const tavilyRouter = claudeUsd + (tavilySearchCredits + extractCredits) * TAVILY_USD;
  const telemWorst = DEEP_SEARCH.basicQueries * telemReserveUsd("default", DEEP_SEARCH.resultsPerSearch) + DEEP_SEARCH.advancedQueries * telemReserveUsd("extended", DEEP_SEARCH.resultsPerSearch);
  const telemTypical = DEEP_MAX_SEARCHES * 0.02; // two or three engines answering a search: ~$0.02
  const telemLow = claudeUsd + extractCredits * TAVILY_USD + telemTypical;
  const telemHigh = claudeUsd + extractCredits * TAVILY_USD + telemWorst;
  // Time from the receipts' stage medians: 5 rounds of searches (12 basic in 5s, 4 deeper in 3s) against Standard's
  // ~2.5, 50 pages read against ~18, the grouping output scaled, judgment batches 3 at a time (the slowest of three).
  const live = files.map((file) => parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")))).filter((analysis) => analysis?.costReceipt && !analysis.cacheHit);
  const median = (values) => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
  const stage = (name) => median(live.map((analysis) => analysis.costReceipt.stageMs[name])) / 1000;
  const standardGroupingOut = mean(rows.filter((row) => row.calls.cluster).map((row) => outputEstimate("cluster", row.calls.cluster)));
  const seconds = stage("search") * 2 + stage("extract") * 1.6 + stage("grouping") * Math.max(1, groupingOut / standardGroupingOut) + stage("judgment") * 1.25 + stage("answer") * 1.2;
  process.stdout.write(`\nDeep search estimate (search-mode.ts; ${pages} pages, ${DEEP_MAX_SEARCHES} searches of ${DEEP_SEARCH.resultsPerSearch} results, judged in 3 batches):\n`);
  process.stdout.write(`  Claude ≈ $${claudeUsd.toFixed(3)}: grouping ${num(groupingIn)} in / ${num(groupingOut)} out, judgment ${num(judgeIn)} in / ${num(judgeOut)} out over 3 requests, answer ≈ $${(answerUsd * 1.5).toFixed(3)}\n`);
  process.stdout.write(`  Tavily router: + ${tavilySearchCredits} search + ${extractCredits} extract credits = $${tavilyRouter.toFixed(3)} a run\n`);
  process.stdout.write(`  Telem router: + ${extractCredits} extract credits + Telem $${telemTypical.toFixed(2)} (2-3 engines a search) to $${telemWorst.toFixed(3)} (every engine, the reservation) = $${telemLow.toFixed(3)}-${telemHigh.toFixed(3)} a run\n`);
  process.stdout.write(`  time ≈ ${Math.round(seconds)} s (search ${(stage("search") * 2).toFixed(0)}, extract ${(stage("extract") * 1.6).toFixed(0)}, grouping ${(stage("grouping") * Math.max(1, groupingOut / standardGroupingOut)).toFixed(0)}, judgment ${(stage("judgment") * 1.25).toFixed(0)}, answer ${(stage("answer") * 1.2).toFixed(0)}); tooltip: Telem ≈$${DEEP_ESTIMATE.telem.lowUsd}-${DEEP_ESTIMATE.telem.highUsd}, Tavily ≈$${DEEP_ESTIMATE.tavily.lowUsd}-${DEEP_ESTIMATE.tavily.highUsd}, ~${DEEP_ESTIMATE.minutes} min\n`);
  const within = (value, low, high) => value >= low - 1e-9 && value <= high + 1e-9;
  assert.ok(within(tavilyRouter, DEEP_ESTIMATE.tavily.lowUsd, DEEP_ESTIMATE.tavily.highUsd), `the Tavily-router Deep estimate ($${tavilyRouter.toFixed(3)}) is inside the tooltip's range`);
  assert.ok(within(telemLow, DEEP_ESTIMATE.telem.lowUsd, DEEP_ESTIMATE.telem.highUsd) && within(telemHigh, DEEP_ESTIMATE.telem.lowUsd, DEEP_ESTIMATE.telem.highUsd), `the Telem-router Deep estimate ($${telemLow.toFixed(3)}-${telemHigh.toFixed(3)}) is inside the tooltip's range`);
  assert.ok(Math.abs(telemWorst - DEEP_ESTIMATE.telem.telemHighUsd) < 0.005, "the tooltip's Telem ceiling is the Deep run's Telem reservation");
  assert.ok(within(seconds, 60, 120), `the Deep time estimate (${Math.round(seconds)} s) is the tooltip's 1-2 minutes`);
}

// Where each request's input goes.
process.stdout.write("\nWhere the input goes (average characters per request):\n");
for (const name of ["cluster", "judge", "answer"]) {
  const list = rows.map((row) => row.calls[name]).filter(Boolean);
  if (!list.length) continue;
  const mean = (key) => list.reduce((total, call) => total + call[key], 0) / list.length;
  process.stdout.write(`  ${pad(name, 8)} total ${num(mean("total") + mean("schemaChars"))}: fixed instructions ${num(mean("instructions"))}, output schema ${num(mean("schemaChars"))}, page text ${num(mean("text"))}, page metadata/keys ${num(mean("meta"))}${name === "judge" ? `, citedPages ${num(mean("cited"))}, sharedWording ${num(mean("wording"))}, empty arrays ${num(mean("emptyArrays"))}` : ""}\n`);
}

// Prompt caching: what is stable across requests.
const judgeFixed = rows.map((row) => row.calls.judge).filter(Boolean);
const meanJudgeFixed = judgeFixed.reduce((total, call) => total + call.instructions + call.schemaChars, 0) / Math.max(1, judgeFixed.length);
const meanJudgeTotal = judgeFixed.reduce((total, call) => total + call.total + call.schemaChars, 0) / Math.max(1, judgeFixed.length);
const judgeOut = totals.calls.judge.out / Math.max(1, totals.calls.judge.n);
const fixedTokens = tokens(meanJudgeFixed);
const allTokens = requestTokens(meanJudgeTotal);
process.stdout.write(`\nPrompt caching (Sonnet 5.5: minimum 512 tokens; write 1.25x, read $0.10/M = 0.05x):\n`);
process.stdout.write(`  Within one live run the three requests share no prefix (different instructions first), so caching cannot be read back inside a run.\n`);
process.stdout.write(`  Judge fixed instructions + schema ≈ ${num(fixedTokens)} tokens, the same in every run; caching them saves ≈ $${((fixedTokens * (PRICE.input - PRICE.cacheRead)) / 1e6).toFixed(4)} per later run within 5 minutes and costs ≈ $${((fixedTokens * (PRICE.cacheWrite - PRICE.input)) / 1e6).toFixed(4)} extra on a run with no follow-up.\n`);
const runs = 10;
const noCache = runs * usd(allTokens, judgeOut);
const withCache = (allTokens * PRICE.cacheWrite + (runs - 1) * allTokens * PRICE.cacheRead + runs * judgeOut * PRICE.output) / 1e6;
process.stdout.write(`  Re-judging one saved trace ${runs} times (rejudge:trace; byte-identical prompt ≈ ${num(allTokens)} tokens): ≈ $${noCache.toFixed(3)} without caching, ≈ $${withCache.toFixed(3)} with ECHO_PROMPT_CACHE=1 (${Math.round(100 - (100 * withCache) / noCache)}% less).\n`);

// Tavily search yield from the saved audits.
process.stdout.write("\nTavily searches (from each trace's saved search audit):\n");
for (const file of files) {
  const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
  const audit = (analysis?.searchAudit ?? []).filter((entry) => entry.status !== "not searched");
  const advanced = audit.filter((entry) => entry.depth === "advanced");
  const roots = new Set(analysis.roots);
  const advancedPages = advanced.flatMap((entry) => entry.pageIds ?? []);
  process.stdout.write(`  ${pad(path.basename(file).replace(/\.echo\.json$/, "").slice(0, 45), 46)}basic ${audit.length - advanced.length}, advanced ${advanced.length} (${advanced.length * 2} credits) adding ${advancedPages.length} kept pages, ${advancedPages.filter((id) => roots.has(id)).length} of them roots\n`);
}

// The thin-claim path (ECHO_DEEP_SEARCH_BELOW). Saved audits used the queries of their day; since the 11/13 query fix
// the generator keeps the claim's figures, so for traces whose queries changed the basic page count below is only a
// lower bound and the advanced pass may not fire at all. What the new queries would find can only be seen live.
{
  const { generateQueries } = load(path.join(root, "src/lib/echo/pipeline.ts"));
  const { comparisonPageKey } = load(path.join(root, "src/lib/echo/compare.ts"));
  const sheets = new Map(fs.readdirSync(path.join(root, "evaluation")).filter((name) => name.endsWith(".labels.json")).map((name) => {
    const sheet = JSON.parse(fs.readFileSync(path.join(root, "evaluation", name), "utf8"));
    return [sheet.claim, new Map(sheet.labels.map((label) => [label.sourceKey, label]))];
  }));
  process.stdout.write("\nThin-claim path (advanced pass; basic distinct pages decide it, threshold default 20):\n");
  const thin = [];
  for (const file of files) {
    const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
    const audit = (analysis?.searchAudit ?? []).filter((entry) => entry.status !== "not searched");
    const basic = audit.filter((entry) => entry.depth === "basic");
    const basicPages = basic.reduce((total, entry) => total + entry.uniquePagesAdded, 0);
    const now = new Set(generateQueries(analysis.claim));
    const changed = basic.filter((entry) => !now.has(entry.query)).length;
    const advanced = audit.filter((entry) => entry.depth === "advanced");
    const name = path.basename(file).replace(/\.echo\.json$/, "");
    thin.push({ name, basicPages, changed, advancedRan: advanced.length > 0 });
    if (!advanced.length) continue;
    const labels = sheets.get(analysis.claim) ?? new Map();
    const added = advanced.flatMap((entry) => entry.pageIds ?? []).map((id) => analysis.pages.find((page) => page.id === id)).filter(Boolean);
    const described = added.map((page) => {
      const label = labels.get(comparisonPageKey(page));
      return `${page.domain} ${page.judgment.kind}${label ? ` (label ${label.expectedKind ?? "none"})` : " (unlabeled)"}`;
    });
    const unique = advanced.reduce((total, entry) => total + entry.uniquePagesAdded, 0);
    process.stdout.write(`  ${pad(name.slice(0, 45), 46)}basic ${basicPages} pages${changed ? ` (${changed}/${basic.length} of its queries changed by the fix: a lower bound)` : " (same queries today)"}; advanced added ${unique}, kept ${added.length}: ${described.join("; ") || "none"}\n`);
  }
  const advancedRuns = (threshold) => thin.filter((row) => row.advancedRan && row.basicPages < threshold);
  const cells = [20, 15, 14, 13, 10, 0].map((threshold) => `<${threshold}: ${advancedRuns(threshold).length}`);
  process.stdout.write(`  Runs whose saved basic count would still trigger the advanced pass, by ECHO_DEEP_SEARCH_BELOW: ${cells.join(", ")} (of ${thin.length}; 6 credits ≈ $0.048 each).\n`);
  const unknown = thin.filter((row) => row.advancedRan && row.changed).length;
  process.stdout.write(`  ${unknown} of the ${thin.filter((row) => row.advancedRan).length} thin runs used queries the fix has since changed; their basic count today is unknown offline.\n`);
}

// Offline checks of the cost switches (mocked providers, no spend). They assert, so a broken switch fails this script.
process.stdout.write("\nCost switch checks (mocked providers):\n");
{
  // A thin claim: every basic query returns the same 12 pages, so basic search ends with 12 distinct pages.
  const thin = files.map((file) => parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")))).find((analysis) => analysis?.pages.length === 12);
  assert.ok(thin, "a saved trace with 12 pages exists for the deep-search check");
  current = { analysis: thin, idMap: new Map(thin.pages.map((page, index) => [page.id, `page-${index + 1}`])) };
  const advancedCalls = async (setting) => {
    if (setting === undefined) delete process.env.ECHO_DEEP_SEARCH_BELOW;
    else process.env.ECHO_DEEP_SEARCH_BELOW = setting;
    captured.length = 0;
    await analyzeClaim(thin.claim, () => {}, { forceFresh: true });
    delete process.env.ECHO_DEEP_SEARCH_BELOW;
    const searches = captured.filter((entry) => entry.endpoint === "tavily search");
    return { basic: searches.filter((entry) => entry.body.search_depth === "basic").length, advanced: searches.filter((entry) => entry.body.search_depth === "advanced").length };
  };
  const unset = await advancedCalls(undefined);
  assert.equal(unset.advanced, 3, "default: 12 basic pages (< 20) still trigger the 3-query advanced pass");
  assert.equal((await advancedCalls("10")).advanced, 0, "ECHO_DEEP_SEARCH_BELOW=10: 12 basic pages mean no advanced call");
  assert.equal((await advancedCalls("0")).advanced, 0, "ECHO_DEEP_SEARCH_BELOW=0 skips the advanced pass");
  assert.equal((await advancedCalls("13")).advanced, 3, "ECHO_DEEP_SEARCH_BELOW=13: 12 pages are still below the trigger");
  assert.equal((await advancedCalls("50")).advanced, 3, "values above 20 act as 20; the switch never adds searches");
  assert.equal((await advancedCalls("junk")).advanced, 3, "an invalid value keeps the default");
  process.stdout.write(`  ok  ECHO_DEEP_SEARCH_BELOW: 12 basic pages -> 3 advanced searches by default (${unset.basic} basic), 0 with =10 or =0 (saves 6 credits ≈ $0.048)\n`);
}
{
  // The cost receipt: a live run carries one that matches what the mocked providers billed; rejudge-style calls don't.
  const sample = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, "public/demo-traces/lose-most-body-heat-through-head.echo.json"), "utf8")));
  assert.equal(sample.costReceipt, undefined, "a trace saved before receipts existed shows no receipt");
  current = { analysis: sample, idMap: new Map(sample.pages.map((page, index) => [page.id, `page-${index + 1}`])) };
  captured.length = 0;
  billUsage = true;
  const result = await analyzeClaim(sample.claim, () => {}, { forceFresh: true });
  const receipt = result.costReceipt;
  assert.ok(receipt && receipt.version === 1, "a live run carries a cost receipt");
  const searches = captured.filter((entry) => entry.endpoint === "tavily search");
  const extracts = captured.filter((entry) => entry.endpoint === "tavily extract");
  assert.equal(receipt.tavily.basicSearches + receipt.tavily.advancedSearches, searches.length, "every completed search is on the receipt");
  assert.equal(receipt.tavily.extractRequests, extracts.length, "every completed extract is on the receipt");
  const billedCredits = searches.reduce((total, entry) => total + (entry.body.search_depth === "advanced" ? 2 : 1), 0) + extracts.reduce((total, entry) => total + Math.ceil(entry.body.urls.length / 5), 0);
  assert.equal(receipt.tavily.credits, billedCredits, "receipt credits are the credits Tavily reported");
  const messages = captured.filter((entry) => entry.endpoint === "messages");
  assert.deepEqual(receipt.claude.map((entry) => entry.step), ["grouping", "judgment", "answer"].slice(0, messages.length), "one receipt line per paid Claude request, in order");
  assert.equal(receipt.claude.reduce((total, entry) => total + entry.inputTokens, 0), messages.reduce((total, entry) => total + mockInputTokens(entry.body), 0), "receipt tokens are the usage Claude reported");
  assert.ok(Math.abs(receipt.usd.total - receipt.usd.claude - receipt.usd.tavily) < 1e-6 && receipt.usd.tavily === receipt.tavily.credits * 0, "dollar totals add up (Tavily priced at this script's $0 per credit)");
  assert.ok(Object.values(receipt.stageMs).every((ms) => Number.isFinite(ms) && ms >= 0) && receipt.stageMs.total >= receipt.stageMs.search, "stage times are recorded");
  captured.length = 0;
  const rejudged = await judgePages(sample.claim, sample.pages, sample.clusters);
  assert.ok(Array.isArray(rejudged) && captured.some((entry) => entry.endpoint === "messages"), "judgePages outside a live run still works and records nothing");
  billUsage = false;
  process.stdout.write(`  ok  cost receipt: ${receipt.tavily.credits} Tavily credits over ${searches.length} searches + ${extracts.length} extracts, ${receipt.claude.length} Claude requests (${receipt.claude.map((entry) => `${entry.step} ${entry.inputTokens}/${entry.outputTokens}`).join(", ")}) ≈ $${receipt.usd.claude.toFixed(4)} Claude on the mocked usage\n`);
}

{
  // ECHO_PROMPT_CACHE: the model reads the same text; only the judge request is split into two cache-marked blocks.
  const sample = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, "public/demo-traces/goldfish-3-second-memory.echo.json"), "utf8")));
  current = { analysis: sample, idMap: new Map(sample.pages.map((page, index) => [page.id, `page-${index + 1}`])) };
  const bodies = async (flag) => {
    if (flag) process.env.ECHO_PROMPT_CACHE = "1";
    captured.length = 0;
    await analyzeClaim(sample.claim, () => {}, { forceFresh: true });
    delete process.env.ECHO_PROMPT_CACHE;
    return captured.filter((entry) => entry.endpoint === "messages" || entry.endpoint === "count_tokens").map((entry) => entry.body);
  };
  const off = await bodies(false);
  const on = await bodies(true);
  assert.equal(off.length, on.length, "the switch adds or removes no request");
  let cachedRequests = 0;
  off.forEach((plain, index) => {
    const cached = on[index];
    const plainContent = plain.messages[0].content;
    const cachedContent = cached.messages[0].content;
    assert.equal(typeof plainContent, "string", "without the switch every prompt is sent as one plain string, as before");
    if (typeof cachedContent === "string") {
      assert.deepEqual(cached, plain, "requests other than the judge are byte-identical with the switch on");
      return;
    }
    cachedRequests += 1;
    assert.ok(plainContent.startsWith("You are a cautious"), "only the source-judgment request is cache-marked");
    assert.equal(cachedContent.length, 2, "two blocks: fixed instructions, then the run's data");
    assert.ok(cachedContent.every((block) => block.type === "text" && block.cache_control?.type === "ephemeral"), "both blocks carry a 5-minute cache mark");
    assert.equal(cachedContent.map((block) => block.text).join(""), plainContent, "the blocks join to exactly the plain prompt");
    assert.ok(cachedContent[1].text.startsWith("Claim: "), "the fixed part ends before the claim");
    assert.deepEqual({ ...cached, messages: undefined }, { ...plain, messages: undefined }, "model, max_tokens and schema are unchanged");
  });
  assert.equal(cachedRequests, 2, "the judge request and its free token count are both cache-marked");
  const fixedTokens = tokens(on.find((body) => typeof body.messages[0].content !== "string").messages[0].content[0].text.length);
  assert.ok(fixedTokens >= 512, "the fixed instructions are above Sonnet 5.5's 512-token cache minimum");

  // Billing: a cache write is settled at 1.25x input and a cache read at $0.10 per million tokens.
  const { getAnthropicBudgetSnapshot } = load(path.join(root, "src/lib/echo/daily-budget.ts"));
  const blank = sample.pages.map((page) => ({ ...page, judgment: { kind: "origin", parentId: null, confidence: 0, evidence: "Awaiting source comparison." }, hasPrimaryEvidence: false }));
  current = { analysis: sample, idMap: new Map(sample.pages.map((page) => [page.id, page.id])) };
  process.env.ECHO_PROMPT_CACHE = "1";
  usageOverride = { input_tokens: 300, cache_creation_input_tokens: 2000, cache_read_input_tokens: 5000, output_tokens: 1000 };
  const before = (await getAnthropicBudgetSnapshot()).spentUsd;
  await judgePages(sample.claim, blank, sample.clusters);
  const charged = (await getAnthropicBudgetSnapshot()).spentUsd - before;
  usageOverride = null;
  delete process.env.ECHO_PROMPT_CACHE;
  const expected = (300 * 2 + 2000 * 2.5 + 5000 * 0.1 + 1000 * 10) / 1e6;
  assert.ok(Math.abs(charged - expected) < 1e-9, `cache writes and reads are charged to the daily cap ($${charged} vs $${expected})`);
  assert.ok((await getAnthropicBudgetSnapshot()).reservedUsd < 1e-9, "no reservation is left behind");
  process.stdout.write(`  ok  ECHO_PROMPT_CACHE: judge prompt split into 2 cache-marked blocks (fixed part ≈ ${fixedTokens} tokens), same text, other requests unchanged; cache writes/reads charged to the cap\n`);
}

{
  // The search cache (on by default; ECHO_SEARCH_CACHE=0 turns it off): a retry that is not "Run fresh" reuses the
  // searches of a run that failed after searching.
  const sample = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, "public/demo-traces/americans-check-phones-96-times.echo.json"), "utf8")));
  current = { analysis: sample, idMap: new Map(sample.pages.map((page, index) => [page.id, `page-${index + 1}`])) };
  const searchesFor = async (claim, options) => {
    captured.length = 0;
    let pages = null;
    let result = null;
    let failure = null;
    try { result = await analyzeClaim(claim, () => {}, options); pages = result.pages.map((page) => page.url); } catch (error) { if (error.code !== "CLAUDE_ERROR") throw error; failure = error; }
    return { searches: captured.filter((entry) => entry.endpoint === "tavily search").length, extracts: captured.filter((entry) => entry.endpoint === "tavily extract").length, pages, result, failure };
  };
  const { REUSED_SEARCH_REASON } = load(path.join(root, "src/lib/echo/pipeline.ts"));
  // Opted out: every retry searches again, as before 11/13.
  process.env.ECHO_SEARCH_CACHE = "0";
  rejectModel = true;
  const offFirst = await searchesFor(sample.claim, {});
  rejectModel = false;
  const offRetry = await searchesFor(sample.claim, {});
  assert.ok(offFirst.searches > 0 && offRetry.searches === offFirst.searches, "with ECHO_SEARCH_CACHE=0 a retry searches again");
  // Default (unset): a retry reuses the failed run's searches.
  delete process.env.ECHO_SEARCH_CACHE;
  // A claim none of whose queries an earlier replay in this script searched (the cache is keyed by query, and the
  // quoted phrase "Americans check their phones" is shared by every phones trace).
  const claim = `${sample.claim} `.replace("96", "ninety-six").replace("phones", "smartphones");
  rejectModel = true;
  const onFirst = await searchesFor(claim, {});
  rejectModel = false;
  const onRetry = await searchesFor(claim, {});
  assert.equal(onRetry.searches, 0, "by default a retry within 15 minutes reuses every completed search");
  assert.ok(onRetry.pages?.length, "the retry still completes the trace from the reused results");
  // A failed run says what it spent: its error carries a receipt with the searches and extracts it paid for.
  const spentReceipt = onFirst.failure?.costReceipt;
  assert.ok(spentReceipt && spentReceipt.tavily.basicSearches + spentReceipt.tavily.advancedSearches === onFirst.searches && spentReceipt.tavily.extractRequests === onFirst.extracts && spentReceipt.claude.length === 0, "a run that failed after searching returns a receipt of what it spent");
  // The retry's audit says its searches were reused, and its receipt shows no new searches.
  const reusedAudit = onRetry.result.searchAudit.filter((entry) => entry.status === "searched");
  assert.ok(reusedAudit.length > 0 && reusedAudit.every((entry) => entry.reason === REUSED_SEARCH_REASON), "every reused search is marked as reused from the 15-minute cache in the audit");
  assert.equal(onRetry.result.costReceipt.tavily.basicSearches + onRetry.result.costReceipt.tavily.advancedSearches, 0, "the retry's receipt counts no searches");
  assert.ok(parsePortableTrace({ format: "echo-trace", version: 1, exportedAt: new Date().toISOString(), analysis: onRetry.result }), "a trace with reused searches still passes the import check");
  const fresh = await searchesFor(claim, { forceFresh: true });
  assert.equal(fresh.searches, onFirst.searches, "Run fresh always searches again, even with cached searches waiting");
  assert.ok(fresh.result.searchAudit.every((entry) => entry.reason !== REUSED_SEARCH_REASON), "a fresh run's searches are not marked reused");
  // A server cache hit is the original run, receipt included; cacheHit says so.
  const hit = await analyzeClaim(claim, () => {}, {});
  assert.ok(hit.cacheHit === true && hit.costReceipt, "a cache hit returns the original run's receipt, marked cacheHit");
  const freshAgain = await searchesFor(claim, { forceFresh: true });
  assert.equal(freshAgain.searches, onFirst.searches, "a second Run fresh searches again too");
  process.stdout.write(`  ok  search cache (on by default): a retry after a failed run makes 0 of ${onFirst.searches} searches again (saves ${onFirst.searches} basic/advanced requests); Run fresh always searches; ECHO_SEARCH_CACHE=0 turns it off\n`);
}

{
  // ANTHROPIC_GROUPING_MODEL: only the grouping request changes model; an unpriced model stops before any search.
  const sample = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, "public/demo-traces/goldfish-3-second-memory.echo.json"), "utf8")));
  current = { analysis: sample, idMap: new Map(sample.pages.map((page, index) => [page.id, `page-${index + 1}`])) };
  const models = async () => {
    captured.length = 0;
    await analyzeClaim(sample.claim, () => {}, { forceFresh: true });
    return Object.fromEntries(captured.filter((entry) => entry.endpoint === "messages").map((entry) => [promptText(entry.body).slice(0, 12), entry.body.model]));
  };
  const before = await models();
  assert.ok(Object.values(before).every((name) => name === "claude-sonnet-5-5"), "unset: every request uses the configured model");
  process.env.ANTHROPIC_GROUPING_MODEL = "claude-haiku-5-5";
  const after = await models();
  assert.equal(after["Group these "], "claude-haiku-5-5", "the grouping request moves to the switch's model");
  assert.equal(after["You are a ca"], "claude-sonnet-5-5", "the source judgment stays on the classifier model");
  assert.equal(after["Answer the u"], before["Answer the u"], "the answer request is unchanged");
  process.env.ANTHROPIC_GROUPING_MODEL = "some-unpriced-model";
  captured.length = 0;
  await assert.rejects(analyzeClaim(sample.claim, () => {}, { forceFresh: true }), (error) => error.code === "BUDGET_MODEL_UNSUPPORTED");
  assert.equal(captured.length, 0, "an unpriced grouping model stops the run before any search");
  delete process.env.ANTHROPIC_GROUPING_MODEL;
  process.stdout.write("  ok  ANTHROPIC_GROUPING_MODEL: only grouping moves model; an unpriced model stops before search; off by default\n");
}

{
  // ECHO_THINKING_OFF: off by default no request carries a `thinking` field (as before); with it, only the named steps
  // (and their free token counts) carry the model's off switch, and everything else is byte-identical.
  const sample = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, "public/demo-traces/goldfish-3-second-memory.echo.json"), "utf8")));
  current = { analysis: sample, idMap: new Map(sample.pages.map((page, index) => [page.id, `page-${index + 1}`])) };
  const bodies = async () => {
    captured.length = 0;
    await analyzeClaim(sample.claim, () => {}, { forceFresh: true });
    return captured.filter((entry) => entry.endpoint === "messages" || entry.endpoint === "count_tokens").map((entry) => entry.body);
  };
  const stepOf = (body) => ({ "Group these ": "grouping", "You are a ca": "judgment", "Answer the u": "answer" })[promptText(body).slice(0, 12)];
  delete process.env.ECHO_THINKING_OFF;
  const plain = await bodies();
  assert.ok(plain.length === 6 && plain.every((body) => !("thinking" in body)), "unset: no request sends a thinking setting");
  process.env.ECHO_THINKING_OFF = "judgment";
  const judgeOff = await bodies();
  judgeOff.forEach((body, index) => {
    if (stepOf(body) === "judgment") assert.deepEqual(body.thinking, { type: "between_tools" }, "Sonnet 5.5's off switch is between_tools (disabled is a 400)");
    else assert.deepEqual(body, plain[index], "requests for other steps are byte-identical");
  });
  assert.equal(judgeOff.filter((body) => body.thinking).length, 2, "the judge request and its token count carry it");
  process.env.ECHO_THINKING_OFF = "grouping";
  process.env.ANTHROPIC_GROUPING_MODEL = "claude-haiku-5-5";
  const groupOff = await bodies();
  assert.ok(groupOff.filter((body) => body.thinking).every((body) => stepOf(body) === "grouping" && body.model === "claude-haiku-5-5" && body.thinking.type === "disabled"), "Haiku 5.5 takes disabled");
  delete process.env.ANTHROPIC_GROUPING_MODEL;
  process.env.ECHO_THINKING_OFF = "all";
  assert.equal((await bodies()).filter((body) => body.thinking?.type === "between_tools").length, 6, "all: every request");
  delete process.env.ECHO_THINKING_OFF;
  // ECHO_LOG_USAGE=1 prints token counts, never the prompt.
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  process.env.ECHO_LOG_USAGE = "1";
  usageOverride = { input_tokens: 5000, output_tokens: 900, output_tokens_details: { thinking_tokens: 400 } };
  try { await bodies(); } finally { process.stderr.write = write; delete process.env.ECHO_LOG_USAGE; usageOverride = null; }
  const usageLines = lines.filter((line) => line.startsWith("[echo usage]"));
  assert.equal(usageLines.length, 3, "one usage line per paid request");
  assert.ok(usageLines.every((line) => /thinking 400/.test(line) && !line.includes(sample.claim)), "usage lines report thinking tokens and no prompt text");
  process.stdout.write("  ok  ECHO_THINKING_OFF: unset sends no thinking field; =judgment adds Sonnet's between_tools to the judge only (Haiku: disabled); ECHO_LOG_USAGE prints thinking tokens; off by default\n");
}

{
  // ECHO_SEARCH_RAW_CONTENT: off, every search body is byte-identical to before (include_raw_content false); on, the
  // searches ask for page text and only pages that came back without it are extracted.
  const sample = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, "public/demo-traces/goldfish-3-second-memory.echo.json"), "utf8")));
  current = { analysis: sample, idMap: new Map(sample.pages.map((page, index) => [page.id, `page-${index + 1}`])) };
  const run = async () => {
    captured.length = 0;
    const result = await analyzeClaim(sample.claim, () => {}, { forceFresh: true });
    return { result, searches: captured.filter((entry) => entry.endpoint === "tavily search").map((entry) => entry.body), extracts: captured.filter((entry) => entry.endpoint === "tavily extract").map((entry) => entry.body) };
  };
  const off = await run();
  assert.ok(off.searches.length && off.searches.every((body) => body.include_raw_content === false), "unset: searches send include_raw_content false, as before");
  assert.ok(off.extracts.length > 0, "unset: pages are extracted");
  process.env.ECHO_SEARCH_RAW_CONTENT = "1";
  const on = await run();
  assert.equal(on.searches.length, off.searches.length, "the switch adds or removes no search");
  on.searches.forEach((body, index) => assert.deepEqual({ ...body, include_raw_content: false }, off.searches[index], "only include_raw_content changes in a search"));
  assert.ok(on.searches.every((body) => body.include_raw_content === "markdown"), "on: searches ask for markdown page text");
  assert.equal(on.extracts.length, 0, "on: pages that came with text are not extracted");
  assert.equal(on.result.costReceipt.tavily.extractRequests, 0, "the receipt shows no extract");
  assert.ok(on.result.pages.every((page) => page.extractionSource === "Tavily extraction"), "search page text counts as Tavily's parsed text");
  const missing = sample.pages.slice(0, 3).map((page) => page.url);
  rawMissing = new Set(missing);
  const partial = await run();
  rawMissing = new Set();
  delete process.env.ECHO_SEARCH_RAW_CONTENT;
  assert.deepEqual(partial.extracts.flatMap((body) => body.urls).sort(), missing.map((url) => url).sort(), "on: only pages that came back without text are extracted");
  const saved = off.result.costReceipt.tavily.credits - on.result.costReceipt.tavily.credits;
  process.stdout.write(`  ok  ECHO_SEARCH_RAW_CONTENT: unset sends include_raw_content false (unchanged); =1 asks searches for page text and extracts only pages without it (on this trace: ${off.extracts.length} extract requests and ${saved} credits fewer, if searches still bill 1 credit each); off by default\n`);
}

{
  // regroup:trace (scripts/regroup-trace.mjs): re-runs only the grouping request on saved traces. Proves, with mocked
  // providers and this script's throwaway ledger, that each pass is exactly one paid grouping request on the chosen
  // model (plus its free token count), that every pass is reserved and settled in the daily ledger, that the script
  // refuses before sending anything when its worst-case estimate exceeds what is left, and that a ledger stop mid-job
  // ends the job.
  const { regroupTraces, compareGrouping, defaultTraceFiles } = await import(pathToFileURL(path.join(root, "scripts/regroup-trace.mjs")).href);
  const { groupingPrompt } = load(path.join(root, "src/lib/echo/pipeline.ts"));
  const { getAnthropicBudgetSnapshot } = load(path.join(root, "src/lib/echo/daily-budget.ts"));
  const quiet = () => {};

  // The comparison itself.
  const judged = (id, kind, parentId = null) => ({ id, judgment: { kind, parentId } });
  const pages = [judged("a", "origin"), judged("b", "derived", "a"), judged("c", "unclear"), judged("d", "origin"), judged("e", "unclear", "d")];
  const saved = [{ pageIds: ["a", "b", "c"] }, { pageIds: ["d", "e"] }];
  const same = compareGrouping(saved, [{ pageIds: ["d", "e"] }, { pageIds: ["c", "a", "b"] }], new Set(), pages);
  assert.ok(!same.changed && same.moved.length === 0 && same.splitPairs === 0 && same.brokenLinks.length === 0, "the same partition in another order is no change");
  const movedOne = compareGrouping(saved, [{ pageIds: ["a", "b"] }, { pageIds: ["c", "d", "e"] }], new Set(), pages);
  assert.deepEqual([movedOne.moved, movedOne.splitPairs, movedOne.savedPairs, movedOne.brokenLinks], [["c"], 2, 4, []], "one page moved splits its two pairs and no parent link");
  const merged = compareGrouping(saved, [{ pageIds: ["a", "b", "c", "d", "e"] }], new Set(), pages);
  assert.deepEqual(merged.moved, ["d", "e"], "a merge moves the smaller saved group");
  const dropped = compareGrouping(saved, [{ pageIds: ["b", "c"] }, { pageIds: ["d", "e"] }], new Set(["a"]), pages);
  assert.deepEqual([dropped.excluded, dropped.excludedRoots, dropped.brokenLinks], [["a"], ["a"], ["b"]], "an excluded root is reported, and its copy's link breaks");

  // A perturbed grouping through the script: one page moved, one group marked off-claim.
  const goldfishFile = path.join(root, "public/demo-traces/goldfish-3-second-memory.echo.json");
  const goldfish = parsePortableTrace(JSON.parse(fs.readFileSync(goldfishFile, "utf8")));
  const savedDrafts = () => goldfish.clusters.map((cluster) => ({ label: cluster.label, pageIds: [...cluster.pageIds], matchesClaim: true }));
  groupingOverride = savedDrafts;
  const unchanged = await regroupTraces({ files: [goldfishFile], model: "claude-haiku-5-5", runs: 1, log: quiet });
  assert.equal(unchanged.rows[0].changed, false, "the saved grouping answered back is no change");
  groupingOverride = () => {
    const drafts = savedDrafts();
    drafts[1].pageIds.push(drafts[0].pageIds.pop());
    drafts[3].matchesClaim = false;
    return drafts;
  };
  const perturbed = (await regroupTraces({ files: [goldfishFile], model: "claude-haiku-5-5", runs: 1, log: quiet })).rows[0];
  assert.deepEqual([perturbed.moved.length, perturbed.excluded, perturbed.newGroups], [1, goldfish.clusters[3].pageIds, goldfish.clusters.length - 1], "a moved page and an excluded group are both reported");

  // Every saved trace, twice: one grouping request per pass, on the chosen model, all charged to the ledger.
  const files = defaultTraceFiles(root);
  assert.equal(files.length, savedTraceCount, "regroup:trace uses the same saved traces as this measurement");
  groupingOverride = (prompt) => [{ label: "all", pageIds: JSON.parse(prompt.slice(prompt.indexOf("\n\nPages: ") + 9)).map((page) => page.id), matchesClaim: true }];
  billUsage = true;
  captured.length = 0;
  const before = await getAnthropicBudgetSnapshot();
  const report = await regroupTraces({ files, model: "claude-haiku-5-5", runs: 2, log: quiet });
  const after = await getAnthropicBudgetSnapshot();
  const messages = captured.filter((entry) => entry.endpoint === "messages");
  assert.equal(report.passes, files.length * 2, "every trace is regrouped twice");
  assert.ok(report.rows.every((row) => !row.error && row.requests === 1), "each pass records exactly one paid request");
  assert.equal(messages.length, files.length * 2, "exactly one grouping request per pass");
  assert.equal(captured.filter((entry) => entry.endpoint === "count_tokens").length, files.length * 2, "one free token count per pass, before its paid request");
  assert.equal(captured.filter((entry) => entry.endpoint.startsWith("tavily")).length, 0, "no search or extract credits");
  assert.ok(messages.every((entry) => entry.body.model === "claude-haiku-5-5" && promptText(entry.body).startsWith("Group these") && entry.body.max_tokens === 1800), "every request is the grouping request on the chosen model");
  const firstTrace = parsePortableTrace(JSON.parse(fs.readFileSync(files[0], "utf8")));
  assert.equal(promptText(messages[0].body), groupingPrompt(firstTrace.claim, firstTrace.pages), "the prompt is the live run's grouping prompt on the saved pages");
  const charged = after.spentUsd - before.spentUsd;
  assert.ok(charged > 0 && Math.abs(charged - report.spentUsd) < 1e-4, `the ledger was charged what the passes report ($${charged.toFixed(6)} vs $${report.spentUsd.toFixed(6)})`);
  assert.ok(after.reservedUsd < 1e-9, "no reservation is left behind");
  assert.ok(report.worstTotal >= charged, "the up-front estimate is not below what was spent");

  // Refusals before anything is sent: estimate over what is left, an unpriced model, a dry run.
  captured.length = 0;
  process.env.ECHO_CLAUDE_DAILY_CAP_USD = String(after.providers.claude.spentUsd + report.worstTotal / 4);
  await assert.rejects(regroupTraces({ files, model: "claude-haiku-5-5", runs: 2, log: quiet }), (error) => error.code === "DAILY_BUDGET_REACHED", "a worst case above what is left under Claude's cap refuses to start");
  process.env.ECHO_CLAUDE_DAILY_CAP_USD = "2";
  // A fixed subset, so these refusals do not depend on how many saved traces exist (the cap here is $2).
  const someFiles = files.slice(0, 8);
  await assert.rejects(regroupTraces({ files: someFiles, model: "some-unpriced-model", runs: 1, log: quiet }), (error) => error.code === "BUDGET_MODEL_UNSUPPORTED");
  const dry = await regroupTraces({ files: someFiles, model: "claude-sonnet-5-5", runs: 3, dryRun: true, log: quiet });
  assert.equal(captured.length, 0, "a refused job and a dry run send nothing, not even a token count");

  // The ledger stops a job mid-way (as if another run spent the rest of the day): the first pass is paid, the second
  // is refused by the ledger before its paid request, and nothing after it is sent.
  let calls = 0;
  onModelCall = () => { calls += 1; process.env.ECHO_CLAUDE_DAILY_CAP_USD = "0"; };
  const stoppedJob = await regroupTraces({ files, model: "claude-haiku-5-5", runs: 2, log: quiet });
  onModelCall = null;
  process.env.ECHO_CLAUDE_DAILY_CAP_USD = "2";
  assert.equal(calls, 1, "after the ledger refuses, no further grouping request is sent");
  assert.ok(stoppedJob.stopped && /DAILY_BUDGET_REACHED/.test(stoppedJob.rows[1].error) && stoppedJob.rows.length === 2, "the job stops at the ledger's refusal");
  assert.ok((await getAnthropicBudgetSnapshot()).reservedUsd < 1e-9, "the refused pass leaves no reservation");
  billUsage = false;
  groupingOverride = null;
  const passUsd = report.spentUsd / report.passes;
  process.stdout.write(`  ok  regroup:trace: 1 grouping request per pass (${report.passes} passes over ${files.length} traces), all charged to the ledger (mocked Haiku usage ≈ $${passUsd.toFixed(5)} a pass); refuses up front when the worst case ($${report.worstTotal.toFixed(4)} for 2 Haiku runs, $${dry.worstTotal.toFixed(3)} for 3 Sonnet runs) exceeds what is left; a ledger stop ends the job\n`);
}

{
  // ab:cost (scripts/ab-cost.mjs): the deferred cost experiments as A/Bs. Proves with mocked providers and this
  // script's throwaway ledger that a dry run (the default) sends nothing and charges nothing, that --run sends exactly
  // each experiment's requests, every one reserved and settled, that the worst case covers what is spent and
  // refuses up front when it does not fit, that a ledger stop ends the job, and that each verdict follows its rule.
  const { abCost, verdictFor, LIVE_PROMPT_BOUNDS, PASS_CRITERIA, JUDGE_MAX_TOKENS, EXPERIMENTS } = await import(pathToFileURL(path.join(root, "scripts/ab-cost.mjs")).href);
  const { getAnthropicBudgetSnapshot } = load(path.join(root, "src/lib/echo/daily-budget.ts"));
  const { generateQueries } = load(path.join(root, "src/lib/echo/pipeline.ts"));
  const { parseLabelSheet, scoreTrace } = load(path.join(root, "src/lib/echo/evaluation.ts"));
  const quiet = () => {};
  const at = (file) => path.join(root, file);
  const traceAt = (file) => parsePortableTrace(JSON.parse(fs.readFileSync(at(file), "utf8")));
  const ledger = async () => { const snapshot = await getAnthropicBudgetSnapshot(); return { spent: snapshot.spentUsd, reserved: snapshot.reservedUsd }; };
  const near = (a, b, tolerance = 2e-5) => Math.abs(a - b) <= tolerance;
  const count = (endpoint) => captured.filter((entry) => entry.endpoint === endpoint).length;
  // The mocked providers answer from `current`: point it at each pass's trace (saved ids for rejudge and regroup,
  // page-N for a live run).
  const serve = () => ({ target }) => { current = { analysis: target.analysis, idMap: new Map(target.analysis.pages.map((page) => [page.id, page.id])) }; };
  setCaps(5); // the throwaway ledger only; every refusal below sets its own cap

  // A live run's worst case is bounded by LIVE_PROMPT_BOUNDS: every saved trace's replayed requests fit under them.
  for (const row of rows) {
    assert.ok(row.pages <= LIVE_PROMPT_BOUNDS.maxPages, `${row.name}: at most 20 pages`);
    for (const [name, bound, schema] of [["cluster", LIVE_PROMPT_BOUNDS.groupingChars, LIVE_PROMPT_BOUNDS.schemaChars.grouping], ["judge", LIVE_PROMPT_BOUNDS.judgeChars, LIVE_PROMPT_BOUNDS.schemaChars.judgment], ["answer", LIVE_PROMPT_BOUNDS.answerChars, LIVE_PROMPT_BOUNDS.schemaChars.answer]]) {
      const call = row.calls[name];
      if (!call) continue;
      assert.ok(call.total <= bound && call.schemaChars <= schema, `${row.name}: the ${name} request (${call.total} + ${call.schemaChars} chars) fits ab:cost's live bound`);
      assert.ok(call.total <= 0.7 * bound, `${row.name}: the ${name} request uses under 70% of the bound, so the bound keeps a margin`);
    }
  }

  // Dry runs (the default) of every experiment with its default targets: a plan and a worst case, nothing sent.
  captured.length = 0;
  const before = await ledger();
  const dry = {};
  for (const experiment of EXPERIMENTS) dry[experiment] = await abCost({ experiment, log: quiet });
  assert.equal(captured.length, 0, "a dry run sends nothing to any provider, not even a token count");
  assert.deepEqual(await ledger(), before, "a dry run charges and reserves nothing");
  assert.ok(EXPERIMENTS.every((experiment) => dry[experiment].dryRun && dry[experiment].worstTotal > 0 && dry[experiment].criteria === PASS_CRITERIA[experiment]), "each dry run prints its worst case and pass rule");
  assert.deepEqual([dry.thinking.passes, dry["haiku-grouping"].passes, dry["raw-content"].passes, dry["deep-search"].passes], [2 * 4, 2 * savedTraceCount, 2, 2], "default targets: 4 labeled demo traces, every saved trace, one claim");
  await assert.rejects(abCost({ experiment: "nonsense", log: quiet }), (error) => error.code === "USAGE");
  // The deep-search plan reads, for free, what the advanced pass found on the saved runs of its claim.
  const savedOrigins = dry["deep-search"].savedEvidence.filter((entry) => entry.origins > 0);
  assert.ok(savedOrigins.some((entry) => entry.run.endsWith("2026-11-13-run1") && entry.pages.some((page) => page.domain === "asurion.com" && page.kind === "origin")), "the plan shows that the 11/13 phones run 1 found asurion.com only through the advanced pass");

  // thinking --run: 2 traces x 2 runs = 8 judge requests (4 per arm), arms alternating, only B carries thinking off.
  const thinkingFiles = ["public/demo-traces/goldfish-3-second-memory.echo.json", "public/demo-traces/americans-check-phones-96-times.echo.json"].map(at);
  billUsage = true;
  captured.length = 0;
  let start = await ledger();
  const thinking = await abCost({ experiment: "thinking", files: thinkingFiles, runs: 2, run: true, log: quiet, beforePass: serve() });
  let end = await ledger();
  let messages = captured.filter((entry) => entry.endpoint === "messages").map((entry) => entry.body);
  assert.equal(messages.length, 8, "one judge request per pass");
  assert.equal(count("count_tokens"), 8, "one free token count per pass");
  assert.equal(count("tavily search") + count("tavily extract"), 0, "no search credits");
  assert.ok(messages.every((body) => promptText(body).startsWith("You are a cautious") && body.max_tokens === JUDGE_MAX_TOKENS), "every request is the judge request");
  assert.deepEqual(thinking.rows.map((row) => row.arm), ["A", "B", "A", "B", "B", "A", "B", "A"], "arms alternate, B first on even runs");
  thinking.rows.forEach((row, index) => assert.deepEqual(messages[index].thinking, row.arm === "B" ? { type: "between_tools" } : undefined, "only arm B turns the judge's thinking off"));
  assert.ok(near(end.spent - start.spent, thinking.spentUsd) && end.reserved < 1e-9, `every judge request was reserved and settled ($${(end.spent - start.spent).toFixed(6)} charged, $${thinking.spentUsd.toFixed(6)} reported)`);
  assert.ok(thinking.worstTotal >= thinking.spentUsd, "the worst case covers what was spent");
  // The mocked judge answers with the saved judgments, which then pass today's post-judge guards (an origin rated 50
  // or below stays unresolved since 11/13: goldfish's scienceabc.com, 50), so the saved run is scored the same way.
  const { unsureOriginsUnclear } = load(path.join(root, "src/lib/echo/pipeline.ts"));
  const goldfish = traceAt("public/demo-traces/goldfish-3-second-memory.echo.json");
  const savedScore = scoreTrace({ ...goldfish, pages: unsureOriginsUnclear(goldfish.pages) }, parseLabelSheet(JSON.parse(fs.readFileSync(at("evaluation/goldfish-3-second-memory.labels.json"), "utf8"))));
  assert.equal(thinking.rows[0].match, savedScore.exactKinds, "a pass is scored with eval:trace against the label sheet");
  assert.equal(thinking.verdict.verdict, "NO GAIN", "the same judgments at the same mocked cost: quality kept, nothing saved");

  // raw-content --run on one claim (live runs): A extracts, B asks searches for page text and extracts nothing.
  process.env.ECHO_TAVILY_USD_PER_CREDIT = "0.008"; // so Tavily credits are reserved and settled in the ledger too
  const goldfishFile = at("public/demo-traces/goldfish-3-second-memory.echo.json");
  const goldfishTrace = traceAt("public/demo-traces/goldfish-3-second-memory.echo.json");
  const queryCount = generateQueries(goldfishTrace.claim).length;
  captured.length = 0;
  start = await ledger();
  const raw = await abCost({ experiment: "raw-content", files: [goldfishFile], run: true, log: quiet, beforePass: () => { current = { analysis: goldfishTrace, idMap: new Map(goldfishTrace.pages.map((page, index) => [page.id, `page-${index + 1}`])) }; } });
  end = await ledger();
  const searches = captured.filter((entry) => entry.endpoint === "tavily search").map((entry) => entry.body);
  const [rawA, rawB] = raw.rows;
  assert.equal(searches.length, 2 * (queryCount + 3), "each arm: every query (basic) plus the 3-query advanced pass (14 pages < 20)");
  assert.ok(searches.slice(0, queryCount + 3).every((body) => body.include_raw_content === false) && searches.slice(queryCount + 3).every((body) => body.include_raw_content === "markdown"), "only arm B asks for page text");
  assert.deepEqual([rawA.extractRequests, rawB.extractRequests, count("tavily extract")], [2, 0, 2], "A extracts in 2 batches, B not at all");
  assert.equal(count("messages"), rawA.requests + rawB.requests, "every Claude request is on a receipt");
  assert.equal(count("count_tokens"), count("messages"), "one free token count per Claude request");
  assert.ok(near(end.spent - start.spent, raw.spentUsd) && end.reserved < 1e-9, `searches, extracts and Claude requests were reserved and settled ($${(end.spent - start.spent).toFixed(6)} charged, $${raw.spentUsd.toFixed(6)} reported)`);
  assert.ok(raw.rows.every((row) => row.usd <= raw.worstTotal / 2), "each live run costs less than its bounded worst case");
  assert.equal(raw.verdict.verdict, "PASS", `3 extract credits saved, searches billed 1 each, same judgments (${raw.verdict.reason})`);
  // If a search with page text billed 2 credits, the rule fails it.
  rawSearchCredits = 2;
  const rawBilled = await abCost({ experiment: "raw-content", files: [goldfishFile], run: true, log: quiet, beforePass: () => { current = { analysis: goldfishTrace, idMap: new Map(goldfishTrace.pages.map((page, index) => [page.id, `page-${index + 1}`])) }; } });
  rawSearchCredits = 1;
  assert.equal(rawBilled.verdict.verdict, "FAIL", "searches billed extra for page text fail the raw-content rule");

  // haiku-grouping --run: Sonnet (the noise floor) and Haiku regroup each trace once, interleaved.
  const groupFiles = ["public/demo-traces/goldfish-3-second-memory.echo.json", "public/demo-traces/humans-use-10-percent-of-brain.echo.json", "evaluation/runs/vikings-wore-horned-helmets.2026-11-12-run1.echo.json"].map(at);
  groupingOverride = () => current.analysis.clusters.map((cluster) => ({ label: cluster.label, pageIds: [...cluster.pageIds], matchesClaim: true }));
  captured.length = 0;
  start = await ledger();
  const grouping = await abCost({ experiment: "haiku-grouping", files: groupFiles, run: true, log: quiet, beforePass: serve() });
  end = await ledger();
  groupingOverride = null;
  messages = captured.filter((entry) => entry.endpoint === "messages").map((entry) => entry.body);
  assert.deepEqual(messages.map((body) => body.model), ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], "one grouping request per arm per trace, interleaved");
  assert.ok(messages.every((body) => promptText(body).startsWith("Group these") && body.max_tokens === 1800) && count("count_tokens") === 6 && count("tavily search") === 0, "only grouping requests and their free token counts");
  assert.ok(near(end.spent - start.spent, grouping.spentUsd) && end.reserved < 1e-9, "every grouping request was reserved and settled");
  assert.ok(grouping.rows.every((row) => Number.isFinite(row.stageMs.grouping)), "each pass has its grouping time");
  assert.equal(grouping.verdict.verdict, "PASS", `the saved grouping answered back by both models, Haiku cheaper (${grouping.verdict.reason})`);

  // deep-search --run on a thin claim (12 pages): A runs the advanced pass, B (=0) skips it.
  const thinFile = at("evaluation/runs/americans-check-phones-96-times.2026-11-11-rerun.echo.json");
  const thinTrace = traceAt("evaluation/runs/americans-check-phones-96-times.2026-11-11-rerun.echo.json");
  const thinQueries = generateQueries(thinTrace.claim).length;
  const serveThin = () => { current = { analysis: thinTrace, idMap: new Map(thinTrace.pages.map((page, index) => [page.id, `page-${index + 1}`])) }; };
  captured.length = 0;
  start = await ledger();
  const deep = await abCost({ experiment: "deep-search", files: [thinFile], run: true, log: quiet, beforePass: serveThin });
  end = await ledger();
  assert.deepEqual(deep.rows.map((row) => [row.arm, row.basicSearches, row.advancedSearches]), [["A", thinQueries, 3], ["B", thinQueries, 0]], "A searches the advanced pass, B skips it");
  assert.equal(count("tavily search"), 2 * thinQueries + 3, "exactly those searches were sent");
  assert.ok(near(end.spent - start.spent, deep.spentUsd) && end.reserved < 1e-9, "every request was reserved and settled");
  assert.equal(deep.verdict.verdict, "PASS", `the mocked advanced pass adds no new page (${deep.verdict.reason})`);
  // --control: a saved live run is arm A, so only arm B spends.
  const controlFile = at("evaluation/runs/americans-check-phones-96-times.2026-11-13-run3.echo.json");
  const controlTrace = traceAt("evaluation/runs/americans-check-phones-96-times.2026-11-13-run3.echo.json");
  captured.length = 0;
  const controlled = await abCost({ experiment: "deep-search", files: [controlFile], controlFile, run: true, log: quiet, beforePass: () => { current = { analysis: controlTrace, idMap: new Map(controlTrace.pages.map((page, index) => [page.id, `page-${index + 1}`])) }; } });
  assert.deepEqual(controlled.rows.map((row) => [row.arm, Boolean(row.fromControl)]), [["A", true], ["B", false]], "the saved run is arm A; one live run (B) is made");
  assert.equal(count("tavily search"), generateQueries(controlTrace.claim).length, "only B's basic searches are sent");
  assert.ok(controlled.rows[0].advanced.ran && controlled.rows[0].advanced.pages.length === 3, "A's advanced contribution is read from the saved run's search audit");
  await assert.rejects(abCost({ experiment: "deep-search", claims: ["Goldfish have a 3-second memory"], controlFile, log: quiet }), (error) => error.code === "USAGE", "a control of another claim is refused");
  await assert.rejects(abCost({ experiment: "thinking", controlFile, log: quiet }), (error) => error.code === "USAGE", "--control is only for live experiments");

  // Refusals before anything is sent: a worst case above what is left, in a dry run and with --run.
  captured.length = 0;
  const left = await getAnthropicBudgetSnapshot();
  process.env.ECHO_CLAUDE_DAILY_CAP_USD = String(left.providers.claude.spentUsd + dry.thinking.worstTotal / 2);
  await assert.rejects(abCost({ experiment: "thinking", run: true, log: quiet }), (error) => error.code === "DAILY_BUDGET_REACHED", "a worst case above what is left under Claude's cap refuses to start");
  await assert.rejects(abCost({ experiment: "thinking", log: quiet }), (error) => error.code === "DAILY_BUDGET_REACHED", "the dry run says so too");
  assert.equal(captured.length, 0, "a refused job sends nothing");
  // A live experiment needs room under Tavily's cap too.
  process.env.ECHO_CLAUDE_DAILY_CAP_USD = "5";
  process.env.ECHO_TAVILY_DAILY_CAP_USD = String(left.providers.tavily.spentUsd + dry["raw-content"].worstTotal / 4);
  await assert.rejects(abCost({ experiment: "raw-content", log: quiet }), (error) => error.code === "DAILY_BUDGET_REACHED", "a live experiment refuses to start when Tavily's cap cannot cover its worst case");
  setCaps(5);
  // A ledger stop mid-job (as if another run spent the rest of the day): the first pass is paid, the second refused
  // by the ledger before its request, and nothing after it is sent.
  let paid = 0;
  onModelCall = () => { paid += 1; process.env.ECHO_CLAUDE_DAILY_CAP_USD = "0"; };
  const stopped = await abCost({ experiment: "thinking", files: thinkingFiles, runs: 2, run: true, log: quiet, beforePass: serve() });
  onModelCall = null;
  process.env.ECHO_CLAUDE_DAILY_CAP_USD = "5";
  assert.equal(paid, 1, "after the ledger refuses, no further request is sent");
  assert.ok(stopped.stopped && stopped.rows.length === 2 && /DAILY_BUDGET_REACHED/.test(stopped.rows[1].error), "the job stops at the ledger's refusal");
  assert.ok((await getAnthropicBudgetSnapshot()).reservedUsd < 1e-9, "the refused pass leaves no reservation");
  billUsage = false;
  setCaps(2);
  process.env.ECHO_TAVILY_USD_PER_CREDIT = "0";

  // Each verdict follows its rule.
  const arm = (fields) => ({ passes: 2, labeled: true, match: 10, matched: 14, wrong: 1, unclear: 2, exactParents: 2, derivedGold: 4, origins: 3, claudeUsd: 0.06, credits: 18, usd: 0.2, stageMs: { search: 7000, extract: 3000, grouping: 6000, judgment: 14000, answer: 3000, total: 33000 }, moved: 1, splitPairs: 2, brokenLinks: 0.5, excludedRootIds: [], advancedRan: true, advancedOrigins: 0, advancedPages: [], searchOverbilled: false, ...fields });
  const rule = (experiment, a, b) => verdictFor(experiment, { A: arm(a), B: arm(b) }).verdict;
  assert.equal(rule("thinking", {}, { claudeUsd: 0.045, stageMs: { judgment: 9000 } }), "PASS");
  assert.equal(rule("thinking", {}, { claudeUsd: 0.045, wrong: 1.5 }), "FAIL", "one more wrong call fails thinking off");
  assert.equal(rule("thinking", {}, { claudeUsd: 0.055, stageMs: { judgment: 13000 } }), "NO GAIN", "under 15% saved is no gain");
  assert.equal(rule("raw-content", {}, { credits: 15, stageMs: { extract: 0 } }), "PASS");
  assert.equal(rule("raw-content", {}, { credits: 17 }), "NO GAIN");
  assert.equal(rule("raw-content", {}, { credits: 15, origins: 1 }), "FAIL", "two origins fewer fails raw content");
  assert.equal(rule("haiku-grouping", { usd: 0.012 }, { usd: 0.0006, moved: 1.8 }), "PASS", "within the noise floor + 1");
  assert.equal(rule("haiku-grouping", { usd: 0.012 }, { usd: 0.0006, moved: 2.5 }), "FAIL");
  assert.equal(rule("haiku-grouping", { usd: 0.012 }, { usd: 0.0006, excludedRootIds: ["x:page-3"] }), "FAIL", "a root Sonnet keeps but Haiku excludes fails");
  assert.equal(rule("deep-search", {}, { credits: 12 }), "PASS");
  assert.equal(rule("deep-search", { advancedOrigins: 1, advancedPages: [{ domain: "asurion.com", kind: "origin", label: null }] }, { origins: 2 }), "FAIL", "an origin only the advanced pass found fails (the 11/13 asurion case)");
  assert.equal(rule("deep-search", { advancedRan: false }, {}), "INCONCLUSIVE");
  assert.equal(verdictFor("thinking", { A: arm({}), B: arm({ passes: 0 }) }).verdict, "INCONCLUSIVE");
  process.stdout.write(`  ok  ab:cost: dry runs of all 4 experiments send nothing (worst cases: thinking $${dry.thinking.worstTotal.toFixed(3)}, raw-content $${dry["raw-content"].worstTotal.toFixed(3)}, haiku-grouping $${dry["haiku-grouping"].worstTotal.toFixed(3)}, deep-search $${dry["deep-search"].worstTotal.toFixed(3)} on default targets); --run sends exactly each experiment's requests, all reserved and settled; refuses over the cap; a ledger stop ends the job; verdicts follow their rules\n`);
}

if (details) {
  process.stdout.write("\nPer-request anatomy (characters):\n");
  for (const row of rows) process.stdout.write(`${row.name}: ${JSON.stringify(row.calls)}\n`);
}
fs.rmSync(scratch, { recursive: true, force: true });
