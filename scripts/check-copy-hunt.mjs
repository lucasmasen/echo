import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const load = createRequire(import.meta.url);
load.extensions[".ts"] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(code, filename);
};
const { copyFingerprints, defaultCopyHuntRoot, matchCopyCandidates, runCopyHunt, copyHuntEnabled } = load("../src/lib/echo/copy-hunt.ts");
const { makePortableTrace, parsePortableTrace } = load("../src/lib/echo/portable.ts");
const readTrace = (name) => parsePortableTrace(JSON.parse(fs.readFileSync(new URL(`../public/demo-traces/${name}.echo.json`, import.meta.url), "utf8")));

const phones = readTrace("americans-check-phones-96-times");
const brain = readTrace("humans-use-10-percent-of-brain");
assert.ok(phones && brain);
delete process.env.ECHO_COPY_HUNT;
assert.equal(copyHuntEnabled(), false, "copy hunt is off unless ECHO_COPY_HUNT=1");

// Fingerprints come from wording the confirmed copies reused, never from the claim itself.
const rootId = defaultCopyHuntRoot(phones);
assert.ok(phones.roots.includes(rootId));
const phrases = copyFingerprints(phones, rootId);
assert.ok(phrases.length >= 1 && phrases.length <= 3);
assert.ok(phrases.every((phrase) => !/96 times a day/i.test(phrase)), "claim restatements are not fingerprints");
const root = phones.pages.find((page) => page.id === rootId);
assert.ok(phrases.every((phrase) => root.text.toLowerCase().replace(/[“”"]/g, "").includes(phrase.toLowerCase().split(" ")[0])));
const noCopies = structuredClone(brain);
for (const page of noCopies.pages) if (page.judgment.kind === "derived") page.judgment = { ...page.judgment, kind: "unclear", parentId: null };
assert.equal(defaultCopyHuntRoot(noCopies), null, "a trace with no confirmed copies has nothing to fingerprint");
await assert.rejects(runCopyHunt(noCopies, { search: async () => [], fetchPage: async () => null }), /confirmed copy/);
assert.ok(defaultCopyHuntRoot(brain), "the brain demo (Scientific American copied 3 times) has a root to hunt from");

// No Tavily key: copy hunt says it needs that key alone (it makes no Claude calls), not the live run's two-key message.
{
  const saved = { tavily: process.env.TAVILY_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
  delete process.env.TAVILY_API_KEY;
  process.env.ANTHROPIC_API_KEY = "check-copy-hunt-placeholder";
  try {
    await assert.rejects(runCopyHunt(phones, { metadata: async () => null, fetchPage: async () => null }), (error) => {
      assert.equal(error.code, "MISSING_KEYS");
      assert.match(error.message, /TAVILY_API_KEY/);
      assert.doesNotMatch(error.message, /ANTHROPIC_API_KEY|demo presets/);
      return true;
    });
  } finally {
    if (saved.tavily === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = saved.tavily;
    if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.anthropic;
  }
}

// Matching: new pages only, verbatim phrase required, known trace URLs skipped.
const known = phones.pages[0].url;
const results = [
  { url: known, title: "Already in trace", content: phrases[0] },
  { url: "https://wfla.example/2021/09/28/phones", title: "WFLA", content: `Survey: ${phrases[0]} and more.`, published_date: "2021-09-28" },
  { url: "https://wfla.example/2021/09/28/phones?utm_source=x", title: "WFLA dup", content: phrases[0] },
  { url: "https://unrelated.example/post", title: "Phones", content: "People use phones a lot." },
  { url: "https://old.example/2018/01/01/story", title: "Older", content: phrases[0] },
  { url: "javascript:alert(1)", title: "bad", content: phrases[0] },
];
const { matches } = matchCopyCandidates(phones, [{ phrase: phrases[0], results }]);
assert.deepEqual(matches.map((match) => match.url).sort(), ["https://old.example/2018/01/01/story", "https://wfla.example/2021/09/28/phones"]);

// Full run with a fake search: no network, no spending; dates and timing are set; result round-trips.
let searches = 0;
const laterOnly = [
  { url: "https://wfla.example/2021/09/28/phones", title: "WFLA", content: `Survey: ${phrases[0]} and more.`, published_date: "2021-09-28" },
  { url: "https://kfox.example/2021/09/29/phones", title: "KFOX", content: `Also ${phrases[0]}.` },
];
const rootDomain = phones.pages.find((page) => page.id === rootId).domain;
const hunt = await runCopyHunt(phones, {
  search: async (phrase) => { searches += 1; return phrase === phrases[0] ? [...laterOnly, { url: `https://${rootDomain}/other-copy-of-release`, title: "Release", content: phrases[0] }] : []; },
  metadata: async () => null, fetchPage: async () => null,
});
assert.equal(searches, phrases.length);
assert.equal(hunt.rootId, rootId);
const byUrl = new Map(hunt.candidates.map((candidate) => [candidate.url, candidate]));
assert.equal(byUrl.get("https://wfla.example/2021/09/28/phones").timing, "after root");
assert.equal(byUrl.get("https://kfox.example/2021/09/29/phones").timing, "after root", "a date in the URL is used");
assert.ok(!hunt.candidates.some((candidate) => candidate.domain === rootDomain), "the original's own site is not listed as a copy");
assert.equal(hunt.commonPhrases, undefined);

// A phrase also found on a page dated before the original is ordinary wording: candidates matched only by it drop out.
const withOld = await runCopyHunt(phones, {
  search: async (phrase) => phrase === phrases[0] ? results : phrase === phrases[1] ? [{ url: "https://wfla.example/2021/09/28/phones", title: "WFLA", content: phrases[1], published_date: "2021-09-28" }] : [],
  metadata: async () => null, fetchPage: async () => null,
});
assert.deepEqual(withOld.commonPhrases, [phrases[0]]);
assert.deepEqual(withOld.candidates.map((candidate) => candidate.url), ["https://wfla.example/2021/09/28/phones"], "only pages with distinctive wording remain");
const withHunt = { ...phones, copyHunt: hunt };
const imported = parsePortableTrace(makePortableTrace(withHunt));
assert.deepEqual(imported?.copyHunt, hunt, "copy hunt results survive save and open");
assert.equal(imported.summary.echoPercentage, phones.summary.echoPercentage, "copy hunt never changes the counts");

// Full-page check: a phrase missing from the snippet but present in the fetched page counts, and the page's own
// publisher date is used. Pages that fail to load are skipped. Known trace pages are never fetched.
const fetched = [];
const pageHunt = await runCopyHunt(phones, {
  search: async (phrase) => phrase === phrases[1] ? [
    { url: "https://kxan.example/news/phones", title: "Station repost", content: "Survey says people check phones a lot." },
    { url: "https://down.example/story", title: "Unreachable", content: "Phones." },
    { url: phones.pages[1].url, title: "Known", content: "x" },
  ] : [],
  metadata: async () => null,
  fetchPage: async (url) => {
    fetched.push(url);
    if (url.includes("down.example")) return null;
    return { text: `<p>Young adults ${phrases[1]}, the survey found.</p>`, date: { date: "2021-09-29", field: "article:published_time meta tag" } };
  },
});
assert.ok(!fetched.some((url) => url === phones.pages[1].url), "pages already in the trace are not fetched");
assert.equal(pageHunt.candidates.length, 1);
assert.equal(pageHunt.candidates[0].foundIn, "full page");
assert.equal(pageHunt.candidates[0].publishedDate, "2021-09-29");
assert.equal(pageHunt.candidates[0].timing, "after root");
assert.equal(pageHunt.pagesChecked, 1);
assert.deepEqual(parsePortableTrace(makePortableTrace({ ...phones, copyHunt: pageHunt }))?.copyHunt, pageHunt, "full-page results round-trip");
const { fetchPageForPhrases, pageTextForPhrases } = load("../src/lib/echo/copy-hunt.ts");
// A fetched page of unclosed <script> tags made the lazy strip expression rescan to the end at every tag.
let started = Date.now();
pageTextForPhrases("<script>x".repeat(160_000));
assert.ok(Date.now() - started < 500, `a 1.5 MB page of unclosed script tags is read quickly (${Date.now() - started} ms)`);
started = Date.now();
pageTextForPhrases("<p>start</p>" + "<a".repeat(750_000));
assert.ok(Date.now() - started < 500, `a 1.5 MB page of '<' without '>' is read quickly (${Date.now() - started} ms)`);
assert.equal(pageTextForPhrases("<p>a</p> 3 < 4 and <b>bold</b> x < y").replace(/\s+/g, " ").trim(), "a 3 < 4 and bold x < y", "tags are removed; a '<' that starts no tag (before a space or digit) stays as text, as a browser shows it");
assert.equal(pageTextForPhrases("<p>Kept</p><script>var x = '<b>';</script><STYLE>p{}</STYLE><noscript>no</noscript> &amp; more").replace(/\s+/g, " ").trim(), "Kept & more", "scripts, styles and noscript blocks are dropped and tags removed");
assert.equal(pageTextForPhrases("<script>unclosed <b>text</b>").replace(/\s+/g, " ").trim(), "unclosed text", "an unclosed script keeps its text, as before");
assert.equal(await fetchPageForPhrases("http://127.0.0.1/admin"), null, "private addresses are never fetched");
assert.equal(await fetchPageForPhrases("file:///etc/passwd"), null, "only http(s) pages are fetched");

// The import check rejects tampered results.
const bad = (mutate) => { const trace = structuredClone(makePortableTrace(withHunt)); mutate(trace.analysis.copyHunt, trace.analysis); return parsePortableTrace(trace); };
assert.equal(bad((h) => { h.rootId = "page-1"; }), null, "root must be a trace root");
assert.equal(bad((h) => { h.candidates[0].url = "javascript:alert(1)"; }), null, "unsafe links rejected");
assert.equal(bad((h, a) => { h.candidates[0].url = a.pages[0].url; }), null, "a candidate cannot duplicate a trace page");
assert.equal(bad((h) => { h.candidates[0].matchedPhrases = ["invented phrase"]; }), null, "matched phrases must be searched phrases");
assert.equal(bad((h) => { h.candidates[0].timing = "confirmed copy"; }), null, "timing labels are fixed");

// A spending-cap error on the first search stops the hunt and reports it.
const { EchoPipelineError } = load("../src/lib/echo/pipeline.ts");
await assert.rejects(runCopyHunt(phones, { search: async () => { throw new EchoPipelineError("BUDGET_EXCEEDED", "cap"); }, metadata: async () => null, fetchPage: async () => null }), /cap/);
// One failed search only skips that phrase.
let call = 0;
const partial = await runCopyHunt(phones, { search: async () => { call += 1; if (call === 1) throw new Error("network"); return results; }, metadata: async () => null, fetchPage: async () => null });
assert.equal(partial.queries[0].status, "failed");

// A trace page at another address (http vs https, no www., a tracking parameter, a trailing slash) is the same page,
// not a possible copy outside the trace; the same outside page at two addresses is listed once.
{
  const fox = phones.pages.find((page) => page.id === "page-1");
  assert.ok(fox && fox.judgment.kind === "derived", "page-1 is a confirmed copy that shares the original's wording");
  const aliases = [fox.url.replace("https://www.", "http://"), `${fox.url}/`, `${fox.url}?utm_source=feed`, fox.url.replace("https://www.", "https://m.")];
  const outside = "https://wfla.example/2021/09/28/phones";
  const aliasHunt = await runCopyHunt(phones, {
    search: async (phrase) => phrase === phrases[0] ? [
      ...aliases.map((url) => ({ url, title: "FOX 13 again", content: phrases[0] })),
      { url: outside, title: "WFLA", content: phrases[0], published_date: "2021-09-28" },
      { url: outside.replace("https://", "http://www."), title: "WFLA again", content: phrases[0], published_date: "2021-09-28" },
    ] : [],
    metadata: async () => null, fetchPage: async () => null,
  });
  assert.deepEqual(aliasHunt.candidates.map((candidate) => candidate.url), [outside], "a trace page at another address is never a new copy, and one outside page counts once");
  assert.equal(aliasHunt.queries.find((query) => query.phrase === phrases[0]).newMatches, 1);
  // The import check compares addresses the same way, so a file cannot list a trace page as an outside copy.
  for (const url of [`${phones.pages[0].url}/`, `${phones.pages[0].url}#top`, `${phones.pages[0].url}?utm_source=x`]) {
    assert.equal(bad((h) => { h.candidates[0].url = url; }), null, `a candidate cannot be a trace page at another address (${url})`);
  }
  assert.equal(bad((h) => { h.candidates[1].url = `${h.candidates[0].url}?utm_medium=y`; }), null, "two candidates cannot be the same page");
}

// "Published after the original" needs the original's own date to be trustworthy, as the candidate's must be: a search
// estimate can be a later update. Nor does an estimated original date make a phrase "common" wording.
{
  const estimated = structuredClone(phones);
  const original = estimated.pages.find((page) => page.id === rootId);
  original.publishedDateSource = "Tavily estimate";
  const estimatedHunt = await runCopyHunt(estimated, {
    search: async (phrase) => phrase === phrases[0] ? [
      { url: "https://wfla.example/2021/09/28/phones", title: "WFLA", content: phrases[0], published_date: "2021-09-28" },
      { url: "https://old.example/2018/01/01/story", title: "Older", content: phrases[0] },
    ] : [],
    metadata: async () => null, fetchPage: async () => null,
  });
  assert.deepEqual(estimatedHunt.candidates.map((candidate) => candidate.timing), ["date unknown", "date unknown"], "an original dated only by a search estimate gives no timing");
  assert.equal(estimatedHunt.commonPhrases, undefined, "an estimated original date marks no phrase as common");
}
process.stdout.write("Echo copy hunt passed: off by default, fingerprints skip claim wording, only new verbatim matches, dates and timing, round-trip, tamper checks, budget stop, common-wording filter, own-site exclusion, full-page phrase check with private-address refusal; no provider calls.\n");
