// Offline check of the origin layer (src/lib/echo/origin-layer.ts): Echo Score, origin types, the publisher rule, the
// wording about pages Echo could not place, claim mutation, the comparison contexts, the per-engine breakdown (with the
// order-free "engines needed" figure, which must equal the one src/lib/echo/origin-flow.ts gives the /origins page) and
// the echo_check MCP tool (which claims a saved run may answer), on the bundled saved runs and small made-up traces.
// No provider call, no network, no cost.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
};
const layerLib = load(path.join(root, "src/lib/echo/origin-layer.ts"));
const { originLayer, originTypeOf, claimMutation, comparePrompts, engineBreakdown, echoCheck, scoreLabel, registrableDomain, claimSentence, wordingDrift, NO_EVIDENCE_WEIGHT } = layerLib;
// The flow library computes "engines needed" for the /origins page; echo_check must report the same figure.
const { originFlow } = load(path.join(root, "src/lib/echo/origin-flow.ts"));
const trace = (name) => JSON.parse(fs.readFileSync(path.join(root, "public/demo-traces", `${name}.echo.json`), "utf8")).analysis;

// Score labels name the evidence base, not the claim's truth.
assert.equal(scoreLabel(0), "Thin evidence base");
assert.equal(scoreLabel(30), "Thin evidence base");
assert.equal(scoreLabel(31), "Moderate evidence base");
assert.equal(scoreLabel(61), "Strong evidence base");
assert.equal(registrableDomain("newsroom.asurion.com"), "asurion.com");
assert.equal(registrableDomain("schoolofeducation.blogs.bristol.ac.uk"), "bristol.ac.uk");

// Phones: two origins, one publisher, and the first is a press release, so the publisher counts once at 0.3.
const phones = trace("americans-check-phones-96-times");
const phonesLayer = originLayer(phones);
assert.equal(phonesLayer.results, 13);
assert.equal(phonesLayer.origins.length, phones.summary.independentOrigins, "the layer counts the same origins as the trace summary");
assert.equal(phonesLayer.entities, 1);
assert.equal(phonesLayer.sameEntity, "asurion.com");
assert.equal(phonesLayer.origins[0].type, "press_release", "a newsroom page published together with its wire copy is a press release");
assert.deepEqual(phonesLayer.origins.map((origin) => origin.counted), [true, false]);
assert.equal(phonesLayer.score, Math.round(100 * (1 - Math.exp(-0.3 / 1.5))));
assert.equal(phonesLayer.label, "Thin evidence base");
// The warning counts origins (not pages) and says how many pages could not be placed.
assert.match(phonesLayer.warning, /^Every origin is asurion\.com: 2 origins, one publisher\. \d+ of the 13 pages could not be tied to any origin\.$/);

// Brain: eight origins, none with evidence of its own, so each counts NO_EVIDENCE_WEIGHT.
const brain = trace("humans-use-10-percent-of-brain");
const brainLayer = originLayer(brain);
assert.equal(brainLayer.origins.length, 8);
assert.ok(brainLayer.origins.every((origin) => !origin.ownEvidence && origin.weight === NO_EVIDENCE_WEIGHT));
assert.equal(brainLayer.entities, 8, "two videos on one platform are two publishers");
assert.equal(brainLayer.label, "Thin evidence base");
assert.match(brainLayer.warning, /None of the 8 origins shows evidence of its own/);

// Goldfish and head heat: a paper and original reporting among the origins. A strong evidence base, whichever way it
// points: both traces' own answers say the claim is not supported.
for (const name of ["goldfish-3-second-memory", "lose-most-body-heat-through-head"]) {
  const layer = originLayer(trace(name));
  assert.equal(layer.label, "Strong evidence base", name);
  assert.ok(layer.origins.some((origin) => origin.type === "primary_document" && origin.ownEvidence), `${name} has a primary document`);
  assert.equal(layer.warning, null);
  assert.match(echoCheck(trace(name)).note, /not a truth rating/);
}

