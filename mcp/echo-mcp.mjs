#!/usr/bin/env node
// Echo's MCP server: one tool, echo_check(claim), so an agent can count a claim's independent origins before it
// answers. Speaks MCP over stdio (newline-delimited JSON-RPC) with no dependency beyond this repo.
//
// What a call costs:
//   - A claim Echo has a saved run for (public/demo-traces and mcp/traces, plus any folder in ECHO_MCP_TRACES; the
//     newest run of a claim wins): free, offline.
//   - Any other claim: nothing runs unless ECHO_MCP_LIVE=1, and then it asks the Echo server at ECHO_URL
//     (default http://localhost:3000) for a live trace, which spends search and Claude credit (about $0.25)
//     through that server's daily caps.
// Add it to Claude Code:   claude mcp add --scope user echo -- node /absolute/path/to/echo/mcp/echo-mcp.mjs
//   (--scope user makes the tool available in every folder; without it the server is added to the current folder only.)
// On a Telem-routed run the reply also carries `engines` (per engine: pages kept, origins reached, origins only that
// engine reached), `engines_needed` ({needed, of}: the fewest engines whose pages together reach every origin of the
// run) and `engines_summary`, the same finding as one order-free line.
// When at least half of a run's origins mention one name that no page of the run is the source of, the reply carries
// `shared_names` ([{name, origins_naming_it, of_origin_publishers, origin_names}]) and `shared_names_note`: the
// origins may share a source search did not return. Found by rule from the saved passages (src/lib/echo/upstream.ts).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const load = createRequire(import.meta.url);
const ts = load("typescript");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
};
const { echoCheck } = load(path.join(projectRoot, "src/lib/echo/origin-layer.ts"));
const { parsePortableTrace } = load(path.join(projectRoot, "src/lib/echo/portable.ts"));
const { upstreamHints } = load(path.join(projectRoot, "src/lib/echo/upstream.ts"));

const LIVE = process.env.ECHO_MCP_LIVE === "1";
const ECHO_URL = (process.env.ECHO_URL || "http://localhost:3000").replace(/\/+$/, "");
// mcp/traces: saved live runs kept for the tool (the Telem-routed runs, which carry each page's search engines).
const TRACE_DIRS = [path.join(projectRoot, "public/demo-traces"), path.join(projectRoot, "mcp/traces"), ...(process.env.ECHO_MCP_TRACES ? process.env.ECHO_MCP_TRACES.split(path.delimiter) : [])];
// Words that do not change which claim is meant: articles, auxiliaries, pronouns and question padding.
const STOP = new Set("a an and are as at be by do does did for from has have how in is it its of on or that the their they them this to was we were what when which who why with you your our my i me he she his her really actually just only true false fact myth".split(" "));

// Number words up to ninety-nine count as their digits ("three-second" = "3-second", "ninety-six" = "96"), so a
// spelled-out figure meets the same-figure rule below. A lone "one" stays a word ("does one lose..."), and so does a
// number word before hundred/thousand/million, which is a different figure.
const SMALL = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const BIG = "(?![\\s-]+(?:hundred|thousand|million|billion|trillion))";
const NUMBER_WORDS = new RegExp(`\\b(${Object.keys(TENS).join("|")})(?:[\\s-]+(${Object.keys(SMALL).slice(0, 9).join("|")}))?\\b${BIG}|\\b(${Object.keys(SMALL).slice(1).join("|")})\\b${BIG}`, "g");
function digits(text) {
  return text.replace(NUMBER_WORDS, (_match, tens, unit, small) => String(tens ? TENS[tens] + (unit ? SMALL[unit] : 0) : SMALL[small]));
}

function keyWords(text) {
  return new Set((digits(text.toLowerCase()).replace(/(\d)%/g, "$1 percent").match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !STOP.has(word)).map((word) => (word.length > 4 ? word.replace(/(?:es|s)$/, "") : word)));
}

