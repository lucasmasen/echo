// Offline check of "Echo went looking" (src/lib/echo/upstream-fold.ts, src/app/origin-upstream-saved.json,
// scripts/origin-upstream.mjs): every saved look-up belongs to a real saved run and names its real origins, the fold
// arithmetic is recomputed here independently, the three look-ups measured on Nov 14 are pinned, and the script's free
// mode sends nothing. No provider call, no network, no cost.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
};
const { foldUpstream, upstreamQuery } = load(path.join(root, "src/lib/echo/upstream-fold.ts"));
const { originLayer, scoreLabel, ORIGIN_TYPE_WEIGHTS, NO_EVIDENCE_WEIGHT, SCORE_SCALE } = load(path.join(root, "src/lib/echo/origin-layer.ts"));
const { upstreamHints } = load(path.join(root, "src/lib/echo/upstream.ts"));

const saved = JSON.parse(fs.readFileSync(path.join(root, "src/app/origin-upstream-saved.json"), "utf8"));
const dirs = ["mcp/traces", "evaluation/known-limits", "public/demo-traces"];
const fileOf = (slug) => dirs.map((dir) => path.join(root, dir, `${slug}.echo.json`)).find((file) => fs.existsSync(file));
const scoreOf = (sum) => Math.round(100 * (1 - Math.exp(-sum / SCORE_SCALE)));
const words = (text) => text.trim().split(/\s+/).filter(Boolean).length;

// What the three look-ups found when they were measured (Nov 14): [folded, origins before, after, score before, after, page found].
const PINNED = {
  "telem-genai-pilots-2026-11-14": [6, 8, 3, 98, 67, true],
  "telem-brain-2026-11-14": [0, 3, 3, 10, 10, false],
  "telem-habit-2026-11-14": [0, 4, 4, 72, 72, false],
};
assert.ok(Object.keys(saved).length >= 1, "at least one look-up is saved");
for (const [slug, record] of Object.entries(saved)) {
  const file = fileOf(slug);
  assert.ok(file, `${slug}: the saved look-up belongs to a saved run`);
  const analysis = JSON.parse(fs.readFileSync(file, "utf8")).analysis;
  const layer = originLayer(analysis);
  assert.equal(record.version, 1);
  assert.equal(record.claim, analysis.claim, `${slug}: same claim`);
  assert.equal(record.traceCreatedAt, analysis.createdAt, `${slug}: measured on this very trace`);
  // The name is the one the shared-name rule finds, and the search is the one the pure builder gives for it.
  const hints = upstreamHints(analysis).filter((hint) => !hint.amongPages);
  assert.deepEqual(record.names, hints.map((hint) => hint.name), `${slug}: the names are the rule's`);
  assert.equal(record.name, hints[0].name);
  assert.equal(record.query, upstreamQuery(analysis.claim, record.names), `${slug}: the search Echo sent is the one the builder makes`);
  assert.ok(record.queries.length >= 1 && record.queries.length <= 2 && record.queries[0] === record.query, `${slug}: one search, a second only as a fallback`);
  assert.ok(Array.isArray(record.engines) && record.engines.every((name) => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)), `${slug}: engine names`);
  // Candidates are pages search had NOT already returned for the run.
  const known = new Set(analysis.pages.map((page) => page.url.replace(/\/$/, "")));
  assert.ok(record.candidates.length <= 5, `${slug}: at most five candidates`);
  for (const candidate of record.candidates) assert.ok(!known.has(candidate.url.replace(/\/$/, "")), `${slug}: ${candidate.url} was not already a page of the run`);
  if (record.upstream) {
    assert.ok(record.candidates.some((candidate) => candidate.url === record.upstream.url), `${slug}: the found page is one of the candidates`);
    assert.ok(record.upstream.type in ORIGIN_TYPE_WEIGHTS, `${slug}: the found page has a real origin type`);
  } else {
    assert.equal(record.upstreamShowsFigure, false, `${slug}: no page found, so no figure shown`);
  }
  // Every origin of the run has exactly one verdict, with a short reason.
  assert.deepEqual(record.origins.map((entry) => entry.id).sort(), layer.origins.map((origin) => origin.id).sort(), `${slug}: one verdict per origin of the run`);
  for (const entry of record.origins) {
    assert.ok(["yes", "no", "unclear"].includes(entry.cites), `${slug}: ${entry.id} cites`);
    assert.equal(typeof entry.independent, "boolean", `${slug}: ${entry.id} independent`);
    assert.equal(entry.name, layer.origins.find((origin) => origin.id === entry.id).name);
    assert.ok(entry.reason && words(entry.reason) <= 40, `${slug}: ${entry.id} has a short reason`);
  }
  assert.ok(record.usd > 0 && record.usd < 0.25, `${slug}: a few cents`);

  // The fold, recomputed here without the library.
  const fold = foldUpstream(layer, record);
  assert.deepEqual(fold.before, { origins: layer.origins.length, publishers: layer.entities, score: layer.score, label: layer.label }, `${slug}: before is the run's own origin layer`);
  const verdict = new Map(record.origins.map((entry) => [entry.id, entry]));
  const folds = (origin) => verdict.get(origin.id).cites === "yes" && !verdict.get(origin.id).independent;
  const kept = layer.origins.filter((origin) => !folds(origin));
  const folded = layer.origins.filter(folds);
  assert.deepEqual(fold.folded, folded.map((origin) => origin.name));
  assert.deepEqual(fold.kept, kept.map((origin) => origin.name));
  const perPublisher = new Map();
  for (const origin of kept) {
    const held = perPublisher.get(origin.entity);
    if (!held || (origin.counted && !held.counted)) perPublisher.set(origin.entity, origin);
  }
  let sum = [...perPublisher.values()].reduce((total, origin) => total + (origin.ownEvidence ? ORIGIN_TYPE_WEIGHTS[origin.type] : NO_EVIDENCE_WEIGHT), 0);
  const counted = Boolean(record.upstream) || folded.length > 0;
  if (counted) sum += record.upstream && record.upstreamShowsFigure ? ORIGIN_TYPE_WEIGHTS[record.upstream.type] : NO_EVIDENCE_WEIGHT;
  assert.equal(fold.after.origins, kept.length + (counted ? 1 : 0), `${slug}: origins after the fold`);
  if (folded.length > 0) assert.equal(fold.after.origins, kept.length + 1, `${slug}: the folded origins become one`);
  assert.equal(fold.after.publishers, perPublisher.size + (counted ? 1 : 0));
  assert.equal(fold.after.score, scoreOf(sum), `${slug}: the score is recomputed from the weights`);
  assert.equal(fold.after.label, scoreLabel(fold.after.score));
  assert.ok(Math.abs(fold.weights.reduce((total, entry) => total + entry.weight, 0) - sum) < 1e-9, `${slug}: the listed weights are the sum`);
  if (!counted) assert.deepEqual(fold.after, fold.before, `${slug}: nothing folded and nothing found changes nothing`);
  const pinned = PINNED[slug];
  if (pinned) assert.deepEqual([fold.folded.length, fold.before.origins, fold.after.origins, fold.before.score, fold.after.score, Boolean(record.upstream)], pinned, `${slug}: as measured on Nov 14`);
}

