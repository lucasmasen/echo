import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const load = createRequire(import.meta.url);
load.extensions[".ts"] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  module._compile(code, filename);
};

const { cloneDemoAnalysis } = load("../src/lib/echo/demo-data.ts");
const { makePortableTrace, parsePortableTrace } = load("../src/lib/echo/portable.ts");
const analysis = cloneDemoAnalysis("brain");
assert.ok(analysis);
analysis.inspectedPageIds = [analysis.pages[0].id];
analysis.reviewNotesByPageId = { [analysis.pages[0].id]: "Checked the original page; this wording appears in its introduction." };
analysis.sourceAssessmentsByPageId = { [analysis.pages[0].id]: "challenged" };
const trace = makePortableTrace(analysis);
assert.deepEqual(parsePortableTrace(trace)?.inspectedPageIds, analysis.inspectedPageIds);
assert.deepEqual(parsePortableTrace(trace)?.reviewNotesByPageId, analysis.reviewNotesByPageId);
assert.deepEqual(parsePortableTrace(trace)?.sourceAssessmentsByPageId, analysis.sourceAssessmentsByPageId);
// Live runs 2026-11-12 (banana DNA, Napoleon): a reliably dated page linking an undated page was saved as derived
// of it, but the import check only accepted the opposite direction, so those runs could not be reopened.
const liveRun = JSON.parse(fs.readFileSync(new URL("../public/demo-traces/lose-most-body-heat-through-head.echo.json", import.meta.url), "utf8"));
assert.ok(parsePortableTrace(liveRun), "a committed live run loads");
assert.equal(parsePortableTrace({ ...liveRun, analysis: { ...liveRun.analysis, createdAt: "not a date" } }), null, "a trace whose date does not parse is refused");
const reverse = structuredClone(liveRun);
const webmdPage = reverse.analysis.pages.find((page) => page.domain === "webmd.com");
const badgerPage = reverse.analysis.pages.find((page) => page.domain === "badgeraustralia.com.au");
assert.equal(badgerPage.judgment.parentId, webmdPage.id);
webmdPage.publishedDate = null;
delete webmdPage.publishedDateSource;
assert.ok(parsePortableTrace(reverse), "a dated page that links an undated page may be derived from it");
badgerPage.citations = [];
assert.equal(parsePortableTrace(reverse), null, "without the citation, an undated parent still cannot be accepted");
const limitedAnswer = structuredClone(trace);
limitedAnswer.analysis.answerStatus = "source-limited";
assert.equal(parsePortableTrace(limitedAnswer)?.answerStatus, "source-limited");

const reviewedAnswer = structuredClone(trace);
reviewedAnswer.analysis.answerStatus = "generated";
reviewedAnswer.analysis.answerSourceIds = [analysis.roots[0]];
reviewedAnswer.analysis.answer = "A checked statement [1].";
reviewedAnswer.analysis.answerStatements = [{ text: "A checked statement", sourceIds: [analysis.roots[0]] }];
reviewedAnswer.analysis.answerReviews = { "0": { status: "supported", note: "The original page shows this result." } };
assert.deepEqual(parsePortableTrace(reviewedAnswer)?.answerReviews, reviewedAnswer.analysis.answerReviews);

const inventedAnswerSource = structuredClone(reviewedAnswer);
inventedAnswerSource.analysis.answerStatements[0].sourceIds = ["missing-page"];
assert.equal(parsePortableTrace(inventedAnswerSource), null);

const alteredAnswer = structuredClone(reviewedAnswer);
alteredAnswer.analysis.answer = "A different statement [1].";
assert.equal(parsePortableTrace(alteredAnswer), null);

const invalidAnswerReview = structuredClone(reviewedAnswer);
invalidAnswerReview.analysis.answerReviews["0"].status = "verified";
assert.equal(parsePortableTrace(invalidAnswerReview), null);

const nonexistentStatementReview = structuredClone(reviewedAnswer);
nonexistentStatementReview.analysis.answerReviews = { "1": { status: "supported", note: "Not in this answer." } };
assert.equal(parsePortableTrace(nonexistentStatementReview), null);

