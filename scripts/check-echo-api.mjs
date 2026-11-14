// Offline check of "Call Echo from any agent": the saved-run matcher (src/lib/echo/saved-check.ts), the free HTTP route
// (src/app/api/echo-check/route.ts, run here in-process: no server needed), the command line (mcp/echo-cli.mjs) and the
// JSON-Schema tool definition (mcp/echo-check.tool.json).
//   node scripts/check-echo-api.mjs
// It holds all of them to the MCP tool's answers and refusals (mcp/echo-mcp.mjs, asked over stdio with live runs off),
// and to echoCheck on the newest saved run of each claim. No provider call, no network, no cost: fetch is replaced by a
// recorder for the whole run and the check fails if anything calls it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The route reads its two folders from the working directory, as it does under Next.
process.chdir(root);
load.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
};
// "@/lib/…" as the route writes it.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolveFilename.call(this, request.startsWith("@/") ? path.join(root, "src", request.slice(2)) : request, ...rest);
};
const networkCalls = [];
globalThis.fetch = async (address) => { networkCalls.push(String(address?.url ?? address)); throw new Error("check-echo-api: a network call was attempted"); };

const ROUTE = path.join(root, "src/app/api/echo-check/route.ts");
const CLI = path.join(root, "mcp/echo-cli.mjs");
const { savedCheck, savedMatch, savedClaims, routedBy, keyWords, sharedNames, SHARED_NAMES_NOTE } = load(path.join(root, "src/lib/echo/saved-check.ts"));
const { echoCheck } = load(path.join(root, "src/lib/echo/origin-layer.ts"));
const { upstreamHints } = load(path.join(root, "src/lib/echo/upstream.ts"));
const { parsePortableTrace } = load(path.join(root, "src/lib/echo/portable.ts"));
const route = load(ROUTE);

const DIRS = ["public/demo-traces", "mcp/traces"];
const listing = () => DIRS.flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith(".echo.json")).sort().map((name) => `${dir}/${name}:${fs.statSync(path.join(root, dir, name)).mtimeMs}`)).join("\n");
function readRuns() {
  return DIRS.flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith(".echo.json")).sort().flatMap((name) => {
    try {
      const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, dir, name), "utf8")));
      return analysis ? [{ file: name, dir, analysis }] : [];
    } catch { return []; }
  }));
}
/** Saved runs can land while this check runs (a live session saves into mcp/traces): compare only on a still folder. */
async function onStillFolders(body) {
  for (let attempt = 0; ; attempt += 1) {
    const before = listing();
    const done = await body(readRuns());
    if (listing() === before) return done;
    assert.ok(attempt < 4, "the saved-run folders kept changing while the check ran");
  }
}

// The same claim, decided here without the module's rule: the same letters and digits, whatever the case or punctuation.
const plain = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** The newest live search run of a claim, found the slow way. */
const newestRunOf = (claim, runs) => runs.filter((run) => run.analysis.mode === "live" && !run.analysis.sourceCheck && plain(run.analysis.claim) === plain(claim)).sort((a, b) => Date.parse(b.analysis.createdAt) - Date.parse(a.analysis.createdAt))[0];
const sameFigures = (got, analysis, label) => {
  const expected = echoCheck(analysis);
  assert.equal(got.echo_score, expected.echo_score, `${label}: echo_score`);
  assert.equal(got.num_origins, expected.num_origins, `${label}: num_origins`);
  assert.deepEqual(got.engines_needed, expected.engines_needed, `${label}: engines_needed`);
  assert.equal(got.summary, expected.summary, `${label}: the page split sentence`);
};

