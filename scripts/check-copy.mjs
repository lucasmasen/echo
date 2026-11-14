// Offline copy check: the words on Echo's screens never claim more than a trace shows. No network, no spend.
//   node scripts/check-copy.mjs
// It reads every string literal, template text and JSX text in src/app/**/*.{ts,tsx} and fails on
//   1. overclaim words ("proves", "proof that", "verified true", "fact-checked", "is false", "100% accurate") unless
//      the sentence negates them ("not proof that …", "never fact-checked"), and
//   2. a hard-coded figure ("21 of 23", "91%") in prose. Real figures come from a trace or DEMO_SCORES at run time,
//      so they sit in template expressions, which this check never flags; a figure typed into the copy is invented.
// A demo claim ("Humans use only 10% of their brain") is the text being checked, not Echo's figure, and is skipped.
//   3. the plain-search line as rendered (plainSearchHeadline / plainSearchDetail) on the four bundled traces, variants
//      of them and every small lineage: no "match", "the web", "really" or "proof", and no more origins than the trace.
//   4. a retired name for the origin counts ("candidate roots" or "candidate-root", "independent roots", "verifiable
//      origins", "primary evidence", "roots with evidence", "root sources", "Answer from roots") anywhere in that copy:
//      the count is "independent origins", those with data of their own are "with own evidence", and root pages stay
//      "root pages". Text frozen in a saved trace (slot 01's answer) is data, not copy, and is not scanned here.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "src", "app");

const OVERCLAIM = /\b(?:proves?|proven|proof that|verified true|fact[- ]checked|is false|100% accurate)\b/gi;
// A caveat: the overclaim is negated within the few words before it ("not proof that", "never proves", "isn't
// fact-checked", "does not prove").
const NEGATION = /\b(?:not|never|no|nor|cannot|can't|isn't|aren't|doesn't|don't|didn't|without)\b(?:\s+\S+){0,3}\s*$/i;
const FIGURE = /\b\d[\d,.]*\s+of\s+(?:its\s+|the\s+|all\s+)?\d[\d,.]*\b|\b\d+(?:\.\d+)?\s?%/g;
// The independence count has one name on screen, "independent origin(s)", and the origins showing data of their own are
// "with own evidence" (Lucas, 2026-11-13). The names it replaced must not come back in copy; root pages stay "root pages".
// "root" where an origin is meant (QA #7, 11/13: slide 5's "ROOT SOURCES", "Answer from roots:", "Check the roots",
// the footer's "TRACE THE ROOTS") is retired too, hyphenated or not ("candidate-root"); "root pages" stays.
// QA round 4 D2: the answer card's "ROOTS ONLY" and "ROOTS CITED IN THE ANSWER", and the ledger's "Inspect root …" label.
const RETIRED = /\b(?:candidate[- ]roots?|independent roots?|verifiable origins?|primary[- ]evidence|roots? with (?:primary )?evidence|root sources?|(?:trace|check) the roots|answer from roots|cited roots|roots no longer cited|the roots or|an? root is|roots (?:only|cited)|inspect root(?! pages?\b))\b/gi;
// Prose has at least three words; "100%", "translate(-50%, -50%)" or "0 of 0" alone are layout values, not copy.
const isProse = (text) => (text.match(/\b[\p{L}]{2,}\b/gu) ?? []).length >= 3;

// Copy that is expected to be flagged until its owner fixes it. A listed case that no longer appears is reported as
// fixed (remove it here); it never fails the check.
const EXPECTED = [];

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

/** The demo claims (the text a trace checks), read from the slot lists, so their figures are not flagged as Echo's. */
function demoClaims() {
  const claims = new Set();
  for (const file of files(appDir)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isPropertyAssignment(node) && /^(?:claim|claimText|query)$/.test(node.name.getText(source)) && ts.isStringLiteralLike(node.initializer)) claims.add(node.initializer.text.trim());
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return claims;
}

