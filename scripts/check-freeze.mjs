// Pre-freeze gate: one command on the freeze commit, a clear GO or NO-GO. No paid provider calls.
//   node scripts/check-freeze.mjs                 checks HEAD
//   node scripts/check-freeze.mjs main demo       checks each ref in turn (one after another, never two servers at once)
//   options: --allow-trace-diff   public/demo-traces/ may differ from `demo` (listed, not failed)
//            --keep               keep the temp clone(s) and step logs
//            --verbose            stream every step's output (otherwise only a failing step's last lines)
//            --tmp <dir>          where the temp clone goes (default: the OS temp folder; never the repo or iCloud)
// For each ref it
//   1. clones the repo into a fresh temp folder (git clone --no-hardlinks, then checks out the ref's commit), runs
//      npm ci and the full verify list there: lint; every check:* script the ref has; build; smoke:ui;
//      preflight -- --serve; measure:cost if the ref has it. A pass proves the ref needs no untracked file. Then it
//      reports any file in the clone that differs from git, and any stray " 2" duplicate file;
//   2. compares public/demo-traces/ between `demo` and the ref, byte for byte (git diff demo <ref>): every trace demo
//      has must be unchanged; the only trace a ref may add is one in ALLOWED_NEW_TRACES (the saved Check these sources
//      run), matching its recorded SHA-256 and its fixture;
//   3. reads the stage headline numbers from the ref's bundled traces and checks them against DEMO_DAY.md and the
//      figures said on stage (slot 02: 13 pages → 2 independent origins, 31% echo; slot 01: 20 pages, 8 root pages,
//      no origin with its own evidence, 15% echo);
//   4. warns if this repo's own working tree is not clean.
// Money: the clone never gets .env.local (it is untracked, so git clone cannot copy it), every provider key and
// budget variable is blanked in the clone's environment, and the run fails if an env file shows up in the clone.
// Exit code 0 only when every ref is GO.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const optionValues = new Set([option("--tmp")].filter(Boolean));
const refs = argv.filter((arg) => !arg.startsWith("--") && !optionValues.has(arg));
if (!refs.length) refs.push("HEAD");
const allowTraceDiff = flag("--allow-trace-diff");
const keep = flag("--keep");
const verbose = flag("--verbose");
const STEP_TIMEOUT_MS = 20 * 60_000;
const TRACE_DIR = "public/demo-traces/";
const out = (line = "") => process.stdout.write(`${line}\n`);

// The figures said on stage (DEMO_DAY.md "On stage"). A freeze commit whose traces or runbook say otherwise is NO-GO.
const STAGE = {
  "02": { pages: 13, origins: 2, echo: 31 },
  "01": { pages: 20, roots: 8, verifiable: 0, echo: 15 },
};

// Bundled traces a ref may add on top of demo's (step 2): each must be this exact file, a byte-for-byte copy of its
// fixture. The saved Check these sources run (2026-11-13, 5 supplied phones links → 1 independent origin).
const ALLOWED_NEW_TRACES = {
  "public/demo-traces/check-these-sources-phones.echo.json": {
    fixture: "scripts/fixtures/sources-phones-live-2026-11-13-v2.echo.json",
    sha256: "71b2331f166dfaf36a6da745c27f1623d4588746df8116933fbfffc33e9b9dd3",
  },
};

function git(args, cwd = scriptRoot) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

