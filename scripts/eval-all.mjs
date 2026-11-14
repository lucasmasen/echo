// Scores every saved trace that has a label sheet (bundled demo traces and evaluation/runs) in one table.
// Offline, no provider calls. Labels are AI-made from full pages unless a sheet says otherwise.
//   npm run eval:all [--replay]
// --replay also scores each run after re-applying the current post-judge guards (unsure origins left unresolved,
// cited undated pages linked, index records as copies, same-day wire copies as co-published origins) to its saved judgments: an offline estimate of what today's rules change, not a new run.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(code, filename);
};
const { parsePortableTrace } = load(path.join(root, "src/lib/echo/portable.ts"));
const { parseLabelSheet, scoreTrace } = load(path.join(root, "src/lib/echo/evaluation.ts"));
const replay = process.argv.includes("--replay");
const guards = replay ? load(path.join(root, "src/lib/echo/pipeline.ts")) : null;
const replayed = (analysis) => {
  const clusterByPage = new Map();
  for (const cluster of analysis.clusters) {
    const ids = new Set(cluster.pageIds);
    cluster.pageIds.forEach((id) => clusterByPage.set(id, ids));
  }
  return { ...analysis, pages: guards.coPublishedCopiesAsOrigins(guards.indexRecordsAsCopies(guards.linkCitedUndatedPages(guards.unsureOriginsUnclear(analysis.pages), clusterByPage), clusterByPage), clusterByPage) };
};

const sheets = new Map();
for (const file of fs.readdirSync(path.join(root, "evaluation")).filter((name) => name.endsWith(".labels.json"))) {
  const sheet = parseLabelSheet(JSON.parse(fs.readFileSync(path.join(root, "evaluation", file), "utf8")));
  if (sheet) sheets.set(file.replace(/\.labels\.json$/, ""), sheet);
}
const traces = [
  ...fs.readdirSync(path.join(root, "public/demo-traces")).map((file) => ({ file: `public/demo-traces/${file}`, bundled: true })),
  ...fs.readdirSync(path.join(root, "evaluation/runs")).map((file) => ({ file: `evaluation/runs/${file}`, bundled: false })),
].filter(({ file }) => file.endsWith(".echo.json"));

const rows = [];
let unreadable = 0;
for (const { file, bundled } of traces) {
  const name = path.basename(file).split(".")[0];
  const sheet = sheets.get(name);
  if (!sheet) continue;
  const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")));
  if (!analysis) { unreadable += 1; process.stdout.write(`UNREADABLE ${file}\n`); continue; }
  // A supplied-links run (the bundled check-these-sources-phones) has no label sheet of its own; it is never scored.
  if (analysis.sourceCheck) continue;
  const score = scoreTrace(analysis, sheet);
  const again = replay ? scoreTrace(replayed(analysis), sheet) : null;
  rows.push({ name, run: bundled ? "bundled" : path.basename(file).split(".")[1], created: analysis.createdAt.slice(0, 16).replace("T", " "), ...score, again });
}
rows.sort((a, b) => a.name.localeCompare(b.name) || a.created.localeCompare(b.created));
const pad = (value, width) => String(value).padEnd(width);
process.stdout.write(`${pad("claim", 36)}${pad("run", 18)}${pad("created (UTC)", 18)}${pad("match", 8)}${pad("wrong", 7)}${pad("unclear", 9)}${pad("exact parents", 15)}${replay ? "replayed: match/wrong/unclear/parents" : ""}\n`);
for (const row of rows) {
  process.stdout.write(`${pad(row.name.slice(0, 35), 36)}${pad(row.run, 18)}${pad(row.created, 18)}${pad(`${row.exactKinds}/${row.matched}`, 8)}${pad(row.settledMistakes, 7)}${pad(row.abstentions, 9)}${pad(`${row.exactEdges}/${row.derivedGold}`, 15)}${row.again ? `${row.again.exactKinds}/${row.again.matched} ${row.again.settledMistakes} ${row.again.abstentions} ${row.again.exactEdges}/${row.again.derivedGold}` : ""}\n`);
}
const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
process.stdout.write(`\n${rows.length} scored runs across ${new Set(rows.map((row) => row.name)).size} claims: ${total("exactKinds")}/${total("matched")} pages match, ${total("settledMistakes")} wrong, ${total("abstentions")} unclear, exact parents ${total("exactEdges")}/${total("derivedGold")}${total("sameWorkEdges") ? ` (+${total("sameWorkEdges")} naming the same work at another address)` : ""}.\n`);
if (replay) {
  const again = (key) => rows.reduce((sum, row) => sum + row.again[key], 0);
  process.stdout.write(`Replayed with current guards (offline estimate, not a new run): ${again("exactKinds")}/${again("matched")} match, ${again("settledMistakes")} wrong, ${again("abstentions")} unclear, exact parents ${again("exactEdges")}/${again("derivedGold")}${again("sameWorkEdges") ? ` (+${again("sameWorkEdges")} naming the same work at another address)` : ""}.\n`);
}
process.stdout.write("Labels are AI-made from full pages (see each sheet's reviewer field); runs before 2026-11-13 00:30 UTC (4:30pm PT, 11/12) used an earlier Echo.\n");
if (unreadable) process.exitCode = 1;
