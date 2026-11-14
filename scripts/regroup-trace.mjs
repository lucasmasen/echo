// Re-run ONLY Echo's grouping request on saved traces with a chosen model, N times each, and report how far the new
// grouping moves from the saved one. Use it for the Haiku grouping A/B (ANTHROPIC_GROUPING_MODEL) before switching.
//   npm run regroup:trace -- [--model claude-haiku-5-5] [--runs 3] [--trace file.echo.json ...] [--json out.json] [--dry-run]
// Without --trace it uses every public/demo-traces/*.echo.json and evaluation/runs/*.echo.json search run (a saved
// Check these sources run, which searched nothing, is left out).
//
// Money: each pass is one grouping request (plus Claude's free token count), sent through the same claudeJson path
// as a live run, so it reserves, settles and is capped by Echo's $2 Pacific-day ledger in .echo/ like every paid
// script. Before the first request the script adds up a worst-case estimate for every pass (150 + prompt chars/2.5
// tokens, + 15%, the full 1,800-token output; real requests ran 150 + chars/2.8) and refuses to start when that exceeds what remains under today's cap.
// --dry-run prints that plan and estimate and sends nothing. No search credits are spent.
//
// What it can and cannot tell you:
//   - Saved traces keep only the pages the saved grouping kept. Pages it excluded as off-claim are not in the file,
//     so this measures whether the new model moves or wrongly excludes kept pages, NOT whether it would keep pages
//     the saved grouping excluded (each trace's excluded count is printed).
//   - Saved groups are unlabeled partitions. A page counts as "moved" when its new group is not the one matched to its
//     saved group (greedy one-to-one by overlap), so splits and merges both count. "Split pairs" counts page pairs that
//     shared a saved group and no longer share one (the judge only compares pages inside one group); "parent links
//     broken" counts saved derived/dashed links whose two pages are no longer in one group or one of them is excluded.
//   - Grouping is not deterministic: run the saved model too (--model claude-sonnet-5-5) to see its own run-to-run
//     noise before reading Haiku's numbers.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(code, filename);
};

export const DEFAULT_MODEL = "claude-haiku-5-5";
// Real Echo requests ran 150 + chars/2.8 tokens on the 11/13 live receipts; the worst case assumes denser text.
const CHARS_PER_TOKEN_WORST_CASE = 2.5;
const REQUEST_OVERHEAD_TOKENS = 150;
const TOKEN_COUNT_HEADROOM = 1.15; // the same headroom claudeJson reserves over Claude's token estimate

/**
 * True for a saved "Check these sources" run (analysis.sourceCheck): it read supplied links and searched nothing, so
 * the search-run measurements and A/Bs (measure:cost, regroup:trace, ab:cost) leave it out by default.
 */
export function isSuppliedLinksRun(file) {
  try { return Boolean(JSON.parse(fs.readFileSync(file, "utf8")).analysis?.sourceCheck); } catch { return false; }
}

/** Every saved search run: public/demo-traces and evaluation/runs, without supplied-links runs. */
export function defaultTraceFiles(root = projectRoot) {
  return ["public/demo-traces", "evaluation/runs"].flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((file) => file.endsWith(".echo.json")).sort().map((file) => path.join(root, dir, file))).filter((file) => !isSuppliedLinksRun(file));
}

/** Worst-case dollars for one grouping pass, sized the way the budget guard reserves it. */
export function worstCaseUsd(promptChars, schemaChars, price, maxTokens) {
  const inputTokens = Math.ceil((REQUEST_OVERHEAD_TOKENS + (promptChars + schemaChars) / CHARS_PER_TOKEN_WORST_CASE) * TOKEN_COUNT_HEADROOM);
  const tier = price.over100k && inputTokens > 100_000 ? price.over100k : price;
  return (inputTokens * tier.input + maxTokens * tier.output) / 1_000_000;
}