// Made-up layers: the rule's branches.
const origin = (id, entity, type, ownEvidence, counted = true) => ({ id, name: `${entity}.com`, entity, type, ownEvidence, counted, weight: ownEvidence ? ORIGIN_TYPE_WEIGHTS[type] : NO_EVIDENCE_WEIGHT });
const layerOf = (origins) => {
  const sum = origins.filter((entry) => entry.counted).reduce((total, entry) => total + entry.weight, 0);
  return { origins, entities: new Set(origins.map((entry) => entry.entity)).size, score: scoreOf(sum), label: scoreLabel(scoreOf(sum)) };
};
const says = (id, cites, independent = false) => ({ id, name: "x", cites, independent, reason: "made up" });
const three = layerOf([origin("a", "alpha", "original_reporting", true), origin("b", "beta", "original_reporting", true), origin("c", "gamma", "unknown", false)]);
// Nothing rests on the document and no page was found: nothing changes.
assert.deepEqual(foldUpstream(three, { name: "Doc", upstream: null, upstreamShowsFigure: false, origins: [says("a", "no"), says("b", "unclear"), says("c", "no")] }).after, foldUpstream(three, { name: "Doc", upstream: null, upstreamShowsFigure: false, origins: [] }).before);
// Two rest on a document Echo did not retrieve: they become one origin with no evidence of its own.
const twoFold = foldUpstream(three, { name: "Doc", upstream: null, upstreamShowsFigure: false, origins: [says("a", "yes"), says("b", "yes"), says("c", "no")] });
assert.deepEqual([twoFold.after.origins, twoFold.after.publishers, twoFold.after.score, twoFold.upstreamFound, twoFold.upstreamCounted], [2, 2, scoreOf(NO_EVIDENCE_WEIGHT * 2), false, true]);
assert.ok(twoFold.after.score < twoFold.before.score, "folding write-ups of one document lowers the score");
// An origin that cites the document but brings evidence of its own is kept.
const stands = foldUpstream(three, { name: "Doc", upstream: null, upstreamShowsFigure: false, origins: [says("a", "yes", true), says("b", "yes"), says("c", "no")] });
assert.deepEqual([stands.folded, stands.citesButStands, stands.after.origins], [["beta.com"], ["alpha.com"], 3]);
// The found page counts at its type's weight only when it shows the figure itself.
const page = { title: "The Doc", url: "https://doc.org/doc.pdf", domain: "doc.org", date: null, type: "primary_document" };
const shown = foldUpstream(three, { name: "Doc", upstream: page, upstreamShowsFigure: true, origins: [says("a", "yes"), says("b", "yes"), says("c", "no")] });
const notShown = foldUpstream(three, { name: "Doc", upstream: page, upstreamShowsFigure: false, origins: [says("a", "yes"), says("b", "yes"), says("c", "no")] });
assert.equal(shown.after.score, scoreOf(ORIGIN_TYPE_WEIGHTS.primary_document + NO_EVIDENCE_WEIGHT));
assert.equal(notShown.after.score, scoreOf(NO_EVIDENCE_WEIGHT * 2));
// One publisher counts once among the origins that stay, also when its counted origin folds.
const twins = layerOf([origin("a", "alpha", "original_reporting", true, true), origin("b", "alpha", "original_reporting", true, false), origin("c", "gamma", "unknown", false)]);
const twinFold = foldUpstream(twins, { name: "Doc", upstream: null, upstreamShowsFigure: false, origins: [says("a", "yes"), says("b", "no"), says("c", "no")] });
assert.deepEqual([twinFold.after.origins, twinFold.after.publishers, twinFold.after.score], [3, 3, scoreOf(ORIGIN_TYPE_WEIGHTS.original_reporting + NO_EVIDENCE_WEIGHT * 2)]);
// The search string: the name quoted when it has a space, the claim's words, and the document-seeking words.
assert.equal(upstreamQuery("Cats sleep 20 hours a day.", ["Whisker Foundation", "WF"]), '"Whisker Foundation" WF Cats sleep 20 hours a day original report OR study OR book OR paper');
assert.equal(upstreamQuery("Cats sleep 20 hours a day.", ["WF"], true), "WF Cats sleep 20 hours a day");
assert.ok(upstreamQuery("x ".repeat(400), ["WF"]).length <= 390);

