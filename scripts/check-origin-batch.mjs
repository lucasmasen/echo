// Offline check of "Echo over a batch of claims" (src/lib/echo/origin-batch.ts): the one-row-per-run table on /origins
// and its CSV. Every saved run's row must agree with the origin layer and the flow it is built from, and the CSV must
// survive commas, quotes and line breaks. No provider call, no network, no cost (fetch is replaced by a function that
// throws for the length of the check).
//   node scripts/check-origin-batch.mjs          one pass line
//   node scripts/check-origin-batch.mjs --rows   also prints each row
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
};

// The library can make no request: it imports only the other pure origin files, and nothing here may call fetch.
const source = fs.readFileSync(path.join(root, "src/lib/echo/origin-batch.ts"), "utf8");
const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
assert.deepEqual(imports.sort(), ["./origin-flow", "./origin-layer", "./types", "./upstream"], "origin-batch.ts imports only the pure origin files");
// upstream.ts (the shared-name rule) is as closed as the file that imports it.
const upstreamSource = fs.readFileSync(path.join(root, "src/lib/echo/upstream.ts"), "utf8");
assert.deepEqual([...upstreamSource.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]).sort(), ["./origin-layer", "./types"], "upstream.ts imports only the origin layer and the types");
assert.doesNotMatch(upstreamSource, /\bfetch\s*\(|XMLHttpRequest|process\.env|node:|require\(/, "upstream.ts has no way to reach a network, a key or a file");
assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|process\.env|node:|require\(/, "origin-batch.ts has no way to reach a network, a key or a file");
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("check-origin-batch made a network request"); };

const { batchRows, batchCsv, batchSpread, batchSummary, csvCell, promptShorterPct, BATCH_COLUMNS } = load(path.join(root, "src/lib/echo/origin-batch.ts"));
const { originLayer, comparePrompts } = load(path.join(root, "src/lib/echo/origin-layer.ts"));
const { originFlow } = load(path.join(root, "src/lib/echo/origin-flow.ts"));
const { upstreamHints } = load(path.join(root, "src/lib/echo/upstream.ts"));

/** A small RFC 4180 reader, written here so the CSV is checked by something other than the code that wrote it. */
function parseCsv(text) {
  const records = [[]];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') { cell += '"'; at += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") { records[records.length - 1].push(cell); cell = ""; }
    else if (char === "\r" && text[at + 1] === "\n") { records[records.length - 1].push(cell); cell = ""; records.push([]); at += 1; }
    else cell += char;
  }
  records[records.length - 1].push(cell);
  return records;
}

const files = ["mcp/traces", "public/demo-traces"].flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith(".echo.json")).sort().map((name) => path.join(dir, name)));
assert.ok(files.length >= 9, `the nine saved runs are there (found ${files.length})`);
const saved = Object.values(JSON.parse(fs.readFileSync(path.join(root, "src/app/origin-layer-saved.json"), "utf8")));
const runs = files.map((file) => {
  const analysis = JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).analysis;
  return { file: path.basename(file), analysis, comparison: saved.find((entry) => entry.traceCreatedAt === analysis.createdAt && entry.claim === analysis.claim) ?? null };
});
const before = JSON.stringify(runs);
const rows = batchRows(runs);
assert.equal(JSON.stringify(runs), before, "batchRows does not change the runs it is given");
assert.deepEqual(batchRows(runs), rows, "the same runs give the same rows");
assert.deepEqual(JSON.parse(JSON.stringify(rows)), rows, "rows are plain data: they survive JSON unchanged");
assert.equal(rows.length, runs.length, "one row per run");
assert.equal(new Set(rows.map((row) => row.file)).size, rows.length, "the file name is a unique key");

