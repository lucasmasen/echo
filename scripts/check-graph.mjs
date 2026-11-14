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
const { downstreamEchoes, groupDownstreamEchoes, summarizeTraceSignals } = load("../src/lib/echo/graph.ts");
const { changedSearchCoverage, changedSourceRelationships, compareAnswerEvidence, compareAnswerReviews, compareSourceReviews, comparisonPageKey } = load("../src/lib/echo/compare.ts");

const page = (id, kind, parentId = null) => ({ id, judgment: { kind, parentId } });
const pages = [
  page("root", "origin"),
  page("first", "derived", "root"),
  page("second", "derived", "first"),
  page("other", "derived", "root"),
  page("uncertain", "unclear", "root"),
  page("after-uncertain", "derived", "uncertain"),
];

assert.deepEqual(downstreamEchoes("root", pages).direct.map(({ id }) => id), ["first", "other"]);
assert.deepEqual(downstreamEchoes("root", pages).all.map(({ id }) => id), ["first", "other", "second"]);
assert.deepEqual(downstreamEchoes("uncertain", pages).all.map(({ id }) => id), ["after-uncertain"]);
assert.deepEqual(downstreamEchoes("missing", pages).all, []);

// A root published together with others counts the group's echoes once each (display only): on the v2 phones sources
// trace asurion.com has no derived link of its own, but Fox 13 → church blog hang off PR Newswire, its same release.
{
  const v2 = JSON.parse(fs.readFileSync(new URL("./fixtures/sources-phones-live-2026-11-13-v2.echo.json", import.meta.url), "utf8")).analysis;
  const asurion = v2.pages.find((entry) => entry.domain === "asurion.com").id;
  const pr = v2.pages.find((entry) => entry.domain === "prnewswire.com").id;
  assert.equal(downstreamEchoes(asurion, v2.pages).all.length, 0, "v2: asurion.com's own links reach no echo");
  const grouped = groupDownstreamEchoes(asurion, v2.pages, v2.coPublishedRootGroups);
  assert.deepEqual(grouped.all.map(({ domain }) => domain).sort(), ["churchandculture.org", "fox13seattle.com"], "v2: asurion.com counts PR Newswire's echoes");
  assert.deepEqual(grouped.direct.map(({ domain }) => domain), ["fox13seattle.com"]);
  assert.deepEqual(grouped.partners.map(({ domain }) => domain), ["prnewswire.com"]);
  const fromPr = groupDownstreamEchoes(pr, v2.pages, v2.coPublishedRootGroups);
  assert.equal(fromPr.all.length, 2);
  assert.deepEqual(fromPr.partners, [], "v2: PR Newswire's own links reach both echoes, so it names no partner");
  // Slot 02: Asurion's 2019 page reaches 4 echoes itself (Fox 13, the church blog, KABC, the reference page); its
  // same-day PR Newswire copy adds none, so Asurion stays 4 with no note, and PR Newswire shows the same 4.
  const slot02 = JSON.parse(fs.readFileSync(new URL("../public/demo-traces/americans-check-phones-96-times.echo.json", import.meta.url), "utf8")).analysis;
  const [lead, twin] = slot02.coPublishedRootGroups[0];
  const own = downstreamEchoes(lead, slot02.pages).all.map(({ id }) => id).sort();
  const slotGrouped = groupDownstreamEchoes(lead, slot02.pages, slot02.coPublishedRootGroups);
  assert.equal(own.length, 4);
  assert.deepEqual(slotGrouped.all.map(({ id }) => id).sort(), own, "slot 02: Asurion's count is unchanged");
  assert.deepEqual(slotGrouped.partners, []);
  const twinGrouped = groupDownstreamEchoes(twin, slot02.pages, slot02.coPublishedRootGroups);
  assert.deepEqual(twinGrouped.all.map(({ id }) => id).sort(), own);
  assert.deepEqual(twinGrouped.partners.map(({ id }) => id), [lead]);
  // A root in no group keeps its own count; a group's echoes count once each, never a member itself.
  assert.deepEqual(groupDownstreamEchoes("root", pages).all.map(({ id }) => id), ["first", "other", "second"]);
  const pair = [page("r1", "origin"), page("r2", "origin"), page("c1", "derived", "r1"), page("c2", "derived", "c1"), page("c3", "derived", "r2"), page("c4", "derived", "c1"), page("c5", "derived", "r2")];
  const both = groupDownstreamEchoes("r1", pair, [["r1", "r2"]]);
  assert.deepEqual(both.all.map(({ id }) => id), ["c1", "c2", "c4", "c3", "c5"]);
  assert.deepEqual(both.direct.map(({ id }) => id), ["c1", "c3", "c5"]);
}