/** A git command's raw output bytes (untrimmed, for checksums), or null when it fails. */
function gitBytes(args, cwd = scriptRoot) {
  const result = spawnSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

const top = git(["rev-parse", "--show-toplevel"]);
if (!top.ok) { out(`check:freeze: not a git repository (${top.stderr})`); process.exit(1); }
const repoRoot = fs.realpathSync(top.stdout);

// --- Temp folder: outside the repo and outside iCloud -------------------------------------------------------------
const tmpBase = fs.realpathSync(option("--tmp") ? path.resolve(option("--tmp")) : os.tmpdir());
const insideRepo = (dir) => dir === repoRoot || dir.startsWith(`${repoRoot}${path.sep}`);
const inICloud = (dir) => /Mobile Documents|iCloud|CloudStorage/i.test(dir);
if (insideRepo(tmpBase) || inICloud(tmpBase)) {
  out(`check:freeze: temp folder ${tmpBase} is inside the repo or iCloud; pass --tmp <dir> somewhere else.`);
  process.exit(1);
}

// The clone's environment: provider keys and budget storage blanked, npm's own variables from this run removed (they
// point at this repo), so every step in the clone resolves to the clone.
function cloneEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(npm_|INIT_CWD$|ANTHROPIC_|TAVILY_|TELEM_|UPSTASH_|KV_|ECHO_|OPENAI_|VERCEL)/.test(name)) continue;
    if (/(_API_KEY|_SECRET|_REST_TOKEN)$/.test(name)) continue;
    env[name] = value;
  }
  // Blank, not just unset: a blank key also overrides any env file Next might find.
  Object.assign(env, { ANTHROPIC_API_KEY: "", TAVILY_API_KEY: "", TELEM_API_KEY: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", ECHO_COPY_HUNT: "0", ECHO_PRESENTER_KEY: "", NEXT_TELEMETRY_DISABLED: "1" });
  return env;
}

// Files named like an iCloud or Finder copy: "page 2.tsx", "BUILD_ID 3".
const DUPLICATE = /^.+ [2-9](\.[^/ ]+)*$/;
function findDuplicates(dir, skip = new Set([".git", "node_modules", ".claude"])) {
  const found = [];
  const walk = (current) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (DUPLICATE.test(entry.name)) found.push(path.relative(dir, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return found;
}

const activeChildren = new Set();
const tempDirs = new Set();
function cleanup() {
  for (const child of activeChildren) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
  if (!keep) for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { out(`\ncheck:freeze: ${signal}, cleaning up`); cleanup(); process.exit(130); });

// Runs one command in the clone, its output to a log file; resolves with pass/fail, seconds and the last lines.
function runStep(command, args, cwd, logFile) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = fs.createWriteStream(logFile);
    let tail = "";
    const child = spawn(command, args, { cwd, env: cloneEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    activeChildren.add(child);
    const onData = (chunk) => {
      log.write(chunk);
      tail = (tail + chunk.toString()).slice(-6000);
      if (verbose) process.stdout.write(chunk);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, STEP_TIMEOUT_MS);
    const finish = (code, error) => {
      clearTimeout(timer);
      activeChildren.delete(child);
      // A step's own servers (next start) must not outlive it.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      log.end();
      if (error) tail += `\n${error.message}`;
      if (timedOut) tail += `\n(timed out after ${STEP_TIMEOUT_MS / 60_000} minutes)`;
      resolve({ ok: code === 0 && !timedOut && !error, seconds: Math.round((Date.now() - started) / 1000), tail });
    };
    child.on("error", (error) => finish(1, error));
    child.on("close", (code) => finish(code));
  });
}

const lastLines = (text, count) => text.trimEnd().split("\n").slice(-count);

async function checkRef(ref) {
  const rows = []; // [area, result, detail]
  const add = (area, result, detail = "") => {
    rows.push([area, result, detail]);
    out(`  ${result.padEnd(5)} ${area}${detail ? ` — ${detail}` : ""}`);
  };
  const resolved = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!resolved.ok) {
    out(`\n=== ${ref}: unknown ref`);
    add("ref", "FAIL", `${ref} is not a commit in ${repoRoot}`);
    return { ref, sha: "", rows };
  }
  const sha = resolved.stdout;
  out(`\n=== ${ref} (${sha.slice(0, 7)}: ${git(["log", "-1", "--format=%s", sha]).stdout})`);

  // 2. Bundled traces identical to the frozen demo branch. Every trace demo has must be byte-identical (none changed or
  //    removed); a trace demo lacks is allowed only if it is listed in ALLOWED_NEW_TRACES and its bytes match the recorded
  //    SHA-256 and, when the ref has it, its source fixture. Anything else fails unless --allow-trace-diff.
  const demo = git(["rev-parse", "--verify", "--quiet", "demo^{commit}"]);
  if (!demo.ok) add("traces vs demo", "FAIL", "no `demo` branch in this repo");
  else {
    const stat = git(["diff", "--stat", demo.stdout, sha, "--", TRACE_DIR]);
    const changes = git(["diff", "--name-status", "--no-renames", demo.stdout, sha, "--", TRACE_DIR]).stdout.split("\n").filter(Boolean).map((line) => { const [status, file] = line.split("\t"); return { status, file }; });
    const kept = git(["ls-tree", "--name-only", `${demo.stdout}:${TRACE_DIR}`]).stdout.split("\n").filter(Boolean);
    const allowed = [];
    const problems = [];
    for (const { status, file } of changes) {
      const rule = ALLOWED_NEW_TRACES[file];
      if (status !== "A" || !rule) { problems.push(`${file} ${status === "A" ? "added (not in ALLOWED_NEW_TRACES)" : status === "D" ? "removed" : "changed"}`); continue; }
      const bytes = gitBytes(["show", `${sha}:${file}`]);
      const digest = bytes && createHash("sha256").update(bytes).digest("hex");
      const fixture = gitBytes(["show", `${sha}:${rule.fixture}`]);
      if (digest !== rule.sha256) problems.push(`${file} added but its SHA-256 is ${digest?.slice(0, 12) ?? "unreadable"}…, not the recorded ${rule.sha256.slice(0, 12)}…`);
      else if (fixture && !fixture.equals(bytes)) problems.push(`${file} added but differs from ${rule.fixture}`);
      else allowed.push(`${path.basename(file)} (${fixture ? `= ${path.basename(rule.fixture)}, ` : ""}sha256 ${digest.slice(0, 12)}…)`);
    }
    if (!stat.ok) add("traces vs demo", "FAIL", stat.stderr);
    else if (!problems.length) add("traces vs demo", "ok", `the ${kept.length} demo traces identical to demo (${demo.stdout.slice(0, 7)})${allowed.length ? `; allowed new: ${allowed.join(", ")}` : ""}`);
    else {
      for (const line of stat.stdout.split("\n")) out(`          ${line}`);
      add("traces vs demo", allowTraceDiff ? "WARN" : "FAIL", `${problems.length} trace file(s) differ from demo: ${problems.join("; ")}${allowTraceDiff ? " (allowed by --allow-trace-diff)" : " (pass --allow-trace-diff to accept)"}`);
    }
  }

  // 3. Stage headline numbers: the ref's slot → trace mapping, its bundled traces, its DEMO_DAY.md.
  const show = (file) => { const result = git(["show", `${sha}:${file}`]); return result.ok ? result.stdout : null; };
  const slotSource = show("src/app/demo-slots.ts") ?? show("src/app/echo-workbench.tsx") ?? "";
  const slotTrace = Object.fromEntries([...slotSource.matchAll(/slot: "(\d+)"[^}]*?capturedTrace: "([^"]+)"/g)].map((match) => [match[1], match[2]]));
  const runbook = show("DEMO_DAY.md") ?? "";
  const said = {
    "02": runbook.match(/\*\*02 [^*]+\*\*\. Headline: "(\d+) pages → (\d+) independent origins?", (\d+)% echo/),
    // Since 2026-11-13 the headline says "No origin with its own evidence — …" (0 of them) and the line counts
    // "8 root pages, 8 independent origins"; the older wording ("0 verifiable origins", "8 roots") still reads (demo).
    "01": runbook.match(/\*\*01 [^*]+\*\* \(headline "(\d+|No) (?:verifiable origins?|independent origins? with (?:its|their) own evidence|origins? with (?:its|their) own evidence)[^"]*", (\d+) pages, (\d+) (?:roots|root pages)(?:, \d+ independent origins?)?, (\d+)% echo\)/),
  };
  const fromRunbook = {
    "02": said["02"] && { pages: +said["02"][1], origins: +said["02"][2], echo: +said["02"][3] },
    "01": said["01"] && { verifiable: said["01"][1] === "No" ? 0 : +said["01"][1], pages: +said["01"][2], roots: +said["01"][3], echo: +said["01"][4] },
  };
  for (const slot of ["02", "01"]) {
    const want = STAGE[slot];
    const describe = (figures) => Object.entries(figures).map(([key, value]) => `${key} ${value}`).join(", ");
    const problems = [];
    if (!fromRunbook[slot]) problems.push(`DEMO_DAY.md has no slot ${slot} headline line`);
    else {
      const off = Object.keys(want).filter((key) => fromRunbook[slot][key] !== want[key]);
      if (off.length) problems.push(`DEMO_DAY.md says ${describe(fromRunbook[slot])}`);
    }
    let got = null;
    const tracePath = slotTrace[slot];
    const raw = tracePath ? show(`public${tracePath}`) : null;
    if (!tracePath) problems.push(`no slot ${slot} trace found in the ref's demo slots`);
    else if (raw === null) problems.push(`${tracePath} is not committed`);
    else {
      try {
        const analysis = JSON.parse(raw).analysis;
        got = { pages: analysis.summary.totalPages, origins: analysis.summary.independentOrigins, roots: analysis.roots.length, verifiable: analysis.summary.verifiableOrigins, echo: analysis.summary.echoPercentage };
        if (analysis.pages.length !== got.pages) problems.push(`trace lists ${analysis.pages.length} pages but its summary says ${got.pages}`);
        const off = Object.keys(want).filter((key) => got[key] !== want[key]);
        if (off.length) problems.push(`trace has ${off.map((key) => `${key} ${got[key]}`).join(", ")}`);
      } catch (error) { problems.push(`${tracePath} does not parse: ${error.message}`); }
    }
    const label = `slot ${slot} headline`;
    if (problems.length) add(label, "FAIL", `stage says ${describe(want)}; ${problems.join("; ")}`);
    else add(label, "ok", `${describe(want)} (trace and DEMO_DAY.md agree)`);
  }

  // Tracked files named like an iCloud copy break the build ("Duplicate identifier").
  const trackedDuplicates = git(["ls-tree", "-r", "--name-only", sha]).stdout.split("\n").filter((file) => DUPLICATE.test(path.basename(file)));
  if (trackedDuplicates.length) add("tracked \" 2\" files", "FAIL", trackedDuplicates.join(", "));

  // 1. Fresh clone, full verify list.
  const work = fs.mkdtempSync(path.join(tmpBase, "echo-freeze-"));
  tempDirs.add(work);
  const clone = path.join(work, "repo");
  const logs = path.join(work, "logs");
  fs.mkdirSync(logs);
  const cloned = git(["clone", "--quiet", "--no-hardlinks", repoRoot, clone], work);
  const checkedOut = cloned.ok && git(["checkout", "--quiet", sha], clone);
  if (!cloned.ok || !checkedOut.ok) {
    add("clone", "FAIL", (cloned.ok ? checkedOut.stderr : cloned.stderr) || "git clone failed");
    return { ref, sha, rows, work };
  }
  out(`          clone: ${clone}`);
  const envFiles = () => fs.readdirSync(clone).filter((name) => /^\.env/.test(name) && name !== ".env.example");
  const hasLedger = () => fs.existsSync(path.join(clone, ".echo"));
  if (envFiles().length || hasLedger()) {
    add("clone has no secrets", "FAIL", `found ${[...envFiles(), ...(hasLedger() ? [".echo/"] : [])].join(", ")} before any step ran; stopping`);
    return { ref, sha, rows, work };
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(clone, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  const checks = Object.keys(scripts).filter((name) => name.startsWith("check:") && name !== "check:freeze");
  const steps = [
    { name: "npm ci", args: ["ci", "--no-audit", "--no-fund"] },
    { name: "lint", args: ["run", "lint"] },
    ...checks.map((name) => ({ name, args: ["run", name] })),
    { name: "build", args: ["run", "build"] },
    { name: "smoke:ui", args: ["run", "smoke:ui"], needsBuild: true },
    { name: "preflight --serve", args: ["run", "preflight", "--", "--serve"], needsBuild: true },
    ...(scripts["measure:cost"] ? [{ name: "measure:cost", args: ["run", "measure:cost"] }] : []),
  ];
  for (const required of ["lint", "build", "smoke:ui", "preflight"]) if (!scripts[required]) add(required, "FAIL", "the ref has no such npm script");
  let installed = true;
  let built = true;
  for (const step of steps) {
    if (step.name !== "npm ci" && !installed) { add(step.name, "skip", "npm ci failed"); continue; }
    if (step.needsBuild && !built) { add(step.name, "skip", "build failed"); continue; }
    if (step.args[0] === "run" && !scripts[step.args[1]]) continue;
    out(`  ...   ${step.name}`);
    const logFile = path.join(logs, `${step.name.replace(/[^\w.-]+/g, "_")}.log`);
    const result = await runStep("npm", step.args, clone, logFile);
    if (!result.ok) {
      if (step.name === "npm ci") installed = false;
      if (step.name === "build") built = false;
      for (const line of lastLines(result.tail, 25)) out(`          | ${line}`);
    }
    // The step's own last word, not npm's "> eslint" echo of the command.
    const last = lastLines(result.tail, 40).filter((line) => line.trim() && !line.startsWith(">")).pop() ?? "";
    add(step.name, result.ok ? "ok" : "FAIL", `${result.seconds} s${result.ok && last ? ` · ${last.trim().slice(0, 110)}` : ""}`);
  }

  // The clone after every step: anything that differs from git, a ledger or env file, stray duplicates.
  if (envFiles().length) add("clone has no secrets", "FAIL", `${envFiles().join(", ")} appeared in the clone during the run`);
  else add("clone has no secrets", "ok", `no .env file in the clone; provider keys blank in every step${hasLedger() ? "; .echo/ written by a mocked or blank-key run (ignored, deleted with the clone)" : ""}`);
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], clone).stdout.split("\n").filter(Boolean);
  if (status.length) add("clone matches git", "WARN", `${status.length} path(s) differ after the run: ${status.slice(0, 12).map((line) => line.trim()).join(", ")}${status.length > 12 ? ", …" : ""}`);
  else add("clone matches git", "ok", "no tracked file changed and no untracked file appeared (ignored build output aside)");
  const duplicates = findDuplicates(clone);
  if (duplicates.length) add("clone \" 2\" files", "FAIL", duplicates.slice(0, 12).join(", "));
  else add("clone \" 2\" files", "ok", "none outside node_modules");
  return { ref, sha, rows, work, logs };
}

out(`Echo freeze gate · repo ${repoRoot} · refs ${refs.join(", ")}`);
out("No paid calls: the clone has no .env.local and every provider key is blank.");

// 4. This repo's own working tree (warn only), and stray duplicates in it.
const realRows = [];
const realStatus = git(["status", "--porcelain"]).stdout.split("\n").filter(Boolean);
realRows.push(["working tree clean", realStatus.length ? "WARN" : "ok", realStatus.length ? `${realStatus.length} uncommitted path(s): ${realStatus.slice(0, 10).map((line) => line.trim()).join(", ")}${realStatus.length > 10 ? ", …" : ""}` : `git status --porcelain is empty in ${repoRoot}`]);
const realDuplicates = findDuplicates(repoRoot);
realRows.push(["repo \" 2\" files", realDuplicates.length ? "WARN" : "ok", realDuplicates.length ? `${realDuplicates.slice(0, 10).join(", ")}${realDuplicates.length > 10 ? ", …" : ""} (if under .next, delete .next and rebuild)` : "none outside node_modules"]);
out("\n=== this repo");
for (const [area, result, detail] of realRows) out(`  ${result.padEnd(5)} ${area} — ${detail}`);

const results = [];
try {
  for (const ref of refs) results.push(await checkRef(ref));
} finally {
  cleanup();
}

out("\n=== Summary");
const width = Math.max(...results.flatMap((result) => result.rows.map(([area]) => area.length)), ...realRows.map(([area]) => area.length), 20);
let allGo = true;
for (const result of results) {
  const failed = result.rows.filter(([, status]) => status === "FAIL");
  const warned = [...result.rows, ...realRows].filter(([, status]) => status === "WARN");
  const go = failed.length === 0 && result.rows.length > 0;
  if (!go) allGo = false;
  out(`\n${result.ref} @ ${result.sha.slice(0, 7) || "?"}`);
  for (const [area, status, detail] of result.rows) {
    const short = detail.length > 90 ? `${detail.slice(0, 89)}…` : detail;
    out(`  ${area.padEnd(width)}  ${status.padEnd(4)}  ${short}`);
  }
  out(`  → ${go ? "GO" : "NO-GO"}${failed.length ? `: ${failed.map(([area]) => area).join(", ")} failed` : ""}${warned.length ? ` (${warned.length} warning${warned.length === 1 ? "" : "s"}: ${warned.map(([area]) => area).join(", ")})` : ""}`);
  if (keep && result.work) out(`  kept: ${result.work}`);
}
out(`\nthis repo: ${realRows.map(([area, status]) => `${area} ${status}`).join("; ")}`);
out(allGo ? `\nFreeze gate: GO (${refs.join(", ")})` : `\nFreeze gate: NO-GO`);
process.exit(allGo ? 0 : 1);
