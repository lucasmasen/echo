// Demo-day preflight: no search or model calls, no spending.
//   npm run preflight           checks the bundled demo traces, their scores and the offline cache list
//   npm run preflight -- --serve also starts the production build on a spare port and fetches every file the
//                                service worker must cache for offline mode (run `npm run build` first)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const load = createRequire(import.meta.url);
load.extensions[".ts"] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  module._compile(code, filename);
};
const { MAX_PORTABLE_TRACE_BYTES, parsePortableTrace } = load("../src/lib/echo/portable.ts");
const { parseLabelSheet, scoreTrace } = load("../src/lib/echo/evaluation.ts");

const failures = [];
const ok = (message) => process.stdout.write(`  ok    ${message}\n`);
const fail = (message) => { failures.push(message); process.stdout.write(`  FAIL  ${message}\n`); };
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

process.stdout.write("Echo demo preflight\n\nDemo traces\n");
const workbench = read("src/app/demo-slots.ts");
const presetTraces = [...workbench.matchAll(/capturedTrace:\s*"([^"]+)"/g)].map((match) => match[1]);
const swTraces = [...read("public/sw.js").matchAll(/"(\/demo-traces\/[^"]+)"/g)].map((match) => match[1]);
if (!presetTraces.length) fail("no demo slots with a captured trace found in src/app/demo-slots.ts");
const missingFromCache = presetTraces.filter((trace) => !swTraces.includes(trace));
if (missingFromCache.length) fail(`demo traces not cached for offline use in public/sw.js: ${missingFromCache.join(", ")}`);
else ok(`all ${presetTraces.length} demo slot traces are in the offline cache list`);

const baseline = JSON.parse(read("evaluation/demo-baseline.json"));
for (const tracePath of presetTraces) {
  const file = path.join(root, "public", tracePath);
  const name = path.basename(tracePath, ".echo.json");
  if (!fs.existsSync(file)) { fail(`${tracePath} is missing`); continue; }
  if (fs.statSync(file).size > MAX_PORTABLE_TRACE_BYTES) { fail(`${tracePath} is over the 2 MB import limit`); continue; }
  const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!analysis) { fail(`${tracePath} does not pass Echo's import check (the slot would show the gray sample)`); continue; }
  if (analysis.mode !== "live") fail(`${tracePath} is not a live capture`);
  ok(`${name}: imports; ${analysis.summary.totalPages} pages → ${analysis.summary.independentOrigins} independent origins, ${analysis.summary.echoPercentage}% echo`);
  const labelsFile = path.join(root, "evaluation", `${name}.labels.json`);
  const expected = baseline[name];
  if (!fs.existsSync(labelsFile)) {
    if (expected) fail(`${name}: baseline exists but ${path.relative(root, labelsFile)} is missing`);
    else process.stdout.write(`  note  ${name}: no labels yet, so no score check\n`);
    continue;
  }
  const sheet = parseLabelSheet(JSON.parse(fs.readFileSync(labelsFile, "utf8")));
  if (!sheet) { fail(`${name}: label sheet is invalid`); continue; }
  const score = scoreTrace(analysis, sheet);
  if (!score.reviewed && !expected) { process.stdout.write(`  note  ${name}: label sheet not filled in yet, so no score check\n`); continue; }
  const summary = `${score.exactKinds}/${score.matched} kinds, ${score.settledMistakes} settled mistakes, ${score.abstentions} abstentions, exact parents ${score.exactEdges}/${score.derivedGold}`;
  if (!expected) { fail(`${name}: scored (${summary}) but has no entry in evaluation/demo-baseline.json`); continue; }
  const worse = [];
  if (score.settledMistakes > expected.settledMistakes) worse.push("more settled mistakes");
  if (score.exactKinds < expected.exactKinds) worse.push("fewer correct kinds");
  if (score.abstentions > expected.abstentions) worse.push("more abstentions");
  if (score.exactEdges < expected.exactEdges) worse.push("fewer exact parent links");
  if (worse.length) fail(`${name}: score dropped below the recorded baseline (${worse.join(", ")}): ${summary}`);
  else ok(`${name}: ${summary} (baseline held)`);
}