// QA round 5 (S2-1): one rule picks the lead of roots published together, on every surface. Pasting PR Newswire first
// made the per-link list and Cite once name prnewswire.com the origin while the tree tagged asurion.com ORIGIN and the
// answer cited asurion.com. The lead is the page with its own evidence, then the one the answer cites, then the
// earliest reliable date, then supplied order: asurion.com in every order and numbering.
{
  const { coPublishedLeadOrder } = load("../src/lib/echo/graph.ts");
  const { sourceCiteOnce, sourceLinkRows } = load("../src/lib/echo/supplied-urls.ts");
  const v2 = JSON.parse(fs.readFileSync(new URL("./fixtures/sources-phones-live-2026-11-13-v2.echo.json", import.meta.url), "utf8")).analysis;
  const host = (url) => new URL(url).hostname.replace(/^www\./, "");
  const base = v2.sourceCheck.urls;
  const orders = [[0, 1, 2, 3, 4], [1, 0, 2, 3, 4], [4, 3, 2, 1, 0], [2, 1, 4, 0, 3]];
  let variants = 0;
  for (const order of orders) {
    for (const numbers of [undefined, [4, 5, 6, 7, 8]]) {
      const analysis = structuredClone(v2);
      analysis.sourceCheck = { ...analysis.sourceCheck, urls: order.map((index) => base[index]) };
      if (numbers) analysis.sourceCheck.numbers = numbers; else delete analysis.sourceCheck.numbers;
      const label = `order ${order.join("")}${numbers ? ", numbered [4]..[8]" : ""}`;
      const [leadId] = coPublishedLeadOrder(analysis, analysis.coPublishedRootGroups[0]);
      assert.equal(analysis.pages.find((entry) => entry.id === leadId).domain, "asurion.com", `${label}: asurion.com leads its co-published pair`);
      const rows = sourceLinkRows(analysis);
      const origin = rows.find((row) => row.status === "origin");
      const same = rows.find((row) => row.status === "same origin");
      assert.equal(origin.host, "asurion.com", `${label}: the list calls asurion.com the independent origin`);
      assert.equal(origin.verdict, "independent origin, with its own evidence", label);
      assert.equal(same.host, "prnewswire.com", label);
      assert.equal(same.verdict, `published together with [${origin.number}], one origin`, `${label}: PR Newswire points at asurion.com's number`);
      assert.match(sourceCiteOnce(analysis).line, new RegExp(`^Cite once: \\[${origin.number}\\] asurion\\.com \\(also published as \\[${same.number}\\]\\)\\.`), `${label}: Cite once recommends asurion.com`);
      assert.deepEqual(rows.map((row) => row.host), order.map((index) => host(base[index])), `${label}: rows keep the supplied order`);
      variants += 1;
    }
  }
  // Each rule step on its own: own evidence beats the answer's citation, which beats the date, which beats the order.
  const twin = (id, url, publishedDate) => ({ id, url, domain: host(url), publishedDate, publishedDateSource: "page metadata", judgment: { kind: "origin", parentId: null } });
  const pair = [twin("a", "https://a.example/x", "2020-01-02"), twin("b", "https://b.example/x", "2020-01-01")];
  const lead = (extra) => coPublishedLeadOrder({ pages: pair, ...extra }, ["a", "b"])[0];
  assert.equal(lead({}), "b", "no evidence or citation: the earliest reliable date leads");
  assert.equal(lead({ answerSourceIds: ["a"] }), "a", "the page the answer cites beats the earlier date");
  assert.equal(lead({ answerSourceIds: ["a"], verifiableRoots: ["b"] }), "b", "own evidence beats the answer's citation");
  assert.equal(coPublishedLeadOrder({ pages: [{ ...pair[0], publishedDate: null }, { ...pair[1], publishedDate: null }], sourceCheck: { urls: ["https://b.example/x", "https://a.example/x"] } }, ["a", "b"])[0], "b", "all else equal: supplied order");
  assert.deepEqual(coPublishedLeadOrder({ pages: pair }, ["a", "missing", "b"]), ["b", "a"], "ids that are not trace pages are left out");
  console.log(`Co-published lead: asurion.com leads the v2 pair in ${variants} pastings (4 orders, numbered from [1] and from [4]) in the list, Cite once and the shared rule.`);
}