// Every bundled run: the layer agrees with the trace's own origin count, the page split adds up, types are from the list.
for (const file of fs.readdirSync(path.join(root, "public/demo-traces")).filter((name) => name.endsWith(".echo.json"))) {
  const analysis = trace(file.replace(/\.echo\.json$/, ""));
  const layer = originLayer(analysis);
  assert.equal(layer.origins.length, analysis.summary.independentOrigins, `${file}: origin count`);
  assert.ok(layer.score >= 0 && layer.score <= 100);
  assert.equal(layer.originPages + layer.copies + layer.unplaced, analysis.pages.length, `${file}: origin pages + copies + unplaced = pages`);
  // Unplaced = the trace's unclear pages, plus any copy of a page that is itself not tied to an origin.
  assert.ok(layer.unplaced >= analysis.pages.filter((entry) => entry.judgment.kind === "unclear").length, `${file}: every unclear page is unplaced`);
  for (const origin of layer.origins) assert.ok(origin.type in layerLib.ORIGIN_TYPE_WEIGHTS);
  // The origins-only context never holds more pages than the full one, and holds exactly one page per origin.
  const prompts = comparePrompts(analysis);
  assert.equal(prompts.naivePages, analysis.pages.length);
  assert.equal(prompts.echoPages, layer.origins.length);
  assert.ok(prompts.echo.length < prompts.naive.length, `${file}: the origins-only context is smaller`);
  assert.deepEqual(comparePrompts(analysis), prompts, "the contexts are deterministic");
  assert.equal(engineBreakdown(analysis), null, `${file}: a run not routed by Telem has no engine breakdown`);
  const check = echoCheck(analysis);
  assert.deepEqual(check.pages, { origin_pages: layer.originPages, confirmed_copies: layer.copies, not_tied_to_an_origin: layer.unplaced });
  assert.ok(check.summary.includes(`${layer.unplaced} could not be tied to any origin`), `${file}: the summary states the unplaced pages`);
}

// Origin types from address and passage.
const page = (over) => ({ id: "p", title: "T", url: "https://example.com/a", domain: "example.com", publishedDate: null, text: "", hasPrimaryEvidence: false, judgment: { kind: "origin", parentId: null, confidence: 90, evidence: "" }, ...over });
assert.equal(originTypeOf(page({ url: "https://www.prnewswire.com/news-releases/x.html" })), "press_release");
assert.equal(originTypeOf(page({ url: "https://acme.com/press-releases/x" })), "press_release");
assert.equal(originTypeOf(page({ title: "Acme press release: record quarter" })), "press_release");
assert.equal(originTypeOf(page({ text: "NASHVILLE, Tenn., Nov. 21, 2019 /PRNewswire/ -- Americans now check their phones 96 times a day." })), "press_release");
assert.equal(originTypeOf(page({ title: "Phone checking statistics", text: "“Americans check their phones 96 times a day” is a vendor press release. Here is what the survey behind it measured." })), "unknown", "an article that mentions a press release is not one");
assert.equal(originTypeOf(page({ url: "https://pubmed.ncbi.nlm.nih.gov/935220" })), "primary_document");
assert.equal(originTypeOf(page({ url: "https://www.sec.gov/Archives/edgar/data/1/x.htm" })), "primary_document");
assert.equal(originTypeOf(page({ url: "https://www.cdc.gov/media/releases/x.html" })), "official_statement");
assert.equal(originTypeOf(page({ url: "https://www.reddit.com/r/x/comments/1" })), "social_post");
assert.equal(originTypeOf(page({ text: "The cuts were confirmed by two people familiar with the matter." })), "anonymous_source");
assert.equal(originTypeOf(page({ hasPrimaryEvidence: true, primaryEvidenceStatus: "found" })), "original_reporting");
assert.equal(originTypeOf(page({})), "unknown");

