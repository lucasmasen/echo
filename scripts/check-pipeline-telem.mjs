// Telem as Echo's search router (src/lib/echo/telem.ts, pipeline.ts telemSearch): offline checks against a mocked
// https://router.telem.ai/v1/search shaped like Telem's API reference (Search: routing[].providers,
// preprocessor_runs[].preprocessor_name / output_payload.results[] / error). No provider is reached: every request
// goes to the mock below, the ledger is a scratch file in a throwaway folder, and the keys are fake.
// Run by check:pipeline (in its own process, so it shares none of that script's mocks or ledger); also runs alone.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "echo-telem-check-"));
process.chdir(scratch);
load.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(code, filename);
};

const TELEM_KEY = "tlm_local_test_key_0001";
Object.assign(process.env, {
  ANTHROPIC_API_KEY: "local-test-key",
  TAVILY_API_KEY: "local-test-key",
  TELEM_API_KEY: TELEM_KEY,
  ANTHROPIC_MODEL: "claude-sonnet-5-5",
  ANTHROPIC_CLASSIFIER_MODEL: "claude-sonnet-5-5",
  ANTHROPIC_ANSWER_MODEL: "claude-sonnet-5-5",
  ECHO_CLAUDE_DAILY_CAP_USD: "2",
  ECHO_TAVILY_DAILY_CAP_USD: "2",
  ECHO_TELEM_DAILY_CAP_USD: "2",
  ECHO_TAVILY_USD_PER_CREDIT: "0.008",
  ECHO_TAVILY_RETRY_DELAY_MS: "1",
  ECHO_CLAUDE_RETRY_DELAY_MS: "1",
  ECHO_SEARCH_CACHE: "0",
  ECHO_HTML_LINKS: "0",
});
for (const key of ["ECHO_SEARCH_ROUTER", "ECHO_DEEP_SEARCH_BELOW", "VERCEL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "ECHO_SEARCH_RAW_CONTENT", "ECHO_ANTHROPIC_DAILY_CAP_USD", "ECHO_DAILY_CAP_OVERRIDE_USD", "ECHO_TELEM_CREDIT_USD"]) delete process.env[key];

const echoLib = path.join(projectRoot, "src", "lib", "echo");
const telem = load(path.join(echoLib, "telem.ts"));
const pipeline = load(path.join(echoLib, "pipeline.ts"));
const budget = load(path.join(echoLib, "daily-budget.ts"));
const { makePortableTrace, parsePortableTrace } = load(path.join(echoLib, "portable.ts"));
const { canonicalUrl } = load(path.join(echoLib, "url.ts"));

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const CLAIM = "90% of startups fail";
const say = (line) => process.stdout.write(`  ok  ${line}\n`);

// --- The mock ----------------------------------------------------------------------------------------------------
let mode = "routed";
const sent = { telem: [], tavilySearch: 0, extract: 0, extractedUrls: 0, claude: 0, other: 0 };
let onTelem = null; // (body) => void, called as each Telem request is sent
const resetSent = () => { sent.telem = []; sent.tavilySearch = 0; sent.extract = 0; sent.extractedUrls = 0; sent.claude = 0; sent.other = 0; };
const page = (host, index) => `https://${host}.example/startups-${index}`;
const row = (url, rank, extra = {}) => ({ rank, url, title: `90% of startups fail, report ${url.slice(8, 30)}`, summary: "90% of startups fail, this report says.", ...extra });
/** A Telem response: providers is [[name, rows] or [name, "failed"]], routing the providers Telem says it chose. */
const telemResponse = (routing, runs) => json({
  status: runs.some(([, rows]) => rows === "failed") ? "partially_succeeded" : "succeeded",
  routing: routing === null ? null : [{ providers: routing }],
  preprocessor_runs: runs.map(([name, rows, extra = {}]) => rows === "failed"
    ? { preprocessor_name: name, status: "failed", error: { message: "upstream timeout" }, output_payload: null }
    : { preprocessor_name: name, status: "succeeded", error: null, output_payload: { tier: "default", results: rows, latency_ms: 500, warnings: [], ...extra } }),
  session_id: "00000000-0000-4000-8000-000000000000",
  interaction_id: "00000000-0000-4000-8000-000000000001",
  normalized_schema_version: 2,
  pinned_providers: ["exa", "tavily", "brave", "parallel", "perplexity"],
});

let currentClaim = CLAIM;
/** index: the query's place in the run's plan (its role below); unique: a number no other request in the run has. */
function telemReply(body, index, unique = index) {
  if (mode === "401") return json({ detail: "Invalid API key" }, 401);
  if (mode === "402") return json({ detail: "Prepaid credit is used up" }, 402);
  if (mode === "429") return json({ detail: "Rate limit exceeded (60 requests/minute for this key)" }, 429, { "retry-after": "42" });
  if (mode === "one-503" && index === 1) return json({ detail: { code: "all_providers_failed", reason: "provider_errors" } }, 503);
  if (mode === "many") {
    // Ten distinct pages per provider per query: the basic search stops after its first five queries.
    return telemResponse(["exa", "brave"], [
      ["exa", Array.from({ length: 10 }, (_, rank) => row(page(`exa${unique}`, rank), rank + 1))],
      ["brave", Array.from({ length: 10 }, (_, rank) => row(page(`brave${unique}`, rank), rank + 1))],
    ]);
  }
  if (mode === "few") {
    // Two pages per query and the same two every time: the deeper pass (tier extended) runs too.
    return telemResponse(["exa", "brave"], [["exa", [row(page("few", 1), 1)]], ["brave", [row(page("few", 2), 1)]]]);
  }
  // "routed" (and "one-503"): the plain search (the claim as typed) goes to Exa, Tavily and Brave, Brave failing on
  // the second query; every query shares one page (shared.example) that two providers return, so it is one page.
  const shared = "https://shared.example/startups-study";
  if (index === 0) {
    return telemResponse(["exa", "tavily", "brave"], [
      ["exa", [row(shared, 1), row(page("exa-first", 1), 2), row(`${shared}?utm_source=x`, 3)], { usage: { total: 0.0071 } }],
      ["tavily", [row(page("tavily-first", 1), 1), row(shared, 2)]],
      ["brave", [row(page("brave-first", 1), 1), row(shared, 2)]],
    ]);
  }
  if (index === 1) return telemResponse(["brave", "exa"], [["brave", "failed"], ["exa", [row(page(`exa-q${index}`, 1), 1), row(shared, 2)]]]);
  // No routing block: the providers are read from the runs.
  return telemResponse(index === 2 ? null : ["perplexity", "parallel"], [["perplexity", [row(page(`perplexity-q${index}`, 1), 1)]], ["parallel", [row(page(`parallel-q${index}`, 1), 1), row(shared, 2)]]]);
}

global.fetch = async (url, options = {}) => {
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("aborted", "AbortError");
  const endpoint = String(url);
  if (endpoint === "https://router.telem.ai/v1/search") {
    const body = JSON.parse(options.body);
    const unique = sent.telem.length;
    sent.telem.push({ body, auth: options.headers?.authorization });
    await onTelem?.(body);
    if (mode === "500") return json({ detail: "Internal Server Error" }, 500);
    if (mode === "drop") throw new TypeError("fetch failed");
    // The batch's searches are sent concurrently, so a query's role comes from its place in the plan, not send order.
    return telemReply(body, Math.max(0, pipeline.generateQueries(currentClaim).indexOf(body.user_input.query)), unique);
  }
  if (endpoint === "https://api.tavily.com/search") {
    sent.tavilySearch += 1;
    return json({ results: [
      { url: page("tavily-direct", 1), title: "90% of startups fail, says a report", content: "90% of startups fail.", score: 0.9 },
      { url: page("tavily-direct", 2), title: "90% of startups fail, another report", content: "90% of startups fail.", score: 0.8 },
    ], usage: { credits: 1 } });
  }
  if (endpoint === "https://api.tavily.com/extract") {
    const batch = JSON.parse(options.body).urls;
    sent.extract += 1;
    sent.extractedUrls += batch.length;
    return json({ results: batch.map((pageUrl) => ({ url: pageUrl, raw_content: `Published: 2021-01-01. 90% of startups fail, says ${pageUrl}.` })), usage: { credits: 1 } });
  }
  if (endpoint.endsWith("/count_tokens")) return json({ input_tokens: 100 });
  if (endpoint.endsWith("/messages")) {
    sent.claude += 1;
    const prompt = JSON.parse(options.body).messages[0].content;
    const ids = [...new Set([...String(prompt).matchAll(/"(?:id|pageId)":"(page-\d+)"/g)].map((match) => match[1]))];
    if (prompt.startsWith("Group these")) return json({ content: [{ type: "text", text: JSON.stringify({ clusters: [{ label: "Startup failure claim", pageIds: ids, matchesClaim: true }] }) }], usage: { input_tokens: 100, output_tokens: 50 } });
    if (prompt.startsWith("You are a cautious")) return json({ content: [{ type: "text", text: JSON.stringify({ judgements: ids.map((id) => ({ pageId: id, kind: "origin", parentId: null, confidence: 70, evidence: "Its own report.", hasPrimaryEvidence: true, primaryEvidenceReason: "Reports the figure.", originBasis: "firsthand" })) }) }], usage: { input_tokens: 100, output_tokens: 50 } });
    if (prompt.startsWith("Answer the")) return json({ content: [{ type: "text", text: JSON.stringify({ claims: [{ text: "The reports say so", sourceNumbers: [1] }] }) }], usage: { input_tokens: 100, output_tokens: 50 } });
    throw new Error("unexpected model prompt");
  }
  sent.other += 1;
  return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
};

const ledger = () => budget.getAnthropicBudgetSnapshot();
const freshLedger = () => fs.rmSync(path.join(scratch, ".echo"), { recursive: true, force: true });
let progressEvents = [];
const run = (claim, options = {}) => {
  currentClaim = claim;
  progressEvents = [];
  return pipeline.analyzeClaim(claim, (event) => progressEvents.push(event), { forceFresh: true, ...options });
};
const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

try {
  // 1. Pure parts: the reservation is the most the allowed providers could cost; the router choice follows the env.
  {
    assert.deepEqual([...telem.TELEM_PROVIDERS], ["exa", "tavily", "brave", "parallel", "perplexity"]);
    assert.equal(telem.telemReserveUsd("default"), 0.031, "a default-tier search reserves every allowed provider at list price ($0.031)");
    assert.equal(telem.telemReserveUsd("extended"), 0.04, "an extended-tier search reserves $0.040 (tavily and parallel cost more there)");
    assert.equal(telem.searchRouter(), "telem", "TELEM_API_KEY set: Telem routes the search");
    process.env.ECHO_SEARCH_ROUTER = "tavily";
    assert.equal(telem.searchRouter(), "tavily", "ECHO_SEARCH_ROUTER=tavily forces Tavily even with a Telem key");
    delete process.env.ECHO_SEARCH_ROUTER;
    const saved = process.env.TELEM_API_KEY;
    delete process.env.TELEM_API_KEY;
    assert.equal(telem.searchRouter(), "tavily", "no TELEM_API_KEY: Tavily, as before");
    process.env.ECHO_SEARCH_ROUTER = "telem";
    assert.equal(telem.searchRouter(), "telem", "ECHO_SEARCH_ROUTER=telem asks for Telem even without a key (and then fails plainly)");
    delete process.env.ECHO_SEARCH_ROUTER;
    process.env.TELEM_API_KEY = saved;
    assert.match(telem.telemKeyProblem(undefined), /TELEM_API_KEY/);
    assert.match(telem.telemKeyProblem("sk-not-telem"), /TELEM_API_KEY.*tlm_/);
    assert.equal(telem.telemKeyProblem(TELEM_KEY), null);
    // Parsing: merged across providers by canonical URL, interleaved by rank, failed runs free and left out.
    const parsed = telem.parseTelemSearch(await telemReply({ user_input: { query: CLAIM } }, 0).json(), "default", 10, canonicalUrl);
    assert.deepEqual(parsed.providers, ["exa", "tavily", "brave"], "the providers that answered, in routing order");
    const shared = parsed.hits.filter((hit) => hit.url.startsWith("https://shared.example/"));
    assert.equal(shared.length, 1, "the page three providers returned (once with a tracking parameter) is one hit");
    assert.deepEqual(shared[0].providers, ["exa", "tavily", "brave"], "the merged hit names every provider that returned it");
    assert.ok(shared[0].score > parsed.hits.find((hit) => hit.providers.length === 1).score, "a page several providers return ranks above one only one returned");
    assert.deepEqual(parsed.hits.slice(0, 3).map((hit) => hit.providers[0]), ["exa", "tavily", "brave"], "hits are interleaved by rank across providers");
    assert.ok(near(parsed.usd, 0.0071 + 0.005 + 0.005), `Exa's own reported cost is used, the others at list price ($${parsed.usd})`);
    const failedRun = telem.parseTelemSearch(await telemReply({ user_input: { query: "x" } }, 1).json(), "default", 10, canonicalUrl);
    assert.deepEqual(failedRun.providers, ["exa"], "a failed provider run is not counted as answering");
    assert.deepEqual(failedRun.failed, ["brave"]);
    assert.ok(near(failedRun.usd, 0.015), "a failed provider run is free");
    const noRouting = telem.parseTelemSearch(await telemReply({ user_input: { query: "x" } }, 2).json(), "default", 10, canonicalUrl);
    assert.deepEqual(noRouting.routed, ["perplexity", "parallel"], "without a routing block, the providers come from the runs");
    say(`Telem pure parts: reserve $${telem.telemReserveUsd("default")} default / $${telem.telemReserveUsd("extended")} extended; router from env; results merged across providers; failed runs free`);
  }

  // 2. A whole run through Telem: request shape, routed providers recorded per query and per page, results deduped,
  //    page reading still on Tavily, the receipt and the ledger agree, and the trace round-trips.
  {
    freshLedger();
    resetSent();
    mode = "routed";
    const reservedAtSend = [];
    onTelem = async () => { reservedAtSend.push((await ledger()).reservedUsd); };
    // The basic plan only (the deeper pass has its own check below).
    process.env.ECHO_DEEP_SEARCH_BELOW = "0";
    const result = await run(CLAIM);
    delete process.env.ECHO_DEEP_SEARCH_BELOW;
    onTelem = null;
    assert.equal(sent.tavilySearch, 0, "no Tavily search is sent when Telem routes the search");
    assert.ok(sent.extract > 0, "page reading stays on Tavily extract");
    assert.ok(sent.telem.length >= 6, `the plan's variants go through Telem (${sent.telem.length})`);
    const first = sent.telem[0];
    assert.equal(first.auth, `Bearer ${TELEM_KEY}`, "the key is sent as a bearer token");
    assert.deepEqual(first.body.search, { auto_routing: "accuracy", providers: { include: ["exa", "tavily", "brave", "parallel", "perplexity"] }, num_results: 10, tier: "default" }, "auto-routing on, chosen from the priced providers, 10 results per provider, default tier");
    assert.equal(typeof first.body.user_input.query, "string");
    assert.equal(new Set(sent.telem.map((request) => `${request.body.search.tier}|${request.body.user_input.query}`)).size, sent.telem.length, "each variant is sent once per pass (no retries)");
    assert.ok(reservedAtSend.every((reserved) => reserved >= 0.031 - 1e-9), "each Telem request is reserved on the ledger before it is sent");
    const audit = result.searchAudit;
    assert.ok(audit.every((entry) => entry.router === "telem"), "every audit entry names the router");
    assert.deepEqual(audit[0].providers, ["exa", "tavily", "brave"], "the plain search records the providers it was routed to");
    assert.deepEqual(audit[1].providers, ["exa"], "a provider whose run failed is not recorded as answering");
    assert.deepEqual(audit[2].providers, ["perplexity", "parallel"]);
    const sharedPage = result.pages.find((entry) => entry.url.startsWith("https://shared.example/"));
    assert.ok(sharedPage, "the shared page is in the trace");
    assert.deepEqual(audit[0].pageProviders[sharedPage.id], ["exa", "tavily", "brave"], "per page: the providers that returned it");
    assert.equal(result.pages.filter((entry) => entry.url.startsWith("https://shared.example/")).length, 1, "a page several providers and queries return is one trace page");
    assert.equal(new Set(result.pages.map((entry) => entry.url)).size, result.pages.length, "no page twice");
    const receipt = result.costReceipt;
    const telemSearches = sent.telem.length;
    assert.equal(receipt.telem.searches, telemSearches, "the receipt counts every completed Telem search");
    assert.equal(receipt.telem.advancedSearches, sent.telem.filter((request) => request.body.search.tier === "extended").length);
    assert.equal(receipt.tavily.basicSearches + receipt.tavily.advancedSearches, 0, "no Tavily search on the receipt");
    assert.ok(receipt.tavily.extractRequests > 0 && receipt.tavily.credits === receipt.tavily.extractRequests, "Tavily is billed for page reading only");
    const runs = Object.values(receipt.telem.providerRuns).reduce((sum, count) => sum + count, 0);
    assert.equal(receipt.telem.providerRuns.exa, 2, "Exa answered the first two queries");
    assert.equal(receipt.telem.providerRuns.brave, 1, "Brave answered once (its second run failed, free)");
    assert.ok(runs >= telemSearches, "at least one provider run per search");
    assert.ok(near(receipt.usd.total, receipt.usd.claude + receipt.usd.tavily + receipt.usd.telem, 1e-5), "total = Claude + Tavily + Telem");
    assert.ok(receipt.usd.telem > 0 && receipt.usd.telem <= telemSearches * 0.031 + 1e-9, `Telem dollars are within the reserved worst case ($${receipt.usd.telem})`);
    const after = await ledger();
    assert.ok(near(after.reservedUsd, 0), `no reservation left open (${after.reservedUsd})`);
    assert.ok(near(after.spentUsd, receipt.usd.total, 1e-4), `the ledger spent what the receipt says ($${after.spentUsd} vs $${receipt.usd.total})`);
    const back = parsePortableTrace(JSON.parse(JSON.stringify(makePortableTrace(result))));
    assert.ok(back, "a Telem trace imports");
    assert.deepEqual(back.searchAudit, result.searchAudit, "the routing fields round-trip");
    assert.deepEqual(back.costReceipt, result.costReceipt, "the Telem receipt round-trips");
    // What the screen says (trace-view.ts): the strip's Search cell, the receipt line and the plain-search hover.
    const view = load(path.join(projectRoot, "src", "app", "trace-view.ts"));
    const used = view.searchProvidersUsed(result);
    assert.deepEqual(used, ["perplexity", "parallel", "exa", "tavily", "brave"], `only the providers that answered, most-used first (${used})`);
    const search = view.howEchoChecked(result).steps.find((step) => step.step === "Search");
    assert.equal(search.value, `${result.searchAudit.filter((entry) => entry.status === "searched").length} searches routed by Telem`);
    assert.match(search.detail, /^across Perplexity, Parallel, Exa, Tavily and Brave · \d+ results · \d+ distinct pages found/);
    assert.match(search.note, /routed by Telem/);
    const line = view.costReceiptLine(result);
    assert.match(line, /search \$0\.07 via Telem, page reading \$0\.02\)/, line);
    assert.match(line, new RegExp(`${telemSearches} searches via Telem \\(${runs} provider runs\\) · ${receipt.tavily.credits} extract credits`), line);
    const lineage = view.plainSearchLineage(result);
    assert.equal(view.plainSearchTooltip(lineage), `Plain search is the trace's first search, the claim as typed, routed by Telem to Exa, Tavily and Brave: “${audit[0].query}”`);
    say(`the screen: Search "${search.value} — ${search.detail}"; receipt "${line}"`);
    say(`a run through Telem: ${telemSearches} searches routed (${Object.entries(receipt.telem.providerRuns).map(([name, count]) => `${name} ${count}`).join(", ")}), no Tavily search, ${receipt.tavily.extractRequests} Tavily extracts; routed providers on every audit entry and per page; the shared page deduped across providers; receipt $${receipt.usd.telem} Telem + $${receipt.usd.tavily} Tavily + $${receipt.usd.claude} Claude = ledger spend; trace round-trips`);
  }

  // 3. Early stop still works: ten new pages per provider per query, so the basic search stops after its first five.
  {
    freshLedger();
    resetSent();
    mode = "many";
    const result = await run(`${CLAIM} early stop`);
    assert.equal(sent.telem.length, 5, `only the first five variants are sent (${sent.telem.length})`);
    const skipped = result.searchAudit.filter((entry) => entry.status === "not searched");
    assert.ok(skipped.length > 0 && skipped.every((entry) => entry.router === "telem" && entry.providers === undefined), "the rest are recorded as not searched, with no providers");
    assert.equal(result.costReceipt.telem.searches, 5);
    say(`early stop: 5 Telem searches, ${skipped.length} variants not run`);
  }

  // 4. The deeper pass (few pages found) goes through Telem at the extended tier, 8 results per provider.
  {
    freshLedger();
    resetSent();
    mode = "few";
    const result = await run(`${CLAIM} few pages`);
    const deep = sent.telem.filter((request) => request.body.search.tier === "extended");
    assert.equal(deep.length, 3, "three deeper searches");
    assert.ok(deep.every((request) => request.body.search.num_results === 8), "8 results per provider on the deeper pass");
    assert.equal(result.costReceipt.telem.advancedSearches, 3);
    assert.ok(result.searchAudit.filter((entry) => entry.depth === "advanced").every((entry) => entry.router === "telem"));
    say("the deeper pass goes through Telem too (extended tier, 8 results, counted as advanced on the receipt)");
  }

  // 5. Plain errors, never retried, nothing left reserved: 401, 402 and 429 stop the run; one 503 marks one query failed.
  for (const [failMode, code, pattern] of [
    ["401", "TELEM_AUTH", /Telem rejected the API key \(401\).*TELEM_API_KEY.*ECHO_SEARCH_ROUTER=tavily/],
    ["402", "TELEM_CREDIT", /Telem's prepaid credit ran out.*ECHO_SEARCH_ROUTER=tavily/],
    ["429", "TELEM_RATE_LIMIT", /rate-limiting this key for the next 42 s.*does not retry/],
  ]) {
    freshLedger();
    resetSent();
    mode = failMode;
    const failure = await run(`${CLAIM} ${failMode}`).then(() => null, (error) => error);
    assert.ok(failure && failure.code === code, `a ${failMode} stops the run with ${code} (${failure?.code}: ${failure?.message})`);
    assert.match(failure.message, pattern);
    assert.ok(sent.telem.length <= 5, `a ${failMode} sends at most the first batch (${sent.telem.length})`);
    assert.equal(new Set(sent.telem.map((request) => request.body.user_input.query)).size, sent.telem.length, `a ${failMode} is not retried`);
    assert.equal(sent.claude, 0, `no Claude request after a ${failMode}`);
    const after = await ledger();
    assert.ok(near(after.reservedUsd, 0) && near(after.spentUsd, 0), `a ${failMode} leaves nothing reserved or spent (reserved ${after.reservedUsd}, spent ${after.spentUsd})`);
  }
  {
    freshLedger();
    resetSent();
    mode = "one-503";
    const result = await run(`${CLAIM} one failed`);
    assert.equal(result.searchAudit[1].status, "failed", "a 503 (every provider failed) marks that query failed");
    assert.equal(result.searchAudit[1].providers, undefined, "a failed query has no providers");
    assert.equal(sent.telem.filter((request) => request.body.user_input.query === result.searchAudit[1].query).length, 1, "the failed query is not retried");
    assert.equal(result.costReceipt.telem.searches, sent.telem.length - 1, "the failed search is not on the receipt");
    assert.ok(near((await ledger()).reservedUsd, 0), "its reservation is released (a 503 costs nothing)");
  }
  say("401, 402 and 429 stop the run with plain messages (the 402 names ECHO_SEARCH_ROUTER=tavily), each query sent once, nothing reserved or spent; a 503 fails one query and the run goes on");

  // 6. The ledger, request by request: reserved before sending, settled at the providers' cost, released on a
  //    refusal, held when billing is unknown (a 500, a dropped connection); a cap too low sends nothing.
  {
    freshLedger();
    resetSent();
    mode = "routed";
    let atSend = null;
    onTelem = async () => { atSend = await ledger(); };
    const outcome = await pipeline.telemSearch(CLAIM, false);
    assert.ok(near(atSend.reservedUsd, 0.031), `reserved $0.031 while the request is out (${atSend.reservedUsd})`);
    let after = await ledger();
    assert.ok(near(after.reservedUsd, 0) && near(after.spentUsd, outcome.usd), `settled at the providers' cost ($${after.spentUsd} = $${outcome.usd})`);
    for (const [heldMode, label] of [["500", "a 500"], ["drop", "a dropped connection"]]) {
      freshLedger();
      mode = heldMode;
      const failure = await pipeline.telemSearch(CLAIM, false).then(() => null, (error) => error);
      assert.equal(failure?.code, "TELEM_ERROR", `${label} is a TELEM_ERROR (${failure?.code})`);
      after = await ledger();
      assert.ok(near(after.reservedUsd, 0.031) && near(after.spentUsd, 0), `${label} holds its reservation against today's cap (reserved ${after.reservedUsd})`);
    }
    onTelem = null;
    freshLedger();
    resetSent();
    mode = "routed";
    process.env.ECHO_TELEM_DAILY_CAP_USD = "0.02";
    const refused = await pipeline.telemSearch(CLAIM, false).then(() => null, (error) => error);
    process.env.ECHO_TELEM_DAILY_CAP_USD = "2";
    assert.equal(refused?.code, "TELEM_DAILY_CAP", `a Telem cap below one search's reservation refuses it with Telem's own code (${refused?.code})`);
    // QA round 6 (S3-3), 11/13 split: each cap's message names the cap it is, and the page-reading step's refusal
    // names Tavily's cap as page reading, never "Tavily searches" (with Telem, Tavily only reads pages).
    assert.match(refused.message, /^Echo’s \$0\.02 daily Telem cap \(searches\) is reached, or too close for this request\. About \$0\.02 remains; it resets at midnight Pacific time\.$/, `Telem router, search step: "${refused.message}"`);
    assert.equal(sent.telem.length, 0, "a refused search is never sent");
    freshLedger();
    process.env.ECHO_TAVILY_DAILY_CAP_USD = "0.02";
    process.env.ECHO_TAVILY_USD_PER_CREDIT = "0.05";
    const readRefused = await pipeline.tavilyPost("extract", { urls: [page("origin", 1)], extract_depth: "basic" }).then(() => null, (error) => error);
    process.env.ECHO_TAVILY_DAILY_CAP_USD = "2";
    process.env.ECHO_TAVILY_USD_PER_CREDIT = "0.008";
    assert.equal(readRefused?.code, "DAILY_BUDGET_REACHED", `a page read above Tavily's cap is refused (${readRefused?.code})`);
    assert.match(readRefused.message, /^Echo’s \$0\.02 daily Tavily cap \(page reading\) is reached, or too close for this request\. About \$0\.02 remains; it resets at midnight Pacific time\.$/, `Telem router, page-reading step: "${readRefused.message}"`);
    assert.doesNotMatch(readRefused.message, /Tavily searches|API limit/, "the page-reading step does not call Tavily a search");
    assert.equal(sent.extract, 0, "a refused page read is never sent");
    say("ledger: $0.031 reserved before each send, settled at the providers' cost; 500 and dropped connections hold theirs; a Telem cap below $0.031 sends nothing (TELEM_DAILY_CAP); each cap's message names its own cap (Telem searches, Tavily page reading)");
  }

  // 6b. One cap per provider, independently: Telem's cap does not stop Claude or Tavily, and Claude's or Tavily's cap
  //     does not stop a Telem search. Defaults, hard maximums, the advisory credit, and the running Telem total.
  {
    const caps = async () => Object.fromEntries(Object.entries((await ledger()).providers).map(([name, entry]) => [name, entry.capUsd]));
    const saved = { claude: process.env.ECHO_CLAUDE_DAILY_CAP_USD, tavily: process.env.ECHO_TAVILY_DAILY_CAP_USD, telem: process.env.ECHO_TELEM_DAILY_CAP_USD };
    delete process.env.ECHO_CLAUDE_DAILY_CAP_USD;
    delete process.env.ECHO_TAVILY_DAILY_CAP_USD;
    delete process.env.ECHO_TELEM_DAILY_CAP_USD;
    assert.deepEqual(await caps(), { claude: 50, tavily: 5, telem: 3 }, "defaults: Claude $50 (a runaway ceiling), Tavily $5, Telem $3");
    assert.deepEqual((await ledger()).telem, { totalUsd: 0, creditUsd: 20 }, "Telem's credit defaults to $20");
    Object.assign(process.env, { ECHO_CLAUDE_DAILY_CAP_USD: "1000", ECHO_TAVILY_DAILY_CAP_USD: "80", ECHO_TELEM_DAILY_CAP_USD: "100", ECHO_TELEM_CREDIT_USD: "12.5" });
    assert.deepEqual(await caps(), { claude: 200, tavily: 50, telem: 20 }, "a cap set above its hard maximum is held to it");
    assert.equal((await ledger()).telem.creditUsd, 12.5, "ECHO_TELEM_CREDIT_USD sets the credit the total is shown against");
    Object.assign(process.env, { ECHO_CLAUDE_DAILY_CAP_USD: "-1", ECHO_TAVILY_DAILY_CAP_USD: "lots", ECHO_TELEM_DAILY_CAP_USD: " " });
    assert.deepEqual(await caps(), { claude: 50, tavily: 5, telem: 3 }, "a negative, unreadable or blank cap is the default");
    process.env.ECHO_TELEM_DAILY_CAP_USD = "0";
    assert.equal((await caps()).telem, 0, "a cap of 0 is a cap of 0");
    delete process.env.ECHO_TELEM_CREDIT_USD;
    Object.assign(process.env, { ECHO_CLAUDE_DAILY_CAP_USD: saved.claude, ECHO_TAVILY_DAILY_CAP_USD: saved.tavily, ECHO_TELEM_DAILY_CAP_USD: saved.telem });

    freshLedger();
    resetSent();
    mode = "routed";
    process.env.ECHO_CLAUDE_DAILY_CAP_USD = "0";
    process.env.ECHO_TAVILY_DAILY_CAP_USD = "0";
    const outcome = await pipeline.telemSearch(CLAIM, false);
    assert.ok(outcome.providers.length && sent.telem.length === 1, "with Claude's and Tavily's caps at $0, a Telem search still goes out");
    const claudeRefused = await budget.reserveAnthropicBudget(0.01, "claude").then(() => null, (error) => error);
    const tavilyRefused = await budget.reserveAnthropicBudget(0.01, "tavily").then(() => null, (error) => error);
    assert.equal(claudeRefused?.code, "DAILY_BUDGET_REACHED", "Claude's own cap refuses Claude");
    assert.match(claudeRefused.message, /daily Claude cap is reached/);
    assert.equal(tavilyRefused?.code, "DAILY_BUDGET_REACHED", "Tavily's own cap refuses Tavily");
    process.env.ECHO_CLAUDE_DAILY_CAP_USD = "2";
    process.env.ECHO_TAVILY_DAILY_CAP_USD = "2";
    process.env.ECHO_TELEM_DAILY_CAP_USD = "0";
    const telemRefused = await budget.reserveAnthropicBudget(0.01, "telem").then(() => null, (error) => error);
    assert.equal(telemRefused?.code, "TELEM_DAILY_CAP", "Telem's own cap refuses Telem");
    const claudeOk = await budget.reserveAnthropicBudget(0.01, "claude");
    const tavilyOk = await budget.reserveAnthropicBudget(0.01, "tavily");
    await budget.settleAnthropicBudget(claudeOk, 0.004);
    await budget.settleAnthropicBudget(tavilyOk, 0.002);
    process.env.ECHO_TELEM_DAILY_CAP_USD = "2";
    const today = await ledger();
    assert.ok(near(today.providers.telem.spentUsd, outcome.usd) && near(today.providers.claude.spentUsd, 0.004) && near(today.providers.tavily.spentUsd, 0.002), "each provider's spend is on its own line");
    assert.ok(near(today.spentUsd, outcome.usd + 0.006), "the snapshot's spentUsd is every provider's together");
    assert.ok(near(today.telem.totalUsd, outcome.usd), "Telem's spend is added to its running total");

    // The running total covers every day: a ledger with Telem spend on an earlier day keeps it in the total but not in
    // today's figure, and today's settle adds to it.
    const ledgerFile = path.join(scratch, ".echo", "anthropic-daily-budget.json");
    const file = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    assert.equal(file.version, 2, "the ledger is written as version 2");
    file.days["2026-11-01"] = { telem: { spentUsd: 1.04, reservations: {} }, claude: { spentUsd: 3, reservations: {} } };
    file.telemTotalUsd = Math.round((file.telemTotalUsd + 1.04) * 1e6) / 1e6;
    fs.writeFileSync(ledgerFile, JSON.stringify(file));
    const second = await pipeline.telemSearch(CLAIM, false);
    const withHistory = await ledger();
    assert.ok(near(withHistory.providers.telem.spentUsd, outcome.usd + second.usd), "today's Telem figure is today's searches only");
    assert.ok(near(withHistory.telem.totalUsd, 1.04 + outcome.usd + second.usd), `the total adds every day's Telem spend ($${withHistory.telem.totalUsd})`);
    assert.ok(near(withHistory.providers.claude.spentUsd, 0.004), "another day's Claude spend is not today's");
    const { budgetLine } = load(path.join(echoLib, "budget-line.ts"));
    const line = budgetLine(withHistory, "telem");
    assert.match(line, /^Telem today \$0\.\d\d \/ \$2\.00 · total \$1\.\d\d of \$20 credit · Claude \$0\.00 \/ \$2\.00 · Tavily \$0\.00 \/ \$2\.00 · local ledger · resets midnight Pacific$/, `the status line: "${line}"`);
    say(`one cap per provider: defaults $50 / $5 / $3, hard maximums $200 / $50 / $20, Telem credit $20 (advisory); each cap refuses only its own provider (Telem's with TELEM_DAILY_CAP); Telem's running total covers every day; status line "${line}"`);
  }

  // 6c. An old (version 1) ledger still loads: its combined days count as Claude's (the split is unknown), Tavily's
  //     and Telem's caps and the Telem total start at zero, and the next write upgrades the file to version 2 with
  //     the old days kept. A ledger that is neither is refused (live calls pause) instead of being overwritten.
  {
    freshLedger();
    const today = (await ledger()).day;
    const ledgerFile = path.join(scratch, ".echo", "anthropic-daily-budget.json");
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, JSON.stringify({ version: 1, days: { [today]: { spentUsd: 1.5, reservations: { "old-run": 0.1 } }, "2026-11-12": { spentUsd: 3.9, reservations: {} } } }));
    const old = await ledger();
    assert.deepEqual(old.providers.claude, { capUsd: 2, spentUsd: 1.5, reservedUsd: 0.1 }, "today's combined spend and open reservation count against Claude's cap");
    assert.deepEqual([old.providers.tavily.spentUsd, old.providers.telem.spentUsd, old.telem.totalUsd], [0, 0, 0], "Tavily, Telem and the Telem total start from zero");
    const reservation = await budget.reserveAnthropicBudget(0.05, "telem");
    await budget.settleAnthropicBudget(reservation, 0.03);
    const upgraded = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    assert.equal(upgraded.version, 2, "the next write upgrades the file to version 2");
    assert.deepEqual(upgraded.days[today].claude, { spentUsd: 1.5, reservations: { "old-run": 0.1 } }, "today's old entry is kept as Claude's, open reservation included");
    assert.deepEqual(upgraded.days["2026-11-12"], { claude: { spentUsd: 3.9, reservations: {} } }, "earlier days are kept");
    assert.ok(near(upgraded.days[today].telem.spentUsd, 0.03) && near(upgraded.telemTotalUsd, 0.03), "the new Telem spend is on its own line and in the total");
    const claudeLeft = await budget.reserveAnthropicBudget(0.4, "claude");
    await budget.releaseAnthropicBudget(claudeLeft);
    assert.equal((await budget.reserveAnthropicBudget(0.5, "claude").then(() => null, (error) => error))?.code, "DAILY_BUDGET_REACHED", "the old spend still counts against Claude's $2 cap ($1.60 used, $0.50 does not fit)");
    for (const bad of [{ version: 3, days: {} }, { version: 2, days: { [today]: { bing: { spentUsd: 1, reservations: {} } } }, telemTotalUsd: 0 }, { version: 1, days: { [today]: { spentUsd: -1, reservations: {} } } }]) {
      fs.writeFileSync(ledgerFile, JSON.stringify(bad));
      assert.equal((await budget.reserveAnthropicBudget(0.01, "telem").then(() => null, (error) => error))?.code, "BUDGET_LEDGER_ERROR", `an unreadable ledger pauses live calls (${JSON.stringify(bad).slice(0, 60)})`);
      assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, "utf8")), bad, "and is not overwritten");
    }
    freshLedger();
    say("an old version 1 ledger loads (its days count as Claude's; Tavily, Telem and the total from zero), upgrades to version 2 on the next write with every day kept; a ledger of another shape pauses live calls and is left untouched");
  }

  // 6c2. The shared ledger (Upstash Redis, remote-budget.ts) splits the same way: a fake Upstash REST endpoint runs the
  //      three scripts' logic on an in-memory store. Claude keeps the old single-cap key (so a day spent before the
  //      split counts as Claude's), Tavily and Telem have their own keys per day, and Telem's settled spend is also
  //      added to one running-total key; a reservation over a provider's cap is refused with that provider's code.
  {
    const baseFetch = global.fetch;
    const hashes = new Map();
    const strings = new Map();
    const hash = (key) => { if (!hashes.has(key)) hashes.set(key, new Map()); return hashes.get(key); };
    const sums = (key) => {
      let spent = 0;
      let reserved = 0;
      for (const [field, value] of hash(key)) {
        if (field === "spent") spent = Number(value);
        else if (field.startsWith("r:")) reserved += Number(value);
      }
      return [spent, reserved];
    };
    const evals = [];
    global.fetch = async (url, options = {}) => {
      if (!String(url).startsWith("https://fake-upstash.example")) return baseFetch(url, options);
      const [command, script, numKeys, ...rest] = JSON.parse(options.body);
      assert.equal(command, "eval", "the shared ledger runs its scripts with EVAL");
      const keys = rest.slice(0, Number(numKeys));
      const args = rest.slice(Number(numKeys)).map(String);
      evals.push(keys);
      let result;
      if (script.includes("for k = 1, 3")) {
        result = [...sums(keys[0]), ...sums(keys[1]), ...sums(keys[2]), Number(strings.get(keys[3]) ?? 0)];
      } else if (script.includes("HSET")) {
        const [cap, amount, id] = [Number(args[0]), Number(args[1]), args[2]];
        const [spent, reserved] = sums(keys[0]);
        if (hash(keys[0]).has(`r:${id}`)) result = [1, spent, reserved];
        else if (spent + reserved + amount > cap) result = [0, spent, reserved];
        else { hash(keys[0]).set(`r:${id}`, amount); result = [1, spent, reserved]; }
      } else if (script.includes("HDEL")) {
        const [id, actual] = [args[0], Number(args[1])];
        if (!hash(keys[0]).has(`r:${id}`)) result = 0;
        else {
          hash(keys[0]).delete(`r:${id}`);
          if (actual > 0) {
            hash(keys[0]).set("spent", Number(hash(keys[0]).get("spent") ?? 0) + actual);
            if (keys[1]) strings.set(keys[1], Number(strings.get(keys[1]) ?? 0) + actual);
          }
          result = 1;
        }
      } else throw new Error("unexpected script");
      return json({ result });
    };
    process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
    try {
      const day = (await ledger()).day;
      hash(`echo:anthropic-budget:v1:${day}`).set("spent", 1_200_000); // $1.20 spent before the split
      const claudeR = await budget.reserveAnthropicBudget(0.1, "claude");
      const tavilyR = await budget.reserveAnthropicBudget(0.05, "tavily");
      const telemR = await budget.reserveAnthropicBudget(0.031, "telem");
      assert.deepEqual([claudeR.backend, claudeR.provider, tavilyR.provider, telemR.provider], ["redis", "claude", "tavily", "telem"]);
      const open = await ledger();
      assert.equal(open.storage, "shared");
      assert.deepEqual(Object.fromEntries(Object.entries(open.providers).map(([name, entry]) => [name, [entry.spentUsd, entry.reservedUsd]])), { claude: [1.2, 0.1], tavily: [0, 0.05], telem: [0, 0.031] }, "each provider's reservation is on its own key; the old key's spend is Claude's");
      await budget.settleAnthropicBudget(claudeR, 0.04);
      await budget.settleAnthropicBudget(tavilyR, 0.016);
      await budget.settleAnthropicBudget(telemR, 0.012);
      const settled = await ledger();
      assert.ok(near(settled.providers.claude.spentUsd, 1.24) && near(settled.providers.tavily.spentUsd, 0.016) && near(settled.providers.telem.spentUsd, 0.012) && near(settled.reservedUsd, 0), "settled on each provider's own key, nothing left reserved");
      assert.ok(near(settled.telem.totalUsd, 0.012), "Telem's settled spend is added to its running total");
      assert.ok(hashes.has(`echo:anthropic-budget:v1:tavily:${day}`) && hashes.has(`echo:anthropic-budget:v1:telem:${day}`) && strings.has("echo:anthropic-budget:v1:telem:total"), "the keys: tavily:<day>, telem:<day> and telem:total beside the old <day> key");
      assert.ok(!evals.some((keys) => keys.length === 2 && !keys[0].includes(":telem:")), "only a Telem settle passes the total key");
      process.env.ECHO_TELEM_DAILY_CAP_USD = "0.02";
      const refused = await budget.reserveAnthropicBudget(0.031, "telem").then(() => null, (error) => error);
      process.env.ECHO_TELEM_DAILY_CAP_USD = "2";
      assert.equal(refused?.code, "TELEM_DAILY_CAP", "a reservation over Telem's cap in the shared ledger is refused with Telem's code");
      assert.match(refused.message, /daily Telem cap \(searches\)/);
      say("shared ledger (fake Upstash): one key per provider per day (Claude keeps the old key), Telem's running total on its own key, each cap refused with its own code");
    } finally {
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      global.fetch = baseFetch;
    }
  }

  // 6d. Telem's daily cap falls back to Tavily instead of failing the run: (1) up front, when what is left of Telem's
  //     cap cannot cover the run's typical searches, the whole run searches with Tavily and says so; (2) mid-run, when
  //     another run takes Telem's room, the rest of this run's searches go through Tavily.
  {
    freshLedger();
    resetSent();
    mode = "routed";
    process.env.ECHO_TELEM_DAILY_CAP_USD = "0.2";
    const result = await run(`${CLAIM} telem cap up front`);
    assert.equal(sent.telem.length, 0, "no Telem search is sent once Telem's cap cannot cover the run");
    const upFrontTavily = sent.tavilySearch;
    assert.ok(upFrontTavily > 0, `the run searches with Tavily instead (${upFrontTavily} searches)`);
    assert.equal(result.searchFallback, "telem-daily-cap", "the trace records why it searched with Tavily");
    assert.ok(result.searchAudit.every((entry) => entry.router === undefined), "its audit is a Tavily run's");
    assert.equal(result.costReceipt.telem, undefined, "its receipt has no Telem block");
    const notice = progressEvents.find((event) => event.label === pipeline.TELEM_CAP_FALLBACK_LABEL);
    assert.ok(notice && notice.searchFallback === "telem-daily-cap", "the wait card is told: \"Telem's daily cap reached, this run searched with Tavily\"");
    assert.ok(progressEvents.find((event) => Array.isArray(event.queries))?.searchFallback === "telem-daily-cap", "the search plan's event carries the fallback too (the wait card keeps the notice for the whole run)");
    assert.ok(progressEvents.filter((event) => event.stage === "search" && event.queriesDone > 0).every((event) => event.searchFallback === "telem-daily-cap"), "and so does each search step's progress");
    assert.equal(pipeline.TELEM_CAP_FALLBACK_LABEL, "Telem's daily cap reached, this run searched with Tavily");
    const back = parsePortableTrace(JSON.parse(JSON.stringify(makePortableTrace(result))));
    assert.equal(back?.searchFallback, "telem-daily-cap", "the fallback round-trips through export and import");
    const copy = JSON.parse(JSON.stringify(makePortableTrace(result)));
    copy.analysis.searchFallback = "bing-cap";
    assert.equal(parsePortableTrace(copy), null, "an unknown fallback value is refused on import");
    assert.ok(near((await ledger()).providers.telem.spentUsd, 0), "nothing was charged to Telem");

    freshLedger();
    resetSent();
    process.env.ECHO_TELEM_DAILY_CAP_USD = "0.5";
    // Another run takes the rest of Telem's room after this run's first five Telem reservations: the ledger then
    // refuses every further Telem reservation, as it would at the cap.
    const realReserve = budget.reserveAnthropicBudget;
    let telemReservations = 0;
    budget.reserveAnthropicBudget = async (amountUsd, provider) => {
      if (provider === "telem" && ++telemReservations > 5) throw new budget.AnthropicBudgetError("TELEM_DAILY_CAP", "Echo’s $0.50 daily Telem cap (searches) is reached, or too close for this request. About $0.00 remains; it resets at midnight Pacific time.");
      return realReserve(amountUsd, provider);
    };
    let midRun;
    try {
      midRun = await run(`${CLAIM} telem cap mid-run`);
    } finally {
      budget.reserveAnthropicBudget = realReserve;
    }
    const viaTelem = midRun.searchAudit.filter((entry) => entry.router === "telem" && entry.status === "searched");
    const viaTavily = midRun.searchAudit.filter((entry) => entry.router === undefined && entry.status === "searched");
    assert.equal(sent.telem.length, 5, `the first batch's five searches went through Telem (${sent.telem.length})`);
    assert.ok(viaTelem.length === 5 && viaTavily.length >= 2 && sent.tavilySearch === viaTavily.length, `the rest went through Tavily (${viaTelem.length} via Telem, ${viaTavily.length} via Tavily)`);
    assert.equal(midRun.searchFallback, "telem-daily-cap");
    assert.equal(progressEvents.filter((event) => event.label === pipeline.TELEM_CAP_FALLBACK_LABEL).length, 1, "the switch is announced once");
    assert.ok(parsePortableTrace(JSON.parse(JSON.stringify(makePortableTrace(midRun)))), "a run with both routers in its audit imports");
    process.env.ECHO_TELEM_DAILY_CAP_USD = "2";
    say(`Telem's cap falls back to Tavily: up front (cap $0.20 < 10 x $0.031: 0 Telem, ${upFrontTavily} Tavily searches) and mid-run (5 via Telem, then ${viaTavily.length} via Tavily); the wait card's notice and the trace's searchFallback say so; nothing fails`);
  }

  // 7. Keys: ECHO_SEARCH_ROUTER=telem without a key, or a key that is not a Telem key, is a MISSING_KEYS error that
  //    names TELEM_API_KEY, before anything is sent. A Check these sources run needs no Telem key.
  {
    const saved = process.env.TELEM_API_KEY;
    for (const [setup, label] of [[() => { delete process.env.TELEM_API_KEY; process.env.ECHO_SEARCH_ROUTER = "telem"; }, "no key"], [() => { process.env.TELEM_API_KEY = "sk-wrong-provider"; }, "a key that is not a Telem key"]]) {
      freshLedger();
      resetSent();
      setup();
      const failure = await run(`${CLAIM} keys`).then(() => null, (error) => error);
      assert.equal(failure?.code, "MISSING_KEYS", `${label}: MISSING_KEYS (${failure?.code})`);
      assert.match(failure.message, /TELEM_API_KEY/);
      assert.equal(sent.telem.length + sent.tavilySearch + sent.extract + sent.claude, 0, `${label}: nothing is sent`);
      delete process.env.ECHO_SEARCH_ROUTER;
      process.env.TELEM_API_KEY = saved;
    }
    say("no Telem key with ECHO_SEARCH_ROUTER=telem, or a non-Telem key: MISSING_KEYS naming TELEM_API_KEY, nothing sent");
  }

  // 8. Without TELEM_API_KEY (or with ECHO_SEARCH_ROUTER=tavily) the Tavily path is unchanged: Tavily searches, no
  //    Telem request, no routing fields in the audit and no Telem block on the receipt.
  {
    const saved = process.env.TELEM_API_KEY;
    for (const [setup, label] of [[() => { delete process.env.TELEM_API_KEY; }, "no Telem key"], [() => { process.env.ECHO_SEARCH_ROUTER = "tavily"; }, "ECHO_SEARCH_ROUTER=tavily"]]) {
      freshLedger();
      resetSent();
      setup();
      const result = await run(`${CLAIM} tavily ${label}`);
      assert.equal(sent.telem.length, 0, `${label}: no Telem request`);
      assert.ok(sent.tavilySearch > 0, `${label}: Tavily searches`);
      assert.ok(result.searchAudit.every((entry) => entry.router === undefined && entry.providers === undefined && entry.pageProviders === undefined), `${label}: no routing fields`);
      assert.equal(result.costReceipt.telem, undefined, `${label}: no Telem block`);
      assert.deepEqual(Object.keys(result.costReceipt.usd), ["claude", "tavily", "total"], `${label}: the receipt's dollar fields are unchanged`);
      process.env.TELEM_API_KEY = saved;
      delete process.env.ECHO_SEARCH_ROUTER;
    }
    say("without a Telem key, or with ECHO_SEARCH_ROUTER=tavily: Tavily searches as before, no Telem request, no routing fields, receipt unchanged");
  }

  // 9. The import check refuses routing fields that do not add up.
  {
    freshLedger();
    resetSent();
    mode = "routed";
    const result = await run(`${CLAIM} import`);
    const trace = () => JSON.parse(JSON.stringify(makePortableTrace(result)));
    const refuse = (label, change) => {
      const copy = trace();
      change(copy.analysis);
      assert.equal(parsePortableTrace(copy), null, `refused: ${label}`);
    };
    assert.ok(parsePortableTrace(trace()));
    refuse("another router name", (analysis) => { analysis.searchAudit[0].router = "bing"; });
    refuse("providers without a router", (analysis) => { delete analysis.searchAudit[0].router; });
    refuse("a provider name with spaces", (analysis) => { analysis.searchAudit[0].providers = ["Exa Search"]; });
    refuse("providers on a query that was not searched", (analysis) => { const skipped = analysis.searchAudit.find((entry) => entry.status !== "searched"); if (skipped) skipped.providers = ["exa"]; else analysis.searchAudit[0].providers = []; });
    refuse("page providers for a page the query did not add", (analysis) => { analysis.searchAudit[0].pageProviders = { "page-999": ["exa"] }; });
    refuse("a Telem block without usd.telem", (analysis) => { delete analysis.costReceipt.usd.telem; });
    refuse("usd.telem without a Telem block", (analysis) => { delete analysis.costReceipt.telem; });
    refuse("a total that leaves Telem out", (analysis) => { analysis.costReceipt.usd.total = analysis.costReceipt.usd.claude + analysis.costReceipt.usd.tavily; });
    refuse("more provider runs than searches", (analysis) => { analysis.costReceipt.telem.providerRuns.exa = analysis.costReceipt.telem.searches + 1; });
    say("import refuses: another router name, providers without a router or on an unsearched query, odd provider names, page providers for other pages, a Telem receipt that does not add up");
  }

  process.stdout.write(`Telem search router passed: request shape, routing recorded per query and per page, dedupe across providers, early stop, deeper pass, ledger reserve/settle/release/hold, one cap per provider, Telem's running total, old ledgers, Telem cap falls back to Tavily, 401/402/429/503, missing keys, Tavily path unchanged, import round-trip; no provider calls (${sent.other} page requests answered 404 by the mock).\n`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.chdir(os.tmpdir());
  fs.rmSync(scratch, { recursive: true, force: true });
}
