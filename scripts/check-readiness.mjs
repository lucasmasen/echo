import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(code, filename);
};
const { cloneDemoAnalysis } = load("../src/lib/echo/demo-data.ts");
const { makePortableTrace } = load("../src/lib/echo/portable.ts");
const { auditTrace } = load("../src/lib/echo/readiness.ts");
const analysis = cloneDemoAnalysis("brain");
assert.ok(analysis);
analysis.inspectedPageIds = [analysis.pages[0].id];
analysis.reviewNotesByPageId = { [analysis.pages[0].id]: "Reviewed the source date." };
analysis.sourceAssessmentsByPageId = { [analysis.pages[0].id]: "challenged" };
const audit = auditTrace(analysis);
assert.equal(audit.pages, 10);
assert.equal(audit.likelyEchoes, 8);
assert.equal(audit.missingDates, 10);
assert.equal(audit.rootsWithPrimaryEvidence, 0);
assert.equal(audit.inspectedPages, 1);
assert.equal(audit.reviewNotePages, 1);
assert.equal(audit.sourceAssessments, 1);
assert.equal(audit.challengedSourceJudgments, 1);
assert.ok(audit.notes.some((note) => note.includes("challenged by a reviewer")));
assert.equal(audit.citedRoots, analysis.answerSourceIds.length);
assert.equal(audit.rootsOmittedFromAnswer, 0);
const reviewedAnswer = auditTrace({ ...analysis, answerStatements: [{ text: "A finding", sourceIds: [analysis.roots[0]] }], answerReviews: { "0": { status: "unsupported", note: "The cited excerpt does not contain that number." } } });
assert.equal(reviewedAnswer.answerStatementsReviewed, 1);
assert.equal(reviewedAnswer.answerStatementsUnsupported, 1);
assert.ok(reviewedAnswer.notes.some((note) => note.includes("marked unsupported")));
// "Trace with Echo" bookmarklet: run its code against a fake page and read the tab it would open.
{
  const vm = await import("node:vm");
  const { bookmarkletCode, bookmarkletHref } = load("../src/lib/echo/bookmarklet.ts");
  const run = (selection, typed = null, origin = "https://echo.example", pageGlobals = {}) => {
    const opened = [];
    const window = { getSelection: () => ({ toString: () => selection }), prompt: () => typed, open: (...args) => { opened.push(args); return null; } };
    vm.runInNewContext(bookmarkletCode(origin), { window, ...pageGlobals });
    return opened;
  };
  // 11/12 round 4: a cut through an emoji left half of it, which reached the claim box as "\uFFFD"; a page whose
  // URL or String global is replaced (old polyfills) made the bookmark throw or ignore the selection.
  const emoji = `${"a".repeat(499)}\u{1F600}tail`;
  const cut = new URL(run(emoji)[0][0]).searchParams.get("claim");
  assert.equal(cut, "a".repeat(499), "a cut never leaves half a character");
  assert.ok(!cut.includes("\uFFFD"));
  const brokenGlobals = { URL: function () { throw new Error("broken polyfill"); }, String: () => "", encodeURIComponent };
  assert.equal(new URL(run("Goldfish have a 3-second memory", null, "https://echo.example", brokenGlobals)[0][0]).searchParams.get("claim"), "Goldfish have a 3-second memory", "a page that replaces URL or String still gets the selection traced");
  const one = run("  Americans check their\n phones   96 times a day ");
  assert.equal(one.length, 1);
  assert.equal(new URL(one[0][0]).searchParams.get("claim"), "Americans check their phones 96 times a day", "the selection is whitespace-collapsed into ?claim=");
  assert.equal(new URL(one[0][0]).origin, "https://echo.example");
  assert.deepEqual(one[0].slice(1), ["_blank", "noopener"], "it opens a new tab without a handle back to the page");
  assert.equal(new URL(run("", "Goldfish have a 3-second memory")[0][0]).searchParams.get("claim"), "Goldfish have a 3-second memory", "with no selection it asks for the claim");
  assert.equal(run("", null).length, 0, "cancelling the prompt opens nothing");
  assert.equal(run("   ", "   ").length, 0, "blank input opens nothing");
  assert.equal(new URL(run("x".repeat(2_000))[0][0]).searchParams.get("claim").length, 500, "long selections are cut to 500 characters");
  const hostile = `'); alert(1); ('</script>&claim=evil#x`;
  assert.equal(new URL(run(hostile)[0][0]).searchParams.get("claim"), hostile, "quotes, tags, & and # in the selection stay text inside the one parameter");
  assert.ok(new URL(run("a claim here", null, "https://echo.example/some/path?x=1")[0][0]).href.startsWith("https://echo.example/?claim="), "it always opens Echo's home page");
  assert.ok(bookmarkletHref("https://echo.example").startsWith("javascript:") && !/[\s"<>]/.test(bookmarkletHref("https://echo.example")), "the bookmark address is a single encoded javascript: URL");
}

// Presenter lock: off without a key; with one, only the presenter cookie may start paid work.
{
  const { isPresenterKey, mayStartPaidWork, presenterToken, PRESENTER_COOKIE } = load("../src/lib/echo/presenter.ts");
  const saved = process.env.ECHO_PRESENTER_KEY;
  const withCookie = (value) => new Request("http://echo.test/api/analyze", { method: "POST", headers: value === null ? {} : { cookie: `theme=dark; ${PRESENTER_COOKIE}=${value}` } });
  delete process.env.ECHO_PRESENTER_KEY;
  assert.equal(mayStartPaidWork(withCookie(null)), true, "no key: live runs stay open");
  process.env.ECHO_PRESENTER_KEY = "   ";
  assert.equal(mayStartPaidWork(withCookie(null)), true, "a blank key does not lock anything");
  process.env.ECHO_PRESENTER_KEY = "stage-key-2026";
  assert.equal(mayStartPaidWork(withCookie(null)), false, "a key set: a visitor without the cookie cannot start paid work");
  assert.equal(mayStartPaidWork(withCookie(presenterToken("stage-key-2026"))), true, "the presenter cookie can");
  assert.equal(mayStartPaidWork(withCookie(presenterToken("wrong"))), false, "a token for another key cannot");
  assert.equal(mayStartPaidWork(withCookie("stage-key-2026")), false, "the raw key is not a valid cookie");
  assert.equal(mayStartPaidWork(withCookie("%E0%A4%A")), false, "a malformed cookie is refused, not thrown");
  assert.notEqual(presenterToken("stage-key-2026"), "stage-key-2026", "the cookie never holds the key");
  assert.equal(isPresenterKey("stage-key-2026"), true);
  assert.equal(isPresenterKey("stage-key-202"), false);
  assert.equal(isPresenterKey(null), false);
  if (saved === undefined) delete process.env.ECHO_PRESENTER_KEY; else process.env.ECHO_PRESENTER_KEY = saved;
}

// 11/12 round 4: the analyze and copy-hunt routes read the whole body with request.text() before checking its size,
// so a chunked request with no Content-Length could be any size. They must stop reading once it passes the limit.
{
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return resolveFilename.call(this, request.startsWith("@/") ? path.join(projectRoot, "src", request.slice(2)) : request, ...rest);
  };
  const savedEnv = { key: process.env.ECHO_PRESENTER_KEY, hunt: process.env.ECHO_COPY_HUNT };
  delete process.env.ECHO_PRESENTER_KEY;
  process.env.ECHO_COPY_HUNT = "1";
  const analyzeRoute = load("../src/app/api/analyze/route.ts");
  const copyHuntRoute = load("../src/app/api/copy-hunt/route.ts");
  const { PRESENTER_COOKIE, presenterToken } = load("../src/lib/echo/presenter.ts");
  // A body sent in 64 KB chunks with no Content-Length; `pulled` counts what the route asked for.
  const chunked = (path, totalBytes, headers = {}) => {
    const chunk = new TextEncoder().encode(`{"claim":"${"x".repeat(65_536 - 11)}"}`.slice(0, 65_536));
    let sent = 0;
    const state = { pulled: 0 };
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= totalBytes) return controller.close();
        sent += chunk.byteLength;
        state.pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return { state, request: new Request(`http://echo.test${path}`, { method: "POST", body, duplex: "half", headers: { "content-type": "application/json", ...headers } }) };
  };
  const huge = chunked("/api/analyze", 64 * 1024 * 1024);
  assert.equal(huge.request.headers.get("content-length"), null, "the probe sends no Content-Length");
  const hugeResponse = await analyzeRoute.POST(huge.request);
  assert.equal(hugeResponse.status, 413, "a chunked 64 MB analyze body is refused");
  assert.equal((await hugeResponse.json()).code, "REQUEST_TOO_LARGE");
  assert.ok(huge.state.pulled <= 256 * 1024, `the analyze route stops reading soon after 8 KB (read ${huge.state.pulled} bytes)`);
  const hugeTrace = chunked("/api/copy-hunt", 64 * 1024 * 1024);
  const hugeTraceResponse = await copyHuntRoute.POST(hugeTrace.request);
  assert.equal(hugeTraceResponse.status, 413, "a chunked 64 MB copy-hunt body is refused");
  assert.equal((await hugeTraceResponse.json()).code, "TRACE_TOO_LARGE");
  assert.ok(hugeTrace.state.pulled <= 3 * 1024 * 1024, `the copy-hunt route stops reading soon after 2 MB (read ${hugeTrace.state.pulled} bytes)`);
  // Small bodies still reach validation, and multi-byte text is counted in bytes, not characters.
  const small = (path, text) => new Request(`http://echo.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: text });
  assert.equal((await (await analyzeRoute.POST(small("/api/analyze", JSON.stringify({ claim: 5 })))).json()).code, "CLAIM_REQUIRED");
  assert.equal((await analyzeRoute.POST(small("/api/analyze", "not json"))).status, 400);
  assert.equal((await analyzeRoute.POST(small("/api/analyze", JSON.stringify({ claim: "é".repeat(5000) })))).status, 413, "8 KB is counted in bytes");
  assert.equal((await (await copyHuntRoute.POST(small("/api/copy-hunt", JSON.stringify({ trace: null })))).json()).code, "INVALID_TRACE");
  // A web page the presenter visits may POST a form or text/plain body to Echo without asking the server first (a CORS
  // "simple" request), and that body can be valid JSON. Only application/json needs a preflight, which Echo never
  // grants, so paid routes take JSON only: no other site can start a run on a local or unlocked Echo.
  {
    const saved = { anthropic: process.env.ANTHROPIC_API_KEY, tavily: process.env.TAVILY_API_KEY, fetch: globalThis.fetch };
    process.env.ANTHROPIC_API_KEY = "";
    process.env.TAVILY_API_KEY = "";
    let providerCalls = 0;
    globalThis.fetch = async () => { providerCalls += 1; throw new Error("no network in this check"); };
    const formBody = '{"claim":"Americans check their phones 96 times a day","forceFresh":true,"x":"="}';
    for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", null]) {
      for (const [route, routePath] of [[analyzeRoute, "/api/analyze"], [copyHuntRoute, "/api/copy-hunt"]]) {
        const request = new Request(`http://echo.test${routePath}`, { method: "POST", body: formBody });
        if (type === null) request.headers.delete("content-type"); else request.headers.set("content-type", type);
        const response = await route.POST(request);
        if (response.status !== 415) await response.body?.cancel();
        assert.equal(response.status, 415, `${routePath} refuses a ${type ?? "missing"} content type`);
        assert.equal((await response.json()).code, "JSON_REQUIRED");
      }
    }
    assert.equal(providerCalls, 0, "a refused cross-site body reaches no provider");
    for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON"]) {
      const request = new Request("http://echo.test/api/analyze", { method: "POST", headers: { "content-type": type }, body: JSON.stringify({ claim: 5 }) });
      assert.equal((await (await analyzeRoute.POST(request)).json()).code, "CLAIM_REQUIRED", `${type} is read`);
    }
    if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.anthropic;
    if (saved.tavily === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = saved.tavily;
    globalThis.fetch = saved.fetch;
  }
  // With the presenter lock on, a visitor is refused before any of the body is read.
  process.env.ECHO_PRESENTER_KEY = "stage-key-2026";
  const locked = chunked("/api/analyze", 64 * 1024 * 1024);
  assert.equal((await analyzeRoute.POST(locked.request)).status, 403, "the presenter check comes first");
  assert.equal(locked.state.pulled <= 65_536, true, "a locked-out request's body is not read");
  const lockedHunt = chunked("/api/copy-hunt", 64 * 1024 * 1024);
  assert.equal((await copyHuntRoute.POST(lockedHunt.request)).status, 403);
  const lockedSources = new Request("http://echo.test/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claim: "Americans check their phones 96 times a day", urls: ["https://a.example/x"] }) });
  assert.equal((await analyzeRoute.POST(lockedSources)).status, 403, "a supplied-sources run is presenter-locked too");
  const presenter = chunked("/api/analyze", 64 * 1024 * 1024, { cookie: `${PRESENTER_COOKIE}=${presenterToken("stage-key-2026")}` });
  assert.equal((await analyzeRoute.POST(presenter.request)).status, 413, "the presenter's oversized body is still refused");
  // Explore gallery: a card's label check must be the trace page's (by run, not by file name) and must not leave
  // out the wrong calls or that some pages have no label.
  {
    const { bundledCards, savedCheckCard, scoreSentence } = load("../src/app/explore/cards.ts");
    const { DEMO_SCORES } = load("../src/lib/echo/demo-scores.ts");
    const readTrace = (publicPath) => fs.promises.readFile(path.join(projectRoot, "public", publicPath), "utf8");
    const cards = await bundledCards(readTrace);
    assert.equal(cards.length, 4, "every bundled run has a card");
    for (const card of cards) {
      const score = DEMO_SCORES[card.trace];
      const sentence = scoreSentence(card.analysis, score);
      assert.match(sentence, /^AI-made labels for /, `${card.trace}: the label check says the labels are AI-made`);
      assert.ok(sentence.includes(`${score.settledMistakes} wrong`) && sentence.includes(`${score.abstentions} left unclear`), `${card.trace}: wrong calls and unclear pages are shown, not only matches`);
      if (score.matched < card.analysis.summary.totalPages) assert.ok(sentence.includes(`${score.matched} of its ${card.analysis.summary.totalPages} pages`), `${card.trace}: unlabelled pages are not counted as agreeing`);
      assert.equal(scoreSentence({ ...card.analysis, createdAt: "2026-11-14T00:00:00.000Z" }, score), "", `${card.trace}: a replaced run does not inherit the old run's score`);
    }
    const heat = cards.find((card) => card.trace.includes("body-heat"));
    assert.equal(scoreSentence(heat.analysis, DEMO_SCORES[heat.trace]), "AI-made labels for 15 of its 18 pages: 10 match Echo, 2 wrong calls, 3 left unclear.");
    const partial = await bundledCards(async (publicPath) => (publicPath.includes("goldfish") ? Promise.reject(new Error("ENOENT")) : publicPath.includes("body-heat") ? "{not json" : readTrace(publicPath)));
    assert.deepEqual(partial.map((card) => card.link), ["/?slot=01", "/?slot=02"], "a missing or invalid trace is left out, never shown as a broken card");
    // The saved Check these sources run has its own card (supplied links, no echo rate); a missing or search-only
    // file gives no card rather than a broken one.
    const check = await savedCheckCard(readTrace);
    assert.equal(check?.link, "/?trace=check-these-sources-phones", "the saved check has a card that opens it");
    assert.ok(check.analysis.sourceCheck?.urls.length > 0, "the saved check card is a supplied-links run");
    assert.equal(await savedCheckCard(async () => Promise.reject(new Error("ENOENT"))), null, "a missing saved check gives no card");
    assert.equal(await savedCheckCard(async () => readTrace("/demo-traces/americans-check-phones-96-times.echo.json")), null, "a search trace is never shown as the saved check");
  }
  Module._resolveFilename = resolveFilename;
  if (savedEnv.key === undefined) delete process.env.ECHO_PRESENTER_KEY; else process.env.ECHO_PRESENTER_KEY = savedEnv.key;
  if (savedEnv.hunt === undefined) delete process.env.ECHO_COPY_HUNT; else process.env.ECHO_COPY_HUNT = savedEnv.hunt;
}
const { statedNumbers, answerNumberGrounding } = load("../src/lib/echo/grounding.ts");
assert.deepEqual(statedNumbers("About 90 percent fail, 4,000 firms, 1.5 years, and ten percent more in 2019; one study.").map((n) => `${n.value}${n.percent ? "%" : ""}`), ["90%", "4000", "1.5", "10%", "2019"]);
assert.deepEqual(statedNumbers("They check ninety-six times a day; forty two percent agree.").map((n) => `${n.value}${n.percent ? "%" : ""}`), ["96", "42%"], "compound number words are read as their figures");
const groundingPages = [{ id: "g-1", title: "Report", domain: "report.example", url: "https://report.example/a", publishedDate: null, text: "The survey of 4,000 companies found 90% closed within ten years.", judgment: { kind: "origin", parentId: null, confidence: 0, evidence: "fixture" } }];
const grounding = answerNumberGrounding({ pages: groundingPages, answerStatements: [
  { text: "Ninety percent of 4000 firms closed", sourceIds: ["g-1"] },
  { text: "Most closed within 3 years, or 75%", sourceIds: ["g-1"] },
  { text: "The figure is 90", sourceIds: ["missing"] },
] });
assert.deepEqual(grounding.map((entry) => entry.unmatchedNumbers), [[], ["3", "75%"], ["90"]], "numbers absent from cited passages are flagged");
assert.deepEqual(answerNumberGrounding({ pages: [{ ...groundingPages[0], publishedDate: "2022-04-22", publishedDateSource: "page metadata" }], answerStatements: [{ text: "A 2022 survey replaced it", sourceIds: ["g-1"] }] })[0].unmatchedNumbers, [], "a cited page's publication year counts as stated");
// Bug round 6 (11/14): only a year the page itself gives counts. A search engine's estimate (often a crawl or last-edit
// date) or a date with no recorded source is not something the cited page states, so "A 2022 survey" stays flagged.
for (const publishedDateSource of ["Tavily estimate", undefined]) {
  assert.deepEqual(answerNumberGrounding({ pages: [{ ...groundingPages[0], publishedDate: "2022-04-22", publishedDateSource }], answerStatements: [{ text: "A 2022 survey replaced it", sourceIds: ["g-1"] }] })[0].unmatchedNumbers, ["2022"], `a ${publishedDateSource ?? "sourceless"} year is not stated by the page`);
}
const scaled = (text, pageText) => answerNumberGrounding({ pages: [{ ...groundingPages[0], text: pageText }], answerStatements: [{ text, sourceIds: ["g-1"] }] })[0].unmatchedNumbers;
assert.deepEqual(scaled("About 2.5 million users", "The app counted 2,500,000 users."), [], "2.5 million matches 2,500,000");
assert.deepEqual(scaled("About 2,500,000 users", "The app counted 2.5 million users."), [], "2,500,000 matches 2.5 million");
assert.deepEqual(scaled("About 2.5 million users", "The app counted 2.5 million users."), [], "the same scaled figure matches");
assert.deepEqual(scaled("About 3 million users", "The app counted 2,500,000 users."), ["3 million"], "a different scaled figure is still flagged");
// 11/12 round 3: "2.5 million" matched a page's "2.5 billion" through the shared 2.5, so a million/billion slip passed.
assert.deepEqual(scaled("About 2.5 million users", "The app counted 2.5 billion users."), ["2.5 million"], "2.5 million is not a page's 2.5 billion");
assert.deepEqual(scaled("About 2.5 billion users", "The app counted 2.5 million users."), ["2.5 billion"], "2.5 billion is not a page's 2.5 million");
assert.deepEqual(scaled("About 2.5 million users", "The app counted 2.5m users."), [], "a figure written without its scale word still matches");
assert.deepEqual(statedNumbers("1.2 billion views and 40 thousand").map((n) => n.value), ["1200000000", "40000"]);
const groundedAudit = auditTrace({ ...analysis, answerStatus: "generated", pages: [...analysis.pages, ...groundingPages], answerStatements: [{ text: "Most closed within 3 years", sourceIds: ["g-1"] }] });
assert.equal(groundedAudit.answerNumbersChecked, 1);
assert.deepEqual(groundedAudit.answerNumbersUnmatched, [{ statementIndex: 0, number: "3" }]);
assert.ok(groundedAudit.notes.some((note) => note.includes("did not appear in the cited passages")));
const unavailable = auditTrace({ ...analysis, answerStatus: "unavailable" });
assert.ok(unavailable.notes.some((note) => note.includes("Answer synthesis was unavailable")));
const manyRoots = Array.from({ length: 14 }, (_, index) => ({ id: `root-${index + 1}`, domain: "example.org", extractionSource: "Tavily extraction", publishedDate: "2020-01-01", publishedDateSource: "page text", primaryEvidenceStatus: "found", judgment: { kind: "origin" } }));
const limitedAudit = auditTrace({ ...analysis, mode: "live", pages: manyRoots, roots: manyRoots.map((page) => page.id), answerSourceIds: [manyRoots[0].id], answerStatus: "generated" });
assert.equal(limitedAudit.rootsOmittedFromAnswer, 2);
assert.equal(limitedAudit.suppliedRootsNotCited, 11);
assert.ok(audit.notes.some((note) => note.includes("synthetic rehearsal")));