/** Each piece of literal text in a file: string literals, the fixed parts of template literals, and JSX text. */
function literalTexts(file, code) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const add = (node, text) => {
    if (text.trim()) out.push({ text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, node });
  };
  const visit = (node) => {
    // Imports, type names and object keys are code, not copy; so are regular expressions.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!(ts.isPropertyAssignment(node.parent) && node.parent.name === node) && !ts.isElementAccessExpression(node.parent)) add(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      add(node.head, node.head.text);
      for (const span of node.templateSpans) add(span.literal, span.literal.text);
    } else if (ts.isJsxText(node)) {
      add(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The overclaim and invented-figure findings in one file's code. */
function scan(relative, code, claims) {
  const found = [];
  for (const { text, line } of literalTexts(relative, code)) {
    const flat = text.replace(/\s+/g, " ").trim();
    if (claims.has(flat)) continue;
    const context = (index, length) => flat.slice(Math.max(0, index - 60), index + length + 60);
    for (const match of flat.matchAll(OVERCLAIM)) {
      if (NEGATION.test(flat.slice(0, match.index))) continue;
      found.push({ file: relative, line, kind: "overclaim", text: match[0], context: context(match.index, match[0].length) });
    }
    for (const match of flat.matchAll(RETIRED)) found.push({ file: relative, line, kind: "retired name", text: match[0], context: context(match.index, match[0].length) });
    if (!isProse(flat)) continue;
    for (const match of flat.matchAll(FIGURE)) found.push({ file: relative, line, kind: "hard-coded figure", text: match[0].trim(), context: context(match.index, match[0].length) });
  }
  return found;
}

// The check checks itself first, on copy written to be caught and copy written to pass.
{
  const sample = `
    const slot = { claim: "Humans use only 10% of their brain" };
    const style = { width: "100%", transform: "translate(-50%, -50%)" };
    export const A = () => <p>Echo proves the claim. This is not proof that it copied. Never fact-checked by us.</p>;
    const b = \`\${matched} of \${total} pages match, about \${percent}% of them\`;
    const c = "Echo is 100% accurate";
    const d = "3 of 4 sources agree with the report";
    const e = \`\${n} pages: 12% of them echo\`;
    const f = "Slide " + 3 + " of 6";
    const g = <span>{n} candidate roots · {m} with own evidence · {k} root pages</span>;
    const h = "The candidate-root pages are listed under ROOT SOURCES";
  `;
  const got = scan("sample.tsx", sample, new Set(["Humans use only 10% of their brain"])).map((finding) => `${finding.kind}: ${finding.text}`);
  const want = ["overclaim: proves", "overclaim: 100% accurate", "hard-coded figure: 100%", "hard-coded figure: 3 of 4", "hard-coded figure: 12%", "retired name: candidate roots", "retired name: candidate-root", "retired name: ROOT SOURCES"];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.log(`Echo copy check is broken: on its own sample it found ${JSON.stringify(got)}, expected ${JSON.stringify(want)}.`);
    process.exit(1);
  }
}

// The plain-search line (plainSearchHeadline / plainSearchDetail in src/app/trace-view.ts) is built at run time, so the
// literal scan above never sees it whole. Its rendered text is checked on the four bundled traces, on variants of them
// whose first search kept other pages, and on every small lineage that adds up: it never says "match", "the web",
// "really" or "proof", and never names more origins than the trace has.
const PLAIN_BANNED = /\bmatch\w*|\bthe web\b|\breally\b|\bproofs?\b/gi;
// Every "N independent origin(s)", "N origin(s)" the line names.
const ORIGIN_COUNT = /\b(\d+)\s+(?:independent origins?|origins?)\b/g;
const FULL_TRACE = /full trace \([^)]*\) finds (?:(\d+) independent origins?|no confirmed independent origin)/;

/** What is wrong with one rendered plain-search line, for a trace with `traceOrigins` independent origins. */
function plainSearchProblems(text, traceOrigins) {
  const problems = [...text.matchAll(PLAIN_BANNED), ...text.matchAll(RETIRED)].map((match) => `says "${match[0]}"`);
  for (const match of text.matchAll(ORIGIN_COUNT)) {
    if (Number(match[1]) > traceOrigins) problems.push(`names ${match[0]} but the trace has ${traceOrigins}`);
  }
  return problems;
}

// The check checks itself: copy written to be caught, and copy written to pass.
{
  const got = plainSearchProblems("Plain search: 3 results match. Behind them: 3 independent origins, really proof; the web agrees. Counted as 2 origins.", 2);
  const want = ['says "match"', 'says "really"', 'says "proof"', 'says "the web"', "names 3 independent origins but the trace has 2"];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.log(`Echo copy check is broken: the plain-search scan found ${JSON.stringify(got)}, expected ${JSON.stringify(want)}.`);
    process.exit(1);
  }
  if (!plainSearchProblems("Plain search: 10 results, all about this claim. Behind them: 2 candidate roots; 1 page unclear.", 2).includes('says "candidate roots"')) {
    console.log("Echo copy check is broken: the plain-search scan missed a retired name.");
    process.exit(1);
  }
  if (plainSearchProblems("Plain search: 10 results, all about this claim. Behind them: 2 independent origins, 1 with its own evidence for it; 1 page unclear.", 2).length) {
    console.log("Echo copy check is broken: the plain-search scan flagged a line that names no more origins than the trace has.");
    process.exit(1);
  }
}

