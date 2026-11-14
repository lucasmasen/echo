// Offline checks for "Trace an article": which sentences of an article Echo suggests tracing. No network, no spend.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const load = createRequire(import.meta.url);
load.extensions[".ts"] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  module._compile(code, filename);
};
const { claimCandidates, MAX_CANDIDATES } = load("../src/lib/echo/claim-candidates.ts");

const article = `# Why we can't put our phones down
Americans check their phones 96 times a day, according to a 2019 survey by Asurion. That is once every 10 minutes.
Subscribe to our newsletter for more stories like this. Dr. Smith of the U.S. National Institute said the habit is growing.
Is it really true that 40% of us are addicted to our phones? Researchers at Stanford found that 1 in 5 teens feel anxious without their phone.
The weather was nice and everyone went outside for a long walk in the park.
Americans check their phones 96 times a day, according to a 2019 survey by Asurion.
Screen time rose 30% during the pandemic, the report shows.`;
const picked = claimCandidates(article).map((candidate) => candidate.text);
assert.deepEqual(picked, [
  "Americans check their phones 96 times a day, according to a 2019 survey by Asurion.",
  "Dr. Smith of the U.S. National Institute said the habit is growing.",
  "Researchers at Stanford found that 1 in 5 teens feel anxious without their phone.",
  "Screen time rose 30% during the pandemic, the report shows.",
], "figures and credited sources are picked, in page order; headings, questions, boilerplate, plain prose and repeats are not");
assert.deepEqual(claimCandidates(article)[0].reasons, ["states a figure", "credits a source"]);
assert.ok(!picked.some((text) => text.startsWith("Why we")), "a heading never joins the sentence after it");
assert.ok(!picked.some((text) => /^National Institute/.test(text)), "an abbreviation (U.S., Dr.) does not end a sentence");

assert.deepEqual(claimCandidates(""), [], "no text, no candidates");
assert.deepEqual(claimCandidates("a".repeat(5_000)), [], "a wall of letters gives none");
assert.deepEqual(claimCandidates(article, 0), [], "max 0 gives none");
const many = Array.from({ length: 40 }, (_, index) => `Survey number ${index + 1} found that ${index + 10}% of adults sleep badly in cities.`).join(" ");
assert.equal(claimCandidates(many).length, MAX_CANDIDATES, `at most ${MAX_CANDIDATES} by default`);
assert.ok(claimCandidates(`Researchers found that 12% of people ${"really ".repeat(60)}like long sentences.`).length === 0, "sentences over 240 characters are skipped");

