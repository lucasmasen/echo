// Offline check of the shared-name hint (src/lib/echo/upstream.ts): names that most of a run's origins mention in the
// passage Echo saved. It pins what the rule finds on every saved run (so a change to the rule shows up here), and
// checks the rule's guards on made-up runs. No provider call, no network, no cost.
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
const { upstreamHints, pageNames } = load(path.join(root, "src/lib/echo/upstream.ts"));
const { originLayer } = load(path.join(root, "src/lib/echo/origin-layer.ts"));

const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).analysis;
const dirs = ["mcp/traces", "public/demo-traces", "evaluation/known-limits"];
const files = dirs.flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith(".echo.json")).map((name) => path.join(dir, name)));
assert.ok(files.length >= 14, "the saved runs are there");

// What the rule finds today, as "name origins/of". A run not listed must give no hint at all.
const PINNED = {
  "telem-brain-2026-11-14": ["William James 3/3", "Energies of Men 2/3"],
  "telem-habit-2026-11-14": ["Maxwell Maltz 3/4"],
  "telem-hours-2026-11-14": ["Malcolm Gladwell 4/5", "Anders Ericsson 3/5"],
  "telem-genai-pilots-2026-11-14": ["MIT 6/7", "NANDA 5/7", "Project NANDA 4/7"],
};
let hinted = 0;
for (const file of files) {
  const analysis = read(file);
  const hints = upstreamHints(analysis);
  const layer = originLayer(analysis);
  const publishers = layer.origins.filter((origin) => origin.counted).length;
  const key = path.basename(file).replace(".echo.json", "");
  assert.deepEqual(hints.map((hint) => `${hint.name} ${hint.origins}/${hint.of}`), PINNED[key] ?? [], `${file}: the names the rule finds`);
  for (const hint of hints) {
    hinted += 1;
    assert.equal(hint.of, publishers, `${file}: counted against the run's origin publishers`);
    assert.ok(hint.origins >= Math.max(2, Math.ceil(publishers / 2)) && hint.origins <= publishers, `${file}: at least half the publishers, and at least two`);
    assert.equal(hint.originNames.length, hint.origins);
    assert.ok(!analysis.claim.toLowerCase().includes(hint.name.toLowerCase()), `${file}: a name is never the claim's own words`);
    // Every origin named really has the name in a saved passage or title.
    for (const name of hint.originNames) {
      const origin = layer.origins.find((entry) => entry.name === name && entry.counted);
      const text = origin.pageIds.map((id) => analysis.pages.find((page) => page.id === id)).map((page) => `${page.title} ${page.text ?? ""}`).join(" ").toLowerCase();
      assert.ok(text.includes(hint.name.toLowerCase()), `${file}: ${name} really mentions ${hint.name}`);
    }
  }
}
// The wider rule (names many of a run s sites mention), pinned on the Telem runs the page shows it for.
const PAGE_PINNED = { "telem-brain-2026-11-14": "William James 6/20", "telem-habit-2026-11-14": "Maxwell Maltz 11/19", "telem-water-2026-11-14": "Food and Nutrition Board 6/20", "telem-hours-2026-11-14": "Malcolm Gladwell 16/20", "telem-nonverbal-2026-11-14": "Albert Mehrabian 9/20", "telem-dunbar-2026-11-14": "Robin Dunbar 7/19" };
for (const file of files.filter((name) => name.startsWith("mcp/traces"))) {
  const key = path.basename(file).replace(".echo.json", "");
  const lead = pageNames(read(file)).filter((name) => !name.amongPages)[0];
  assert.equal(lead ? `${lead.name} ${lead.sites}/${lead.of}` : null, PAGE_PINNED[key] ?? null, `${file}: the name its pages point at`);
  if (lead) assert.ok(lead.sites >= 3 && lead.sites <= lead.of);
}
// The run Echo got wrong is flagged; the cleanest single-origin run is not.
assert.ok(upstreamHints(read("evaluation/known-limits/telem-genai-pilots-2026-11-14.echo.json")).length > 0, "the known-limit run is flagged");
assert.deepEqual(upstreamHints(read("mcp/traces/telem-phones-2026-11-14.echo.json")), [], "one origin: nothing to share");

// Made-up runs: three origin pages from three publishers.
const page = (id, domain, text, title = "A page") => ({ id, title, url: `https://${domain}/x`, domain, publishedDate: "2026-01-01", text, hasPrimaryEvidence: true, judgment: { kind: "origin", parentId: null, confidence: 70, evidence: "made up" } });
const run = (claim, texts) => {
  const pages = texts.map((text, index) => page(`page-${index + 1}`, ["alpha.com", "beta.org", "gamma.net"][index], text));
  return { claim, pages, roots: pages.map((entry) => entry.id), coPublishedRootGroups: [] };
};
const shared = run("Cats sleep 20 hours a day", ["A report by the Whisker Foundation says so.", "According to the Whisker Foundation, cats rest a lot.", "Nobody knows where this started."]);
assert.deepEqual(upstreamHints(shared).map((hint) => [hint.name, hint.origins, hint.of]), [["Whisker Foundation", 2, 3]], "a name two of three origins share");
assert.deepEqual(upstreamHints(run("Cats sleep 20 hours a day", ["The Whisker Foundation says so.", "Cats rest.", "Dogs bark."])), [], "one origin naming it is not a shared name");
assert.deepEqual(upstreamHints(run("The Whisker Foundation says cats sleep 20 hours", ["The Whisker Foundation says so.", "The Whisker Foundation again.", "x"])), [], "the claim's own words are the topic, not a source");
assert.deepEqual(upstreamHints(run("Cats sleep 20 hours a day", ["Cats Sleep A Lot, Study Says. Sleeping Cats are common.", "Sleeping Cats again. Cats Sleep.", "x"])), [], "headline words that restate the claim are not a name");
const self = run("Cats sleep 20 hours a day", ["Alpha Labs found this.", "Alpha Labs is cited here.", "Alpha Labs again."]);
assert.deepEqual(upstreamHints(self).map((hint) => [hint.name, hint.origins]), [["Alpha Labs", 2]], "a publisher naming itself does not count for that publisher");
assert.equal(upstreamHints(self)[0].amongPages, false);
process.stdout.write(`Upstream hint check passed: ${files.length} saved runs pinned (${hinted} shared names on ${Object.keys(PINNED).length} runs, none elsewhere) and the rule's guards hold on made-up runs.\n`);