const unknownPage = structuredClone(trace);
unknownPage.analysis.inspectedPageIds = ["missing-page"];
assert.equal(parsePortableTrace(unknownPage), null);

const repeatedPage = structuredClone(trace);
repeatedPage.analysis.inspectedPageIds = [analysis.pages[0].id, analysis.pages[0].id];
assert.equal(parsePortableTrace(repeatedPage), null);

const oversizedReview = structuredClone(trace);
oversizedReview.analysis.inspectedPageIds = Array.from({ length: 201 }, (_, index) => `page-${index}`);
assert.equal(parsePortableTrace(oversizedReview), null);

const unknownNote = structuredClone(trace);
unknownNote.analysis.reviewNotesByPageId = { "missing-page": "A note on a page outside this trace." };
assert.equal(parsePortableTrace(unknownNote), null);

const oversizedNote = structuredClone(trace);
oversizedNote.analysis.reviewNotesByPageId = { [analysis.pages[0].id]: "x".repeat(601) };
assert.equal(parsePortableTrace(oversizedNote), null);

const emptyNote = structuredClone(trace);
emptyNote.analysis.reviewNotesByPageId = { [analysis.pages[0].id]: "   " };
assert.equal(parsePortableTrace(emptyNote), null);

const unknownAssessment = structuredClone(trace);
unknownAssessment.analysis.sourceAssessmentsByPageId = { "missing-page": "challenged" };
assert.equal(parsePortableTrace(unknownAssessment), null);

const invalidAssessment = structuredClone(trace);
invalidAssessment.analysis.sourceAssessmentsByPageId = { [analysis.pages[0].id]: "verified" };
assert.equal(parsePortableTrace(invalidAssessment), null);