const plainSearchFindings = [];
{
  const load = createRequire(import.meta.url);
  load.extensions[".ts"] = (module, filename) => {
    module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  };
  const { plainSearchDetail, plainSearchHeadline, plainSearchLineage, plainSearchTooltip } = load("../src/app/trace-view.ts");
  const { parsePortableTrace } = load("../src/lib/echo/portable.ts");
  let checked = 0;
  const checkLineage = (label, lineage, traceOrigins) => {
    // The workbench, the text report, Explore and Present slide 1 render the same line (one noun since 2026-11-13).
    const where = label;
    const headline = plainSearchHeadline(lineage);
    const detail = plainSearchDetail(lineage);
    for (const [part, text] of [["headline", headline], ["detail", detail], ["tooltip", plainSearchTooltip({ ...lineage, query: "A claim" })]]) {
      for (const problem of plainSearchProblems(text, traceOrigins)) plainSearchFindings.push(`${where} ${part} ${problem}: “${text}”`);
    }
    // The full-trace clause names exactly the trace's own count.
    const named = detail.match(FULL_TRACE);
    if (!named) plainSearchFindings.push(`${where} detail does not say what the full trace finds: “${detail}”`);
    else if (Number(named[1] ?? 0) !== traceOrigins) plainSearchFindings.push(`${where} detail says the full trace finds ${named[1] ?? 0}, the trace has ${traceOrigins}: “${detail}”`);
    checked += 1;
  };

  // The four bundled search traces, and variants of each whose first search kept other pages (still valid trace files).
  // The saved Check these sources run searched nothing, so it has no plain-search line (and must not get one).
  const traceDir = path.join(root, "public", "demo-traces");
  const traceFiles = fs.readdirSync(traceDir).filter((file) => file.endsWith(".echo.json"));
  const suppliedOnly = traceFiles.filter((file) => JSON.parse(fs.readFileSync(path.join(traceDir, file), "utf8")).analysis.sourceCheck);
  for (const file of suppliedOnly) if (plainSearchLineage(JSON.parse(fs.readFileSync(path.join(traceDir, file), "utf8")).analysis)) plainSearchFindings.push(`${file}: a supplied-links run shows a plain-search line`);
  const bundled = traceFiles.filter((file) => !suppliedOnly.includes(file));
  if (bundled.length !== 4) plainSearchFindings.push(`expected 4 bundled search traces, found ${bundled.length}`);
  for (const file of bundled) {
    const portable = JSON.parse(fs.readFileSync(path.join(traceDir, file), "utf8"));
    const name = file.replace(/\.echo\.json$/, "");
    const analysis = portable.analysis;
    const lineage = plainSearchLineage(analysis);
    if (!lineage) { plainSearchFindings.push(`${name}: no plain-search line`); continue; }
    checkLineage(name, lineage, analysis.summary.independentOrigins);
    const byKind = (kind) => analysis.pages.filter((page) => page.judgment.kind === kind).map((page) => page.id);
    const variants = {
      "one root kept": byKind("origin").slice(0, 1),
      "copies only": byKind("derived"),
      "unclear only": byKind("unclear"),
      "every page kept": analysis.pages.map((page) => page.id),
      "every root kept": byKind("origin"),
    };
    for (const [variant, pageIds] of Object.entries(variants)) {
      if (!pageIds.length) continue;
      for (const returned of [pageIds.length, pageIds.length + 7]) {
        const copy = structuredClone(portable);
        // A page is added by one query only, so the later queries give up the pages the first one now keeps.
        const moved = new Set(pageIds);
        copy.analysis.searchAudit = copy.analysis.searchAudit.map((entry, index) => (index === 0
          ? { ...entry, status: "searched", totalResults: returned, matchingResults: pageIds.length, uniquePagesAdded: pageIds.length, pageIds }
          : { ...entry, pageIds: (entry.pageIds ?? []).filter((id) => !moved.has(id)) }));
        const label = `${name}, ${variant}, ${returned} returned`;
        if (!parsePortableTrace(copy)) { plainSearchFindings.push(`${label}: the variant is not a valid trace file (fix the check)`); continue; }
        const variantLineage = plainSearchLineage(copy.analysis);
        if (variantLineage) checkLineage(label, variantLineage, copy.analysis.summary.independentOrigins);
      }
    }
  }

  // Every small lineage that adds up: kept pages are roots, copies or unclear; origins come from roots and copies, are
  // no more than the trace has, and those with primary evidence are a subset.
  for (let kept = 1; kept <= 4; kept += 1) for (let rootPages = 0; rootPages <= kept; rootPages += 1) for (let copies = 0; rootPages + copies <= kept; copies += 1) {
    const unclear = kept - rootPages - copies;
    for (let rootOrigins = rootPages ? 1 : 0; rootOrigins <= rootPages; rootOrigins += 1) for (let origins = rootOrigins + (copies && !rootPages ? 1 : 0); origins <= rootOrigins + copies; origins += 1) {
      for (const traceOrigins of new Set([origins, origins + 1, origins + 3])) for (const verifiable of new Set([0, origins])) for (const traceVerifiable of new Set([0, verifiable, traceOrigins])) {
        if (traceVerifiable < verifiable) continue;
        for (const [returned, matching] of [[kept, kept], [10, kept], [10, Math.min(10, kept + 2)]]) {
          for (const copiesOfKeptRoots of rootPages && copies ? [true, false] : [copies === 0 || rootPages > 0]) {
            const lineage = { query: "A claim", returned, matching, kept, origins, verifiable, rootPages, rootOrigins, copies, copiesOfKeptRoots, unclear, searched: 5, traceOrigins, traceVerifiable };
            checkLineage(`lineage ${JSON.stringify({ kept, rootPages, rootOrigins, copies, unclear, origins, verifiable, traceOrigins, traceVerifiable, returned, matching, copiesOfKeptRoots })}`, lineage, traceOrigins);
          }
        }
      }
    }
  }
  if (checked < 100) plainSearchFindings.push(`only ${checked} plain-search lines were checked; the generator is broken`);
  for (const finding of plainSearchFindings.slice(0, 20)) console.log(`  FAIL      plain search: ${finding}`);
  if (plainSearchFindings.length) {
    console.log(`\nEcho copy check failed: ${plainSearchFindings.length} plain-search line(s) overclaim (fix plainSearchHeadline / plainSearchDetail in src/app/trace-view.ts).`);
    process.exit(1);
  }
  console.log(`Plain-search lines: ${checked} rendered (4 bundled traces, their variants and small lineages) without "match", "the web", "really", "proof", a retired name or more origins than the trace has.`);
}

