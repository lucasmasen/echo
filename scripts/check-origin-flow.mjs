// Offline check of the origin layer's flow data (src/lib/echo/origin-flow.ts), which the graphic draws: every page of
// a saved run lands in exactly one lane, the per-engine rows add up, and the "what each engine added" sentence is
// true for the saved Telem run. No provider call, no network, no cost.
import assert from "node:assert/strict";
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
const { originFlow, engineScorecard } = load(path.join(root, "src/lib/echo/origin-flow.ts"));
const { originLayer } = load(path.join(root, "src/lib/echo/origin-layer.ts"));

const files = ["public/demo-traces", "mcp/traces"].flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith(".echo.json")).map((name) => path.join(dir, name)));
assert.ok(files.length >= 5, "the bundled runs are there");

// The engine scorecard is the per-run flows added up, nothing more: every total equals the sum over the Telem-routed runs.
{
  const all = files.map((file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).analysis);
  const flows = all.map((analysis) => originFlow(analysis)).filter((flow) => flow.engines.length);
  const card = engineScorecard(all);
  assert.equal(engineScorecard(all.filter((analysis) => !originFlow(analysis).engines.length)), null, "runs without engine data make no scorecard");
  assert.equal(card.claims, flows.length);
  assert.equal(card.runs, flows.reduce((sum, flow) => sum + (flow.bill?.runs ?? 0), 0));
  assert.equal(card.origins, flows.reduce((sum, flow) => sum + new Set(flow.pages.filter((page) => page.engines.length && page.originId).map((page) => page.originId)).size, 0));
  assert.ok(card.singleEngineOrigins <= card.origins);
  assert.equal(card.rows.reduce((sum, row) => sum + row.onlyHere, 0), card.singleEngineOrigins, "an origin reached by one engine is counted for that engine only");
  for (const row of card.rows) {
    assert.equal(row.own + row.copies + row.unplaced, row.pages, `${row.engine}: scorecard row adds up`);
    assert.equal(row.pages, flows.reduce((sum, flow) => sum + (flow.engines.find((engine) => engine.engine === row.engine)?.pages ?? 0), 0));
    assert.equal(row.runs, flows.reduce((sum, flow) => sum + (flow.bill?.runsByEngine[row.engine] ?? 0), 0));
    assert.ok(row.onlyHere <= row.origins);
  }
  assert.equal(card.claimRows.length, card.claims, "one row per Telem-routed claim in the engines-per-origin picture");
  assert.equal(card.claimRows.reduce((sum, row) => sum + row.perOrigin.length, 0), card.origins, "the picture has one dot per origin");
  assert.equal(card.claimRows.reduce((sum, row) => sum + row.perOrigin.filter((count) => count === 1).length, 0), card.singleEngineOrigins, "dots marked 1 are the single-engine origins");
  // Every billed engine run is in exactly one row, including an engine billed on a run where none of its pages was kept.
  assert.equal(card.rows.reduce((sum, row) => sum + row.runs, 0), card.runs, "the rows' runs add up to the runs billed");
}
let routed = 0;
for (const file of files) {
  const analysis = JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).analysis;
  const flow = originFlow(analysis);
  const layer = originLayer(analysis);
  // Every page once, in one lane.
  assert.equal(flow.pages.length, analysis.pages.length, `${file}: every page is drawn`);
  assert.equal(new Set(flow.pages.map((page) => page.id)).size, analysis.pages.length, `${file}: no page twice`);
  assert.equal(flow.counts.origin + flow.counts.copy + flow.counts.unplaced, analysis.pages.length);
  assert.equal(flow.counts.origin, layer.origins.reduce((sum, origin) => sum + origin.pageIds.length, 0), `${file}: origin pages`);
  assert.equal(flow.counts.copy, layer.origins.reduce((sum, origin) => sum + origin.echoes, 0), `${file}: copies match the layer's count`);
  for (const page of flow.pages) {
    const source = analysis.pages.find((entry) => entry.id === page.id);
    if (page.kind === "unplaced") assert.equal(page.originId, null);
    else assert.ok(layer.origins.some((origin) => origin.id === page.originId), `${file}: ${page.id} leads to a real origin`);
    if (page.possibleOriginId) {
      assert.equal(page.kind, "unplaced", `${file}: a possible link is drawn only from a page Echo could not place`);
      assert.equal(source.judgment.kind, "unclear", `${file}: a possible link comes from an unclear judgment, never a confirmed one`);
      assert.ok(layer.origins.some((origin) => origin.id === page.possibleOriginId), `${file}: a possible link ends at a real origin`);
    }
    if (page.kind === "copy") assert.equal(source.judgment.kind, "derived", `${file}: only confirmed copies are drawn as copies`);
    if (page.kind === "origin") assert.equal(source.judgment.kind, "origin");
  }
  // Origin pages come before copies and unplaced pages come last, so the diagram's groups are contiguous.
  const lanes = flow.pages.map((page) => page.originId ?? "none");
  assert.deepEqual(lanes.filter((lane, index) => index === 0 || lanes[index - 1] !== lane).length, new Set(lanes).size, `${file}: each group is drawn in one block`);
  if (flow.counts.unplaced) assert.equal(lanes[lanes.length - 1], "none", `${file}: unplaced pages are last`);
  // Searches: each kept page is credited to at most one search, and each origin to the first search that reached it.
  const firstFound = (analysis.searchAudit ?? []).flatMap((entry) => entry.pageIds ?? []);
  assert.equal(flow.searches.reduce((sum, search) => sum + search.pages, 0), new Set(firstFound).size, `${file}: search rows add up to the pages a search first returned`);
  assert.equal(flow.searches.reduce((sum, search) => sum + search.newOrigins, 0), new Set(flow.pages.filter((page) => firstFound.includes(page.id) && page.originId).map((page) => page.originId)).size, `${file}: each origin is credited to one search`);
  flow.searches.forEach((search, index) => {
    const entry = analysis.searchAudit[index];
    assert.equal(entry.query, search.query, `${file}: search rows are in the audit's own order`);
    assert.equal(search.first, index === 0);
    assert.equal(search.routedTo.length, entry.router === "telem" ? new Set(entry.providers ?? []).size : 0, `${file}: routing chips are Telem's own list of engines for that search`);
    for (const route of search.routedTo) assert.ok(route.pages <= search.pages, `${file}: an engine cannot return more of a search's pages than the search has`);
    if (search.routedTo.length && search.pages > 0) assert.ok(search.routedTo.some((route) => route.pages > 0), `${file}: every kept page of a routed search came from an engine that answered it`);
  });
  for (const search of flow.searches) { assert.equal(search.originNames.length, search.newOrigins); if (!search.ran) assert.equal(search.pages, 0, `${file}: a search that did not run returned nothing`); }
  if (flow.searchLine) assert.match(flow.searchLine, /^(The claim as asked reached|The first search that ran reached|\d+ searches ran)/);
  if (flow.searchLine) assert.doesNotMatch(flow.searchLine, /follow-up/, `${file}: the searches are sent together, so none is called a follow-up`);
  for (const idle of flow.idleEngines) assert.ok(!flow.engines.some((row) => row.engine === idle.engine), `${file}: an idle engine has no kept page`);
  assert.ok(flow.unrecordedOrigins >= 0);
  if (flow.marginal && /only|no single/.test(flow.marginal)) assert.match(flow.marginal, /By this run’s record/, `${file}: a negative engine claim is framed as the run's record`);
  for (const page of flow.pages) assert.equal(page.note, (analysis.pages.find((entry) => entry.id === page.id).judgment.evidence ?? "").trim(), `${file}: the note is the saved judgment, word for word`);
  // Engines: only on a Telem-routed run; each row adds up; "new" origins sum to the origins the engines reach.
  const telem = (analysis.searchAudit ?? []).some((entry) => entry.router === "telem");
  assert.equal(flow.engines.length > 0, telem, `${file}: engines are drawn only for a Telem-routed run`);
  for (const row of flow.engines) {
    assert.equal(row.own + row.copies + row.unplaced, row.pages, `${file}: ${row.engine} adds up`);
    assert.equal(row.pages, flow.pages.filter((page) => page.engines.includes(row.engine)).length);
    assert.ok(row.onlyHere <= row.origins && row.origins <= layer.origins.length);
  }
  if (telem) {
    routed += 1;
    const reached = new Set(flow.pages.filter((page) => page.engines.length && page.originId).map((page) => page.originId));
    const reachers = (id) => new Set(flow.pages.filter((page) => page.originId === id).flatMap((page) => page.engines));
    assert.equal(flow.engines.reduce((sum, row) => sum + row.onlyHere, 0), [...reached].filter((id) => reachers(id).size === 1).length, `${file}: "only here" counts each single-engine origin once`);
    assert.deepEqual(flow.engines.map((row) => row.pages), [...flow.engines.map((row) => row.pages)].sort((a, b) => b - a), "engines are listed by pages returned");
    // Engines needed: brute force again here, independently of the library, and check it is the true minimum.
    const names = flow.engines.map((row) => row.engine);
    let best = reached.size ? Infinity : 0;
    for (let mask = 1; mask < 1 << names.length; mask += 1) {
      const chosen = names.filter((_, index) => mask & (1 << index));
      if ([...reached].every((id) => chosen.some((engine) => reachers(id).has(engine)))) best = Math.min(best, chosen.length);
    }
    assert.equal(flow.needed.needed, best, `${file}: engines needed is the true minimum`);
    assert.equal(flow.needed.of, names.length);
    assert.equal(flow.needed.perOrigin.length, reached.size);
    // Order-free: reversing the engine list must not change any engine's figures or the sentence.
    const reversed = originFlow({ ...analysis, searchAudit: [...analysis.searchAudit].reverse() });
    assert.equal(reversed.marginal, flow.marginal, `${file}: the sentence does not depend on order`);
    for (const row of flow.engines) assert.equal(reversed.engines.find((entry) => entry.engine === row.engine).onlyHere, row.onlyHere);
    if (names.length > 1) assert.ok(flow.marginal, "a run with two or more engines says how many engines it needed");
    if (flow.marginal) assert.doesNotMatch(flow.marginal, /new origin|above/, `${file}: no order-dependent wording`);
  } else {
    assert.equal(flow.marginal, null);
    assert.equal(flow.needed, null);
  }
}
assert.ok(routed >= 1, "at least one saved run was routed by Telem (mcp/traces)");
process.stdout.write(`Origin flow check passed: ${files.length} saved runs, every page in one lane, engine rows add up (${routed} Telem-routed).\n`);