// Echo-spread timeline layout: no page hidden without a count, and an axis a reader can use whatever the span.
{
  const { spreadLayout } = load("../src/app/trace-view.ts");
  const dot = (id, publishedDate, kind = "unclear") => ({ id, title: id, domain: "example.org", url: "https://example.org", publishedDate, publishedDateSource: "page text", text: "", hasPrimaryEvidence: false, judgment: { kind, parentId: null, confidence: 50, evidence: "" } });
  const crowded = spreadLayout([...Array.from({ length: 10 }, (_, index) => dot(`same-${index}`, "2021-05-22")), dot("later", "2024-01-01")], 1000);
  const spots = new Map();
  for (const entry of crowded.placed) spots.set(`${entry.x},${entry.y}`, (spots.get(`${entry.x},${entry.y}`) ?? 0) + 1);
  const hiddenUnder = [...spots.values()].reduce((total, count) => total + count - 1, 0);
  assert.equal(crowded.overflow.reduce((total, entry) => total + entry.count, 0), hiddenUnder, "every page drawn under another is counted in a +N badge");
  assert.equal(hiddenUnder, 6, "ten pages on one day: four stacked, six counted");
  const week = spreadLayout(Array.from({ length: 6 }, (_, index) => dot(`w-${index}`, `2021-05-${10 + index}`)), 1000);
  assert.ok(week.ticks.length >= 2 && week.ticks.every((tick) => /^May \d+$/.test(tick.label)), `a one-week trace is labelled by day (${week.ticks.map((tick) => tick.label)})`);
  const oneDay = spreadLayout([dot("a", "2021-05-22", "origin"), dot("b", "2021-05-22")], 1000);
  assert.deepEqual(oneDay.ticks.map((tick) => tick.label), ["May 22"], "a one-day trace names its day");
  assert.ok(oneDay.placed[0].x > 400 && oneDay.placed[0].x < 600, "a one-day trace is drawn mid-chart, not against the left edge");
  const months = spreadLayout([dot("a", "2020-11-02"), dot("b", "2021-08-20")], 1000);
  assert.ok(months.ticks.some((tick) => tick.label === "2021") && months.ticks.some((tick) => tick.label === "Mar"), `a ten-month trace is labelled by month (${months.ticks.map((tick) => tick.label)})`);
  for (const [years, width] of [[300, 1000], [40, 340], [12, 340]]) {
    const wide = spreadLayout([dot("a", `${2020 - years}-01-05`), dot("b", "2020-06-01")], width);
    const gaps = wide.ticks.slice(1).map((tick, index) => tick.x - wide.ticks[index].x);
    assert.ok(wide.ticks.length >= 2 && gaps.every((gap) => gap >= 50), `${years} years at ${width} wide: tick labels do not crowd (${wide.ticks.map((tick) => tick.label)})`);
    assert.ok(wide.ticks.every((tick) => tick.x >= wide.left && tick.x <= width - wide.right), "ticks stay on the axis");
  }
}