let routed = 0;
let measured = 0;
const sharing = [];
for (const [index, row] of rows.entries()) {
  const { file, analysis, comparison } = runs[index];
  const layer = originLayer(analysis);
  const flow = originFlow(analysis);
  const prompts = comparePrompts(analysis);
  const telem = (analysis.searchAudit ?? []).some((entry) => entry.router === "telem");
  assert.equal(row.file, file);
  assert.equal(row.claim, analysis.claim);
  assert.equal(row.captured, analysis.createdAt);
  assert.equal(row.kind, analysis.sourceCheck ? "links checked" : "claim traced", `${file}: kind follows the run's sourceCheck`);
  assert.equal(row.searchedThrough, analysis.sourceCheck ? "links supplied, no search" : telem ? "Telem" : "Tavily", `${file}: searched through`);
  // Every page once, in exactly one of the three places.
  assert.equal(row.pages, analysis.pages.length, `${file}: pages`);
  assert.equal(row.pages, row.originPages + row.confirmedCopies + row.notTied, `${file}: pages = origin pages + confirmed copies + not tied`);
  assert.equal(row.originPages, flow.counts.origin);
  assert.equal(row.confirmedCopies, flow.counts.copy);
  assert.equal(row.notTied, flow.counts.unplaced);
  assert.equal(row.possibleLinks, analysis.pages.filter((page) => flow.pages.find((entry) => entry.id === page.id).possibleOriginId).length, `${file}: possible links`);
  assert.ok(row.possibleLinks <= row.notTied, `${file}: a possible link is one of the pages not tied to an origin, never a copy`);
  assert.equal(row.origins, layer.origins.length, `${file}: origins equal the origin layer's`);
  assert.equal(row.originsWithOwnEvidence, layer.origins.filter((origin) => origin.ownEvidence).length);
  assert.ok(row.originsWithOwnEvidence <= row.origins && row.publishers <= row.origins && row.origins <= row.originPages, `${file}: origin counts are ordered`);
  assert.equal(row.publishers, layer.entities);
  assert.equal(row.echoScore, layer.score, `${file}: Echo Score equals the origin layer's`);
  assert.equal(row.label, layer.label);
  // Engine figures only where Telem routed the run; "needed" is originFlow's, unchanged.
  assert.equal(row.enginesNeeded, flow.needed ? flow.needed.needed : null, `${file}: engines needed equals originFlow's`);
  assert.equal(row.enginesWithKeptPage, telem ? flow.engines.length : null);
  if (flow.needed) assert.equal(row.enginesWithKeptPage, flow.needed.of, `${file}: the "of" beside engines needed is originFlow's`);
  assert.equal(row.enginesNeeded !== null, telem, `${file}: engine columns are filled only for a Telem-routed run`);
  assert.equal(row.enginesAnswered !== null, telem);
  if (telem) {
    routed += 1;
    const answered = new Set([...(analysis.searchAudit ?? []).flatMap((entry) => entry.providers ?? []), ...Object.entries(analysis.costReceipt?.telem?.providerRuns ?? {}).filter(([, count]) => count > 0).map(([name]) => name)]);
    assert.equal(row.enginesAnswered, answered.size, `${file}: engines that answered a search or were billed`);
    assert.ok(row.enginesNeeded <= row.enginesWithKeptPage && row.enginesWithKeptPage <= row.enginesAnswered, `${file}: needed <= with a kept page <= answered`);
    for (const engine of flow.engines) assert.ok(answered.has(engine.engine), `${file}: ${engine.engine} returned a kept page, so it answered a search`);
    // The flow's own list of engines that answered with no page kept, when the library has one, accounts for the gap.
    if (Array.isArray(flow.idleEngines)) assert.equal(row.enginesAnswered, flow.engines.length + flow.idleEngines.length, `${file}: answered = with a kept page + answered with none kept`);
  }
  // The name most origins share is upstreamHints' first hint that no page of the run is the source of, or nothing.
  const hint = upstreamHints(analysis).filter((entry) => !entry.amongPages)[0] ?? null;
  assert.equal(row.sharedName, hint ? hint.name : null, `${file}: shared name equals upstreamHints on the same run`);
  assert.equal(row.sharedNameOrigins, hint ? hint.origins : null, `${file}: origins naming it`);
  assert.equal(row.sharedNameOf, hint ? hint.of : null, `${file}: of the run's origin publishers`);
  assert.equal(row.sharedName === null, row.sharedNameOrigins === null && row.sharedNameOf === null, `${file}: the name and its two counts come together or not at all`);
  if (hint) {
    sharing.push(`${file.replace(/^telem-|-\d{4}-\d{2}-\d{2}\.echo\.json$/g, "")}: ${row.sharedName} ${row.sharedNameOrigins} of ${row.sharedNameOf}`);
    assert.equal(row.sharedNameOf, row.publishers, `${file}: the "of" is the row's publishers`);
    assert.ok(row.sharedNameOrigins >= 2 && row.sharedNameOrigins <= row.sharedNameOf && row.sharedNameOrigins * 2 >= row.sharedNameOf, `${file}: at least two origins and at least half of them`);
  }
  assert.equal(row.searchesRun, (analysis.searchAudit ?? []).filter((entry) => entry.status === "searched").length, `${file}: searches run`);
  if (analysis.sourceCheck) assert.equal(row.searchesRun, 0, `${file}: a links check runs no search`);
  // The two prompts are the ones the token comparison would send; the percent is worked out again here.
  assert.equal(row.promptCharsEveryPage, prompts.naive.length);
  assert.equal(row.promptCharsOriginsOnly, prompts.echo.length);
  assert.equal(row.promptShorterPct, layer.origins.length ? Math.round(100 * (1 - prompts.echo.length / prompts.naive.length)) : null, `${file}: prompt shorter by matches the two lengths`);
  if (row.promptShorterPct !== null) assert.equal(row.promptShorterPct, promptShorterPct(row.promptCharsEveryPage, row.promptCharsOriginsOnly));
  // A measured token reduction only where a comparison of exactly this run is saved.
  assert.equal(row.measuredTokenReductionPct, comparison ? comparison.reductionPct : null, `${file}: measured reduction is the saved comparison's, or nothing`);
  if (comparison) {
    measured += 1;
    assert.equal(comparison.reductionPct, Math.round(100 * (1 - comparison.echo.inputTokens / comparison.naive.inputTokens)), `${file}: the saved reduction matches its own token counts`);
  }
}
assert.ok(routed >= 4, "the four Telem-routed runs carry engine figures");
// Today's saved runs: the brain run and the habit run have a name most origins share, and no other run does.
assert.deepEqual([...sharing].sort(), ["brain: William James 3 of 3", "habit: Maxwell Maltz 3 of 4", "hours: Malcolm Gladwell 4 of 5"], "the brain, habit and hours runs carry a shared name; every other saved run carries none");
// A comparison of another run is never borrowed: same claim, different capture time.
{
  const [first] = runs;
  const other = { claim: first.analysis.claim, traceCreatedAt: "2001-01-01T00:00:00.000Z", reductionPct: 99 };
  assert.equal(batchRows([{ ...first, comparison: other }])[0].measuredTokenReductionPct, null, "a comparison of a different run is not used");
  assert.equal(batchRows([{ file: first.file, analysis: first.analysis }])[0].measuredTokenReductionPct, null, "no comparison, no measured figure");
}

