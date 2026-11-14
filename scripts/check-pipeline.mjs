import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "echo-pipeline-check-"));
process.chdir(temporaryDirectory);

load.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(code, filename);
};

process.env.ANTHROPIC_API_KEY = "local-test-key";
process.env.TAVILY_API_KEY = "local-test-key";
// Tavily is the router these checks mock; the Telem router has its own check (check-pipeline-telem.mjs).
delete process.env.TELEM_API_KEY;
delete process.env.ECHO_SEARCH_ROUTER;
process.env.ANTHROPIC_MODEL = "claude-sonnet-5-5";
process.env.ANTHROPIC_CLASSIFIER_MODEL = "claude-sonnet-5-5";
process.env.ANTHROPIC_ANSWER_MODEL = "claude-sonnet-5-5";
// One cap per provider (daily-budget.ts); the retired single-cap settings must change nothing.
process.env.ECHO_CLAUDE_DAILY_CAP_USD = "2";
process.env.ECHO_TAVILY_DAILY_CAP_USD = "2";
process.env.ECHO_TELEM_DAILY_CAP_USD = "2";
delete process.env.ECHO_ANTHROPIC_DAILY_CAP_USD;
delete process.env.ECHO_DAILY_CAP_OVERRIDE_USD;
process.env.ECHO_TAVILY_RETRY_DELAY_MS = "1";
process.env.ECHO_CLAUDE_RETRY_DELAY_MS = "1";
process.env.ECHO_TAVILY_USD_PER_CREDIT = "0.001";
delete process.env.VERCEL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const urls = [
  "https://source.example/startups",
  "https://repeat.example/startups",
  "https://other.example/coffee",
];
const searchResults = [
  { url: urls[0], title: "90% of startups fail original data", content: "90% of startups fail in this dataset", published_date: "2020-01-01", score: 0.9 },
  { url: urls[1], title: "90% of startups fail repeated", content: "90% of startups fail, according to the original", published_date: "2021-01-01", score: 0.8 },
  { url: urls[2], title: "90% of startup founders prefer coffee", content: "90% of startup founders prefer coffee", published_date: "2022-01-01", score: 0.7 },
];
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
let searchCalls = 0;
let extractCalls = 0;
let modelCalls = 0;
let tokenCounts = 0;
let primaryEvidencePresent = true;
let searchMode = "results";
let answerMode = "valid";
let metadataFetches = 0;
let extractMode = "dated";
let judgeMode = "complete";
// "overloaded-once": the next model call answers 529 once; "overloaded": every model call answers 529.
let modelMode = "ok";
// "busy-once": the next token count answers 429 once.
let countMode = "ok";
const flakyQueriesSeen = new Set();
let onSearch = null;