/** The shared-name fields a reply should carry, worked out here from upstreamHints: only names no page is the source of. */
const expectedShared = (analysis) => upstreamHints(analysis).filter((hint) => !hint.amongPages).map((hint) => ({ name: hint.name, origins_naming_it: hint.origins, of_origin_publishers: hint.of, origin_names: hint.originNames }));
/** A reply carries shared_names and its note together, or neither. */
const sameShared = (got, analysis, label) => {
  const expected = expectedShared(analysis);
  if (!expected.length) {
    assert.ok(!("shared_names" in got) && !("shared_names_note" in got), `${label}: no shared name, so no shared_names field and no note`);
    return 0;
  }
  assert.deepEqual(got.shared_names, expected, `${label}: shared_names is upstreamHints on the same run`);
  assert.equal(got.shared_names_note, SHARED_NAMES_NOTE, `${label}: the note travels with the field`);
  for (const shared of got.shared_names) {
    assert.ok(shared.origins_naming_it >= 2 && shared.origins_naming_it <= shared.of_origin_publishers && shared.origins_naming_it * 2 >= shared.of_origin_publishers, `${label}: at least two origins and at least half of them name "${shared.name}"`);
    assert.equal(shared.origin_names.length, shared.origins_naming_it, `${label}: one origin name per origin naming "${shared.name}"`);
  }
  return expected.length;
};

const TELEM = {
  phones: "Americans check their phones 96 times a day",
  "body-heat": "You lose most of your body heat through your head",
  brain: "Humans use only 10% of their brains.",
  goldfish: "Goldfish have a 3-second memory",
};
const REFUSED = [
  "The moon is made of cheese",
  "The Great Wall of China is visible from space",
  "Americans check their phones 352 times a day",
  "Americans check their phones 96 times an hour",
  "Goldfish have a 3 month memory",
  "Dogs have a 3 second memory",
  "You lose most of your body heat through your feet",
  "Humans use 100% of their brains",
  "Goldfish",
];
const REWORDED = [
  "Do Americans really check their phones 96 times a day?",
  "Goldfish have a three-second memory",
  "Is it true that we use only ten percent of our brain?",
  "Americans check their phones ninety-six times a day",
];