const { coPublishedRootGroups, originCounts } = load("../src/lib/echo/origins.ts");
const release = "Global tech care company Asurion found that Americans check their phones 96 times a day, or once every ten minutes, a twenty percent increase from its previous survey of two thousand adults, according to the research.";
const rootPage = (id, date, text, publishedDateSource = "page metadata") => ({ id, publishedDate: date, publishedDateSource, text });
const groups = coPublishedRootGroups([
  rootPage("newsroom", "2019-11-21", release),
  rootPage("wire", "2019-11-21", `PRNewswire: ${release}`),
  rootPage("followup", "2022-04-22", "A new survey of 1,965 adults found people now reach for their phones 352 times a day, far above earlier figures."),
  rootPage("estimated", "2019-11-21", release, "Tavily estimate"),
]);
const pageHtmlTrace = structuredClone(trace);
pageHtmlTrace.analysis.pages[0].extractionSource = "Page HTML";
assert.equal(parsePortableTrace(pageHtmlTrace)?.pages[0].extractionSource, "Page HTML", "text read from the page itself survives export and import");
assert.deepEqual(groups, [["newsroom", "wire"]], "the same release posted twice the same day is one origin; estimated dates are not merged");
assert.deepEqual(originCounts(["newsroom", "wire", "followup"], ["newsroom", "wire"], groups), { independent: 2, verifiable: 1 });
// Live run 2026-11-12 ("Cracking your knuckles causes arthritis"): the JABFM full text and its PubMed abstract were
// counted as two independent origins of one 2011 study.
const titled = (id, title, date, source, citations) => ({ id, title, publishedDate: date, publishedDateSource: source, text: `${id} passage`, ...(citations ? { citations } : {}) });
const journal = titled("jabfm", "Knuckle Cracking and Hand Osteoarthritis | American Board of Family Medicine", "2011-03-01", "page metadata");
const abstract = titled("pubmed", "Knuckle cracking and hand osteoarthritis.", "2011-01-01", "Tavily estimate", [{ pageId: "jabfm", how: "title", quote: "q" }]);
assert.deepEqual(coPublishedRootGroups([journal, abstract]), [["jabfm", "pubmed"]], "a journal article and its abstract page are one work");
assert.deepEqual(coPublishedRootGroups([journal, { ...abstract, citations: undefined, publishedDate: "2016-05-01" }]), [], "the same title years apart, with no citation, is not merged");
assert.deepEqual(coPublishedRootGroups([titled("a", "Myth busted", "2020-01-01", "page metadata"), titled("b", "Myth busted", "2020-01-02", "page metadata")]), [], "short generic titles are not enough");
const grouped = structuredClone(trace);
grouped.analysis.coPublishedRootGroups = [grouped.analysis.roots.slice(0, 2)];
grouped.analysis.summary.independentOrigins = grouped.analysis.roots.length - 1;
grouped.analysis.summary.verifiableOrigins = originCounts(grouped.analysis.roots, grouped.analysis.verifiableRoots, grouped.analysis.coPublishedRootGroups).verifiable;
assert.deepEqual(parsePortableTrace(grouped)?.coPublishedRootGroups, grouped.analysis.coPublishedRootGroups, "co-published groups survive export and import");
const badGroup = structuredClone(grouped);
badGroup.analysis.coPublishedRootGroups = [[grouped.analysis.roots[0], "not-a-root"]];
assert.equal(parsePortableTrace(badGroup), null, "groups must reference roots");
const inflated = structuredClone(grouped);
inflated.analysis.summary.independentOrigins = grouped.analysis.roots.length;
assert.equal(parsePortableTrace(inflated), null, "the origin count must match the grouped roots");
const nullFavicon = structuredClone(trace);
nullFavicon.analysis.pages[0].favicon = null;
assert.ok(parsePortableTrace(nullFavicon), "a page whose search result had no favicon (null) still imports");
// Regression (11/10 live run 2): the pipeline links an undated page to an earlier, reliably dated page it
// explicitly cites. Such a live trace must import; the same link without the citation must not.
const liveTrace = JSON.parse(fs.readFileSync(new URL("../public/demo-traces/americans-check-phones-96-times.echo.json", import.meta.url), "utf8"));
assert.equal(liveTrace.analysis.mode, "live");
assert.ok(parsePortableTrace(liveTrace), "the saved live demo trace imports");
const undatedChild = structuredClone(liveTrace);
const child = undatedChild.analysis.pages.find((page) => page.id === "page-6");
assert.equal(child.judgment.kind, "derived");
assert.equal(child.judgment.parentId, "page-2");
child.publishedDate = null;
delete child.publishedDateSource;
delete child.publishedDateEvidence;
assert.equal(parsePortableTrace(undatedChild), null, "an undated derived page without a citation is rejected");
const citedChild = structuredClone(undatedChild);
citedChild.analysis.pages.find((page) => page.id === "page-6").citations = [{ pageId: "page-2", how: "name and year", quote: "Asurion (2019)" }];
assert.ok(parsePortableTrace(citedChild), "an undated page that cites its reliably dated parent imports");
const estimatedChild = structuredClone(citedChild);
Object.assign(estimatedChild.analysis.pages.find((page) => page.id === "page-6"), { publishedDate: "2026-01-01", publishedDateSource: "Tavily estimate" });
assert.ok(parsePortableTrace(estimatedChild), "a page with only an estimated date that cites its parent imports");
const estimatedParent = structuredClone(citedChild);
estimatedParent.analysis.pages.find((page) => page.id === "page-2").publishedDateSource = "Tavily estimate";
assert.equal(parsePortableTrace(estimatedParent), null, "a citation to a parent with only an estimated date does not set direction");
const citesOtherPage = structuredClone(undatedChild);
citesOtherPage.analysis.pages.find((page) => page.id === "page-6").citations = [{ pageId: "page-7", how: "link", quote: "asurion.com" }];
assert.equal(parsePortableTrace(citesOtherPage), null, "a citation to a different page does not justify this parent link");
// A file under 2 MB can nest an unchecked field 100,000 levels deep; it is refused, not a thrown stack overflow (the
// copy-hunt route parses traces outside its try block, so a throw there was a 500).
const deep = structuredClone(trace);
let nested = [];
for (let level = 0; level < 100_000; level += 1) nested = [nested];
deep.analysis.summary.extra = nested;
assert.equal(parsePortableTrace(deep), null, "a deeply nested extra field is refused");
const citesUnknown = structuredClone(trace);
citesUnknown.analysis.pages[0].citations = [{ pageId: "no-such-page", how: "link", quote: "q" }];
assert.equal(parsePortableTrace(citesUnknown), null, "a citation must name a page in the trace");
citesUnknown.analysis.pages[0].citations = [{ pageId: citesUnknown.analysis.pages[0].id, how: "link", quote: "q" }];
assert.equal(parsePortableTrace(citesUnknown), null, "a page cannot cite itself");
// A page date is a plain year or an ISO date: free text such as "Spring 1999" labelled "page metadata" would be
// shown as a date read from the page although Echo never produces one.
for (const [date, accepted] of [["2019", true], ["2019-03", true], ["2019-03-07", true], ["2019-03-07T10:15:00Z", true], ["2019-03-07T10:15:00.000+02:00", true],
  ["Spring 1999", false], ["March 7, 2019", false], ["2019-13-01", false], ["2019-02-30", false], ["2019-03-07 junk", false], ["", false]]) {
  for (const publishedDateSource of ["page metadata", "Tavily estimate"]) {
    const dated = structuredClone(liveTrace);
    Object.assign(dated.analysis.pages.find((page) => page.id === "page-8"), { publishedDate: date, publishedDateSource });
    assert.equal(Boolean(parsePortableTrace(dated)), accepted, `a ${publishedDateSource} page date "${date}" is ${accepted ? "accepted" : "refused"}`);
  }
}
for (const name of fs.readdirSync(new URL("../public/demo-traces/", import.meta.url))) {
  assert.ok(parsePortableTrace(JSON.parse(fs.readFileSync(new URL(`../public/demo-traces/${name}`, import.meta.url), "utf8"))), `${name} still imports`);
}
for (const name of fs.readdirSync(new URL("../evaluation/runs/", import.meta.url))) {
  assert.ok(parsePortableTrace(JSON.parse(fs.readFileSync(new URL(`../evaluation/runs/${name}`, import.meta.url), "utf8"))), `${name} still imports`);
}
// A live run's cost receipt (pipeline.ts) is checked on import: a file with a bad one is refused, never repaired.
{
  const { ReceiptDraft } = load("../src/lib/echo/cost-receipt.ts");
  const draft = new ReceiptDraft(0.008);
  draft.tavilyRequest("search", "basic", 0, 1);
  draft.tavilyRequest("search", "advanced", 0, 2);
  draft.tavilyRequest("extract", undefined, 18, 4);
  draft.claudeRequest({ step: "grouping", model: "claude-haiku-4-5", inputTokens: 21_340, outputTokens: 1_210, cacheWriteTokens: 0, cacheReadTokens: 0, usd: 0.0274 });
  draft.claudeRequest({ step: "judgment", model: "claude-sonnet-4-5", inputTokens: 38_002, outputTokens: 4_515, cacheWriteTokens: 12_000, cacheReadTokens: 0, usd: 0.1817333 });
  draft.claudeRequest({ step: "answer", model: "claude-sonnet-4-5", inputTokens: 9_870, outputTokens: 640, cacheWriteTokens: 0, cacheReadTokens: 0, usd: 0.039211 });
  draft.addStage("search", 2_400);
  const receipt = draft.finish();
  const withReceipt = (mutate = () => {}) => {
    const file = structuredClone(liveRun);
    file.analysis.costReceipt = structuredClone(receipt);
    mutate(file.analysis.costReceipt, file.analysis);
    return parsePortableTrace(file);
  };
  assert.deepEqual(withReceipt()?.costReceipt, receipt, "a live run's receipt round-trips");
  assert.equal(parsePortableTrace(liveRun)?.costReceipt, undefined, "a trace without a receipt still imports");
  const refused = {
    "a receipt that is not an object": (_, analysis) => { analysis.costReceipt = "free"; },
    "another version": (r) => { r.version = 2; },
    "a missing field": (r) => { delete r.stageMs.answer; },
    "an extra field": (r) => { r.note = "trust me"; },
    "an extra Tavily field": (r) => { r.tavily.freeCredits = 3; },
    "an extra Claude field": (r) => { r.claude[0].discount = 1; },
    "a negative count": (r) => { r.tavily.basicSearches = -1; },
    "a non-number count": (r) => { r.tavily.credits = "7"; },
    "an infinite figure": (r) => { r.claude[1].inputTokens = Infinity; },
    "credits over 1000": (r) => { r.tavily.credits = 5_000; },
    "a stage over an hour": (r) => { r.stageMs.total = 2 * 3_600_000; },
    "a dollar figure over $100": (r) => { r.claude[0].usd = 250; r.usd.claude += 250 - 0.0274; r.usd.total += 250 - 0.0274; },
    "an unknown step": (r) => { r.claude[0].step = "rejudge"; },
    "an empty model": (r) => { r.claude[0].model = ""; },
    "a long model name": (r) => { r.claude[0].model = "m".repeat(500); },
    "eleven Claude calls": (r) => { r.claude = Array.from({ length: 11 }, () => ({ ...r.claude[0], usd: 0 })); r.usd.claude = 0; r.usd.total = r.usd.tavily; },
    "Claude entries that are not a list": (r) => { r.claude = { 0: r.claude[0] }; },
    "a total that is not Claude plus Tavily": (r) => { r.usd.total = r.usd.claude; },
    "a Claude total that is not its calls": (r) => { r.usd.claude += 1; r.usd.total += 1; },
    "a Tavily total that is not its credits": (r) => { r.usd.tavily += 1; r.usd.total += 1; },
  };
  for (const [label, mutate] of Object.entries(refused)) assert.equal(withReceipt(mutate), null, `refused: ${label}`);
  assert.ok(withReceipt((r) => { r.claude = []; r.usd.claude = 0; r.usd.total = r.usd.tavily; }), "a run whose Claude calls all failed has an empty list");
  // Round 5 (11/14): a Claude entry may say how much of its output was thinking (ECHO_LOG_USAGE reads it): optional,
  // a finite count no larger than the entry's output tokens.
  for (const [label, thinking] of [["none of it", 0], ["part of it", 1_200], ["all of it", 4_515]]) {
    const imported = withReceipt((r) => { r.claude[1].thinkingTokens = thinking; });
    assert.equal(imported?.costReceipt.claude[1].thinkingTokens, thinking, `thinking tokens import: ${label}`);
  }
  for (const [label, thinking] of [["negative", -1], ["more than the output", 4_516], ["not a number", "900"], ["infinite", Infinity], ["NaN", Number.NaN], ["null", null]]) {
    assert.equal(withReceipt((r) => { r.claude[1].thinkingTokens = thinking; }), null, `thinking tokens refused: ${label}`);
  }
}
// Bug round 11/13: the search audit ("what the plain search returned") was imported as written. A file could say a
// query kept 9 pages from 2 results, list a page twice, or show a failed search that returned results. The pipeline
// writes pages kept <= unique pages added <= matching results <= results returned, each page added by one query
// only, and no results for a failed or skipped query; a file that breaks that is refused, never repaired.
{
  const withAudit = (mutate) => {
    const file = structuredClone(liveRun);
    mutate(file.analysis.searchAudit, file.analysis);
    return parsePortableTrace(file);
  };
  const kept = liveRun.analysis.searchAudit.findIndex((entry) => entry.pageIds?.length >= 2);
  assert.ok(kept >= 0 && withAudit(() => {}), "the committed head-heat run has a query that kept two pages, and imports");
  const refusedAudits = {
    "more pages kept than added": (audit) => { audit[kept].uniquePagesAdded = audit[kept].pageIds.length - 1; },
    "more pages added than matched": (audit) => { audit[kept].matchingResults = audit[kept].uniquePagesAdded - 1; },
    "more matches than results returned": (audit) => { audit[kept].totalResults = audit[kept].matchingResults - 1; },
    "a fractional count": (audit) => { audit[kept].totalResults += 0.5; },
    "a page listed twice in one query": (audit) => { audit[kept].pageIds = [audit[kept].pageIds[0], audit[kept].pageIds[0]]; },
    "a page added by two queries": (audit) => { const other = audit.findIndex((entry, index) => index !== kept && entry.status === "searched"); audit[other].pageIds = [...(audit[other].pageIds ?? []), audit[kept].pageIds[0]]; audit[other].uniquePagesAdded = Math.max(audit[other].uniquePagesAdded, audit[other].pageIds.length); audit[other].matchingResults = Math.max(audit[other].matchingResults, audit[other].uniquePagesAdded); audit[other].totalResults = Math.max(audit[other].totalResults, audit[other].matchingResults); },
    "a page id not in the trace": (audit) => { audit[kept].pageIds[0] = "page-999"; },
    "a failed search that returned results": (audit) => { audit[kept].status = "failed"; },
    "a skipped search that returned results": (audit) => { audit[kept].status = "not searched"; },
  };
  for (const [label, mutate] of Object.entries(refusedAudits)) assert.equal(withAudit(mutate), null, `search audit refused: ${label}`);
  assert.ok(withAudit((audit) => { audit.push({ query: "a skipped variant", depth: "basic", status: "not searched", totalResults: 0, matchingResults: 0, uniquePagesAdded: 0, pageIds: [] }); }), "a skipped query with no results imports");
  assert.ok(withAudit((audit) => { audit[kept].totalResults += 5; audit[kept].matchingResults += 2; }), "results that matched but added no page (already found) import");
}
// "Check these sources": a supplied-sources trace (sourceCheck, no search audit) round-trips through export and
// import; an older trace without sourceCheck still loads (above); a file whose supplied list does not cover its pages,
// or that also claims a search, is refused.
{
  const sources = structuredClone(liveRun);
  delete sources.analysis.searchAudit;
  const unread = "https://paywalled.example/phones";
  sources.analysis.sourceCheck = { urls: [...sources.analysis.pages.map((page) => page.url), unread], unreadUrls: [unread] };
  const loaded = parsePortableTrace(sources);
  assert.ok(loaded, "a supplied-sources trace loads");
  assert.deepEqual(loaded.sourceCheck, sources.analysis.sourceCheck, "its supplied and unread links load as saved");
  const again = parsePortableTrace(JSON.parse(JSON.stringify(makePortableTrace(loaded))));
  assert.deepEqual(again, loaded, "a supplied-sources trace round-trips through export and import unchanged");
  const refused = {
    "a page that was not supplied": (check) => { check.urls = check.urls.slice(1); },
    "a search audit as well": (_check, analysis) => { analysis.searchAudit = []; },
    "a trace page listed as unread": (check) => { check.unreadUrls = [check.urls[0]]; },
    "an unread link that was not supplied": (check) => { check.unreadUrls = ["https://elsewhere.example/x"]; },
    "the same link twice": (check) => { check.urls = [...check.urls, `${check.urls[0]}#again`]; },
    "more than 20 links": (check) => { check.urls = [...check.urls, ...Array.from({ length: 20 }, (_, index) => `https://n${index}.example/x`)]; },
    "a non-web link": (check) => { check.urls = [...check.urls, "javascript:alert(1)"]; },
    "an unknown field": (check) => { check.query = "x"; },
    "not an object": (_check, analysis) => { analysis.sourceCheck = ["https://a.example/x"]; },
  };
  for (const [label, mutate] of Object.entries(refused)) {
    const file = structuredClone(sources);
    mutate(file.analysis.sourceCheck, file.analysis);
    assert.equal(parsePortableTrace(file), null, `supplied-sources trace refused: ${label}`);
  }
}
process.stdout.write("Echo portable trace passed: source and answer reviews round-trip; malformed citations and review data are rejected; supplied-sources traces round-trip.\n");