// The script: paid only with --spend, and the free mode never loads the pipeline (so it cannot send anything).
const script = fs.readFileSync(path.join(root, "scripts/origin-upstream.mjs"), "utf8");
assert.match(script, /const dry = !args\.includes\("--spend"\);/, "spending needs --spend");
assert.match(script, /const pipeline = dry \? null : load\(/, "the free mode does not load the pipeline");
assert.ok(!/\bfetch\(/.test(script), "the script sends nothing itself");
const free = execFileSync(process.execPath, [path.join(root, "scripts/origin-upstream.mjs")], { cwd: root, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
assert.match(free, /Nothing was sent\./, "the free mode says nothing was sent");
assert.ok(!/searched:/.test(free), "the free mode searches nothing");
// The pipeline's part goes through the guarded helpers and has no request of its own.
const pipelineSource = fs.readFileSync(path.join(root, "src/lib/echo/pipeline.ts"), "utf8");
const part = pipelineSource.slice(pipelineSource.indexOf('// Origin layer: "Echo went looking"'));
assert.ok(part.length > 500 && part.includes("export async function findUpstream"), "findUpstream is in the pipeline");
assert.ok(!/\bfetch\(/.test(part), "findUpstream makes no request of its own");
for (const helper of ["telemSearch(", "claudeJson<", "runReceipt.run(", "tavilyPost<"]) assert.ok(part.includes(helper), `findUpstream goes through ${helper}`);
// Nothing in the app calls it: it runs only from the script.
const callers = [];
const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (/\.(ts|tsx)$/.test(entry.name) && fs.readFileSync(full, "utf8").includes("findUpstream(") && !full.endsWith("pipeline.ts")) callers.push(full); } };
walk(path.join(root, "src"));
assert.deepEqual(callers, [], "no page or route can start a look-up");
process.stdout.write(`Origin upstream check passed: ${Object.keys(saved).length} saved look-ups match their runs, the fold is recomputed independently, ${Object.keys(PINNED).length} are pinned as measured, and the script's free mode sends nothing.\n`);