const huge = "Studies show 40% of people sleep badly at night in large cities. ".repeat(20_000);
const started = performance.now();
claimCandidates(huge);
assert.ok(performance.now() - started < 1_500, "a 1.3 MB article is read in well under 1.5 s");
for (const wall of ["Dr. Smith ", "U.S. Army "]) {
  const abbreviationStarted = performance.now();
  claimCandidates(wall.repeat(150_000));
  assert.ok(performance.now() - abbreviationStarted < 1_500, `a 1.5 MB page of "${wall.trim()}" (every piece ends on an abbreviation) is read in linear time`);
}
assert.deepEqual(claimCandidates("On Jan. 5, 2020, researchers found that 40% of adults sleep badly in big cities. Smith et al. 2019 found that 30% of teens wake up at night in the survey.").map((candidate) => candidate.text), [
  "On Jan. 5, 2020, researchers found that 40% of adults sleep badly in big cities.",
  "Smith et al. 2019 found that 30% of teens wake up at night in the survey.",
], "a month abbreviation or \"et al.\" before a number does not cut the sentence into a fragment");
assert.deepEqual(claimCandidates("40% of adults sleep badly in big cities across the world\n\nResearchers found that 30% of teens wake up at night, a study says.").map((candidate) => candidate.text), [
  "40% of adults sleep badly in big cities across the world",
  "Researchers found that 30% of teens wake up at night, a study says.",
], "a paragraph or list item without a full stop never runs into the next one");
assert.deepEqual(claimCandidates("# Heart health\n#1 cause of death: heart disease kills 700,000 people a year, the CDC report says.\n\n## Why it matters\n#MeToo posts rose 40% in a week, a 2018 study found.").map((candidate) => candidate.text), [
  "#1 cause of death: heart disease kills 700,000 people a year, the CDC report says.",
  "#MeToo posts rose 40% in a week, a 2018 study found.",
], "only a markdown heading (\"# \", \"## \") is dropped: a sentence that starts with \"#1\" or a hashtag is still a sentence");
// A publisher's about-us box (Pew's mobile fact sheet ends with one) is not a claim; the page's findings still are.
assert.deepEqual(claimCandidates([
  "Pew Research Center does research to inform the public about the issues, attitudes and trends shaping the world.",
  "Pew Research Center is a nonpartisan, nonadvocacy fact tank that informs the public about the issues shaping the world.",
  "The Center conducts public opinion polling, demographic research, computational social science research and other data-driven research.",
  "It does not take policy positions, and it is a subsidiary of The Pew Charitable Trusts, its primary funder.",
  "The Brookings Institution is a nonprofit public policy organization based in Washington, D.C., founded in 1916.",
  "Our mission is to provide research that helps 10 million readers make sense of the news.",
  "The vast majority of Americans (98%) now own a cellphone of some kind, a Pew Research Center survey found.",
  "Pew Research Center found that 91% of adults own a smartphone, up from 35% in its first survey in 2011.",
  "Researchers at the Center conducted the survey of 5,733 adults from Jan. 22 to 27.",
].join(" ")).map((candidate) => candidate.text), [
  "The vast majority of Americans (98%) now own a cellphone of some kind, a Pew Research Center survey found.",
  "Pew Research Center found that 91% of adults own a smartphone, up from 35% in its first survey in 2011.",
  "Researchers at the Center conducted the survey of 5,733 adults from Jan. 22 to 27.",
], "a publisher's self-description (informs the public, fact tank, nonprofit, conducts research, no policy positions, subsidiary, our mission) is dropped; what its survey found is kept");