// 5. The "Cite once" line and its data view on a Check these sources result (sourceCiteOnce / sourceCiteOnceData in
// src/lib/echo/supplied-urls.ts) are built at run time too. On both saved phones sources traces and every way of
// judging their five pages (origin, copy or unclear, each pointing at the page before it), the line never tells the
// reader to "drop" a link, never calls one "wrong", never says "public API" or an overclaim word or retired name, names
// exactly the links the per-link list calls an independent origin, and cites only supplied citation numbers; the data
// view is valid JSON that says it is a citation, not proof.
{
  const CITE_BANNED = /\b(?:drop(?:s|ped)?|wrong|public api)\b/gi;
  const load = createRequire(import.meta.url);
  const { sourceCiteOnce, sourceCiteOnceData, sourceLinkRows } = load("../src/lib/echo/supplied-urls.ts");
  const { parsePortableTrace } = load("../src/lib/echo/portable.ts");
  const problems = [];
  let rendered = 0;
  const checkCite = (label, analysis) => {
    const cite = sourceCiteOnce(analysis);
    const data = sourceCiteOnceData(analysis);
    if (!cite || !data) { problems.push(`${label}: no cite-once line`); return; }
    const line = cite.line;
    for (const match of [...line.matchAll(CITE_BANNED), ...line.matchAll(OVERCLAIM), ...line.matchAll(RETIRED)]) problems.push(`${label}: says "${match[0]}": “${line}”`);
    const rows = sourceLinkRows(analysis);
    const origins = rows.filter((row) => row.status === "origin").map((row) => row.number);
    const lead = line.match(/^(?:Cite once: (.*?)\.(?: |$)|Cite once each: (.*?)\.(?: |$)|No supplied link is a confirmed independent origin)/);
    const named = lead ? [...(lead[1] ?? lead[2] ?? "").matchAll(/(?:^|; )\[(\d+)\]/g)].map((match) => Number(match[1])) : null;
    if (!named || JSON.stringify(named) !== JSON.stringify(origins)) problems.push(`${label}: names ${JSON.stringify(named)} to cite once, the per-link list has origins ${JSON.stringify(origins)}: “${line}”`);
    const numbers = new Set(rows.map((row) => row.number));
    for (const match of line.matchAll(/\[(\d+)\]/g)) if (!numbers.has(Number(match[1]))) problems.push(`${label}: cites [${match[1]}], not a supplied citation number: “${line}”`);
    try {
      const parsed = JSON.parse(data);
      if (parsed.citeOnce !== line || !/not proof of the claim/.test(parsed.note) || parsed.citations.length !== rows.length) problems.push(`${label}: the data view does not match the line or lacks its caveat`);
    } catch { problems.push(`${label}: the data view is not valid JSON`); }
    rendered += 1;
  };
  for (const file of ["sources-phones-live-2026-11-13.echo.json", "sources-phones-live-2026-11-13-v2.echo.json"]) {
    const base = parsePortableTrace(JSON.parse(fs.readFileSync(path.join(root, "scripts", "fixtures", file), "utf8")));
    if (!base) { problems.push(`${file}: does not load`); continue; }
    checkCite(file, base);
    const kinds = ["origin", "derived", "unclear"];
    for (let code = 0; code < kinds.length ** base.pages.length; code += 1) {
      const variant = structuredClone(base);
      variant.pages = variant.pages.map((page, index) => {
        const kind = kinds[Math.floor(code / kinds.length ** index) % kinds.length];
        const parentId = kind === "origin" ? null : base.pages[(index + base.pages.length - 1) % base.pages.length].id;
        return { ...page, judgment: { ...page.judgment, kind, parentId } };
      });
      variant.roots = variant.pages.filter((page) => page.judgment.kind === "origin").map((page) => page.id);
      variant.verifiableRoots = (base.verifiableRoots ?? []).filter((id) => variant.roots.includes(id));
      variant.coPublishedRootGroups = (base.coPublishedRootGroups ?? []).map((group) => group.filter((id) => variant.roots.includes(id))).filter((group) => group.length > 1);
      checkCite(`${file}, kinds ${variant.pages.map((page) => page.judgment.kind[0]).join("")}`, variant);
    }
  }
  if (rendered < 400) problems.push(`only ${rendered} cite-once lines were checked; the generator is broken`);
  for (const problem of problems.slice(0, 20)) console.log(`  FAIL      cite once: ${problem}`);
  if (problems.length) {
    console.log(`\nEcho copy check failed: ${problems.length} cite-once line(s) overclaim or miscount (fix sourceCiteOnce in src/lib/echo/supplied-urls.ts).`);
    process.exit(1);
  }
  console.log(`Cite-once lines: ${rendered} rendered (2 saved sources traces and every origin/copy/unclear judging of their pages) without "drop", "wrong", "public API", an overclaim or a retired name, naming exactly the per-link list's origins, citing only supplied numbers, with a valid data view.`);
}

