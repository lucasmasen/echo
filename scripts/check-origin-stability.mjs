// Offline check of "How stable is a score?" (src/lib/echo/origin-stability.ts): the card on /origins that puts two
// saved runs of the same claim side by side. The pairs must be exactly the claims that have two saved runs, every
// figure must agree with the origin layer, and what two runs share must read the same from either side. No provider
// call, no network, no cost (fetch is replaced by a function that throws for the length of the check).
//   node scripts/check-origin-stability.mjs          one pass line
//   node scripts/check-origin-stability.mjs --rows   also prints each pair's row and sentence
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

// The library can make no request: it imports only pure origin files, and nothing in it may call fetch or read a setting.
const source = fs.readFileSync(path.join(root, "src/lib/echo/origin-stability.ts"), "utf8");
const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
assert.deepEqual(imports.sort(), ["./origin-layer", "./saved-check"], "origin-stability.ts imports only the origin layer and the saved-run matcher");
assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|process\.env|node:|require\(/, "origin-stability.ts has no way to reach a network, a key or a file");
const matcher = fs.readFileSync(path.join(root, "src/lib/echo/saved-check.ts"), "utf8");
assert.doesNotMatch(matcher, /\bfetch\s*\(|XMLHttpRequest|process\.env|node:|require\(/, "saved-check.ts, which it imports, is pure too");
const component = fs.readFileSync(path.join(root, "src/app/origins/stability.tsx"), "utf8");
assert.doesNotMatch(component, /["']use client["']|\bfetch\s*\(|process\.env|window\./, "stability.tsx is a server component that sends nothing");
assert.match(component, /data-jump="stability"/, "the card can be jumped to");
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("check-origin-stability made a network request"); };

const { stabilityPairs, stabilitySummary, pageAddress, originNames } = load(path.join(root, "src/lib/echo/origin-stability.ts"));
const { originLayer } = load(path.join(root, "src/lib/echo/origin-layer.ts"));
const { savedMatch } = load(path.join(root, "src/lib/echo/saved-check.ts"));

// The runs the page hands the card: the Telem runs and every run in public/demo-traces. The known-limit run is not read.
const files = ["mcp/traces", "public/demo-traces"].flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith(".echo.json")).sort().map((name) => path.join(dir, name)));
const runs = files.map((file) => ({ file: path.basename(file), analysis: JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).analysis }));
const before = JSON.stringify(runs);
const pairs = stabilityPairs(runs);
assert.equal(JSON.stringify(runs), before, "stabilityPairs does not change the runs it is given");
assert.deepEqual(stabilityPairs(runs), pairs, "the same runs give the same pairs");
assert.deepEqual(stabilityPairs([...runs].reverse()), pairs, "the order the runs are handed in does not matter");
assert.deepEqual(JSON.parse(JSON.stringify(pairs)), pairs, "pairs are plain data: they survive JSON unchanged");

// 1. The pairs are exactly the claims with two saved runs. Worked out again here with a plain rule (the claim's
//    letters and digits, case aside), so the grouping is checked by something other than the code that did it.
const traced = runs.filter((run) => run.analysis.mode === "live" && !run.analysis.sourceCheck);
const plain = (claim) => claim.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const groups = new Map();
for (const run of traced) groups.set(plain(run.analysis.claim), [...(groups.get(plain(run.analysis.claim)) ?? []), run]);
const twice = [...groups.values()].filter((group) => group.length > 1);
assert.equal(pairs.length, twice.length, `one pair per claim with two saved runs (${pairs.length} pairs, ${twice.length} such claims)`);
assert.ok(pairs.length >= 4, `the four claims traced through Tavily earlier and through Telem today are paired (found ${pairs.length})`);
for (const group of twice) {
  const ordered = [...group].sort((a, b) => a.analysis.createdAt.localeCompare(b.analysis.createdAt));
  const pair = pairs.find((entry) => plain(entry.claim) === plain(group[0].analysis.claim));
  assert.ok(pair, `"${group[0].analysis.claim}" has ${group.length} saved runs, so it has a pair`);
  assert.equal(pair.savedRuns, group.length);
  assert.equal(pair.earlier.file, ordered[0].file, `${pair.claim}: the earlier side is the oldest run`);
  assert.equal(pair.later.file, ordered[ordered.length - 1].file, `${pair.claim}: the later side is the newest run`);
  // The interfaces' own rule agrees: each run's claim is answered by the other run.
  assert.ok(savedMatch(ordered[0].analysis.claim, [ordered[ordered.length - 1]]), `${pair.claim}: echo_check's matcher calls the two runs the same claim`);
}
for (const pair of pairs) {
  for (const side of [pair.earlier, pair.later]) {
    const run = runs.find((entry) => entry.file === side.file);
    assert.ok(run && !run.analysis.sourceCheck, `${side.file}: a links check is never one side of a pair`);
  }
}
assert.ok(!pairs.some((pair) => [pair.earlier.file, pair.later.file].some((file) => runs.find((run) => run.file === file).analysis.sourceCheck)), "the links-check run is left out");
// A claim traced once has no pair, and a copy of one run is not a second run.
assert.deepEqual(stabilityPairs(runs.filter((run) => run.file.startsWith("telem-"))), [], "one run per claim: no pair");
assert.deepEqual(stabilityPairs([runs[0], { ...runs[0], file: "copy.echo.json" }]), [], "the same run handed in twice is one run");
assert.deepEqual(stabilityPairs([]), []);
assert.equal(stabilitySummary([]), null, "no pair, no summary: the card renders nothing");