// The publisher rule on made-up traces.
const made = (pages, groups = []) => ({ claim: "Acme cut 30% of its sales team", pages, roots: pages.filter((entry) => entry.judgment.kind === "origin").map((entry) => entry.id), coPublishedRootGroups: groups });
// (a) A release on a wire service and on the company's newsroom, the wire copy leading the group, plus the company's
// own later page: one publisher (the company), not the wire service and the company.
const wireLed = originLayer(made([
  page({ id: "wire", url: "https://www.prnewswire.com/news-releases/acme-cuts.html", domain: "prnewswire.com", publishedDate: "2025-03-01" }),
  page({ id: "newsroom", url: "https://www.acme.com/press-releases/acme-cuts", domain: "acme.com", publishedDate: "2025-03-01" }),
  page({ id: "later", url: "https://www.acme.com/blog/update", domain: "acme.com", publishedDate: "2025-06-01", hasPrimaryEvidence: true, primaryEvidenceStatus: "found" }),
], [["wire", "newsroom"]]));
assert.equal(wireLed.origins.length, 2);
assert.equal(wireLed.entities, 1, "a wire copy leading a co-published group does not make the wire service a second publisher");
assert.equal(wireLed.sameEntity, "acme.com");
// (b) Two different companies' releases on the same wire service, and two papers on the same index: separate publishers.
assert.equal(originLayer(made([
  page({ id: "a", url: "https://www.prnewswire.com/news-releases/acme.html", domain: "prnewswire.com" }),
  page({ id: "b", url: "https://www.prnewswire.com/news-releases/globex.html", domain: "prnewswire.com" }),
])).entities, 2, "two releases on one wire service are two publishers");
assert.equal(originLayer(made([
  page({ id: "a", url: "https://pubmed.ncbi.nlm.nih.gov/111", domain: "pubmed.ncbi.nlm.nih.gov", hasPrimaryEvidence: true, primaryEvidenceStatus: "found" }),
  page({ id: "b", url: "https://pubmed.ncbi.nlm.nih.gov/222", domain: "pubmed.ncbi.nlm.nih.gov", hasPrimaryEvidence: true, primaryEvidenceStatus: "found" }),
])).entities, 2, "two papers on one index are two publishers");
// (c) One origin and pages Echo could not place: the warning does not say everything leads back to it.
const partly = originLayer(made([
  page({ id: "o", hasPrimaryEvidence: true, primaryEvidenceStatus: "found" }),
  page({ id: "c", url: "https://copy.example/a", domain: "copy.example", judgment: { kind: "derived", parentId: "o", confidence: 90, evidence: "" } }),
  page({ id: "u1", url: "https://one.example/a", domain: "one.example", judgment: { kind: "unclear", parentId: null, confidence: 40, evidence: "" } }),
  page({ id: "u2", url: "https://two.example/a", domain: "two.example", judgment: { kind: "unclear", parentId: "o", confidence: 40, evidence: "" } }),
]));
assert.deepEqual([partly.originPages, partly.copies, partly.unplaced], [1, 1, 2], "an unclear page with a guessed parent is not a confirmed copy");
assert.match(partly.warning, /^Every page Echo could place leads back to one origin \(example\.com, original reporting\)\. 2 of the 4 pages could not be tied to any origin\.$/);
// (d) No confirmed origin: nothing to compare, and the summary says so.
const none = made([page({ id: "u", judgment: { kind: "unclear", parentId: null, confidence: 30, evidence: "" } })]);
assert.equal(originLayer(none).score, 0);
assert.equal(comparePrompts(none).echoPages, 0);
assert.match(echoCheck(none).summary, /^None of the 1 page about this claim was confirmed as an independent origin\.$/);