/** Compares a new grouping with the saved one. Saved groups hold only kept pages; excluded is a Set of page ids. */
export function compareGrouping(savedClusters, newClusters, excluded, pages) {
  const savedOf = new Map();
  savedClusters.forEach((cluster, index) => cluster.pageIds.forEach((id) => savedOf.set(id, index)));
  const newOf = new Map();
  newClusters.forEach((cluster, index) => cluster.pageIds.forEach((id) => newOf.set(id, index)));
  // Greedy one-to-one match of new groups to saved groups by shared pages.
  const overlaps = [];
  newClusters.forEach((cluster, newIndex) => {
    const counts = new Map();
    for (const id of cluster.pageIds) if (savedOf.has(id)) counts.set(savedOf.get(id), (counts.get(savedOf.get(id)) ?? 0) + 1);
    for (const [savedIndex, count] of counts) overlaps.push({ newIndex, savedIndex, count });
  });
  overlaps.sort((a, b) => b.count - a.count || a.savedIndex - b.savedIndex || a.newIndex - b.newIndex);
  const matchOfNew = new Map();
  const usedSaved = new Set();
  for (const { newIndex, savedIndex } of overlaps) {
    if (matchOfNew.has(newIndex) || usedSaved.has(savedIndex)) continue;
    matchOfNew.set(newIndex, savedIndex);
    usedSaved.add(savedIndex);
  }
  const ids = [...savedOf.keys()];
  const moved = ids.filter((id) => !excluded.has(id) && matchOfNew.get(newOf.get(id)) !== savedOf.get(id));
  const newlyExcluded = ids.filter((id) => excluded.has(id));
  let savedPairs = 0;
  let splitPairs = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      if (savedOf.get(ids[i]) !== savedOf.get(ids[j])) continue;
      savedPairs += 1;
      const together = !excluded.has(ids[i]) && !excluded.has(ids[j]) && newOf.get(ids[i]) === newOf.get(ids[j]);
      if (!together) splitPairs += 1;
    }
  }
  const byId = new Map(pages.map((page) => [page.id, page]));
  const links = pages.filter((page) => page.judgment?.parentId && byId.has(page.judgment.parentId));
  const brokenLinks = links.filter((page) => {
    const parent = page.judgment.parentId;
    return excluded.has(page.id) || excluded.has(parent) || newOf.get(page.id) !== newOf.get(parent);
  });
  const roots = new Set(pages.filter((page) => page.judgment?.kind === "origin").map((page) => page.id));
  return {
    savedGroups: savedClusters.length,
    newGroups: newClusters.length,
    moved,
    excluded: newlyExcluded,
    excludedRoots: newlyExcluded.filter((id) => roots.has(id)),
    savedPairs,
    splitPairs,
    parentLinks: links.length,
    brokenLinks: brokenLinks.map((page) => page.id),
    changed: moved.length > 0 || newlyExcluded.length > 0 || splitPairs > 0,
  };
}

/**
 * Plans, checks the budget, then runs every pass. Modules are loaded from the current working directory's ledger
 * (the CLI changes to the project root first, so it is the real one). Returns the report; throws before any request
 * when the estimate does not fit under today's cap.
 */