// A year- or month-only page date is not a precise day: it wins "earliest" only when even its last day is earlier.
{
  const { datedSpanOf, lastDayOf, pageDateLabel } = load("../src/app/trace-view.ts");
  const page = (id, publishedDate) => ({ id, title: id, domain: `${id}.example`, url: `https://${id}.example/`, publishedDate, publishedDateSource: "page text", text: "", hasPrimaryEvidence: false, judgment: { kind: "unclear", parentId: null, confidence: 50, evidence: "" } });
  // A later page in another year keeps the span open, so datedSpanOf names a first page.
  const firstOf = (...dates) => datedSpanOf({ pages: [...dates.map((date, index) => page(`p${index}`, date)), page("later", "2022-01-01")] })?.first.publishedDate;
  assert.equal(firstOf("2019", "2019-05-03"), "2019-05-03", "\"2019\" may be December: May 3, 2019 is the earliest page");
  assert.equal(firstOf("2018", "2019-05-03"), "2018", "\"2018\" is surely earlier than May 3, 2019");
  assert.equal(firstOf("2019-05", "2019-05-31"), "2019-05-31", "a month and its last day tie: the precise day wins");
  assert.equal(firstOf("2019-04", "2019-05-02"), "2019-04", "April 2019 is surely earlier than May 2, 2019");
  assert.equal(new Date(lastDayOf("2019-02") * 86_400_000).toISOString().slice(0, 10), "2019-02-28", "February 2019's last day is the 28th");
  assert.equal(pageDateLabel("2019"), "2019 (year only)");
  assert.equal(pageDateLabel("2019-05"), "May 2019 (month only)");
  assert.equal(pageDateLabel("2019-05-03"), "2019-05-03", "a full date is shown as given");
}

