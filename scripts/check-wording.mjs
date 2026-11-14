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
const { findSharedPhrases, visibleEdgeSignals, textOverlap } = load("../src/lib/echo/wording.ts");

const source = { id: "source", text: "In the original study, 73 percent of deployments degraded within ninety days." };
const copy = { id: "copy", text: "Researchers reported 73 percent of deployments degraded within ninety days, citing the study.", linkedPageIds: ["source"] };
const signals = visibleEdgeSignals(copy, source);
assert.equal(signals.linkedParentUrl, true);
assert.ok(signals.sharedPhrases.some((phrase) => phrase.includes("73 percent of deployments degraded within ninety days")));
assert.equal(visibleEdgeSignals({ id: "raw-link", text: "See https://example.org/root/?utm_source=share" }, { ...source, url: "https://example.org/root" }).linkedParentUrl, true);
assert.deepEqual(findSharedPhrases("this was from the other one with that", "this was from the other one with that"), []);
assert.equal(visibleEdgeSignals({ id: "html-link", text: "No URL in this passage.", citations: [{ pageId: source.id, how: "link", quote: "This page's HTML links to https://example.org/root" }] }, source).linkedParentUrl, true, "a link found in the page's HTML counts as a visible parent link");
assert.equal(visibleEdgeSignals({ id: "named", text: "No URL in this passage.", citations: [{ pageId: source.id, how: "named as source", quote: "according to Example" }] }, source).linkedParentUrl, false, "naming a source is not a link");
assert.deepEqual(visibleEdgeSignals({ id: "paraphrase", text: "A later analysis described a similar failure rate." }, source), { linkedParentUrl: false, sharedPhrases: [], textOverlap: 0 });
const wire = "The city council voted on Tuesday to approve a new transit plan that adds four bus lines, extends service hours past midnight, and funds the changes through a regional sales tax measure passed last spring.";
assert.ok(textOverlap(`Reposted: ${wire}`, wire) >= 0.8, "a reposted wire story has high overlap");
assert.equal(textOverlap("Too short to measure.", wire), 0, "very short passages report no overlap");
assert.ok(visibleEdgeSignals({ id: "repost", text: `Reposted: ${wire}` }, { ...source, text: wire }).textOverlap >= 0.8);

// edgeSentence: a derived edge described only from facts on its two pages, checked on three edges of a bundled run.
{
  const { edgeSentence } = load("../src/lib/echo/wording.ts");
  const phones = JSON.parse(fs.readFileSync(new URL("../public/demo-traces/americans-check-phones-96-times.echo.json", import.meta.url), "utf8")).analysis;
  const byId = new Map(phones.pages.map((page) => [page.id, page]));
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const shown = (value) => `${months[Number(value.slice(5, 7)) - 1]} ${Number(value.slice(8, 10))}, ${value.slice(0, 4)}`;
  const expected = {
    "page-1": "fox13seattle.com (Sep 28, 2021, from page metadata) is dated after asurion.com (Nov 21, 2019, from page metadata) and shares at least 3 distinctive phrases with it.",
    "page-4": "narcissusandthechild.com cites asurion.com (Nov 21, 2019, from page metadata) by name and year.",
    "page-10": "churchandculture.org (Oct 28, 2021, from its URL) is dated after fox13seattle.com (Sep 28, 2021, from page metadata), cites it by its title and shares at least 3 distinctive phrases with it.",
  };
  for (const [id, sentence] of Object.entries(expected)) {
    const child = byId.get(id);
    const parent = byId.get(child.judgment.parentId);
    const got = edgeSentence(child, parent, phones);
    assert.equal(got, sentence, `${id}: the edge sentence`);
    // Every name and date in it is on the two page objects; nothing comes from model text.
    for (const domain of got.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g)) assert.ok([child.domain, parent.domain].includes(domain), `${id}: "${domain}" is one of the edge's own domains`);
    const dates = got.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/g) ?? [];
    for (const date of dates) assert.ok([child, parent].some((page) => page.publishedDate && shown(page.publishedDate) === date), `${id}: "${date}" is one of the edge's own page dates`);
    if (/is dated after/.test(got)) assert.ok(child.publishedDate > parent.publishedDate, `${id}: "dated after" matches the dates`);
    const how = child.citations?.find((citation) => citation.pageId === parent.id)?.how;
    if (/cites|names/.test(got)) assert.ok(how && got.includes(how === "title" ? "by its title" : how), `${id}: the citation wording matches the page's own citation`);
    assert.ok(!/cop(?:y|ied)|proves?|confirm/i.test(got), `${id}: the sentence never says the page copied, only what Echo saw`);
  }
  const fox = byId.get("page-1");
  const asurion = byId.get(fox.judgment.parentId);
  assert.equal(edgeSentence({ ...fox, judgment: { ...fox.judgment, kind: "unclear" } }, asurion, phones), null, "an uncertain (dashed) link is never described as a confirmed edge");
  assert.equal(edgeSentence(fox, byId.get("page-6"), phones), null, "only the page's own parent");
  assert.equal(edgeSentence(asurion, asurion, phones), null, "a root has no edge");
  assert.equal(edgeSentence(fox, asurion, { ...phones, pages: [fox] }), null, "both pages must be in the trace");
  const bare = { id: "bare", domain: "bare.example", title: "", url: "", text: "Nothing in common.", publishedDate: null, judgment: { kind: "derived", parentId: asurion.id } };
  assert.equal(edgeSentence(bare, asurion, { ...phones, pages: [...phones.pages, bare] }), null, "nothing concrete (no dates, citation, link or shared wording): no sentence");
  const claimOnly = { ...bare, id: "claim-only", text: `I read that ${phones.claim}.` };
  assert.ok(findSharedPhrases(`Report: ${phones.claim}.`, claimOnly.text).length > 0, "the two share the claim's own words");
  assert.equal(edgeSentence(claimOnly, { ...asurion, text: `Report: ${phones.claim}.` }, { ...phones, pages: [...phones.pages, claimOnly] }), null, "wording that only restates the claim is not a distinctive phrase");
}

