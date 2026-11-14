#!/usr/bin/env node
// echo_check from a command line, for any agent or script that can run a command:
//   node mcp/echo-cli.mjs "Americans check their phones 96 times a day"      the check as plain text
//   node mcp/echo-cli.mjs "Goldfish have a three-second memory" --json       the same check as JSON
//   node mcp/echo-cli.mjs --list                                             the claims that have a saved run
//   node mcp/echo-cli.mjs "<claim>" --links                                  the saved "Check these sources" run of a claim
//
// Offline and free. It answers only from the saved run files in this repo (public/demo-traces and mcp/traces), with
// the matching rule the MCP tool uses (src/lib/echo/saved-check.ts). It has no network code and reads no setting, so
// it cannot start a search or a model call. A claim with no saved run is refused (exit code 1) with the list of
// claims that have one. A live run of a new claim is the MCP tool's live mode or the app, and those spend.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const load = createRequire(import.meta.url);
const ts = load("typescript");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
load.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
};
const { savedCheck, savedClaims } = load(path.join(projectRoot, "src/lib/echo/saved-check.ts"));
const { ORIGIN_TYPE_LABELS } = load(path.join(projectRoot, "src/lib/echo/origin-layer.ts"));
const { parsePortableTrace } = load(path.join(projectRoot, "src/lib/echo/portable.ts"));

const TRACE_DIRS = [path.join(projectRoot, "public/demo-traces"), path.join(projectRoot, "mcp/traces")];
const MAX_CLAIM = 500;

/** Every saved run in the two folders. Which of them may answer is the shared module's rule, not this file's. */
function savedRuns() {
  const found = [];
  for (const dir of TRACE_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".echo.json")).sort(); } catch { continue; }
    for (const name of names) {
      try {
        const analysis = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
        if (analysis) found.push({ file: name, analysis });
      } catch { /* not a trace */ }
    }
  }
  return found;
}

const count = (value, one, many) => `${value} ${value === 1 ? one : many}`;
const ROUTED = { telem: "searched through Telem", tavily: "searched through Tavily", "links supplied": "read from links someone supplied, with no search" };

/** The check as plain text: every figure is the saved run's own, read from the reply. */
function asText(check) {
  const row = (label, value) => `${label.padEnd(16)}${value}`;
  const lines = [
    "Echo check: saved run, offline, no cost",
    "",
    row("Claim checked", check.claim),
    row("Echo Score", `${check.echo_score} of 100 (${check.label})`),
    row("Origins", `${count(check.num_origins, "independent origin", "independent origins")}, ${count(check.num_publishers, "publisher", "publishers")}`),
    row("Pages", `${check.num_results} about this claim: ${count(check.pages.origin_pages, "origin page", "origin pages")}, ${count(check.pages.confirmed_copies, "confirmed copy", "confirmed copies")}, ${check.pages.not_tied_to_an_origin} not tied to an origin`),
    "",
    check.summary,
  ];
  if (check.wording_note) lines.push("", `Wording: ${check.wording_note}`);
  if (check.scope_note) lines.push("", `Scope: ${check.scope_note}`);
  if (check.origins.length) {
    lines.push("", "Independent origins");
    check.origins.forEach((origin, index) => {
      const type = (ORIGIN_TYPE_LABELS[origin.type] ?? origin.type).toLowerCase();
      lines.push(`  ${index + 1}. ${origin.name} (${type}${origin.date ? `, dated ${origin.date}` : ", no date read"}). ${origin.own_evidence ? "Shows evidence of its own." : "No evidence of its own in this passage."} Repeated by ${count(origin.repeated_by, "other page", "other pages")}.`);
      lines.push(`     ${origin.url}`);
    });
  }
  if (check.warning) lines.push("", `Warning: ${check.warning}`);
  if (check.shared_names?.length) {
    lines.push("");
    for (const shared of check.shared_names) lines.push(row("Shared name", `${shared.name}, in the saved passage of ${shared.origins_naming_it} of ${count(shared.of_origin_publishers, "origin publisher", "origin publishers")}: ${shared.origin_names.join(", ")}`));
    lines.push(`  ${check.shared_names_note}`);
  }
  if (check.engines_needed) {
    lines.push("", row("Engines needed", `${check.engines_needed.needed} of ${check.engines_needed.of}, by this run's record`));
    if (check.engines_summary) lines.push(`  ${check.engines_summary}`);
  }
  if (check.echo_answer) lines.push("", "Echo's answer, written from the origin pages only", `  ${check.echo_answer}`);
  lines.push("", row("Run", `captured ${check.captured}, ${ROUTED[check.routed_by] ?? check.routed_by}, file ${check.file}. Not refreshed.`), row("Note", check.note));
  return lines.join("\n");
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const claim = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();
const kind = flags.has("--links") ? "links" : "search";
const print = (text) => process.stdout.write(`${text}\n`);

if (flags.has("--help") || [...flags].some((flag) => !["--json", "--links", "--list", "--help"].includes(flag))) {
  print('Usage: node mcp/echo-cli.mjs "<claim as one sentence>" [--json] [--links]\n       node mcp/echo-cli.mjs --list [--links]\nSaved runs only: offline, no cost. A claim with no saved run is refused.');
  process.exitCode = flags.has("--help") ? 0 : 2;
} else if (flags.has("--list")) {
  const claims = savedClaims(savedRuns(), kind);
  print(flags.has("--json") ? JSON.stringify(claims, null, 2) : claims.join("\n"));
} else if (!claim || claim.length > MAX_CLAIM) {
  print(`Pass the claim as one sentence of at most ${MAX_CLAIM} characters, in quotes.`);
  process.exitCode = 2;
} else {
  const runs = savedRuns();
  const check = savedCheck(claim, runs, kind);
  if (check) {
    print(flags.has("--json") ? JSON.stringify(check, null, 2) : asText(check));
  } else {
    const claims = savedClaims(runs, kind);
    const error = "No saved Echo run matches this claim. This command answers from saved runs only: it never searches and never spends.";
    print(flags.has("--json") ? JSON.stringify({ error, hint: claims }, null, 2) : [error, "", "Claims that have a saved run:", ...claims.map((saved) => `  ${saved}`)].join("\n"));
    process.exitCode = 1;
  }
}