global.fetch = async (url, options) => {
  if (options?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  const endpoint = String(url);
  if (endpoint.endsWith("/search")) {
    searchCalls += 1;
    onSearch?.();
    const searchBody = JSON.parse(options.body);
    assert.equal(searchBody.include_usage, true, "searches ask Tavily to report credit usage");
    if (searchBody.search_depth === "basic") assert.equal(searchBody.max_results, 10, "basic searches request ten results; Tavily bills per request");
    if (searchMode === "failed") return new Response("unavailable", { status: 503 });
    if (searchMode === "flaky") {
      const query = JSON.parse(options.body).query;
      if (!flakyQueriesSeen.has(query)) {
        flakyQueriesSeen.add(query);
        return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
      }
    }
    if (searchMode === "empty") return json({ results: [] });
    // Ten distinct relevant pages per search, so the basic search stops early after its first five.
    if (searchMode === "many") return json({ results: Array.from({ length: 10 }, (_, index) => ({ url: `https://many${searchCalls}-${index}.example/startups`, title: "90% of startups fail, page-only headline", content: "90% of startups fail, says this page-only paragraph", published_date: "2021-01-01", score: 0.5 })) });
    return json({ results: searchResults });
  }
  if (endpoint.endsWith("/extract")) {
    extractCalls += 1;
    if (extractMode === "ratelimited") return new Response("slow down", { status: 429 });
    if (extractMode === "html-text") return json({ results: [{ url: urls[0], raw_content: "Published: 2020-01-01. 90% of startups fail in this original dataset." }] });
    if (extractMode === "article-cite") return json({ results: [
      { url: urls[0], raw_content: "90% of startups fail in this original dataset." },
      { url: urls[1], raw_content: "90% of startups fail, a new report repeats." },
    ] });
    if (extractMode === "html-links") return json({ results: [
      { url: urls[0], raw_content: "90% of startups fail in this original dataset." },
      { url: urls[1], raw_content: "90% of startups fail, a new report repeats." },
    ] });
    if (extractMode !== "dated") return json({ results: [
      { url: urls[0], raw_content: "90% of startups fail in this original dataset." },
      { url: urls[1], raw_content: `90% of startups fail. Source: ${urls[0]} and ${urls[2]}` },
      { url: urls[2], raw_content: "Published: 2022-01-01. 90% of startup founders prefer coffee." },
    ] });
    return json({ results: [
      { url: urls[0], raw_content: "Published: 2020-01-01. 90% of startups fail in this original dataset." },
      { url: urls[1], raw_content: `Published: 2021-01-01. 90% of startups fail. Source: ${urls[0]} and ${urls[2]}` },
      { url: urls[2], raw_content: "Published: 2022-01-01. 90% of startup founders prefer coffee." },
    ] });
  }
  if (endpoint.endsWith("/count_tokens")) {
    tokenCounts += 1;
    if (countMode === "busy-once") {
      countMode = "ok";
      return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
    }
    const body = JSON.parse(options.body);
    assert.equal(body.output_config?.format?.type, "json_schema", "token estimate must include the output schema");
    return json({ input_tokens: 100 });
  }
  if (endpoint.endsWith("/messages")) {
    modelCalls += 1;
    if (modelMode === "overloaded" || modelMode === "overloaded-once") {
      if (modelMode === "overloaded-once") modelMode = "ok";
      return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), { status: 529, headers: { "retry-after": "0" } });
    }
    const prompt = JSON.parse(options.body).messages[0].content;
    if (prompt.startsWith("Group these")) assert.match(prompt, /never split pages that make the same assertion by page type/, "grouping must not separate originals from their repeats");
    if (prompt.startsWith("Group these")) return json({
      content: [{ type: "text", text: JSON.stringify({ clusters: [
        { label: "Startup failure claim", pageIds: ["page-1", "page-2"], matchesClaim: true },
        { label: "Coffee preference", pageIds: ["page-3"], matchesClaim: false },
      ] }) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    if (prompt.startsWith("You are a cautious")) {
      assert.match(prompt, /"sharedWording":\[/, "the judge receives computed wording signals");
      assert.match(prompt, /"page metadata" come from the page itself/, "the judge is told publisher dates are usable for direction");
      assert.match(prompt, /Today's date \(UTC\): \d{4}-\d{2}-\d{2}\./, "the judge knows today's date so recent pages are not treated as future-dated");
    }
    if (prompt.startsWith("You are a cautious") && judgeMode !== "complete") return json({
      content: [{ type: "text", text: JSON.stringify({ judgements: judgeMode === "missing-one"
        ? [{ pageId: "page-1", kind: "origin", parentId: null, confidence: 80, evidence: "Original data.", hasPrimaryEvidence: true, primaryEvidenceReason: "Contains the dataset." }]
        : judgeMode === "unsure-origin"
          ? [
            { pageId: "page-1", kind: "origin", parentId: null, confidence: 45, evidence: "Explainer with its own framing; no cluster page cited.", hasPrimaryEvidence: false, primaryEvidenceReason: "Restates the figure." },
            { pageId: "page-2", kind: "derived", parentId: "page-1", confidence: 85, evidence: "Names the earlier source.", hasPrimaryEvidence: false, primaryEvidenceReason: "Repeats the number." },
          ]
          : [] }) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    if (prompt.startsWith("You are a cautious")) return json({
      content: [{ type: "text", text: JSON.stringify({ judgements: [
        { pageId: "page-1", kind: "origin", parentId: null, confidence: 80, evidence: "Original data.", hasPrimaryEvidence: primaryEvidencePresent, primaryEvidenceReason: primaryEvidencePresent ? "Contains the dataset." : "No supporting dataset appears in this passage." },
        { pageId: "page-2", kind: "derived", parentId: "page-1", confidence: 85, evidence: "Names the earlier source.", hasPrimaryEvidence: false, primaryEvidenceReason: "Repeats the number." },
      ] }) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    if (prompt.startsWith("Answer the")) return json({
      content: [{ type: "text", text: JSON.stringify({ claims: [{ text: "The source says so", sourceNumbers: [answerMode === "invalid" ? 99 : 1] }] }) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    throw new Error("Unexpected model prompt");
  }
  if ((extractMode === "metadata" || extractMode === "html-links" || extractMode === "html-text" || extractMode === "article-cite") && (endpoint === urls[0] || endpoint === urls[1])) {
    metadataFetches += 1;
    const published = endpoint === urls[0] ? "2020-01-01" : "2021-01-01";
    const articleBody = extractMode === "article-cite" ? `<p>${"Startup outcomes vary a lot by sector and region, and most surveys disagree on the exact share. ".repeat(4)}</p><h3>References</h3><p>Source Startup Survey (2020). Original dataset of founders.</p>` : extractMode === "html-text" ? `<p>${"A new report repeats that 90% of startups fail, citing the original dataset from 2020 without adding data. ".repeat(6)}</p>` : "";
    const body = endpoint === urls[1] ? `<body><nav><a href="${urls[2]}">menu</a></nav><article>${articleBody}${extractMode === "article-cite" ? "" : `<a href="${urls[0]}">original dataset</a>`}</article></body>` : "<body></body>";
    return new Response(`<html><head><meta property="article:published_time" content="${published}T09:00:00Z"></head>${body}</html>`, { status: 200, headers: { "content-type": "text/html" } });
  }
  if (endpoint === "https://hop.example/to-metadata") return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
  if (endpoint === "https://hop.example/to-public") return new Response("", { status: 301, headers: { location: "/final" } });
  if (endpoint === "https://hop.example/final") return new Response(`<html><head><meta property="article:published_time" content="2015-05-05"></head></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (endpoint.startsWith("http://169.254.")) throw new Error("the metadata address must never be requested");
  if (endpoint.startsWith("https://meta.example/")) {
    metadataFetches += 1;
    if (endpoint.endsWith("/jsonld")) return new Response(`<html><head><script type="application/ld+json">{"@type":"NewsArticle","dateModified":"2024-05-05","datePublished":"2019-03-04T10:00:00Z"}</script></head><body>x</body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    if (endpoint.endsWith("/meta")) return new Response(`<html><head><meta property="article:modified_time" content="2024-01-01"><meta property="article:published_time" content="2018-07-09T08:00:00+00:00"></head></html>`, { status: 200, headers: { "content-type": "text/html" } });
    if (endpoint.endsWith("/pdf")) return new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } });
    if (endpoint.endsWith("/missing")) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return new Response(`<html><head><title>No date</title></head></html>`, { status: 200, headers: { "content-type": "text/html" } });
  }
  throw new Error(`Unexpected network destination: ${endpoint}`);
};

const dateOnly = ({ date, source }) => (source === undefined ? { date } : { date, source });
async function main() {
  const pipelineModule = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  const { composeRootAnswer, dateFrom, fetchPublishedMetadata, isContinuouslyEditedPage, isFetchablePublicUrl, metadataDate, safeJudgment, selectAnswerRoots, sharedWordingSignals } = pipelineModule;
  // Every trace the pipeline produces must load again (export/import, session restore, copy hunt).
  // Live runs on 2026-11-12 produced traces the import check rejected after citation rules changed.
  const { makePortableTrace, parsePortableTrace } = load(path.join(projectRoot, "src/lib/echo/portable.ts"));
  let tracesChecked = 0;
  const analyzeClaim = async (...args) => {
    const result = await pipelineModule.analyzeClaim(...args);
    assert.ok(parsePortableTrace(JSON.parse(JSON.stringify(makePortableTrace(result)))), `a pipeline trace for "${result.claim}" must load again after export`);
    tracesChecked += 1;
    return result;
  };
  assert.deepEqual(dateOnly(dateFrom(null, "", "https://news.example/2020-11-08/report")), { date: "2020-11-08", source: "URL date" });
  assert.deepEqual(dateOnly(dateFrom(null, "", "https://news.example/2020/11/08/report")), { date: "2020-11-08", source: "URL date" });
  assert.deepEqual(dateOnly(dateFrom(null, "", "https://news.example/report?redirect=/2020/11/08/report")), { date: null });
  assert.deepEqual(dateOnly(dateFrom(null, "", "https://www.theguardian.com/lifeandstyle/2020/nov/08/report")), { date: "2020-11-08", source: "URL date" }, "a word month in the URL path is a URL date");
  assert.deepEqual(dateOnly(dateFrom(null, "", "https://news.example/2020/feb/30/report")), { date: null }, "an impossible word-month URL date is refused");
  assert.deepEqual(dateOnly(dateFrom(null, "", "https://news.example/2020/may/report")), { date: null }, "a URL month without a day is not a date");
  assert.equal(dateFrom(null, "", "https://www.theguardian.com/science/2020/nov/08/report").evidence, "URL path /2020/nov/08");
  // 11/11 labels: day-first dates after a publishing cue, and Q&A "answered by ... on <date>" pages.
  assert.deepEqual(dateOnly(dateFrom(null, "Myth or fact. Published 20 November 2021 by the lab.", "https://lab.example/myth")), { date: "2021-11-20", source: "page text" });
  assert.deepEqual(dateOnly(dateFrom(null, "Question asked by Ruthenium. Answered by Jason, Nathan, Sophie on 20 Mar 2013. Also asked", "https://qa.example/q")), { date: "2013-03-20", source: "page text" });
  assert.deepEqual(dateOnly(dateFrom(null, "Answered by Sophie on March 20, 2013.", "https://qa.example/q")), { date: "2013-03-20", source: "page text" });
  assert.deepEqual(dateOnly(dateFrom(null, "Last updated 20 November 2021. Read more.", "https://lab.example/myth")), { date: null }, "an updated date is not a publication date");
  assert.deepEqual(dateOnly(dateFrom(null, "A study from 20 November 2021 found this.", "https://lab.example/myth")), { date: null }, "a bare date without a cue is not used");
  assert.deepEqual(dateOnly(dateFrom(null, "", "https://news.example/2020-02-30/report")), { date: null });
  assert.deepEqual(dateOnly(dateFrom("2022-01-01", "Published: 2020-11-08", "https://news.example/2021-01-01/report")), { date: "2020-11-08", source: "page text" });
  assert.deepEqual(dateOnly(dateFrom("2022-01-01", `<meta property="article:published_time" content="2020-11-08T09:00:00Z">`, "https://news.example/report")), { date: "2020-11-08", source: "page text" });
  assert.deepEqual(dateOnly(dateFrom(null, `<meta content="2020-11-08" property="article:published_time">`, "https://news.example/report")), { date: "2020-11-08", source: "page text" });
  assert.deepEqual(dateOnly(dateFrom(null, `<time datetime="2020-11-08" itemprop="datePublished">8 November 2020</time>`, "https://news.example/report")), { date: "2020-11-08", source: "page text" });
  assert.deepEqual(dateOnly(dateFrom(null, `${"x".repeat(1200)}<meta itemprop="datePublished" content="2020-11-08">`, "https://news.example/report")), { date: "2020-11-08", source: "page text" });
  assert.deepEqual(dateOnly(dateFrom("2022-01-01", `<meta property="article:modified_time" content="2024-02-02">`, "https://news.example/report")), { date: "2022-01-01", source: "Tavily estimate" });
  assert.deepEqual(dateOnly(dateFrom("2022-01-01", `<meta property="article:published_time" content="2020-02-30">`, "https://news.example/report")), { date: "2022-01-01", source: "Tavily estimate" });
  assert.equal(metadataDate(`<head><meta name="parsely-pub-date" content="2017-02-03T00:00:00Z"></head>`), "2017-02-03");
  assert.equal(metadataDate(`<head><meta property="article:modified_time" content="2024-02-02"></head>`), null, "an updated date is not a publication date");
  assert.equal(metadataDate(`<head><meta name="date" content="2021-02-30"></head>`), null, "an impossible date is rejected");
  assert.equal(metadataDate(`<head></head><body><time pubdate datetime="2016-06-01T12:00">June</time></body>`), "2016-06-01");
  assert.equal(metadataDate(`<head></head><script type="application/ld+json">{"datePublished": "Jul 13, 2026","dateModified":"Jul 14, 2026"}</script>`), "2026-07-13", "month-name schema dates are read");
  assert.equal(metadataDate(`<head><meta name="date" content="Mon, 09 Mar 2020 08:00:00 GMT"></head>`), "2020-03-09");
  assert.equal(metadataDate(`<head><meta name="date" content="13 July 2026"></head>`), "2026-07-13");
  assert.equal(metadataDate(`<head></head><body>${"x".repeat(60000)}<script>self.state={"@type":"Article","datePublished":"2026-01-12"}</script></body>`), "2026-01-12", "schema dates outside JSON-LD scripts are read");
  assert.equal(metadataDate(`<head><meta name="date" content="Smarch 40, 2020"></head>`), null);
  const nextYear = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(metadataDate(`<head><meta property="article:published_time" content="${nextYear}T09:00:00Z"></head>`), null, "a publication date more than two days ahead is not trusted");
  assert.equal(dateFrom(null, "Event on " + nextYear, `https://news.example/${nextYear.replaceAll("-", "/")}/event`).date, null, "a future URL date is not trusted");
  // Live check 2026-11-12: WebMD's 2011 interview writes its JSON-LD date US-style, so Echo fell back to a 2026 estimate.
  const webmdHead = (lang) => `<html lang="${lang}"><head><script type="application/ld+json">{"@type":"Article","dateModified":"01/04/2011 19:00:00","datePublished":"01/04/2011 19:00:00"}</script></head></html>`;
  assert.equal(metadataDate(webmdHead("en")), "2011-01-04", "an English page's 01/04/2011 is read as January 4");
  assert.match(load(path.join(projectRoot, "src/lib/echo/pipeline.ts")).metadataDateDetail(webmdHead("en")).field, /month\/day as in US dates/, "an assumed day/month order is shown in the date evidence");
  assert.equal(metadataDate(webmdHead("fr")), null, "an ambiguous day/month order on a non-English page is refused");
  assert.equal(metadataDate(`<html lang="en-GB"><head><script type="application/ld+json">{"datePublished":"25/04/2011"}</script></head></html>`), "2011-04-25", "an unambiguous day-first date is read on any page");
  assert.equal(metadataDate(`<html lang="en-GB"><head><script type="application/ld+json">{"datePublished":"01/04/2011"}</script></head></html>`), null, "British pages are not assumed month-first");
  assert.equal(metadataDate(`<html lang="en"><head></head><body><script>x={"datePublished":"01\\u002F04\\u002F2011 19:00:00"}</script></body></html>`), "2011-01-04", "escaped slashes in framework state are read");
  // Live run 2026-11-12 (knuckle cracking): PMC gives the 1990 study's date as "1990 May" only.
  assert.equal(metadataDate(`<head><meta name="citation_publication_date" content="1990 May"></head>`), "1990-05-01", "a journal issue month is read as its first day");
  assert.equal(metadataDate(`<head><meta name="citation_publication_date" content="2011 Mar-Apr"></head>`), "2011-03-01");
  assert.equal(metadataDate(`<head><meta name="citation_date" content="2011/03"></head>`), "2011-03-01");
  assert.equal(metadataDate(`<head><meta name="date" content="1990 May"></head>`), null, "only journal citation fields get month-only dates");
  assert.equal(metadataDate(`<head><meta name="citation_publication_date" content="2011 Smarch"></head>`), null);
  // YouTube puts its microdata in the body.
  assert.equal(metadataDate(`<html><head><title>v</title></head><body><div itemscope><meta itemprop="uploadDate" content="2025-09-11T09:01:14-07:00"></div></body></html>`), "2025-09-11", "a video's upload date in page microdata is its publication date");
  assert.equal(isContinuouslyEditedPage("https://en.wikipedia.org/wiki/Ten_percent_of_brain_myth"), true, "a wiki creation date is not a passage date");
  assert.equal(isContinuouslyEditedPage("https://example.org/wiki/Topic"), true);
  assert.equal(isContinuouslyEditedPage("https://www.scientificamerican.com/article/x/"), false);
  assert.equal(await fetchPublishedMetadata("https://en.wikipedia.org/wiki/Anything"), null);
  assert.equal(isFetchablePublicUrl("https://news.example/a"), true);
  for (const blocked of ["http://localhost:3000/x", "http://127.0.0.1/x", "http://10.0.0.5/x", "http://192.168.1.1/", "http://169.254.169.254/latest", "file:///etc/passwd", "http://[::1]/", "https://user:pw@news.example/", "http://intranet/"]) {
    assert.equal(isFetchablePublicUrl(blocked), false, `${blocked} must not be fetched`);
  }
  assert.equal(await fetchPublishedMetadata("https://meta.example/jsonld"), "2019-03-04");
  assert.equal(await fetchPublishedMetadata("https://meta.example/meta"), "2018-07-09");
  assert.equal(await fetchPublishedMetadata("https://meta.example/pdf"), null);
  assert.equal(await fetchPublishedMetadata("https://meta.example/missing"), null);
  assert.equal(await fetchPublishedMetadata("https://meta.example/nodate"), null);
  assert.equal(await fetchPublishedMetadata("https://unreachable.example/x"), null, "a network failure must not stop a trace");
  const fetchesBefore = metadataFetches;
  assert.equal(await fetchPublishedMetadata("https://meta.example/jsonld"), "2019-03-04");
  assert.equal(metadataFetches, fetchesBefore, "repeat metadata lookups reuse the server cache");
  assert.equal(await fetchPublishedMetadata("http://127.0.0.1/meta"), null);
  const wordingPages = [
    { id: "w-1", text: "Researchers at the Harbor Institute tracked 4,000 companies across eleven regional accelerator programs and found that 90% of startups fail." },
    { id: "w-2", text: "A blog repeats it: researchers at the Harbor Institute tracked 4,000 companies across eleven regional accelerator programs, so 90% of startups fail." },
    { id: "w-3", text: "Everyone says 90% of startups fail within the first years, but nobody checks." },
  ];
  const wording = sharedWordingSignals(wordingPages, "90% of startups fail");
  assert.equal(wording.get("w-2")?.[0].pageId, "w-1", "distinctive shared wording is passed to the judge");
  assert.match(wording.get("w-2")[0].phrases[0], /Harbor Institute tracked 4 000 companies/);
  assert.equal(wording.has("w-3"), false, "restating the claim itself is not a derivation signal");
  const restated = sharedWordingSignals([
    { id: "r-1", text: "Myth check: do people really think that humans use only 10 percent of their brains? Imaging shows otherwise." },
    { id: "r-2", text: "Many still believe that humans use only 10 percent of their brains, but scans of sleeping people disagree." },
  ], "Humans use only 10% of their brains");
  assert.equal(restated.size, 0, "spelling out the claim's percentage is still a restatement, not a copy signal");
  const wire = "The city council voted on Tuesday to approve a new transit plan that adds four bus lines, extends service hours past midnight, and funds the changes through a regional sales tax measure passed last spring.";
  const syndication = sharedWordingSignals([
    { id: "wire", text: wire },
    { id: "copy", text: `Local paper: ${wire} Officials said details would follow.` },
    { id: "own", text: "A separate report interviewed riders about the transit plan and found mixed views on the new bus lines and later hours." },
  ], "council approves transit plan");
  assert.ok(syndication.get("copy")[0].pageId === "wire" && syndication.get("copy")[0].overlap >= 0.8, "a syndicated copy has high overlap with its source");
  assert.ok(!syndication.get("own")?.some((entry) => entry.overlap >= 0.2), "independent reporting on the same topic has low overlap");
  const { resolveDateCoverage } = load(path.join(projectRoot, "src/lib/echo/date-coverage.ts"));
  const coverage = await resolveDateCoverage([
    { url: "https://news.example/2021/03/04/story", publishedDate: "2024-01-01" },
    { url: "https://meta.example/meta", publishedDate: "2024-01-01" },
    { url: "https://meta.example/nodate", publishedDate: "2024-01-01" },
    { url: "https://meta.example/missing" },
  ]);
  assert.deepEqual(coverage.rows.map((row) => row.source), ["URL date", "page metadata", "Tavily estimate", null]);
  assert.deepEqual([coverage.trusted, coverage.estimated, coverage.missing], [2, 1, 1], "pre-test separates usable dates from search estimates");
  const { htmlToText, mentionsClaim, scoutPages } = load(path.join(projectRoot, "src/lib/echo/scout.ts"));
  for (const hostile of ["<script>x".repeat(100_000), "<!--x".repeat(200_000), "<a ".repeat(500_000), "<br".repeat(300_000) + ">"]) {
    const started = performance.now();
    htmlToText(hostile);
    assert.ok(performance.now() - started < 1_000, "htmlToText stays linear on hostile HTML (unclosed blocks, comments, runs of <)");
  }
  assert.equal(htmlToText("<p>A &amp; B</p><!-- note --><script>x()</script><br>C"), "A & B. C");
  assert.equal(htmlToText("<html><head><script>var x=1</script><style>p{}</style></head><body><nav>Menu</nav><p>Fish &amp; chips&#39; price</p><p>rose 5%</p></body></html>"), "Fish & chips' price. rose 5%.");
  assert.equal(mentionsClaim("A report says 73% of RAG deployments degrade within months.", "73% of RAG deployments degrade"), true);
  assert.equal(mentionsClaim("Most RAG deployments degrade within months.", "73% of RAG deployments degrade"), false, "the claim's number must appear");
  const story = "The regional transit authority said on Monday that ridership on its new express buses rose 41% in the first quarter, crediting later evening service and a simplified fare structure introduced in January.";
  const scout = scoutPages([
    { url: "https://wire.example/2024/03/04/transit", html: `<html><head></head><body><p>${story}</p></body></html>` },
    { url: "https://paper-a.example/transit", html: `<html><head><meta property="article:published_time" content="2024-03-05T08:00:00Z"></head><body><p>Reposted: ${story}</p></body></html>` },
    { url: "https://blog.example/opinion", html: `<html><head><meta property="article:published_time" content="2024-03-09"></head><body><p>I rode the express buses after ridership rose 41% and found them crowded but quick; my own count on Thursday found every seat taken.</p></body></html>` },
    { url: "https://down.example/x", html: null, status: "HTTP 404" },
  ], "ridership rose 41%");
  assert.equal(scout.fetched, 3);
  assert.equal(scout.relevant, 3);
  assert.equal(scout.usableDates, 3);
  assert.equal(scout.directionalLinks, 1, "the reposted copy links back to the earlier wire story");
  assert.deepEqual([scout.links[0].childId, scout.links[0].parentId], ["p2", "p1"]);
  const original = "Global tech care company Asurion found that Americans check their phones 96 times a day, or once every ten minutes, a twenty percent increase from its previous survey of two thousand adults.";
  const sibling = (n) => ({ id: `s${n}`, publishedDate: "2021-09-28", text: `FOX ${n} — ${original} Station ${n} viewers shared their own habits online, and many said they keep phones at the dinner table.` });
  const syndicated = sharedWordingSignals([{ id: "orig", publishedDate: "2019-11-21", text: original }, sibling(1), sibling(2), sibling(3), sibling(4), sibling(5)], "Americans check their phones 96 times a day");
  assert.equal(syndicated.get("s3")[0].pageId, "orig", "the earlier original is kept even when same-day siblings overlap more");
  assert.equal(dateFrom(null, "", "https://news.example/2020/11/08/report").evidence, "URL path /2020/11/08");
  assert.match(dateFrom(null, "Posted on March 4, 2021 by staff", "https://news.example/report").evidence, /Page says “Posted on March 4, 2021”/);
  assert.match(dateFrom("2022-01-01", "", "https://news.example/report").evidence, /estimate/);
  const { metadataDateDetail } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  assert.deepEqual(metadataDateDetail(`<head><meta property="article:published_time" content="2019-11-21T09:00:00Z"></head>`), { date: "2019-11-21", field: "article:published_time meta tag" });
  // A visible date in an element marked as the publication date (Houston Methodist, Arthritis UK); updated dates are not.
  assert.equal(metadataDateDetail(`<body><span class="blog-metadata-published-date">June 8, 2020</span></body>`)?.date, "2020-06-08");
  assert.equal(metadataDateDetail(`<body><p class="post-date">Published: 30 November 2025</p></body>`)?.date, "2025-11-30");
  assert.equal(metadataDateDetail(`<body><span class="updated-date published-date">June 8, 2024</span></body>`), null, "an updated date is not a publication date");
  assert.equal(metadataDateDetail(`<body><span class="published-date">06/08/2020</span></body>`), null, "a numeric date in an element is ambiguous and not read");
  assert.equal(metadataDateDetail(`<body><ul class="recent"><li class="post-date">May 2, 2024</li><li class="post-date">April 9, 2024</li></ul><span class="post-date">June 8, 2020</span></body>`), null, "marked elements with different dates are a post list, not this page's date");
  assert.equal(metadataDateDetail(`<body><span class="post-date">June 8, 2020</span><p>Story</p><div class="post-date">June 8, 2020</div></body>`)?.date, "2020-06-08", "the same date shown twice is still the page's date");
  assert.equal(metadataDateDetail(`<body><span class="price">June 8, 2020</span></body>`), null, "a date in an unmarked element is not read");
  const { findCitations, linkCitedUndatedPages, outboundLinks, linkKey, fetchOutboundLinks, fetchPageFacts, samePageKey, articleText, indexRecordsAsCopies, movedArticleLink, isPrivateAddress, fetchPublicPage, relevantPassage, generateQueries, searchClaimText, isRelevantSearchResult, spelledNumber, stripSideContent, pageDoi, videoDescriptionLinks } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  const citedRelease = { id: "rel", url: "https://www.asurion.com/press-releases/americans-check-their-phones-96-times-a-day", domain: "asurion.com", title: "Americans Check Their Phones 96 Times a Day - Asurion", publishedDate: "2019-11-21", publishedDateSource: "page metadata", text: "release", judgment: { kind: "origin", parentId: null, confidence: 80, evidence: "x" } };
  const social = { id: "ig", url: "https://www.instagram.com/p/x", domain: "instagram.com", title: "post", publishedDate: "2025-11-11", publishedDateSource: "Tavily estimate", text: "short passage", judgment: { kind: "unclear", parentId: null, confidence: 40, evidence: "estimated date" } };
  const reference = { id: "ref", url: "https://refs.example/asurion2019", domain: "refs.example", title: "ref", publishedDate: null, text: "passage", judgment: { kind: "unclear", parentId: null, confidence: 40, evidence: "undated" } };
  const unrelated = { id: "other", url: "https://blog.example/x", domain: "blog.example", title: "x", publishedDate: null, text: "x", judgment: { kind: "unclear", parentId: null, confidence: 30, evidence: "undated" } };
  const fullText = new Map([
    ["ig", "We check our phones every 10 minutes, 96 times a day on average, according to research by Asurion in 2019."],
    ["ref", "APA Citation. Asurion, . (2019). Americans Check Their Phones 96 Times a Day. Summary of the industry survey."],
    ["other", "Asurion released a new phone survey in 2022 with different numbers."],
  ]);
  const cites = findCitations([citedRelease, social, reference, unrelated], fullText, "Americans check their phones 96 times a day");
  assert.equal(cites.get("ig")?.[0]?.pageId, "rel", "organization name next to the cited page's year is a citation");
  assert.equal(cites.get("ig")?.[0]?.how, "name and year");
  assert.ok(cites.get("ref")?.some((c) => c.pageId === "rel" && (c.how === "title" || c.how === "name and year")), "an exact title citation is found");
  assert.equal(cites.has("other"), false, "naming the organization with a different year is not a citation of this page");
  const claimTitled = findCitations([citedRelease, reference], new Map([["ref", "Everyone repeats that Americans check their phones 96 times a day, but who measured it?"]]), "Americans check their phones 96 times a day");
  assert.equal(claimTitled.has("ref"), false, "quoting a title that is just the claim is not a citation");
  // 11/10 brain-trace labels: "Scientific American" (spaced) names scientificamerican.com, and a reference entry
  // "(2008). <title>" cites a page even when its title sounds like the claim.
  const sciam = { id: "sa", url: "https://www.scientificamerican.com/article/do-people-only-use-10-percent-of-their-brains", domain: "scientificamerican.com", title: "Do People Only Use 10 Percent Of Their Brains? | Scientific American", publishedDate: "2008-02-07", publishedDateSource: "page metadata", text: "interview", judgment: { kind: "origin", parentId: null, confidence: 80, evidence: "x" } };
  const brainClaim = "Humans use only 10% of their brains";
  const wiki = { ...unrelated, id: "wiki", domain: "en.wikipedia.org", url: "https://en.wikipedia.org/wiki/Ten-percent-of-the-brain_myth" };
  const mnt = { ...unrelated, id: "mnt", domain: "medicalnewstoday.com", url: "https://www.medicalnewstoday.com/articles/321060" };
  const spaced = findCitations([sciam, wiki], new Map([["wiki", "References: \"Do People Only Use 10 Percent Of Their Brains?\". Scientific American, 7 February 2008."]]), brainClaim);
  assert.equal(spaced.get("wiki")?.[0]?.pageId, "sa", "a spaced organization name next to the year is a citation");
  const refEntry = findCitations([sciam, mnt], new Map([["mnt", "Brain basics. (2023). Boyd, R. (2008). Do people only use 10 percent of their brains? Carnegie, D. (1936)."]]), brainClaim);
  assert.equal(refEntry.get("mnt")?.[0]?.how, "title", "a reference entry with the cited page's year and title is a citation");
  // Live run 2026-11-12 ("Only 2% of the world's population has green eyes"): AARP's own headline matched
  // Glasses.com's generic question title and was taken as a citation.
  const glasses = { id: "gl", url: "https://www.glasses.com/gl-us/blog/rarest-eye-color", domain: "glasses.com", title: "What Is the Rarest Eye Color? | Glasses.com", publishedDate: "2026-03-27", publishedDateSource: "page metadata", text: "x", judgment: { kind: "unclear", parentId: null, confidence: 0, evidence: "x" } };
  const aarp = { id: "aarp", url: "https://www.aarp.org/health/rarest-eye-color", domain: "aarp.org", title: "What's the Rarest Eye Color, and Why?", publishedDate: null, text: "x", judgment: { kind: "unclear", parentId: null, confidence: 0, evidence: "x" } };
  const eyeClaim = "Only 2% of the world's population has green eyes";
  assert.equal(findCitations([glasses, aarp], new Map([["aarp", "Health # What Is the Rarest Eye Color in the World? ## How many eye colors are there"]]), eyeClaim).has("aarp"), false, "a page's own heading that repeats another page's title is not a citation");
  assert.equal(findCitations([glasses, aarp], new Map([["aarp", "# Eye colors\nSee also: What Is the Rarest Eye Color? (Glasses.com) for more."]]), eyeClaim).get("aarp")?.[0]?.how, "title", "the same title in body text is still a citation");
  const yearElsewhere = findCitations([sciam, mnt], new Map([["mnt", "Do people only use 10 percent of their brains? No. A 2008 survey of teachers found the myth common."]]), brainClaim);
  assert.equal(yearElsewhere.has("mnt"), false, "a claim-like title with the year in another sentence is not a citation");
  // 11/11 live brain run: "according to an interview ... in Scientific American" credits the publisher without a year.
  const credit = "But this is just a myth, according to an interview with neurologist Barry Gordon in Scientific American. He explained";
  const datedMnt = { ...mnt, publishedDate: "2018-02-27", publishedDateSource: "page metadata" };
  assert.equal(findCitations([sciam, datedMnt], new Map([["mnt", credit]]), brainClaim).get("mnt")?.[0]?.how, "named as source", "a dated later page crediting the publisher by name is a citation");
  assert.equal(findCitations([sciam, mnt], new Map([["mnt", credit]]), brainClaim).has("mnt"), false, "a bare name never counts for an undated page");
  assert.equal(findCitations([sciam, { ...datedMnt, publishedDate: "2006-01-01" }], new Map([["mnt", credit]]), brainClaim).has("mnt"), false, "a page dated before the source cannot cite it");
  assert.equal(findCitations([sciam, datedMnt], new Map([["mnt", "I read Scientific American as a kid and loved the brain issues."]]), brainClaim).has("mnt"), false, "a mention without a credit phrase is not a citation");
  const namedOnly = { ...mnt, citations: [{ pageId: "sa", how: "named as source", quote: "according to ... Scientific American" }], judgment: { kind: "unclear", parentId: null, confidence: 40, evidence: "undated" } };
  assert.equal(linkCitedUndatedPages([sciam, namedOnly], new Map([["mnt", new Set(["sa", "mnt"])], ["sa", new Set(["sa", "mnt"])]]))[1].judgment.kind, "unclear", "a name-only citation never links an undated page");
  const foxStory = { ...citedRelease, id: "fox", domain: "fox13seattle.com", url: "https://www.fox13seattle.com/news/x", title: "Americans check their smartphones 96 times a day, survey says | FOX 13 Seattle", publishedDate: "2021-09-28" };
  const blogCites = findCitations([foxStory, reference], new Map([["ref", "Sources. Chris Williams, “Americans Check Their Smartphones 96 Times a Day, Survey Says,” Fox 5, September 28, 2021."]]), "Americans check their phones 96 times a day");
  assert.equal(blogCites.get("ref")?.[0]?.how, "title", "a distinctive cited title still counts");
  assert.match(blogCites.get("ref")[0].quote, /Chris Williams, “Americans Check Their Smartphones/, "the quote shows the citation itself");
  assert.equal(findCitations([citedRelease, { ...social, id: "fb", domain: "facebook.com" }], new Map([["rel", "Shared on facebook.com in 2019"]])).has("rel"), false, "generic platforms are not organizations to cite");
  const cluster = new Map([["rel", new Set(["rel", "ig", "ref", "other"])], ["ig", new Set(["rel", "ig", "ref", "other"])], ["ref", new Set(["rel", "ig", "ref", "other"])], ["other", new Set(["rel", "ig", "ref", "other"])]]);
  const linked = linkCitedUndatedPages([citedRelease, { ...social, citations: cites.get("ig") }, { ...reference, citations: cites.get("ref") }, unrelated], cluster);
  assert.deepEqual(linked.map((page) => [page.id, page.judgment.kind, page.judgment.parentId]), [["rel", "origin", null], ["ig", "derived", "rel"], ["ref", "derived", "rel"], ["other", "unclear", null]]);
  assert.match(linked[1].judgment.evidence, /cannot cite something published after it/);
  const citedJudgment = safeJudgment({ kind: "derived", parentId: "rel", confidence: 70, evidence: "Cites Asurion 2019." }, { ...reference, citations: cites.get("ref") }, new Map([["rel", citedRelease], ["ref", reference]]), new Set(["rel", "ref"]));
  assert.equal(citedJudgment.kind, "derived", "a verified citation can stand in for a missing date");
  assert.equal(safeJudgment({ kind: "derived", parentId: "rel", confidence: 70, evidence: "x" }, reference, new Map([["rel", citedRelease], ["ref", reference]]), new Set(["rel", "ref"])).kind, "unclear", "without a verified citation an undated page stays unresolved");
  // Live run 2026-11-10: the reference page's extracted text dropped its APA header; only the title names Asurion 2019.
  const titledRef = { ...reference, title: "Asurion, . (2019) | References | Narcissus and the Child" };
  const titleCites = findCitations([citedRelease, titledRef], new Map([["ref", "## Summary This industry survey documented that the average American checks their phone 96 times per day."]]), "Americans check their phones 96 times a day");
  assert.equal(titleCites.get("ref")?.[0]?.pageId, "rel", "an organization and year in the citing page's title is a citation");
  assert.match(titleCites.get("ref")[0].quote, /^Page title: Asurion, \. \(2019\)/);
  assert.equal(findCitations([citedRelease, { ...titledRef, title: "Asurion (2022) survey notes" }], new Map([["ref", "summary"]])).has("ref"), false, "a title naming a different year is not a citation");
  // Live run 2026-11-11: WebMD's 2011 interview carried only a search-estimated 2026 date, so the 2021 page that
  // lists its title as a source could not be linked to it.
  const webmd = { id: "wmd", url: "https://www.webmd.com/a-to-z-guides/features/do-we-really-lose-most-of-our-heat-through-our-heads", domain: "webmd.com", title: "Do We Really Lose Most of Our Heat Through Our Heads? - WebMD", publishedDate: "2026-10-07", publishedDateSource: "Tavily estimate", text: "Ingebretsen interview", hasPrimaryEvidence: false, judgment: { kind: "origin", parentId: null, confidence: 60, evidence: "x" } };
  const meateater = { id: "me", url: "https://www.themeateater.com/x", domain: "themeateater.com", title: "Do You Lose Half of Your Body Heat from Your Head?", publishedDate: "2021-12-28", publishedDateSource: "page metadata", text: "Ingebretsen said", hasPrimaryEvidence: false, judgment: { kind: "unclear", parentId: null, confidence: 40, evidence: "x" } };
  const heatClaim = "You lose most of your body heat through your head";
  const heatSources = "Sources: Do We Really Lose Most of Our Heat Through Our Heads? WebMD, Richard Ingebretsen.";
  const reverseCites = findCitations([webmd, meateater], new Map([["me", heatSources]]), heatClaim);
  assert.equal(reverseCites.get("me")?.[0]?.pageId, "wmd", "a dated page naming the title of an estimate-dated page cites it");
  // A stock opening line that happens to be a post's title is not a citation of that post (brain trace: a 2021 video
  // "citing" a Facebook post whose only date is a 2026 estimate).
  const fbPost = { ...webmd, id: "fb", url: "https://www.facebook.com/BrainAwarenessWeek/videos/873445291884166", domain: "facebook.com", title: "Have you heard that we only use 10% of our brains? It's a myth! ..." };
  const video = { ...meateater, id: "yt", url: "https://www.youtube.com/watch?v=VwrdPEdJv9g", domain: "youtube.com", title: "The Ten Percent Brain Myth" };
  const stockLine = findCitations([fbPost, video], new Map([["yt", "So, have you heard that we only use 10% of our brains? Let's look at the scans."]]), "Humans use only 10% of their brains");
  assert.equal(stockLine.has("yt"), false, "a claim-like title made of filler words, with no publisher named, is not a citation");
  assert.equal(reverseCites.get("me")[0].how, "title");
  // A publisher whose name is a common word (history.com → "history") is not "named" by that word in passing.
  const historyCom = { ...webmd, id: "hist", url: "https://www.history.com/articles/did-vikings-really-wear-horned-helmets", domain: "history.com", title: "Did Vikings Really Wear Horned Helmets? | HISTORY", publishedDate: "2019-03-01", publishedDateSource: "page metadata" };
  const vikingBlog = { ...meateater, id: "vb", url: "https://blog.example/vikings", domain: "blog.example", title: "Viking helmets", publishedDate: "2022-05-05" };
  const vikingClaim = "Vikings wore horned helmets";
  assert.equal(findCitations([historyCom, vikingBlog], new Map([["vb", "So, did Vikings really wear horned helmets? Viking history says no."]]), vikingClaim).has("vb"), false, "the word history beside a stock question is not a citation of history.com");
  assert.equal(findCitations([historyCom, vikingBlog], new Map([["vb", "Sources: Did Vikings Really Wear Horned Helmets? History.com, 2019."]]), vikingClaim).get("vb")?.[0]?.pageId, "hist", "the site's domain written out still names it");
  assert.equal(findCitations([historyCom, vikingBlog], new Map([["vb", "Helmets found in 2019 changed Viking history for good."]]), vikingClaim).has("vb"), false, "the word history near the year is not history.com and that year");
  assert.equal(findCitations([historyCom, vikingBlog], new Map([["vb", "According to history, Vikings wore plain iron caps."]]), vikingClaim).has("vb"), false, "according to history does not credit history.com");
  assert.equal(findCitations([historyCom, vikingBlog], new Map([["vb", "According to History.com, Vikings wore plain iron caps."]]), vikingClaim).get("vb")?.[0]?.how, "named as source");
  assert.equal(findCitations([webmd, { ...meateater, publishedDateSource: "Tavily estimate" }], new Map([["me", heatSources]]), heatClaim).has("me"), false, "two pages without reliable dates give no order");
  assert.equal(findCitations([webmd, meateater], new Map([["me", "Sources: WebMD, 2011."]]), heatClaim).has("me"), false, "a bare name never links to a page with no reliable date");
  const mutual = findCitations([webmd, meateater], new Map([["me", heatSources], ["wmd", `Related: ${meateater.title} https://www.themeateater.com/x`]]), heatClaim);
  assert.equal(mutual.has("me"), false, "pages linking to each other give no new direction");
  // A written address is a link only when it is the whole address, not the start of a longer one.
  const linkedTarget = { id: "lt", url: "https://news.example.org/story.php?id=1", domain: "news.example.org", title: "Story", publishedDate: "2019-01-01", publishedDateSource: "URL date", text: "x", hasPrimaryEvidence: false, judgment: { kind: "unclear", parentId: null, confidence: 50, evidence: "" } };
  const slugTarget = { ...linkedTarget, id: "st", url: "https://www.science.example/brain", domain: "science.example" };
  const writer = { ...linkedTarget, id: "wr", url: "https://blog.other.net/post", domain: "blog.other.net", publishedDate: "2021-01-01" };
  const citedBy = (target, text) => findCitations([target, writer], new Map([["wr", text]]), brainClaim).get("wr")?.[0]?.how ?? null;
  assert.equal(citedBy(linkedTarget, "See news.example.org/story.php?id=12345 for the report."), null, "a longer query (?id=12345) is another page than ?id=1");
  assert.equal(citedBy(slugTarget, "Read www.science.example/brain-myths-debunked today."), null, "a longer slug is another page");
  assert.equal(citedBy(slugTarget, "Read www.science.example/brain/part-2 today."), null, "a deeper path is another page");
  assert.equal(citedBy(slugTarget, "Source: notwww.science.example/brain"), null, "a longer host is another site");
  assert.equal(citedBy(slugTarget, "Read https://www.science.example/brain."), "link", "an address ending a sentence is a link");
  assert.equal(citedBy(slugTarget, "Read (www.science.example/brain/) and www.science.example/brain?utm_source=x"), "link", "a trailing slash or query still links the page");
  assert.equal(citedBy(linkedTarget, "Seen at news.example.org/story.php?id=12 and https://news.example.org/story.php?id=1&ref=home"), "link", "a later exact mention still counts");
  // Live run 2026-11-12: search text dropped MeatEater's source list, but its HTML still links to WebMD.
  const meHtml = `<html><head><title>x</title></head><body><nav><a href="https://www.webmd.com/nav-only">Health</a></nav><header><a href="https://partner.example/">p</a></header>
    <article><p>Ingebretsen said so.</p><h3>Sources</h3><a href="https://www.webmd.com/a-to-z-guides/features/do-we-really-lose-most-of-our-heat-through-our-heads/?utm_source=x">WebMD</a>
    <a href='/hunting/other-story'>Our other story</a><a href="https://themeateater.com/fishing">own site</a><a href="mailto:a@b.c">mail</a><a href="#top">top</a>
    <a href="https://news.example/a?x=1&amp;y=2">News</a></article><aside><a href="https://sidebar.example/">ad</a></aside><footer><a href="https://footer.example/">f</a></footer><script>var a='<a href="https://script.example/">'</script></body></html>`;
  const meLinks = outboundLinks(meHtml, "https://www.themeateater.com/x");
  assert.deepEqual(meLinks, ["webmd.com/a-to-z-guides/features/do-we-really-lose-most-of-our-heat-through-our-heads", "news.example/a?x=1&y=2"], "only body links to other sites count; nav, header, footer, sidebar, scripts and own-site links are skipped");
  assert.equal(linkKey("http://WWW.WebMD.com/A/"), "webmd.com/a");
  // Redirects are followed by hand so each hop is checked: a public page must not bounce Echo to a private address.
  assert.equal(await fetchPublishedMetadata("https://hop.example/to-metadata"), null, "a redirect to a cloud metadata address is refused before it is requested");
  assert.equal(await fetchPublishedMetadata("https://hop.example/to-public"), "2015-05-05", "an ordinary relative redirect is still followed");
  assert.equal((await fetchPublicPage("https://hop.example/to-public", { headers: {}, signal: AbortSignal.timeout(2000) }))?.finalUrl, "https://hop.example/final");
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateAddress(address), true, `${address} is private`);
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::6810:84e5"]) assert.equal(isPrivateAddress(address), false, `${address} is public`);
  // The same addresses written another way: IPv4-mapped in hex, uncompressed IPv6.
  for (const address of ["::ffff:7f00:1", "::FFFF:a9fe:a9fe", "0:0:0:0:0:0:0:1", "0000::1", "FE80::1"]) assert.equal(isPrivateAddress(address), true, `${address} is private`);
  assert.equal(isPrivateAddress("::ffff:5db8:d822"), false, "a mapped public address is public");
  for (const address of ["192.0.0.170", "198.18.0.1", "198.19.255.1", "192.0.2.5", "198.51.100.7", "203.0.113.9", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "::127.0.0.1", "::7f00:1", "2002:7f00:1::", "2002:c0a8:101::1"]) assert.equal(isPrivateAddress(address), true, `${address} is reserved or carries a private IPv4 address`);
  assert.equal(isFetchablePublicUrl("http://198.18.0.1/page"), false, "a literal reserved IPv4 host is refused by the URL check too");
  assert.equal(isFetchablePublicUrl("https://93.184.216.34/page"), true, "a literal public IPv4 host is allowed");
  for (const address of ["64:ff9b::808:808", "2002:808:808::1", "198.20.0.1", "192.0.3.1"]) assert.equal(isPrivateAddress(address), false, `${address} carries or is a public address`);
  // A fully qualified name ends in a dot; "localhost." is localhost.
  for (const url of ["http://localhost./", "http://LOCALHOST./x", "http://foo.localhost./", "http://metadata.google.internal./", "http://printer.local./", "http://router.local../"]) assert.equal(isFetchablePublicUrl(url), false, `${url} is refused`);
  assert.equal(isFetchablePublicUrl("https://www.example.com./article"), true, "a public name with a trailing dot is still public");
  // Echo fetches arbitrary pages on the server; a malformed page must not stall it (an unclosed-<meta> page took 8 s).
  const hostile = { meta: "<head>" + '<meta name="date" content="'.repeat(20000) + "</head>", scripts: "<body>" + "<script>x".repeat(3000) + "x".repeat(1_400_000) };
  let started = Date.now();
  metadataDate(hostile.meta);
  assert.ok(Date.now() - started < 2000, `a page of unclosed meta tags is read quickly (${Date.now() - started} ms)`);
  started = Date.now();
  outboundLinks(hostile.scripts, "https://site.example/a");
  articleText(hostile.scripts);
  assert.ok(Date.now() - started < 2000, `a page of unclosed script tags is read quickly (${Date.now() - started} ms)`);
  // Unclosed <article>, <p> or JSON-LD blocks made each lazy match rescan to the end of the page: 300 KB took 1.4 s,
  // a 1.5 MB page tens of seconds, all on the server's event loop.
  for (const [label, html, read] of [
    ["<article> tags", "<article>".repeat(160_000), articleText],
    ["<p> tags in an article", `<article>${"<p>x".repeat(370_000)}</article>`, articleText],
    ["<li> tags in main", `<main>${"<li a>".repeat(250_000)}</main>`, articleText],
    ["JSON-LD scripts", '<script type="application/ld+json">x'.repeat(40_000), metadataDate],
    ["'<' characters in a paragraph", `<article><p>${"<a".repeat(750_000)}</p></article>`, articleText],
  ]) {
    started = Date.now();
    read(html);
    assert.ok(Date.now() - started < 500, `a 1.5 MB page of unclosed ${label} is read quickly (${Date.now() - started} ms)`);
  }
  assert.equal(articleText(`<article><p>${"Unclosed lead paragraph ".repeat(5)}<article><p>${"Body text of the article that runs on. ".repeat(12)}</p><pre>code</pre><p>End.</p></article>`)?.startsWith("Unclosed lead paragraph"), true, "an article's text still starts at its first paragraph");
  assert.equal(articleText(`<article><p>${"Kept paragraph text here. ".repeat(20)}</pre></p></article>`)?.includes("</pre>"), false, "a </pre> does not close a <p>");
  assert.equal(metadataDate('<script type="application/ld+json">{"x":1}<script type="application/ld+json">{"datePublished":"2014-03-02"}</script>'), "2014-03-02", "JSON-LD after an unclosed script is still read as before");
  // Vikings labels: Asgard Alaska links History.com's old /news/ address, which now redirects to /articles/.
  assert.equal(movedArticleLink("history.com/articles/did-vikings-really-wear-horned-helmets", new Set(["history.com/news/did-vikings-really-wear-horned-helmets"])), true, "an article moved to another section with the same slug is the same page");
  assert.equal(movedArticleLink("bbc.com/future/article/20130708-is-most-heat-lost-from-your-head", new Set(["bbc.com/future/story/20130708-is-most-heat-lost-from-your-head"])), true);
  assert.equal(movedArticleLink("history.com/articles/did-vikings-really-wear-horned-helmets", new Set(["other.com/news/did-vikings-really-wear-horned-helmets"])), false, "the same slug on another site is not the page");
  assert.equal(movedArticleLink("news.example/2024/05/story", new Set(["news.example/2023/01/story"])), false, "short generic slugs are not matched");
  // Knuckle-cracking labels: the PubMed record of the JABFM 2011 study is a copy of it, not a second origin.
  const jabfmPage = { id: "j", url: "https://www.jabfm.org/content/24/2/169", domain: "jabfm.org", title: "Knuckle Cracking and Hand Osteoarthritis | American Board of Family Medicine", publishedDate: "2011-03-01", publishedDateSource: "page metadata", text: "study", hasPrimaryEvidence: true, primaryEvidenceStatus: "found", judgment: { kind: "origin", parentId: null, confidence: 80, evidence: "Own study." } };
  const pubmedPage = { id: "pm", url: "https://pubmed.ncbi.nlm.nih.gov/21383216", domain: "pubmed.ncbi.nlm.nih.gov", title: "Knuckle cracking and hand osteoarthritis.", publishedDate: "2011-01-01", publishedDateSource: "Tavily estimate", text: "abstract", hasPrimaryEvidence: true, primaryEvidenceStatus: "found", judgment: { kind: "origin", parentId: null, confidence: 80, evidence: "Abstract." } };
  const knuckleGroup = new Map([["j", new Set(["j", "pm"])], ["pm", new Set(["j", "pm"])]]);
  const indexed = indexRecordsAsCopies([jabfmPage, pubmedPage], knuckleGroup);
  assert.deepEqual([indexed[1].judgment.kind, indexed[1].judgment.parentId, indexed[1].hasPrimaryEvidence], ["derived", "j", false], "an index record of an article in the group is a copy of it");
  assert.equal(indexed[0].judgment.kind, "origin");
  const nuvirox = { id: "nv", url: "https://nuvirox.com/knuckles", domain: "nuvirox.com", title: "Does Knuckle Cracking Cause Arthritis?", publishedDate: "2026-09-27", publishedDateSource: "page metadata", text: "x", hasPrimaryEvidence: false, citations: [{ pageId: "j", how: "title", quote: "q" }, { pageId: "pm", how: "title", quote: "q" }], judgment: { kind: "derived", parentId: "pm", confidence: 70, evidence: "Summarizes the PubMed abstract." } };
  const knuckleGroup3 = new Map(["j", "pm", "nv"].map((id) => [id, new Set(["j", "pm", "nv"])]));
  const repointed = indexRecordsAsCopies([jabfmPage, pubmedPage, nuvirox], knuckleGroup3);
  assert.equal(repointed[2].judgment.parentId, "j", "a copy of the index record that also cites the article is linked to the article");
  assert.equal(indexRecordsAsCopies([jabfmPage, pubmedPage, { ...nuvirox, citations: [{ pageId: "pm", how: "title", quote: "q" }] }], knuckleGroup3)[2].judgment.parentId, "pm", "without a citation of the article the judge's parent stays");
  assert.equal(indexRecordsAsCopies([jabfmPage, pubmedPage], new Map([["j", new Set(["j"])], ["pm", new Set(["pm"])]]))[1].judgment.kind, "origin", "an article in a different claim group is not used");
  assert.equal(indexRecordsAsCopies([jabfmPage, { ...pubmedPage, title: "Some other paper about hand osteoarthritis" }], knuckleGroup)[1].judgment.kind, "origin", "a record with a different title is left alone");
  // Search results that write the claim's number out are still relevant.
  assert.equal(spelledNumber(96), "ninety-six");
  assert.equal(spelledNumber(10), "ten");
  assert.equal(isRelevantSearchResult({ title: "Do humans share half their DNA with bananas?", content: "The banana claim explained." }, "Humans share 50% of their DNA with bananas"), true, "'half' matches 50%");
  assert.equal(isRelevantSearchResult({ title: "Do we use only ten percent of our brains?", content: "Neurologists explain the brain myth." }, "Humans use only 10% of their brains"), true, "'ten percent' matches 10%");
  assert.equal(isRelevantSearchResult({ title: "Americans check their phones ninety-six times a day", content: "Survey." }, "Americans check their phones 96 times a day"), true, "'ninety-six' matches 96");
  assert.equal(isRelevantSearchResult({ title: "Do humans share 15 percent of their DNA with bananas?", content: "Banana genetics." }, "Humans share 50% of their DNA with bananas"), false, "a different figure still does not match");
  assert.equal(isRelevantSearchResult({ title: "Americans often check their phones", content: "A survey." }, "Americans check their phones 10 times a day"), false, "'often' does not contain the number ten");
  // "10,000" is one figure: pages write it with or without the comma, as 10K or in words.
  const steps = "You need to walk 10,000 steps a day";
  for (const title of ["Do you really need 10,000 steps a day?", "Why 10000 steps a day?", "The 10K steps a day myth", "Ten thousand steps a day: where it came from", "Is 10 000 steps a day right?"]) {
    assert.equal(isRelevantSearchResult({ title, content: "" }, steps), true, `10,000 matches: ${title}`);
  }
  for (const title of ["Walk 7,000 steps a day", "Walk 100,000 steps a day", "Walk 10,000,000 steps a day", "10 steps a day"]) {
    assert.equal(isRelevantSearchResult({ title, content: "" }, steps), false, `a different figure does not match: ${title}`);
  }
  assert.equal(isRelevantSearchResult({ title: "Earth gets 1.5 million tons of dust", content: "" }, "Earth gains 1.5 million tons of space dust a year"), true, "a decimal is one figure");
  assert.equal(isRelevantSearchResult({ title: "Earth gets 15 million tons of dust", content: "1 or 5 percent" }, "Earth gains 1.5 million tons of space dust a year"), false, "1.5 is not 1 and 5");
  assert.equal(isRelevantSearchResult({ title: "Only 2.5% of people have green eyes", content: "" }, "2.5% of people have green eyes"), true, "a decimal percent");
  assert.equal(isRelevantSearchResult({ title: "A million-dollar idea", content: "One million people" }, "1,000,000 people believe this myth"), true, "one million in words");
  assert.equal(isRelevantSearchResult({ title: "Does sugar cause hyperactivity in children?", content: "" }, "Sugar makes kids hyperactive"), true, "hyperactive matches hyperactivity");
  assert.equal(isRelevantSearchResult({ title: "Sugar prices rise", content: "Sugar costs more this year." }, "Sugar makes kids hyperactive"), false, "one shared word is still not the claim");
  assert.equal(isRelevantSearchResult({ title: "The app has 2,500,000 daily users", content: "" }, "The app has 2.5 million daily users"), true, "2,500,000 is the claim's 2.5 million");
  assert.equal(isRelevantSearchResult({ title: "The app has 2.5 million daily users", content: "" }, "The app has 2,500,000 daily users"), true, "2.5 million is the claim's 2,500,000");
  assert.equal(isRelevantSearchResult({ title: "The app has 3,000,000 daily users", content: "" }, "The app has 2.5 million daily users"), false, "a different figure is still not this claim");
  assert.equal(isRelevantSearchResult({ title: "2.5 million people", content: "" }, "2.5% of people have green eyes"), false, "a plain figure is not the claim's percentage");
  const halfPage = { id: "half", url: "https://genes.example/a", domain: "genes.example", title: "Banana DNA", publishedDate: "2020-01-01", publishedDateSource: "page metadata", text: "Our own sequencing shows people share about half of their genes' structure with bananas.", hasPrimaryEvidence: false, judgment: { kind: "unclear", parentId: null, confidence: 0, evidence: "x" } };
  assert.equal(safeJudgment({ kind: "origin", parentId: null, confidence: 70, evidence: "Own analysis.", hasPrimaryEvidence: false }, halfPage, new Map([["half", halfPage]]), new Set(["half"]), "Humans share 50% of their DNA with bananas").kind, "origin", "a page that writes the claim's figure as 'half' states it");
  assert.equal(safeJudgment({ kind: "origin", parentId: null, confidence: 70, evidence: "x", hasPrimaryEvidence: false }, { ...halfPage, text: "People share many genes with bananas." }, new Map([["half", halfPage]]), new Set(["half"]), "Humans share 50% of their DNA with bananas").kind, "unclear", "a page with no figure at all is still not an origin");
  const usersClaim = "The app has 2.5 million daily users";
  assert.equal(safeJudgment({ kind: "origin", parentId: null, confidence: 70, evidence: "Own count.", hasPrimaryEvidence: false }, { ...halfPage, text: "Our logs count 2,500,000 daily users." }, new Map([["half", halfPage]]), new Set(["half"]), usersClaim).kind, "origin", "2,500,000 states the claim's 2.5 million");
  assert.equal(safeJudgment({ kind: "origin", parentId: null, confidence: 70, evidence: "Own count.", hasPrimaryEvidence: false }, { ...halfPage, text: "Our logs count 2.5 million daily users." }, new Map([["half", halfPage]]), new Set(["half"]), usersClaim).kind, "origin", "the same scaled figure states it");
  // Knuckle labels: Nuvirox cites the JABFM study by DOI in its reference list ("doi: 10.3122/jabfm.2011.02.100156").
  assert.equal(pageDoi('<head><meta name="citation_doi" content="10.3122/jabfm.2011.02.100156" /></head>'), "10.3122/jabfm.2011.02.100156");
  assert.equal(pageDoi('<head><meta name="DC.Identifier" content="https://doi.org/10.1136/ARD.49.5.308"></head>'), "10.1136/ard.49.5.308", "DOI URLs and case are normalized");
  const studyPage = { id: "study", url: "https://www.jabfm.org/content/24/2/169", domain: "jabfm.org", title: "Knuckle Cracking and Hand Osteoarthritis", publishedDate: "2011-03-01", publishedDateSource: "page metadata", text: "x", judgment: { kind: "origin", parentId: null, confidence: 80, evidence: "x" } };
  const blogPage = { id: "blog", url: "https://nuvirox.com/blogs/learn/x", domain: "nuvirox.com", title: "Does cracking knuckles cause arthritis?", publishedDate: "2026-09-27", publishedDateSource: "page metadata", text: "x", judgment: { kind: "unclear", parentId: null, confidence: 0, evidence: "x" } };
  const dois = new Map([["study", "10.3122/jabfm.2011.02.100156"]]);
  const byDoiText = findCitations([studyPage, blogPage], new Map([["blog", "References: J Am Board Fam Med. 2011;24(2):169-174. doi: 10.3122/JABFM.2011.02.100156."]]), "Cracking your knuckles causes arthritis", new Map(), dois);
  assert.equal(byDoiText.get("blog")?.[0]?.pageId, "study", "a DOI in the reference list is a citation of that article");
  assert.equal(byDoiText.get("blog")[0].how, "link");
  assert.equal(findCitations([studyPage, blogPage], new Map([["blog", "x"]]), "Cracking your knuckles causes arthritis", new Map([["blog", ["doi.org/10.3122/jabfm.2011.02.100156"]]]), dois).get("blog")?.[0]?.pageId, "study", "a doi.org link is a citation");
  assert.equal(findCitations([studyPage, blogPage], new Map([["blog", "doi: 10.1136/ard.49.5.308"]]), "Cracking your knuckles causes arthritis", new Map(), dois).has("blog"), false, "a different DOI is not");
  const pubmedRecord = { ...studyPage, id: "pmr", url: "https://pubmed.ncbi.nlm.nih.gov/21383216", domain: "pubmed.ncbi.nlm.nih.gov" };
  const pmcPaper = { ...studyPage, id: "pmc", url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC1004074", domain: "pmc.ncbi.nlm.nih.gov", publishedDate: "1990-05-01" };
  const idCites = findCitations([pubmedRecord, pmcPaper, blogPage], new Map([["blog", "1. Deweber K et al. 2011. PMID: 21383216. 2. Castellanos J. 1990. PMC1004074."]]), "Cracking your knuckles causes arthritis");
  assert.deepEqual((idCites.get("blog") ?? []).map((citation) => citation.pageId).sort(), ["pmc", "pmr"], "PMID and PMC ids in a reference list are citations");
  assert.equal(findCitations([pubmedRecord, blogPage], new Map([["blog", "PMID: 213832160 is another paper"]]), "Cracking your knuckles causes arthritis").has("blog"), false, "a longer id is not a match");
  // Review fixes 11/12 evening.
  // (1) Re-pointing to the article must not put a later-dated article before its copy.
  const laterArticle = { ...jabfmPage, publishedDate: "2024-06-01", publishedDateSource: "page metadata" };
  const earlyRecord = { ...pubmedPage, publishedDate: "2024-03-15", publishedDateSource: "page metadata" };
  const newsCopy = { ...nuvirox, publishedDate: "2024-04-02", citations: [{ pageId: "j", how: "link", quote: "q" }, { pageId: "pm", how: "link", quote: "q" }], judgment: { kind: "derived", parentId: "pm", confidence: 70, evidence: "x" } };
  assert.equal(indexRecordsAsCopies([laterArticle, earlyRecord, newsCopy], knuckleGroup3)[2].judgment.parentId, "pm", "a copy is not re-pointed to an article dated after it");
  // (2) An article derived from its own index record does not form a loop with it.
  const looped = indexRecordsAsCopies([{ ...jabfmPage, judgment: { kind: "derived", parentId: "pm", confidence: 60, evidence: "x" } }, pubmedPage], knuckleGroup);
  assert.deepEqual([looped[0].judgment.kind, looped[0].judgment.parentId, looped[1].judgment.parentId], ["unclear", null, "j"], "the article's link to its own record is dropped");
  const ownDoi = findCitations([{ ...pubmedRecord, publishedDateSource: "page metadata" }, { ...studyPage, publishedDateSource: "Tavily estimate" }], new Map([["study", "Cite as: doi: 10.3122/jabfm.2011.02.100156"]]), "Cracking your knuckles causes arthritis", new Map(), new Map([["study", "10.3122/jabfm.2011.02.100156"], ["pmr", "10.3122/jabfm.2011.02.100156"]]));
  assert.equal(ownDoi.has("study"), false, "a page's own DOI is not a citation of its record");
  assert.equal(findCitations([pubmedRecord, { ...pmcPaper, citations: undefined }], new Map([["pmc", "PMID: 21383216"]]), "x x x").has("pmc"), false, "a PMC page printing its PMID does not cite the PubMed record");
  // (3) Future dates in page text are refused too.
  assert.equal(dateFrom(null, "Published on December 25, 2099. Text.", "https://news.example/a").date, null, "a future written-out date in page text is not trusted");
  // (4) Out-of-range numeric entities do not throw.
  assert.ok(articleText(`<article><p>${"Valid text for an article body here. ".repeat(15)}&#1114112; &#xFFFFFFF;</p></article>`)?.includes("&#1114112;"), "an invalid code point stays as written");
  // (5) Script pages deep in a path keep their query.
  assert.notEqual(samePageKey("https://example.org/news/story.aspx?id=101"), samePageKey("https://example.org/news/story.aspx?id=202"));
  // Comment threads, related-story lists and share bars link to other people's or the site's picks, not the page's sources.
  const withSides = `<article><div class="entry-content"><p>Source: <a href="https://src.example/study">the study</a></p></div><div id="comments"><div class="comment"><div><a href="https://commenter.example/x">my blog</a></div></div></div><ul class="related-posts"><li><a href="https://other.example/y">More</a></li></ul><div class="social-share"><a href="https://twitter.example/share">Tweet</a></div><p>After the widgets.</p></article>`;
  assert.deepEqual(outboundLinks(withSides, "https://site.example/a"), ["src.example/study"], "comments, related lists and share bars are skipped, nested blocks included");
  assert.match(stripSideContent(withSides), /After the widgets/, "content after a skipped block is kept");
  // A YouTube video's sources are in its player data's description, not in <a> tags; search text cuts them short.
  const ytHtml = `<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"hp6BZedPjZU","title":"Head heat","shortDescription":"Mom was wrong.\\n\\nSources:\\n- https://jamaicahospital.org/newsletter/true-or-false-head/\\n- https://www.youtube.com/watch?v=other\\n- see https://src.example/study.","isLive":false}};</script><script>{"shortDescription":"https://recommended.example/not-this-video"}</script>`;
  assert.deepEqual(videoDescriptionLinks(ytHtml, "https://www.youtube.com/shorts/hp6BZedPjZU"), ["jamaicahospital.org/newsletter/true-or-false-head", "src.example/study"], "a video's description links are read; YouTube's own and other videos' links are not");
  assert.deepEqual(videoDescriptionLinks(ytHtml, "https://site.example/a"), [], "only YouTube pages are read this way");
  assert.deepEqual(videoDescriptionLinks(`{"videoDetails":{"shortDescription":"${"x".repeat(20_000)}`, "https://youtube.com/watch?v=a"), [], "an unterminated description is ignored, not scanned to the end");
  // A claim that contains quotation marks must not produce broken quoted-phrase searches.
  for (const query of generateQueries('Einstein said "insanity is doing the same thing over and over"')) {
    const quotes = (query.match(/["“”]/g) ?? []).length;
    assert.ok(quotes === 0 || (quotes === 2 && /^"[^"]+"$/.test(query)), `search query has balanced quoting: ${query}`);
  }
  // A judge may type the claim as a question; searches use the claim's own words.
  assert.equal(searchClaimText("Is it true that goldfish have a 3-second memory?"), "goldfish have a 3-second memory");
  assert.equal(searchClaimText("Do we use only 10% of our brains?"), "we use only 10% of our brains");
  assert.equal(searchClaimText("Did you know that Americans check their phones 96 times a day"), "Americans check their phones 96 times a day");
  assert.equal(searchClaimText("Claim: bulls are angered by the color red."), "bulls are angered by the color red.");
  assert.equal(searchClaimText("Is the Great Wall of China visible from space?"), "the Great Wall of China visible from space");
  assert.equal(searchClaimText("Does it?"), "Does it?", "too little left: keep what was typed");
  assert.equal(searchClaimText("Does sugar make kids hyper"), "Does sugar make kids hyper", "no question mark: a statement's first word is kept");
  for (const claim of ["Humans use only 10% of their brains", "Americans check their phones 96 times a day", "Goldfish have a 3-second memory", "You lose most of your body heat through your head", "Einstein said \"insanity is doing the same thing over and over\""]) {
    assert.equal(searchClaimText(claim), claim, `a plain statement is searched unchanged: ${claim}`);
  }
  assert.deepEqual(generateQueries("Is it true that goldfish have a 3-second memory?"), generateQueries("goldfish have a 3-second memory"), "question and statement search the same queries");
  assert.ok(generateQueries("You need to walk 10,000 steps a day").includes("\"10,000 steps a day\""), "the quoted search keeps 10,000 whole");
  assert.equal(searchClaimText("Saw this on twitter: https://x.com/foo/status/123 says 70% of the ocean is unexplored"), "70% of the ocean is unexplored", "where the judge saw it, and the pasted link, are not searched");
  assert.equal(searchClaimText("I read on Reddit that bulls hate the color red"), "bulls hate the color red");
  assert.equal(searchClaimText("Napoleon was really short 🤔"), "Napoleon was really short", "emoji are not searched");
  assert.equal(searchClaimText("Found on Mars: water ice at the poles"), "Found on Mars: water ice at the poles", "a place that is part of the claim is kept");
  assert.equal(searchClaimText("Read in a 2019 study: 10% of brain is used"), "Read in a 2019 study: 10% of brain is used", "a named study is part of the claim");
  assert.equal(searchClaimText("Saw it in the news, 70% of people skip breakfast"), "70% of people skip breakfast");
  assert.ok(generateQueries("Saw this on twitter: https://x.com/foo/status/123 says 70% of the ocean is unexplored").every((query) => !/https|status|123|twitter/.test(query)), "no query carries the pasted link");
  assert.ok(!generateQueries("You lose most of your body heat through your head").includes("\"through\""), "a single quoted word is not a search");
  // 11/13: was "Humans 10 brains", words that are not next to each other in the claim (an exact-phrase search for
  // them finds nothing). The quoted phrase is now a run of the claim's own words.
  assert.ok(generateQueries("Humans use only 10% of their brains").includes("\"Humans use only 10%\""), "the brain claim's quoted search is words that stand together in the claim");
  assert.equal(isRelevantSearchResult({ title: "Do goldfish really have a 3-second memory?", content: "Researchers trained goldfish." }, searchClaimText("Is it true that goldfish have a 3-second memory?")), true);
  // A claim in another language still picks the passage that mentions it.
  const spanish = `${"Los gatos dormidos tragan aire sin problema alguno. ".repeat(50)} Es un mito que los niños tragan arañas dormidos cada año. ${"Otro relleno sin relación alguna con nada. ".repeat(50)}`;
  assert.match(relevantPassage(spanish, "Los niños tragan arañas dormidos"), /los niños tragan arañas dormidos/, "a claim's accented words count when choosing its passage");
  const longPara = "Researchers measured heat loss in volunteers wearing arctic suits that left only the head exposed. ".repeat(5);
  const articleHtml = `<html><body><nav><p>Menu item text</p></nav><article><h1>Is it true?</h1><script>var x = "<p>script</p>";</script><p>${longPara}</p><aside><p>Related story</p></aside><p>Tom &amp; Jerry&#39;s &ldquo;test&rdquo; winter&#x27;s</p></article><footer><p>Footer</p></footer></body></html>`;
  const readText = articleText(articleHtml);
  assert.ok(readText?.startsWith("# Is it true?"), "article text starts with the article's own heading, marked as a heading");
  assert.ok(readText.includes("Tom & Jerry's “test” winter's"), "HTML entities, including hex ones, are decoded");
  assert.ok(!/Menu item|Related story|Footer|script/.test(readText), "navigation, sidebars, footers and scripts are left out");
  // AARP's own <h1> repeats Glasses.com's question title; read from HTML it must not become a title citation either.
  const aarpHtmlText = articleText(`<article><h1>What Is the Rarest Eye Color in the World?</h1><p>${"Eye color depends on melanin in the iris and varies widely around the world. ".repeat(8)}</p></article>`);
  assert.equal(findCitations([glasses, aarp], new Map([["aarp", aarpHtmlText]]), eyeClaim).has("aarp"), false, "a page's own <h1> read from its HTML is not a title citation");
  assert.equal(articleText("<html><body><article><p>Too short to be an article.</p></article></body></html>"), undefined, "a page with too little article text gives none");
  assert.equal(articleText(`<html><body><div><p>${longPara}</p></div></body></html>`), undefined, "a page without an article or main element gives none");
  // Live check 2026-11-12: a Nature blog's link to one YouTube video matched two other videos in the trace.
  assert.notEqual(linkKey("https://www.youtube.com/watch?v=VwrdPEdJv9g"), linkKey("https://www.youtube.com/watch?v=e6wWw2B3Dz0"), "pages told apart only by their query are different pages");
  assert.equal(linkKey("https://youtu.be/VwrdPEdJv9g?t=30"), linkKey("https://m.youtube.com/watch?v=VwrdPEdJv9g&feature=share"), "short and mobile YouTube links name the same video");
  assert.equal(linkKey("https://news.example/a?utm_source=x&ref=home"), "news.example/a", "tracking parameters are ignored");
  assert.equal(linkKey("https://news.example/story.php?id=5"), "news.example/story.php?id=5");
  // Live run 2026-11-12 ("Einstein failed math"): ABC's 2004 article came back twice, over http with ?site= and over https.
  assert.equal(samePageKey("http://www.abc.net.au/science/articles/2004/06/23/1115185.htm?site=science%2Fgreatmomentsinscience"), samePageKey("https://www.abc.net.au/science/articles/2004/06/23/1115185.htm"), "one article at two addresses is one page");
  assert.notEqual(samePageKey("https://www.youtube.com/watch?v=a1"), samePageKey("https://www.youtube.com/watch?v=b2"), "pages named by their query stay distinct");
  assert.notEqual(samePageKey("https://news.example/story.php?id=5"), samePageKey("https://news.example/story.php?id=6"));
  assert.equal(samePageKey("https://news.example/2024/05/story?page=2"), "news.example/2024/05/story");
  const htmlCites = findCitations([webmd, meateater], new Map([["me", "Ingebretsen said so."]]), heatClaim, new Map([["me", meLinks]]));
  assert.equal(htmlCites.get("me")?.[0]?.pageId, "wmd", "a link found only in the page's HTML is a citation");
  assert.equal(htmlCites.get("me")[0].how, "link");
  assert.match(htmlCites.get("me")[0].quote, /^This page's HTML links to https:\/\/www\.webmd\.com/);
  assert.equal(findCitations([webmd, meateater], new Map([["me", "x"]]), heatClaim, new Map([["me", ["webmd.com/other-article"]]])).has("me"), false, "a link to a different page on the same site is not a citation");
  const datedRelease = { ...webmd, id: "rel2", publishedDate: "2011-01-05", publishedDateSource: "page metadata" };
  assert.equal(findCitations([datedRelease, { ...meateater, publishedDateSource: "Tavily estimate" }], new Map([["me", ""]]), heatClaim, new Map([["me", meLinks]])).get("me")?.[0]?.pageId, "rel2", "an undated page whose HTML links to a dated page cites it, even with no extracted text");
  const laterPage = { ...meateater, id: "later", url: "https://later.example/update", domain: "later.example", publishedDate: "2024-03-01", publishedDateSource: "page metadata" };
  assert.equal(findCitations([laterPage, meateater], new Map([["me", ""]]), heatClaim, new Map([["me", ["later.example/update"]]])).has("me"), false, "an HTML link to a page dated later was added in an update and is not a citation");
  assert.deepEqual(await fetchOutboundLinks("http://127.0.0.1/x"), [], "private addresses are never fetched for links");
  assert.deepEqual(await fetchOutboundLinks("https://unreachable.example/x"), [], "a failed link fetch never stops a trace");
  assert.deepEqual(await fetchOutboundLinks("https://meta.example/pdf"), [], "non-HTML responses give no links");
  assert.equal((await fetchPageFacts("https://meta.example/jsonld", undefined, true)).date?.date, "2019-03-04", "the combined reader finds the same publisher date");
  assert.equal((await fetchPageFacts("https://meta.example/meta", undefined, true)).date?.date, "2018-07-09");
  assert.equal((await fetchPageFacts("https://en.wikipedia.org/wiki/Anything", undefined, true)).date, null, "wiki creation dates are still ignored");
  const heatGroup = new Map([["wmd", new Set(["wmd", "me"])], ["me", new Set(["wmd", "me"])]]);
  const heatLinked = linkCitedUndatedPages([webmd, { ...meateater, citations: reverseCites.get("me") }], heatGroup);
  assert.deepEqual([heatLinked[1].judgment.kind, heatLinked[1].judgment.parentId], ["derived", "wmd"], "an unresolved dated page citing an estimate-dated page links to it");
  assert.match(heatLinked[1].judgment.evidence, /dated 2021-12-28 and a page cannot cite something published after it/);
  const heatJudged = safeJudgment({ kind: "derived", parentId: "wmd", confidence: 70, evidence: "Quotes Ingebretsen." }, { ...meateater, citations: reverseCites.get("me") }, new Map([["wmd", webmd], ["me", meateater]]), new Set(["wmd", "me"]));
  assert.equal(heatJudged.kind, "derived", "the citation outranks the parent's later estimated date");
  assert.match(heatJudged.evidence, /estimated date is not its first publication/);
  assert.equal(safeJudgment({ kind: "derived", parentId: "wmd", confidence: 70, evidence: "x" }, meateater, new Map([["wmd", webmd], ["me", meateater]]), new Set(["wmd", "me"])).kind, "unclear", "without the citation the estimated date still blocks the link");
  // Saved head-heat trace 11/12: MeatEater links WebMD in its HTML, but the judge named Live Science as its parent.
  const liveSci = { id: "ls", url: "https://www.livescience.com/34411-body-heat-loss-head.html", domain: "livescience.com", title: "Body heat loss", publishedDate: "2013-02-01", publishedDateSource: "page metadata", text: "Army manual", hasPrimaryEvidence: false, judgment: { kind: "origin", parentId: null, confidence: 60, evidence: "x" } };
  const webmdDated = { ...webmd, publishedDate: "2011-01-04", publishedDateSource: "page metadata" };
  const linkedMe = { ...meateater, citations: [{ pageId: "wmd", how: "link", quote: "This page's HTML links to https://www.webmd.com/..." }] };
  const heatPages = new Map([["wmd", webmdDated], ["me", linkedMe], ["ls", liveSci]]);
  const heatIds = new Set(["wmd", "me", "ls"]);
  const preferred = safeJudgment({ kind: "derived", parentId: "ls", confidence: 70, evidence: "Paraphrases Live Science." }, linkedMe, heatPages, heatIds);
  assert.deepEqual([preferred.kind, preferred.parentId], ["derived", "wmd"], "a page that cites one earlier page in its group is linked to that page, not to an uncited one");
  assert.match(preferred.evidence, /cites webmd\.com directly but not livescience\.com/);
  assert.equal(safeJudgment({ kind: "derived", parentId: "wmd", confidence: 70, evidence: "x" }, linkedMe, heatPages, heatIds).parentId, "wmd", "a cited parent the judge chose is kept");
  const twoCited = { ...linkedMe, citations: [...linkedMe.citations, { pageId: "x2", how: "link", quote: "q" }] };
  const otherCited = { ...liveSci, id: "x2", url: "https://other.example/a", domain: "other.example" };
  assert.equal(safeJudgment({ kind: "derived", parentId: "ls", confidence: 70, evidence: "x" }, twoCited, new Map([...heatPages, ["x2", otherCited]]), new Set([...heatIds, "x2"])).parentId, "ls", "with two cited candidates the judge's choice stands");
  assert.equal(safeJudgment({ kind: "derived", parentId: "ls", confidence: 70, evidence: "x" }, { ...meateater, citations: [{ pageId: "wmd", how: "named as source", quote: "according to WebMD" }] }, heatPages, heatIds).parentId, "ls", "naming a source is not enough to override the judge");
  assert.equal(safeJudgment({ kind: "derived", parentId: "ls", confidence: 70, evidence: "x" }, linkedMe, new Map([["wmd", { ...webmdDated, publishedDate: "2022-06-01" }], ["me", linkedMe], ["ls", liveSci]]), heatIds).parentId, "ls", "a cited page dated after this one is never made its parent");
  assert.equal(safeJudgment({ kind: "derived", parentId: "ls", confidence: 70, evidence: "x" }, linkedMe, heatPages, new Set(["me", "ls"])).parentId, "ls", "a cited page outside the claim group is not used");
  // The retelling check (on by default) stops a page that only retells an outside source from counting as an origin.
  const retold = safeJudgment({ kind: "origin", parentId: null, confidence: 60, evidence: "Explainer.", hasPrimaryEvidence: false, originBasis: "retelling" }, meateater, new Map([["me", meateater]]), new Set(["me"]), heatClaim);
  assert.equal(retold.kind, "unclear");
  assert.match(retold.evidence, /retells the claim/);
  assert.equal(safeJudgment({ kind: "origin", parentId: null, confidence: 60, evidence: "Interview.", hasPrimaryEvidence: false, originBasis: "firsthand" }, meateater, new Map([["me", meateater]]), new Set(["me"]), heatClaim).kind, "origin");
  assert.equal(safeJudgment({ kind: "origin", parentId: null, confidence: 60, evidence: "Data.", hasPrimaryEvidence: true, originBasis: "retelling" }, meateater, new Map([["me", meateater]]), new Set(["me"]), heatClaim).kind, "origin", "a page with its own primary evidence stays an origin");
  // Live run 2026-11-10: a statistics roundup quoting a different figure was judged an independent origin.
  const roundup = { id: "ca", url: "https://www.consumeraffairs.com/x", domain: "consumeraffairs.com", title: "Cell Phone Statistics (2026)", publishedDate: "2023-09-28", publishedDateSource: "page metadata", text: "Each day, Americans check their phones 205 times on average, according to a 2024 survey." };
  const roundupJudgment = safeJudgment({ kind: "origin", parentId: null, confidence: 55, evidence: "Gives a different figure.", hasPrimaryEvidence: false }, roundup, new Map([["ca", roundup]]), new Set(["ca"]), "Americans check their phones 96 times a day.");
  assert.equal(roundupJudgment.kind, "unclear", "a page without the claim's figure or its own data is not an origin");
  assert.equal(safeJudgment({ kind: "origin", parentId: null, confidence: 80, evidence: "New survey.", hasPrimaryEvidence: true }, { ...roundup, text: "Our survey of 1,965 adults found 352 checks a day." }, new Map([["ca", roundup]]), new Set(["ca"]), "Americans check their phones 96 times a day.").kind, "origin", "a page with its own data stays an origin even with a newer figure");
  assert.equal(safeJudgment({ kind: "origin", parentId: null, confidence: 72, evidence: "Release.", hasPrimaryEvidence: false }, { ...roundup, text: "Americans now check their phones 96 times a day." }, new Map([["ca", roundup]]), new Set(["ca"]), "Americans check their phones 96 times a day.").kind, "origin", "a page stating the claim's figure can still be an origin");
  const manyRoots = Array.from({ length: 14 }, (_, index) => ({ id: `root-${index + 1}`, primaryEvidenceStatus: index === 13 ? "found" : "not found" }));
  const selectedRoots = selectAnswerRoots(manyRoots, manyRoots.map((page) => page.id));
  assert.equal(selectedRoots.length, 12);
  assert.equal(selectedRoots[0].id, "root-14", "a primary-evidence root must not be lost behind the 12-source limit");
  assert.ok(!selectedRoots.some((page) => page.id === "root-13"));
  const answerSources = [{ id: "root-a" }, { id: "root-b" }, { id: "root-c" }];
  assert.deepEqual(composeRootAnswer([
    { text: "First finding", sourceNumbers: [3, 1, 3] },
    { text: "Second finding.", sourceNumbers: [1] },
  ], answerSources), {
    answer: "First finding [1] [2]. Second finding [2].",
    answerSourceIds: ["root-c", "root-a"],
    answerStatements: [
      { text: "First finding", sourceIds: ["root-c", "root-a"] },
      { text: "Second finding", sourceIds: ["root-a"] },
    ],
  });
  assert.throws(() => composeRootAnswer([{ text: "Invented citation [1]", sourceNumbers: [1] }], answerSources), /source numbers/);
  assert.throws(() => composeRootAnswer([{ text: "Invalid root", sourceNumbers: [4] }], answerSources), /source numbers/);
  assert.throws(() => composeRootAnswer([{ text: "x".repeat(701), sourceNumbers: [1] }], answerSources), /source numbers/);
  assert.throws(() => composeRootAnswer([], answerSources), /one to four/);
  const sourcePage = (id, publishedDate, publishedDateSource = "page text", extractionSource = "Tavily extraction") => ({
    id, publishedDate, publishedDateSource, extractionSource,
  });
  const parent = sourcePage("parent", "2020-01-01");
  const child = sourcePage("child", "2021-01-01");
  const parentMap = new Map([[parent.id, parent], [child.id, child]]);
  const allowed = new Set(parentMap.keys());
  const proposed = { kind: "derived", parentId: parent.id, confidence: 90, evidence: "The child names the earlier source." };
  assert.equal(safeJudgment(proposed, child, parentMap, allowed).kind, "derived");
  const estimated = safeJudgment(proposed, { ...child, publishedDateSource: "Tavily estimate" }, parentMap, allowed);
  assert.equal(estimated.kind, "unclear");
  assert.equal(estimated.parentId, parent.id, "an estimated date may retain a dashed possible path");
  assert.equal(estimated.confidence, 0);
  assert.equal(safeJudgment(proposed, { ...child, publishedDate: null }, parentMap, allowed).kind, "unclear");
  const releaseText = "Global tech care company Asurion found that Americans check their phones 96 times a day, or once every ten minutes, a twenty percent increase from its previous survey of two thousand adults.";
  const wireRelease = { ...sourcePage("wire", "2019-11-21", "page metadata"), domain: "prnewswire.com", text: releaseText };
  const newsroom = { ...sourcePage("newsroom", "2019-11-21", "page metadata"), domain: "asurion.com", text: `Newsroom: ${releaseText}` };
  const releaseMap = new Map([[wireRelease.id, wireRelease], [newsroom.id, newsroom]]);
  const coPublishedJudgment = safeJudgment({ kind: "derived", parentId: "wire", confidence: 80, evidence: "Same text." }, newsroom, releaseMap, new Set(releaseMap.keys()));
  assert.equal(coPublishedJudgment.kind, "origin", "a same-day identical posting becomes a co-published origin, not an unresolved page");
  assert.equal(coPublishedJudgment.parentId, null);
  assert.match(coPublishedJudgment.evidence, /co-published origin/);
  assert.equal(safeJudgment({ kind: "derived", parentId: "wire", confidence: 80, evidence: "x" }, { ...newsroom, text: "A different summary of phone habits with its own wording entirely, written later the same day by a separate desk." }, releaseMap, new Set(releaseMap.keys())).kind, "unclear", "same-day pages with different text stay unresolved");
  const reversed = safeJudgment(proposed, { ...child, publishedDate: "2019-01-01" }, parentMap, allowed);
  assert.equal(reversed.kind, "unclear");
  assert.equal(reversed.parentId, null, "a later parent must not remain linked");
  assert.equal(safeJudgment({ ...proposed, parentId: "child" }, child, parentMap, allowed).kind, "unclear");
  assert.equal(safeJudgment(proposed, child, parentMap, new Set(["child"])).kind, "unclear");
  assert.equal(safeJudgment({ kind: "origin", parentId: null, hasPrimaryEvidence: false }, sourcePage("snippet", null, undefined, "Search snippet"), parentMap, allowed).kind, "unclear");
  const result = await analyzeClaim("90% of startups fail", () => {});
  assert.equal(result.pages.length, 2);
  assert.equal(result.excludedPageCount, 1);
  assert.equal(result.roots.length, 1);
  assert.equal(result.summary.echoPercentage, 50);
  assert.equal(result.answerStatus, "generated");
  assert.equal(result.answer, "The source says so [1].");
  assert.deepEqual(result.answerSourceIds, ["page-1"]);
  assert.deepEqual(result.answerStatements, [{ text: "The source says so", sourceIds: ["page-1"] }]);
  assert.match(result.echoContribution, /excluded derived and unresolved pages/);
  assert.ok(result.pages.every((page) => page.url !== urls[2] && !page.linkedPageIds?.includes("page-3")));
  assert.ok(result.searchAudit?.every((entry) => !entry.pageIds?.includes("page-3")));
  assert.ok(searchCalls >= 10);
  assert.equal(modelCalls, 3);
  assert.equal(tokenCounts, modelCalls);
  const searchesBeforeCache = searchCalls;
  const extractsBeforeCache = extractCalls;
  const cached = await analyzeClaim("90% of startups fail", () => {});
  assert.equal(cached.cacheHit, true);
  assert.equal(searchCalls, searchesBeforeCache);
  assert.equal(extractCalls, extractsBeforeCache);
  assert.equal(modelCalls, 3);
  const planEvents = [];
  await analyzeClaim("90% of startups fail", (event) => planEvents.push(event), { forceFresh: true });
  assert.ok(searchCalls > searchesBeforeCache);
  assert.ok(extractCalls > extractsBeforeCache, "Run fresh must bypass the recent extract cache");
  assert.equal(modelCalls, 6);
  {
    // The live wait's search plan: the "queries" step lists every planned variant, built from the claim alone, and
    // the basic search steps tick them off in order. No page text (titles, snippets, extracts, domains) can reach it.
    const { planQueryText, PLAN_QUERY_MAX_CHARS } = pipelineModule;
    const planned = pipelineModule.generateQueries("90% of startups fail");
    const queryEvents = planEvents.filter((event) => event.queries !== undefined);
    assert.equal(queryEvents.length, 1, "one progress event carries the search plan");
    assert.equal(queryEvents[0].stage, "queries", "the plan arrives with the queries step, before any search");
    assert.ok(planEvents.indexOf(queryEvents[0]) < planEvents.findIndex((event) => event.stage === "search"), "the plan comes before the first search step");
    assert.deepEqual(queryEvents[0].queries, planned.map(planQueryText), "the plan is exactly the claim's own search variants");
    assert.equal(queryEvents[0].queries.length, planned.length, "every planned variant is listed (no change to how many run)");
    assert.ok(queryEvents[0].queries.every((query) => query.length <= PLAN_QUERY_MAX_CHARS && !/[\u0000-\u001f\n]/.test(query)), "each listed variant is one short line");
    const done = planEvents.filter((event) => event.queriesDone !== undefined).map((event) => event.queriesDone);
    assert.deepEqual(done, [0, 5, planned.length], `the basic search reports 0, then 5, then all ${planned.length} variants finished`);
    assert.ok(planEvents.filter((event) => event.queriesDone !== undefined).every((event) => event.stage === "search"), "only search steps count finished variants");
    assert.ok(planEvents.some((event) => event.label === "Deepening a thin search") && planEvents.filter((event) => event.label === "Deepening a thin search").every((event) => event.queriesDone === undefined), "the deepening pass (a repeat of three variants) leaves the plan's count alone");
    const planText = JSON.stringify(planEvents.map((event) => [event.queries, event.queriesDone]));
    for (const pageText of [...searchResults.flatMap((result) => [result.title, result.content]), "in this original dataset", "according to the original", "prefer coffee", "source.example", "repeat.example", "Published:"]) {
      if (pageText.trim() === "90% of startups fail") continue;
      assert.ok(!planText.includes(pageText), `page text "${pageText}" never reaches the search plan`);
    }
    assert.equal(planQueryText(`  "a\nb"\u0007\tc  `), "\"a b\" c", "a variant is cleaned to one line");
    const long = planQueryText(`${"x".repeat(200)}`);
    assert.ok(long.length === PLAN_QUERY_MAX_CHARS && long.endsWith("…"), "an over-long variant is cut to 120 characters with an ellipsis");
    // A search that finds 20 distinct pages early stops: the plan's count stays at the variants actually searched.
    searchMode = "many";
    const stopEvents = [];
    const stopper = new AbortController();
    await assert.rejects(() => pipelineModule.analyzeClaim("90% of startups fail, plan stop check", (event) => { stopEvents.push(event); if (event.stage === "extract") stopper.abort(); }, { forceFresh: true, signal: stopper.signal }));
    searchMode = "results";
    const stopDone = stopEvents.filter((event) => event.queriesDone !== undefined).map((event) => event.queriesDone);
    assert.ok(stopEvents.some((event) => event.label === "Enough distinct pages found"), "the early stop is reported");
    assert.deepEqual(stopDone, [0, 5, 5], "an early stop leaves the skipped variants unticked");
    assert.ok(!JSON.stringify(stopEvents.map((event) => [event.queries, event.queriesDone])).includes("page-only"), "the early-stop run's plan holds no page text");
  }
  primaryEvidencePresent = false;
  const callsBeforeLimited = modelCalls;
  const limited = await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true });
  assert.equal(limited.answerStatus, "source-limited");
  assert.equal(limited.summary.verifiableOrigins, 0);
  assert.match(limited.answer, /cannot confirm the claim/);
  assert.deepEqual(limited.answerSourceIds, ["page-1"]);
  assert.equal(modelCalls, callsBeforeLimited + 2, "limited root evidence skips paid answer synthesis");
  assert.equal(tokenCounts, modelCalls);
  primaryEvidencePresent = true;
  answerMode = "invalid";
  const callsBeforeAnswerFailure = modelCalls;
  const failedAnswer = await analyzeClaim("90 percent of startups fail", () => {}, { forceFresh: true });
  assert.equal(failedAnswer.answerStatus, "unavailable");
  assert.match(failedAnswer.answer, /without valid root source numbers/);
  assert.equal(failedAnswer.roots.length, 1, "answer failure must preserve the completed source tree");
  assert.equal(modelCalls, callsBeforeAnswerFailure + 3);
  answerMode = "valid";
  const extractsBeforeRecovery = extractCalls;
  const recoveredAnswer = await analyzeClaim("90 percent of startups fail", () => {});
  assert.equal(recoveredAnswer.cacheHit, undefined, "failed synthesis must not enter the server cache");
  assert.equal(recoveredAnswer.answerStatus, "generated");
  assert.equal(extractCalls, extractsBeforeRecovery, "a retry after failed synthesis should reuse recent source extracts");
  assert.equal(modelCalls, callsBeforeAnswerFailure + 6);
  extractMode = "undated";
  const estimatedOnly = await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true });
  assert.ok(estimatedOnly.pages.every((page) => page.publishedDateSource === "Tavily estimate"), "without page or metadata dates, only search estimates remain");
  assert.equal(estimatedOnly.summary.echoPercentage, 0, "search-estimated dates alone cannot confirm an echo");
  extractMode = "metadata";
  const metadataProgress = [];
  const pageFetchesBefore = metadataFetches;
  const withMetadata = await analyzeClaim("90% of startups fail", (event) => metadataProgress.push(event), { forceFresh: true });
  assert.equal(metadataFetches - pageFetchesBefore, 2, "one direct fetch per page serves both its publisher date and its links");
  assert.ok(withMetadata.pages.every((page) => page.publishedDateSource === "page metadata"), "publisher metadata replaces search estimates");
  assert.deepEqual(withMetadata.pages.map((page) => page.publishedDate), ["2020-01-01", "2021-01-01"]);
  assert.equal(withMetadata.summary.echoPercentage, 50, "publisher dates let a supported link be confirmed");
  process.env.ECHO_HTML_LINKS = "0";
  const withoutLinks = await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true });
  assert.deepEqual(withoutLinks.pages.map((page) => page.publishedDate), ["2020-01-01", "2021-01-01"], "with source links off, the date-only reader still finds publisher dates");
  delete process.env.ECHO_HTML_LINKS;
  assert.ok(metadataProgress.some((event) => /publisher-supplied date/.test(event.detail ?? event.message ?? JSON.stringify(event))), "progress reports how many dates were upgraded");
  searchResults.push({ ...searchResults[0], url: "http://www.source.example/startups/?ref=home" });
  const deduped = await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true });
  assert.equal(deduped.pages.filter((page) => page.domain === "source.example").length, 1, "a search result for the same article at another address is not added twice");
  searchResults.pop();
  extractMode = "html-links";
  const htmlLinked = await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true });
  const htmlCitations = htmlLinked.pages.find((page) => page.url === urls[1])?.citations ?? [];
  assert.equal(htmlCitations.length, 1, "a source link that only survives in the page's HTML still reaches the trace");
  assert.equal(htmlCitations[0].pageId, htmlLinked.pages.find((page) => page.url === urls[0]).id);
  assert.match(htmlCitations[0].quote, /^This page's HTML links to/);
  extractMode = "article-cite";
  const articleCited = await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true });
  process.env.ECHO_HTML_LINKS = "0"; const citedFromArticle0 = (await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true })).pages.find((page) => page.url === urls[1])?.citations ?? []; delete process.env.ECHO_HTML_LINKS; assert.equal(citedFromArticle0.length, 0, "control: without the page read there is no citation");
  const citedFromArticle = articleCited.pages.find((page) => page.url === urls[1])?.citations ?? [];
  assert.ok(citedFromArticle.some((citation) => citation.pageId === articleCited.pages.find((page) => page.url === urls[0]).id && citation.how === "name and year"), "a reference list that search extraction trimmed is read from the page's own article text");
  extractMode = "html-text";
  const pageRead = await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true });
  const readPage = pageRead.pages.find((page) => page.url === urls[1]);
  assert.equal(readPage?.extractionSource, "Page HTML", "a page search could not extract is read from its own article text");
  assert.match(readPage.text, /A new report repeats/);
  extractMode = "dated";
  searchMode = "flaky";
  const callsBeforeFlaky = searchCalls;
  const recovered = await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true });
  assert.equal(recovered.pages.length, 2, "a temporary rate limit is retried once instead of losing the query");
  assert.ok(recovered.searchAudit.every((entry) => entry.status !== "failed"));
  assert.ok(searchCalls - callsBeforeFlaky >= 20, "each query was retried after its first 429");
  searchMode = "results";
  modelMode = "overloaded-once";
  const modelCallsBeforeOverload = modelCalls;
  const afterOverload = await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true });
  assert.equal(afterOverload.pages.length, 2, "one 529 from Claude is retried instead of ending the run");
  assert.equal(modelCalls - modelCallsBeforeOverload, 4, "the overloaded call is sent exactly twice; the other two once each");
  modelMode = "overloaded";
  await assert.rejects(analyzeClaim("90% of startups fail", () => {}, { forceFresh: true }), (error) => error.code === "CLAUDE_OVERLOADED" && /overloaded/.test(error.message), "a second 529 stops with a plain overloaded message");
  modelMode = "ok";
  // Without a key the run stops before any call, and points to the saved runs (four of them), not "two demo presets".
  {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(analyzeClaim("90% of startups fail", () => {}, { forceFresh: true }), (error) => error.code === "MISSING_KEYS" && /saved runs open without keys/.test(error.message) && !/two demo presets/.test(error.message), "a run without keys names the saved runs");
    } finally {
      process.env.ANTHROPIC_API_KEY = savedKey;
    }
  }
  countMode = "busy-once";
  const countsBeforeBusy = tokenCounts;
  assert.equal((await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true })).pages.length, 2, "one 429 on the free token count is retried instead of ending the run");
  assert.equal(tokenCounts - countsBeforeBusy, 4, "the busy token count is sent exactly twice; the other two once each");
  assert.ok((await load(path.join(projectRoot, "src/lib/echo/daily-budget.ts")).getAnthropicBudgetSnapshot()).reservedUsd < 1e-9, "a 529 leaves no budget reserved");
  extractMode = "ratelimited";
  const extractProgress = [];
  const snippetOnly = await analyzeClaim("90% of startups fail", (event) => extractProgress.push(JSON.stringify(event)), { forceFresh: true });
  assert.ok(snippetOnly.pages.every((page) => page.extractionSource === "Search snippet"), "a rate-limited extraction falls back to snippets instead of failing the run");
  assert.ok(extractProgress.some((line) => /search snippets/.test(line)), "the snippet fallback is reported in progress");
  extractMode = "dated";
  const controller = new AbortController();
  const callsBeforeCancel = modelCalls;
  onSearch = () => controller.abort();
  await assert.rejects(() => analyzeClaim("90% of startups fail", () => {}, { forceFresh: true, signal: controller.signal }), (error) => error.name === "AbortError" || controller.signal.aborted);
  onSearch = null;
  assert.equal(modelCalls, callsBeforeCancel, "cancelling during search must stop before any model call");
  await assert.rejects(() => analyzeClaim("90% of startups fail", () => {}, { signal: AbortSignal.abort() }), (error) => error.name === "AbortError");
  // 11/12 round 4: "........" passed the 8-character check and spent ~10 Tavily searches on punctuation.
  const searchesBeforeJunk = searchCalls;
  for (const junk of ["........", "!!!!!!!!!!!!", "- - - - - - -", "?? ?? ?? ??", "a.b.......", "12345678", "1.2.3......"]) {
    await assert.rejects(() => analyzeClaim(junk, () => {}, { forceFresh: true }), (error) => error.code === "CLAIM_NO_WORDS" && /words/.test(error.message), `"${junk}" is refused before any spend`);
  }
  assert.equal(searchCalls, searchesBeforeJunk, "a claim without words runs no search");
  const { claimHasWords } = pipelineModule;
  const labelClaims = fs.readdirSync(path.join(projectRoot, "evaluation")).filter((name) => name.endsWith(".labels.json")).map((name) => JSON.parse(fs.readFileSync(path.join(projectRoot, "evaluation", name), "utf8")).claim);
  assert.ok(labelClaims.length >= 7, "every labelled claim is checked");
  for (const real of [...labelClaims, "Humans use only 10% of their brains", "Americans check their phones 96 times a day", "Goldfish have a 3-second memory", "You lose most of your body heat through your head", "金鱼的记忆只有三秒", "E=mc² is wrong", "5G causes COVID"]) {
    assert.equal(claimHasWords(real), true, `"${real}" is a claim in words`);
  }
  searchMode = "failed";
  const callsBeforeFailedSearch = modelCalls;
  await assert.rejects(() => analyzeClaim("A claim whose search provider is unavailable", () => {}, { forceFresh: true }), (error) => error.code === "SEARCH_INCOMPLETE" && /cannot assess this claim/.test(error.message));
  assert.equal(modelCalls, callsBeforeFailedSearch, "failed search must stop before model calls");
  searchMode = "empty";
  await assert.rejects(() => analyzeClaim("A claim with no matching search pages", () => {}, { forceFresh: true }), (error) => error.code === "NO_RESULTS" && /completed search/.test(error.message));
  assert.equal(modelCalls, callsBeforeFailedSearch, "empty search must stop before model calls");
  searchMode = "results";
  judgeMode = "missing-one";
  const partial = await analyzeClaim("90% of startups will fail", () => {});
  const skipped = partial.pages.find((page) => page.id === "page-2");
  assert.equal(skipped.judgment.kind, "unclear", "a page the judge skipped stays unresolved instead of failing the paid run");
  assert.match(skipped.judgment.evidence, /did not return a judgment/);
  assert.equal(partial.roots.length, 1, "the judged pages still form the tree");
  const partialAgain = await analyzeClaim("90% of startups will fail", () => {});
  assert.equal(partialAgain.cacheHit, undefined, "a partially judged trace is not cached, so a retry can complete it");
  judgeMode = "missing-all";
  await assert.rejects(() => analyzeClaim("90% of startups fail", () => {}, { forceFresh: true }), (error) => error.code === "CLAUDE_INCOMPLETE", "a mostly missing judgment still stops the run");
  // Accuracy round 11/13: an origin the judge rates 50 or below, on a page with no data of its own, is not a root.
  judgeMode = "unsure-origin";
  const unsure = await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true });
  const unsureRoot = unsure.pages.find((page) => page.id === "page-1");
  assert.equal(unsureRoot.judgment.kind, "unclear", "a coin-flip origin with no data of its own stays unresolved");
  assert.match(unsureRoot.judgment.evidence, /unsure this page is an independent origin \(45 of 100\)/);
  assert.deepEqual(unsure.roots, [], "it is not counted as an independent origin");
  assert.equal(unsure.answerStatus, "unavailable", "no answer is synthesized from an unsure root");
  judgeMode = "complete";
  const { getAnthropicBudgetSnapshot } = load(path.join(projectRoot, "src/lib/echo/daily-budget.ts"));
  // 11/13 policy: each provider has its own cap, set by its own variable; the old single-cap settings are not read.
  process.env.ECHO_ANTHROPIC_DAILY_CAP_USD = "0.01";
  process.env.ECHO_DAILY_CAP_OVERRIDE_USD = "0";
  const caps = (snapshot) => Object.fromEntries(Object.entries(snapshot.providers).map(([name, entry]) => [name, entry.capUsd]));
  assert.deepEqual(caps(await getAnthropicBudgetSnapshot()), { claude: 2, tavily: 2, telem: 2 }, "the retired ECHO_ANTHROPIC_DAILY_CAP_USD and ECHO_DAILY_CAP_OVERRIDE_USD change no cap");
  delete process.env.ECHO_ANTHROPIC_DAILY_CAP_USD;
  delete process.env.ECHO_DAILY_CAP_OVERRIDE_USD;
  const beforeTavilyCharge = await getAnthropicBudgetSnapshot();
  searchMode = "results";
  await analyzeClaim("90% of startups fail", () => {}, { forceFresh: true });
  const afterTavilyCharge = await getAnthropicBudgetSnapshot();
  const tavilyCharge = afterTavilyCharge.providers.tavily.spentUsd - beforeTavilyCharge.providers.tavily.spentUsd;
  const claudeCharge = afterTavilyCharge.providers.claude.spentUsd - beforeTavilyCharge.providers.claude.spentUsd;
  assert.ok(tavilyCharge > 0.01, "Tavily credits are charged to Tavily's own daily cap");
  assert.ok(claudeCharge > 0, "Claude's requests are charged to Claude's");
  assert.ok(Math.abs((afterTavilyCharge.spentUsd - beforeTavilyCharge.spentUsd) - (tavilyCharge + claudeCharge)) < 1e-9, "the snapshot's total is the providers' sum");
  assert.equal(afterTavilyCharge.providers.telem.spentUsd, 0, "a Tavily run charges nothing to Telem");
  process.env.ECHO_TAVILY_USD_PER_CREDIT = "0.5";
  const callsBeforeCap = modelCalls;
  // QA round 6 (S3-3): the message matches the error card's title ("Daily spending cap reached") and names the cap it
  // hit: Tavily's, with Tavily searching (no Telem, no "API limit").
  await assert.rejects(() => analyzeClaim("90% of startups fail", () => {}, { forceFresh: true }), (error) => {
    assert.equal(error.code, "DAILY_BUDGET_REACHED", `a cap refusal (${error.code}: ${error.message})`);
    assert.match(error.message, /^About \$\d+\.\d\d remains under Echo’s \$2\.00 daily Tavily cap \(searches and page reading\)\. That is too little for this run's searches and page reading, so Echo stopped before spending search credits\.$/, `Tavily router: the cap message reads "${error.message}"`);
    assert.doesNotMatch(error.message, /Telem|API limit|Claude/, "it names only the cap it hit");
    return true;
  }, "expensive searches stop the run at Tavily's daily cap");
  assert.equal(modelCalls, callsBeforeCap, "a run stopped by the cap makes no model calls");
  const snapshotAfterCap = await getAnthropicBudgetSnapshot();
  assert.ok(Object.values(snapshotAfterCap.providers).every((entry) => entry.spentUsd <= entry.capUsd + 1e-9) && snapshotAfterCap.reservedUsd < 1e-9, "no provider's spending exceeds its cap and no reservation is left behind");
  process.env.ECHO_TAVILY_USD_PER_CREDIT = "0.001";
  // Claude's own cap, independently: with Tavily's far from reached, a Claude cap below the judgment's output stops
  // the run before any search, and names Claude's cap.
  process.env.ECHO_CLAUDE_DAILY_CAP_USD = String(afterTavilyCharge.providers.claude.spentUsd + 0.01);
  const searchesBeforeClaudeCap = searchCalls;
  await assert.rejects(() => analyzeClaim("90% of startups fail", () => {}, { forceFresh: true }), (error) => {
    assert.equal(error.code, "DAILY_BUDGET_REACHED", `a Claude cap refusal (${error.code}: ${error.message})`);
    assert.match(error.message, /^About \$0\.01 remains under Echo’s \$\d+\.\d\d daily Claude cap\. That is too little to reserve the source-judgment output, so Echo stopped before spending search credits\.$/, error.message);
    return true;
  });
  assert.equal(searchCalls, searchesBeforeClaudeCap, "a run stopped by Claude's cap sends no search");
  process.env.ECHO_CLAUDE_DAILY_CAP_USD = "2";
  assert.ok(tracesChecked >= 15, "most pipeline runs in this check are re-imported");
  console.log(`Echo pipeline passed (${tracesChecked} traces re-imported): chronology, filtering, citations, budget, cache, fresh bypass, limited-evidence answer, failed synthesis, publisher-metadata dates, retries, snippet fallback, cancellation, Claude's and Tavily's own daily caps, partial judgments, citation-based direction, and search failure paths; no provider calls.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

// Cost round 11/13: the searched phrase keeps the claim's figures. It had sent "Americans check their phones times
// fact check source" and "Humans only their brains evidence", which found almost nothing.
{
  const { generateQueries } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  for (const [claim, figure] of [["Americans check their phones 96 times a day", /\b96\b/], ["Humans use only 10% of their brains", /\b10\b/]]) {
    for (const query of generateQueries(claim).filter((variant) => !variant.startsWith('"'))) assert.match(query, figure, `"${query}" keeps the claim's figure`);
  }
}