// Bug round 5 (11/14): a search estimate is not a page's own fact. The bundled brain run (slot 01) read
// "en.wikipedia.org (Aug 20, 2026, a search estimate) is dated after scientificamerican.com (Feb 7, 2008, …)": Tavily's
// guess (here a last-edit date) set the order. An estimated date is neither shown nor compared; the copy hunt already
// gives such pages no timing.
{
  const { edgeSentence } = load("../src/lib/echo/wording.ts");
  const brain = JSON.parse(fs.readFileSync(new URL("../public/demo-traces/humans-use-10-percent-of-brain.echo.json", import.meta.url), "utf8")).analysis;
  const byId = new Map(brain.pages.map((page) => [page.id, page]));
  const wiki = brain.pages.find((page) => page.domain.endsWith("wikipedia.org") && page.judgment.kind === "derived");
  const parent = byId.get(wiki.judgment.parentId);
  assert.equal(wiki.publishedDateSource, "Tavily estimate", "the bundled case still has an estimated date");
  assert.equal(edgeSentence(wiki, parent, brain), "en.wikipedia.org cites scientificamerican.com (Feb 7, 2008, from page metadata) by name and year.", "an estimated date is not shown or compared");
  const estimatedParent = { ...parent, publishedDate: "2001-01-01", publishedDateSource: "Tavily estimate" };
  const dated = { ...wiki, publishedDate: "2021-06-01", publishedDateSource: "page text" };
  const pages = brain.pages.map((page) => (page.id === parent.id ? estimatedParent : page.id === wiki.id ? dated : page));
  assert.equal(edgeSentence(dated, estimatedParent, { ...brain, pages }), "en.wikipedia.org (Jun 1, 2021, from the page text) cites scientificamerican.com by name and year.", "nor an estimated parent date");
  // Every edge in the bundled and evaluation runs: no estimate in a sentence.
  for (const dir of ["../public/demo-traces/", "../evaluation/runs/"]) {
    for (const name of fs.readdirSync(new URL(dir, import.meta.url)).filter((file) => file.endsWith(".json"))) {
      const analysis = JSON.parse(fs.readFileSync(new URL(`${dir}${name}`, import.meta.url), "utf8")).analysis;
      const pagesById = new Map(analysis.pages.map((page) => [page.id, page]));
      for (const page of analysis.pages) {
        const sentence = page.judgment.parentId && pagesById.has(page.judgment.parentId) ? edgeSentence(page, pagesById.get(page.judgment.parentId), analysis) : null;
        assert.ok(!sentence?.includes("search estimate"), `${name} ${page.id}: "${sentence}" uses a search estimate`);
      }
    }
  }
}

// Bug round 6 (11/14): an edge sentence uses the screen's date rule (hasReliableDate in graph.ts, the one behind "no
// reliable date"). It had shown and ordered by a date with no recorded source, a timestamp, or one in the future, so
// a page counted under "no reliable date" on the strip read "(Jan 1, 2099) is dated after ..." in its own copy details.
{
  const { edgeSentence } = load("../src/lib/echo/wording.ts");
  const { hasReliableDate } = load("../src/lib/echo/graph.ts");
  const brain = JSON.parse(fs.readFileSync(new URL("../public/demo-traces/humans-use-10-percent-of-brain.echo.json", import.meta.url), "utf8")).analysis;
  const wiki = brain.pages.find((page) => page.domain.endsWith("wikipedia.org") && page.judgment.kind === "derived");
  const parent = brain.pages.find((page) => page.id === wiki.judgment.parentId);
  const plain = "en.wikipedia.org cites scientificamerican.com (Feb 7, 2008, from page metadata) by name and year.";
  for (const [label, date, source] of [
    ["a date with no recorded source", "2021-06-01", undefined],
    ["a date more than two days ahead", "2099-01-01", "page text"],
    ["a timestamp", "2021-06-01T10:00:00Z", "page metadata"],
  ]) {
    const child = { ...wiki, publishedDate: date, publishedDateSource: source };
    assert.equal(hasReliableDate(child), false, `${label} is not reliable on screen`);
    const pages = brain.pages.map((page) => (page.id === wiki.id ? child : page));
    assert.equal(edgeSentence(child, parent, { ...brain, pages }), plain, `${label} is neither shown nor compared in an edge sentence`);
  }
  const unsourcedParent = { ...parent, publishedDateSource: undefined };
  const dated = { ...wiki, publishedDate: "2021-06-01", publishedDateSource: "page text" };
  const pages = brain.pages.map((page) => (page.id === parent.id ? unsourcedParent : page.id === wiki.id ? dated : page));
  assert.equal(edgeSentence(dated, unsourcedParent, { ...brain, pages }), "en.wikipedia.org (Jun 1, 2021, from the page text) cites scientificamerican.com by name and year.", "nor a parent date with no recorded source");
  // A plain year or month stays: it is reliable, shown as written, and never ordered (it has no day).
  const yearOnly = { ...wiki, publishedDate: "2019", publishedDateSource: "page text" };
  assert.equal(edgeSentence(yearOnly, parent, { ...brain, pages: brain.pages.map((page) => (page.id === wiki.id ? yearOnly : page)) }), "en.wikipedia.org (2019, from the page text) cites scientificamerican.com (Feb 7, 2008, from page metadata) by name and year.");
}

process.stdout.write("Echo wording passed: direct links and distinctive overlap are visible; generic wording is excluded; edge sentences use only the pages' own facts.\n");