const counts = await onStillFolders(async (runs) => {
  const searchRuns = runs.filter((run) => run.analysis.mode === "live" && !run.analysis.sourceCheck);
  const claims = [...new Map(searchRuns.map((run) => [plain(run.analysis.claim), run.analysis.claim])).values()];
  assert.ok(runs.filter((run) => run.dir === "public/demo-traces").length >= 5 && claims.length >= 4, "the bundled runs and the saved Telem runs are there");

  // 1. Every claim with a saved run is answered from its newest run, with that run's own figures.
  for (const claim of claims) {
    const newest = newestRunOf(claim, runs);
    const got = savedCheck(claim, runs);
    assert.ok(got, `"${claim}" has a saved run and is answered`);
    assert.equal(got.file, newest.file, `"${claim}": the newest saved run answers`);
    sameFigures(got, newest.analysis, claim);
    assert.deepEqual({ ...got, shared_names: undefined, shared_names_note: undefined, asked: undefined, source: undefined, captured: undefined, routed_by: undefined, file: undefined }, { ...echoCheck(newest.analysis), shared_names: undefined, shared_names_note: undefined, asked: undefined, source: undefined, captured: undefined, routed_by: undefined, file: undefined }, `"${claim}": the reply is echoCheck of that run plus the shared-name hint and where it came from`);
    sameShared(got, newest.analysis, claim);
    assert.deepEqual(sharedNames(newest.analysis), expectedShared(newest.analysis).length ? { shared_names: expectedShared(newest.analysis), shared_names_note: SHARED_NAMES_NOTE } : {}, `"${claim}": sharedNames is the two fields or nothing`);
    assert.equal(got.asked, claim);
    assert.equal(got.source, "saved run");
    assert.equal(got.captured, newest.analysis.createdAt);
    assert.equal(got.wording_note, undefined, `"${claim}": its own wording needs no note`);
    const viaTelem = (newest.analysis.searchAudit ?? []).some((entry) => entry.router === "telem");
    assert.equal(got.routed_by, viaTelem ? "telem" : "tavily", `"${claim}": routed_by is read from the run`);
  }
  // The four Telem claims of Nov 14 are among them, each answered by its Telem run and carrying an engines-needed figure.
  for (const [key, claim] of Object.entries(TELEM)) {
    const got = savedCheck(claim, runs);
    assert.ok(got, `the Telem ${key} claim is answered`);
    assert.equal(got.routed_by, "telem", `${key}: the newest run is the Telem-routed one`);
    assert.match(got.file, new RegExp(`^telem-${key}-`), `${key}: answered from mcp/traces`);
    assert.ok(got.engines_needed && got.engines_needed.needed >= 1 && got.engines_needed.needed <= got.engines_needed.of, `${key}: engines needed`);
    assert.match(got.engines_summary, /this does not rank the engines\.$/, `${key}: one run does not rank engines`);
  }
  // The shared-name hint. Today's saved runs: the brain claim's three origins all name William James, the habit claim's
  // name Maxwell Maltz, and the phones claim has no such name. The figures are read from the run, never typed here twice.
  {
    const brain = savedCheck(TELEM.brain, runs);
    assert.deepEqual(brain.shared_names.map((shared) => [shared.name, shared.origins_naming_it, shared.of_origin_publishers]), [["William James", 3, 3], ["Energies of Men", 2, 3]], "brain: William James in all three origins, then Energies of Men");
    assert.equal(brain.shared_names_note, SHARED_NAMES_NOTE);
    assert.equal(brain.shared_names[0].of_origin_publishers, brain.num_publishers, "brain: the 'of' is the run's publishers among its origins");
    const habit = savedCheck("It takes 21 days to form a habit", runs);
    assert.deepEqual(habit.shared_names.map((shared) => [shared.name, shared.origins_naming_it, shared.of_origin_publishers]), [["Maxwell Maltz", 3, 4]], "habit: Maxwell Maltz in three of four origins");
    const phones = savedCheck(TELEM.phones, runs);
    assert.ok(!("shared_names" in phones) && !("shared_names_note" in phones), "phones: no shared_names field");
    const withName = searchRuns.filter((run) => expectedShared(run.analysis).length).map((run) => run.file).sort();
    assert.deepEqual(withName, ["telem-brain-2026-11-14.echo.json", "telem-habit-2026-11-14.echo.json", "telem-hours-2026-11-14.echo.json"], "of the saved search runs, only today's brain and habit runs have a name most origins share");
    // The note is one sentence, says what the field does not show, and never says a page was copied.
    assert.match(SHARED_NAMES_NOTE, /^When [^.]+ may share a source [^.]+ num_origins may be too high; [^.]+ a hint to check, not a finding\.$/);
    assert.doesNotMatch(SHARED_NAMES_NOTE, /copied|proves?|confirmed/i);
    // A name that a page of the run is itself the source of is shared, not missing: it is left out of the reply.
    const [first] = upstreamHints(newestRunOf(TELEM.brain, runs).analysis);
    assert.equal(first.amongPages, false);
  }
  // The bundled claims: each bundled file's claim is answered (by a newer Telem run today), and by the bundled run
  // itself once the newer runs are taken away, which then reads as a Tavily search with no per-engine figure.
  const bundled = runs.filter((run) => run.dir === "public/demo-traces");
  for (const run of bundled) {
    const got = savedCheck(run.analysis.claim, runs);
    assert.ok(got, `bundled claim "${run.analysis.claim}" is answered`);
    sameFigures(got, newestRunOf(run.analysis.claim, runs).analysis, `bundled ${run.file}`);
    if (run.analysis.sourceCheck) continue;
    const alone = savedCheck(run.analysis.claim, bundled);
    const newestBundled = newestRunOf(run.analysis.claim, bundled);
    assert.equal(alone.file, newestBundled.file);
    sameFigures(alone, newestBundled.analysis, `bundled only, ${run.file}`);
    if ((newestBundled.analysis.searchAudit ?? []).some((entry) => entry.router === "telem")) continue;
    assert.equal(alone.routed_by, "tavily", `${newestBundled.file}: a run with no Telem search reads as a Tavily search`);
    assert.equal(alone.engines_needed, undefined, "a run not routed by Telem has no engines-needed figure");
  }

  // 2. The matching rule. Reworded: a question, a spelled-out figure, one key word left out.
  for (const claim of REWORDED) assert.ok(savedCheck(claim, runs), `"${claim}" is the saved claim reworded`);
  assert.equal(savedCheck(REWORDED[0], runs).wording_note, undefined, "the same claim asked as a question needs no wording note");
  assert.equal(savedCheck(REWORDED[1], runs).claim, TELEM.goldfish, "a spelled-out figure is the same figure");
  assert.match(savedCheck(REWORDED[2], runs).wording_note, /^The saved run traced "Humans use only 10% of their brains\."\. Your wording differs by one key word/);
  assert.equal(savedCheck(REWORDED[2], runs).asked, REWORDED[2]);
  // A swapped word, a changed figure, another claim, or one bare word: refused, with no figure of any run.
  for (const claim of REFUSED) assert.equal(savedCheck(claim, runs), null, `"${claim}" is not answered from another claim's saved run`);
  for (const claim of ["", "   ", "?"]) assert.equal(savedCheck(claim, runs), null);
  // The newest run of a claim wins, whatever order the runs are handed in.
  const phonesRun = newestRunOf(TELEM.phones, runs);
  const later = { file: "later.echo.json", analysis: { ...phonesRun.analysis, createdAt: new Date(Date.parse(phonesRun.analysis.createdAt) + 60_000).toISOString() } };
  const earlier = { file: "earlier.echo.json", analysis: { ...phonesRun.analysis, createdAt: "2020-01-01T00:00:00.000Z" } };
  assert.equal(savedCheck(TELEM.phones, [earlier, ...runs, later]).file, "later.echo.json");
  assert.equal(savedCheck(TELEM.phones, [later, ...runs, earlier]).file, "later.echo.json");
  assert.equal(savedCheck(TELEM.phones, [earlier, ...runs]).file, phonesRun.file);
  // An exact wording beats a newer run that is one key word away.
  const oneWordAway = { file: "near.echo.json", analysis: { ...later.analysis, claim: "Most Americans check their phones 96 times a day" } };
  assert.equal(savedMatch(TELEM.phones, [oneWordAway, ...runs]).file, phonesRun.file);
  assert.equal(savedMatch("Most Americans check their phones 96 times a day", [oneWordAway, ...runs]).file, "near.echo.json");
  // A "Check these sources" run covers only the links someone supplied: it never answers a search question, and it
  // answers only a caller who asks for the links run, with that scope stated.
  const linkRuns = runs.filter((run) => run.analysis.sourceCheck);
  assert.ok(linkRuns.length >= 1, "the saved links check is bundled");
  for (const run of linkRuns) {
    assert.equal(savedCheck(run.analysis.claim, [run]), null, "a links run alone does not answer a search question");
    const got = savedCheck(run.analysis.claim, runs, "links");
    assert.equal(got.routed_by, "links supplied");
    assert.ok(got.scope_note.includes("only the links someone supplied"));
    assert.equal(routedBy(run.analysis), "links supplied");
  }
  assert.equal(savedCheck(TELEM.goldfish, runs, "links"), null, "no links run was saved for the goldfish claim");
  // The list a refusal carries: one wording per claim that has a saved search run.
  const listed = savedClaims(runs);
  assert.deepEqual(listed.map(plain).sort(), claims.map(plain).sort());
  assert.ok(keyWords("Ninety-six of the 3 hundred").has("96") && keyWords("three hundred").has("three"), "number words below a hundred count as digits; a number word before hundred stays a word");

  // 3. The MCP tool over stdio, live runs off: the same claims answered with the same figures, the same claims refused.
  const asked = [...claims, ...REWORDED, ...REFUSED];
  const requests = [
    { jsonrpc: "2.0", id: "list", method: "tools/list" },
    ...asked.map((claim, index) => ({ jsonrpc: "2.0", id: index, method: "tools/call", params: { name: "echo_check", arguments: { claim } } })),
  ];
  const mcp = spawnSync(process.execPath, [path.join(root, "mcp/echo-mcp.mjs")], { cwd: "/", input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`, encoding: "utf8", env: { ...process.env, ECHO_MCP_LIVE: "0", ECHO_MCP_TRACES: "", ECHO_URL: "http://127.0.0.1:9" } });
  assert.equal(mcp.status, 0, mcp.stderr);
  const replies = new Map(mcp.stdout.trim().split("\n").map((line) => JSON.parse(line)).map((reply) => [reply.id, reply]));
  asked.forEach((claim, index) => {
    const reply = replies.get(index).result;
    const theirs = JSON.parse(reply.content[0].text);
    const ours = savedCheck(claim, runs);
    assert.equal(reply.isError, ours === null, `"${claim}": the MCP tool and the saved-check module agree on whether a saved run answers`);
    if (!ours) return assert.match(theirs.error, /^No saved Echo run matches this claim/);
    for (const key of ["claim", "echo_score", "label", "num_results", "num_origins", "num_publishers", "pages", "summary", "origins", "warning", "echo_answer", "engines", "engines_needed", "engines_summary", "note", "shared_names", "shared_names_note", "asked", "wording_note"]) assert.deepEqual(ours[key], theirs[key], `"${claim}": ${key} matches the MCP tool`);
    assert.equal("shared_names" in theirs, "shared_names" in ours, `"${claim}": the MCP tool and the module agree on whether there is a shared name`);
    assert.ok(theirs.source.includes(`(${ours.file})`), `"${claim}": both answered from ${ours.file}`);
  });
  // The tool definition for other frameworks is the MCP tool's own, in the JSON-Schema function-calling shape.
  const tool = JSON.parse(fs.readFileSync(path.join(root, "mcp/echo-check.tool.json"), "utf8"));
  const theirs = replies.get("list").result.tools[0];
  assert.deepEqual(Object.keys(tool), ["name", "description", "parameters"]);
  assert.equal(tool.name, "echo_check");
  assert.equal(tool.description, theirs.description, "the tool JSON carries the MCP tool's description, word for word");
  assert.deepEqual(tool.parameters, theirs.inputSchema);
  assert.match(tool.description, /`shared_names`[^.]*say the origins "may share a source"[^.]*never that one page "is copied from" another/, "the description tells an agent how to word a shared name");
  // The MCP tool keeps its own copy of the note (it loads upstream.ts itself): the two are the same words.
  assert.ok(fs.readFileSync(path.join(root, "mcp/echo-mcp.mjs"), "utf8").includes(`const SHARED_NAMES_NOTE = ${JSON.stringify(SHARED_NAMES_NOTE)};`), "mcp/echo-mcp.mjs carries the note word for word");
  const brainByMcp = JSON.parse(replies.get(asked.indexOf(TELEM.brain)).result.content[0].text);
  assert.deepEqual(brainByMcp.shared_names.map((shared) => [shared.name, shared.origins_naming_it, shared.of_origin_publishers])[0], ["William James", 3, 3], "MCP: the brain claim returns William James, three of three");
  assert.ok(!("shared_names" in JSON.parse(replies.get(asked.indexOf(TELEM.phones)).result.content[0].text)), "MCP: the phones claim returns no shared_names field");
  assert.deepEqual(tool.parameters.required, ["claim"]);
  assert.equal(tool.parameters.type, "object");
  assert.equal(tool.parameters.properties.claim.type, "string");

  // 4. The HTTP route, called in-process with a plain Request.
  const get = async (query) => {
    const response = await route.GET(new Request(`http://localhost/api/echo-check${query}`));
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const openHeaders = (response, label) => {
    assert.equal(response.headers.get("access-control-allow-origin"), "*", `${label}: any site may read it`);
    assert.equal(response.headers.get("cache-control"), "no-store", `${label}: never cached`);
  };
  for (const claim of [...claims, ...REWORDED]) {
    const response = await get(`?claim=${encodeURIComponent(claim)}`);
    assert.equal(response.status, 200, `GET "${claim}"`);
    openHeaders(response, claim);
    assert.deepEqual(response.body, JSON.parse(JSON.stringify(savedCheck(claim, runs))), `GET "${claim}": the reply is the saved-check reply`);
    assert.equal(response.body.source, "saved run");
    assert.ok(Number.isFinite(Date.parse(response.body.captured)));
    assert.ok(["telem", "tavily"].includes(response.body.routed_by));
  }
  const phones = await get(`?claim=${encodeURIComponent(TELEM.phones)}`);
  assert.ok(!("shared_names" in phones.body) && !("shared_names_note" in phones.body), "GET phones: no shared_names field");
  const brainByHttp = await get(`?claim=${encodeURIComponent(TELEM.brain)}`);
  assert.deepEqual(brainByHttp.body.shared_names.map((shared) => [shared.name, shared.origins_naming_it, shared.of_origin_publishers])[0], ["William James", 3, 3], "GET brain: William James, three of three");
  assert.equal(brainByHttp.body.shared_names_note, SHARED_NAMES_NOTE);
  assert.deepEqual(brainByHttp.body.shared_names, brainByMcp.shared_names, "the HTTP route and the MCP tool return the same shared names");
  sameFigures(phones.body, phonesRun.analysis, "GET phones");
  assert.equal(phones.body.routed_by, "telem");
  assert.equal(phones.body.captured, phonesRun.analysis.createdAt);
  for (const claim of REFUSED) {
    const response = await get(`?claim=${encodeURIComponent(claim)}`);
    assert.equal(response.status, 404, `GET "${claim}" is refused`);
    openHeaders(response, claim);
    assert.deepEqual(Object.keys(response.body), ["error", "hint"]);
    assert.match(response.body.error, /^No saved Echo run matches this claim\..*never starts a live run/);
    assert.deepEqual(response.body.hint, listed, "the refusal lists the claims that do have a saved run");
    assert.equal(response.body.echo_score, undefined);
  }
  for (const query of ["", "?claim=", "?claim=%20%20", "?q=goldfish", `?claim=${"a ".repeat(251)}`]) {
    const response = await get(query);
    assert.equal(response.status, 400, `GET ${query.slice(0, 20) || "(no claim)"} is a bad request`);
    openHeaders(response, query);
    assert.equal(typeof response.body.error, "string");
  }
  const links = await get(`?claim=${encodeURIComponent(linkRuns[0].analysis.claim)}&links=1`);
  assert.equal(links.status, 200);
  assert.equal(links.body.routed_by, "links supplied");
  assert.equal(links.body.file, linkRuns[0].file);
  const preflight = route.OPTIONS();
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

  // 5. The command line, run from another folder: the score in plain text, the same reply as JSON, a refusal with exit 1.
  const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: "/", encoding: "utf8", env: { ...process.env, ECHO_MCP_LIVE: "0" } });
  const expectedPhones = echoCheck(phonesRun.analysis);
  const text = cli(TELEM.phones);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`^Echo Score\\s+${expectedPhones.echo_score} of 100 \\(${expectedPhones.label}\\)$`, "m"), "the command line prints the score");
  assert.ok(text.stdout.includes(expectedPhones.summary) && text.stdout.includes(expectedPhones.engines_summary) && text.stdout.includes(expectedPhones.note), "and the page split, the engine sentence and the note");
  assert.match(text.stdout, new RegExp(`^Engines needed\\s+${expectedPhones.engines_needed.needed} of ${expectedPhones.engines_needed.of}, by this run's record$`, "m"));
  assert.ok(text.stdout.includes(expectedPhones.origins[0].url));
  const json = cli(TELEM.phones, "--json");
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), JSON.parse(JSON.stringify(savedCheck(TELEM.phones, runs))), "--json prints the reply the route sends");
  assert.doesNotMatch(text.stdout, /^Shared name/m, "the phones claim prints no Shared name line");
  assert.ok(!("shared_names" in JSON.parse(json.stdout)), "command line, phones: no shared_names field");
  const brainByCli = JSON.parse(cli(TELEM.brain, "--json").stdout);
  assert.deepEqual(brainByCli.shared_names, brainByHttp.body.shared_names, "the command line and the HTTP route return the same shared names");
  assert.deepEqual(brainByCli.shared_names, brainByMcp.shared_names, "the command line and the MCP tool return the same shared names");
  assert.equal(brainByCli.shared_names_note, brainByMcp.shared_names_note);
  const brainText = cli(TELEM.brain).stdout;
  for (const shared of brainByCli.shared_names) assert.match(brainText, new RegExp(`^Shared name\\s+${shared.name}, in the saved passage of ${shared.origins_naming_it} of ${shared.of_origin_publishers} origin publishers: ${shared.origin_names.join(", ").replace(/\./g, "\\.")}$`, "m"), `the command line prints a Shared name line for ${shared.name}`);
  assert.ok(brainText.includes(`  ${SHARED_NAMES_NOTE}`), "and the note under it");
  const unquoted = cli(...REWORDED[1].split(" "), "--json");
  assert.equal(JSON.parse(unquoted.stdout).claim, TELEM.goldfish, "a claim typed without quotes is read as one sentence");
  const refused = cli(REFUSED[0]);
  assert.equal(refused.status, 1, "a claim with no saved run exits 1");
  assert.match(refused.stdout, /^No saved Echo run matches this claim\./);
  for (const claim of listed) assert.ok(refused.stdout.includes(`  ${claim}\n`), `the refusal lists "${claim}"`);
  assert.doesNotMatch(refused.stdout, /Echo Score/);
  const refusedJson = cli(REFUSED[4], "--json");
  assert.equal(refusedJson.status, 1);
  assert.deepEqual(JSON.parse(refusedJson.stdout).hint, listed);
  assert.equal(cli().status, 2, "no claim is a usage error");
  assert.deepEqual(cli("--list").stdout.trim().split("\n"), listed);

  return { claims: claims.length, runs: runs.length, compared: asked.length };
});