/** Saved traces, newest first for each claim. Read on every call so a trace saved while the server runs is found. */
function savedTraces() {
  const found = [];
  for (const dir of TRACE_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".echo.json")); } catch { continue; }
    for (const name of names) {
      try {
        const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
        // A "Check these sources" run covers only the links someone supplied, so it does not answer a search question.
        if (analysis && analysis.mode === "live" && !analysis.sourceCheck) found.push({ file: name, analysis });
      } catch { /* not a trace */ }
    }
  }
  return found.sort((a, b) => b.analysis.createdAt.localeCompare(a.analysis.createdAt));
}

/**
 * A saved run answers a claim only when it is the same claim: the same figures, and the same key words give or take
 * one word that one side leaves out ("we use 10% of our brain" for "Humans use only 10% of their brains"). A claim
 * with a word swapped ("3-month memory", "through your feet", "96 times an hour") shares neither side's full set, so
 * it is refused: a different claim must never be answered from this run's score.
 */
function savedMatch(claim) {
  const asked = keyWords(claim);
  if (asked.size < 2) return null;
  const numbers = (words) => [...words].filter((word) => /^\d/.test(word));
  let best = null;
  for (const entry of savedTraces()) {
    const have = keyWords(entry.analysis.claim);
    if (numbers(asked).some((number) => !have.has(number)) || numbers(have).some((number) => !asked.has(number))) continue;
    const missingFromAsked = [...have].filter((word) => !asked.has(word)).length;
    const extraInAsked = [...asked].filter((word) => !have.has(word)).length;
    // One side must contain the other, and the smaller side may lack at most one word.
    if ((missingFromAsked && extraInAsked) || missingFromAsked + extraInAsked > 1) continue;
    const distance = missingFromAsked + extraInAsked;
    if (!best || distance < best.distance) best = { ...entry, distance };
  }
  return best;
}

async function liveTrace(claim) {
  const response = await fetch(`${ECHO_URL}/api/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claim }), signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error ?? `Echo's server answered ${response.status}.`);
  }
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      // Split on "\n" only: a page title may hold U+2028/U+2029, which a multiline regex would treat as a line end.
      const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (!event || !data) continue;
      if (event === "result") return JSON.parse(data);
      if (event === "error") throw new Error(JSON.parse(data).message ?? "Echo could not finish the trace.");
    }
  }
  throw new Error("Echo's server closed the connection before a result.");
}

// What shared_names means, in one sentence. The same sentence as SHARED_NAMES_NOTE in src/lib/echo/saved-check.ts;
// scripts/check-echo-api.mjs holds the two to the same words.
const SHARED_NAMES_NOTE = "When at least half of a run's origins mention the same name and no page of the run is that source, those origins may share a source that is not among the pages, so num_origins may be too high; the names are found by rule from the saved passages and are a hint to check, not a finding.";

/** The shared-name fields of a reply, or nothing when the run has no such name. By rule, no model call. */
function sharedNames(analysis) {
  const names = upstreamHints(analysis)
    .filter((hint) => !hint.amongPages)
    .map((hint) => ({ name: hint.name, origins_naming_it: hint.origins, of_origin_publishers: hint.of, origin_names: hint.originNames }));
  return names.length ? { shared_names: names, shared_names_note: SHARED_NAMES_NOTE } : {};
}

async function runEchoCheck(claim) {
  const saved = savedMatch(claim);
  if (saved) {
    return {
      ...echoCheck(saved.analysis),
      ...sharedNames(saved.analysis),
      asked: claim,
      ...(saved.distance ? { wording_note: `The saved run traced "${saved.analysis.claim}". Your wording differs by one key word; say which claim was checked.` } : {}),
      source: `saved Echo run of ${saved.analysis.createdAt.slice(0, 10)} (${saved.file}); not refreshed`,
    };
  }
  if (!LIVE) {
    const claims = [...new Set(savedTraces().map((entry) => entry.analysis.claim))];
    return { error: "No saved Echo run matches this claim, and live runs are off for this server (set ECHO_MCP_LIVE=1 to allow them; each one spends about $0.25 of search and Claude credit).", saved_claims: claims };
  }
  const analysis = await liveTrace(claim);
  return { ...echoCheck(analysis), ...sharedNames(analysis), asked: claim, source: `live Echo run just now through ${ECHO_URL}` };
}