// The spread note: worked out again here from the rows.
{
  const groups = new Map();
  for (const row of rows.filter((entry) => entry.kind === "claim traced")) {
    const key = row.claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    groups.set(key, [...(groups.get(key) ?? []), row.echoScore]);
  }
  const gaps = [...groups.values()].filter((scores) => scores.length > 1).map((scores) => Math.max(...scores) - Math.min(...scores)).filter((gap) => gap > 0);
  const spread = batchSpread(rows);
  if (!gaps.length) assert.equal(spread, null);
  else {
    assert.equal(spread.high - spread.low, Math.max(...gaps), "the spread note names the widest gap");
    const same = groups.get(spread.claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
    assert.ok(same, "the spread note's claim is one of the traced claims");
    assert.equal(spread.runs, same.length, "it counts that claim's runs");
    assert.equal(spread.low, Math.min(...same), "its low score is that claim's lowest run");
    assert.equal(spread.high, Math.max(...same), "its high score is that claim's highest run");
  }
  assert.equal(batchSpread(rows.slice(0, 1)), null, "one run of a claim has no spread");
  assert.equal(batchSpread(rows.filter((row) => row.kind === "links checked")), null, "a links check is not compared with a trace");

  // The counts the sentence above the table is written from.
  const summary = batchSummary(rows);
  assert.equal(summary.runs, rows.length);
  assert.equal(summary.telem + summary.tavily + summary.links, rows.length, "every row was searched through Telem, through Tavily, or is a links check");
  assert.equal(summary.telem, routed);
  assert.equal(summary.links, runs.filter((run) => run.analysis.sourceCheck).length);
  assert.equal(summary.measured, measured);
  assert.deepEqual(summary.spread, spread);
  // "Older runs, on earlier days" may be said only when every Tavily run's Pacific day is before every Telem run's.
  const day = (iso) => new Date(new Date(iso).getTime() - 8 * 3600 * 1000).toISOString().slice(0, 10); // November: Pacific time is UTC-8
  const telemDays = rows.filter((row) => row.searchedThrough === "Telem").map((row) => day(row.captured));
  const tavilyDays = rows.filter((row) => row.searchedThrough === "Tavily").map((row) => day(row.captured));
  assert.equal(summary.tavilyEarlier, tavilyDays.length > 0 && telemDays.length > 0 && tavilyDays.every((older) => telemDays.every((newer) => older < newer)), "the Tavily runs are called older only when they are");
  assert.equal(batchSummary(rows.filter((row) => row.searchedThrough !== "Tavily")).tavilyEarlier, false, "no Tavily run, nothing to call older");
  const sameDay = rows.map((row) => ({ ...row, captured: "2026-11-14T20:00:00.000Z" }));
  assert.equal(batchSummary(sameDay).tavilyEarlier, false, "runs of the same day are not called older");
}

// The CSV of the saved runs: a header and one line per row, and it reads back to the same values.
{
  const csv = batchCsv(rows);
  const lines = csv.split("\r\n");
  assert.equal(lines.length, rows.length + 1, "one line per row plus a header");
  assert.equal(lines[0], BATCH_COLUMNS.map((column) => column.header).join(","), "the header names every column");
  assert.equal(new Set(BATCH_COLUMNS.map((column) => column.header)).size, BATCH_COLUMNS.length, "no header twice");
  assert.deepEqual(BATCH_COLUMNS.map((column) => column.key).sort(), Object.keys(rows[0]).sort(), "the CSV has a column for every field of a row");
  assert.ok(!csv.endsWith("\n"), "no empty last line");
  const records = parseCsv(csv);
  assert.equal(records.length, rows.length + 1);
  for (const [index, row] of rows.entries()) {
    const record = records[index + 1];
    assert.equal(record.length, BATCH_COLUMNS.length, `${row.file}: every record has every column`);
    BATCH_COLUMNS.forEach((column, at) => {
      const value = row[column.key];
      // A claim that starts like a formula is written with a leading apostrophe; none of the saved claims does.
      assert.equal(record[at], value === null ? "" : String(value), `${row.file}: ${column.header} reads back`);
    });
  }
}

// Escaping, on a row written to break a careless CSV: a comma, quotes, both kinds of line break, and a formula.
{
  const base = rows[0];
  const hard = [
    { ...base, file: "a.echo.json", claim: 'He said "most people", then left, twice' },
    { ...base, file: "b.echo.json", claim: "Line one\nline two\r\nline three" },
    { ...base, file: "c.echo.json", claim: "=HYPERLINK(\"http://example.invalid\",\"click\")" },
    { ...base, file: "d.echo.json", claim: "plain", enginesNeeded: null, promptShorterPct: -12, measuredTokenReductionPct: null, sharedName: 'Smith, "the report"', sharedNameOrigins: 2, sharedNameOf: 3 },
  ];
  const csv = batchCsv(hard);
  const records = parseCsv(csv);
  assert.equal(records.length, hard.length + 1, "a line break inside a claim does not start a new record");
  for (const record of records) assert.equal(record.length, BATCH_COLUMNS.length, "a comma inside a claim does not start a new column");
  const claimAt = BATCH_COLUMNS.findIndex((column) => column.key === "claim");
  assert.equal(records[1][claimAt], hard[0].claim, "commas and quotes read back");
  assert.equal(records[2][claimAt], hard[1].claim, "line breaks read back");
  assert.equal(records[3][claimAt], `'${hard[2].claim}`, "a claim that starts like a formula is written as text");
  assert.equal(records[4][BATCH_COLUMNS.findIndex((column) => column.key === "enginesNeeded")], "", "no engine figure is an empty cell, not a zero");
  assert.equal(records[4][BATCH_COLUMNS.findIndex((column) => column.key === "promptShorterPct")], "-12", "a negative number stays a number");
  assert.equal(records[4][BATCH_COLUMNS.findIndex((column) => column.key === "sharedName")], 'Smith, "the report"', "a shared name with a comma and quotes reads back");
  assert.equal(records[4][BATCH_COLUMNS.findIndex((column) => column.key === "sharedNameOrigins")], "2");
  assert.equal(records[1][BATCH_COLUMNS.findIndex((column) => column.key === "sharedName")], base.sharedName ?? "", "no shared name is an empty cell");
  assert.deepEqual(["sharedName", "sharedNameOrigins", "sharedNameOf"].map((key) => BATCH_COLUMNS.find((column) => column.key === key).header), ["name_most_origins_share", "origins_naming_it", "of_origin_publishers"], "the CSV names the three shared-name columns");
  assert.equal(csvCell('a "b"'), '"a ""b"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("a\nb"), '"a\nb"');
  assert.equal(csvCell("plain text"), "plain text");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell(Number.NaN), "");
  for (const start of ["=1+1", "+1", "-1", "@a", "\tx"]) assert.ok(csvCell(start).replace(/^"/, "").startsWith("'"), `"${start.trim()}" is not left to run as a formula`);
  assert.equal(batchCsv([]), BATCH_COLUMNS.map((column) => column.header).join(","), "no rows: the header alone");
}

globalThis.fetch = realFetch;
if (process.argv.includes("--rows")) {
  for (const row of rows) {
    console.log(`  ${row.file}: "${row.claim}" · ${row.searchedThrough} · pages ${row.pages} (${row.originPages} origin, ${row.confirmedCopies} copies, ${row.notTied} not tied, ${row.possibleLinks} possible) · origins ${row.origins} (${row.originsWithOwnEvidence} with own evidence, ${row.publishers} publishers) · score ${row.echoScore} ${row.label} · engines ${row.enginesNeeded === null ? "-" : `${row.enginesNeeded} of ${row.enginesWithKeptPage} (${row.enginesAnswered} answered)`} · searches ${row.searchesRun} · prompt ${row.promptCharsEveryPage} -> ${row.promptCharsOriginsOnly} chars (${row.promptShorterPct === null ? "-" : `${row.promptShorterPct}%`}) · measured ${row.measuredTokenReductionPct === null ? "-" : `${row.measuredTokenReductionPct}%`} · shared name ${row.sharedName === null ? "-" : `${row.sharedName} (${row.sharedNameOrigins} of ${row.sharedNameOf})`}`);
  }
}
console.log(`check-origin-batch: ok (${rows.length} saved runs, one row each; ${routed} routed by Telem with engine figures; ${measured} with a measured token comparison; ${sharing.length} with a name most origins share (${sharing.join("; ")}); rows add up and match the origin layer and flow; CSV has ${BATCH_COLUMNS.length} columns, a header and one line per row, and escapes commas, quotes, line breaks and formulas)`);
