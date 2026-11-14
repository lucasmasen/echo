#!/usr/bin/env node
// Free claim scout: fetches pages directly (no Tavily, no Claude) and estimates
// whether a live trace could show dated copy links for a claim.
//
//   npm run scout:claim -- --claim "Full claim" --urls urls.txt [--json]
//
// urls.txt holds one URL per line, e.g. from any ordinary web search.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
load.extensions[".ts"] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(code, filename);
};
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { scoutPages } = load(path.join(projectRoot, "src/lib/echo/scout.ts"));
const { isFetchablePublicUrl } = load(path.join(projectRoot, "src/lib/echo/pipeline.ts"));

const flag = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const claim = flag("claim");
const urlsFile = flag("urls");
if (!claim || !urlsFile) {
  console.error('Usage: npm run scout:claim -- --claim "Full claim" --urls urls.txt [--json]');
  process.exit(2);
}
const urls = [...new Set(fs.readFileSync(urlsFile, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => /^https?:\/\//i.test(line)))].slice(0, 40);
const MAX_BYTES = 1_500_000;

async function fetchHtml(url) {
  if (!isFetchablePublicUrl(url)) return { url, html: null, status: "blocked address" };
  try {
    const response = await fetch(url, {
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "Mozilla/5.0 (compatible; EchoSourceTracer/0.1)" },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { url, html: null, status: `HTTP ${response.status}` };
    if (!/html/i.test(response.headers.get("content-type") ?? "html")) return { url, html: null, status: "not HTML" };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let bytes = 0;
    while (bytes < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => undefined);
    return { url, html, status: "ok" };
  } catch (error) {
    return { url, html: null, status: error?.name === "TimeoutError" ? "timeout" : "fetch failed" };
  }
}

const inputs = [];
for (let offset = 0; offset < urls.length; offset += 6) inputs.push(...await Promise.all(urls.slice(offset, offset + 6).map(fetchHtml)));
const report = scoutPages(inputs, claim);

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ claim, ...report, pages: report.pages.map(({ passage, ...page }) => ({ ...page, passageChars: passage.length })) }, null, 2)}\n`);
} else {
  const byId = new Map(report.pages.map((page) => [page.id, page]));
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
  console.log(`\nClaim scout · ${urls.length} URLs fetched directly · no Tavily or Claude calls`);
  console.log(`Claim: ${claim}`);
  console.log(`Fetched ${report.fetched}/${urls.length} · repeat the claim: ${report.relevant} · usable dates among those: ${report.usableDates}`);
  console.log(`Copy-like pairs: ${report.links.length} · dated and directional: ${report.directionalLinks} · pages with a dated earlier copy source: ${report.pagesWithDirectionalParent} · pages in ≥50%-overlap copy groups: ${report.pagesInCopyGroups}`);
  const ratio = report.relevant ? report.pagesWithDirectionalParent / report.relevant : 0;
  const copied = report.relevant ? report.pagesInCopyGroups / report.relevant : 0;
  console.log(ratio >= 0.25 ? "COPY POTENTIAL: PROMISING — a live trace may show visible, dated echoes"
    : copied >= 0.25 ? "COPY POTENTIAL: COPIES WITHOUT DIRECTION — much text is copied, but dates cannot yet order it; look for the earlier original"
    : ratio > 0 ? "COPY POTENTIAL: SOME — expect a few echoes at most"
    : "COPY POTENTIAL: LOW — pages look independently written; a trace will likely show 0% echo");
  console.log("\nLikely copy pairs (later ← earlier):");
  for (const link of report.links.slice(0, 15)) {
    const child = byId.get(link.childId);
    const parent = byId.get(link.parentId);
    console.log(`  ${link.directional ? "→" : "?"} ${host(child.url)} (${child.date ?? "undated"}) ← ${host(parent.url)} (${parent.date ?? "undated"}) · overlap ${Math.round(link.overlap * 100)}%${link.phrases[0] ? ` · “${link.phrases[0].slice(0, 80)}”` : ""}`);
  }
  console.log("\nPages:");
  for (const page of report.pages) console.log(`  ${page.mentionsClaim ? "✓" : "·"} ${page.date ? `${page.date} (${page.dateSource})` : "no usable date".padEnd(24)} ${page.status === "ok" ? "" : `[${page.status}] `}${page.url}`);
  console.log("\nThese are wording and date heuristics, not source judgments. Use them to choose which claims deserve a paid live trace.");
}