const claims = demoClaims();
const findings = files(appDir).flatMap((file) => scan(path.relative(root, file), fs.readFileSync(file, "utf8"), claims));

const isExpected = (finding) => EXPECTED.some((entry) => entry.file === finding.file && finding.text.includes(entry.text));
const unexpected = findings.filter((finding) => !isExpected(finding));
const expected = findings.filter(isExpected);
for (const finding of expected) console.log(`  expected  ${finding.file}:${finding.line}  ${finding.kind} "${finding.text}"  …${finding.context}…`);
for (const entry of EXPECTED) {
  if (!expected.some((finding) => finding.file === entry.file && finding.text.includes(entry.text))) console.log(`  fixed     ${entry.file}: "${entry.text}" no longer appears; remove it from EXPECTED in scripts/check-copy.mjs`);
}
for (const finding of unexpected) console.log(`  FAIL      ${finding.file}:${finding.line}  ${finding.kind} "${finding.text}"  …${finding.context}…`);
if (unexpected.length) {
  console.log(`\nEcho copy check failed: ${unexpected.length} overclaim, invented-figure or retired-name finding(s). Reword it, take the figure from a trace or DEMO_SCORES, (for a real caveat) negate it, or say "independent origins" / "with own evidence" / "root pages".`);
  process.exit(1);
}
console.log(`Echo copy check passed: no overclaim words, hard-coded figures or retired origin names in src/app copy (${expected.length} expected finding(s) awaiting their fix). No network.`);