// The saved Check these sources run (demo-slots.ts SAVED_SOURCE_CHECK): offline-cached, imports, and is the run of
// exactly the links its button and the failed-run fallback name.
const savedCheckTrace = workbench.match(/savedTrace:\s*"([^"]+)"/)?.[1];
if (!savedCheckTrace) fail("no saved Check these sources run (savedTrace) found in src/app/demo-slots.ts");
else {
  const file = path.join(root, "public", savedCheckTrace);
  const analysis = fs.existsSync(file) ? parsePortableTrace(JSON.parse(fs.readFileSync(file, "utf8"))) : null;
  const urls = [...(workbench.slice(workbench.indexOf("SAVED_SOURCE_CHECK")).match(/urls: \[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (!swTraces.includes(savedCheckTrace)) fail(`${savedCheckTrace} is not in public/sw.js's offline cache list`);
  else if (!analysis) fail(`${savedCheckTrace} is missing or does not pass Echo's import check`);
  else if (analysis.mode !== "live" || !analysis.sourceCheck) fail(`${savedCheckTrace} is not a live Check these sources run`);
  else if (JSON.stringify(analysis.sourceCheck.urls) !== JSON.stringify(urls)) fail(`${savedCheckTrace}'s links differ from SAVED_SOURCE_CHECK.urls in demo-slots.ts`);
  else ok(`saved Check these sources run: offline-cached, imports; ${analysis.sourceCheck.urls.length} supplied links → ${analysis.summary.independentOrigins} independent origin${analysis.summary.independentOrigins === 1 ? "" : "s"}`);
}

// Every saved evaluation run must load too: the accuracy card lists them, and a trace the import check rejects
// would also fail to reopen in the app (11/12: two live traces failed after the citation rules changed).
const runDir = path.join(root, "evaluation", "runs");
const runFiles = fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((file) => file.endsWith(".echo.json")) : [];
const unreadableRuns = runFiles.filter((file) => !parsePortableTrace(JSON.parse(fs.readFileSync(path.join(runDir, file), "utf8"))));
if (unreadableRuns.length) fail(`saved runs that fail Echo's import check: ${unreadableRuns.join(", ")}`);
else ok(`all ${runFiles.length} saved evaluation runs pass the import check`);

process.stdout.write("\nAccuracy card\n");
{
  const { computeDemoScores, renderDemoScores } = await import("./demo-scores.mjs");
  const stored = fs.readFileSync(path.join(root, "src/lib/echo/demo-scores.ts"), "utf8");
  if (stored !== renderDemoScores(computeDemoScores())) fail("the app's accuracy card is out of date: run `npm run eval:demo-scores`, then rebuild");
  else ok("the app's accuracy card matches the current traces and labels");
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function checkServer() {
  process.stdout.write("\nProduction build (offline cache)\n");
  if (!fs.existsSync(path.join(root, ".next", "BUILD_ID"))) { fail("no production build: run `npm run build` first"); return; }
  const port = await freePort();
  const server = spawn(path.join(root, "node_modules", ".bin", "next"), ["start", "-p", String(port), "-H", "127.0.0.1"], { cwd: root, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    let home = null;
    for (let attempt = 0; attempt < 60 && !home; attempt += 1) {
      try {
        const response = await fetch(`${base}/`);
        if (response.ok) home = await response.text();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!home) { fail("production server did not answer within 15 seconds"); return; }
    ok(`production build serves the app on port ${port}`);
    // The same list public/sw.js caches on install; one failed file means no offline mode at all.
    const assets = [...new Set([
      ...[...home.matchAll(/(?:src|href)=["']([^"']*\/_next\/static\/[^"']+)["']/g)].map((match) => match[1]),
      "/sw.js", "/manifest.webmanifest", "/icon.svg", ...swTraces,
    ])];
    const broken = [];
    for (const asset of assets) {
      const response = await fetch(new URL(asset, base));
      if (!response.ok) broken.push(`${asset} (${response.status})`);
      await response.arrayBuffer();
    }
    if (broken.length) fail(`offline cache would fail to install; these files did not load: ${broken.join(", ")}`);
    else ok(`all ${assets.length} files the offline cache needs load from the production build`);
    // The saved Check these sources run, as the service worker caches it: served by the build, and it imports.
    if (savedCheckTrace) {
      const response = await fetch(new URL(savedCheckTrace, base));
      const served = response.ok ? parsePortableTrace(await response.json().catch(() => null)) : null;
      if (!served?.sourceCheck) fail(`the build does not serve ${savedCheckTrace} as an importable Check these sources run (${response.status})`);
      else ok(`the build serves ${savedCheckTrace} (precached for offline), and it imports`);
    }
    if (!home.includes("Zombie stat") || !home.includes("Ghost stat")) fail("the home page does not show both demo slots");
    else ok("home page shows both demo slots");
  } finally {
    server.kill();
  }
}

if (process.argv.includes("--serve")) await checkServer();
else process.stdout.write("\n  note  add `-- --serve` after `npm run build` to also test the production build's offline files\n");

process.stdout.write(failures.length ? `\nPreflight FAILED (${failures.length}). Fix these before presenting.\n` : "\nPreflight passed. Still do the manual wifi-off reload in DEMO_DAY.md once.\n");
process.exitCode = failures.length ? 1 : 0;
