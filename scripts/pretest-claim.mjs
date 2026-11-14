#!/usr/bin/env node
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
const { resolveDateCoverage } = load(path.join(projectRoot, "src/lib/echo/date-coverage.ts"));

const claim = flagValue("claim");
const phrase = flagValue("phrase");
const apiKey = process.env.TAVILY_API_KEY;

if (!claim || !phrase) {
  console.error('Usage: npm run pretest:claim -- --claim "Full claim" --phrase \'"quoted phrase"\'');
  process.exit(2);
}
if (!apiKey) {
  console.error("TAVILY_API_KEY is missing from .env.local. This command does not use Anthropic.");
  process.exit(2);
}

const queries = [claim, phrase];
const collected = new Map();

try {
  for (const query of queries) {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 20,
        include_published_date: true,
        include_favicon: false,
        include_answer: false,
        include_raw_content: false,
      }),
    });
    if (!response.ok) throw new Error(`Tavily search failed with HTTP ${response.status}.`);
    const payload = await response.json();
    for (const result of payload.results ?? []) {
      const url = canonicalUrl(result.url);
      if (!url) continue;
      const previous = collected.get(url);
      if (!previous || (result.content?.length ?? 0) > (previous.content?.length ?? 0)) {
        collected.set(url, { ...result, url });
      }
    }
  }

  const pages = [...collected.values()];
  const dated = pages.filter((page) => Boolean(page.published_date)).length;
  const coverage = await resolveDateCoverage(pages.map((page) => ({ url: page.url, publishedDate: page.published_date, text: page.content })));
  const dateByUrl = new Map(coverage.rows.map((row) => [row.url, row]));
  const percent = (count) => (pages.length ? ` (${Math.round((count / pages.length) * 100)}%)` : "");
  console.log(`\nClaim pre-test · ${queries.length} Tavily search requests · publisher dates read directly from pages · no Claude calls`);
  console.log(`Claim: ${claim}`);
  console.log(`Quoted phrase: ${phrase}`);
  console.log(`\n${pages.length} distinct URLs · ${dated}/${pages.length} with any search date${percent(dated)}`);
  console.log(`Dates usable for direction (page text, URL, or publisher metadata): ${coverage.trusted}/${pages.length}${percent(coverage.trusted)} · search estimate only: ${coverage.estimated} · none: ${coverage.missing}`);
  console.log(`${pages.length >= 20 ? "VOLUME CHECK: PASS" : "VOLUME CHECK: REVIEW — target is 20+ URLs"}`);
  console.log(`${pages.length && coverage.trusted / pages.length > 0.5 ? "DATE CHECK: PASS — most pages have a usable date" : "DATE CHECK: REVIEW — most pages lack a usable date, so few links can be confirmed"}`);
  console.log("\nReview titles and snippets below for repeated wording and verify the origin story manually. Search results alone do not establish a true source root.\n");
  for (const [index, page] of pages.entries()) {
    const title = String(page.title || "Untitled result").replace(/\s+/g, " ").trim();
    const snippet = String(page.content || "").replace(/\s+/g, " ").trim().slice(0, 240);
    console.log(`${String(index + 1).padStart(2, "0")}. ${title}`);
    const resolved = dateByUrl.get(page.url);
    console.log(`    Date: ${resolved?.date ? `${resolved.date} (${resolved.source})` : "unclear"} · ${page.url}`);
    if (snippet) console.log(`    ${snippet}${page.content.length > 240 ? "…" : ""}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "The pre-test search failed.");
  process.exitCode = 1;
}

function flagValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function canonicalUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}