// The plain-search line: what the claim's own first search returned, and where Echo traces those pages. Checked on
// the four bundled real traces against an independent recount, and on odd but valid synthetic traces.
{
  const { plainSearchLineage } = load("../src/app/trace-view.ts");
  // The recount: a kept page is a root, a copy whose confirmed (solid) parents lead to a root, or unclear (a dashed or
  // unclear link, a missing parent, or a loop anywhere up its chain). Co-published roots are one origin.
  const recount = (analysis) => {
    const first = analysis.searchAudit?.[0];
    if (analysis.mode !== "live" || first?.status !== "searched" || !(first.totalResults > 0)) return null;
    const byId = Object.fromEntries(analysis.pages.map((page) => [page.id, page]));
    const kept = [...new Set(first.pageIds ?? [])].filter((id) => byId[id]);
    if (!kept.length) return null;
    const rootOf = (id, path = []) => {
      const page = byId[id];
      if (!page || path.includes(id)) return null;
      if (page.judgment.kind === "origin") return id;
      return page.judgment.kind === "derived" && page.judgment.parentId ? rootOf(page.judgment.parentId, [...path, id]) : null;
    };
    const originKey = (id) => (analysis.coPublishedRootGroups ?? []).find((group) => group.includes(id))?.slice().sort().join("+") ?? id;
    const tally = { origins: new Set(), verifiable: new Set(), rootPages: 0, copies: 0, unclear: 0 };
    for (const id of kept) {
      const root = rootOf(id);
      if (!root) { tally.unclear += 1; continue; }
      tally.origins.add(originKey(root));
      if (analysis.verifiableRoots.includes(root)) tally.verifiable.add(originKey(root));
      if (root === id) tally.rootPages += 1; else tally.copies += 1;
    }
    return { query: first.query, returned: first.totalResults, kept: kept.length, origins: tally.origins.size, traceOrigins: analysis.summary.independentOrigins, verifiable: tally.verifiable.size, rootPages: tally.rootPages, copies: tally.copies, unclear: tally.unclear };
  };
  const invariants = (lineage, analysis, label) => {
    const first = analysis.searchAudit[0];
    assert.equal(lineage.rootPages + lineage.copies + lineage.unclear, lineage.kept, `${label}: every kept page is a root, a copy or unclear`);
    assert.ok(lineage.origins <= lineage.traceOrigins, `${label}: the plain search never leads to more origins than the trace has`);
    assert.ok(lineage.verifiable <= lineage.origins, `${label}: origins with primary evidence are a subset`);
    assert.ok(lineage.origins <= lineage.rootPages + lineage.copies, `${label}: each origin is reached by a kept page`);
    assert.ok(lineage.kept <= first.matchingResults && first.matchingResults <= lineage.returned, `${label}: kept ≤ matching ≤ returned`);
    const firstIds = new Set(first.pageIds);
    assert.ok(lineage.kept <= firstIds.size, `${label}: only pages the first query returned are counted`);
  };
  // returned / kept / origins (whole trace) / with primary evidence / root pages / copies / unclear, read off each file.
  const expected = {
    "humans-use-10-percent-of-brain": [10, 10, 4, 8, 0, 4, 2, 4],
    "americans-check-phones-96-times": [10, 5, 1, 2, 1, 2, 2, 1],
    "goldfish-3-second-memory": [10, 8, 3, 4, 1, 3, 1, 4],
    "lose-most-body-heat-through-head": [10, 10, 2, 4, 1, 2, 1, 7],
  };
  const traceDir = path.join(projectRoot, "public/demo-traces");
  // The saved Check these sources run read 5 supplied links and searched nothing, so it has no plain-search line.
  const isSourceCheck = (file) => Boolean(JSON.parse(fs.readFileSync(path.join(traceDir, file), "utf8")).analysis.sourceCheck);
  const bundledFiles = fs.readdirSync(traceDir).filter((file) => file.endsWith(".echo.json"));
  const bundled = bundledFiles.filter((file) => !isSourceCheck(file));
  assert.deepEqual(bundledFiles.filter(isSourceCheck), ["check-these-sources-phones.echo.json"], "one bundled supplied-links run, the saved Check these sources run");
  for (const file of bundledFiles.filter(isSourceCheck)) assert.equal(plainSearchLineage(JSON.parse(fs.readFileSync(path.join(traceDir, file), "utf8")).analysis), null, `${file}: a supplied-links run has no plain-search line`);
  assert.equal(bundled.length, Object.keys(expected).length, "every bundled search trace has expected plain-search numbers");
  for (const file of bundled) {
    const name = file.replace(/\.echo\.json$/, "");
    const trace = JSON.parse(fs.readFileSync(path.join(traceDir, file), "utf8")).analysis;
    const lineage = plainSearchLineage(trace);
    assert.ok(lineage, `${name}: a live trace with a searched first query has a plain-search line`);
    { const expected = recount(trace); assert.deepEqual(expected === null || lineage === null ? lineage : Object.fromEntries(Object.keys(expected).map((key) => [key, lineage[key]])), expected, `${name}: plainSearchLineage agrees with the independent recount (on the recount's fields)`); }
    const [returned, kept, origins, traceOrigins, verifiable, rootPages, copies, unclear] = expected[name];
    assert.deepEqual({ returned, kept, origins, traceOrigins, verifiable, rootPages, copies, unclear }, { returned: lineage.returned, kept: lineage.kept, origins: lineage.origins, traceOrigins: lineage.traceOrigins, verifiable: lineage.verifiable, rootPages: lineage.rootPages, copies: lineage.copies, unclear: lineage.unclear }, `${name}: plain-search numbers`);
    invariants(lineage, trace, name);
  }

  // Synthetic traces. node(id, kind, parentId) builds a page; the first query keeps `kept` and returned `returned`.
  const node = (id, kind, parentId = null) => ({ id, title: id, domain: `${id}.example`, url: `https://${id}.example/`, publishedDate: null, text: "", hasPrimaryEvidence: false, judgment: { kind, parentId, confidence: 60, evidence: "" } });
  const traceOf = (pages, kept, { returned = kept.length, matching = Math.min(returned, kept.length), groups, verifiable = [], status = "searched", mode = "live", audit = true } = {}) => {
    const roots = pages.filter((page) => page.judgment.kind === "origin").map((page) => page.id);
    const independent = new Set(roots.map((id) => groups?.find((group) => group.includes(id))?.join("+") ?? id)).size;
    return {
      mode, claim: "A claim", pages, roots, verifiableRoots: verifiable, ...(groups ? { coPublishedRootGroups: groups } : {}),
      summary: { totalPages: pages.length, independentOrigins: independent, verifiableOrigins: verifiable.length, echoPercentage: 0 },
      ...(audit ? { searchAudit: [{ query: "A claim", depth: "basic", status, totalResults: status === "searched" ? returned : 0, matchingResults: status === "searched" ? matching : 0, uniquePagesAdded: kept.length, pageIds: kept }, { query: "a variant", depth: "basic", status: "searched", totalResults: 10, matchingResults: 3, uniquePagesAdded: 3, pageIds: ["other"] }] } : {}),
    };
  };
  const check = (label, analysis, numbers) => {
    const lineage = plainSearchLineage(analysis);
    { const expected = recount(analysis); assert.deepEqual(expected === null || lineage === null ? lineage : Object.fromEntries(Object.keys(expected).map((key) => [key, lineage[key]])), expected, `${label}: agrees with the independent recount (on the recount's fields)`); }
    if (numbers === null) return assert.equal(lineage, null, `${label}: no plain-search line`);
    for (const [key, value] of Object.entries(numbers)) assert.equal(lineage[key], value, `${label}: ${key}`);
    invariants(lineage, analysis, label);
  };
  const root = node("root", "origin");
  const other = node("other", "origin");
  check("a parent cycle", traceOf([root, other, node("a", "derived", "b"), node("b", "derived", "a")], ["a", "b", "root"]), { origins: 1, rootPages: 1, copies: 0, unclear: 2 });
  check("a self-parent", traceOf([root, other, node("self", "derived", "self")], ["self", "root"]), { origins: 1, copies: 0, unclear: 1 });
  check("a missing parent", traceOf([root, other, node("orphan", "derived", "gone")], ["orphan", "root"]), { origins: 1, copies: 0, unclear: 1 });
  check("a copy with no parent named", traceOf([root, other, node("bare", "derived", null)], ["bare", "root"]), { copies: 0, unclear: 1 });
  // A dashed (unclear) link to a root is not a copy; nor is a solid copy of a page whose own link is dashed.
  check("a dashed link", traceOf([root, other, node("dashed", "unclear", "root"), node("below", "derived", "dashed")], ["dashed", "below"]), { origins: 0, rootPages: 0, copies: 0, unclear: 2 });
  check("a two-step copy", traceOf([root, other, node("mid", "derived", "root"), node("leaf", "derived", "mid")], ["leaf"]), { origins: 1, rootPages: 0, copies: 1, unclear: 0, traceOrigins: 2 });
  const twin = node("twin", "origin");
  check("a co-published group, one member kept", traceOf([root, twin, other], ["twin"], { groups: [["root", "twin"]] }), { origins: 1, rootPages: 1, traceOrigins: 2 });
  check("a co-published group, both kept", traceOf([root, twin, other, node("copy", "derived", "twin")], ["root", "twin", "copy"], { groups: [["root", "twin"]], verifiable: ["root"] }), { origins: 1, verifiable: 1, rootPages: 2, copies: 1 });
  check("kept < matching", traceOf([root, other], ["root"], { returned: 10, matching: 6 }), { returned: 10, kept: 1 });
  check("one result", traceOf([root, other], ["root"], { returned: 1 }), { returned: 1, kept: 1, origins: 1 });
  check("no origin", traceOf([root, other, node("u", "unclear")], ["u"], { returned: 4 }), { origins: 0, verifiable: 0, unclear: 1 });
  check("a kept id twice, and one no longer in the trace", traceOf([root, other], ["root", "root", "dropped"], { returned: 5, matching: 3 }), { kept: 1, rootPages: 1 });
  check("a failed first query", traceOf([root, other], ["root"], { status: "failed" }), null);
  check("a rehearsal", traceOf([root, other], ["root"], { mode: "demo" }), null);
  check("no search audit", traceOf([root, other], ["root"], { audit: false }), null);
  check("none of the first query's pages kept", traceOf([root, other], ["dropped"], { returned: 3, matching: 1 }), null);
}