const cyclic = [page("a", "derived", "b"), page("b", "derived", "a")];
assert.deepEqual(downstreamEchoes("a", cyclic).all.map(({ id }) => id), ["b"]);
assert.deepEqual(summarizeTraceSignals([
  { judgment: { kind: "derived", parentId: "root" }, publishedDate: "2020-01-01", publishedDateSource: "page text" },
  { judgment: { kind: "unclear", parentId: "root" }, publishedDate: "2021-01-01", publishedDateSource: "Tavily estimate" },
  { judgment: { kind: "unclear", parentId: null }, publishedDate: null },
]), { likelyEchoes: 1, possiblePaths: 1, datesToVerify: 2 });
// Round 5 (11/14): "dates to verify" uses the screen's rule (trace-view's reliablyDatedPages): a page has a reliable
// date only when it was read off the page (not a search estimate, with a recorded source), as a plain year, month or
// day, no later than two days ahead. An odd, future or sourceless date was counted as reliable here but not on screen.
{
  const { reliablyDatedPages } = load("../src/app/trace-view.ts");
  const dated = (publishedDate, publishedDateSource = "page text") => ({ judgment: { kind: "origin", parentId: null }, publishedDate, publishedDateSource });
  const soon = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const odd = [dated("2019"), dated("2019-05"), dated("2019-05-03"), dated(soon), dated("2031-01-01"), dated("2019-05-03T10:00:00Z"), dated("May 2019"), dated("2019-05-03", null), dated("2019-05-03", "Tavily estimate"), dated(null), dated("")];
  const unreliable = (pages) => pages.length - reliablyDatedPages({ pages }).length;
  assert.equal(unreliable(odd), 7, "the screen's rule: a year, a month, a day and tomorrow are reliable; seven are not");
  assert.equal(summarizeTraceSignals(odd).datesToVerify, unreliable(odd), "datesToVerify counts the pages the screen calls undated");
  for (const dir of ["../public/demo-traces/", "../evaluation/runs/"]) {
    for (const name of fs.readdirSync(new URL(dir, import.meta.url)).filter((file) => file.endsWith(".json"))) {
      const { pages } = JSON.parse(fs.readFileSync(new URL(`${dir}${name}`, import.meta.url), "utf8")).analysis;
      assert.equal(summarizeTraceSignals(pages).datesToVerify, unreliable(pages), `${name}: datesToVerify agrees with the screen`);
    }
  }
}

const source = (id, url, kind, parentId = null, primaryEvidenceStatus = "unclear") => ({
  id, url, title: id, domain: "example.org", hasPrimaryEvidence: primaryEvidenceStatus === "found",
  primaryEvidenceStatus, judgment: { kind, parentId },
});
const saved = {
  pages: [source("saved-root", "https://example.org/root?b=2&a=1&utm_source=test", "origin", null, "found"), source("saved-child", "https://example.org/child#old", "derived", "saved-root")],
  roots: ["saved-root"],
};
const sameWithNewIds = {
  pages: [source("new-root", "https://example.org/root/?a=1&b=2", "origin", null, "found"), source("new-child", "https://example.org/child", "derived", "new-root")],
  roots: ["new-root"],
};
assert.equal(comparisonPageKey(saved.pages[0]), comparisonPageKey(sameWithNewIds.pages[0]));
assert.deepEqual(changedSourceRelationships(sameWithNewIds, saved), []);

const revised = {
  pages: [source("new-root", "https://example.org/root/?a=1&b=2", "unclear", null, "not found"), { ...source("new-child", "https://example.org/child", "origin"), publishedDate: "2026-11-08", publishedDateSource: "page text" }],
  roots: ["new-child"],
};
assert.deepEqual(changedSourceRelationships(revised, saved).map(({ page, changes }) => [page.id, changes]), [
  ["new-root", ["classification", "primary evidence", "root candidacy"]],
  ["new-child", ["classification", "proposed source", "publication date", "root candidacy"]],
]);
const changedPassage = structuredClone(sameWithNewIds);
changedPassage.pages[0].text = "New extracted evidence appears here.";
changedPassage.pages[0].extractionSource = "Tavily extraction";
const oldPassage = structuredClone(saved);
oldPassage.pages[0].text = "Earlier search snippet.";
oldPassage.pages[0].extractionSource = "Search snippet";
assert.deepEqual(changedSourceRelationships(changedPassage, oldPassage).map(({ page, changes }) => [page.id, changes]), [
  ["new-root", ["extraction method", "retrieved passage"]],
]);
changedPassage.pages[0].text = "Earlier   search\n snippet.";
changedPassage.pages[0].extractionSource = "Search snippet";
assert.deepEqual(changedSourceRelationships(changedPassage, oldPassage), [], "whitespace-only extraction changes should not create a review flag");

