import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const { makePortableTrace } = load("../src/lib/echo/portable.ts");
const { makeLabelSheet, parseLabelSheet, scoreTrace } = load("../src/lib/echo/evaluation.ts");
const analysis = cloneDemoAnalysis("brain");
assert.ok(analysis);
analysis.reviewNotesByPageId = { [analysis.pages[0].id]: "Reviewer saw a date on the original page." };
const sheet = makeLabelSheet(analysis);
assert.equal(sheet.labels[0].note, analysis.reviewNotesByPageId[analysis.pages[0].id]);
assert.equal(sheet.labels[0].expectedKind, null, "a review note must not silently become a classification label");
sheet.labels[0].expectedKind = "origin";
sheet.labels[1].expectedKind = "origin";
sheet.labels[2].expectedKind = "derived";
sheet.labels[2].expectedParentKey = sheet.labels[0].sourceKey;
assert.ok(parseLabelSheet(sheet));
const baseline = scoreTrace(analysis, sheet);
assert.equal(baseline.matched, 3);
assert.equal(baseline.exactKinds, 3);
assert.equal(baseline.exactEdges, 1);
assert.equal(baseline.kindAccuracy, 1);

const rerun = structuredClone(analysis);
rerun.pages = rerun.pages.map((page) => ({ ...page, id: `new-${page.id}`, judgment: { ...page.judgment, parentId: page.judgment.parentId ? `new-${page.judgment.parentId}` : null } }));
assert.equal(scoreTrace(rerun, sheet).exactEdges, 1, "new page IDs should not break URL/title-based labels");
rerun.pages[2].judgment.parentId = rerun.pages[1].id;
assert.equal(scoreTrace(rerun, sheet).exactEdges, 0, "a wrong parent must be counted even when the kind matches");
assert.equal(scoreTrace(rerun, sheet).sameWorkEdges, 0, "a different page is not the same work");
// The expected parent's PubMed record (same distinctive title, dated within a year) is the same work, counted apart.
const twin = structuredClone(rerun);
const workTitle = "Knuckle cracking and hand osteoarthritis study";
twin.pages[0] = { ...twin.pages[0], title: workTitle, publishedDate: "2011-03-01" };
twin.pages[1] = { ...twin.pages[1], title: `${workTitle}.`, publishedDate: "2011-04-01" };
const twinSheet = makeLabelSheet(twin);
twinSheet.labels[0].expectedKind = "origin";
twinSheet.labels[1].expectedKind = "origin";
twinSheet.labels[2].expectedKind = "derived";
twinSheet.labels[2].expectedParentKey = twinSheet.labels[0].sourceKey;
const twinScore = scoreTrace(twin, twinSheet);
assert.equal(twinScore.exactEdges, 0, "exact parent links stay exact");
assert.equal(twinScore.sameWorkEdges, 1, "the same work at another address is counted as such");
rerun.pages[2].judgment.kind = "unclear";
assert.equal(scoreTrace(rerun, sheet).abstentions, 1);

const urlTrace = {
  claim: "A claim with stable URLs", mode: "live",
  pages: [
    { id: "old-root", title: "Original", domain: "example.org", url: "https://example.org/root?a=1&b=2", publishedDate: "2020-01-01", text: "Original reporting.", judgment: { kind: "origin", parentId: null } },
    { id: "old-copy", title: "Repeat", domain: "example.net", url: "https://example.net/copy", publishedDate: "2021-01-01", text: "Repeats reporting.", judgment: { kind: "derived", parentId: "old-root" } },
  ],
};
const urlLabels = makeLabelSheet(urlTrace);
urlLabels.labels[0].expectedKind = "origin";
urlLabels.labels[1].expectedKind = "derived";
urlLabels.labels[1].expectedParentKey = urlLabels.labels[0].sourceKey;
const urlRerun = structuredClone(urlTrace);
urlRerun.pages[0].id = "new-root";
urlRerun.pages[0].url = "https://example.org/root/?b=2&utm_source=rerun&a=1#section";
urlRerun.pages[1].judgment.parentId = "new-root";
assert.equal(scoreTrace(urlRerun, urlLabels).exactEdges, 1, "normalized URLs and new IDs should preserve a correct edge");

const invalid = structuredClone(sheet);
invalid.labels[2].expectedParentKey = "missing-source";
assert.equal(parseLabelSheet(invalid), null);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-eval-check-"));
try {
  const traceFile = path.join(tempDir, "fixture.echo.json");
  const labelsFile = path.join(tempDir, "labels.json");
  fs.writeFileSync(traceFile, JSON.stringify(makePortableTrace(analysis)));
  execFileSync(process.execPath, ["scripts/eval-trace.mjs", "init", traceFile, labelsFile], { encoding: "utf8" });
  assert.equal(JSON.parse(fs.readFileSync(labelsFile, "utf8")).labels[0].expectedKind, null);
  assert.equal(JSON.parse(fs.readFileSync(labelsFile, "utf8")).labels[0].note, analysis.reviewNotesByPageId[analysis.pages[0].id]);
  fs.writeFileSync(labelsFile, JSON.stringify(sheet));
  const output = execFileSync(process.execPath, ["scripts/eval-trace.mjs", "score", traceFile, labelsFile, "--json"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), baseline);
  process.stdout.write("Echo evaluation passed: stable labels, parent errors, abstentions, and local CLI scoring; no provider calls.\n");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