// Round 5 (11/14): a run that fails after searching carries what it spent (EchoPipelineError.costReceipt, set by
// analyzeClaim); the streamed error event forwards it, and keeps code and message as before. The pipeline is stubbed:
// no provider call.
{
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    return resolveFilename.call(this, request.startsWith("@/") ? path.join(projectRoot, "src", request.slice(2)) : request, ...rest);
  };
  const pipelinePath = load.resolve("../src/lib/echo/pipeline.ts");
  const routePath = load.resolve("../src/app/api/analyze/route.ts");
  const real = { pipeline: load.cache[pipelinePath], route: load.cache[routePath] };
  const realPipeline = load(pipelinePath);
  const { ReceiptDraft } = load("../src/lib/echo/cost-receipt.ts");
  const draft = new ReceiptDraft(0.008);
  draft.tavilyRequest("search", "basic", 0, 1);
  draft.claudeRequest({ step: "grouping", model: "claude-haiku-4-5", inputTokens: 2_000, outputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 0, usd: 0.0035 });
  const receipt = draft.finish();
  let failWith = null;
  const analyzeCalls = [];
  const stub = { ...realPipeline, analyzeClaim: async (...args) => { analyzeCalls.push(args); throw failWith; } };
  load.cache[pipelinePath] = { ...real.pipeline, exports: stub };
  delete load.cache[routePath];
  const savedKey = process.env.ECHO_PRESENTER_KEY;
  delete process.env.ECHO_PRESENTER_KEY;
  try {
    const route = load(routePath);
    const errorEvent = async () => {
      const response = await route.POST(new Request("http://echo.test/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claim: "Goldfish have a 3-second memory" }) }));
      const frame = (await response.text()).split("\n\n").find((entry) => entry.startsWith("event: error"));
      return JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5));
    };
    failWith = Object.assign(new realPipeline.EchoPipelineError("CLAUDE_OVERLOADED", "Claude is busy."), { costReceipt: receipt });
    assert.deepEqual(await errorEvent(), { code: "CLAUDE_OVERLOADED", message: "Claude is busy.", costReceipt: receipt }, "a failed run's error event carries what it spent");
    failWith = new realPipeline.EchoPipelineError("NO_EXTRACTS", "Nothing to read.");
    assert.deepEqual(await errorEvent(), { code: "NO_EXTRACTS", message: "Nothing to read." }, "an error with no receipt keeps the old shape");
    failWith = new Error("boom");
    assert.deepEqual(await errorEvent(), { code: "ANALYSIS_FAILED", message: "Echo could not finish this analysis. Please try again." }, "an unexpected error with no receipt keeps the old shape");
    // Round 5 cost: a provider time limit (Claude's 60 s) throws a DOMException TimeoutError, not an EchoPipelineError.
    // analyzeClaim now puts the receipt on it (non-enumerable, as attachCostReceipt does), and TIMEOUT forwards it.
    const { attachCostReceipt } = load("../src/lib/echo/cost-receipt.ts");
    failWith = new DOMException("The operation timed out.", "TimeoutError");
    attachCostReceipt(failWith, receipt);
    assert.deepEqual(await errorEvent(), { code: "TIMEOUT", message: "A provider request timed out. Try the claim again.", costReceipt: receipt }, "a timed-out run's error event carries what it spent");
    failWith = new DOMException("The operation timed out.", "TimeoutError");
    assert.deepEqual(await errorEvent(), { code: "TIMEOUT", message: "A provider request timed out. Try the claim again." }, "a timeout with no receipt keeps the old shape");
    failWith = new TypeError("fetch failed");
    attachCostReceipt(failWith, receipt);
    assert.deepEqual(await errorEvent(), { code: "ANALYSIS_FAILED", message: "Echo could not finish this analysis. Please try again.", costReceipt: receipt }, "any other failed run's error event carries what it spent");
    failWith = Object.assign(new Error("odd"), { costReceipt: { total: 5 } });
    assert.deepEqual(await errorEvent(), { code: "ANALYSIS_FAILED", message: "Echo could not finish this analysis. Please try again." }, "something that is not a receipt is not forwarded");
    // "Check these sources": urls is checked before the run starts. A bad list is a plain 400 and nothing runs; a good
    // one reaches analyzeClaim canonical and deduplicated; a body without urls is an ordinary search run, as before.
    const post = (body) => route.POST(new Request("http://echo.test/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    analyzeCalls.length = 0;
    for (const urls of [[], "https://a.example/x", ["ftp://a.example/x"], ["http://localhost:3000/"], ["http://10.0.0.5/x"], Array.from({ length: 21 }, (_, index) => `https://n${index}.example/x`), [7]]) {
      const response = await post({ claim: "Americans check their phones 96 times a day", urls });
      assert.equal(response.status, 400, `urls ${JSON.stringify(urls).slice(0, 60)} is refused with a 400`);
      const body = await response.json();
      assert.equal(body.code, "SOURCES_INVALID");
      assert.ok(typeof body.error === "string" && body.error.length > 10, "the refusal says why in plain words");
    }
    assert.equal(analyzeCalls.length, 0, "a refused list starts no analysis");
    assert.equal((await (await post({ claim: 5, urls: ["https://a.example/x"] })).json()).code, "CLAIM_REQUIRED", "the claim is still required");
    failWith = new realPipeline.EchoPipelineError("NO_EXTRACTS", "Nothing to read.");
    await (await post({ claim: "Americans check their phones 96 times a day", urls: ["https://a.example/x?utm_source=chatgpt.com", "https://a.example/x/", "https://b.example/y#top"] })).text();
    assert.deepEqual(analyzeCalls.at(-1)[2].urls, ["https://a.example/x", "https://b.example/y"], "a good list reaches analyzeClaim canonical and deduplicated");
    await (await post({ claim: "Americans check their phones 96 times a day" })).text();
    assert.ok(!("urls" in analyzeCalls.at(-1)[2]), "a body without urls is an ordinary search run");
  } finally {
    load.cache[pipelinePath] = real.pipeline;
    if (real.route) load.cache[routePath] = real.route; else delete load.cache[routePath];
    Module._resolveFilename = resolveFilename;
    if (savedKey === undefined) delete process.env.ECHO_PRESENTER_KEY; else process.env.ECHO_PRESENTER_KEY = savedKey;
  }
}

// "How Echo checked this" (howEchoChecked in src/app/trace-view.ts): the run's steps as counts, from the trace's own
// fields only. Every number below was counted by hand from the JSON (11/14): searches and results from searchAudit
// (status "searched"; totalResults; uniquePagesAdded summed, each page counted by the first search that kept it),
// pages read = pages + excludedPageCount, reliable dates = dates whose source is not "Tavily estimate", copies =
// judgment "derived", answer figures from each statement's numbers (the answer card's per-statement check).
{
  const { howEchoChecked, howEchoCheckedText, stageTimeLabel } = load("../src/app/trace-view.ts");
  const read = (file) => JSON.parse(fs.readFileSync(path.join(projectRoot, file), "utf8")).analysis;
  const expected = {
    "public/demo-traces/americans-check-phones-96-times.echo.json": [
      "Plan: 10 query variants — built from the claim's wording, no model call",
      "Search: 13 searches run (3 deeper) — 124 results · 15 distinct pages found",
      "Read: 15 pages read — 9 with a reliable date · 1 only from its search snippet",
      "Group: 4 claim groups — 13 pages about the claim · 2 off-claim pages excluded",
      "Judge: 2 independent origins — from 3 root pages · 4 confirmed copies (by date or citation) · 6 unclear",
      "Verify: 8 of 8 answer figures — found in the passages they cite",
      "Answer: Written from 2 independent origins — root pages only; copies and unclear pages left out",
    ],
    "public/demo-traces/humans-use-10-percent-of-brain.echo.json": [
      "Plan: 10 query variants — built from the claim's wording, no model call",
      "Search: 5 searches run — 50 results · 20 distinct pages found · 5 variants not run (enough pages found)",
      "Read: 20 pages read — 11 with a reliable date · 3 only from their search snippet",
      "Group: 1 claim group — 20 pages about the claim · none off-claim",
      "Judge: 8 independent origins — 3 confirmed copies (by date or citation) · 9 unclear",
      "Answer: No answer written — none of the 8 independent origins shows evidence of its own, so Echo lists them (no model call)",
    ],
    "public/demo-traces/goldfish-3-second-memory.echo.json": [
      "Plan: 10 query variants — built from the claim's wording, no model call",
      "Search: 13 searches run (3 deeper) — 124 results · 14 distinct pages found",
      "Read: 14 pages read — 8 with a reliable date · 1 only from its search snippet",
      "Group: 4 claim groups — 14 pages about the claim · none off-claim",
      "Judge: 4 independent origins — 1 confirmed copy (by date or citation) · 9 unclear",
      "Verify: No figures to check — the answer states no numbers",
      "Answer: Written from 4 independent origins — cites 1 of them; copies and unclear pages left out",
    ],
    // 21 distinct pages found, 20 read: selectPagesForAnalysis keeps at most 20.
    "public/demo-traces/lose-most-body-heat-through-head.echo.json": [
      "Plan: 9 query variants — built from the claim's wording, no model call",
      "Search: 5 searches run — 50 results · 21 distinct pages found · 4 variants not run (enough pages found)",
      "Read: 20 pages read — of 21 found (at most 20 per run) · 13 with a reliable date · 4 only from their search snippet",
      "Group: 3 claim groups — 18 pages about the claim · 2 off-claim pages excluded",
      "Judge: 4 independent origins — 3 confirmed copies (by date or citation) · 11 unclear",
      "Verify: 5 of 6 answer figures — found in the passages they cite; not found: 40%",
      "Answer: Written from 4 independent origins — cites 3 of them; copies and unclear pages left out",
    ],
    // A Check these sources run: no plan or search, and stage times from its receipt (extract 913 ms, grouping 2502,
    // judgment 7940, answer 2719; the 1 ms "search" is skipped, not timed).
    "scripts/fixtures/sources-phones-live-2026-11-13.echo.json": [
      "Plan · Search: Skipped — read 5 supplied links; no web search",
      "Read: 5 of 5 supplied links read — 5 with a reliable date (0.9 s)",
      "Group: 1 claim group — 5 pages about the claim · none off-claim (2.5 s)",
      "Judge: 1 independent origin — 2 confirmed copies (by date or citation) · 2 unclear (7.9 s)",
      "Verify: 6 of 7 answer figures — found in the passages they cite; not found: 18",
      "Answer: Written from 1 independent origin — root pages only; copies and unclear pages left out (2.7 s)",
    ],
  };
  for (const [file, lines] of Object.entries(expected)) {
    const checked = howEchoChecked(read(file));
    assert.deepEqual(howEchoCheckedText(checked.steps), lines, `${file}: the "How Echo checked this" steps`);
    assert.ok(checked.steps.every((step) => step.note.length > 40), `${file}: every step has a hover note`);
    assert.ok(checked.steps.every((step) => !/candidate roots?|independent roots?|verifiable origins?|primary evidence|veto/i.test(`${step.value} ${step.detail} ${step.note}`)), `${file}: no retired names and no rule-veto count`);
    // QA round 4 D5: Group counts the pages about the claim; Search, which counts another number, never says so (it
    // once read "15 distinct pages kept as about the claim" beside Group's "13 pages about the claim").
    assert.ok(checked.steps.every((step) => !/^(?:Plan · )?Search$/.test(step.step) || !/about the claim/i.test(`${step.value} ${step.detail} ${step.note}`)), `${file}: the Search step does not say "about the claim"`);
  }
  assert.equal(howEchoChecked(read("public/demo-traces/americans-check-phones-96-times.echo.json")).totalMs, undefined, "a trace without a receipt (slot 02's Nov 10 run) shows no stage times");
  assert.equal(howEchoChecked(read("scripts/fixtures/sources-phones-live-2026-11-13.echo.json")).totalMs, 14076);
  assert.equal(stageTimeLabel(14076), "14 s");
  assert.equal(stageTimeLabel(65_400), "1 min 5 s");
  assert.equal(stageTimeLabel(40), "<0.1 s");
  // An older trace without the counts drops those numbers rather than guessing them; a rehearsal has no strip.
  const phones = read("public/demo-traces/americans-check-phones-96-times.echo.json");
  const older = { ...phones, excludedPageCount: undefined, answerStatus: undefined, answerStatements: undefined, searchAudit: phones.searchAudit.map(({ uniquePagesAdded, ...entry }) => (void uniquePagesAdded, entry)) };
  assert.deepEqual(howEchoCheckedText(howEchoChecked(older).steps), [
    "Plan: 10 query variants — built from the claim's wording, no model call",
    "Search: 13 searches run (3 deeper) — 124 results",
    "Read: 13 pages read — 9 with a reliable date · 1 only from its search snippet",
    "Group: 4 claim groups — 13 pages about the claim",
    "Judge: 2 independent origins — from 3 root pages · 4 confirmed copies (by date or citation) · 6 unclear",
  ], "an older trace without excludedPageCount, uniquePagesAdded or answer fields");
  const noAudit = howEchoChecked({ ...phones, searchAudit: undefined });
  assert.deepEqual(noAudit.steps.map((step) => step.step), ["Read", "Group", "Judge", "Verify", "Answer"], "no search audit: no Plan or Search step");
  assert.equal(howEchoChecked({ ...phones, mode: "demo" }), null, "a rehearsal has no strip");
  process.stdout.write("Echo strip passed: \"How Echo checked this\" counts match the four bundled traces and the sources fixture.\n");
}

// The evidence funnel, the run details and the page details (evidenceFunnel, runDetails, pageDetails in
// src/app/trace-view.ts): how much a run processed, from the trace's own fields only. Every number below was counted by
// hand from the JSON (11/14): variants = distinct searchAudit queries; searches = status "searched" (deeper = depth
// "advanced"); search results = their totalResults summed (results, not sources: one page per search it appeared in),
// "mention the claim's terms" = matchingResults summed; distinct pages = uniquePagesAdded summed; pages read = pages +
// excludedPageCount (a sources run: supplied links minus unread); reliable dates = dates not from "Tavily estimate";
// citations = each page's citations of another page in the trace; characters = the saved passages' lengths; Claude
// calls and tokens = the cost receipt's claude entries (input + output + cache tokens).
{
  const { evidenceFunnel, evidenceFunnelText, evidenceFunnelHeadline, runDetails, pageDetails } = load("../src/app/trace-view.ts");
  const read = (file) => JSON.parse(fs.readFileSync(path.join(projectRoot, file), "utf8")).analysis;
  const expected = {
    "public/demo-traces/americans-check-phones-96-times.echo.json": {
      text: "10 query variants (written from the claim) → 13 searches (3 deeper) → 124 search results scanned (56 mention the claim's terms) → 15 distinct pages (each counted once) → 15 pages read (9 with a reliable publisher date) → 4 claim groups (2 off-claim set aside) → 13 pages about the claim (4 confirmed copies · 6 unclear) → 2 independent origins (both with their own evidence)",
      facts: ["Publisher dates: 7 from page metadata, 2 from the URL", "4 citations found between pages", "16,286 characters of page passages saved"],
      headline: "From 124 search results to 2 independent origins",
      summary: ["Tavily", "13 searches", "124 search results", "15 distinct pages", "15 read"],
    },
    "public/demo-traces/humans-use-10-percent-of-brain.echo.json": {
      text: "10 query variants (written from the claim) → 5 searches (5 variants not needed) → 50 search results scanned (43 mention the claim's terms) → 20 distinct pages (each counted once) → 20 pages read (11 with a reliable publisher date) → 1 claim group (none off-claim) → 20 pages about the claim (3 confirmed copies · 9 unclear) → 8 independent origins (none with its own evidence)",
      facts: ["Publisher dates: 7 from page metadata, 3 from the URL, 1 from the page text", "3 citations found between pages", "22,313 characters of page passages saved"],
      headline: "From 50 search results to 8 independent origins",
      summary: ["Tavily", "5 searches", "50 search results", "20 distinct pages", "20 read"],
    },
    "public/demo-traces/goldfish-3-second-memory.echo.json": {
      text: "10 query variants (written from the claim) → 13 searches (3 deeper) → 124 search results scanned (89 mention the claim's terms) → 14 distinct pages (each counted once) → 14 pages read (8 with a reliable publisher date) → 4 claim groups (none off-claim) → 14 pages about the claim (1 confirmed copy · 9 unclear) → 4 independent origins (2 with their own evidence)",
      facts: ["Publisher dates: 6 from page metadata, 2 from the page text", "19,299 characters of page passages saved"],
      headline: "From 124 search results to 4 independent origins",
      summary: ["Tavily", "13 searches", "124 search results", "14 distinct pages", "14 read"],
    },
    // 21 distinct pages found, 20 read: a run reads at most 20.
    "public/demo-traces/lose-most-body-heat-through-head.echo.json": {
      text: "9 query variants (written from the claim) → 5 searches (4 variants not needed) → 50 search results scanned (49 mention the claim's terms) → 21 distinct pages (at most 20 read per run) → 20 pages read (13 with a reliable publisher date) → 3 claim groups (2 off-claim set aside) → 18 pages about the claim (3 confirmed copies · 11 unclear) → 4 independent origins (3 with their own evidence)",
      facts: ["Publisher dates: 12 from page metadata, 1 from the page text", "4 citations found between pages", "19,315 characters of page passages saved"],
      headline: "From 50 search results to 4 independent origins",
      summary: ["Tavily", "5 searches", "50 search results", "21 distinct pages", "20 read"],
    },
    // The saved Check these sources run: no search stages; its receipt adds Claude's calls and tokens (2,425 + 79 +
    // 6,234 + 836 + 1,558 + 371 = 11,503) and the run time (14,284 ms).
    "public/demo-traces/check-these-sources-phones.echo.json": {
      text: "5 supplied links (no web search) → 5 links read (5 with a reliable publisher date) → 1 claim group (none off-claim) → 5 pages about the claim (2 confirmed copies · 1 unclear) → 3 Claude calls (11,503 tokens) → 1 independent origin (with its own evidence)",
      facts: ["Publisher dates: 3 from page metadata, 2 from the URL", "4 citations found between pages", "7,088 characters of page passages saved", "14 s from start to finish"],
      headline: "From 5 supplied links to 1 independent origin",
      summary: ["no web search", "5 supplied links", "5 read", "3 Claude calls"],
    },
  };
  for (const [file, want] of Object.entries(expected)) {
    const analysis = read(file);
    const funnel = evidenceFunnel(analysis);
    assert.equal(evidenceFunnelText(funnel), want.text, `${file}: the evidence funnel`);
    assert.deepEqual(funnel.facts, want.facts, `${file}: the funnel's facts`);
    assert.equal(evidenceFunnelHeadline(funnel), want.headline, `${file}: the funnel slide's headline`);
    assert.deepEqual(runDetails(analysis).summary, want.summary, `${file}: the run details summary`);
    assert.ok(funnel.stages.every((stage) => stage.note.length > 40), `${file}: every stage has a hover note`);
    // Honesty: search results and pages are never called sources or origins; only the last stage counts origins.
    for (const stage of funnel.stages) {
      const words = `${stage.label} ${stage.detail}`;
      if (stage.key !== "origins") assert.ok(!/\bsources?\b|\borigins?\b/i.test(words), `${file}: the ${stage.key} stage reads "${words}"`);
      assert.ok(!/candidate roots?|independent roots?|verifiable origins?|primary evidence/i.test(`${words} ${stage.note}`), `${file}: no retired names`);
    }
    // The last stage is the trace's own independent-origin count, the verdict's.
    assert.equal(funnel.stages.at(-1).value, analysis.summary.independentOrigins, `${file}: the funnel ends at the verdict's count`);
    // Every page has details, and they name only pages of this trace.
    for (const page of analysis.pages) {
      const rows = pageDetails(analysis, page, analysis.sourceCheck ? 1 : undefined);
      assert.equal(rows[0].lines[0], page.domain, `${file}: ${page.id}'s details start with its site`);
      assert.match(rows.find((row) => row.label === "Text").lines[0], new RegExp(`· ${page.text.length.toLocaleString("en-US")} characters of passage saved$`));
    }
  }
  const phones = read("public/demo-traces/americans-check-phones-96-times.echo.json");
  // The line under the stages says what the first counts mean, from the same counts.
  assert.equal(evidenceFunnel(phones).lead, "Search results are not sources: 124 counts every result of the 13 searches, a page two searches returned counting twice; 15 counts each page once.");
  assert.equal(evidenceFunnel(read("public/demo-traces/check-these-sources-phones.echo.json")).lead, "Echo read only the 5 links supplied, with no web search.");
  // Rows of the phones run's details, as counted above; without a receipt its Claude row says so.
  const rows = Object.fromEntries(runDetails(phones).rows.map((row) => [row.label, row.lines]));
  assert.deepEqual(rows["Searches"], ["13 run · 10 basic, 3 deeper"]);
  assert.deepEqual(rows["Search results scanned"], ["124 (56 mention the claim's terms), counted search by search"]);
  assert.deepEqual(rows["Pages read"], ["15: 13 about the claim, 2 off-claim"]);
  assert.deepEqual(rows["Page text"], ["12 extracted by Tavily · 1 search snippet only", "16,286 characters of passages saved (the part of each page about the claim)"]);
  assert.deepEqual(rows["Publisher dates"], ["9 reliable (7 from page metadata, 2 from the URL) · 1 only a search estimate (not counted) · 3 none found"]);
  assert.deepEqual(rows["Citations between pages"], ["4 (3 by name and year, 1 by title)"]);
  assert.deepEqual(rows["Claude"], ["Calls and tokens not recorded: this trace was saved before Echo kept a cost receipt"]);
  assert.equal(rows["Cost receipt"], undefined, "no receipt, no cost row");
  const check = read("public/demo-traces/check-these-sources-phones.echo.json");
  const checkRows = Object.fromEntries(runDetails(check).rows.map((row) => [row.label, row.lines]));
  assert.deepEqual(checkRows["Claude"], ["claude-sonnet-5-5 · 3 calls (grouping, judgment, answer)", "10,217 input + 1,286 output tokens"]);
  assert.deepEqual(checkRows["Stage times"], ["read 0.6 s · group 2.1 s · judge 7.4 s · answer 4.2 s · total 14 s"]);
  assert.equal(checkRows["Search router"], undefined, "a sources run names no search router");
  // Page details: asurion.com on slot 02 (its date, its text, the search that first found it).
  const asurion = phones.pages.find((page) => page.domain === "asurion.com" && page.judgment.kind === "origin" && page.publishedDate === "2019-11-21");
  const asurionRows = Object.fromEntries(pageDetails(phones, asurion).map((row) => [row.label, row.lines]));
  assert.equal(asurionRows["Publisher date"][0], "Nov 21, 2019 · from page metadata");
  assert.equal(asurionRows["First found by"][0], `Search 1 of 13: “${phones.searchAudit[0].query}”`);
  assert.deepEqual(asurionRows["Own evidence"], ["Found in its passage"]);
  // A Telem run: the searches say so, the engines that answered are named (fact, run details and the page's details),
  // and the receipt's Claude calls join the funnel. Built from the phones run: every search answered by Exa, Tavily
  // and Brave, Brave only on the deeper ones, and each kept page returned by Exa.
  const telem = structuredClone(phones);
  telem.searchAudit = telem.searchAudit.map((entry) => ({
    ...entry, router: "telem", providers: entry.depth === "advanced" ? ["exa", "tavily", "brave"] : ["exa", "tavily"],
    pageProviders: Object.fromEntries((entry.pageIds ?? []).map((id) => [id, entry.depth === "advanced" ? ["exa", "brave"] : ["exa"]])),
  }));
  telem.costReceipt = structuredClone(check.costReceipt);
  telem.costReceipt.telem = { searches: 13, advancedSearches: 3, providerRuns: { exa: 13, tavily: 13, brave: 3 } };
  telem.costReceipt.usd.telem = 0.3;
  const telemFunnel = evidenceFunnel(telem);
  assert.equal(telemFunnel.stages.find((stage) => stage.key === "searches").detail, "3 deeper · via Telem");
  assert.match(telemFunnel.stages.find((stage) => stage.key === "results").note, /within one search, a page several engines returned counts once/);
  assert.deepEqual(telemFunnel.stages.map((stage) => stage.key), ["variants", "searches", "results", "distinct", "read", "groups", "about", "calls", "origins"]);
  assert.equal(telemFunnel.facts[0], "Search engines (via Telem): Exa, Tavily and Brave");
  const telemRows = Object.fromEntries(runDetails(telem).rows.map((row) => [row.label, row.lines]));
  assert.equal(telemRows["Search engines"][0], "Exa: answered 13 of the 13 searches; returned 13 pages of the 13 kept");
  assert.equal(telemRows["Search engines"][2], `Brave: answered 3 of the 13 searches; returned ${telem.searchAudit.filter((entry) => entry.depth === "advanced").flatMap((entry) => entry.pageIds ?? []).length} pages of the 13 kept`);
  assert.deepEqual(telemRows["Engine runs billed"], ["Exa 13 · Tavily 13 · Brave 3"]);
  const telemAsurion = Object.fromEntries(pageDetails(telem, asurion).map((row) => [row.label, row.lines]));
  assert.deepEqual(telemAsurion["First found by"], [`Search 1 of 13: “${phones.searchAudit[0].query}”`, "Returned by Exa (via Telem)"]);
  // An older trace: no search audit gives no search stages (kind "pages"); no uniquePagesAdded drops "distinct pages";
  // a rehearsal has no funnel and no run details.
  const noAudit = evidenceFunnel({ ...phones, searchAudit: undefined });
  assert.equal(noAudit.kind, "pages");
  assert.equal(evidenceFunnelHeadline(noAudit), "From 15 pages read to 2 independent origins");
  const noUnique = evidenceFunnel({ ...phones, searchAudit: phones.searchAudit.map(({ uniquePagesAdded, ...entry }) => (void uniquePagesAdded, entry)) });
  assert.deepEqual(noUnique.stages.map((stage) => stage.key), ["variants", "searches", "results", "read", "groups", "about", "origins"]);
  assert.equal(evidenceFunnel({ ...phones, mode: "demo" }), null, "a rehearsal has no funnel");
  assert.equal(runDetails({ ...phones, mode: "demo" }), null, "a rehearsal has no run details");
  process.stdout.write("Echo funnel passed: the evidence funnel, run details and page details match the five bundled traces by hand count; Telem and older traces too.\n");
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-audit-check-"));
try {
  const traceFile = path.join(tempDir, "rehearsal.echo.json");
  fs.writeFileSync(traceFile, JSON.stringify(makePortableTrace(analysis)));
  const output = execFileSync(process.execPath, ["scripts/audit-trace.mjs", traceFile, "--json"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), audit);
  process.stdout.write("Echo audit passed: portable trace loads locally and reports coverage limits without provider calls.\n");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