// "Check these sources": the sentence box fills itself from a pasted answer. It picks the sentence that carries the
// citations (preferring one with a figure), with the markers and links taken out; a source list's own lines are never
// the claim. Pure text work, like the candidates above.
{
  const { suggestedClaim } = load("../src/lib/echo/supplied-urls.ts");
  const a = "https://www.asurion.com/press-releases/americans-check-their-phones-96-times-a-day";
  const b = "https://www.prnewswire.com/news-releases/americans-check-their-phones-96-times-a-day-300962643.html";
  const picks = [
    ["bracketed markers and a numbered source list", `Phones are a big part of daily life. Americans check their phones 96 times a day, according to a 2019 survey by Asurion [1][2]. Researchers say 40% of people feel anxious without one.\n\nSources\n[1] Asurion: Americans check their phones 96 times a day ${a}\n[2] ${b}`, "Americans check their phones 96 times a day, according to a 2019 survey by Asurion."],
    ["a marker after the full stop", `Americans check their phones 96 times a day.[1] The survey polled 2,000 adults in 2019 for its results.\n[1]: ${a}`, "Americans check their phones 96 times a day."],
    ["markdown footnotes", `Most people say 70% of their screen time is on phones, a report says. Americans check their phones 96 times a day[^1].\n\n[^1]: ${a}`, "Americans check their phones 96 times a day."],
    ["numbered markdown links", `Americans check their phones 96 times a day [1](${a}) and the habit keeps growing [2](${b}).`, "Americans check their phones 96 times a day and the habit keeps growing."],
    ["a link named by its site", `Americans check their phones 96 times a day ([asurion.com](${a}?utm_source=chatgpt.com)). Some 2,000 adults took the survey in 2019.`, "Americans check their phones 96 times a day."],
    ["a markdown link with words", `According to [a 2019 Asurion survey](${a}), Americans check their phones 96 times a day.`, "According to a 2019 Asurion survey, Americans check their phones 96 times a day."],
    ["bare links in the prose", `Americans check their phones 96 times a day (${a}). Also see ${b} for the wire copy.`, "Americans check their phones 96 times a day."],
    ["no markers: the sentence with a figure", `Phones are everywhere these days. Americans check their phones 96 times a day, a survey says.\n${a}\n${b}`, "Americans check their phones 96 times a day, a survey says."],
    // QA round 3 #10: a short cited sentence (under 40 characters) is still picked.
    ["a short sentence with a footnote", `Americans check phones 96 times a day.[^1]\n\n[^1]: ${a}`, "Americans check phones 96 times a day."],
    ["a short sentence with two markers", `Phones get checked 96 times a day [3][7].\n[3] ${a}\n[7] ${b}`, "Phones get checked 96 times a day."],
    ["a short sentence with a parenthesised number", `The figure is 96 times a day (1).\n(1) ${a}`, "The figure is 96 times a day."],
  ];
  for (const [label, text, expected] of picks) assert.equal(suggestedClaim(text), expected, `the sentence box picks from ${label}`);
  assert.equal(suggestedClaim(`${a}\n${b}`), null, "a list of links alone gives no sentence");
  assert.equal(suggestedClaim(""), null);
  assert.equal(suggestedClaim("Thanks! Let me know if you want more."), null, "no figure and no source: nothing to check");
  assert.equal(suggestedClaim(`Research shows it works well. Thanks for reading.\n\n${a}`), null, "a short sentence with neither a marker nor a figure still needs 40 characters");
  assert.equal(suggestedClaim("Version 2 of the plan (3) is here, and it is long enough to count as a sentence."), null, "a parenthesised number inside a sentence is not a marker, and no figure or source: nothing picked");
  assert.equal(suggestedClaim(`Sources:\n1. Americans check their phones 96 times a day, Asurion ${a}`), null, "a source list's title is never the claim");
  assert.ok((suggestedClaim(`${"Researchers found 40% of people check phones. ".repeat(20_000)}[1] ${a}`) ?? "").length <= 500, "a huge paste stays bounded");
}

