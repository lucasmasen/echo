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
const { auditTrace } = load("../src/lib/echo/readiness.ts");
const filename = process.argv.find((arg, index) => index > 1 && !arg.startsWith("--"));
if (!filename || process.argv.includes("--help")) {
  process.stdout.write("Usage: npm run audit:trace -- path/to/trace.echo.json [--json]\nReads a saved trace locally; no search or model calls.\n");
  process.exitCode = process.argv.includes("--help") ? 0 : 1;
} else {
  try {
    const file = path.resolve(filename);
    if (fs.statSync(file).size > MAX_PORTABLE_TRACE_BYTES) throw new Error("Trace exceeds Echo's 2 MB import limit.");
    const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!analysis) throw new Error("Invalid or unsupported Echo trace.");
    const audit = auditTrace(analysis);
    if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    else {
      process.stdout.write(`Echo trace audit — ${audit.claim}\nCaptured: ${audit.createdAt} · ${audit.mode}\n`);
      process.stdout.write(`Coverage: ${audit.pages} pages · ${audit.domains} domains · ${audit.fullExtracts} extracted passages\n`);
      process.stdout.write(`Dates: ${audit.pageOrUrlDates} page/URL · ${audit.estimatedDates} search-estimated · ${audit.missingDates} missing · ${audit.unknownDateSources} source unrecorded\n`);
      process.stdout.write(`Relationships: ${audit.likelyEchoes} likely echoes · ${audit.possiblePaths} possible paths · ${audit.roots} candidate roots (${audit.rootsWithPrimaryEvidence} with primary evidence)\n`);
      process.stdout.write(`Failed searches: ${audit.failedQueries}\n`);
      process.stdout.write(`Answer: ${audit.answerStatus} · ${audit.citedRoots} cited roots · ${audit.rootsOmittedFromAnswer} roots outside source limit · ${audit.suppliedRootsNotCited} supplied but uncited\n`);
      if (audit.answerNumbersChecked) process.stdout.write(`Answer numbers: ${audit.answerNumbersChecked - audit.answerNumbersUnmatched.length}/${audit.answerNumbersChecked} found in cited passages${audit.answerNumbersUnmatched.length ? ` · not found: ${audit.answerNumbersUnmatched.map(({ number, statementIndex }) => `${number} (statement ${statementIndex + 1})`).join(", ")}` : ""}\n`);
      if (audit.answerStatements) process.stdout.write(`Manual answer check: ${audit.answerStatementsReviewed}/${audit.answerStatements} statements checked · ${audit.answerStatementsUnsupported} marked unsupported\n`);
      process.stdout.write(`Manual review recorded: ${audit.inspectedPages} inspected marks · ${audit.reviewNotePages} page notes · ${audit.sourceAssessments} source assessments (${audit.challengedSourceJudgments} challenged)\n`);
      process.stdout.write(`Review notes:\n${audit.notes.length ? audit.notes.map((note) => `- ${note}`).join("\n") : "- No automatic coverage flags. Manually check roots and major edges."}\n`);
    }
  } catch (error) {
    process.stderr.write(`Echo trace audit failed: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  }
}
