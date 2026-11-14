// Deep search (src/lib/echo/search-mode.ts; pipeline.ts deepSearchForClaim, judgeBatches, judgePages batching):
// offline checks with mocked Tavily, Telem and Claude. No provider is reached: every request goes to the mock below,
// the ledger is a scratch file in a throwaway folder, and the keys are fake.
// Run by check:pipeline (in its own process, so it shares none of that script's mocks or ledger); also runs alone.
//   1. A Deep run through Tavily reads more than 20 pages (up to 50, at most 3 a site), sends at most 16 searches of
//      20 results, groups with a 4,000-token limit and judges in batches of at most 20 pages, each page once.
//   2. Through Telem: at most 16 Telem searches, 20 results per provider, each reserved at that size; Telem's cap
//      too low for a Deep run's searches sends the run to Tavily.
//   3. Batched judging keeps every post-judge guard across batches: a co-published copy judged in another batch than
//      its origin, a coin-flip origin, a cited parent in another batch, an unreadable batch.
//   4. The receipt, the ledger and the trace: what the receipt says is what each provider's cap was charged; the
//      trace records searchMode "deep" and round-trips; a Standard run of the same claim is not answered by it.
//   5. Standard is unchanged: the same requests as before (one judgment request, the old prompt, 20 pages, 10
//      results a search, no searchMode), and the route accepts only "standard" or "deep".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "echo-deep-check-"));
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
  ANTHROPIC_MODEL: "claude-sonnet-5-5",
  ANTHROPIC_CLASSIFIER_MODEL: "claude-sonnet-5-5",
  ANTHROPIC_ANSWER_MODEL: "claude-sonnet-5-5",
  ECHO_CLAUDE_DAILY_CAP_USD: "50",
  ECHO_TAVILY_DAILY_CAP_USD: "5",
  ECHO_TELEM_DAILY_CAP_USD: "3",
  ECHO_TAVILY_USD_PER_CREDIT: "0.008",
  ECHO_TAVILY_RETRY_DELAY_MS: "1",
  ECHO_CLAUDE_RETRY_DELAY_MS: "1",
  ECHO_SEARCH_CACHE: "0",
  ECHO_HTML_LINKS: "0",
  ECHO_RETELLING_CHECK: "1",
});
for (const key of ["TELEM_API_KEY", "ECHO_SEARCH_ROUTER", "ECHO_DEEP_SEARCH_BELOW", "VERCEL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "ECHO_SEARCH_RAW_CONTENT", "ECHO_ANTHROPIC_DAILY_CAP_USD", "ECHO_DAILY_CAP_OVERRIDE_USD", "ECHO_PROMPT_CACHE", "ECHO_THINKING_OFF", "ANTHROPIC_GROUPING_MODEL"]) delete process.env[key];

const echoLib = path.join(projectRoot, "src", "lib", "echo");
const pipeline = load(path.join(echoLib, "pipeline.ts"));
const budget = load(path.join(echoLib, "daily-budget.ts"));
const telem = load(path.join(echoLib, "telem.ts"));
const mode = load(path.join(echoLib, "search-mode.ts"));
const { makePortableTrace, parsePortableTrace } = load(path.join(echoLib, "portable.ts"));

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const say = (line) => process.stdout.write(`  ok  ${line}\n`);
const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
const CLAIM = "90% of startups fail";

// --- The mock ----------------------------------------------------------------------------------------------------
// Every search returns its own distinct pages (40 sites, so a site can come back many times); the pages' text states
// the claim and a date. The grouping answer puts every page in one group, so a Deep run's 50 pages must be split.
const SITES = 40;
const sent = { searches: [], telem: [], extracts: [], grouping: [], judge: [], answer: [], other: 0 };
const resetSent = () => { for (const key of ["searches", "telem", "extracts", "grouping", "judge", "answer"]) sent[key] = []; sent.other = 0; };
let searchSerial = 0;
const resultsFor = (count) => Array.from({ length: count }, (_, rank) => {
  searchSerial += 1;
  const site = searchSerial % SITES;
  return { url: `https://site${site}.example/startups-${searchSerial}`, title: `90% of startups fail, report ${searchSerial}`, content: "90% of startups fail, this report says.", published_date: `20${String(10 + (searchSerial % 14)).padStart(2, "0")}-01-01`, score: 1 - rank / 100 };
});
const pageText = (url) => {
  const serial = Number(url.match(/startups-(\d+)/)?.[1] ?? 0);
  return `Published: 20${String(10 + (serial % 14)).padStart(2, "0")}-01-0${1 + (serial % 9)}. 90% of startups fail, report number ${serial} on ${url}.`;
};
const clustersIn = (prompt) => JSON.parse(prompt.slice(prompt.indexOf("\n\nClusters: ") + 12));
let judgeFailWhen = null; // (prompt) => true to answer that batch with unreadable text, as Claude sometimes does
const judgeReply = (prompt) => {
  const clusters = clustersIn(prompt);
  const judgements = [];
  for (const cluster of clusters) {
    const ids = cluster.pages.map((page) => page.id);
    const candidates = [...(cluster.contextPages ?? []), ...cluster.pages];
    const dated = candidates.filter((page) => page.publishedDate).sort((a, b) => a.publishedDate.localeCompare(b.publishedDate));
    const oldest = dated[0]?.id;
    for (const id of ids) {
      const page = cluster.pages.find((entry) => entry.id === id);
      const parent = dated.find((entry) => entry.publishedDate < page.publishedDate)?.id;
      judgements.push(id === oldest || !parent
        ? { pageId: id, kind: "origin", parentId: null, confidence: 80, evidence: "Its own report.", hasPrimaryEvidence: true, primaryEvidenceReason: "Reports the figure.", originBasis: "firsthand" }
        : { pageId: id, kind: "derived", parentId: oldest ?? parent, confidence: 70, evidence: "Repeats the earlier report.", hasPrimaryEvidence: false, primaryEvidenceReason: "No data of its own.", originBasis: "not-origin" });
    }
  }
  return { judgements };
};
let judgeOverride = null; // (prompt) => judgements answer, for the guard checks
const model = (value, usage = { input_tokens: 1000, output_tokens: 200 }) => json({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], usage, stop_reason: "end_turn" });

global.fetch = async (url, options = {}) => {
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("aborted", "AbortError");
  const endpoint = String(url);
  const body = options.body ? JSON.parse(options.body) : {};
  if (endpoint === "https://api.tavily.com/search") {
    sent.searches.push(body);
    return json({ results: resultsFor(body.max_results), usage: { credits: body.search_depth === "advanced" ? 2 : 1 } });
  }
  if (endpoint === "https://router.telem.ai/v1/search") {
    sent.telem.push(body);
    const runs = ["exa", "brave"].map((name) => ({ preprocessor_name: name, status: "succeeded", error: null, output_payload: { results: resultsFor(body.search.num_results).map((row, index) => ({ rank: index + 1, url: row.url, title: row.title, summary: row.content, publish_date: row.published_date })) } }));
    return json({ status: "succeeded", routing: [{ providers: ["exa", "brave"] }], preprocessor_runs: runs });
  }
  if (endpoint === "https://api.tavily.com/extract") {
    sent.extracts.push(body);
    return json({ results: body.urls.map((pageUrl) => ({ url: pageUrl, raw_content: pageText(pageUrl) })), usage: { credits: Math.ceil(body.urls.length / 5) } });
  }
  if (endpoint.endsWith("/count_tokens")) return json({ input_tokens: Math.ceil(JSON.stringify(body).length / 3) });
  if (endpoint.endsWith("/messages")) {
    const prompt = body.messages[0].content;
    if (prompt.startsWith("Group these")) {
      sent.grouping.push(body);
      const ids = JSON.parse(prompt.slice(prompt.indexOf("\n\nPages: ") + 9)).map((page) => page.id);
      return model({ clusters: [{ label: "Startup failure claim", pageIds: ids, matchesClaim: true }] });
    }
    if (prompt.startsWith("You are a cautious")) {
      sent.judge.push(body);
      if (judgeFailWhen?.(prompt)) return model("this is not JSON");
      return model(judgeOverride ? judgeOverride(prompt) : judgeReply(prompt));
    }
    if (prompt.startsWith("Answer the")) {
      sent.answer.push(body);
      return model({ claims: [{ text: "The reports say so", sourceNumbers: [1] }] });
    }
    throw new Error("unexpected model prompt");
  }
  sent.other += 1;
  return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
};

const ledger = () => budget.getAnthropicBudgetSnapshot();
const freshLedger = () => fs.rmSync(path.join(scratch, ".echo"), { recursive: true, force: true });
let progressEvents = [];
const run = (claim, options = {}) => {
  progressEvents = [];
  return pipeline.analyzeClaim(claim, (event) => progressEvents.push(event), { forceFresh: true, ...options });
};
const judgedIds = (body) => clustersIn(body.messages[0].content).flatMap((cluster) => cluster.pages.map((page) => page.id));

try {
  // 0. The parameters and the estimate shown in the claim box.
  {
    assert.equal(mode.DEEP_MAX_SEARCHES, 16, "a Deep run sends at most 16 searches (12 basic + 4 deeper)");
    assert.deepEqual([mode.DEEP_SEARCH.resultsPerSearch, mode.DEEP_SEARCH.pagesRead, mode.DEEP_SEARCH.judgeBatchPages, mode.DEEP_SEARCH.maxPagesPerDomain], [20, 50, 20, 3]);
    const tip = mode.deepSearchTooltip("telem");
    assert.match(tip, /^Deep search: at most 16 Telem searches \(20 results per engine; up to \$0\.69 of Telem credit\), reads up to 50 pages \(Standard: 20\) and judges them in batches\. Estimate ≈\$0\.6–1\.1 · ~1–2 min per run/, tip);
    assert.match(mode.deepSearchTooltip("tavily"), /16 searches of 20 results.*Estimate ≈\$0\.4–0\.6/);
    // The tooltip's Telem figure is what a Deep run reserves: 12 basic + 4 extended-tier searches at 20 results.
    const worstTelem = 12 * telem.telemReserveUsd("default", 20) + 4 * telem.telemReserveUsd("extended", 20);
    assert.ok(near(worstTelem, mode.DEEP_ESTIMATE.telem.telemHighUsd, 0.005), `the tooltip's Telem ceiling is the reservation ($${worstTelem.toFixed(3)})`);
    assert.equal(telem.telemReserveUsd("default"), 0.031, "a Standard search still reserves $0.031");
    assert.equal(telem.telemReserveUsd("extended"), 0.04, "and $0.040 at the extended tier");
    const deepQueries = pipeline.deepQueries("Americans check their phones 96 times a day");
    const standard = pipeline.generateQueries("Americans check their phones 96 times a day");
    assert.equal(deepQueries.length, 12, "12 Deep variants");
    assert.deepEqual(deepQueries.slice(0, standard.length), standard, "the Standard variants come first, in order");
    assert.ok(deepQueries.slice(standard.length).every((query) => /\b96\b/.test(query)), "the extra variants keep the claim's figure");
    say(`parameters: 16 searches max, 20 results each, 50 pages, batches of 20; tooltip "${tip}"`);
  }

  // 1. A Deep run through Tavily.
  let deepResult;
  {
    freshLedger();
    resetSent();
    const before = await ledger();
    deepResult = await run(CLAIM, { searchMode: "deep" });
    const after = await ledger();
    assert.equal(deepResult.searchMode, "deep", "the trace records the Deep mode");
    assert.ok(deepResult.pages.length > 20 && deepResult.pages.length <= 50, `more than 20 pages read (${deepResult.pages.length})`);
    assert.equal(deepResult.pages.length, 50, "50 pages read when the search finds enough");
    const perSite = new Map();
    for (const page of deepResult.pages) perSite.set(page.domain, (perSite.get(page.domain) ?? 0) + 1);
    assert.ok([...perSite.values()].every((count) => count <= 3), "at most 3 pages from one site");
    assert.ok(perSite.size >= 17, `pages from many distinct sites (${perSite.size})`);
    assert.ok(sent.searches.length <= 16, `at most 16 searches (${sent.searches.length})`);
    assert.ok(sent.searches.every((body) => body.max_results === 20), "20 results a search");
    assert.equal(sent.searches.filter((body) => body.search_depth === "advanced").length, 4, "the deeper pass always runs, on 4 variants");
    const planned = progressEvents.find((event) => Array.isArray(event.queries));
    assert.equal(planned.queries.length, 12, "the wait card's plan lists 12 variants");
    assert.ok(deepResult.searchAudit.length <= 16 && deepResult.searchAudit.filter((entry) => entry.status !== "not searched").length === sent.searches.length, "the audit has every planned search, the searched ones as sent");
    assert.ok(deepResult.searchAudit.some((entry) => entry.reason === "Stopped after collecting at least 100 distinct pages to conserve search credits."), "the basic pass stops at 100 distinct pages, not 20");
    assert.equal(sent.extracts.length, 5, "50 pages are read in 5 extract batches of 10");
    assert.equal(sent.grouping.length, 1, "one grouping request");
    assert.equal(sent.grouping[0].max_tokens, 4000, "with a 4,000-token output limit");
    assert.equal(sent.judge.length, 3, "50 pages in one group are judged in 3 batches");
    const judged = sent.judge.map(judgedIds);
    assert.ok(judged.every((ids) => ids.length <= 20), `each batch judges at most 20 pages (${judged.map((ids) => ids.length).join(", ")})`);
    assert.deepEqual(judged.flat().sort(), deepResult.pages.map((page) => page.id).sort(), "every page is judged exactly once");
    assert.ok(sent.judge.slice(1).every((body) => body.messages[0].content.includes('"contextPages"') && body.messages[0].content.includes("This request judges part of the trace")), "later batches carry earlier pages as context, with the batch rule");
    assert.ok(sent.judge.every((body) => body.max_tokens === 5200), "each batch keeps the judgment request's output limit");
    const derived = deepResult.pages.filter((page) => page.judgment.kind === "derived");
    assert.ok(derived.length > 30, `copies judged in later batches link to the origin they saw as context (${derived.length} derived)`);
    assert.equal(new Set(derived.map((page) => page.judgment.parentId)).size, 1, "all of them to the one oldest page");
    // The receipt: 1 grouping + 3 judgments + 1 answer, its Tavily lines are the requests sent, and each provider's
    // cap was charged what the receipt says.
    const receipt = deepResult.costReceipt;
    assert.deepEqual(receipt.claude.map((entry) => entry.step), ["grouping", "judgment", "judgment", "judgment", "answer"], "the receipt lists every Claude request");
    assert.equal(receipt.tavily.basicSearches + receipt.tavily.advancedSearches, sent.searches.length);
    assert.equal(receipt.tavily.extractRequests, 5);
    assert.equal(receipt.tavily.extractedUrls, 50);
    assert.ok(near(after.providers.claude.spentUsd - before.providers.claude.spentUsd, receipt.usd.claude, 1e-5), "Claude's cap was charged the receipt's Claude dollars");
    assert.ok(near(after.providers.tavily.spentUsd - before.providers.tavily.spentUsd, receipt.usd.tavily, 1e-5), "Tavily's cap was charged the receipt's Tavily dollars");
    assert.ok(near(after.reservedUsd, 0), "nothing is left reserved");
    const back = parsePortableTrace(JSON.parse(JSON.stringify(makePortableTrace(deepResult))));
    assert.ok(back && back.searchMode === "deep" && back.pages.length === 50, "a Deep trace round-trips through export and import");
    say(`Deep via Tavily: ${sent.searches.length} searches (20 results), ${deepResult.pages.length} pages from ${perSite.size} sites (≤3 each), 5 extracts, grouping 4,000 tokens, judged in 3 batches (${judged.map((ids) => ids.length).join(" + ")}), receipt $${receipt.usd.total.toFixed(4)} = the caps' charges`);
  }

  // 2. Through Telem: at most 16 Telem searches, breadth from 20 results per provider.
  {
    freshLedger();
    resetSent();
    process.env.TELEM_API_KEY = TELEM_KEY;
    const reserved = [];
    const realReserve = budget.reserveAnthropicBudget;
    budget.reserveAnthropicBudget = async (amountUsd, provider) => {
      if (provider === "telem") reserved.push(amountUsd);
      return realReserve(amountUsd, provider);
    };
    let result;
    try {
      result = await run(`${CLAIM} via telem`, { searchMode: "deep" });
    } finally {
      budget.reserveAnthropicBudget = realReserve;
    }
    assert.ok(sent.telem.length > 0 && sent.telem.length <= 16, `at most 16 Telem searches (${sent.telem.length})`);
    assert.equal(sent.searches.length, 0, "no Tavily search");
    assert.ok(sent.telem.every((body) => body.search.num_results === 20), "20 results per provider");
    assert.equal(sent.telem.filter((body) => body.search.tier === "extended").length, 4, "4 deeper (extended tier) searches");
    assert.equal(reserved.length, sent.telem.length, "one Telem reservation per search");
    assert.deepEqual([reserved.filter((amount) => near(amount, 0.041)).length, reserved.filter((amount) => near(amount, 0.05)).length], [sent.telem.length - 4, 4], `each reserved at 20 results: $0.041 basic, $0.050 extended ($${[...new Set(reserved)].join(", $")})`);
    assert.ok(result.pages.length > 20, `more than 20 pages read (${result.pages.length})`);
    assert.equal(result.costReceipt.telem.searches, sent.telem.length);
    const after = await ledger();
    assert.ok(near(after.providers.telem.spentUsd, result.costReceipt.usd.telem, 1e-5) && near(after.telem.totalUsd, result.costReceipt.usd.telem, 1e-5), "Telem's cap and running total were charged the receipt's Telem dollars");
    // Telem's cap with room for a Standard run but not a Deep one: the Deep run searches with Tavily and says so.
    freshLedger();
    resetSent();
    process.env.ECHO_TELEM_DAILY_CAP_USD = "0.5";
    const fellBack = await run(`${CLAIM} via telem capped`, { searchMode: "deep" });
    process.env.ECHO_TELEM_DAILY_CAP_USD = "3";
    assert.equal(sent.telem.length, 0, "no Telem search when Telem's cap cannot cover a Deep run's 16 ($0.69)");
    assert.ok(sent.searches.length > 0 && fellBack.searchFallback === "telem-daily-cap" && fellBack.searchMode === "deep", "the Deep run searches with Tavily and records why");
    assert.ok(progressEvents.some((event) => event.label === pipeline.TELEM_CAP_FALLBACK_LABEL), "the wait card is told");
    delete process.env.TELEM_API_KEY;
    say(`Deep via Telem: ≤16 Telem searches at 20 results per provider (each reserved at $0.041 / $0.050), >20 pages, Telem's cap and total charged the receipt's dollars; a Telem cap of $0.50 sends a Deep run to Tavily`);
  }

  // 3. Batched judging keeps every post-judge guard across batches (judgePages on 45 hand-made pages in one group).
  {
    resetSent();
    const page = (index, fields = {}) => ({
      id: `page-${index + 1}`, title: `Report ${index + 1}`, url: `https://p${index}.example/report`, domain: `p${index}.example`,
      publishedDate: `2020-${String(1 + Math.floor(index / 28)).padStart(2, "0")}-${String(1 + (index % 28)).padStart(2, "0")}`, publishedDateSource: "page text",
      extractionSource: "Tavily extraction", text: `90% of startups fail, says report ${index + 1}, with its own unusual wording number ${index * 7919}.`, hasPrimaryEvidence: false,
      judgment: { kind: "origin", parentId: null, confidence: 0, evidence: "Awaiting source comparison." }, ...fields,
    });
    const pages = Array.from({ length: 45 }, (_, index) => page(index));
    // A release posted twice the same day: page 20 (the 20th by date, so in the first batch) and page 21 (first of the
    // second batch), with the same text.
    const release = "Our 2020 study of 4,000 startups found that 90% of startups fail within ten years, the report released today says, with full tables and methods.";
    pages[19] = { ...pages[19], publishedDate: "2020-01-20", text: release };
    pages[20] = { ...pages[20], publishedDate: "2020-01-20", text: release };
    // Page 44 (third batch) cites page 3 (first batch) by link; the judge names page 5 instead.
    pages[43] = { ...pages[43], citations: [{ pageId: "page-3", how: "link", quote: "https://p2.example/report" }] };
    const cluster = { id: "cluster-1", label: "Startup failure claim", pageIds: pages.map((entry) => entry.id) };
    const pageById = new Map(pages.map((entry) => [entry.id, entry]));
    const batches = pipeline.judgeBatches([cluster], pageById, new Map(), 20);
    assert.deepEqual(batches.map((batch) => batch[0].judgeIds.length), [20, 20, 5], "45 pages in one group: parts of 20, 20 and 5 in date order");
    assert.ok(batches[0][0].judgeIds.includes("page-20") && batches[1][0].judgeIds.includes("page-21"), "the co-published pair falls in two batches");
    assert.ok(batches[2][0].contextIds.includes("page-3"), "a page's cited page is in its batch's context");
    assert.ok(batches.slice(1).every((batch) => batch[0].contextIds.includes("page-1") && batch[0].contextIds.length <= 20), "later batches carry the earliest pages, at most 20");
    judgeOverride = (prompt) => ({
      judgements: clustersIn(prompt).flatMap((group) => group.pages.map(({ id }) => {
        if (id === "page-1") return { pageId: id, kind: "origin", parentId: null, confidence: 85, evidence: "Firsthand.", hasPrimaryEvidence: true, primaryEvidenceReason: "Data.", originBasis: "firsthand" };
        if (id === "page-20") return { pageId: id, kind: "origin", parentId: null, confidence: 80, evidence: "The study release.", hasPrimaryEvidence: true, primaryEvidenceReason: "Tables.", originBasis: "firsthand" };
        if (id === "page-21") return { pageId: id, kind: "unclear", parentId: null, confidence: 40, evidence: "Same day as another posting.", hasPrimaryEvidence: false, primaryEvidenceReason: "Repeats.", originBasis: "not-origin" };
        if (id === "page-30") return { pageId: id, kind: "origin", parentId: null, confidence: 45, evidence: "Maybe its own take.", hasPrimaryEvidence: false, primaryEvidenceReason: "None.", originBasis: "own-analysis" };
        if (id === "page-44") return { pageId: id, kind: "derived", parentId: "page-5", confidence: 70, evidence: "Repeats an earlier page.", hasPrimaryEvidence: false, primaryEvidenceReason: "None.", originBasis: "not-origin" };
        return { pageId: id, kind: "derived", parentId: "page-1", confidence: 70, evidence: "Repeats page 1.", hasPrimaryEvidence: false, primaryEvidenceReason: "None.", originBasis: "not-origin" };
      })),
    });
    const judgedPages = await pipeline.judgePages(CLAIM, pages, [cluster], undefined, true, { batchPages: 20, concurrency: 3 });
    const byId = new Map(judgedPages.map((entry) => [entry.id, entry]));
    assert.equal(sent.judge.length, 3, "three judgment requests");
    assert.equal(byId.get("page-21").judgment.kind, "origin", "the copy judged unclear in the second batch is a co-published origin with its twin from the first");
    assert.match(byId.get("page-21").judgment.evidence, /^Published within days of p19\.example with largely identical text/);
    assert.match(byId.get("page-20").judgment.evidence, /^Published the same day as p20\.example with largely identical text; Echo counts them as one origin\./, "and its twin gets the partner note");
    assert.equal(byId.get("page-30").judgment.kind, "unclear", "a coin-flip origin (45 of 100) with no data of its own stays unresolved");
    assert.match(byId.get("page-30").judgment.evidence, /unsure this page is an independent origin \(45 of 100\)/);
    assert.equal(byId.get("page-44").judgment.parentId, "page-3", "a page judged in the third batch is linked to the page it cites in the first, not the judge's pick");
    assert.match(byId.get("page-44").judgment.evidence, /cites p2\.example directly but not p4\.example/);
    assert.ok(judgedPages.filter((entry) => entry.judgment.kind === "derived").every((entry) => entry.judgment.parentId === "page-1" || entry.id === "page-44"), "copies in later batches link to the origin they saw as context");

    // An unreadable batch: its pages stay unjudged when they are at most a quarter of the pages, else the run stops.
    resetSent();
    // The 12-page group's request fails (its pages are under a quarter of the 50).
    judgeFailWhen = (prompt) => clustersIn(prompt).some((group) => group.label === "y");
    const small = Array.from({ length: 50 }, (_, index) => page(index));
    const smallCluster = { id: "c", label: "x", pageIds: small.map((entry) => entry.id) };
    const twoGroups = [{ ...smallCluster, pageIds: smallCluster.pageIds.slice(0, 38) }, { id: "c2", label: "y", pageIds: smallCluster.pageIds.slice(38) }];
    const partial = await pipeline.judgePages(CLAIM, small, twoGroups, undefined, true, { batchPages: 20, concurrency: 1 });
    const unjudged = partial.filter((entry) => entry.judgment.evidence === pipeline.UNJUDGED_EVIDENCE);
    assert.equal(unjudged.length, 12, `the unreadable batch's 12 pages are left unresolved (${unjudged.length})`);
    assert.ok(partial.filter((entry) => entry.judgment.evidence !== pipeline.UNJUDGED_EVIDENCE).length === 38, "the other batches' 38 pages are judged");
    // Two of the three requests of one 50-page group fail: 40 pages unjudged.
    let failures = 0;
    judgeFailWhen = () => (failures += 1) <= 2;
    await assert.rejects(pipeline.judgePages(CLAIM, small, [smallCluster], undefined, true, { batchPages: 20, concurrency: 1 }), (error) => error.code === "CLAUDE_INCOMPLETE", "more than a quarter unjudged still stops the run");
    judgeFailWhen = null;
    // A request refused for good (Claude rejects the key) stops the batches not yet sent.
    resetSent();
    let refusals = 0;
    const realFetch = global.fetch;
    global.fetch = async (url, options) => (String(url).endsWith("/messages") && (refusals += 1) ? new Response(JSON.stringify({ type: "error" }), { status: 401 }) : realFetch(url, options));
    await assert.rejects(pipeline.judgePages(CLAIM, small, [smallCluster], undefined, true, { batchPages: 20, concurrency: 1 }), (error) => error.code === "CLAUDE_AUTH");
    global.fetch = realFetch;
    assert.equal(refusals, 1, "after a refused judgment request, no other batch is sent");
    judgeOverride = null;

    // Packing: groups that fit are never split, and are packed largest first.
    const groups = [25, 12, 8, 5, 3].map((size, index) => ({ id: `g${index}`, label: `g${index}`, pageIds: Array.from({ length: size }, (_, at) => `g${index}-${at}`) }));
    const many = new Map(groups.flatMap((group) => group.pageIds.map((id, at) => [id, page(at, { id })])));
    const packed = pipeline.judgeBatches(groups, many, new Map(), 20);
    assert.deepEqual(packed.map((batch) => batch.reduce((sum, unit) => sum + unit.judgeIds.length, 0)), [20, 20, 13], "25 + 12 + 8 + 5 + 3 pages: three requests of at most 20");
    assert.deepEqual(packed.flat().flatMap((unit) => unit.judgeIds).sort(), groups.flatMap((group) => group.pageIds).sort(), "every page in exactly one request");
    assert.ok(packed.flat().filter((unit) => unit.cluster.id !== "g0").every((unit) => unit.judgeIds.length === groups.find((group) => group.id === unit.cluster.id).pageIds.length), "a group that fits is never split");
    say("batched judging keeps the guards across batches: a co-published copy (unclear, batch 2) joins its origin (batch 1) with the partner note; a coin-flip origin stays unresolved; a cited parent in another batch wins; an unreadable batch leaves its pages unresolved, more than a quarter stops the run; groups that fit are never split");
  }

  // 4. Cache: a Deep run and a Standard run of the same claim never answer for each other.
  {
    freshLedger();
    resetSent();
    const claim = `${CLAIM} cache check`;
    const deep = await pipeline.analyzeClaim(claim, () => {}, { searchMode: "deep" });
    const standard = await pipeline.analyzeClaim(claim, () => {});
    assert.ok(!standard.cacheHit && standard.searchMode === undefined, "a Standard run is not answered by a cached Deep run");
    const deepAgain = await pipeline.analyzeClaim(claim, () => {}, { searchMode: "deep" });
    assert.ok(deepAgain.cacheHit && deepAgain.searchMode === "deep" && deep.pages.length === deepAgain.pages.length, "a second Deep run of it opens the cached Deep run");
    const standardAgain = await pipeline.analyzeClaim(claim, () => {});
    assert.ok(standardAgain.cacheHit && standardAgain.searchMode === undefined, "and a second Standard run the Standard one");
    say("cache: Deep and Standard runs of one claim are cached apart");
  }

  // 5. Standard is unchanged.
  {
    freshLedger();
    resetSent();
    const standard = await run(`${CLAIM} standard`);
    assert.equal(standard.searchMode, undefined, "a Standard trace has no searchMode");
    assert.ok(standard.pages.length <= 20, `at most 20 pages (${standard.pages.length})`);
    assert.ok(sent.searches.length <= 13 && sent.searches.every((body) => body.max_results === (body.search_depth === "advanced" ? 8 : 10)), "10 results a basic search, 8 a deeper one, at most 13 searches");
    assert.equal(sent.grouping[0].max_tokens, 1800, "grouping keeps its 1,800-token limit");
    assert.equal(sent.judge.length, 1, "one judgment request");
    const prompt = sent.judge[0].messages[0].content;
    assert.ok(!prompt.includes("contextPages") && !prompt.includes("This request judges part of the trace"), "the judgment prompt has no batch rule or context pages");
    assert.equal(progressEvents.find((event) => Array.isArray(event.queries)).queries.length, 10, "10 planned variants");
    // A Deep run whose pages fit one request sends the very same judgment prompt as Standard.
    const fewPages = standard.pages.map((entry) => ({ ...entry, judgment: { kind: "origin", parentId: null, confidence: 0, evidence: "Awaiting source comparison." } }));
    resetSent();
    await pipeline.judgePages(CLAIM, fewPages, standard.clusters, undefined, true);
    await pipeline.judgePages(CLAIM, fewPages, standard.clusters, undefined, true, { batchPages: 20, concurrency: 3 });
    assert.equal(sent.judge.length, 2);
    assert.equal(sent.judge[1].messages[0].content.replace(/Today's date \(UTC\): \S+/, ""), sent.judge[0].messages[0].content.replace(/Today's date \(UTC\): \S+/, ""), "a batched judgment of 20 pages or fewer is the Standard request, byte for byte");
    // A Check these sources run ignores Deep (it searches nothing), and the import check refuses a Deep sources trace.
    const copy = JSON.parse(JSON.stringify(makePortableTrace(deepResult)));
    copy.analysis.searchMode = "wide";
    assert.equal(parsePortableTrace(copy), null, "an unknown searchMode is refused on import");
    const sources = JSON.parse(JSON.stringify(makePortableTrace(deepResult)));
    sources.analysis.sourceCheck = { urls: [sources.analysis.pages[0].url] };
    delete sources.analysis.searchAudit;
    assert.equal(parsePortableTrace(sources), null, "a Deep Check these sources trace is refused");
    say("Standard unchanged: 10 variants, 10/8 results, ≤20 pages, grouping 1,800 tokens, one judgment request without batch rule; a Deep judgment that fits one request is the Standard prompt byte for byte");
  }

  // 6. The route: searchMode is "standard", "deep" or absent, in the JSON body only; anything else is refused before
  //    anything runs, and the status GET knows nothing of it.
  {
    const Module = load("node:module");
    const resolveFilename = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
      return resolveFilename.call(this, request.startsWith("@/") ? path.join(projectRoot, "src", request.slice(2)) : request, ...rest);
    };
    const route = load(path.join(projectRoot, "src", "app", "api", "analyze", "route.ts"));
    const post = (body) => route.POST(new Request("http://echo.test/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const readResult = async (response) => {
      const text = await response.text();
      const frame = text.split("\n\n").find((part) => part.startsWith("event: result"));
      return frame ? JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) : null;
    };
    freshLedger();
    resetSent();
    for (const bad of ["wide", "DEEP", 1, true, null, ["deep"]]) {
      const response = await post({ claim: `${CLAIM} route`, searchMode: bad });
      assert.equal(response.status, 400, `searchMode ${JSON.stringify(bad)} is refused`);
      assert.equal((await response.json()).code, "SEARCH_MODE_INVALID");
    }
    assert.equal(sent.searches.length + sent.telem.length, 0, "a refused mode sends nothing");
    const deep = await readResult(await post({ claim: `${CLAIM} route`, searchMode: "deep", forceFresh: true }));
    assert.ok(deep?.searchMode === "deep" && deep.pages.length > 20, "searchMode \"deep\" makes a Deep run");
    const standard = await readResult(await post({ claim: `${CLAIM} route standard`, searchMode: "standard", forceFresh: true }));
    const plain = await readResult(await post({ claim: `${CLAIM} route plain`, forceFresh: true }));
    assert.ok(standard && plain && standard.searchMode === undefined && plain.searchMode === undefined && standard.pages.length <= 20 && plain.pages.length <= 20, "\"standard\" and no searchMode make a Standard run");
    const status = await (await route.GET(new Request("http://echo.test/api/analyze?searchMode=deep&deep=1"))).json();
    assert.ok(!JSON.stringify(status).includes("searchMode"), "the status GET says nothing of a mode, whatever its URL");
    Module._resolveFilename = resolveFilename;
    say("route: searchMode \"deep\" makes a Deep run; \"standard\" or none a Standard one; any other value is SEARCH_MODE_INVALID before anything is sent");
  }

  process.stdout.write(`Deep search passed: >20 pages (50), ≤16 searches at 20 results, Telem ≤16 with Tavily fallback, batched judging with every guard, receipt = caps' charges, trace round-trip, cache apart, Standard unchanged; no provider calls (${sent.other} page requests answered 404 by the mock).\n`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.chdir(os.tmpdir());
  fs.rmSync(scratch, { recursive: true, force: true });
}
