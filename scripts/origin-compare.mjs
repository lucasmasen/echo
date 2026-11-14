// Origin layer: measure the token comparison on saved traces and save each result in src/app/origin-layer-saved.json,
// so the panel can show real numbers offline.
//   npm run origin:compare                                    FREE (the default): prints each context's size, sends nothing
//   npm run origin:compare -- --spend [trace.echo.json ...]   PAID: two Claude answer calls per trace (about 2-3 cents),
//                                                             through Echo's daily budget guard; with no trace named,
//                                                             every bundled run in public/demo-traces
// Spending needs --spend typed after the "--". npm keeps flags typed before it for itself, so the default is the free one.
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
const traceDir = path.join(projectRoot, "public/demo-traces");
// One file, imported by the panel (origin-layer-panel.tsx), so saved comparisons are in the build and work offline.
const outFile = path.join(projectRoot, "src/app/origin-layer-saved.json");
const saved = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : {};
const files = args.filter((arg) => !arg.startsWith("--")).map((file) => path.resolve(file));
if (!files.length) files.push(...fs.readdirSync(traceDir).filter((name) => name.endsWith(".echo.json")).map((name) => path.join(traceDir, name)));

process.chdir(projectRoot); // the budget ledger lives in .echo/ under the project
const { parsePortableTrace } = load(path.join(projectRoot, "src/lib/echo/portable.ts"));
const { comparePrompts, originLayer } = load(path.join(projectRoot, "src/lib/echo/origin-layer.ts"));
if (!dry && !process.env.ANTHROPIC_API_KEY) {
  process.stdout.write("ANTHROPIC_API_KEY is not set (this script reads .env.local through the npm script). Leave out --spend to see sizes for free.\n");
  process.exit(1);
}
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
  const prompts = comparePrompts(analysis);
  const head = `${slug}: Echo Score ${layer.score} (${layer.label}), ${layer.results} results -> ${layer.origins.length} origins`;
  if (dry) {
    process.stdout.write(`${head}; contexts ${prompts.naive.length} vs ${prompts.echo.length} characters (${prompts.naivePages} vs ${prompts.echoPages} pages), nothing sent\n`);
    continue;
  }
  if (!layer.origins.length) {
    process.stdout.write(`${head}; no confirmed origin, so there is nothing to compare (nothing sent)\n`);
    continue;
  }
  if (!force && saved[slug]?.traceCreatedAt === analysis.createdAt) {
    process.stdout.write(`${head}; already compared (use --force to run it again)\n`);
    continue;
  }
  const comparison = await pipeline.compareOriginAnswers(analysis);
  saved[slug] = comparison;
  fs.writeFileSync(outFile, `${JSON.stringify(saved, null, 2)}\n`);
  spent += comparison.usd;
  process.stdout.write(`${head}; input tokens ${comparison.naive.inputTokens} -> ${comparison.echo.inputTokens} (-${comparison.reductionPct}%), confidence ${comparison.naive.confidence} -> ${comparison.echo.confidence}, sources ${comparison.naive.supportingSources} -> ${comparison.echo.supportingSources}, $${comparison.usd.toFixed(4)}\n`);
}
process.stdout.write(dry ? "Nothing was sent. To measure for real, add --spend after the -- (two Claude calls per trace).\n" : `Total: $${spent.toFixed(4)} (list-price estimate)\n`);
