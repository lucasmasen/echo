// Origin layer, "Echo went looking": for a saved run whose origins mostly name one outside document that no page of
// the run is (src/lib/echo/upstream.ts), search for that document once through Telem, ask the model once which found
// page is it and which origins attribute the claim to it, and save the result in src/app/origin-upstream-saved.json,
// so the panel can show the fold offline.
//   npm run origin:upstream                                    FREE (the default): prints the name, the search it would
//                                                              send and what the fold could look like; sends nothing
//   npm run origin:upstream -- --spend [trace.echo.json ...]   PAID: per trace, one Telem search (a second only when the
//                                                              first returns nothing usable), at most one Tavily read
//                                                              and one Claude call (about 10-20 cents), through Echo's
//                                                              daily budget guard; with no trace named, every saved
//                                                              run in mcp/traces and evaluation/known-limits
// Spending needs --spend typed after the "--". npm keeps flags typed before it for itself, so the default is the free one.
// --max-usd N stops before starting a trace once N dollars are spent in this call (default 0.60).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
};

const args = process.argv.slice(2);
const dry = !args.includes("--spend");
const force = args.includes("--force");
const maxAt = args.indexOf("--max-usd");
const maxUsd = maxAt >= 0 && Number(args[maxAt + 1]) > 0 ? Number(args[maxAt + 1]) : 0.6;
// One file, imported by the panel (origin-upstream.ts), so saved look-ups are in the build and work offline.
const outFile = path.join(projectRoot, "src/app/origin-upstream-saved.json");
const saved = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : {};
const files = args.filter((arg, index) => !arg.startsWith("--") && (maxAt < 0 || index !== maxAt + 1)).map((file) => path.resolve(file));
if (!files.length) {
  for (const dir of ["mcp/traces", "evaluation/known-limits"]) {
    const full = path.join(projectRoot, dir);
    if (fs.existsSync(full)) files.push(...fs.readdirSync(full).filter((name) => name.endsWith(".echo.json")).sort().map((name) => path.join(full, name)));
  }
}

process.chdir(projectRoot); // the budget ledger lives in .echo/ under the project
const { parsePortableTrace } = load(path.join(projectRoot, "src/lib/echo/portable.ts"));
const { originLayer, originTypeOf } = load(path.join(projectRoot, "src/lib/echo/origin-layer.ts"));
const { upstreamHints } = load(path.join(projectRoot, "src/lib/echo/upstream.ts"));
const { foldUpstream, upstreamQuery } = load(path.join(projectRoot, "src/lib/echo/upstream-fold.ts"));
if (!dry && (!process.env.ANTHROPIC_API_KEY || !process.env.TELEM_API_KEY)) {
  process.stdout.write("ANTHROPIC_API_KEY and TELEM_API_KEY must be set (this script reads .env.local through the npm script). Leave out --spend to see the search for free.\n");
  process.exit(1);
}
// The free mode never loads the pipeline: it only builds the search string (upstream-fold.ts, pure).
const pipeline = dry ? null : load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));

let spent = 0;
for (const file of files) {
  const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(file, "utf8")));
  const slug = path.basename(file).replace(/\.echo\.json$/, "");
  if (!analysis) {
    process.stdout.write(`${slug}: not a valid Echo trace, skipped\n`);
    continue;
  }
  const layer = originLayer(analysis);
  const hints = upstreamHints(analysis).filter((hint) => !hint.amongPages);
  const head = `${slug}: Echo Score ${layer.score} (${layer.label}), ${layer.origins.length} origins`;
  if (!hints.length) {
    process.stdout.write(`${head}; no name most origins share, so there is nothing to look for (nothing sent)\n`);
    continue;
  }
  const names = hints.map((hint) => hint.name);
  const said = `"${names[0]}" named by ${hints[0].origins} of ${hints[0].of} origin publishers`;
  if (dry) {
    process.stdout.write(`${head}; ${said}; would search: ${upstreamQuery(analysis.claim, names)}; nothing sent\n`);
    continue;
  }
  if (!force && saved[slug]?.traceCreatedAt === analysis.createdAt) {
    process.stdout.write(`${head}; already looked up (use --force to run it again)\n`);
    continue;
  }
  if (spent >= maxUsd) {
    process.stdout.write(`${head}; stopped: $${spent.toFixed(4)} spent in this call reached --max-usd ${maxUsd} (nothing sent for this run)\n`);
    continue;
  }
  const byId = new Map(analysis.pages.map((page) => [page.id, page]));
  const origins = layer.origins.map((origin) => ({ id: origin.id, name: origin.name, passage: origin.pageIds.map((id) => byId.get(id)).filter(Boolean).map((page) => `${page.title}\n${page.text ?? ""}`).join("\n\n") }));
  const finding = await pipeline.findUpstream({ claim: analysis.claim, names, origins, knownUrls: analysis.pages.map((page) => page.url) });
  const { text: upstreamText, ...upstreamPage } = finding.upstream ?? {};
  // The found page's type by the origin layer's own rule (address, title, text); "has evidence" is the model's answer.
  const type = finding.upstream ? originTypeOf({ id: "upstream", title: upstreamPage.title, url: upstreamPage.url, domain: upstreamPage.domain, publishedDate: upstreamPage.date, text: upstreamText ?? "", hasPrimaryEvidence: finding.upstreamShowsFigure, judgment: { kind: "origin", parentId: null, confidence: 0, evidence: "" } }) : null;
  const record = {
    version: 1,
    claim: analysis.claim,
    traceCreatedAt: analysis.createdAt,
    name: finding.name,
    names: finding.names,
    query: finding.query,
    queries: finding.queries,
    engines: finding.engines,
    candidates: finding.candidates,
    upstream: finding.upstream ? { ...upstreamPage, type } : null,
    upstreamShowsFigure: finding.upstreamShowsFigure,
    upstreamReason: finding.upstreamReason,
    origins: finding.origins,
    model: finding.model,
    usd: finding.usd,
    createdAt: finding.createdAt,
  };
  saved[slug] = record;
  fs.writeFileSync(outFile, `${JSON.stringify(saved, null, 2)}\n`);
  spent += record.usd;
  const fold = foldUpstream(layer, record);
  process.stdout.write(`${head}; ${said}; searched: ${record.query}${record.queries.length > 1 ? ` (then: ${record.queries[1]})` : ""}; engines ${record.engines.join(", ") || "none"}; found ${record.upstream ? record.upstream.url : "no page that is that document"}; folded ${fold.folded.length} (${fold.folded.join(", ") || "none"}), kept ${fold.kept.length}; origins ${fold.before.origins} -> ${fold.after.origins}, score ${fold.before.score} -> ${fold.after.score}; $${record.usd.toFixed(4)}\n`);
}
process.stdout.write(dry ? "Nothing was sent. To look for real, add --spend after the -- (one Telem search and one Claude call per trace with a shared name).\n" : `Total: $${spent.toFixed(4)} (list-price estimate)\n`);
