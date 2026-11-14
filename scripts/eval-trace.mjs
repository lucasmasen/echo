import fs from "node:fs";
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
const { MAX_PORTABLE_TRACE_BYTES, parsePortableTrace } = load("../src/lib/echo/portable.ts");
const { makeLabelSheet, parseLabelSheet, scoreTrace } = load("../src/lib/echo/evaluation.ts");

const usage = "Usage:\n  npm run eval:trace -- init trace.echo.json labels.json\n  npm run eval:trace -- score trace.echo.json labels.json [--json]\nAll work is local; no search or model calls.\n";
const [command, tracePath, labelsPath] = process.argv.slice(2);
if (process.argv.includes("--help")) {
  process.stdout.write(usage);
} else if (!tracePath || !labelsPath || !["init", "score"].includes(command)) {
  process.stderr.write(usage);
  process.exitCode = 1;
} else {
  try {
    const traceFile = path.resolve(tracePath);
    if (fs.statSync(traceFile).size > MAX_PORTABLE_TRACE_BYTES) throw new Error("Trace exceeds Echo's 2 MB import limit.");
    const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(traceFile, "utf8")));
    if (!analysis) throw new Error("Invalid or unsupported Echo trace.");
    if (command === "init") {
      const sheet = makeLabelSheet(analysis);
      fs.writeFileSync(path.resolve(labelsPath), `${JSON.stringify(sheet, null, 2)}\n`, { flag: "wx" });
      process.stdout.write(`Created ${sheet.labels.length} source labels with blank expected kinds in ${path.resolve(labelsPath)}. Saved trace review notes were copied; open each source, then fill expectedKind and expectedParentKey. Existing files are never overwritten.\n`);
    } else {
      const sheet = parseLabelSheet(JSON.parse(fs.readFileSync(path.resolve(labelsPath), "utf8")));
      if (!sheet) throw new Error("Invalid label sheet. Derived labels need a different parent key from this sheet; other labels must have a null parent.");
      const score = scoreTrace(analysis, sheet);
      if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(score, null, 2)}\n`);
      else {
        const rate = (value) => value === null ? "n/a" : `${Math.round(value * 100)}%`;
        process.stdout.write(`Echo source evaluation — ${score.claim} (${score.mode})\n`);
        process.stdout.write(`${score.reviewed} reviewed labels · ${score.matched} pages in this trace · ${score.missingReviewed.length} labeled pages absent\n`);
        process.stdout.write(`Kind accuracy: ${score.exactKinds}/${score.matched} (${rate(score.kindAccuracy)}) · ${score.settledMistakes} settled mistakes · ${score.abstentions} abstentions\n`);
        process.stdout.write(`Derived detection: precision ${rate(score.derivedPrecision)} · recall ${rate(score.derivedRecall)} · exact parent links ${score.exactEdges}/${score.derivedGold} gold derived pages${score.sameWorkEdges ? ` (+${score.sameWorkEdges} naming the same work at another address)` : ""}\n`);
        process.stdout.write(`Disagreements: ${score.disagreements.length}\n${score.disagreements.length ? score.disagreements.map((entry) => `- ${entry.title}\n  expected ${entry.expected}\n  observed ${entry.observed}`).join("\n") : "- None among matched reviewed pages."}\n`);
        if (score.missingReviewed.length) process.stdout.write(`Labeled sources missing from this trace: ${score.missingReviewed.map((entry) => entry.title).join(", ")}\n`);
        if (score.mode === "demo") process.stdout.write("This is a synthetic rehearsal fixture; its score does not measure live source-judgment quality.\n");
        process.stdout.write("Scores measure agreement with the manually reviewed labels, not factual truth or web-wide coverage.\n");
      }
    }
  } catch (error) {
    process.stderr.write(`Echo evaluation failed: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  }
}