// Claim mutation: the origin's sentence leads each chain, copies follow oldest first, and other figures are listed.
const mutation = claimMutation(phones);
assert.equal(mutation.claimFigure, "96 times");
assert.ok(mutation.variants.some((variant) => variant.figure === "352 times"), "the 2022 figure is listed as a variant");
const chain = mutation.chains[0];
assert.equal(chain.steps[0].pageId, phonesLayer.origins[0].id);
assert.match(chain.steps[0].sentence, /96 times a day/);
assert.equal(chain.steps.length, 1 + phonesLayer.origins[0].echoes);
assert.ok(chain.steps.slice(1).every((step) => step.drift > 0 && step.drift <= 1));
// The marked copy is the one that keeps the least wording of the page it copied, in every chain of every bundled run.
for (const name of ["americans-check-phones-96-times", "humans-use-10-percent-of-brain", "goldfish-3-second-memory", "lose-most-body-heat-through-head"]) {
  for (const entry of claimMutation(trace(name)).chains) {
    if (entry.biggest === null) continue;
    assert.equal(entry.steps[entry.biggest].drift, Math.max(...entry.steps.slice(1).map((step) => step.drift)), `${name}: the marked copy has the largest wording change`);
    assert.match(entry.note, /keeps the least of the wording of the page it copied \(/);
  }
}
const heat = claimMutation(trace("lose-most-body-heat-through-head"));
assert.equal(heat.claimFigure, null);
assert.ok(heat.variants.some((variant) => variant.figure === "45%"), "a claim without a figure lists the percentages pages give for it");
// A percentage that is not about the claim's quantity is not listed as "another figure for the same thing".
const brainVariants = claimMutation(brain).variants.map((variant) => variant.figure);
assert.ok(!brainVariants.includes("15%"), `the brain run lists no unrelated percentage (${brainVariants.join(", ")})`);
// Pronouns in the claim do not make a sentence a statement of it.
assert.match(claimSentence({ title: "T", text: "Your blood flow will not slow as your body cools, and you will get colder faster. People say you lose most of your body heat through your head, which studies do not support." }, "You lose most of your body heat through your head"), /lose most of your body heat through your head/);
assert.equal(wordingDrift("Americans check phones 96 times a day", "Americans check phones 96 times a day"), 0);
assert.equal(claimSentence({ title: "Fallback title | Site", text: "Nothing relevant here at all, only filler words in a sentence." }, "Goldfish have a 3-second memory"), "Fallback title");

// Per-engine breakdown on a Telem-routed audit (the phones pages with engines attached).
const routed = { ...phones, searchAudit: [{ query: "q", depth: "basic", status: "searched", totalResults: 13, matchingResults: 13, uniquePagesAdded: 13, router: "telem", providers: ["exa", "brave", "tavily"], pageIds: phones.pages.map((entry) => entry.id), pageProviders: Object.fromEntries(phones.pages.map((entry, index) => [entry.id, [["exa"], ["brave"], ["tavily", "exa"]][index % 3]])) }] };
const engines = engineBreakdown(routed);
assert.equal(engines.pages, 13);
assert.deepEqual(engines.engines.map((row) => row.engine).sort(), ["brave", "exa", "tavily"]);
for (const row of engines.engines) {
  assert.ok(row.origins <= phonesLayer.origins.length);
  assert.equal(row.pages, row.unplaced + row.copies + routed.pages.filter((entry) => routed.searchAudit[0].pageProviders[entry.id].includes(row.engine) && phonesLayer.origins.some((origin) => origin.pageIds.includes(entry.id))).length, `${row.engine}: pages = origins' own pages + copies + unplaced`);
}
// The sentence counts the pages Echo kept, not every result the engines returned.
assert.match(engines.headline, /^3 engines returned the 13 pages Echo kept/);
assert.equal(echoCheck(routed).engines.length, 3);
assert.equal(echoCheck(phones).engines, undefined);
const routedNone = { ...none, searchAudit: [{ query: "q", depth: "basic", status: "searched", totalResults: 1, matchingResults: 1, uniquePagesAdded: 1, router: "telem", providers: ["exa", "brave"], pageIds: ["u"], pageProviders: { u: ["exa", "brave"] } }] };
assert.equal(engineBreakdown(routedNone).headline, "2 engines returned the one page Echo kept, and that page was not confirmed as an origin.", "with no origin the engine sentence claims no copies and no origin");
assert.deepEqual(echoCheck(routedNone).engines_needed, { needed: 0, of: 2 }, "no origin reached: no engine was needed for one");

// Engines needed: the fewest engines whose pages (an origin page, or a confirmed copy leading back to it) together reach
// every origin reached in the run. Each wording branch on a small made-up run, and none of it depends on list order.
const ORDER_WORDS = /first engine|new origins?|extra engines?|added \d|nothing new|most pages/i;
const audit = (pageProviders) => [{ query: "q", depth: "basic", status: "searched", totalResults: 9, matchingResults: 9, uniquePagesAdded: 9, router: "telem", providers: [...new Set(Object.values(pageProviders).flat())], pageIds: Object.keys(pageProviders), pageProviders }];
const three = [
  page({ id: "o1", url: "https://one.example/a", domain: "one.example", hasPrimaryEvidence: true, primaryEvidenceStatus: "found" }),
  page({ id: "o2", url: "https://two.example/a", domain: "two.example", hasPrimaryEvidence: true, primaryEvidenceStatus: "found" }),
  page({ id: "o3", url: "https://three.example/a", domain: "three.example" }),
  page({ id: "c1", url: "https://copy.example/a", domain: "copy.example", judgment: { kind: "derived", parentId: "o1", confidence: 90, evidence: "" } }),
  page({ id: "c2", url: "https://copy.example/b", domain: "copy.example", judgment: { kind: "derived", parentId: "c1", confidence: 90, evidence: "" } }),
  page({ id: "u1", url: "https://loose.example/a", domain: "loose.example", judgment: { kind: "unclear", parentId: "o3", confidence: 40, evidence: "" } }),
];
const engineCases = [
  // No engine reaches all three: beta is the only way to o2, and gamma covers o1 (through a copy of a copy) and o3.
  { providers: { o1: ["alpha"], o2: ["beta"], o3: ["gamma"], c2: ["gamma"], u1: ["alpha", "delta"] }, needed: { needed: 2, of: 4 }, alone: [], only: { alpha: 0, beta: 1, gamma: 1, delta: 0 }, says: "No single engine reached all 3 origins; it took 2 of the 4. 2 origins came through one engine only." },
  // One engine reaches every origin on its own; the others do not.
  { providers: { o1: ["alpha"], o2: ["alpha", "beta"], o3: ["alpha"], c1: ["gamma"] }, needed: { needed: 1, of: 3 }, alone: ["alpha"], only: { alpha: 1, beta: 0, gamma: 0 }, says: "One of the 3 engines (alpha) reached all 3 origins on its own; no other engine did. 1 origin came through one engine only." },
  // Two of three reach every origin on their own.
  { providers: { o1: ["alpha", "beta"], o2: ["alpha", "beta", "gamma"], o3: ["beta", "alpha"] }, needed: { needed: 1, of: 3 }, alone: ["alpha", "beta"], only: { alpha: 0, beta: 0, gamma: 0 }, says: "2 of the 3 engines (alpha, beta) each reached all 3 origins on their own; the other one did not." },
  // Every engine reaches every origin: any one of them would have done.
  { providers: { o1: ["alpha", "beta"], o2: ["beta", "alpha"], o3: ["alpha"], c1: ["beta"], u1: ["beta"] }, pages: three.filter((entry) => entry.id !== "o3"), needed: { needed: 1, of: 2 }, alone: ["alpha", "beta"], only: { alpha: 0, beta: 0 }, says: "Both engines reached both origins: any one of them alone would have reached them." },
  // An engine whose only page is an unclear page with a guessed parent reaches no origin.
  // (The other two origins have no engine on record here, and the sentence says they are outside the count.)
  { providers: { o1: ["alpha"], u1: ["delta"] }, needed: { needed: 1, of: 2 }, alone: ["alpha"], only: { alpha: 1, delta: 0 }, says: "One of the 2 engines (alpha) reached the one origin on its own; no other engine did. 1 origin came through one engine only. 2 origins of this run have no engine on record and are not counted here." },
];
for (const entry of engineCases) {
  const pages = entry.pages ?? three;
  const providers = Object.fromEntries(Object.entries(entry.providers).filter(([id]) => pages.some((item) => item.id === id)));
  const run = { ...made(pages), searchAudit: audit(providers) };
  const found = engineBreakdown(run);
  const result = echoCheck(run);
  assert.deepEqual(result.engines_needed, entry.needed, entry.says);
  assert.deepEqual(found.needed.alone, entry.alone, entry.says);
  assert.deepEqual(Object.fromEntries(result.engines.map((row) => [row.engine, row.origins_only_this_engine_reached])), entry.only, entry.says);
  assert.ok(result.engines_summary.includes(entry.says), `${result.engines_summary} | wanted: ${entry.says}`);
  assert.match(result.engines_summary, /One run, in hindsight: this does not rank the engines\.$/);
  assert.doesNotMatch(result.engines_summary, ORDER_WORDS);
  // The same figure as the flow library, and the true minimum by a separate brute force over every set of engines.
  const flow = originFlow(run);
  assert.deepEqual(result.engines_needed, { needed: flow.needed.needed, of: flow.needed.of });
  const names = found.engines.map((row) => row.engine);
  const reach = Object.values(found.foundBy);
  let best = reach.length ? Infinity : 0;
  for (let mask = 1; mask < 1 << names.length; mask += 1) {
    const chosen = names.filter((_, index) => mask & (1 << index));
    if (reach.every((list) => chosen.some((engine) => list.includes(engine)))) best = Math.min(best, chosen.length);
  }
  assert.equal(result.engines_needed.needed, best, "engines needed is the true minimum");
  // Order-free: the pages, the searches and each page's engine list in another order, and the engines spread over two searches.
  const ids = Object.keys(providers);
  const reordered = { ...made([...pages].reverse()), searchAudit: [...audit(Object.fromEntries(ids.slice(1).reverse().map((id) => [id, [...providers[id]].reverse()]))), ...audit({ [ids[0]]: [...providers[ids[0]]].reverse() })] };
  const again = echoCheck(reordered);
  assert.equal(again.engines_summary, result.engines_summary, "the engine sentence does not depend on order");
  assert.deepEqual(again.engines_needed, result.engines_needed);
  assert.deepEqual(Object.fromEntries(again.engines.map((row) => [row.engine, row.origins_only_this_engine_reached])), entry.only);
}
// One engine only: nothing to compare, and the sentence still says how many of its pages could not be placed.
const oneEngine = echoCheck({ ...made(three.filter((entry) => ["o1", "c1", "u1"].includes(entry.id))), searchAudit: audit({ o1: ["alpha"], c1: ["alpha"], u1: ["alpha"] }) });
assert.deepEqual(oneEngine.engines_needed, { needed: 1, of: 1 });
assert.equal(oneEngine.engines_summary, "One engine returned the 3 pages Echo kept on this run; 1 of those pages could not be tied to any origin. Its pages reached 1 independent origin.");
assert.equal(echoCheck(phones).engines_needed, undefined, "a run not routed by Telem has no engines-needed figure");

// The saved Telem-routed runs (mcp/traces): echo_check reports the engines-needed figure the /origins page shows, each
// engine's "only this engine reached" count matches the flow library, and the sentence has no order-dependent wording.
const TELEM_NEEDED = { phones: [1, 5], "body-heat": [3, 5], brain: [2, 4], goldfish: [1, 5] };
const telemFiles = fs.readdirSync(path.join(root, "mcp/traces")).filter((name) => /^telem-.*\.echo\.json$/.test(name));
assert.ok(telemFiles.length >= 4, "the four saved Telem runs are there");
for (const file of telemFiles) {
  const analysis = JSON.parse(fs.readFileSync(path.join(root, "mcp/traces", file), "utf8")).analysis;
  const result = echoCheck(analysis);
  const flow = originFlow(analysis);
  const found = engineBreakdown(analysis);
  const layer = originLayer(analysis);
  assert.ok(flow.needed, `${file}: the flow library has an engines-needed figure`);
  assert.deepEqual(result.engines_needed, { needed: flow.needed.needed, of: flow.needed.of }, `${file}: echo_check and /origins agree on engines needed`);
  assert.deepEqual([...found.needed.alone].sort(), [...flow.needed.alone].sort(), `${file}: the engines that reach every origin alone`);
  assert.deepEqual(result.engines.map((row) => [row.engine, row.pages, row.origins, row.origins_only_this_engine_reached]), flow.engines.map((row) => [row.engine, row.pages, row.origins, row.onlyHere]), `${file}: per-engine rows match the flow library`);
  assert.equal(result.engines.reduce((sum, row) => sum + row.origins_only_this_engine_reached, 0), Object.values(found.foundBy).filter((list) => list.length === 1).length, `${file}: each single-engine origin is counted once`);
  const pinned = Object.entries(TELEM_NEEDED).find(([key]) => file.startsWith(`telem-${key}-2026-11-14`));
  if (pinned) assert.deepEqual([result.engines_needed.needed, result.engines_needed.of], pinned[1], `${file}: engines needed as measured on Nov 14`);
  // The sentence: order-free wording, the figure itself, the unplaced pages, and no ranking.
  assert.doesNotMatch(result.engines_summary, ORDER_WORDS, `${file}: no order-dependent wording`);
  const { needed, of } = result.engines_needed;
  const all = found.origins === 1 ? "the one origin" : found.origins === 2 ? "both origins" : `all ${found.origins} origins`;
  if (needed > 1) assert.ok(result.engines_summary.includes(`No single engine reached ${all}; it took ${needed} of the ${of}.`), `${file}: ${result.engines_summary}`);
  else if (found.needed.alone.length === of) assert.ok(result.engines_summary.includes(`Every one of the ${of} engines reached ${all}`), `${file}: ${result.engines_summary}`);
  else assert.ok(result.engines_summary.includes(`of the ${of} engines (${found.needed.alone.join(", ")})`) && result.engines_summary.includes(`reached ${all} on`), `${file}: ${result.engines_summary}`);
  assert.ok(result.engines_summary.startsWith(`${of} engines returned the ${found.pages} pages Echo kept`), `${file}: the sentence counts the pages Echo kept`);
  if (found.pages === layer.results && layer.unplaced) assert.ok(result.engines_summary.includes(`${layer.unplaced} of those pages could not be tied to any origin`), `${file}: the engine sentence states the unplaced pages`);
  assert.match(result.engines_summary, /this does not rank the engines\.$/, `${file}: one run does not rank engines`);
  // Order-free on the real run too: the searches in reverse order give the same sentence and the same figures.
  const reversed = echoCheck({ ...analysis, searchAudit: [...analysis.searchAudit].reverse() });
  assert.equal(reversed.engines_summary, result.engines_summary, `${file}: the sentence does not depend on search order`);
  assert.deepEqual(reversed.engines_needed, result.engines_needed);
  assert.deepEqual(reversed.engines, result.engines);
}

// echo_check over MCP (stdio). A saved run answers only its own claim: the same figures, and the same key words give or
// take one word one side leaves out. A claim with a word swapped is refused, and so is anything else while live runs are off.
const call = (id, claim) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo_check", arguments: { claim } } });
const refusedClaims = [
  "The Great Wall of China is visible from space",
  "Americans check their phones 352 times a day",
  "Americans check their phones 96 times an hour",
  "Goldfish have a 3 month memory",
  "Dogs have a 3 second memory",
  "You lose most of your body heat through your feet",
  "Humans use 100% of their brains",
];
const requests = [
  { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: "list", method: "tools/list" },
  call(3, "Do Americans really check their phones 96 times a day?"),
  call(4, "Goldfish have a three-second memory"),
  call(5, "Is it true that we use only ten percent of our brain?"),
  ...refusedClaims.map((claim, index) => call(100 + index, claim)),
];
const run = spawnSync(process.execPath, [path.join(root, "mcp/echo-mcp.mjs")], { cwd: "/", input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`, encoding: "utf8", env: { ...process.env, ECHO_MCP_LIVE: "0", ECHO_MCP_TRACES: "", ECHO_URL: "http://127.0.0.1:9" } });
assert.equal(run.status, 0, run.stderr);
const lines = run.stdout.trim().split("\n");
const replies = new Map(lines.map((line) => JSON.parse(line)).map((reply) => [reply.id, reply]));
assert.equal(replies.size, requests.length - 1, "one reply per request with an id (0 and a string id included), none for the notification");
assert.equal(replies.get(0).result.serverInfo.name, "echo");
assert.deepEqual(replies.get("list").result.tools.map((tool) => tool.name), ["echo_check"]);
assert.match(replies.get("list").result.tools[0].description, /`engines_needed`.*never use it to rank search engines/, "the tool tells an agent what engines_needed is and that one run ranks nothing");
// The add command in the server's own header is the one that works from every folder.
assert.match(fs.readFileSync(path.join(root, "mcp/echo-mcp.mjs"), "utf8"), /claude mcp add --scope user echo -- node /);
const checked = JSON.parse(replies.get(3).result.content[0].text);
assert.equal(replies.get(3).result.isError, false);
// The newest saved run of the claim answers: the Telem-routed run in mcp/traces when it is there, else the bundled one.
const telemPhonesPath = path.join(root, "mcp/traces/telem-phones-2026-11-14.echo.json");
const newestPhones = fs.existsSync(telemPhonesPath) ? JSON.parse(fs.readFileSync(telemPhonesPath, "utf8")).analysis : phones;
const expected = echoCheck(newestPhones);
assert.deepEqual([checked.echo_score, checked.num_results, checked.num_origins, checked.num_publishers], [expected.echo_score, expected.num_results, expected.num_origins, expected.num_publishers]);
assert.deepEqual(checked.pages, expected.pages);
assert.equal(checked.summary, expected.summary);
assert.equal(checked.wording_note, undefined, "the same claim asked as a question needs no wording note");
assert.match(checked.source, /saved Echo run/);
if (newestPhones !== phones) {
  // The real Telem-routed run: most of its pages could not be placed, and every sentence the tool returns says so.
  const real = engineBreakdown(newestPhones);
  const layer = originLayer(newestPhones);
  assert.ok(real && real.engines.length >= 2, "the saved Telem run records more than one engine");
  assert.ok(real.engines.every((row) => row.pages === row.unplaced + row.copies + newestPhones.pages.filter((entry) => layer.origins.some((origin) => origin.pageIds.includes(entry.id)) && newestPhones.searchAudit.some((query) => (query.pageProviders?.[entry.id] ?? []).includes(row.engine))).length));
  assert.equal(checked.engines.length, real.engines.length);
  assert.equal(checked.engines_summary, real.headline);
  assert.ok(layer.unplaced > layer.copies, "this run has more unplaced pages than confirmed copies");
  assert.match(checked.warning, new RegExp(`^Every page Echo could place leads back to one origin .*\\. ${layer.unplaced} of the ${layer.results} pages could not be tied to any origin\\.$`));
  assert.ok(!/Everything in this trace/.test(JSON.stringify(checked)), "nothing the tool returns says everything leads back to the origin");
  // The text an agent reads carries the engines-needed figure and its sentence, and the sentence keeps the unplaced pages in view.
  const printed = replies.get(3).result.content[0].text;
  assert.deepEqual(checked.engines_needed, expected.engines_needed);
  assert.deepEqual(checked.engines_needed, { needed: 1, of: real.engines.length }, "every engine reached the one origin, so one engine was needed");
  assert.ok(printed.includes('"engines_needed"') && printed.includes('"origins_only_this_engine_reached"'), "the printed reply has the engines-needed figure and each engine's only-here count");
  assert.deepEqual(checked.engines, expected.engines);
  assert.ok(checked.engines_summary.includes(`Every one of the ${real.engines.length} engines reached the one origin: any one of them alone would have reached it.`), checked.engines_summary);
  assert.ok(checked.engines_summary.includes(`${layer.unplaced} of those pages could not be tied to any origin`), checked.engines_summary);
  assert.doesNotMatch(checked.engines_summary, ORDER_WORDS, "the engine sentence the tool prints has no order-dependent wording");
}
// A spelled-out figure is the same figure; one word left out is the same claim, and the reply says which claim was traced.
const goldfish = JSON.parse(replies.get(4).result.content[0].text);
assert.equal(replies.get(4).result.isError, false, "a spelled-out figure matches the saved claim");
assert.equal(goldfish.claim, "Goldfish have a 3-second memory");
const brainReply = JSON.parse(replies.get(5).result.content[0].text);
assert.equal(replies.get(5).result.isError, false);
assert.equal(brainReply.claim, brain.claim);
assert.match(brainReply.wording_note, /The saved run traced "Humans use only 10% of their brains\."/);
// Refusals: the reply is the "no saved run, live runs are off" refusal itself (not a failed attempt to reach a server),
// and it lists the claims that do have a saved run.
refusedClaims.forEach((claim, index) => {
  const reply = replies.get(100 + index);
  assert.equal(reply.result.isError, true, `"${claim}" is not answered from another claim's saved run`);
  const body = JSON.parse(reply.result.content[0].text);
  assert.match(body.error, /^No saved Echo run matches this claim, and live runs are off/, `"${claim}": refused before any request`);
  assert.ok(Array.isArray(body.saved_claims) && body.saved_claims.length >= 4);
  assert.equal(body.echo_score, undefined);
});

process.stdout.write(`Origin layer check passed: score, types, publisher rule, unplaced-page wording, mutation, contexts, engines, engines needed (${telemFiles.length} saved Telem runs agree with the flow library) and the echo_check MCP tool.\n`);