// 6. The route, the command line and everything they import cannot reach a provider: no pipeline or budget module,
// no setting read, no network call anywhere in the files they load.
{
  // The modules check:links keeps out of pages (they call a paid provider or keep its ledger), plus every other
  // library file that makes a request or reads a setting today. Any new one is caught by the source scan below.
  const FORBIDDEN = /(?:^|\/)(?:pipeline|copy-hunt|scout|daily-budget|remote-budget|telem|cost-flags|presenter|extension-origins|site)(?:\.ts)?$/;
  const importsOf = (file) => {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const found = [];
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) found.push({ spec: node.moduleSpecifier.text, typeOnly: Boolean(node.importClause?.isTypeOnly) });
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(sf) === "require") && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) found.push({ spec: node.arguments[0].text, typeOnly: false });
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  };
  const resolve = (from, spec) => {
    const base = spec.startsWith("@/") ? path.join(root, "src", spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
  };
  const reach = (entry) => {
    const seen = new Set([entry]);
    const packages = new Set();
    const queue = [entry];
    while (queue.length) {
      const file = queue.shift();
      for (const { spec, typeOnly } of importsOf(file)) {
        assert.doesNotMatch(spec, FORBIDDEN, `${path.relative(root, file)} imports ${spec}, a module that can call a provider`);
        const target = resolve(file, spec);
        if (!target) { if (!typeOnly) packages.add(spec); continue; }
        if (!seen.has(target)) { seen.add(target); queue.push(target); }
      }
    }
    return { files: [...seen], packages: [...packages].sort() };
  };
  const routeReach = reach(ROUTE);
  assert.deepEqual(routeReach.packages, ["node:fs/promises", "node:path"], "the route's only packages read files and join paths");
  assert.ok(routeReach.files.includes(path.join(root, "src/lib/echo/saved-check.ts")) && routeReach.files.includes(path.join(root, "src/lib/echo/portable.ts")));
  assert.ok(routeReach.files.includes(path.join(root, "src/lib/echo/upstream.ts")), "the shared-name rule (upstream.ts) is among the files scanned below");
  // The command line loads its three .ts modules by path, so their reach is checked from each of them.
  const cliSource = fs.readFileSync(CLI, "utf8");
  const cliModules = [...cliSource.matchAll(/load\(path\.join\(projectRoot, "([^"]+\.ts)"\)\)/g)].map((match) => path.join(root, match[1]));
  assert.deepEqual(cliModules.map((file) => path.relative(root, file)).sort(), ["src/lib/echo/origin-layer.ts", "src/lib/echo/portable.ts", "src/lib/echo/saved-check.ts"]);
  assert.deepEqual(importsOf(CLI).map((entry) => entry.spec).sort(), ["node:fs", "node:module", "node:path", "node:url"], "the command line imports no network module");
  const everyFile = new Set([...routeReach.files, CLI, ...cliModules.flatMap((file) => { const found = reach(file); assert.deepEqual(found.packages, [], `${path.relative(root, file)} needs no package`); return found.files; })]);
  for (const file of everyFile) {
    const source = fs.readFileSync(file, "utf8");
    const name = path.relative(root, file);
    assert.ok(!source.includes("process.env"), `${name} reads no setting`);
    assert.ok(!/\bfetch\s*\(/.test(source), `${name} makes no request`);
    assert.doesNotMatch(source, /XMLHttpRequest|WebSocket|EventSource|sendBeacon|node:(?:http|https|net|tls|dgram|child_process)\b/, `${name} has no other way out`);
  }
  const routeSource = fs.readFileSync(ROUTE, "utf8");
  assert.doesNotMatch(routeSource, /pipeline/, "the route never names the pipeline");
  assert.ok(!routeSource.includes("process.env") && !routeSource.includes("fetch("));
  assert.doesNotMatch(cliSource, /ECHO_MCP_LIVE|ECHO_URL|api\/analyze/, "the command line has no live mode");

  // The route answers GET (and the browser's OPTIONS question) and nothing else: no POST, nothing that could spend.
  const sf = ts.createSourceFile(ROUTE, routeSource, ts.ScriptTarget.Latest, true);
  const exported = (statement) => statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const names = sf.statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) return ["(a re-export)"];
    if (ts.isFunctionDeclaration(statement) && exported(statement)) return [statement.name?.text ?? "(default)"];
    if (ts.isVariableStatement(statement) && exported(statement)) return statement.declarationList.declarations.map((declaration) => declaration.name.getText(sf));
    return [];
  });
  assert.deepEqual(names.sort(), ["GET", "OPTIONS", "dynamic", "runtime"], "the route exports GET, OPTIONS and its two settings only");
  assert.deepEqual(Object.keys(route).filter((name) => /^[A-Z]+$/.test(name)).sort(), ["GET", "OPTIONS"]);
  // It is free, so it is not one of the paid routes check:links guards, and no page or component requests it.
  const paidLines = fs.readFileSync(path.join(root, "scripts/check-links.mjs"), "utf8").split("\n").filter((line) => /^const PAID_(?:ROUTES|PATH) = /.test(line));
  assert.equal(paidLines.length, 2, "check-links.mjs still names its paid routes in PAID_ROUTES and PAID_PATH");
  for (const line of paidLines) assert.ok(!line.includes("echo-check"), "check-links.mjs does not list /api/echo-check as a paid route");
  const appDir = path.join(root, "src/app");
  const filesIn = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : /\.(?:ts|tsx)$/.test(entry.name) ? [path.join(dir, entry.name)] : []));
  for (const file of filesIn(appDir).filter((name) => !name.startsWith(path.join(appDir, "api") + path.sep))) {
    const page = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && /(?:^|\.)fetch$/.test(node.expression.getText(page)) && node.arguments.some((argument) => argument.getText(page).includes("echo-check"))) assert.fail(`${path.relative(root, file)} requests /api/echo-check; the route is for agents outside the app`);
      ts.forEachChild(node, visit);
    };
    visit(page);
  }
}