export async function regroupTraces({ files, model = DEFAULT_MODEL, runs = 1, dryRun = false, log = (line) => process.stdout.write(`${line}\n`) }) {
  const pipeline = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
  const { parsePortableTrace } = load(path.join(projectRoot, "src/lib/echo/portable.ts"));
  const { getAnthropicBudgetSnapshot } = load(path.join(projectRoot, "src/lib/echo/daily-budget.ts"));
  const { ReceiptDraft, runReceipt } = load(path.join(projectRoot, "src/lib/echo/cost-receipt.ts"));
  const price = pipeline.modelPriceUsdPerMillion(model);
  if (!price) throw Object.assign(new Error(`Echo's budget guard has no price for ${model}; nothing was sent.`), { code: "BUDGET_MODEL_UNSUPPORTED" });
  const schemaChars = 400; // CLUSTER_SCHEMA as sent is ~385 characters (measure:cost)

  const traces = files.map((file) => {
    const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!analysis) throw new Error(`${file} is not a valid Echo trace; nothing was sent.`);
    const promptChars = pipeline.groupingPrompt(analysis.claim, analysis.pages).length;
    return { file, name: path.basename(file).replace(/\.echo\.json$/, ""), analysis, promptChars, worstUsd: worstCaseUsd(promptChars, schemaChars, price, pipeline.GROUPING_MAX_TOKENS) };
  });
  const passes = traces.length * runs;
  const worstTotal = traces.reduce((total, trace) => total + trace.worstUsd, 0) * runs;
  const snapshot = await getAnthropicBudgetSnapshot();
  // Grouping requests are Claude's only: what is left under Claude's own daily cap (daily-budget.ts).
  const claude = snapshot.providers.claude;
  const remaining = Math.max(0, claude.capUsd - claude.spentUsd - claude.reservedUsd);
  log(`Regroup with ${model}: ${traces.length} traces x ${runs} ${runs === 1 ? "run" : "runs"} = ${passes} grouping requests, worst case $${worstTotal.toFixed(4)}; $${remaining.toFixed(4)} remains of today's $${claude.capUsd.toFixed(2)} Claude cap (${snapshot.storage} ledger, ${snapshot.day}).`);
  if (!snapshot.available) throw Object.assign(new Error("The budget ledger is unavailable here, so no request was sent."), { code: "BUDGET_STORAGE_UNAVAILABLE" });
  if (worstTotal > remaining + 1e-9) {
    throw Object.assign(new Error(`The worst-case estimate ($${worstTotal.toFixed(4)}) is more than the $${remaining.toFixed(4)} left under today's Claude cap; nothing was sent. Use fewer --runs or --trace files.`), { code: "DAILY_BUDGET_REACHED" });
  }
  if (dryRun) {
    for (const trace of traces) log(`  ${trace.name.padEnd(48)} ${String(trace.analysis.pages.length).padStart(2)} pages, ${trace.analysis.clusters.length} saved groups, ${trace.analysis.excludedPageCount ?? 0} excluded earlier (not in file), prompt ${trace.promptChars} chars, worst case $${trace.worstUsd.toFixed(4)} a pass`);
    return { model, runs, passes: 0, worstTotal, rows: [], spentUsd: 0 };
  }

  const rows = [];
  let stopped = null;
  outer: for (let run = 1; run <= runs; run += 1) {
    for (const trace of traces) {
      const draft = new ReceiptDraft(0);
      const row = { trace: trace.name, run, model };
      try {
        const result = await runReceipt.run(draft, () => draft.time("grouping", () => pipeline.clusterPages(trace.analysis.claim, trace.analysis.pages, undefined, model)));
        Object.assign(row, compareGrouping(trace.analysis.clusters, result.clusters, result.excludedPageIds, trace.analysis.pages));
      } catch (error) {
        row.error = `${error?.code ?? "ERROR"}: ${error instanceof Error ? error.message : String(error)}`;
        // A budget or auth stop ends the whole job; a malformed answer is recorded and the next pass goes on.
        if (["DAILY_BUDGET_REACHED", "BUDGET_LEDGER_ERROR", "BUDGET_LOCK_ERROR", "BUDGET_LOCK_TIMEOUT", "BUDGET_STORE_ERROR", "BUDGET_STORAGE_UNAVAILABLE", "BUDGET_ESTIMATE_ERROR", "CLAUDE_AUTH", "MISSING_KEYS"].includes(error?.code)) stopped = row.error;
      }
      const receipt = draft.finish();
      row.requests = receipt.claude.length;
      row.inputTokens = receipt.claude.reduce((total, entry) => total + entry.inputTokens, 0);
      row.outputTokens = receipt.claude.reduce((total, entry) => total + entry.outputTokens, 0);
      row.usd = receipt.usd.claude;
      row.ms = receipt.stageMs.grouping; // the grouping request's wall time (token count, request, retries)
      rows.push(row);
      log(row.error
        ? `  ${trace.name.slice(0, 46).padEnd(47)} #${run} failed: ${row.error}`
        : `  ${trace.name.slice(0, 46).padEnd(47)} #${run} groups ${row.savedGroups}->${row.newGroups} · moved ${row.moved.length} · excluded ${row.excluded.length} (${row.excludedRoots.length} roots) · split pairs ${row.splitPairs}/${row.savedPairs} · parent links broken ${row.brokenLinks.length}/${row.parentLinks} · ${row.inputTokens}/${row.outputTokens} tok $${row.usd.toFixed(5)}`);
      if (stopped) break outer;
    }
  }
  const done = rows.filter((row) => !row.error);
  const sum = (pick) => done.reduce((total, row) => total + pick(row), 0);
  const spentUsd = rows.reduce((total, row) => total + row.usd, 0);
  log(`\n${model}: ${done.length} of ${rows.length} passes completed${stopped ? ` (stopped: ${stopped})` : ""}; ${done.filter((row) => row.changed).length} changed the grouping.`);
  if (done.length) {
    log(`  pages moved ${sum((row) => row.moved.length)} (max ${Math.max(...done.map((row) => row.moved.length))} in one pass), excluded ${sum((row) => row.excluded.length)} (${sum((row) => row.excludedRoots.length)} roots), split pairs ${sum((row) => row.splitPairs)} of ${sum((row) => row.savedPairs)}, parent links broken ${sum((row) => row.brokenLinks.length)} of ${sum((row) => row.parentLinks)}.`);
  }
  log(`  cost $${spentUsd.toFixed(4)} (${rows.reduce((total, row) => total + row.requests, 0)} paid requests; $${(spentUsd / Math.max(1, rows.length)).toFixed(5)} a pass), charged to the daily ledger.`);
  return { model, runs, passes: rows.length, worstTotal, rows, spentUsd, stopped };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const values = (name) => args.flatMap((arg, index) => (arg === `--${name}` && args[index + 1] ? [args[index + 1]] : []));
  const option = (name, fallback) => values(name).at(-1) ?? fallback;
  const dryRun = args.includes("--dry-run");
  if (args.includes("--help")) {
    process.stdout.write("Usage: npm run regroup:trace -- [--model claude-haiku-5-5] [--runs 3] [--trace file.echo.json ...] [--json out.json] [--dry-run]\n");
    process.exit(0);
  }
  const model = option("model", DEFAULT_MODEL);
  const runs = Math.max(1, Math.min(5, Math.floor(Number(option("runs", 1))) || 1));
  const traceArgs = values("trace").map((file) => path.resolve(file));
  const jsonOut = option("json", null);
  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    process.stdout.write("ANTHROPIC_API_KEY is not set (this script reads .env.local through the npm script).\n");
    process.exit(1);
  }
  const files = traceArgs.length ? traceArgs : defaultTraceFiles();
  if (jsonOut) fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  const jsonPath = jsonOut ? path.resolve(jsonOut) : null;
  process.chdir(projectRoot); // the budget ledger lives in .echo/ under the project, as for every paid script
  try {
    const report = await regroupTraces({ files, model, runs, dryRun });
    if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    if (report.stopped) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
