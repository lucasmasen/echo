// Run one live Echo trace from the terminal, exactly as the app does (same pipeline, same per-provider Pacific-day caps
// and ledger), save it as a portable trace, and optionally score it against a label sheet. Costs about $0.15-0.25;
// --deep makes a Deep search run (search-mode.ts; estimate ≈$0.4-1.1, up to 16 searches and 50 pages).
//   npm run trace:claim -- "Claim text" [out.echo.json] [--labels labels.json] [--deep]
// Unlike pretest:claim, every search and model call goes through the daily-cap ledger.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(code, filename);
};

const args = process.argv.slice(2);
const labelsAt = args.indexOf("--labels");
const labelsPath = labelsAt >= 0 ? args[labelsAt + 1] : null;
const [claim, outArg] = args.filter((arg, index) => !arg.startsWith("--") && (labelsAt < 0 || index !== labelsAt + 1));
if (!claim) {
  process.stdout.write('Usage: npm run trace:claim -- "Claim text" [out.echo.json] [--labels labels.json] [--deep]\n');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY || !process.env.TAVILY_API_KEY) {
  process.stdout.write("ANTHROPIC_API_KEY and TAVILY_API_KEY must be set (this script reads .env.local through the npm script).\n");
  process.exit(1);
}
const slug = claim.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
const outPath = path.resolve(outArg ?? `${slug}.echo.json`);
process.chdir(projectRoot); // the budget ledger lives in .echo/ under the project
const { analyzeClaim } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
const { getAnthropicBudgetSnapshot } = load(path.join(projectRoot, "src/lib/echo/daily-budget.ts"));

const before = await getAnthropicBudgetSnapshot();
const started = Date.now();
// Time spent in each pipeline stage (search, extract, cluster, judge, answer), to see where a 30-55 s run goes.
const stageMs = new Map();
let currentStage = null;
let stageStarted = started;
const closeStage = (now) => {
  if (currentStage) stageMs.set(currentStage, (stageMs.get(currentStage) ?? 0) + now - stageStarted);
};
const onProgress = (event) => {
  const now = Date.now();
  if (event.stage !== currentStage) {
    closeStage(now);
    currentStage = event.stage;
    stageStarted = now;
  }
  process.stdout.write(`  ${((now - started) / 1000).toFixed(1).padStart(5)} s  ${event.stage ?? ""} · ${event.label ?? ""}${event.detail ? ` — ${event.detail}` : ""}\n`);
};
const stageLine = () => [...stageMs].map(([stage, ms]) => `${stage} ${(ms / 1000).toFixed(1)} s`).join(" · ");
let analysis;
try {
  analysis = await analyzeClaim(claim, onProgress, { forceFresh: true, ...(args.includes("--deep") ? { searchMode: "deep" } : {}) });
  closeStage(Date.now());
} catch (error) {
  // A daily-cap stop, missing keys or a provider failure: say what happened and what was spent, without a stack trace.
  const spent = (await getAnthropicBudgetSnapshot()).spentUsd - before.spentUsd;
  closeStage(Date.now());
  process.stdout.write(`\nNo trace saved. ${error?.code ? `${error.code}: ` : ""}${error instanceof Error ? error.message : String(error)}\nspent $${spent.toFixed(2)} on this attempt${stageMs.size ? `\nstages: ${stageLine()}` : ""}\n`);
  process.exit(1);
}
const seconds = Math.round((Date.now() - started) / 1000);
fs.writeFileSync(outPath, JSON.stringify({ format: "echo-trace", version: 1, exportedAt: new Date().toISOString(), analysis }, null, 2));
const after = await getAnthropicBudgetSnapshot();
const htmlLinks = analysis.pages.flatMap((page) => page.citations ?? []).filter((citation) => citation.quote.startsWith("This page's HTML links to")).length;
process.stdout.write(`\n${claim}${analysis.searchMode === "deep" ? " (DEEP SEARCH)" : ""}${analysis.searchFallback ? " (Telem's daily cap reached: searched with Tavily)" : ""}\n${seconds} s · ${analysis.summary.totalPages} pages · ${analysis.summary.independentOrigins} origins · ${analysis.summary.echoPercentage}% echo · answer ${analysis.answerStatus} · ${htmlLinks} HTML source links\n`);
process.stdout.write(`stages: ${stageLine()}\n`);
// One cap per provider (daily-budget.ts): this run's spend by provider, then today's against each cap.
const by = (name) => after.providers[name].spentUsd - before.providers[name].spentUsd;
const today = (name, label) => `${label} $${after.providers[name].spentUsd.toFixed(2)} of $${after.providers[name].capUsd.toFixed(2)}`;
process.stdout.write(`spent $${(after.spentUsd - before.spentUsd).toFixed(2)} (Claude $${by("claude").toFixed(2)}, Tavily $${by("tavily").toFixed(2)}, Telem $${by("telem").toFixed(2)}) · today ${today("claude", "Claude")}, ${today("tavily", "Tavily")}, ${today("telem", "Telem")} (Telem total $${after.telem.totalUsd.toFixed(2)} of $${after.telem.creditUsd} credit)\nsaved ${path.relative(projectRoot, outPath)}\n`);
if (labelsPath) {
  const { parseLabelSheet, scoreTrace } = load(path.join(projectRoot, "src/lib/echo/evaluation.ts"));
  const sheet = parseLabelSheet(JSON.parse(fs.readFileSync(path.resolve(labelsPath), "utf8")));
  if (!sheet) throw new Error("Not a valid label sheet.");
  const score = scoreTrace(analysis, sheet);
  process.stdout.write(`labels: ${score.exactKinds}/${score.matched} kinds · ${score.settledMistakes} wrong · ${score.abstentions} unclear · ${score.exactEdges} exact parent links\n`);
}