const audit = (query, status, matchingResults, totalResults = matchingResults) => ({ query, depth: "basic", status, matchingResults, totalResults, uniquePagesAdded: matchingResults });
assert.deepEqual(changedSearchCoverage(
  { searchAudit: [audit("  example   claim ", "searched", 4), audit("new phrase", "searched", 2)] },
  { searchAudit: [audit("example claim", "searched", 4), audit("failed phrase", "failed", 0)] },
).map(({ query }) => query), ["new phrase", "failed phrase"]);
assert.deepEqual(changedSearchCoverage({ searchAudit: [] }, { searchAudit: [] }), []);

const oldAnswer = { ...saved, answer: "Original answer [1].", answerStatus: "generated", answerSourceIds: ["saved-root"] };
const sameAnswerNewIds = { ...sameWithNewIds, answer: "Original answer [1].", answerStatus: "generated", answerSourceIds: ["new-root"] };
assert.deepEqual(compareAnswerEvidence(sameAnswerNewIds, oldAnswer), {
  answerChanged: false, statusChanged: false, citedSourcesAdded: [], citedSourcesRemoved: [],
});
const changedAnswer = { ...sameAnswerNewIds, answer: "Revised answer [1].", answerStatus: "source-limited", answerSourceIds: ["new-child"] };
const answerChange = compareAnswerEvidence(changedAnswer, oldAnswer);
assert.equal(answerChange.answerChanged, true);
assert.equal(answerChange.statusChanged, true);
assert.deepEqual(answerChange.citedSourcesAdded.map((page) => page.id), ["new-child"]);
assert.deepEqual(answerChange.citedSourcesRemoved.map((page) => page.id), ["saved-root"]);

const reviewedOldAnswer = { ...oldAnswer, answerStatements: [{ text: "Original answer", sourceIds: ["saved-root"] }], answerReviews: { "0": { status: "supported", note: "Original page checked." } } };
const reviewedNewIds = { ...sameAnswerNewIds, answerStatements: [{ text: "Original answer", sourceIds: ["new-root"] }], answerReviews: { "0": { status: "supported", note: "Original page checked." } } };
assert.deepEqual(compareAnswerReviews(reviewedNewIds, reviewedOldAnswer), {
  currentReviewed: 1, previousReviewed: 1, currentTotal: 1, previousTotal: 1, changed: [],
}, "new page IDs should not look like changed manual checks");
const revisedReview = { ...reviewedNewIds, answerReviews: { "0": { status: "unsupported", note: "The page does not show the claimed number." } } };
assert.deepEqual(compareAnswerReviews(revisedReview, reviewedOldAnswer).changed, [{
  statement: "Original answer", current: revisedReview.answerReviews["0"], previous: reviewedOldAnswer.answerReviews["0"],
}]);
assert.equal(compareAnswerReviews({ ...reviewedNewIds, answerReviews: {} }, reviewedOldAnswer).changed.length, 1);
assert.equal(compareAnswerReviews({ ...sameAnswerNewIds, answerStatements: undefined }, reviewedOldAnswer).changed.length, 1);

const inspectedOld = { ...saved, inspectedPageIds: ["saved-root"], reviewNotesByPageId: { "saved-root": "Confirmed the date on the page." }, sourceAssessmentsByPageId: { "saved-root": "supported" } };
const inspectedNew = { ...sameWithNewIds, inspectedPageIds: ["new-root"], reviewNotesByPageId: { "new-root": "Confirmed the date on the page." }, sourceAssessmentsByPageId: { "new-root": "supported" } };
assert.deepEqual(compareSourceReviews(inspectedNew, inspectedOld), { currentInspected: 1, previousInspected: 1, changed: [] });
const updatedSourceReview = { ...inspectedNew, inspectedPageIds: [], reviewNotesByPageId: { "new-root": "Date is actually an update." }, sourceAssessmentsByPageId: { "new-root": "challenged" } };
assert.deepEqual(compareSourceReviews(updatedSourceReview, inspectedOld).changed.map(({ page, currentInspected, previousInspected, currentNote, previousNote, currentAssessment, previousAssessment }) => ({ id: page.id, currentInspected, previousInspected, currentNote, previousNote, currentAssessment, previousAssessment })), [{
  id: "new-root", currentInspected: false, previousInspected: true, currentNote: "Date is actually an update.", previousNote: "Confirmed the date on the page.", currentAssessment: "challenged", previousAssessment: "supported",
}]);

process.stdout.write("Echo graph passed: reachability, cycle guard, saved-run source, answer, manual review, citation, and query-coverage changes.\n");