// Bug round 11/13: two pages that cite each other became each other's parent (a loop with no origin). Page a has a
// reliable date and cites b; b is undated and cites a back.
{
  const { safeJudgment, linkCitedUndatedPages, breakDerivedCycles } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  const base = { title: "t", text: "Text 96 times a day.", hasPrimaryEvidence: false, extractionSource: "Page HTML" };
  const unjudged = { kind: "unclear", parentId: null, confidence: 0, evidence: "x" };
  const a = { ...base, id: "a", domain: "a.example", url: "https://a.example/", publishedDate: "2020-03-01", publishedDateSource: "page text", citations: [{ pageId: "b", how: "link", quote: "b" }], judgment: unjudged };
  const b = { ...base, id: "b", domain: "b.example", url: "https://b.example/", publishedDate: null, citations: [{ pageId: "a", how: "link", quote: "a" }], judgment: unjudged };
  const byId = new Map([["a", a], ["b", b]]);
  const group = new Set(["a", "b"]);
  const judgedA = { ...a, judgment: safeJudgment({ kind: "derived", parentId: "b", confidence: 70, evidence: "copies b" }, a, byId, group, "96 times a day") };
  assert.notEqual(judgedA.judgment.kind, "derived", "citations both ways give no direction, so a is not derived from undated b");
  const judgedB = { ...b, judgment: safeJudgment({ kind: "unclear", parentId: null, confidence: 30, evidence: "no date" }, b, byId, group, "96 times a day") };
  const linked = linkCitedUndatedPages([judgedA, judgedB], new Map([["a", group], ["b", group]]));
  assert.ok(!linked.some((page) => page.judgment.kind === "derived"), "a page citing back is not linked as a parent");
  // Even if every rule upstream agreed, the last guard breaks a loop of derived links.
  const loop = breakDerivedCycles([
    { ...a, judgment: { kind: "derived", parentId: "b", confidence: 60, evidence: "x" } },
    { ...b, judgment: { kind: "derived", parentId: "a", confidence: 60, evidence: "x" } },
  ]);
  assert.ok(loop.every((page) => page.judgment.kind === "unclear" && page.judgment.parentId), "both undated links in a loop become unclear, kept as dashed paths");
  const c = { ...base, id: "c", domain: "c.example", url: "https://c.example/", publishedDate: "2019-01-01", publishedDateSource: "page metadata", judgment: unjudged };
  const triangle = breakDerivedCycles([
    { ...a, judgment: { kind: "derived", parentId: "c", confidence: 60, evidence: "x" } },
    { ...c, judgment: { kind: "derived", parentId: "b", confidence: 60, evidence: "x" } },
    { ...b, judgment: { kind: "derived", parentId: "a", confidence: 60, evidence: "x" } },
  ]);
  assert.equal(triangle.find((page) => page.id === "a").judgment.kind, "derived", "a link backed by two reliable dates in order stays");
  assert.ok(["b", "c"].every((id) => triangle.find((page) => page.id === id).judgment.kind === "unclear"), "the loop's weak links become unclear");
  const chain = [{ ...a, judgment: { kind: "derived", parentId: "c", confidence: 60, evidence: "x" } }, { ...c, judgment: { kind: "origin", parentId: null, confidence: 60, evidence: "x" } }];
  assert.equal(breakDerivedCycles(chain), chain, "pages without a loop are returned untouched");
}