// 7. The README section names the three ways as they are, and where the tool JSON is.
{
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const start = readme.indexOf("## Call Echo from any agent");
  assert.ok(start >= 0, "README has the section");
  const next = readme.indexOf("\n## ", start + 1);
  const section = readme.slice(start, next < 0 ? undefined : next);
  for (const line of ["claude mcp add --scope user echo -- node ", "/api/echo-check?claim=", "node mcp/echo-cli.mjs ", "mcp/echo-check.tool.json", "npm run check:echo-api", "`shared_names`", "may share a source"]) assert.ok(section.includes(line), `the README section shows: ${line}`);
  assert.doesNotMatch(section, /is copied from(?! another)/, "the README never says an origin is copied from a shared name");
  assert.doesNotMatch(section, /\b(?:customers?|revenue|proves?|proven)\b/i, "no claim about who pays, and no overclaim");
}

assert.deepEqual(networkCalls, [], "nothing in this check made a network call");
Module._resolveFilename = resolveFilename;
process.stdout.write(`Echo API check passed: ${counts.claims} saved claims (${counts.runs} run files) answered from their newest run by the saved-check module, the HTTP route and the command line; ${counts.compared} claims compared with the MCP tool, refusals included; the tool JSON matches the MCP tool; shared_names agrees across the module, the HTTP route, the command line and the MCP tool; no network call and no setting read.\n`);