const TOOL = {
  name: "echo_check",
  description: "Count the independent origins behind a factual claim before you answer it. Search engines count sources; Echo traces which retrieved pages merely repeat another page and reports how many independent origins remain, each origin's type (primary document, original reporting, press release, social post, ...) and an Echo Score from 0 (one unverified origin echoed many times) to 100 (several independent origins with evidence of their own). Call it when a user asks whether a statistic, quote or widely repeated claim is true or well supported, then state how many independent origins there are and name them. Report the page split exactly as the `summary` field gives it: pages \"not tied to an origin\" are neither copies nor origins, so never say that every page leads back to the origin unless that count is 0. The score rates the evidence base, not truth: the origins may support the claim or contradict it (see `echo_answer`). When the run was routed through several search engines, the result also has `engines_needed` ({needed, of}: the fewest engines whose pages together reach every origin of that run) and `engines_summary`, which says it in one line: report that line as it is. It is hindsight on one run, so never use it to rank search engines. When `shared_names` is present, at least half of the run's origins mention the same name (a person, a book, a report) and no page of the run is that source: say the origins \"may share a source\" and that `num_origins` may then be too high, never that one page \"is copied from\" another, because it is a hint found by rule and not a finding.",
  inputSchema: { type: "object", properties: { claim: { type: "string", description: "The claim as one full sentence, e.g. \"Americans check their phones 96 times a day\"." } }, required: ["claim"], additionalProperties: false },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  const reply = (result) => { if (id !== undefined) send({ jsonrpc: "2.0", id, result }); };
  if (method === "initialize") {
    return reply({
      protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "echo", version: "0.1.0" },
      instructions: "Echo counts origins, not sources. Before answering whether a widely repeated claim or statistic is true, call echo_check with the claim and report the number of independent origins and their types.",
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: [TOOL] });
  if (method === "tools/call") {
    if (params?.name !== TOOL.name) return reply({ content: [{ type: "text", text: `Unknown tool: ${params?.name}` }], isError: true });
    const claim = typeof params?.arguments?.claim === "string" ? params.arguments.claim.trim() : "";
    if (!claim || claim.length > 500) return reply({ content: [{ type: "text", text: "Pass the claim as one sentence of at most 500 characters." }], isError: true });
    try {
      const result = await runEchoCheck(claim);
      return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: Boolean(result.error) });
    } catch (error) {
      return reply({ content: [{ type: "text", text: `Echo could not check this claim: ${error instanceof Error ? error.message : String(error)}` }], isError: true });
    }
  }
  if (id !== undefined && !String(method).startsWith("notifications/")) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

// Run directly with a claim to try it without an MCP client:  node mcp/echo-mcp.mjs --check "Goldfish have a 3-second memory"
const checkAt = process.argv.indexOf("--check");
if (checkAt >= 0) {
  process.stdout.write(`${JSON.stringify(await runEchoCheck(process.argv.slice(checkAt + 1).join(" ")), null, 2)}\n`);
} else {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    const task = handle(message).catch((error) => process.stderr.write(`[echo-mcp] ${error instanceof Error ? error.message : String(error)}\n`)).finally(() => pending.delete(task));
    pending.add(task);
  });
  // Exit only once every queued reply has been handed to the pipe (an empty write's callback runs after them).
  lines.on("close", async () => { await Promise.allSettled([...pending]); process.stdout.write("", () => process.exit(0)); });
}
