// Re-run only Echo's source-judgment step on a saved trace and score it against a label sheet.
// It reuses the trace's retrieved pages and claim groups, so it costs one Claude call per run (about $0.05)
// and no search credits. Every call goes through Echo's $2 Pacific-day Anthropic guard and ledger.
//   npm run rejudge:trace -- trace.echo.json labels.json [--mode off|on|both] [--runs 2] [--out dir]
// --mode on turns on the retelling check (ECHO_RETELLING_CHECK); "both" runs the current judge as a control too.
// --links first fetches each page's HTML (free, direct) and adds the source-link citations a trace saved before
// ECHO_HTML_LINKS existed would lack, so old traces can be re-judged with what a live run now sees.
// --dates first re-reads publisher dates (free, direct) for pages whose saved date is missing or only estimated.
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

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const [tracePath, labelsPath] = args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
if (!tracePath || !labelsPath) {
  process.stdout.write("Usage: npm run rejudge:trace -- trace.echo.json labels.json [--mode off|on|both] [--runs 2] [--out dir] [--dates] [--links] [--details]\n");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  process.stdout.write("ANTHROPIC_API_KEY is not set (this script reads .env.local through the npm script).\n");
  process.exit(1);
}
const mode = option("mode", "both");
const runs = Math.max(1, Math.min(5, Number(option("runs", 1)) || 1));
const outDir = option("out", null);

process.chdir(projectRoot); // the budget ledger lives in .echo/ under the project
const { judgePages, findCitations, fetchPageFacts, fetchPublishedMetadataDetail } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));
const { parsePortableTrace } = load(path.join(projectRoot, "src/lib/echo/portable.ts"));
const { parseLabelSheet, scoreTrace } = load(path.join(projectRoot, "src/lib/echo/evaluation.ts"));

const trace = JSON.parse(fs.readFileSync(path.resolve(tracePath), "utf8"));
const analysis = parsePortableTrace(trace);
if (!analysis) throw new Error("Not a valid Echo trace file.");
const sheet = parseLabelSheet(JSON.parse(fs.readFileSync(path.resolve(labelsPath), "utf8")));
if (!sheet) throw new Error("Not a valid label sheet.");

if (args.includes("--dates")) {
  const trusted = new Set(["page text", "URL date", "page metadata"]);
  let upgraded = 0;
  analysis.pages = await Promise.all(analysis.pages.map(async (page) => {
    if (page.publishedDate && trusted.has(page.publishedDateSource ?? "")) return page;
    const detail = await fetchPublishedMetadataDetail(page.url, undefined, true);
    if (!detail) return page;
    upgraded += 1;
    return { ...page, publishedDate: detail.date, publishedDateSource: "page metadata", publishedDateEvidence: `Publisher's ${detail.field}, read from the page itself` };
  }));
  process.stdout.write(`--dates: ${upgraded} ${upgraded === 1 ? "page" : "pages"} now have a publisher date\n`);
}
if (args.includes("--links")) {
  const facts = new Map(await Promise.all(analysis.pages.map(async (page) => [page.id, await fetchPageFacts(page.url)])));
  const links = new Map([...facts].map(([id, fact]) => [id, fact.links]));
  // As in a live run: citations are also looked for in the page's own article text (trimmed reference lists).
  const fullText = new Map(analysis.pages.map((page) => [page.id, `${page.text}\n\n${facts.get(page.id)?.text ?? ""}`]));
  const dois = new Map([...facts].filter(([, fact]) => fact.doi).map(([id, fact]) => [id, fact.doi]));
  const found = findCitations(analysis.pages, fullText, analysis.claim, links, dois);
  let added = 0;
  analysis.pages = analysis.pages.map((page) => {
    const saved = page.citations ?? [];
    const extra = (found.get(page.id) ?? []).filter((citation) => !saved.some((old) => old.pageId === citation.pageId));
    added += extra.length;
    return extra.length ? { ...page, citations: [...saved, ...extra].slice(0, 8) } : page;
  });
  process.stdout.write(`--links: added ${added} ${added === 1 ? "citation" : "citations"} from the pages' HTML links and article text\n`);
}
const unjudged = analysis.pages.map((page) => {
  const copy = { ...page };
  for (const field of ["judgment", "hasPrimaryEvidence", "primaryEvidenceStatus", "primaryEvidenceReason"]) delete copy[field];
  return copy;
});
const describe = (label, pages) => {
  const score = scoreTrace({ ...analysis, pages }, sheet);
  const origins = pages.filter((page) => page.judgment.kind === "origin").length;
  const derived = pages.filter((page) => page.judgment.kind === "derived").length;
  return { label, matched: score.matched, exactKinds: score.exactKinds, settledMistakes: score.settledMistakes, abstentions: score.abstentions, exactEdges: score.exactEdges, origins, derived, disagreements: score.disagreements };
};
const print = (row) => process.stdout.write(`${row.label.padEnd(22)} ${row.exactKinds}/${row.matched} match · ${row.settledMistakes} wrong · ${row.abstentions} unclear · ${row.exactEdges} exact links · ${row.origins} origins, ${row.derived} derived\n`);

process.stdout.write(`${analysis.claim}\n`);
const results = [describe("saved trace", analysis.pages)];
print(results[0]);
const modes = mode === "both" ? [false, true] : [mode === "on"];
for (let run = 1; run <= runs; run += 1) {
  for (const retelling of modes) {
    const label = `${retelling ? "retelling on" : "current judge"} #${run}`;
    try {
      const pages = await judgePages(analysis.claim, unjudged, analysis.clusters, undefined, retelling);
      const row = describe(label, pages);
      results.push(row);
      print(row);
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        const slug = analysis.claim.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
        fs.writeFileSync(path.join(outDir, `${slug}.${retelling ? "on" : "off"}.${run}.echo.json`), JSON.stringify({ ...trace, analysis: { ...analysis, pages } }, null, 2));
      }
    } catch (error) {
      process.stdout.write(`${label.padEnd(22)} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
if (args.includes("--details")) {
  for (const row of results) {
    process.stdout.write(`\n${row.label}\n`);
    for (const item of row.disagreements) process.stdout.write(`  - ${item.title.slice(0, 70)}\n    expected ${item.expected.slice(0, 90)}\n    observed ${item.observed.slice(0, 90)}\n`);
  }
}