// 2. Every figure of each side is the origin layer's, and what the two runs share is symmetric.
const host = (url) => url.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0].toLowerCase().replace(/^www\./, "");
const pathOnly = (url) => url.replace(/^[a-z]+:\/\//i, "").replace(/[?#].*$/, "").replace(/^[^/]*/, "").replace(/\/+$/, "");
const TRACKING = new Set(["code", "error", "vl"]);
// The address rule, written again: no protocol, www, trailing slash or fragment, and only the query parts that name the page.
const address = (url) => {
  const query = (url.split("#")[0].split("?")[1] ?? "").split("&").filter((part) => part && !TRACKING.has(part.split("=")[0]) && !part.startsWith("utm_")).sort();
  return `${host(url)}${pathOnly(url)}${query.length ? `?${query.join("&")}` : ""}`;
};
const swapped = (run, at) => ({ ...run, analysis: { ...run.analysis, createdAt: at } });
const keys = (origins) => origins.map((origin) => origin.key);
for (const pair of pairs) {
  const earlier = runs.find((run) => run.file === pair.earlier.file);
  const later = runs.find((run) => run.file === pair.later.file);
  for (const [side, run] of [[pair.earlier, earlier], [pair.later, later]]) {
    const layer = originLayer(run.analysis);
    assert.equal(side.score, layer.score, `${side.file}: the score is originLayer(...).score`);
    assert.equal(side.label, layer.label);
    assert.equal(side.pages, run.analysis.pages.length, `${side.file}: pages kept`);
    assert.equal(side.origins, layer.origins.length, `${side.file}: origins`);
    assert.equal(side.originsWithOwnEvidence, layer.origins.filter((origin) => origin.ownEvidence).length, `${side.file}: origins with own evidence`);
    assert.equal(side.captured, run.analysis.createdAt);
    assert.equal(side.searchedThrough, (run.analysis.searchAudit ?? []).some((entry) => entry.router === "telem") ? "Telem" : "Tavily", `${side.file}: searched through`);
    assert.match(side.day, /^\d{4}-\d{2}-\d{2}$/, `${side.file}: a calendar day`);
    for (const page of run.analysis.pages) assert.equal(pageAddress(page.url), address(page.url), `${page.url}: address`);
  }
  assert.ok(pair.earlier.captured <= pair.later.captured, `${pair.claim}: earlier is before later`);
  assert.equal(pair.gap, Math.abs(pair.earlier.score - pair.later.score), `${pair.claim}: the gap is the distance between the two scores`);
  assert.equal(pair.sameDay, pair.earlier.day === pair.later.day);
  assert.equal(pair.sameRoute, pair.earlier.searchedThrough === pair.later.searchedThrough);

  // Pages in both, counted again from the raw addresses, from each side.
  const mine = new Set(earlier.analysis.pages.map((page) => address(page.url)));
  const theirs = new Set(later.analysis.pages.map((page) => address(page.url)));
  const forward = [...mine].filter((entry) => theirs.has(entry)).length;
  const backward = [...theirs].filter((entry) => mine.has(entry)).length;
  assert.equal(forward, backward, `${pair.claim}: pages in both read the same from either run`);
  assert.equal(pair.earlierAddresses, mine.size);
  assert.equal(pair.laterAddresses, theirs.size);
  assert.equal(pair.sharedPages, forward + pair.sisterPages.length, `${pair.claim}: pages in both = same address + one article at sister addresses`);
  assert.ok(pair.sharedPages <= Math.min(pair.earlier.pages, pair.later.pages, mine.size, theirs.size), `${pair.claim}: pages in both never exceed either run`);
  // A sister pair is real: the same path on two hosts of one name, one in each run, and not already an exact match.
  for (const sister of pair.sisterPages) {
    const a = earlier.analysis.pages.filter((page) => host(page.url) === sister.earlier);
    const b = later.analysis.pages.filter((page) => host(page.url) === sister.later);
    assert.notEqual(sister.earlier, sister.later);
    assert.equal(sister.earlier.split(".")[0], sister.later.split(".")[0], `${pair.claim}: sister hosts share a name`);
    assert.ok(a.some((page) => pathOnly(page.url).length > 1 && b.some((other) => pathOnly(other.url) === pathOnly(page.url) && !mine.has(address(other.url)) && !theirs.has(address(page.url)))), `${pair.claim}: ${sister.earlier} and ${sister.later} carry the same path`);
  }
  assert.equal(Boolean(pair.sisterNote), pair.sisterPages.length > 0, `${pair.claim}: a sister note exactly when there is a sister page`);
  for (const sister of pair.sisterPages) assert.ok(pair.sisterNote.includes(sister.earlier) && pair.sisterNote.includes(sister.later));

  // Origins: three lists that never overlap and together are every origin of each run.
  const shared = keys(pair.sharedOrigins);
  const onlyEarlier = keys(pair.onlyEarlier);
  const onlyLater = keys(pair.onlyLater);
  for (const list of [shared, onlyEarlier, onlyLater]) assert.equal(new Set(list).size, list.length, `${pair.claim}: no origin is listed twice`);
  assert.ok(!onlyEarlier.some((key) => shared.includes(key)), `${pair.claim}: "only the earlier run" shares nothing with "in both"`);
  assert.ok(!onlyLater.some((key) => shared.includes(key)), `${pair.claim}: "only the later run" shares nothing with "in both"`);
  assert.ok(!onlyEarlier.some((key) => onlyLater.includes(key)), `${pair.claim}: the two "only" lists share nothing`);
  assert.ok(shared.length <= Math.min(pair.earlier.origins, pair.later.origins), `${pair.claim}: origins in both never exceed either run`);
  // Each run's origins, re-derived: one per publisher, or per page on a host the origin layer counts page by page.
  const distinct = (run) => new Set(originLayer(run.analysis).origins.map((origin) => (origin.entity.includes("#") ? `page:${address(origin.url)}` : origin.entity))).size;
  assert.equal(shared.length + onlyEarlier.length, distinct(earlier), `${pair.claim}: in both + only earlier = the earlier run's origins`);
  assert.equal(shared.length + onlyLater.length, distinct(later), `${pair.claim}: in both + only later = the later run's origins`);
  for (const [side, run] of [[pair.counted.earlier, earlier], [pair.counted.later, later]]) {
    const counted = originLayer(run.analysis).origins.filter((origin) => origin.counted);
    assert.equal(side.withEvidence, counted.filter((origin) => origin.ownEvidence).length);
    assert.equal(side.without, counted.filter((origin) => !origin.ownEvidence).length);
  }

  // Symmetry of the whole record: swap which run came first, and "in both" stays while the two "only" lists trade places.
  const [flipped] = stabilityPairs([swapped(earlier, later.analysis.createdAt), swapped(later, earlier.analysis.createdAt)]);
  assert.equal(flipped.sharedPages, pair.sharedPages, `${pair.claim}: pages in both is symmetric`);
  assert.equal(flipped.sharedOrigins.length, pair.sharedOrigins.length, `${pair.claim}: origins in both is symmetric`);
  assert.equal(flipped.onlyEarlier.length, pair.onlyLater.length);
  assert.equal(flipped.onlyLater.length, pair.onlyEarlier.length);
  assert.deepEqual(flipped.onlyEarlier.map((origin) => origin.name).sort(), pair.onlyLater.map((origin) => origin.name).sort(), `${pair.claim}: the "only" lists trade places`);
  assert.equal(flipped.gap, pair.gap);
  assert.equal(flipped.earlier.score, pair.later.score);

  // The sentence: plain text, and every origin it names as kept by one run alone is one that run kept with evidence of its own.
  assert.ok(pair.why.length > 20 && !/undefined|NaN|null|\[object/.test(pair.why), `${pair.claim}: the sentence is whole`);
  assert.doesNotMatch(`${pair.why} ${pair.sisterNote ?? ""}`, /\bproves?\b|\bconfirmed\b|follow-up|\bcustomers?\b|\busers?\b|\bbetter\b|\bworse\b| [—–] /i, `${pair.claim}: the sentence keeps to the wording rules`);
  const evidencedOnly = (list, other) => list.filter((origin) => origin.ownEvidence && !other.some((entry) => entry.key === origin.key));
  for (const origin of [...evidencedOnly(pair.onlyEarlier, pair.sharedOrigins), ...evidencedOnly(pair.onlyLater, pair.sharedOrigins)]) assert.ok(pair.why.includes(origin.name), `${pair.claim}: the sentence names ${origin.name}`);
  // When the sentence says the other run did not keep those pages, no page of an origin only one run kept with
  // evidence is in the other run. Checked on the raw addresses.
  if (/(?:That page is not|Neither page is|None of those pages is) among the pages the (?:other|earlier|later) run kept/.test(pair.why)) {
    for (const [list, from, other] of [[pair.onlyEarlier, earlier, theirs], [pair.onlyLater, later, mine]]) {
      const layer = originLayer(from.analysis);
      for (const origin of list.filter((entry) => entry.ownEvidence)) {
        const pagesOf = layer.origins.filter((entry) => entry.name === origin.name).flatMap((entry) => entry.pageIds).map((id) => from.analysis.pages.find((page) => page.id === id).url);
        assert.ok(pagesOf.length > 0 && !pagesOf.some((url) => other.has(address(url))), `${pair.claim}: no page of ${origin.name} is in the other run`);
      }
    }
  }
  if (pair.gap === 0) assert.match(pair.why, /did not move|scores match/, `${pair.claim}: equal scores are said to be equal`);
  if (!pair.counted.earlier.withEvidence && !pair.counted.later.withEvidence && pair.gap > 0) assert.match(pair.why, /Neither run kept an origin with evidence of its own/);
}

// 3. The summary: widest and narrowest gap, worked out again.
const summary = stabilitySummary(pairs);
const gaps = pairs.map((pair) => pair.gap);
assert.equal(summary.claims, pairs.length);
assert.equal(summary.widest.gap, Math.max(...gaps), "the widest gap is the largest");
assert.equal(summary.narrowest.gap, Math.min(...gaps), "the narrowest gap is the smallest");
assert.deepEqual(gaps, [...gaps].sort((a, b) => b - a), "pairs come widest gap first");
assert.equal(summary.dayAndRouteBothChanged, pairs.every((pair) => pair.earlier.day !== pair.later.day && pair.earlier.searchedThrough !== pair.later.searchedThrough));

// 4. The address rule on cases written to be caught.
assert.equal(pageAddress("https://www.BBC.com/future/article/x/?utm_source=a#top"), "bbc.com/future/article/x");
assert.equal(pageAddress("http://bbc.com/future/article/x"), "bbc.com/future/article/x");
assert.notEqual(pageAddress("https://www.youtube.com/watch?v=aaa"), pageAddress("https://www.youtube.com/watch?v=bbb"), "two videos are two pages");
assert.equal(pageAddress("https://www.youtube.com/watch?v=aaa&vl=en"), pageAddress("https://youtube.com/watch?v=aaa"), "a language parameter does not make a new page");
assert.equal(originNames([{ key: "a", name: "a.com" }, { key: "b", name: "b.com" }, { key: "c", name: "b.com" }]), "a.com and b.com twice");

globalThis.fetch = realFetch;
if (process.argv.includes("--rows")) {
  for (const pair of pairs) {
    const side = (run) => `${run.day} through ${run.searchedThrough}: score ${run.score} (${run.label}), ${run.pages} pages, ${run.origins} origins, ${run.originsWithOwnEvidence} with own evidence`;
    console.log(`\n"${pair.claim}" · gap ${pair.gap}`);
    console.log(`  earlier  ${side(pair.earlier)}`);
    console.log(`  later    ${side(pair.later)}`);
    console.log(`  pages in both ${pair.sharedPages} (of ${pair.earlier.pages} and ${pair.later.pages}) · origins in both ${pair.sharedOrigins.length}${pair.sharedOrigins.length ? `: ${originNames(pair.sharedOrigins)}` : ""}`);
    console.log(`  only earlier ${pair.onlyEarlier.length}${pair.onlyEarlier.length ? `: ${originNames(pair.onlyEarlier)}` : ""}`);
    console.log(`  only later ${pair.onlyLater.length}${pair.onlyLater.length ? `: ${originNames(pair.onlyLater)}` : ""}`);
    console.log(`  why: ${pair.why}${pair.sisterNote ? ` ${pair.sisterNote}` : ""}`);
  }
  console.log("");
}
console.log(`origin stability check passed: ${pairs.length} claims with two saved runs out of ${traced.length} traced runs (${runs.length - traced.length} links check left out); score gaps ${gaps.join(", ")}; each side's score equals the origin layer's; shared pages and origins are symmetric and never exceed either run; the "only" lists never overlap "in both"; no network request was made.`);