// The /api/claims route itself, with fetch and DNS faked: no network, no spend.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "echo-claims-check-")));
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolveFilename.call(this, request.startsWith("@/") ? path.join(projectRoot, "src", request.slice(2)) : request, ...rest);
};
const dns = load("node:dns/promises");
const realLookup = dns.lookup;
const addresses = { "news.example": "93.184.216.34", "evil.example": "93.184.216.35", "metadata.internal.example": "169.254.169.254", "slow.example": "93.184.216.36", "pdf.example": "93.184.216.37", "gone.example": "93.184.216.38" };
dns.lookup = async (host) => [{ address: addresses[host] ?? "93.184.216.99", family: 4 }];
const html = (body) => `<html><head><title>Phones &amp; us | News</title><script>var x = "Americans check their phones 500 times a day, a fake study found.";</script></head><body><nav>Subscribe now</nav><article><h1>Phones and us</h1><p>${body}</p></article></body></html>`;
const articleBody = "Americans check their phones 96 times a day, according to a 2019 survey by Asurion. That is a lot. Researchers at Stanford found that 1 in 5 teens feel anxious without their phone. ".repeat(3);
const fetches = [];
global.fetch = async (input, init) => {
  const url = String(input);
  fetches.push(url);
  if (init?.signal?.aborted) throw init.signal.reason;
  if (url.startsWith("https://news.example/")) return new Response(html(articleBody), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  if (url.startsWith("https://list.example/")) return new Response(`<html><body><article><p>${"Ordinary prose about city life with nothing to check in it at all. ".repeat(8)}</p><ul><li>40% of adults sleep badly in big cities at night</li><li>Researchers found that 30% of teens wake at night</li></ul></article></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://divs.example/")) return new Response(`<html><body><div>Photo: Getty Images<div>Researchers found that 30% of teens wake at night, in a survey.</div></div><table><tr><td>Share of adults who sleep badly</td><td>40% in the 2019 survey data</td></tr></table></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://hidden.example/")) return new Response(`<html><head><title>Americans check their phones 500 times a day, a survey finds</title></head><body><div>Researchers found that 30% of teens wake at night, in a survey.</div><!-- if a > b: old copy said 400 times a day, a fake study found. --><textarea>A fake study found that 90% of people never read the terms.</textarea><select><option>Researchers estimate 70% of shoppers pick this option first.</option></select><script>window.__DATA__ = { text: "Researchers found that 80% of scripts are never shown to readers at all."`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://commented.example/")) return new Response(`<html><body><article><p>${"Ordinary prose about city life with nothing to check in it at all. ".repeat(8)}</p><!-- <p>Americans check their phones 500 times a day, a fake study found.</p> --></article></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://latin1.example/")) return new Response(Buffer.from("<html><body><div>Según el estudio, el 40% de los niños duermen mal en la ciudad.</div></body></html>", "latin1"), { status: 200, headers: { "content-type": "text/html; charset=ISO-8859-1" } });
  if (url.startsWith("https://sjis.example/")) return new Response(new Uint8Array([...Buffer.from('<html><head><meta charset="shift_jis"><title>'), 0x93, 0xfa, 0x96, 0x7b, 0x82, 0xcc, 0x83, 0x6a, 0x83, 0x85, 0x81, 0x5b, 0x83, 0x58, ...Buffer.from("</title></head><body></body></html>")]), { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://utf16meta.example/")) return new Response('<html><head><meta charset="utf-16"><title>Sleep news</title></head><body><div>Researchers found that 30% of teens wake at night, in a survey.</div></body></html>', { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://badcharset.example/")) return new Response("<html><body><div>Hello.</div></body></html>", { status: 200, headers: { "content-type": "text/html; charset=x-made-up" } });
  if (url.startsWith("https://cut.example/")) {
    const start = Buffer.from("<html><body><div>Researchers found that 30% of teens wake at night, in a survey.</div>");
    const tail = Buffer.from("<div>Researchers found that 40% of adults sleep badly in élan cities and towns everywhere.</div></body></html>");
    const cutAt = tail.indexOf(Buffer.from("é")) + 1;
    const filler = Buffer.alloc(1_500_000 - start.length - cutAt, " ");
    return new Response(Buffer.concat([start, filler, tail]), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.startsWith("https://entities.example/")) return new Response("<html><head><title>Why we can&#8217;t stop &mdash; &lt;b&gt;\n  News</title></head><body><div>Researchers found that 30% of teens can&#8217;t sleep at night, in a survey.</div></body></html>", { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://longtitle.example/")) return new Response(`<html><head><title>${"Researchers say ".repeat(30)}</title></head><body></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://lessthan.example/")) return new Response("<html><body><div>Of the adults surveyed, 30% were <18 years old and 12% were >65, the study found.</div></body></html>", { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://lessthan-article.example/")) return new Response(`<html><body><article><p>${"Ordinary prose about city life with nothing to check in it at all. ".repeat(8)}</p><p>In the survey, 40% of riders paid <$2 a trip and 9% paid >$10 a trip, the report says.</p></article></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://longread.example/")) {
    // An article whose paragraph text passes 20,000 characters, cut 60 characters into a checkable sentence.
    const paragraphs = ["Americans check their phones 96 times a day, according to a 2019 survey by Asurion.", ...Array.from({ length: 280 }, () => "Ordinary prose about city life with nothing to check in it at all.")];
    const before = paragraphs.join("\n\n").length + 2;
    paragraphs.push(`${"Long ".repeat(Math.floor((19_940 - before - 2) / 5))}`.trim().padEnd(19_940 - before - 2, "x"));
    paragraphs.push("Researchers at Stanford found that 1 in 5 teens feel anxious without their phones, a survey says.");
    return new Response(`<html><body><article>${paragraphs.map((text) => `<p>${text}</p>`).join("")}</article></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  }
  if (url.startsWith("https://blocks.example/")) return new Response("<html><body><div>Researchers found that 30% of teens wake at night<hr>A survey found 20% of adults sleep well at night<pre>x = 40</pre>Studies show 10% of people dream in colour<figure><img alt=\"\">Photo</figure>Data from a 2019 survey shows 5% never sleep<details><summary>Methods</summary>The poll asked 2,000 people in 2019 about sleep</details></div></body></html>", { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://rawtext.example/")) return new Response(`<html><head><title>Sleep <!-- news</title><style>/* <!-- */</style></head><body><script>var s="<!--";</script><div>Researchers found that 30% of teens wake at night, in a survey.</div><textarea>Type <!-- here</textarea><!-- <script> --><div>Studies show 10% of people dream in colour, a 2019 survey says.</div><!-- A fake study found 90% of comments lie. --></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  // An empty comment ("<!-->", "<!--->") ends where it starts, and "--!>" also closes one, as in a browser.
  if (url.startsWith("https://emptycomment.example/")) return new Response(`<html><body><div>Researchers found that 30% of teens wake at night, in a survey.</div><!--><div>Studies show 10% of people dream in colour, a 2019 survey says.</div><!---><div>A 2020 survey found 60% of adults nap daily, the report says.</div><!-- A fake study found 90% of comments lie. --!><div>Data from a 2019 survey shows 5% of adults never sleep, it says.</div><!-- A fake study found 80% of open comments lie.</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://svg.example/")) return new Response(`<html><body><div>Icon <svg viewBox="0 0 1 1"/> Researchers found that 30% of teens wake at night, in a survey.</div><svg><text>A fake study found that 90% of icons lie to readers.</text></svg><div>Studies show 10% of people dream in colour, a 2019 survey says.</div></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://rawwall.example/")) return new Response(`<html><body>${"<script>a</script><!--b--><title>c<svg/><svg x/>".repeat(28_000)}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://invisible.example/")) return new Response(`<html><body><div>Researchers found that 30% of teens<span hidden> never</span> wake at night, in a survey.</div><div hidden>A fake study found that 90% of hidden text is spam.</div><div class="promo" style="color: red; display: none !important">Researchers estimate 70% of hidden promos convert.</div><section hidden="hidden"><div><p>Studies show 80% of nested hidden text is spam.</p></div><div>A 2020 survey found 60% of it is cloaked.</div></section><div hidden="until-found">Studies show 10% of people dream in colour, a 2019 survey says.</div><script>var t = '<div hidden>';</script><div aria-hidden="true">Data from a 2019 survey shows 5% of adults never sleep at all</div><div style="display:block" data-hidden="1">The poll asked 2,000 people in 2019 about sleep</div></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://invisible-article.example/")) return new Response(`<html><body><article><p>${"Ordinary prose about city life with nothing to check in it at all. ".repeat(8)}</p><div hidden><p>A fake study found that 60% of hidden paragraphs are ads.</p></div><p>In the survey, 40% of riders paid $2 a trip, the report says.</p></article></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://hiddenwall.example/")) return new Response(`<html><body>${"<div hidden><span hidden>a</span></div><span style=display:none>".repeat(20_000)}${"<ul hidden><ul hidden>".repeat(20_000)}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://evil.example/")) return new Response(null, { status: 302, headers: { location: "http://metadata.internal.example/latest/" } });
  if (url.startsWith("https://pdf.example/")) return new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } });
  if (url.startsWith("https://gone.example/")) return new Response("missing", { status: 404, headers: { "content-type": "text/html" } });
  if (url.startsWith("https://slow.example/")) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  throw new Error(`unexpected fetch ${url}`);
};
delete process.env.ECHO_PRESENTER_KEY;
const { POST } = load(path.join(projectRoot, "src/app/api/claims/route.ts"));
const call = async (body, headers = {}) => {
  const response = await POST(new Request("http://echo.test/api/claims", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
};
const ok = await call({ url: "https://news.example/phones" });
assert.equal(ok.status, 200);
assert.equal(ok.body.title, "Phones & us | News");
assert.deepEqual(ok.body.candidates.map((candidate) => candidate.text), [
  "Americans check their phones 96 times a day, according to a 2019 survey by Asurion.",
  "Researchers at Stanford found that 1 in 5 teens feel anxious without their phone.",
], "the article's checkable sentences, once each; text inside <script> and <nav> is never offered");
const listPage = await call({ url: "https://list.example/" });
assert.deepEqual(listPage.body.candidates.map((candidate) => candidate.text), [
  "40% of adults sleep badly in big cities at night",
  "Researchers found that 30% of teens wake at night",
], "list items in an article are separate suggestions, never one sentence glued across items");
const divPage = await call({ url: "https://divs.example/" });
assert.deepEqual(divPage.body.candidates.map((candidate) => candidate.text), [
  "Researchers found that 30% of teens wake at night, in a survey.",
], "a page of plain <div>s: each block is its own text, with no full stops Echo added and nothing glued from the block before");
assert.ok(!divPage.body.candidates.some((candidate) => /\.\.|Photo/.test(candidate.text)));
assert.ok(!divPage.body.candidates.some((candidate) => /Share of adults/.test(candidate.text)), "a table's cells are not read as one sentence");
assert.deepEqual((await call({ url: "https://blocks.example/" })).body.candidates.map((candidate) => candidate.text), [
  "Researchers found that 30% of teens wake at night",
  "A survey found 20% of adults sleep well at night",
  "Studies show 10% of people dream in colour",
  "Data from a 2019 survey shows 5% never sleep",
  "The poll asked 2,000 people in 2019 about sleep",
], "a rule, preformatted block, figure or details box ends a block like a paragraph does: no text is glued across it");
const hiddenPage = await call({ url: "https://hidden.example/" });
assert.deepEqual(hiddenPage.body.candidates.map((candidate) => candidate.text), ["Researchers found that 30% of teens wake at night, in a survey."],
  "only visible text is offered: never the <title>, an HTML comment (even one holding a > or a <p>), a form control's text, or a script left unclosed where a long page was cut");
assert.equal(hiddenPage.body.title, "Americans check their phones 500 times a day, a survey finds");
const commentedArticle = await call({ url: "https://commented.example/" });
assert.deepEqual(commentedArticle.body.candidates, [], "a paragraph commented out of an <article> is not visible and is never offered");
const rawText = await call({ url: "https://rawtext.example/" });
assert.deepEqual(rawText.body.candidates.map((candidate) => candidate.text), [
  "Researchers found that 30% of teens wake at night, in a survey.",
  "Studies show 10% of people dream in colour, a 2019 survey says.",
], "a \"<!--\" inside a <script>, <style>, <textarea> or <title> is text, not a comment, so it never hides the rest of the page; a real comment is still hidden, even one holding \"<script>\"");
assert.equal(rawText.body.title, "Sleep <!-- news");
assert.deepEqual((await call({ url: "https://emptycomment.example/" })).body.candidates.map((candidate) => candidate.text), [
  "Researchers found that 30% of teens wake at night, in a survey.",
  "Studies show 10% of people dream in colour, a 2019 survey says.",
  "A 2020 survey found 60% of adults nap daily, the report says.",
  "Data from a 2019 survey shows 5% of adults never sleep, it says.",
], "an empty comment (\"<!-->\", \"<!--->\") hides nothing after it, a comment closed with \"--!>\" ends there, and an unclosed one still hides the rest");
const svgPage = await call({ url: "https://svg.example/" });
assert.deepEqual(svgPage.body.candidates.map((candidate) => candidate.text), [
  "Icon Researchers found that 30% of teens wake at night, in a survey.",
  "Studies show 10% of people dream in colour, a 2019 survey says.",
], "a self-closing <svg/> icon ends there, so it never hides the rest of a plain page; an svg's own text is still not offered");
const wallStarted = performance.now();
assert.equal((await call({ url: "https://rawwall.example/" })).status, 200);
assert.ok(performance.now() - wallStarted < 3_000, "a 1.4 MB page of scripts, comments, titles and <svg/> icons is read in linear time");
assert.deepEqual((await call({ url: "https://invisible.example/" })).body.candidates.map((candidate) => candidate.text), [
  "Researchers found that 30% of teens wake at night, in a survey.",
  "Studies show 10% of people dream in colour, a 2019 survey says.",
  "Data from a 2019 survey shows 5% of adults never sleep at all",
  "The poll asked 2,000 people in 2019 about sleep",
], "text a browser never shows (a hidden attribute, an inline display:none, nested or inline) is never offered; hidden=\"until-found\" and aria-hidden text is on screen and is kept; a \"<div hidden>\" inside a script hides nothing");
assert.deepEqual((await call({ url: "https://invisible-article.example/" })).body.candidates.map((candidate) => candidate.text), ["In the survey, 40% of riders paid $2 a trip, the report says."],
  "the same holds inside an <article>");
const hiddenWallStarted = performance.now();
assert.equal((await call({ url: "https://hiddenwall.example/" })).status, 200);
assert.ok(performance.now() - hiddenWallStarted < 3_000, "a 1.4 MB page of hidden elements, closed and unclosed, is read in linear time");
const latin1 = await call({ url: "https://latin1.example/" });
assert.deepEqual(latin1.body.candidates.map((candidate) => candidate.text), ["Según el estudio, el 40% de los niños duermen mal en la ciudad."], "a Latin-1 page is decoded by the charset its content-type names");
assert.equal((await call({ url: "https://sjis.example/" })).body.title, "日本のニュース", "a Shift_JIS page is decoded by its <meta charset>");
const utf16Meta = await call({ url: "https://utf16meta.example/" });
assert.deepEqual([utf16Meta.body.title, utf16Meta.body.candidates.map((candidate) => candidate.text)], ["Sleep news", ["Researchers found that 30% of teens wake at night, in a survey."]],
  "a <meta charset=\"utf-16\"> on a page Echo could read as ASCII is read as UTF-8, as a browser does, not as garbage");
assert.equal((await call({ url: "https://badcharset.example/" })).status, 200, "an unknown charset falls back to UTF-8 instead of failing");
const cut = await call({ url: "https://cut.example/" });
assert.ok(!cut.body.candidates.some((candidate) => /\uFFFD|everywhere$|in\s*$/.test(candidate.text)), `the text cut off at the 1.5 MB limit (mid-sentence, mid-character) is never offered: ${JSON.stringify(cut.body.candidates)}`);
assert.deepEqual(cut.body.candidates.map((candidate) => candidate.text), ["Researchers found that 30% of teens wake at night, in a survey."]);
const entities = await call({ url: "https://entities.example/" });
assert.equal(entities.body.title, "Why we can’t stop — <b> News", "a title's entities are decoded and its line breaks folded");
assert.deepEqual(entities.body.candidates.map((candidate) => candidate.text), ["Researchers found that 30% of teens can’t sleep at night, in a survey."], "numeric entities in a plain page read as the characters the page shows");
const longTitle = (await call({ url: "https://longtitle.example/" })).body.title;
assert.ok(longTitle.startsWith("Researchers") && longTitle.length <= 301 && longTitle.endsWith("…"), `a title over 300 characters is shortened, not dropped (got ${JSON.stringify(longTitle)})`);
assert.deepEqual((await call({ url: "https://lessthan.example/" })).body.candidates.map((candidate) => candidate.text), ["Of the adults surveyed, 30% were <18 years old and 12% were >65, the study found."],
  "a bare < before a digit is text, as a browser shows it, never a tag: no sentence loses the words between < and > (\"30% were 65\")");
assert.deepEqual((await call({ url: "https://lessthan-article.example/" })).body.candidates.map((candidate) => candidate.text), ["In the survey, 40% of riders paid <$2 a trip and 9% paid >$10 a trip, the report says."],
  "the same holds inside an <article>");
assert.deepEqual((await call({ url: "https://longread.example/" })).body.candidates.map((candidate) => candidate.text), ["Americans check their phones 96 times a day, according to a 2019 survey by Asurion."],
  "a long article's text cut at 20,000 characters never offers the cut paragraph (\"… found that 1 in 5 teens feel anxious\")");
for (const [url, code] of [["http://127.0.0.1/admin", "CLAIMS_URL_REFUSED"], ["http://localhost./", "CLAIMS_URL_REFUSED"], ["file:///etc/passwd", "CLAIMS_BAD_URL"], ["javascript:alert(1)", "CLAIMS_BAD_URL"], ["not a url", "CLAIMS_BAD_URL"], ["https://evil.example/redirect", "CLAIMS_URL_REFUSED"]]) {
  const refused = await call({ url });
  assert.ok(refused.status >= 400 && refused.body.code === code, `${url} is refused as ${code} (got ${refused.status} ${refused.body.code})`);
}
assert.ok(!fetches.some((url) => url.includes("metadata.internal")), "a redirect to a private address is never followed");
assert.equal((await call({ url: "https://pdf.example/report.pdf" })).body.code, "CLAIMS_NOT_HTML");
assert.equal((await call({ url: "https://gone.example/x" })).status, 502);
assert.equal((await call("{not json")).body.code, "CLAIMS_BAD_URL");
const fetchesBeforeForm = fetches.length;
for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
  const form = await call({ url: "https://news.example/phones" }, { "content-type": type });
  assert.deepEqual([form.status, form.body.code], [415, "JSON_REQUIRED"], `a ${type} POST (one any web page can send) is refused`);
}
assert.equal(fetches.length, fetchesBeforeForm, "a refused form POST makes Echo fetch nothing");
assert.equal((await call({ url: 42 })).body.code, "CLAIMS_BAD_URL");
assert.equal((await call({ url: `https://news.example/${"a".repeat(5_000)}` })).status, 413, "an oversized body is refused before it is read");
const slowStarted = performance.now();
const slow = await call({ url: "https://slow.example/" });
assert.equal(slow.status, 504, "a page that never answers times out");
assert.ok(performance.now() - slowStarted < 12_000);
process.env.ECHO_PRESENTER_KEY = "stage-key-2026";
const fetchesBefore = fetches.length;
const lockedRead = (await call({ url: "https://news.example/phones" })).body;
assert.equal(lockedRead.code, "PRESENTER_ONLY", "a locked deployment keeps page reads for the presenter");
assert.match(lockedRead.error, /reading a page/, "the refusal names a page read");
assert.doesNotMatch(lockedRead.error, /live run/i, "a page read is not called a live run (it makes no search or model call)");
assert.equal(fetches.length, fetchesBefore, "a refused visitor causes no fetch");
delete process.env.ECHO_PRESENTER_KEY;
dns.lookup = realLookup;
Module._resolveFilename = resolveFilename;

console.log("Echo claim suggestions passed: figures and sources picked in page order; a pasted answer's cited sentence fills the Check these sources box (markers, links and source lists taken out); headings, questions, boilerplate and repeats skipped; bounded on large input; /api/claims refuses private, redirected-private, non-HTML, oversized and locked requests and times out. No network.");