// Accuracy round 11/13: the 11/13 brain run counted 14 origins with 4 wrong calls. Each wrong one was an origin the
// judge itself rated 45 or 50 on a page with no data of its own (Wikipedia, Psychology Today, UAMS, Britannica). Such
// a coin-flip origin stays unresolved; confidence 55 stays an origin, as do pages with primary evidence and Echo's own
// confidence-0 co-published origins. It runs before the citation rule, so a cited earlier page can still be linked.
{
  const { unsureOriginsUnclear, linkCitedUndatedPages, UNSURE_ORIGIN_MAX_CONFIDENCE } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  assert.equal(UNSURE_ORIGIN_MAX_CONFIDENCE, 50);
  const page = (id, judgment, extra = {}) => ({ id, title: id, domain: `${id}.example`, url: `https://${id}.example/`, text: "t", hasPrimaryEvidence: false, publishedDate: "2020-01-01", publishedDateSource: "page metadata", judgment, ...extra });
  const origin = (confidence) => ({ kind: "origin", parentId: null, confidence, evidence: "Synthesizes the history from its own references." });
  const pages = unsureOriginsUnclear([
    page("wiki", origin(45)),
    page("ucams", origin(50)),
    page("bbc", origin(55)),
    page("study", origin(40), { hasPrimaryEvidence: true }),
    page("wire", origin(0)),
    page("copy", { kind: "derived", parentId: "bbc", confidence: 30, evidence: "x" }),
    page("maybe", { kind: "unclear", parentId: null, confidence: 20, evidence: "x" }),
  ]);
  const kind = (id) => pages.find((entry) => entry.id === id).judgment.kind;
  assert.deepEqual(["wiki", "ucams"].map(kind), ["unclear", "unclear"], "origins rated 50 or below with no data of their own are unresolved");
  const wiki = pages.find((entry) => entry.id === "wiki").judgment;
  assert.equal(wiki.parentId, null);
  assert.equal(wiki.confidence, 0);
  assert.match(wiki.evidence, /^Claude was unsure this page is an independent origin \(45 of 100\).*Claude's reason: Synthesizes the history/);
  assert.deepEqual(["bbc", "study", "wire", "copy", "maybe"].map(kind), ["origin", "origin", "origin", "derived", "unclear"], "confident origins, pages with primary evidence, co-published origins and other kinds are untouched");
  // An undated encyclopedia page the judge called an unsure origin, citing a dated article in its group, is linked.
  const article = page("sciam", origin(80));
  const encyclopedia = page("enc", origin(45), { publishedDate: null, publishedDateSource: undefined, citations: [{ pageId: "sciam", how: "link", quote: "Scientific American, 2008" }] });
  const group = new Set(["sciam", "enc"]);
  const linked = linkCitedUndatedPages(unsureOriginsUnclear([article, encyclopedia]), new Map([["sciam", group], ["enc", group]]));
  assert.deepEqual([linked[1].judgment.kind, linked[1].judgment.parentId], ["derived", "sciam"], "the citation rule still links an unsure origin to the page it cites");
}

// Accuracy round 11/13: a live "Check these sources" run on the phones links labelled PR Newswire's same-day copy of
// Asurion's release "unclear" ("not dated earlier"), while search runs counted the pair as one co-published origin.
// Same pages, same dates, same text (overlap 0.74): the only difference was the judge's draft. safeJudgment turns a
// same-day same-text "derived" into a co-published origin, but the judge (as its prompt asks when neither page is
// strictly earlier) answered "unclear" with a dashed parent, which safeJudgment drops. 2026-11-13-run1, a search run,
// had the same miss. After judging, an unresolved page that is the same release as an origin in its group, posted
// within days and not after it, joins that origin as a co-published root, counted once.
{
  const { coPublishedCopiesAsOrigins, safeJudgment, UNJUDGED_EVIDENCE } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  const { coPublishedRootGroups, originCounts } = load(path.join(projectRoot, "src/lib/echo/origins.ts"));
  const release = "Americans now check their phones 96 times a day, once every 10 minutes, according to new research by global tech care company Asurion. That is a 20 percent daily increase from a similar survey conducted by Asurion two years ago. Eighteen to 24 year olds check their phones twice as much as the national average.";
  const page = (id, date, judgment, extra = {}) => ({ id, title: id, domain: `${id}.example`, url: `https://${id}.example/`, text: release, hasPrimaryEvidence: false, extractionSource: "Tavily extraction", publishedDate: date, publishedDateSource: "page metadata", judgment, ...extra });
  const origin = { kind: "origin", parentId: null, confidence: 85, evidence: "Asurion's own release." };
  const unclear = (parentId = null) => ({ kind: "unclear", parentId, confidence: 0, evidence: "The proposed parent is not dated earlier than this page, so Echo removed the directional link." });
  const newsroom = page("newsroom", "2019-11-21", origin);
  const wire = page("wire", "2019-11-21", unclear(), { text: `NASHVILLE, Tenn., Nov. 21, 2019 /PRNewswire/ -- ${release}`, citations: [{ pageId: "newsroom", how: "name and year", quote: "Asurion (2019)" }] });
  const group = new Set(["newsroom", "wire", "later", "other", "earlier"]);
  const clusters = new Map([...group].map((id) => [id, group]));
  // The judge's own draft for the wire copy, as in the live run, through safeJudgment and then the guard.
  const byId = new Map([[newsroom.id, newsroom], [wire.id, wire]]);
  const drafted = safeJudgment({ kind: "unclear", parentId: "newsroom", confidence: 55, evidence: "Same text, same day; neither is earlier.", hasPrimaryEvidence: false }, wire, byId, group, "Americans check their phones 96 times a day");
  assert.deepEqual([drafted.kind, drafted.parentId], ["unclear", null], "safeJudgment alone still drops the dashed same-day parent");
  const [, joined] = coPublishedCopiesAsOrigins([newsroom, { ...wire, judgment: drafted }], clusters);
  assert.deepEqual([joined.judgment.kind, joined.judgment.parentId, joined.judgment.confidence], ["origin", null, 0], "the same-day wire copy becomes a co-published origin (confidence 0 marks Echo's rule)");
  assert.match(joined.judgment.evidence, /^Published within days of newsroom\.example with largely identical text.*co-published origin/);
  const groups = coPublishedRootGroups([newsroom, joined]);
  assert.deepEqual(groups, [["newsroom", "wire"]], "the pair is grouped as one release");
  assert.equal(originCounts(["newsroom", "wire"], [], groups).independent, 1, "and counted once: the guard never adds an independent origin");
  // The same result whichever draft the judge chose: "derived" (safeJudgment's own rule) or "unclear" (this guard).
  const viaDerived = safeJudgment({ kind: "derived", parentId: "newsroom", confidence: 80, evidence: "Same text.", hasPrimaryEvidence: false }, wire, byId, group, "Americans check their phones 96 times a day");
  assert.deepEqual([viaDerived.kind, viaDerived.evidence], [joined.judgment.kind, joined.judgment.evidence], "a derived draft and an unclear draft for the same pair end the same way");
  // Left alone: a dashed parent that is another page, an earlier-dated origin (a link the judge declined), different
  // text, a snippet, a page the judge never assessed, an untrusted date, more than three days apart, another group.
  const keep = (candidate, pages = [newsroom, candidate], map = clusters) => coPublishedCopiesAsOrigins(pages, map).find((entry) => entry.id === candidate.id).judgment.kind;
  assert.equal(keep({ ...wire, judgment: unclear("other") }), "unclear", "a page whose possible parent is a different page is left to that path");
  assert.equal(keep(wire, [{ ...newsroom, publishedDate: "2019-11-20" }, wire]), "unclear", "an origin dated strictly earlier could have been its parent; the judge's doubt stands");
  assert.equal(keep(wire, [{ ...newsroom, publishedDate: "2019-11-23" }, wire]), "origin", "an origin posted two days after it is still the same release");
  assert.equal(keep(wire, [{ ...newsroom, publishedDate: "2019-11-26" }, wire]), "unclear", "more than three days apart is not one release");
  assert.equal(keep({ ...wire, text: "A different take on phone habits, written by a separate desk with its own reporting and none of the release's sentences, 96 times a day." }), "unclear", "different text stays unresolved");
  assert.equal(keep({ ...wire, extractionSource: "Search snippet" }), "unclear", "a search snippet is too little text to call it the same release");
  assert.equal(keep({ ...wire, judgment: { ...unclear(), evidence: UNJUDGED_EVIDENCE } }), "unclear", "a page the judge returned nothing for stays unjudged");
  assert.equal(keep({ ...wire, publishedDateSource: "Tavily estimate" }), "unclear", "an estimated date is not enough to call them the same day");
  assert.equal(keep(wire, [newsroom, wire], new Map([["newsroom", new Set(["newsroom"])], ["wire", new Set(["wire"])]])), "unclear", "an origin in another claim group does not count");
  assert.equal(keep(wire, [{ ...newsroom, judgment: unclear() }, wire]), "unclear", "two unresolved copies do not promote each other: it only joins an existing origin");
  // The bundled search trace (asurion.com and prnewswire.com already counted once) is unchanged by the guard.
  const bundled = JSON.parse(fs.readFileSync(path.join(projectRoot, "public/demo-traces/americans-check-phones-96-times.echo.json"), "utf8")).analysis;
  const bundledClusters = new Map(bundled.clusters.flatMap((cluster) => cluster.pageIds.map((id) => [id, new Set(cluster.pageIds)])));
  const replayed = coPublishedCopiesAsOrigins(bundled.pages, bundledClusters);
  assert.deepEqual(replayed.map((entry) => entry.judgment), bundled.pages.map((entry) => entry.judgment), "the search-mode phones trace keeps every judgment");
  assert.deepEqual(bundled.coPublishedRootGroups, [["page-2", "page-3"]], "and its asurion.com + prnewswire.com pair");
}

// Bug round 3 (11/13, QA #3): once two pages are a co-published pair, the partner's judge evidence must not contradict
// it. On the phones sources run Asurion's read "...the same-day press release is a copy, not an earlier source." while
// PR Newswire's said both are one origin. The partner gets Echo's own note first, then Claude's text, labeled.
{
  const { coPublishedPartnerNotes, coPublishedCopiesAsOrigins, safeJudgment } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  const release = "Americans now check their phones 96 times a day, once every 10 minutes, according to new research by global tech care company Asurion. That is a 20 percent daily increase from a similar survey conducted by Asurion two years ago. Eighteen to 24 year olds check their phones twice as much as the national average.";
  const page = (id, date, judgment, extra = {}) => ({ id, title: id, domain: `${id}.example`, url: `https://${id}.example/`, text: release, hasPrimaryEvidence: true, extractionSource: "Tavily extraction", publishedDate: date, publishedDateSource: "page metadata", judgment, ...extra });
  const claudeSays = "Asurion's own page reports its new survey; the same-day press release is a copy, not an earlier source.";
  const newsroom = page("newsroom", "2019-11-21", { kind: "origin", parentId: null, confidence: 90, evidence: claudeSays });
  const wireDraft = page("wire", "2019-11-21", { kind: "unclear", parentId: null, confidence: 0, evidence: "Not dated earlier." }, { text: `NASHVILLE, Tenn., Nov. 21, 2019 /PRNewswire/ -- ${release}` });
  const group = new Set(["newsroom", "wire", "fox"]);
  const clusters = new Map([...group].map((id) => [id, group]));
  const fox = page("fox", "2021-09-28", { kind: "derived", parentId: "newsroom", confidence: 82, evidence: "Fox repeats the release." }, { text: "Fox 13 says Americans check phones 96 times a day." });
  const paired = coPublishedCopiesAsOrigins([newsroom, wireDraft, fox], clusters);
  const [lead, wire, copy] = coPublishedPartnerNotes(paired, clusters);
  assert.match(wire.judgment.evidence, /^Published within days of newsroom\.example/, "the wire page keeps Echo's co-published note");
  assert.equal(lead.judgment.evidence, `Published the same day as wire.example with largely identical text; Echo counts them as one origin. Claude's note: ${claudeSays}`, "the partner's evidence starts with Echo's pair note, then Claude's text, labeled");
  assert.deepEqual([lead.judgment.kind, lead.judgment.parentId, lead.judgment.confidence, lead.hasPrimaryEvidence], ["origin", null, 90, true], "only the evidence text changes");
  assert.equal(copy, paired[2], "pages outside the pair are untouched");
  assert.equal(coPublishedPartnerNotes(coPublishedPartnerNotes(paired, clusters), clusters)[0].judgment.evidence, lead.judgment.evidence, "running it twice adds the note once");
  // The safeJudgment path (the judge called the wire derived from a newsroom page dated a day later): the same note on
  // the partner, "within days" when the dates differ.
  const laterNewsroom = { ...newsroom, publishedDate: "2019-11-22" };
  const viaDerived = safeJudgment({ kind: "derived", parentId: "newsroom", confidence: 80, evidence: "Same text.", hasPrimaryEvidence: false }, wireDraft, new Map([["newsroom", laterNewsroom], ["wire", wireDraft]]), group, "Americans check their phones 96 times a day");
  assert.equal(viaDerived.kind, "origin", "safeJudgment makes the wire a co-published origin");
  const [partnerLater] = coPublishedPartnerNotes([laterNewsroom, { ...wireDraft, judgment: viaDerived }], clusters);
  assert.match(partnerLater.judgment.evidence, /^Published within days of wire\.example with largely identical text; Echo counts them as one origin\. Claude's note: /, "pages a day apart are 'within days'");
  // Left alone: no Echo-made pair in the trace, another claim group.
  assert.equal(coPublishedPartnerNotes([newsroom, fox], clusters)[0], newsroom, "a trace with no co-published pair is unchanged");
  const apart = new Map([["newsroom", new Set(["newsroom"])], ["wire", new Set(["wire"])]]);
  assert.equal(coPublishedPartnerNotes([newsroom, wire], apart)[0], newsroom, "a page in another claim group gets no note");
  // judgePages applies it last, after every other guard.
  const source = fs.readFileSync(path.join(projectRoot, "src/lib/echo/pipeline.ts"), "utf8");
  assert.match(source, /return coPublishedPartnerNotes\(breakDerivedCycles\(coPublishedCopiesAsOrigins\(/, "judgePages ends with coPublishedPartnerNotes");
}

// Cost round 2 (11/13): the search cache is on by default; ECHO_SEARCH_CACHE=0 is the opt-out. "Run fresh" always
// searching is checked end to end with mocked providers in scripts/measure-cost.mjs.
{
  const { searchCacheEnabled } = load(path.join(projectRoot, "src/lib/echo/cost-flags.ts"));
  const saved = process.env.ECHO_SEARCH_CACHE;
  const cases = [[undefined, true], ["", true], ["1", true], ["0", false], [" 0 ", false], ["off", true]];
  for (const [value, expected] of cases) {
    if (value === undefined) delete process.env.ECHO_SEARCH_CACHE;
    else process.env.ECHO_SEARCH_CACHE = value;
    assert.equal(searchCacheEnabled(), expected, `ECHO_SEARCH_CACHE=${JSON.stringify(value)} -> search cache ${expected ? "on" : "off"}`);
  }
  if (saved === undefined) delete process.env.ECHO_SEARCH_CACHE;
  else process.env.ECHO_SEARCH_CACHE = saved;
}

// Bug round 4 (11/13): the loop guard must touch only the loop. A dated copy x hangs off a loop a <-> b; x's own link
// is outside the loop and stays derived, and a separate dated chain in the same trace is left alone.
{
  const { breakDerivedCycles } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  const page = (id, date, judgment) => ({ id, title: id, domain: `${id}.example`, url: `https://${id}.example/`, text: "t", hasPrimaryEvidence: false, publishedDate: date, publishedDateSource: date ? "page metadata" : undefined, judgment });
  const derived = (parentId) => ({ kind: "derived", parentId, confidence: 70, evidence: "x" });
  const pages = breakDerivedCycles([
    page("a", "2020-01-01", derived("b")),
    page("b", null, derived("a")),
    page("x", "2021-01-01", derived("a")),
    page("root", "2018-01-01", { kind: "origin", parentId: null, confidence: 80, evidence: "x" }),
    page("copy", "2019-01-01", derived("root")),
    page("copy2", null, derived("copy")),
  ]);
  const kind = (id) => pages.find((entry) => entry.id === id).judgment.kind;
  assert.equal(kind("x"), "derived", "a link into a loop, from outside it, stays derived");
  assert.ok(["a", "b"].every((id) => kind(id) === "unclear"), "both undated links of the loop become unclear");
  assert.deepEqual(["root", "copy", "copy2"].map(kind), ["origin", "derived", "derived"], "a chain with no loop, even through an undated page, is untouched");
}

// Bug round 4 (11/13), fixed by the cost agent: the searched phrase behind six of the ten query variants kept its first
// 7 kept words, so a negation or the assertion after them was cut and those six searches asked the opposite question:
// "Cracking your knuckles every single day does not cause arthritis" searched "Cracking your knuckles every single day
// does fact check source" (no "not", no "arthritis"). Stop words of four or more letters ("does", "your", "that") had
// passed the length test and used up the slots. Now filler is dropped at any length, negations are always kept, and a
// long claim keeps its last three words.
{
  const { generateQueries } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  const phraseQueries = (claim) => generateQueries(claim).filter((query) => !query.startsWith('"') && query !== claim);
  const suffix = / (?:fact check source|study OR report OR paper|original source|according to|study finds|statistics source|evidence)$/;
  for (const [claim, words] of [
    ["Cracking your knuckles every single day does not cause arthritis", ["not", "arthritis"]],
    ["Most people who drink coffee every morning before work are not dehydrated", ["not", "dehydrated"]],
    ["Sugar doesn't make kids hyperactive", ["doesn't", "hyperactive"]],
    ["Vaccines never cause autism", ["never", "autism"]],
    ["Eating carrots without butter does nothing for your eyesight", ["without", "nothing", "eyesight"]],
  ]) {
    const queries = phraseQueries(claim);
    assert.ok(queries.length >= 6, `"${claim}" still has its phrase variants`);
    for (const query of queries) for (const word of words) assert.ok(query.toLowerCase().split(/\s+/).includes(word), `"${query}" keeps "${word}"`);
    for (const query of queries) assert.ok(!/\b(?:does|your|that|have|who)\b/i.test(query.replace(suffix, "")), `"${query}" drops filler words at any length`);
  }
  // "US" and "IT" in capitals are names, not "us" and "it".
  for (const query of phraseQueries("IT workers in the US earn 20% more")) assert.match(query, /^IT workers US earn 20%/, `"${query}" keeps IT, US and the percent sign`);
  assert.ok(!phraseQueries("Tell us what it costs").some((query) => /\b(?:us|it)\b/.test(query.replace(suffix, ""))), "lowercase us and it are still filler");
  // The quoted figure phrase keeps its percent sign.
  assert.ok(generateQueries("Humans use only 10% of their brains").includes('"10% of their brains"'), "the quoted number phrase keeps 10%");
  // A quoted phrase is words that stand next to each other in the claim.
  const quotedOf = (claim) => generateQueries(claim).filter((query) => query.startsWith('"')).map((query) => query.slice(1, -1));
  for (const claim of ["Vaccines cause autism", "You lose most of your body heat through your head", "Cracking your knuckles every single day does not cause arthritis", "Americans check their phones 96 times a day"]) {
    for (const quoted of quotedOf(claim)) assert.ok(claim.includes(quoted), `quoted "${quoted}" appears as written in "${claim}"`);
  }
  assert.ok(!generateQueries("Vaccines cause autism").includes('"Vaccines autism"'), "no quoted phrase of words that are not next to each other");
}

// Cost round 3 (11/13): a live run read every page's own HTML only after Tavily's extract came back, 8 at a time
// (extract 4.8-9.6 s of a 36-46 s run). The free reads now start with the extract, up to 20 at once and at most 4 on
// one site, and keep their old limits. Its own hosts only: everything else still goes to the mock above, which
// main() is using at the same time.
{
  const { startPageReads, PAGE_READ_CONCURRENCY, PAGE_READS_PER_HOST } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  const dnsPromises = load("node:dns/promises");
  const originalLookup = dnsPromises.lookup;
  const originalFetch = global.fetch;
  const readHost = /^https:\/\/(busy|s\d+)\.reads-check\.example\//;
  dnsPromises.lookup = (hostname, ...rest) => (hostname.endsWith(".reads-check.example") ? Promise.resolve([{ address: "93.184.216.34", family: 4 }]) : originalLookup(hostname, ...rest));
  let running = 0;
  let maxRunning = 0;
  const runningByHost = new Map();
  let maxOnOneHost = 0;
  const started = [];
  let releaseAll = null;
  let gate = new Promise((resolve) => { releaseAll = resolve; });
  global.fetch = async (url, options) => {
    const address = String(url);
    if (!readHost.test(address)) return originalFetch(url, options);
    const host = new URL(address).host;
    started.push(address);
    running += 1;
    runningByHost.set(host, (runningByHost.get(host) ?? 0) + 1);
    maxRunning = Math.max(maxRunning, running);
    maxOnOneHost = Math.max(maxOnOneHost, runningByHost.get(host));
    try {
      await gate;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(`<html><head></head><body><a href="https://cited.example${new URL(address).pathname}">source</a></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
    } finally {
      running -= 1;
      runningByHost.set(host, runningByHost.get(host) - 1);
    }
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  (async () => {
    try {
      assert.equal(PAGE_READ_CONCURRENCY, 20);
      assert.equal(PAGE_READS_PER_HOST, 4);
      // 6 pages on one site and 20 on others: the reads start before anything is classified, at most 20 at once.
      const urls = [...Array.from({ length: 6 }, (_, index) => `https://busy.reads-check.example/p${index}`), ...Array.from({ length: 20 }, (_, index) => `https://s${index}.reads-check.example/p${index}`)];
      const reads = startPageReads(urls, undefined, true);
      await settle();
      assert.ok(running > 0, "page reads start before the extract result classifies them");
      assert.equal(maxRunning, PAGE_READ_CONCURRENCY, "at most 20 page reads at once");
      assert.equal(maxOnOneHost, PAGE_READS_PER_HOST, "at most 4 reads on one site at once");
      // The last busy-site page needs a date: it moves ahead of the other queued busy-site page.
      reads.classify(urls.map((url) => url.endsWith("busy.reads-check.example/p5")));
      releaseAll();
      const facts = await reads.results();
      assert.deepEqual(facts.map((fact) => fact.links[0]), urls.map((url) => `cited.example${new URL(url).pathname}`), "facts come back in the order of the pages");
      const busyStarts = started.filter((address) => address.includes("busy."));
      assert.ok(busyStarts.indexOf("https://busy.reads-check.example/p5") < busyStarts.indexOf("https://busy.reads-check.example/p4"), "a page that needs a date is read before a queued link-only page");
      assert.ok(maxOnOneHost <= PAGE_READS_PER_HOST && maxRunning <= PAGE_READ_CONCURRENCY, "the limits held for the whole step");
      // A failed extract cancels the reads: pending pages resolve with no facts and nothing rejects.
      gate = new Promise((resolve) => { releaseAll = resolve; });
      const cancelled = startPageReads(urls.slice(0, 8), undefined, true);
      await settle();
      cancelled.cancel();
      releaseAll();
      const none = await cancelled.results();
      assert.ok(none.every((fact) => fact.date === null && fact.links.length === 0), "cancelled reads give no facts");
      console.log("Page reads passed: they overlap the extract, at most 20 at once and 4 per site, date pages first, cancel cleanly.");
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      global.fetch = originalFetch;
      dnsPromises.lookup = originalLookup;
    }
  })();
}

// Bug round 6 (11/14), ahead of the cost agent's concurrency work: reservation races in the daily cap. Runs after
// main() (on beforeExit, so it never shares main's mocks or ledger) with fresh copies of pipeline.ts and
// daily-budget.ts in their own throwaway working directory, so the ledger is a scratch file and nothing reaches a
// provider. Every reserve, settle and release goes through a wrapper that records it per reservation id, and every paid
// request (Tavily search/extract, Claude messages) reads the ledger at the moment it is sent. Checked:
// 1. A burst of concurrent paid calls whose combined reservations exceed what is left: only those that fit are sent,
//    the rest are refused before sending (Tavily searches, then Claude grouping requests).
// 2. Each reservation is settled or released exactly once, never twice.
// 3. A failure mid-batch (503 after retry, a network error, a cancel; Claude 400 and 529) releases that request's
//    reservation while the others settle. Claude 500s and transport errors keep theirs, as pipeline.ts documents
//    (billing may be ambiguous): checked as held, counted against the cap, and finished zero times.
// 4. Three whole runs at once under a cap that fits about one and a half: at every paid send, spent + reserved stays
//    within the cap and the request holds a reservation; afterwards none is left open.
// 5. Page reads overlapping the extract (startPageReads) take no reservation, and an extract failure (a 401, or the
//    ledger refusing a batch) cancels the reads, sends no Claude request and leaves no reservation behind.
// Mutation-checked on scratch copies (11/14): an unlocked reserve, a Tavily settle without its once-guard, a 529 retry
// that does not release, and an extract failure that does not cancel the page reads each fail this block.
process.once("beforeExit", () => {
  reservationRaceChecks().catch((error) => { console.error(error); process.exitCode = 1; });
});

async function reservationRaceChecks() {
  const baseFetch = global.fetch; // main's provider mock, its modes back at their defaults
  const savedEnv = { ...process.env };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "echo-reservation-check-"));
  process.chdir(scratch);
  const echoLib = path.join(projectRoot, "src", "lib", "echo");
  for (const key of Object.keys(load.cache)) if (key.startsWith(echoLib)) delete load.cache[key];
  process.env.ECHO_SEARCH_CACHE = "0";
  process.env.ECHO_TAVILY_USD_PER_CREDIT = "0.01";
  const PROVIDERS = ["claude", "tavily", "telem"];
  const CAP_VARIABLE = { claude: "ECHO_CLAUDE_DAILY_CAP_USD", tavily: "ECHO_TAVILY_DAILY_CAP_USD", telem: "ECHO_TELEM_DAILY_CAP_USD" };
  const capOf = (provider) => Number(process.env[CAP_VARIABLE[provider]]);
  for (const provider of PROVIDERS) process.env[CAP_VARIABLE[provider]] = "2";
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const budget = load(path.join(echoLib, "daily-budget.ts"));
    const pipeline = load(path.join(echoLib, "pipeline.ts"));
    const real = { reserve: budget.reserveAnthropicBudget, settle: budget.settleAnthropicBudget, release: budget.releaseAnthropicBudget };
    let reservations = new Map();
    const unknownFinishes = [];
    let reserveCalls = 0;
    let refuseReservation = () => false; // (call number) -> true to refuse it as the ledger would at the cap
    budget.reserveAnthropicBudget = async (amountUsd, provider) => {
      reserveCalls += 1;
      // A refusal waits its turn on the ledger lock, as a real one does (a zero reservation, taken and given back).
      if (refuseReservation(reserveCalls) && await real.release(await real.reserve(0, provider)) === undefined) throw new budget.AnthropicBudgetError("DAILY_BUDGET_REACHED", "Refused by the race check, as if another run had taken the rest of the day's cap.");
      const reservation = await real.reserve(amountUsd, provider);
      assert.equal(reservation.provider, provider ?? "claude", "a reservation is taken against the provider that asked for it");
      reservations.set(reservation.id, { amountUsd: reservation.amountUsd, provider: reservation.provider, finishes: [] });
      return reservation;
    };
    const finish = (reservation, how) => {
      const entry = reservations.get(reservation.id);
      if (entry) entry.finishes.push(how);
      else unknownFinishes.push(how);
    };
    budget.settleAnthropicBudget = async (reservation, usd) => { finish(reservation, "settle"); return real.settle(reservation, usd); };
    budget.releaseAnthropicBudget = async (reservation) => { finish(reservation, "release"); return real.release(reservation); };

    const day = (await budget.getAnthropicBudgetSnapshot()).day;
    const ledgerFile = path.join(process.cwd(), ".echo", "anthropic-daily-budget.json");
    // The scratch ledger (version 2): one entry per provider per day. usage() sums them; usageOf(provider) reads one.
    const usageOf = (provider) => {
      let entry;
      try {
        const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
        assert.equal(ledger.version, 2, "the ledger is written as version 2");
        entry = ledger.days[day]?.[provider];
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      entry ??= { spentUsd: 0, reservations: {} };
      const amounts = Object.values(entry.reservations);
      return { spent: entry.spentUsd, reserved: amounts.reduce((sum, amount) => sum + amount, 0), open: amounts.length };
    };
    const usage = () => PROVIDERS.map(usageOf).reduce((sum, entry) => ({ spent: sum.spent + entry.spent, reserved: sum.reserved + entry.reserved, open: sum.open + entry.open }), { spent: 0, reserved: 0, open: 0 });
    // Every provider's cap at capUsd, or each named in an object ({ claude: 0.1 }) and the others at $2.
    const freshLedger = (capUsd) => {
      fs.rmSync(path.join(process.cwd(), ".echo"), { recursive: true, force: true });
      for (const provider of PROVIDERS) process.env[CAP_VARIABLE[provider]] = String(typeof capUsd === "number" ? capUsd : capUsd[provider] ?? 2);
      reservations = new Map();
    };
    let inFlight = 0;
    let peakReserved = 0;
    let peakByProvider = { claude: 0, tavily: 0, telem: 0 };
    // Called the moment a paid request is sent: its reservation is already on the ledger, and every provider's entry
    // is within that provider's own cap.
    const atSend = (label) => {
      inFlight += 1;
      const now = usage();
      peakReserved = Math.max(peakReserved, now.reserved);
      for (const provider of PROVIDERS) {
        const entry = usageOf(provider);
        const cap = capOf(provider);
        peakByProvider[provider] = Math.max(peakByProvider[provider], entry.reserved);
        assert.ok(entry.spent + entry.reserved <= cap + 1e-9, `${label}: ${provider} spent $${entry.spent} + reserved $${entry.reserved} stays within its $${cap} cap when the request is sent`);
      }
      assert.ok(now.open >= inFlight, `${label}: every paid request in flight holds a reservation (${now.open} open for ${inFlight} in flight)`);
    };
    const gate = () => {
      let open;
      const opened = new Promise((resolve) => { open = resolve; });
      return { open, wait: () => Promise.race([opened, delay(2_000)]) };
    };
    const everyFinishedOnce = (label) => {
      assert.deepEqual(unknownFinishes, [], `${label}: nothing settles or releases a reservation it did not take`);
      for (const [id, entry] of reservations) assert.equal(entry.finishes.length, 1, `${label}: reservation ${id.slice(0, 8)} ($${entry.amountUsd}) finished ${entry.finishes.length} times (${entry.finishes.join(", ") || "never"}), expected once`);
    };
    const finishes = () => [...reservations.values()].map((entry) => entry.finishes.join("+") || "held");

    // 1a. Ten concurrent basic searches at $0.01 a credit; $0.035 fits three. The mock holds every sent search until
    // all ten have been sent or refused, so a settle cannot free room mid-burst.
    {
      freshLedger(0.035);
      const total = 10;
      let sent = 0;
      let refused = 0;
      const burst = gate();
      const check = () => { if (sent + refused === total) burst.open(); };
      global.fetch = async (url) => {
        if (!String(url).endsWith("/search")) throw new Error(`unexpected request ${url}`);
        sent += 1;
        atSend("search burst");
        check();
        await burst.wait();
        inFlight -= 1;
        return json({ results: [], usage: { credits: 1 } });
      };
      const outcomes = await Promise.allSettled(Array.from({ length: total }, (_, index) => pipeline.tavilyPost("search", { query: `race ${index}`, search_depth: "basic" })
        .catch((error) => { refused += 1; check(); throw error; })));
      assert.equal(sent, 3, "only the three searches the cap can cover are sent");
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason.code === "DAILY_BUDGET_REACHED").length, 7, "the other seven are refused by the cap before sending");
      const after = usage();
      assert.ok(after.open === 0 && Math.abs(after.spent - 0.03) < 1e-9, `the ledger ends with no open reservation and $0.03 spent (open ${after.open}, spent $${after.spent})`);
      everyFinishedOnce("search burst");
    }

    // 1b. Six concurrent grouping requests; the cap fits two of their full reservations (input + all of the output
    // limit). One request first, with nothing held back, measures the reservation.
    const pages = ["page-1", "page-2", "page-3"].map((id, index) => ({ id, title: `Page ${index + 1}`, domain: `p${index}.example`, url: `https://p${index}.example/`, text: "90% of startups fail.", publishedDate: null, hasPrimaryEvidence: false, judgment: { kind: "unclear", parentId: null, confidence: 0, evidence: "x" } }));
    let claudeMode = () => null; // (case name, attempt) -> a Response or an Error to use instead of the mock's answer
    const claudeAttempts = new Map();
    const claudeFetch = (burst) => async (url, options) => {
      const endpoint = String(url);
      if (endpoint.endsWith("/count_tokens")) return baseFetch(url, options);
      if (!endpoint.endsWith("/messages")) throw new Error(`unexpected request ${url}`);
      const prompt = JSON.parse(options.body).messages[0].content;
      const name = typeof prompt === "string" ? prompt.match(/race case (\w+)/)?.[1] ?? "?" : "?";
      claudeAttempts.set(name, (claudeAttempts.get(name) ?? 0) + 1);
      atSend(`grouping ${name}`);
      try {
        await burst?.();
        const replaced = claudeMode(name, claudeAttempts.get(name));
        if (replaced instanceof Error) throw replaced;
        return replaced ?? await baseFetch(url, options);
      } finally {
        inFlight -= 1;
      }
    };
    {
      freshLedger(2);
      global.fetch = claudeFetch();
      await pipeline.clusterPages("90% of startups fail, race case probe", pages);
      const [probe] = [...reservations.values()];
      assert.ok(probe && probe.amountUsd > 0, "a grouping request reserves before it is sent");
      freshLedger(probe.amountUsd * 2.5);
      const total = 6;
      let sent = 0;
      let refused = 0;
      const burst = gate();
      const check = () => { if (sent + refused === total) burst.open(); };
      global.fetch = claudeFetch(async () => { sent += 1; check(); await burst.wait(); });
      const outcomes = await Promise.allSettled(Array.from({ length: total }, (_, index) => pipeline.clusterPages(`90% of startups fail, race case burst${index}`, pages)
        .catch((error) => { refused += 1; check(); throw error; })));
      assert.equal(sent, 2, `only the two grouping requests the cap covers are sent (sent ${sent})`);
      assert.equal(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason.code === "DAILY_BUDGET_REACHED").length, 4, "the other four are refused before sending");
      assert.equal(usage().open, 0, "no reservation is left open after the burst");
      everyFinishedOnce("grouping burst");
    }

    // 3a. Six concurrent searches, three of which fail mid-batch: a 503 (twice, so after its retry), a network error,
    // and a cancel while the request is out. Each failure releases its reservation; the three successes settle.
    {
      freshLedger(2);
      const controller = new AbortController();
      let sent = 0;
      const allSent = gate();
      global.fetch = async (url, options) => {
        const query = JSON.parse(options.body).query;
        atSend(`search ${query}`);
        if (query !== "fail 503") sent += 1;
        if (sent === 5) allSent.open();
        try {
          if (query === "fail 503") return new Response("unavailable", { status: 503 });
          if (query === "fail network") throw new TypeError("fetch failed");
          if (query === "fail cancel") {
            return await new Promise((_, reject) => {
              if (options.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
              options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
            });
          }
          await allSent.wait();
          return json({ results: [], usage: { credits: 1 } });
        } finally {
          inFlight -= 1;
        }
      };
      const queries = ["ok 1", "ok 2", "fail 503", "fail network", "fail cancel", "ok 3"];
      const running = queries.map((query) => pipeline.tavilyPost("search", { query, search_depth: "basic" }, query === "fail cancel" ? controller.signal : undefined));
      await allSent.wait();
      controller.abort();
      const outcomes = await Promise.allSettled(running);
      assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled", "rejected", "rejected", "rejected", "fulfilled"], "the three failures fail and the others complete");
      assert.deepEqual(finishes(), ["settle", "settle", "release", "release", "release", "settle"], "each failure releases its own reservation and each success settles its own");
      const after = usage();
      assert.ok(after.open === 0 && Math.abs(after.spent - 0.03) < 1e-9, `only the three successful searches are charged (open ${after.open}, spent $${after.spent})`);
      everyFinishedOnce("search failures");
    }

    // 3b. Claude requests failing mid-batch, all at once: a 400 and two 529s are rejections with no completion, so
    // their reservations are released (a 529 releases before its one retry and reserves again); a 529 then a success
    // settles the retry's reservation. A 500 and a dropped connection keep their reservation on the ledger (billing
    // may be ambiguous): held, still counted against the cap, finished zero times.
    {
      freshLedger(2);
      claudeAttempts.clear();
      const status = (code) => new Response(JSON.stringify({ type: "error" }), { status: code, headers: { "retry-after": "0" } });
      claudeMode = (name, attempt) => ({
        bad: () => status(400),
        busy: () => status(529),
        busyonce: () => (attempt === 1 ? status(529) : null),
        server: () => status(500),
        dropped: () => new TypeError("fetch failed"),
      })[name]?.() ?? null;
      global.fetch = claudeFetch();
      const cases = ["ok", "bad", "busy", "busyonce", "server", "dropped"];
      const outcomes = await Promise.allSettled(cases.map((name) => pipeline.clusterPages(`90% of startups fail, race case ${name}`, pages)));
      claudeMode = () => null;
      assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "rejected", "rejected", "fulfilled", "rejected", "rejected"], "the ok and retried requests complete; the others fail");
      assert.deepEqual(cases.map((name) => claudeAttempts.get(name)), [1, 1, 2, 2, 1, 1], "a 529 is retried once; nothing else is");
      const byOutcome = finishes().sort();
      assert.deepEqual(byOutcome, ["held", "held", "release", "release", "release", "release", "settle", "settle"], `eight reservations: two settled, four released, two held (${byOutcome.join(", ")})`);
      const held = [...reservations.values()].filter((entry) => !entry.finishes.length).reduce((sum, entry) => sum + entry.amountUsd, 0);
      const after = usage();
      assert.ok(after.open === 2 && Math.abs(after.reserved - held) < 1e-9, `the ledger holds the 500's and the dropped request's reservations ($${held.toFixed(4)}) against the cap`);
      for (const [id, entry] of reservations) assert.ok(entry.finishes.length <= 1, `reservation ${id.slice(0, 8)} is never finished twice`);
    }

    // 4. Three whole runs at once. One run alone first measures its peak reserved amount; the cap is then set to one
    // and a half of that, so the three runs cannot all hold their reservations at once.
    {
      freshLedger(2);
      process.env.ECHO_TAVILY_USD_PER_CREDIT = "0.001";
      global.fetch = async (url, options) => {
        const endpoint = String(url);
        const paid = endpoint.endsWith("/search") || endpoint.endsWith("/extract") || endpoint.endsWith("/messages");
        if (!paid) return baseFetch(url, options);
        atSend(endpoint.slice(endpoint.lastIndexOf("/") + 1));
        try {
          await delay(5);
          return await baseFetch(url, options);
        } finally {
          inFlight -= 1;
        }
      };
      peakReserved = 0;
      peakByProvider = { claude: 0, tavily: 0, telem: 0 };
      await pipeline.analyzeClaim("90% of startups fail, race run alone", () => {}, { forceFresh: true });
      const onePeak = peakByProvider.claude;
      assert.ok(onePeak > 0 && peakByProvider.tavily > 0 && usage().open === 0, "a single run reserves before each paid request (Claude's and Tavily's) and leaves nothing open");
      everyFinishedOnce("single run");
      // Claude's cap at one and a half runs' peak (Tavily's stays at $2): the three runs race for Claude's room.
      freshLedger({ claude: onePeak * 1.5 });
      peakReserved = 0;
      // Named, not numbered: a "1" in the claim would be a figure every search result must state.
      const runs = await Promise.allSettled(["alpha", "beta", "gamma"].map((name) => pipeline.analyzeClaim(`90% of startups fail, race run ${name}`, () => {}, { forceFresh: true })));
      // A run that failed may still have requests out (Promise.all rejects on the first failure): wait for them.
      for (let waited = 0; waited < 2_000 && [...reservations.values()].some((entry) => !entry.finishes.length); waited += 20) await delay(20);
      const refused = runs.filter((run) => run.status === "rejected");
      assert.ok(refused.every((run) => run.reason.code === "DAILY_BUDGET_REACHED"), `a run stopped only by the cap (${refused.map((run) => run.reason.code ?? run.reason.message).join(", ")})`);
      assert.ok(refused.length >= 1, "three runs at once cannot all fit a cap of one and a half runs");
      const after = usage();
      assert.ok(after.open === 0 && PROVIDERS.every((provider) => usageOf(provider).spent <= capOf(provider) + 1e-9), `no reservation is left open and each provider's spending stays within its cap (open ${after.open}, Claude spent $${usageOf("claude").spent} of $${capOf("claude")})`);
      everyFinishedOnce("three runs");
      process.stdout.write(`  ok  reservation races: 3 of 10 concurrent searches and 2 of 6 grouping requests sent under a cap that covers that many; each reservation finished once; failures mid-batch release theirs (Claude 500s and dropped connections hold theirs, by design); three runs under a Claude cap of 1.5 runs: ${runs.length - refused.length} completed, ${refused.length} stopped by the cap, never over the cap at any send\n`);
    }

    // 5. Page reads overlapping the extract (startPageReads, cost round 3). 14 pages, so two extract batches (10 + 4),
    // while every page's own HTML is read at once. Page reads are free: they take no reservation. The extract then
    // fails mid-batch, either rejected (Tavily 401, which stops the run) or refused by the ledger before its request
    // (DAILY_BUDGET_REACHED on the second batch's reservation), while the other batch is still out. The run stops,
    // every page read in flight is cancelled, no Claude request is sent, and the batch still out settles its own
    // reservation when it returns: nothing is left open.
    {
      const dnsPromises = load("node:dns/promises");
      const originalLookup = dnsPromises.lookup;
      const readsHost = ".race-reads.example";
      dnsPromises.lookup = (hostname, ...rest) => (hostname.endsWith(readsHost) ? Promise.resolve([{ address: "93.184.216.34", family: 4 }]) : originalLookup(hostname, ...rest));
      const results = Array.from({ length: 14 }, (_, index) => ({ url: `https://r${index}${readsHost}/startups`, title: `90% of startups fail, report ${index}`, content: "90% of startups fail in this report.", published_date: "2021-01-01", score: 0.9 - index * 0.01 }));
      let searchesSent = 0;
      try {
        for (const mode of ["auth", "cap"]) {
          freshLedger(2);
          process.env.ECHO_TAVILY_USD_PER_CREDIT = "0.001";
          let searches = 0;
          let extractsSent = 0;
          let claudeSent = 0;
          let readsStarted = 0;
          let readsAborted = 0;
          const heldBatch = gate();
          // In "cap" mode the second extract batch's reservation is refused; in "auth" mode the first batch is rejected.
          refuseReservation = (call) => mode === "cap" && call === searchesSent + 2;
          reserveCalls = 0;
          global.fetch = async (url, options) => {
            const endpoint = String(url);
            if (endpoint.endsWith("/search")) {
              searches += 1;
              atSend("search");
              inFlight -= 1;
              return json({ results, usage: { credits: 1 } });
            }
            if (endpoint.endsWith("/extract")) {
              extractsSent += 1;
              atSend("extract");
              try {
                const batch = JSON.parse(options.body).urls;
                await delay(20); // the page reads are under way before the extract answers
                if (mode === "auth" && batch.includes(results[0].url)) return new Response("bad key", { status: 401 });
                await heldBatch.wait();
                return json({ results: [], usage: { credits: 1 } });
              } finally {
                inFlight -= 1;
              }
            }
            if (endpoint.endsWith("/messages") || endpoint.endsWith("/count_tokens")) {
              claudeSent += 1;
              return baseFetch(url, options);
            }
            if (endpoint.includes(readsHost)) {
              readsStarted += 1;
              return new Promise((_, reject) => {
                const abort = () => { readsAborted += 1; reject(new DOMException("aborted", "AbortError")); };
                if (options?.signal?.aborted) abort();
                else options?.signal?.addEventListener("abort", abort, { once: true });
              });
            }
            return baseFetch(url, options);
          };
          const failure = await pipeline.analyzeClaim("90% of startups fail, race reads", () => {}, { forceFresh: true }).then(() => null, (error) => error);
          if (mode === "auth") searchesSent = searches;
          assert.equal(failure?.code, mode === "auth" ? "TAVILY_AUTH" : "DAILY_BUDGET_REACHED", `${mode}: the failed extract stops the run (${failure?.code ?? failure?.message ?? "it completed"})`);
          assert.equal(extractsSent, mode === "auth" ? 2 : 1, `${mode}: ${mode === "auth" ? "both batches were sent" : "the refused batch was never sent"}`);
          assert.equal(reservations.size, searches + extractsSent, `${mode}: one reservation per search and per extract sent; page reads take none`);
          await delay(30);
          assert.ok(readsStarted > 0 && readsAborted === readsStarted, `${mode}: every page read in flight is cancelled (${readsAborted} of ${readsStarted})`);
          assert.equal(claudeSent, 0, `${mode}: no Claude request after the extract failed`);
          assert.equal(usage().open, 1, `${mode}: the batch still out holds its own reservation until it returns`);
          heldBatch.open();
          for (let waited = 0; waited < 2_000 && usage().open; waited += 10) await delay(10);
          assert.equal(usage().open, 0, `${mode}: once the last batch returns, no reservation is left`);
          everyFinishedOnce(`extract failure (${mode})`);
        }
        process.stdout.write(`  ok  page reads overlapping the extract take no reservation; a rejected extract (401) or one refused by the ledger stops the run, cancels every page read, sends no Claude request, and the batch still out settles its own reservation\n`);
      } finally {
        refuseReservation = () => false;
        dnsPromises.lookup = originalLookup;
      }
    }
  } finally {
    global.fetch = baseFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    process.chdir(os.tmpdir());
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Cost round 5 (11/14): a run that hits a provider time limit still says what it spent. Claude's 60 s limit throws a
// DOMException TimeoutError, not an EchoPipelineError, and analyzeClaim used to put its receipt only on the latter, so
// /api/analyze sent TIMEOUT with no receipt although the searches and extracts were already billed. Here the grouping
// request hangs until its time limit fires (AbortSignal.timeout's 60 s shortened to 40 ms for this check only); the
// thrown error must still be a TimeoutError, and must carry a receipt whose Tavily lines are exactly the mocked
// searches and extracts, with no Claude request on it (the hung request never returned usage). Runs after the
// reservation races (a beforeExit registered from inside the first one, so it never shares their mocks), with fresh
// module copies and a scratch ledger; no provider is reached.
process.once("beforeExit", () => {
  process.once("beforeExit", () => {
    timeoutReceiptCheck().catch((error) => { console.error(error); process.exitCode = 1; });
  });
});

async function timeoutReceiptCheck() {
  const baseFetch = global.fetch;
  const baseTimeout = AbortSignal.timeout;
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "echo-timeout-receipt-check-"));
  process.chdir(scratch);
  const echoLib = path.join(projectRoot, "src", "lib", "echo");
  for (const key of Object.keys(load.cache)) if (key.startsWith(echoLib)) delete load.cache[key];
  process.env.ECHO_SEARCH_CACHE = "0";
  process.env.ECHO_TAVILY_USD_PER_CREDIT = "0.008";
  for (const name of ["ECHO_CLAUDE_DAILY_CAP_USD", "ECHO_TAVILY_DAILY_CAP_USD", "ECHO_TELEM_DAILY_CAP_USD"]) process.env[name] = "2";
  delete process.env.ECHO_DEEP_SEARCH_BELOW;
  // AbortSignal.timeout's timer does not hold the process open (a server's sockets do), so this one does meanwhile.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const pipeline = load(path.join(echoLib, "pipeline.ts"));
    const host = ".timeout-receipt.example";
    const results = Array.from({ length: 4 }, (_, index) => ({ url: `https://t${index}${host}/startups`, title: `90% of startups fail, report ${index}`, content: "90% of startups fail in this report.", published_date: "2021-01-01", score: 0.9 - index * 0.01 }));
    const sent = { searches: 0, advancedSearches: 0, extracts: 0, extractedUrls: 0, credits: 0, groupingSent: 0, groupingTimedOut: 0, otherClaude: 0 };
    AbortSignal.timeout = (ms) => baseTimeout.call(AbortSignal, ms === 60_000 ? 40 : ms);
    global.fetch = async (url, options) => {
      if (options?.signal?.aborted) throw options.signal.reason;
      const endpoint = String(url);
      if (endpoint.endsWith("/search")) {
        // Four distinct pages is below the deep-search trigger, so the advanced pass runs too (2 credits each).
        const advanced = JSON.parse(options.body).search_depth === "advanced";
        sent.searches += 1;
        if (advanced) sent.advancedSearches += 1;
        sent.credits += advanced ? 2 : 1;
        return json({ results, usage: { credits: advanced ? 2 : 1 } });
      }
      if (endpoint.endsWith("/extract")) {
        sent.extracts += 1;
        const batch = JSON.parse(options.body).urls;
        sent.extractedUrls += batch.length;
        sent.credits += 1;
        return json({ results: batch.map((pageUrl) => ({ url: pageUrl, raw_content: `Published: 2021-01-01. 90% of startups fail, says ${pageUrl}.` })), usage: { credits: 1 } });
      }
      if (endpoint.endsWith("/count_tokens")) return json({ input_tokens: 100 });
      if (endpoint.endsWith("/messages")) {
        const prompt = JSON.parse(options.body).messages[0].content;
        if (typeof prompt !== "string" || !prompt.startsWith("Group these")) {
          sent.otherClaude += 1;
          throw new Error("only the grouping request should be sent before the time limit stops the run");
        }
        sent.groupingSent += 1;
        // A request that never answers: it ends only when its signal (the run's, combined with the time limit) aborts.
        return new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => { sent.groupingTimedOut += 1; reject(options.signal.reason); }, { once: true });
        });
      }
      return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    };
    const failure = await pipeline.analyzeClaim("90% of startups fail, timeout receipt", () => {}, { forceFresh: true }).then(() => null, (error) => error);
    assert.ok(failure instanceof DOMException && failure.name === "TimeoutError", `the hung grouping request ends the run with its TimeoutError, unchanged (${failure?.name ?? "it completed"}: ${failure?.message ?? ""})`);
    assert.equal(sent.groupingSent, 1, "one grouping request was sent");
    assert.equal(sent.groupingTimedOut, 1, "the grouping request was stopped by its time limit");
    assert.equal(sent.otherClaude, 0, "no judgment or answer request after the time limit");
    assert.ok(sent.searches > 0 && sent.extracts > 0, `the run searched and extracted before grouping (${sent.searches} searches, ${sent.extracts} extracts)`);
    const receipt = failure.costReceipt;
    assert.ok(receipt && receipt.version === 1, "the TimeoutError carries the run's receipt");
    assert.ok(!Object.keys(failure).includes("costReceipt"), "the receipt is non-enumerable on an error that is not an EchoPipelineError");
    assert.deepEqual(
      { basicSearches: receipt.tavily.basicSearches, advancedSearches: receipt.tavily.advancedSearches, extractRequests: receipt.tavily.extractRequests, extractedUrls: receipt.tavily.extractedUrls, credits: receipt.tavily.credits },
      { basicSearches: sent.searches - sent.advancedSearches, advancedSearches: sent.advancedSearches, extractRequests: sent.extracts, extractedUrls: sent.extractedUrls, credits: sent.credits },
      "the receipt's Tavily lines are exactly the mocked searches and extracts",
    );
    assert.deepEqual(receipt.claude, [], "the hung request returned no usage, so no Claude line is on the receipt");
    assert.equal(receipt.usd.tavily, Math.round(sent.credits * 0.008 * 1e6) / 1e6, "the Tavily dollars are the credits at the configured rate");
    assert.equal(receipt.usd.total, receipt.usd.tavily, "the run's total is its Tavily spend");
    process.stdout.write(`  ok  a provider time limit (Claude grouping, TimeoutError) still carries the run's receipt: ${sent.searches - sent.advancedSearches} basic + ${sent.advancedSearches} advanced searches and ${sent.extracts} extract = ${receipt.tavily.credits} credits, $${receipt.usd.total}; the error stays a TimeoutError\n`);
  } finally {
    clearInterval(keepAlive);
    AbortSignal.timeout = baseTimeout;
    global.fetch = baseFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    process.chdir(fs.existsSync(savedCwd) ? savedCwd : os.tmpdir());
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// "Check these sources" (supplied-sources mode): a person gives Echo the links (an AI answer's citations) and Echo
// reads exactly those, with no search. Four links where two copy the other two must come out as 2 independent
// origins; no Tavily search may be sent; the trace records the supplied links, round-trips through export/import, and
// a search run of the same claim never answers it from the cache. A fifth link that returns no text is listed as
// unread, not judged. Bad lists (empty, not http(s), private addresses, more than 20 links, not an array) are refused
// before anything is sent. Runs last (a third beforeExit, after the time-limit check), with fresh module copies, a
// scratch ledger and mocked providers and pages; no provider is reached.
process.once("beforeExit", () => {
  process.once("beforeExit", () => {
    process.once("beforeExit", () => {
      suppliedSourcesCheck().catch((error) => { console.error(error); process.exitCode = 1; });
    });
  });
});

async function suppliedSourcesCheck() {
  const baseFetch = global.fetch;
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "echo-sources-check-"));
  process.chdir(scratch);
  const echoLib = path.join(projectRoot, "src", "lib", "echo");
  for (const key of Object.keys(load.cache)) if (key.startsWith(echoLib)) delete load.cache[key];
  process.env.ECHO_TAVILY_USD_PER_CREDIT = "0.008";
  for (const name of ["ECHO_CLAUDE_DAILY_CAP_USD", "ECHO_TAVILY_DAILY_CAP_USD", "ECHO_TELEM_DAILY_CAP_USD"]) process.env[name] = "2";
  process.env.ECHO_SEARCH_CACHE = "0";
  const keepAlive = setInterval(() => {}, 1_000);
  const dnsPromises = load("node:dns/promises");
  const originalLookup = dnsPromises.lookup;
  const host = ".sources-check.example";
  dnsPromises.lookup = (hostname, ...rest) => (hostname.endsWith(host) ? Promise.resolve([{ address: "93.184.216.34", family: 4 }]) : originalLookup(hostname, ...rest));
  try {
    const pipeline = load(path.join(echoLib, "pipeline.ts"));
    const { makePortableTrace, parsePortableTrace } = load(path.join(echoLib, "portable.ts"));
    const { urlsInText } = load(path.join(echoLib, "supplied-urls.ts"));
    const A = `https://a${host}/phones-study`;
    const B = `https://b${host}/phones-copy`;
    const C = `https://c${host}/phone-habits`;
    const D = `https://d${host}/phone-news`;
    const E = `https://e${host}/paywalled`;
    const texts = {
      [A]: "# Our 2019 phone survey of 2,000 adults\nPublished: 2019-05-01. Our survey of 2,000 adults found Americans check their phones 96 times a day. Methods: a two-week diary study.",
      [B]: `Published: 2019-06-01. Americans check their phones 96 times a day, according to a survey. Source: ${A}`,
      [C]: "# Phone habits tracked by app\nPublished: 2019-04-01. Our app logged 11,000 phones: Americans check their phones 96 times a day on average.",
      [D]: `Published: 2019-07-01. Americans check their phones 96 times a day, an app study found. Source: ${C}`,
    };
    const sent = { searches: 0, extracts: 0, extractedUrls: [], pageReads: 0, prompts: 0 };
    global.fetch = async (url, options) => {
      if (options?.signal?.aborted) throw options.signal.reason;
      const endpoint = String(url);
      if (endpoint.endsWith("/search")) { sent.searches += 1; return json({ results: [], usage: { credits: 1 } }); }
      if (endpoint.endsWith("/extract")) {
        sent.extracts += 1;
        const batch = JSON.parse(options.body).urls;
        sent.extractedUrls.push(...batch);
        return json({ results: batch.filter((pageUrl) => texts[pageUrl]).map((pageUrl) => ({ url: pageUrl, raw_content: texts[pageUrl] })), usage: { credits: 1 } });
      }
      if (endpoint.endsWith("/count_tokens")) return json({ input_tokens: 100 });
      if (endpoint.endsWith("/messages")) {
        const content = JSON.parse(options.body).messages[0].content;
        const text = typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
        sent.prompts += 1;
        if (text.startsWith("Group these")) return json({ content: [{ type: "text", text: JSON.stringify({ clusters: [{ label: "96 phone checks a day", pageIds: ["page-1", "page-2", "page-3", "page-4"], matchesClaim: true }] }) }], usage: { input_tokens: 100, output_tokens: 50 } });
        if (text.startsWith("You are a cautious")) return json({ content: [{ type: "text", text: JSON.stringify({ judgements: [
          { pageId: "page-1", kind: "origin", parentId: null, confidence: 85, evidence: "Publishes its own diary survey.", hasPrimaryEvidence: true, primaryEvidenceReason: "Describes its survey and method." },
          { pageId: "page-2", kind: "derived", parentId: "page-1", confidence: 85, evidence: "Links the survey and repeats its figure.", hasPrimaryEvidence: false, primaryEvidenceReason: "Repeats the figure." },
          { pageId: "page-3", kind: "origin", parentId: null, confidence: 80, evidence: "Publishes its own app logs.", hasPrimaryEvidence: true, primaryEvidenceReason: "Describes its app data." },
          { pageId: "page-4", kind: "derived", parentId: "page-3", confidence: 85, evidence: "Links the app study and repeats it.", hasPrimaryEvidence: false, primaryEvidenceReason: "Repeats the figure." },
        ] }) }], usage: { input_tokens: 100, output_tokens: 50 } });
        if (text.startsWith("Answer the")) return json({ content: [{ type: "text", text: JSON.stringify({ claims: [{ text: "Two separate studies report about 96 checks a day", sourceNumbers: [1, 2] }] }) }], usage: { input_tokens: 100, output_tokens: 50 } });
        throw new Error(`unexpected model prompt: ${text.slice(0, 40)}`);
      }
      if (new URL(endpoint).hostname.endsWith(host)) {
        // The pages' own HTML (free direct reads): nothing extra, so the extract decides; the unreadable link is gone.
        sent.pageReads += 1;
        return endpoint === E ? new Response("gone", { status: 404, headers: { "content-type": "text/html" } }) : new Response("<html><head></head><body></body></html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`Unexpected network destination: ${endpoint}`);
    };

    // The phones claim is a demo slot's claim: a supplied-sources run of it is not that slot's (search) run.
    const claim = "Americans check their phones 96 times a day";
    // As pasted from an AI answer: tracking parameters, a #fragment, markdown, trailing punctuation, an http duplicate.
    const httpA = A.replace("https:", "http:");
    const pasted = `Sources: [1](${A}?utm_source=chatgpt.com), ${B}. See also ${C}#methods and ${D}, plus ${httpA}.`;
    const picked = urlsInText(pasted);
    assert.deepEqual(picked, [A, B, C, D], "pasted text yields each page once, canonical, in order (its http copy is the same page, so one chip)");
    assert.deepEqual(urlsInText(`${A.replace("https://", "https://www.")} ${A}`).length, 1, "a www. copy of a link is one chip too");
    // The server is the authority: sent the http copy anyway (an old client, a hand-made request), it still keeps one.
    const suppliedEvents = [];
    const result = await pipeline.analyzeClaim(claim, (event) => suppliedEvents.push(event), { urls: [...picked, httpA] });
    assert.equal(sent.searches, 0, "a supplied-sources run sends no search");
    assert.ok(suppliedEvents.length && suppliedEvents.every((event) => event.queries === undefined && event.queriesDone === undefined), "a supplied-sources run has no search plan to show");
    assert.deepEqual([...sent.extractedUrls].sort(), [A, B, C, D].sort(), "exactly the four distinct supplied links are extracted (the http copy of A is the same page)");
    assert.deepEqual(result.sourceCheck, { urls: [A, B, C, D] }, "the trace records the supplied links, in order");
    assert.equal(result.searchAudit, undefined, "a supplied-sources trace has no search audit");
    assert.equal(result.claimSlot, "live", "a demo claim checked against supplied links is not the demo slot's run");
    assert.equal(result.summary.totalPages, 4);
    assert.equal(result.summary.independentOrigins, 2, "four links where two copy the other two are 2 independent origins");
    assert.deepEqual([...result.roots].sort(), ["page-1", "page-3"]);
    assert.equal(result.pages.find((page) => page.id === "page-1").title, "Our 2019 phone survey of 2,000 adults", "a supplied link is named by its own heading");
    assert.equal(result.pages.find((page) => page.id === "page-2").title, "Phones copy", "a page without a heading is named by its address");
    assert.equal(result.answerStatus, "generated");
    const reopened = parsePortableTrace(JSON.parse(JSON.stringify(makePortableTrace(result))));
    assert.ok(reopened, "a supplied-sources trace loads again after export");
    assert.deepEqual(reopened.sourceCheck, result.sourceCheck, "its supplied links survive export and import");
    // Tampered files are refused; the same trace without sourceCheck is an ordinary trace.
    const tamper = (change) => { const file = JSON.parse(JSON.stringify(makePortableTrace(result))); change(file.analysis); return parsePortableTrace(file); };
    assert.equal(tamper((analysis) => { analysis.sourceCheck.urls = analysis.sourceCheck.urls.slice(1); }), null, "a trace page that is not among the supplied links is refused");
    assert.equal(tamper((analysis) => { analysis.searchAudit = []; }), null, "a supplied-sources trace that also claims a search is refused");
    assert.equal(tamper((analysis) => { analysis.sourceCheck.unreadUrls = ["https://elsewhere.example/x"]; }), null, "an unread link that was not supplied is refused");
    assert.equal(tamper((analysis) => { analysis.sourceCheck.unreadUrls = [A]; }), null, "a trace page listed as unread is refused");
    assert.equal(tamper((analysis) => { analysis.sourceCheck.urls = []; }), null, "an empty supplied list is refused");
    assert.equal(tamper((analysis) => { analysis.sourceCheck.urls = [...analysis.sourceCheck.urls, "javascript:alert(1)"]; }), null, "a non-web supplied link is refused");
    assert.equal(tamper((analysis) => { analysis.sourceCheck.extra = true; }), null, "an unknown sourceCheck field is refused");
    assert.ok(tamper((analysis) => { delete analysis.sourceCheck; }), "the same trace without sourceCheck is an ordinary trace");

    // Citation numbers: kept in the browser, attached to the finished trace, round-trip through trace files, and drive
    // the per-link list. Plain 1..N numbers are not stored, so every older trace stays as it was.
    const { withCitationNumbers, sourceLinkRows, sourceCheckPoint } = load(path.join(echoLib, "supplied-urls.ts"));
    assert.equal(withCitationNumbers(result, { urls: [A, B, C, D], numbers: [1, 2, 3, 4] }), result, "plain 1..N numbers are not stored");
    assert.equal(withCitationNumbers(result, { urls: [A, C, B, D], numbers: [2, 4, 5, 7] }), result, "numbers sent for links in another order are not attached");
    assert.equal(withCitationNumbers(result, null), result);
    const numbered = withCitationNumbers(result, { urls: [A, B, C, D], numbers: [2, 4, 5, 7] });
    assert.deepEqual(numbered.sourceCheck, { urls: [A, B, C, D], numbers: [2, 4, 5, 7] }, "the answer's own numbers are attached to the trace");
    assert.equal(result.sourceCheck.numbers, undefined, "attaching numbers does not change the server's result");
    const numberedAgain = parsePortableTrace(JSON.parse(JSON.stringify(makePortableTrace(numbered))));
    assert.deepEqual(numberedAgain?.sourceCheck, numbered.sourceCheck, "citation numbers survive export and import");
    const tamperNumbers = (numbers) => { const file = JSON.parse(JSON.stringify(makePortableTrace(numbered))); file.analysis.sourceCheck.numbers = numbers; return parsePortableTrace(file); };
    for (const [label, bad] of [["a repeated number", [2, 2, 5, 7]], ["too few numbers", [2, 4, 5]], ["a zero", [0, 4, 5, 7]], ["a fraction", [2.5, 4, 5, 7]], ["a year-sized number", [2019, 4, 5, 7]], ["a string", ["2", 4, 5, 7]], ["not a list", 2]]) assert.equal(tamperNumbers(bad), null, `citation numbers with ${label} are refused`);
    const hostA = new URL(A).hostname;
    const hostC = new URL(C).hostname;
    assert.deepEqual(sourceLinkRows(numbered).map((row) => `[${row.number}] ${row.host} — ${row.verdict}`), [
      `[2] ${hostA} — independent origin, with its own evidence`,
      `[4] ${new URL(B).hostname} — copy of [2]`,
      `[5] ${hostC} — independent origin, with its own evidence`,
      `[7] ${new URL(D).hostname} — copy of [5]`,
    ], "each supplied link gets its number and what the trace found, in pasted order");
    assert.deepEqual(sourceLinkRows(result).map((row) => row.number), [1, 2, 3, 4], "a trace without numbers shows 1..N");
    assert.equal(sourceCheckPoint(result), "Your answer's 4 citations trace back to 2 independent origins, all with their own evidence.");
    // Unclear and dashed links, an unread link and one set aside as off the claim, from the same trace's fields.
    const varied = structuredClone(numbered);
    const byId = (id) => varied.pages.find((page) => page.id === id);
    byId("page-2").judgment = { kind: "unclear", parentId: null, confidence: 0, evidence: "The proposed parent is not dated earlier than this page, so Echo removed the directional link." };
    byId("page-2").text = byId("page-1").text;
    byId("page-4").judgment = { kind: "unclear", parentId: "page-3", confidence: 55, evidence: "Repeats the app study's figure and names it without a link." };
    varied.sourceCheck = { urls: [A, B, C, D, E, `https://f${host}/coffee`], numbers: [2, 4, 5, 7, 8, 9], unreadUrls: [E] };
    assert.deepEqual(sourceLinkRows(varied).map((row) => `[${row.number}] ${row.verdict}`), [
      "[2] independent origin, with its own evidence",
      "[4] unclear (same text, no earlier date)",
      "[5] independent origin, with its own evidence",
      "[7] possible copy of [5], link not confirmed",
      "[8] could not be read",
      "[9] not about this claim",
    ], "unclear, possible-copy, unread and off-claim links each say so");
    assert.equal(sourceCheckPoint({ ...varied, summary: { ...varied.summary, independentOrigins: 1, verifiableOrigins: 0 } }), "Of your answer's 6 citations, 4 address this claim, and they trace back to 1 independent origin, without its own evidence.");
    const together = structuredClone(numbered);
    together.coPublishedRootGroups = [["page-3", "page-1"]];
    // The lead of roots published together (coPublishedLeadOrder, QA round 5 S2-1): own evidence, then cited by the
    // answer, then the earliest reliable date, then pasting order. Both have their own evidence and the same date here.
    for (const id of ["page-1", "page-3"]) Object.assign(together.pages.find((page) => page.id === id), { publishedDate: "2019-11-21", publishedDateSource: "page metadata" });
    together.answerSourceIds = ["page-1", "page-3"];
    assert.deepEqual(sourceLinkRows(together).map((row) => row.verdict).slice(0, 3), ["independent origin, with its own evidence", "copy of [2]", "published together with [2], one origin"], "all else equal, a root published together with an earlier-pasted one names it");
    together.answerSourceIds = ["page-3"];
    assert.deepEqual(sourceLinkRows(together).map((row) => row.verdict).slice(0, 3), ["published together with [5], one origin", "copy of [2]", "independent origin, with its own evidence"], "the one the answer cites leads, whatever the pasting order");

    // The server cache: the same claim and links (in another order) reopen the run; a search run of the claim does not.
    const extractsBefore = sent.extracts;
    const again = await pipeline.analyzeClaim(claim, () => {}, { urls: [D, C, B, A] });
    assert.equal(again.cacheHit, true, "the same claim and links reopen the cached run");
    assert.equal(sent.extracts, extractsBefore, "a cache hit extracts nothing");
    const searchAnswer = await pipeline.analyzeClaim(claim, () => {}, {}).then(() => "completed", (error) => error.code ?? error.message);
    assert.equal(searchAnswer, "NO_RESULTS", "a search run of the same claim searches (the mock finds nothing) instead of reopening the supplied-sources run");
    assert.ok(sent.searches > 0, "the search run did search");

    // An unreadable fifth link is listed as unread and judged nowhere.
    sent.searches = 0;
    const withUnread = await pipeline.analyzeClaim(claim, () => {}, { urls: [A, B, C, D, E] });
    assert.equal(sent.searches, 0);
    assert.deepEqual(withUnread.sourceCheck, { urls: [A, B, C, D, E], unreadUrls: [E] }, "a link with no readable text is listed as unread");
    assert.equal(withUnread.summary.totalPages, 4, "the unread link is not a trace page");
    assert.ok(!withUnread.pages.some((page) => page.url === E));
    assert.ok(parsePortableTrace(JSON.parse(JSON.stringify(makePortableTrace(withUnread)))), "a trace with an unread link loads again");

    // Bad lists: refused whole before anything is sent.
    const before = { extracts: sent.extracts, prompts: sent.prompts, reads: sent.pageReads };
    const twentyOne = Array.from({ length: 21 }, (_, index) => `https://n${index}${host}/x`);
    const badLists = [
      ["an empty list", []],
      ["a list that is not an array", A],
      ["a number", [5]],
      ["a blank entry", [" "]],
      ["an ftp link", ["ftp://files.example/x"]],
      ["a javascript link", ["javascript:alert(1)"]],
      ["localhost", ["http://localhost:3000/api/analyze"]],
      ["a private address", [A, "http://192.168.1.1/admin"]],
      ["the cloud metadata address", ["http://169.254.169.254/latest/meta-data/"]],
      ["a link with credentials", ["https://user:pw@news.example/a"]],
      ["21 different links", twentyOne],
      ["an over-long link", [`https://long${host}/${"x".repeat(2_100)}`]],
    ];
    for (const [label, urls] of badLists) {
      await assert.rejects(() => pipeline.analyzeClaim(claim, () => {}, { urls }), (error) => error.code === "SOURCES_INVALID", `${label} is refused`);
    }
    assert.deepEqual(pipeline.suppliedSourceUrls([...twentyOne.slice(0, 20), twentyOne[0], `${twentyOne[1]}?utm_source=x`]), twentyOne.slice(0, 20), "20 different links pass; repeats of them (even with tracking) do not count again");
    // S3-4: the refusal says why. A link with a username or password is refused for that (it once read "example.com is
    // not a public web address"), without repeating the credentials; a private host is named.
    const refusal = (urls) => { try { pipeline.suppliedSourceUrls(urls); return null; } catch (error) { return error.message; } };
    assert.equal(refusal(["http://user:pw@example.com/x"]), "One link includes a username or password, and Echo does not read links with a username or password. Paste the page's address without them.");
    assert.doesNotMatch(refusal(["https://alice:s3cret@news.example/a"]), /alice|s3cret|news\.example is not a public/, "the credentials are not repeated, and the host is not called private");
    assert.equal(refusal(["http://192.168.1.1/admin"]), "192.168.1.1 is not a public web address, so Echo will not read it.");
    // QA round 4 D3: a public IPv6 link is refused for being an IPv6 address (as its chip says), not as a private one.
    assert.equal(refusal(["https://[2606:4700::1111]:8443/x"]), "Echo does not read links to an IPv6 address ([2606:4700::1111]:8443). Paste the page's address with its site name instead.");
    assert.equal(refusal(["http://[::1]/q"]), "[::1] is not a public web address, so Echo will not read it.", "a private IPv6 address is still not public");
    // The panel warns from the same rules, judged on the link's text alone (the server stays the authority).
    const { unreadableAddressReason } = load(path.join(projectRoot, "src", "lib", "echo", "public-address.ts"));
    for (const [url, reason] of [["http://user:pw@example.com/x", "credentials"], ["https://user@example.com/x", "credentials"], ["http://localhost:3000/x", "not public"], ["http://10.0.0.5/x", "not public"], ["http://192.168.1.1/", "not public"], ["http://169.254.169.254/latest", "not public"], ["http://[::1]/", "not public"], ["https://[2606:4700::1111]/x", "ipv6"], ["http://[fd00::1]/x", "not public"], ["http://intranet/", "not public"], ["http://printer.local/", "not public"], ["https://news.example/a", null], ["https://93.184.216.34/page", null]]) {
      assert.equal(unreadableAddressReason(url), reason, `${url}: ${reason ?? "readable"}`);
      assert.equal(reason === null, refusal([url]) === null, `${url}: the panel and the server agree`);
    }
    await assert.rejects(() => pipeline.analyzeClaim("??", () => {}, { urls: [A] }), (error) => error.code === "CLAIM_TOO_SHORT", "the claim rules still apply first");
    await assert.rejects(() => pipeline.analyzeClaim("........ 96", () => {}, { urls: [A] }), (error) => error.code === "CLAIM_NO_WORDS", "the no-word-claim guard still applies");
    assert.equal(sent.extracts, before.extracts, "no refused list sent an extract");
    assert.equal(sent.prompts, before.prompts, "no refused list sent a model request");
    assert.equal(sent.pageReads, before.reads, "no refused list read a page");
    // Anthropic's own account spend limit answers 400 to every call: its own message, no "try again", nothing spent.
    const mockedFetch = global.fetch;
    global.fetch = async (url, options) => String(url).endsWith("/count_tokens")
      ? new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC." } }), { status: 400, headers: { "content-type": "application/json" } })
      : mockedFetch(url, options);
    try {
      await assert.rejects(() => pipeline.analyzeClaim(`${claim} (account limit)`, () => {}, { urls: [A, B] }), (error) => error.code === "CLAUDE_ACCOUNT_LIMIT" && /Anthropic Console/.test(error.message), "an account usage limit is named as such");
    } finally {
      global.fetch = mockedFetch;
    }
    assert.equal(pipeline.isClaudeAccountLimit("Your credit balance is too low to access the Anthropic API."), true);
    assert.equal(pipeline.isClaudeAccountLimit("messages: text content blocks must be non-empty"), false, "an ordinary bad request is not an account limit");

    // The live 11/13 sources run on the phones links: a company newsroom and its wire copy, the same day, the same
    // text, and a later news story citing the wire. The judge called the wire copy "unclear" with the newsroom as a
    // dashed parent (neither is strictly earlier). It ends as a co-published origin counted once with the newsroom,
    // as search runs count the pair, not as an unresolved page.
    const releaseBody = "Americans now check their phones 96 times a day, once every 10 minutes, according to new research by global tech care company Asurion. That is a 20 percent daily increase from a similar survey conducted by Asurion two years ago. Eighteen to 24 year olds check their phones twice as much as the national average, and Baby Boomers are seven times more likely to text than to talk in person.";
    const N = `https://newsroom${host}/press-releases/phones-96`;
    const W = `https://wire${host}/news-releases/phones-96`;
    const F = `https://tv${host}/news/phones-96`;
    const wireTexts = {
      [N]: `# Americans Check Their Phones 96 Times a Day\nPublished: 2019-11-21. ${releaseBody}`,
      [W]: `# Americans Check Their Phones 96 Times a Day\nPublished: 2019-11-21. NASHVILLE, Tenn. /Wire/ -- ${releaseBody}`,
      [F]: `# Americans check their smartphones 96 times a day, survey says\nPublished: 2021-09-28. New research shows Americans check their phones 96 times a day, according to global tech care company Asurion. Source: ${W}`,
    };
    const wireMock = global.fetch;
    global.fetch = async (url, options) => {
      const endpoint = String(url);
      if (endpoint.endsWith("/extract")) {
        const batch = JSON.parse(options.body).urls;
        return json({ results: batch.filter((pageUrl) => wireTexts[pageUrl]).map((pageUrl) => ({ url: pageUrl, raw_content: wireTexts[pageUrl] })), usage: { credits: 1 } });
      }
      if (endpoint.endsWith("/messages")) {
        const content = JSON.parse(options.body).messages[0].content;
        const text = typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
        if (text.startsWith("Group these")) return json({ content: [{ type: "text", text: JSON.stringify({ clusters: [{ label: "96 phone checks a day", pageIds: ["page-1", "page-2", "page-3"], matchesClaim: true }] }) }], usage: { input_tokens: 100, output_tokens: 50 } });
        if (text.startsWith("You are a cautious")) return json({ content: [{ type: "text", text: JSON.stringify({ judgements: [
          { pageId: "page-1", kind: "origin", parentId: null, confidence: 85, evidence: "The company's own page announcing its survey.", hasPrimaryEvidence: false, primaryEvidenceReason: "States the survey's findings." },
          { pageId: "page-2", kind: "unclear", parentId: "page-1", confidence: 55, evidence: "Same-day wire copy of the release; neither page is clearly earlier.", hasPrimaryEvidence: false, primaryEvidenceReason: "Reproduces the release." },
          { pageId: "page-3", kind: "derived", parentId: "page-2", confidence: 80, evidence: "Links the wire release and repeats its figures.", hasPrimaryEvidence: false, primaryEvidenceReason: "Repeats the figure." },
        ] }) }], usage: { input_tokens: 100, output_tokens: 50 } });
        if (text.startsWith("Answer the")) return json({ content: [{ type: "text", text: JSON.stringify({ claims: [{ text: "Asurion's 2019 survey reports 96 checks a day", sourceNumbers: [1] }] }) }], usage: { input_tokens: 100, output_tokens: 50 } });
      }
      return wireMock(url, options);
    };
    let wireRun;
    try {
      wireRun = await pipeline.analyzeClaim(claim, () => {}, { urls: [N, W, F], forceFresh: true });
    } finally {
      global.fetch = wireMock;
    }
    const wirePage = (id) => wireRun.pages.find((entry) => entry.id === id);
    assert.deepEqual([wirePage("page-1").publishedDate, wirePage("page-2").publishedDate], ["2019-11-21", "2019-11-21"], "both postings carry the page's own date");
    assert.deepEqual([wirePage("page-2").judgment.kind, wirePage("page-2").judgment.parentId], ["origin", null], "the same-day wire copy is a co-published origin, not unclear");
    assert.match(wirePage("page-2").judgment.evidence, /co-published origin/);
    // QA #3: the newsroom's own evidence agrees with the pair (Echo's note first, the judge's words after, labeled).
    assert.equal(wirePage("page-1").judgment.evidence, `Published the same day as ${wirePage("page-2").domain} with largely identical text; Echo counts them as one origin. Claude's note: The company's own page announcing its survey.`, "the newsroom page's evidence names its wire partner first");
    assert.deepEqual([wirePage("page-3").judgment.kind, wirePage("page-3").judgment.parentId], ["derived", "page-2"], "the later story stays derived from the wire copy it links");
    assert.deepEqual([...wireRun.roots].sort(), ["page-1", "page-2"]);
    assert.deepEqual(wireRun.coPublishedRootGroups, [["page-1", "page-2"]], "the newsroom page and its wire copy are one release");
    assert.equal(wireRun.summary.independentOrigins, 1, "counted once: 1 independent origin, as before");
    assert.ok(parsePortableTrace(JSON.parse(JSON.stringify(makePortableTrace(wireRun)))), "the sources trace with a co-published pair loads again");
    process.stdout.write(`  ok  supplied sources: 4 links (2 copying the other 2) → 2 independent origins with no search sent; the links round-trip through export; the same links reopen the cache, a search run does not; an unreadable link is listed as unread; ${badLists.length} bad lists refused before any request; a same-day wire copy the judge called unclear is one co-published origin with its newsroom page\n`);
  } finally {
    clearInterval(keepAlive);
    dnsPromises.lookup = originalLookup;
    global.fetch = baseFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    process.chdir(fs.existsSync(savedCwd) ? savedCwd : os.tmpdir());
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// "Check these sources": citation numbers read from every shape an AI answer pastes its links in. Pure text, no network.
{
  const { citedUrlsInText, urlsInText } = load(path.join(projectRoot, "src", "lib", "echo", "supplied-urls.ts"));
  const [a, b, c, d] = ["https://a.example/one", "https://b.example/two", "https://c.example/three", "https://d.example/four"];
  const numbersOf = (text) => citedUrlsInText(text).map(({ url, number }) => `${number} ${url}`);
  const pageKeyOf = (url) => load(path.join(projectRoot, "src", "lib", "echo", "supplied-urls.ts")).pageKey(url);
  const shapes = [
    ["bracketed numbers before each link", `Sources:\n[1] ${a}\n[2] ${b}\n[3] ${c}`, [`1 ${a}`, `2 ${b}`, `3 ${c}`]],
    ["bracketed numbers on one line", `Sources: [1] ${a} [2] ${b}, [3] ${c}.`, [`1 ${a}`, `2 ${b}`, `3 ${c}`]],
    ["a numbered list", `1. ${a}\n2. ${b}\n3) ${c}`, [`1 ${a}`, `2 ${b}`, `3 ${c}`]],
    ["a numbered list with titles first", `1. Asurion: Americans check their phones 96 times a day — ${a}\n2. Fox 13 (${b})`, [`1 ${a}`, `2 ${b}`]],
    ["bulleted bracket numbers with titles", `- [1] Asurion press release ${a}\n* [2] Wire copy, ${b}`, [`1 ${a}`, `2 ${b}`]],
    ["markdown footnotes", `Phones get checked 96 times a day.[^1] Often.[^2]\n\n[^1]: ${a}\n[^2]: ${b}`, [`1 ${a}`, `2 ${b}`]],
    ["markdown reference definitions", `[1]: ${a}\n[2]: ${b} "Title"`, [`1 ${a}`, `2 ${b}`]],
    ["numbered markdown links", `It is 96 times a day [1](${a}) and rising [2](${b}?utm_source=chatgpt.com), says [[3]](${c}).`, [`1 ${a}`, `2 ${b}`, `3 ${c}`]],
    ["parenthesised numbers", `(1) ${a}\n(2) ${b}`, [`1 ${a}`, `2 ${b}`]],
    ["numbers out of order, kept in pasted order", `[3] ${c}\n[1] ${a}\n[2] ${b}`, [`3 ${c}`, `1 ${a}`, `2 ${b}`]],
    ["an unnumbered paste", `${a}\n${b} and ${c}`, [`1 ${a}`, `2 ${b}`, `3 ${c}`]],
    ["markdown links with words, numbered 1..N", `[Asurion](${a}) and [Fox 13](${b})`, [`1 ${a}`, `2 ${b}`]],
    ["an http/https/www copy, keeping the first number", `[1] ${a}\n[2] ${a.replace("https://", "http://www.")}\n[3] ${b}`, [`1 ${a}`, `3 ${b}`]],
    ["a link first unnumbered, numbered later in the list", `As ${a} says.\n\n[4] ${a}\n[5] ${b}`, [`4 ${a}`, `5 ${b}`]],
    ["some links numbered, the rest after the highest", `[2] ${a} and also ${b}, ${c}`, [`2 ${a}`, `3 ${b}`, `4 ${c}`]],
    ["one number used twice", `[1] ${a}\n[1] ${b}\n[2] ${c}`, [`1 ${a}`, `3 ${b}`, `2 ${c}`]],
    ["a second link on a numbered line", `1. ${a} ${b}\n2. ${c}`, [`1 ${a}`, `3 ${b}`, `2 ${c}`]],
    ["a year at line start is not a number", `2019. ${a}\n${b}`, [`1 ${a}`, `2 ${b}`]],
    ["a number inside prose is not a citation", `Version 2 of ${a} and 5 reasons ${b}`, [`1 ${a}`, `2 ${b}`]],
    ["a zero is not a citation number", `[0] ${a}\n[1] ${b}`, [`2 ${a}`, `1 ${b}`]],
    ["a comma-joined list", `${a},${b},${c}`, [`1 ${a}`, `2 ${b}`, `3 ${c}`]],
    ["a numbered link with a fragment and trailing punctuation", `[7] ${d}#methods.`, [`7 ${d}`]],
    // QA round 3 #11: an unnumbered markdown link before a numbered one takes the lowest free number, in order.
    ["a site-named markdown link before a numbered one", "([asurion.com](https://www.asurion.com/a)) and ([2](https://www.prnewswire.com/b))", ["1 https://www.asurion.com/a", "2 https://www.prnewswire.com/b"]],
    ["unnumbered links before and after numbered ones", `${a} then [1] ${b}, ${c} and [3] ${d}`, [`2 ${a}`, `1 ${b}`, `4 ${c}`, `3 ${d}`]],
    // QA round 3 #12: an IPv6 host in brackets is an address (the panel warns; the server refuses it), not two broken ones.
    ["IPv6 address links", "See http://[::1]/q and https://[2606:4700::1111]/x, then http://[::1].", ["1 http://[::1]/q", "2 https://[2606:4700::1111]/x", "3 http://[::1]/"]],
  ];
  for (const [label, text, expected] of shapes) assert.deepEqual(numbersOf(text), expected, `citation numbers: ${label}`);
  for (const [, text] of shapes) {
    const numbers = citedUrlsInText(text).map((cited) => cited.number);
    assert.equal(new Set(numbers).size, numbers.length, "no two links share a number");
    assert.deepEqual(citedUrlsInText(text).map((cited) => cited.url), urlsInText(text), "the numbered list is the same links, in the same order, as urlsInText");
  }
  assert.deepEqual(citedUrlsInText(""), []);
  // The live trace of the five phones links (2026-11-13, the demo's example), read back into its per-link list.
  const { sourceLinkRows, sourceCheckPoint } = load(path.join(projectRoot, "src", "lib", "echo", "supplied-urls.ts"));
  const { parsePortableTrace } = load(path.join(projectRoot, "src", "lib", "echo", "portable.ts"));
  const phones = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(projectRoot, "scripts", "fixtures", "sources-phones-live-2026-11-13.echo.json"), "utf8")));
  assert.ok(phones, "the saved phones sources trace loads (no citation numbers: an older trace stays valid)");
  assert.deepEqual(sourceLinkRows(phones).map((row) => `[${row.number}] ${row.host} — ${row.verdict}`), [
    "[1] asurion.com — independent origin, with its own evidence",
    "[2] prnewswire.com — unclear (same text, no earlier date)",
    "[3] fox13seattle.com — copy of [2]",
    "[4] kabc.com — possible copy of [1], link not confirmed",
    "[5] churchandculture.org — copy of [3]",
  ], "the saved live phones trace reads as the demo's per-link list");
  assert.equal(sourceCheckPoint(phones), "Your answer's 5 citations trace back to 1 independent origin, with its own evidence.");

  // "Cite once": which supplied links to keep, read from the per-link rows alone, and the same result as data.
  {
    const { sourceCiteOnce, sourceCiteOnceData } = load(path.join(projectRoot, "src", "lib", "echo", "supplied-urls.ts"));
    const v2 = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(projectRoot, "scripts", "fixtures", "sources-phones-live-2026-11-13-v2.echo.json"), "utf8")));
    assert.ok(v2, "the newer phones sources trace (v2: PR Newswire published together with Asurion) loads");
    assert.deepEqual(sourceLinkRows(v2).map((row) => `[${row.number}] ${row.host} — ${row.verdict}`), [
      "[1] asurion.com — independent origin, with its own evidence",
      "[2] prnewswire.com — published together with [1], one origin",
      "[3] fox13seattle.com — copy of [2]",
      "[4] kabc.com — possible copy of [1], link not confirmed",
      "[5] churchandculture.org — copy of [3]",
    ]);
    assert.equal(sourceCiteOnce(v2).line, "Cite once: [1] asurion.com (also published as [2]). Repeats it: [3], [5]. Unclear: [4].", "v2: one origin, its co-published copy, the copies that lead back to it, the possible copy as unclear");
    assert.equal(sourceCiteOnce(phones).line, "Cite once: [1] asurion.com. Unclear: [2], [4]. Repeats [2]: [3], [5].", "v1: copies of an unclear link are named with that link, not with the origin");
    const data = JSON.parse(sourceCiteOnceData(v2));
    assert.deepEqual(data, {
      claim: "Americans check their phones 96 times a day",
      checked: "supplied links only, no web search",
      citeOnce: "Cite once: [1] asurion.com (also published as [2]). Repeats it: [3], [5]. Unclear: [4].",
      origins: [{ cite: 1, url: v2.sourceCheck.urls[0], publishedTogether: [2], repeatedBy: [3, 5], ownEvidence: "found" }],
      citations: [
        { n: 1, url: v2.sourceCheck.urls[0], status: "origin", of: null, origin: 1 },
        { n: 2, url: v2.sourceCheck.urls[1], status: "same origin", of: 1, origin: 1 },
        { n: 3, url: v2.sourceCheck.urls[2], status: "copy", of: 2, origin: 1 },
        { n: 4, url: v2.sourceCheck.urls[3], status: "possible copy", of: 1, origin: null },
        { n: 5, url: v2.sourceCheck.urls[4], status: "copy", of: 3, origin: 1 },
      ],
      note: "A citation identifies a supplied source, not proof of the claim. Origins are counted among these links only.",
    }, "the data view is valid JSON with every citation and its origin group");
    assert.ok(sourceCiteOnceData(v2).split("\n").length <= 16, "the data view stays compact: one origin or citation per line");
    // Two origins, one without its own evidence: each is named, and each origin's repeats are listed under its number.
    const two = structuredClone(v2);
    two.pages = two.pages.map((page) => (page.id === "page-4" ? { ...page, primaryEvidenceStatus: "not found", judgment: { ...page.judgment, kind: "origin", parentId: null } } : page));
    two.roots = [...two.roots, "page-4"];
    two.summary = { ...two.summary, independentOrigins: 2 };
    assert.equal(sourceCiteOnce(two).line, "Cite once each: [1] asurion.com (also published as [2]); [4] kabc.com (no own evidence identified). Repeats [1]: [3], [5].");
    // No confirmed origin: nothing to cite once; unclear links, then the copies that lead to one of them.
    const zero = structuredClone(v2);
    zero.pages = zero.pages.map((page) => (page.id === "page-1" || page.id === "page-2" ? { ...page, judgment: { ...page.judgment, kind: "unclear", parentId: null } } : page));
    Object.assign(zero, { roots: [], verifiableRoots: [], coPublishedRootGroups: [], summary: { ...zero.summary, independentOrigins: 0, verifiableOrigins: 0 } });
    assert.equal(sourceCiteOnce(zero).line, "No supplied link is a confirmed independent origin, so there is none to cite once. Unclear: [1], [2], [4]. Repeats [2]: [3], [5].");
    // Unread and off-claim links, the answer's own citation numbers, and a loop of copies that ends nowhere.
    const more = structuredClone(v2);
    more.sourceCheck = { urls: [...v2.sourceCheck.urls, "https://gone.example/x", "https://off.example/y"], unreadUrls: ["https://gone.example/x"], numbers: [2, 3, 4, 5, 6, 7, 9] };
    more.pages = more.pages.map((page) => (page.id === "page-3" ? { ...page, judgment: { ...page.judgment, parentId: "page-5" } } : page));
    assert.equal(sourceCiteOnce(more).line, "Cite once: [2] asurion.com (also published as [3]). Unclear: [5]. Repeats another supplied link: [4], [6]. Could not be read: [7]. Not about this claim: [9].");
    assert.equal(sourceCiteOnce({ ...v2, sourceCheck: undefined }), null, "a search trace has no cite-once line");
    assert.equal(sourceCiteOnceData({ ...v2, sourceCheck: undefined }), null);

    // QA round 3 #9: Copy link keeps the answer's numbers (?nums=) so [2]–[6] reopen as [2]–[6]; plain 1..N adds nothing.
    const { sourceShareParams, numbersFromParam, sharedSourceText, urlsFromParam: fromParam } = load(path.join(projectRoot, "src", "lib", "echo", "supplied-urls.ts"));
    const numbered = { urls: v2.sourceCheck.urls, numbers: [2, 3, 4, 5, 6] };
    const shareParams = sourceShareParams(v2.claim, numbered);
    assert.deepEqual(shareParams, { claim: v2.claim, urls: v2.sourceCheck.urls.join(" "), nums: "2,3,4,5,6" });
    assert.deepEqual(sourceShareParams(v2.claim, v2.sourceCheck), { claim: v2.claim, urls: v2.sourceCheck.urls.join(" ") }, "1..N: no nums");
    const reopened = sharedSourceText(fromParam(shareParams.urls), numbersFromParam(shareParams.nums, 5));
    assert.deepEqual(citedUrlsInText(reopened).map((cited) => cited.number), [2, 3, 4, 5, 6], "the link's panel shows the answer's own numbers");
    for (const bad of ["2,3", "2,3,4,5,x", "2,2,3,4,5", "0,1,2,3,4", "1,2,3,4,1000", ""]) assert.equal(numbersFromParam(bad, 5), null, `a bad ?nums= (${JSON.stringify(bad)}) falls back to 1..N`);
    assert.equal(sharedSourceText(["https://a.example/x", "https://b.example/y"], null), "https://a.example/x\nhttps://b.example/y");
  }

  // QA round 2. An http and an https copy of one page keep the https address (either order) and the first number.
  assert.deepEqual(numbersOf(`[1] ${a.replace("https:", "http:")}\n[2] ${a}`), [`1 ${a}`], "http first: the https address is kept, with the first number");
  assert.deepEqual(numbersOf(`[1] ${a}\n[2] ${a.replace("https:", "http:")}`), [`1 ${a}`], "https first: still the https address");
  assert.deepEqual(numbersOf(`${a.replace("https:", "http:")} then [3] ${a}`), [`3 ${a}`], "the first number found, on the https copy");
  // A link over 2,000 characters is counted, so the panel can say it was left out; ?urls= arrives whole (the panel caps it at 20 and says so).
  const { overlongUrlCount, urlsFromParam, pastedLinks, removalsStillPasted, sourceCheckHeadline, sourceCheckReadLine, sourceCheckReportLines, sourceCheckNoSearchLine } = load(path.join(projectRoot, "src", "lib", "echo", "supplied-urls.ts"));
  const longLink = `https://long.example/${"x".repeat(2_100)}`;
  assert.equal(overlongUrlCount(`${a} ${longLink}`), 1, "an over-long link is counted");
  assert.deepEqual(pastedLinks(`${a} ${longLink}`, []), { urls: [a], numbers: [1], leftOut: 0, removedHere: 0, overlong: 1 }, "it is left out of the links and reported");
  const twentyFive = Array.from({ length: 25 }, (_, index) => `https://n${index}.example/x`);
  assert.equal(urlsFromParam(twentyFive.join(" ")).length, 25, "a ?urls= link arrives whole");
  assert.deepEqual(pastedLinks(twentyFive.join("\n"), []).leftOut, 5, "the panel sends 20 and says 5 were left out");
  // Removal is by page and for the current paste only: an http/www copy stays removed; a page no longer pasted is forgotten.
  const removed = [pageKeyOf(b)];
  assert.deepEqual(pastedLinks(`${a}\n${b}`, removed), { urls: [a], numbers: [1], leftOut: 0, removedHere: 1, overlong: 0 }, "a removed link keeps its number out and is counted as removed");
  assert.equal(pastedLinks(`${a}\n${b.replace("https://", "http://www.")}`, removed).removedHere, 1, "its http/www copy is the same removed page");
  assert.deepEqual(removalsStillPasted(`${a}\n${b}`, removed), removed, "still pasted: still removed");
  assert.deepEqual(removalsStillPasted("", removed), [], "the box cleared: the removal is forgotten");
  assert.deepEqual(pastedLinks(b, removalsStillPasted(b, removalsStillPasted("", removed))).urls, [b], "so pasting the removed link again brings its chip back");
  // The headline and read line, for every count: no "1 of 1", no zero clauses, zero origins is unresolved, not dependent.
  assert.deepEqual(sourceCheckHeadline(phones), { text: "5 supplied links → 1 independent origin", evidence: null });
  assert.equal(sourceCheckReadLine(phones), "Echo read all 5 supplied links and ran no web search. Of the 5 pages about this claim: 1 root page (1 independent origin), 2 confirmed copies of another supplied page, 2 unclear.");
  const one = structuredClone(phones);
  one.pages = one.pages.slice(0, 1); one.sourceCheck = { urls: one.sourceCheck.urls.slice(0, 1) };
  assert.equal(sourceCheckReadLine(one), "Echo read the supplied link and ran no web search.", "one link: no “1 of 1”, no page breakdown");
  assert.equal(sourceCheckHeadline(one).text, "1 supplied link → 1 independent origin");
  const noCopies = structuredClone(phones);
  noCopies.pages = noCopies.pages.map((page) => ({ ...page, judgment: { ...page.judgment, kind: page.id === "page-1" ? "origin" : "unclear", parentId: null } }));
  assert.equal(sourceCheckReadLine(noCopies), "Echo read all 5 supplied links and ran no web search. Of the 5 pages about this claim: 1 root page (1 independent origin), 4 unclear.", "a zero count is left out");
  // QA round 4 D4: every page is accounted for, root pages too. Published together (v2): "2 root pages published
  // together (1 independent origin)"; two origins, one of them co-published, say how pages published together count.
  const phonesV2 = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(projectRoot, "scripts", "fixtures", "sources-phones-live-2026-11-13-v2.echo.json"), "utf8")));
  assert.equal(sourceCheckReadLine(phonesV2), "Echo read all 5 supplied links and ran no web search. Of the 5 pages about this claim: 2 root pages published together (1 independent origin), 2 confirmed copies of another supplied page, 1 unclear.");
  const mixedRoots = { ...structuredClone(phonesV2), roots: ["page-1", "page-2", "page-4"], summary: { ...phonesV2.summary, independentOrigins: 2 } };
  mixedRoots.pages = mixedRoots.pages.map((page) => (page.id === "page-4" ? { ...page, judgment: { ...page.judgment, kind: "origin", parentId: null } } : page));
  assert.equal(sourceCheckReadLine(mixedRoots), "Echo read all 5 supplied links and ran no web search. Of the 5 pages about this claim: 3 root pages (2 independent origins; pages published together count once), 2 confirmed copies of another supplied page.");
  const twoOrigins = { ...structuredClone(mixedRoots), coPublishedRootGroups: [], roots: ["page-1", "page-4"] };
  twoOrigins.pages = twoOrigins.pages.map((page) => (page.id === "page-2" ? { ...page, judgment: { ...page.judgment, kind: "unclear" } } : page));
  assert.equal(sourceCheckReadLine(twoOrigins), "Echo read all 5 supplied links and ran no web search. Of the 5 pages about this claim: 2 root pages (2 independent origins), 2 confirmed copies of another supplied page, 1 unclear.");
  const unresolved = { ...structuredClone(noCopies), roots: [], verifiableRoots: [], summary: { ...phones.summary, independentOrigins: 0, verifiableOrigins: 0 } };
  unresolved.pages = unresolved.pages.map((page) => ({ ...page, judgment: { ...page.judgment, kind: "unclear" } }));
  assert.deepEqual(sourceCheckHeadline(unresolved), { text: "5 supplied links → no confirmed independent origin", evidence: null }, "zero origins reads as unresolved");
  assert.equal(sourceCheckPoint(unresolved), "Your answer's 5 citations trace back to no confirmed independent origin among these links.");
  const partlyRead = { ...structuredClone(phones), sourceCheck: { urls: [...phones.sourceCheck.urls, "https://gone.example/x"], unreadUrls: ["https://gone.example/x"] } };
  assert.equal(sourceCheckReadLine(partlyRead).split(". ").slice(0, 2).join(". "), "Echo read 5 of the 6 supplied links and ran no web search. 1 link could not be read (gone.example)");
  // Present slide 1 lists every link beside the line, so there the unread sites are not named twice.
  assert.equal(sourceCheckReadLine(partlyRead, { listUnread: false }).split(". ").slice(0, 2).join(". "), "Echo read 5 of the 6 supplied links and ran no web search. 1 link could not be read");
  // The text report's section: the headline, what was read, each link with its number, verdict and address, the plain
  // line; and, where a search trace has its query audit, a line that no search ran. A search trace gets neither.
  assert.deepEqual(sourceCheckReportLines(phones), [
    "Checked supplied links (no web search):",
    "5 supplied links → 1 independent origin",
    "Echo read all 5 supplied links and ran no web search. Of the 5 pages about this claim: 1 root page (1 independent origin), 2 confirmed copies of another supplied page, 2 unclear.",
    `[1] asurion.com — independent origin, with its own evidence\n   ${phones.sourceCheck.urls[0]}`,
    `[2] prnewswire.com — unclear (same text, no earlier date)\n   ${phones.sourceCheck.urls[1]}`,
    `[3] fox13seattle.com — copy of [2]\n   ${phones.sourceCheck.urls[2]}`,
    `[4] kabc.com — possible copy of [1], link not confirmed\n   ${phones.sourceCheck.urls[3]}`,
    `[5] churchandculture.org — copy of [3]\n   ${phones.sourceCheck.urls[4]}`,
    "Your answer's 5 citations trace back to 1 independent origin, with its own evidence.",
    "Cite once: [1] asurion.com. Unclear: [2], [4]. Repeats [2]: [3], [5].",
  ]);
  assert.equal(sourceCheckNoSearchLine(phones), "Web search: none ran. Echo read only the 5 supplied links, so there is no search query audit.");
  assert.equal(sourceCheckNoSearchLine(one), "Web search: none ran. Echo read only the supplied link, so there is no search query audit.");
  assert.deepEqual(sourceCheckReportLines({ ...phones, sourceCheck: undefined }), [], "a search trace has no supplied-links section");
  const none = { ...structuredClone(phones), pages: [], roots: [], verifiableRoots: [], summary: { ...phones.summary, totalPages: 0, independentOrigins: 0, verifiableOrigins: 0 } };
  assert.equal(sourceCheckHeadline({ ...none, sourceCheck: { urls: phones.sourceCheck.urls, unreadUrls: phones.sourceCheck.urls } }).text, "None of the 5 supplied links could be read");
  assert.equal(sourceCheckHeadline({ ...none, sourceCheck: { urls: phones.sourceCheck.urls } }).text, "None of the 5 supplied links is about this claim");
  assert.equal(sourceCheckHeadline({ ...none, sourceCheck: { urls: phones.sourceCheck.urls.slice(0, 1), unreadUrls: phones.sourceCheck.urls.slice(0, 1) } }).text, "The supplied link could not be read");
  // QA round 3 #14: with no page to trace, the plain line says what happened to the links, not "0 address this claim".
  assert.equal(sourceCheckPoint({ ...none, sourceCheck: { urls: phones.sourceCheck.urls, unreadUrls: phones.sourceCheck.urls } }), "None of your answer's 5 citations could be read, so Echo has no origin to show.");
  assert.equal(sourceCheckPoint({ ...none, sourceCheck: { urls: phones.sourceCheck.urls } }), "None of your answer's 5 citations is about this claim, so Echo has no origin to show.");
  assert.equal(sourceCheckPoint({ ...none, sourceCheck: { urls: phones.sourceCheck.urls, unreadUrls: phones.sourceCheck.urls.slice(0, 2) } }), "None of your answer's 5 citations is readable and about this claim (2 could not be read), so Echo has no origin to show.");
  assert.equal(sourceCheckPoint({ ...none, sourceCheck: { urls: phones.sourceCheck.urls.slice(0, 1), unreadUrls: phones.sourceCheck.urls.slice(0, 1) } }), "Your answer's citation could not be read, so Echo has no origin to show.");
  assert.equal(sourceCheckPoint({ ...none, sourceCheck: { urls: phones.sourceCheck.urls.slice(0, 1) } }), "Your answer's citation is not about this claim, so Echo has no origin to show.");
  const someEvidence = { ...structuredClone(phones), summary: { ...phones.summary, independentOrigins: 3, verifiableOrigins: 1 } };
  assert.deepEqual(sourceCheckHeadline(someEvidence), { text: "5 supplied links → 3 independent origins", evidence: "1 with its own evidence" });
  // QA round 4 D1: a supplied-sources answer shows each citation with the supplied link's own number, so the answer,
  // its cited-source list and the per-link list agree; a search trace keeps the model's 1..N. Display only.
  {
    const { answerCitationNumbers, displayedAnswer } = load(path.join(projectRoot, "src", "lib", "echo", "supplied-urls.ts"));
    const renumbered = { ...structuredClone(phones), sourceCheck: { ...phones.sourceCheck, numbers: [2, 3, 4, 5, 6] } };
    assert.deepEqual(answerCitationNumbers(renumbered), [2], "asurion.com, pasted as [2], is cited as [2]");
    assert.ok(displayedAnswer(renumbered).includes("once every 10 minutes [2].") && !/\[1\]/.test(displayedAnswer(renumbered)), "the answer's [1] markers read [2]");
    assert.equal(renumbered.answer, phones.answer, "the stored answer text is unchanged");
    const originSecond = { ...structuredClone(phones), sourceCheck: { urls: [phones.sourceCheck.urls[1], phones.sourceCheck.urls[0], ...phones.sourceCheck.urls.slice(2)] } };
    assert.deepEqual(answerCitationNumbers(originSecond), [2], "1..N links: an origin pasted second is still cited as [2]");
    assert.deepEqual(answerCitationNumbers({ ...structuredClone(phones), sourceCheck: undefined }), [1], "a search trace keeps the model's numbering");
    assert.equal(displayedAnswer({ ...structuredClone(phones), sourceCheck: undefined }), phones.answer);
    const twoCited = { ...structuredClone(phones), answer: "A [1]. B [2]. C [3].", answerSourceIds: ["page-1", "page-3"], sourceCheck: { ...phones.sourceCheck, numbers: [2, 3, 4, 5, 6] } };
    assert.equal(displayedAnswer(twoCited), "A [2]. B [4]. C [3].", "each marker maps to its own source; a marker past the cited list is left as written");
  }
  process.stdout.write(`  ok  citation numbers: ${shapes.length} paste shapes ([1] url, 1. url, [^1]: url, [1](url), (1) url, unnumbered, http/www copies keep the first number, repeats and gaps) each give every link one number\n`);
}

// Telem as the search router (scripts/check-pipeline-telem.mjs): runs last (a fourth beforeExit, after the supplied
// sources check), in its own process so it shares none of this script's mocks, module copies or ledger. It mocks
// router.telem.ai and every other provider; nothing is reached.
process.once("beforeExit", () => {
  process.once("beforeExit", () => {
    process.once("beforeExit", () => {
      process.once("beforeExit", () => {
        const child = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "check-pipeline-telem.mjs")], { cwd: projectRoot, stdio: "inherit", env: { ...process.env } });
        if (child.status !== 0) process.exitCode = 1;
        // Deep search (scripts/check-pipeline-deep.mjs): its own process too, mocks and scratch ledger of its own.
        const deep = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "check-pipeline-deep.mjs")], { cwd: projectRoot, stdio: "inherit", env: { ...process.env } });
        if (deep.status !== 0) process.exitCode = 1;
      });
    });
  });
});
