// Browser click-through of the demo, run against the production build in your installed Google Chrome.
// No search or model calls: the server starts with the API keys blanked, so nothing can spend money.
//   npm run build && npm run smoke:ui          (add -- --headed to watch it)
// It checks what a judge would see: each demo slot and the backup open, the accuracy card and copy hunt show,
// Present mode steps through every slide, a failed live run offers the saved run, and the demo still works
// with the network switched off after one online visit (the service worker's offline cache). Last, a judge-typed
// claim runs live to a finished trace against mocked providers (scripts/smoke-mock-providers.mjs), still no spend,
// and so does a pasted AI answer's links (Check these sources), which only its button can start.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const headed = process.argv.includes("--headed");
const failures = [];
const ok = (message) => process.stdout.write(`  ok    ${message}\n`);
const fail = (message) => { failures.push(message); process.stdout.write(`  FAIL  ${message}\n`); };

const workbench = fs.readFileSync(path.join(root, "src/app/demo-slots.ts"), "utf8");
const slots = [...workbench.matchAll(/\{ id: "(\w+)", slot: "(\d+)", label: "([^"]+)", claim: "([^"]+)", capturedTrace: "([^"]+)" \}/g)]
  .map(([, id, slot, label, claim, trace]) => ({ id, slot, label, claim, trace }));
const backups = [...workbench.matchAll(/\{ label: "([^"]+)", claim: "([^"]+)", capturedTrace: "([^"]+)" \}/g)]
  .map(([, label, claim, trace]) => ({ label, claim, trace }));
// A list that cannot be read would make every slot check pass vacuously.
if (!slots.length || !backups.length) {
  process.stdout.write(`UI smoke test FAILED: read ${slots.length} demo slots and ${backups.length} backups from src/app/demo-slots.ts.\n`);
  process.exit(1);
}
const scoresSource = fs.readFileSync(path.join(root, "src/lib/echo/demo-scores.ts"), "utf8");
const DEMO_SCORES = JSON.parse(scoresSource.slice(scoresSource.indexOf("DEMO_SCORES: Record<string, DemoScore> = ") + "DEMO_SCORES: Record<string, DemoScore> = ".length).trim().replace(/;$/, ""));
const summaryOf = (trace) => JSON.parse(fs.readFileSync(path.join(root, "public", trace), "utf8")).analysis;
// The saved Check these sources run (demo-slots.ts SAVED_SOURCE_CHECK), shown on /how and as a card on /explore.
const SAVED_CHECK_TRACE = "/demo-traces/check-these-sources-phones.echo.json";

// The plain-search wording the planner checked by hand against each bundled trace, shown under the verdict, in the
// text report and on each Explore card. "About this claim" (never "match"): on the brain run every plain result
// debunks the myth.
const expectedLines = {
  "americans-check-phones-96-times": {
    primary: "Plain search: 10 results, 5 about this claim. Behind those 5: 1 independent origin; 1 page unclear.",
    detail: "Of those 5: 2 root pages published together, counted as 1 origin, 2 confirmed copies of them, 1 unclear (no confirmed link). Echo's full trace (13 searches) finds 2 independent origins, both with their own evidence.",
    stage: "Behind those 5: 1 independent origin; 1 page unclear.",
    breakdown: "13 pages = 3 root pages (2 independent origins; pages published together count once) + 4 confirmed copies + 6 unclear",
    verdict: "Echo collapses repeated pages to their independent origins. 6 relationships remain unresolved. 2 off-claim pages were excluded. 31% echo",
  },
  "humans-use-10-percent-of-brain": {
    primary: "Plain search: 10 results, all about this claim. Behind them: 4 independent origins, none with its own evidence for it; 4 pages unclear.",
    detail: "Of those 10: 4 root pages, 2 confirmed copies of them, 4 unclear (no confirmed link). Echo's full trace (5 searches) finds 8 independent origins, none with its own evidence for the claim.",
    stage: "Behind them: 4 independent origins, none with its own evidence for it; 4 pages unclear.",
    breakdown: "20 pages = 8 root pages (8 independent origins) + 3 confirmed copies + 9 unclear",
    verdict: "No independent origin shows evidence of its own for this claim in its retrieved passage. 15% echo",
  },
  "goldfish-3-second-memory": { primary: "Plain search: 10 results, 8 about this claim. Behind those 8: 3 independent origins, 1 with its own evidence for it; 4 pages unclear.", breakdown: "14 pages = 4 root pages (4 independent origins) + 1 confirmed copy + 9 unclear", verdict: "Echo collapses repeated pages to their independent origins. 9 relationships remain unresolved. 7% echo" },
  "lose-most-body-heat-through-head": { primary: "Plain search: 10 results, all about this claim. Behind them: 2 independent origins, 1 with its own evidence for it; 7 pages unclear.", breakdown: "18 pages = 4 root pages (4 independent origins) + 3 confirmed copies + 11 unclear", verdict: "Echo collapses repeated pages to their independent origins. 11 relationships remain unresolved. 2 off-claim pages were excluded. 17% echo" },
};
const slugOf = (trace) => trace.split("/").pop().replace(/\.echo\.json$/, "");
// Retired names for the origin count, and "root" where an origin is meant (the same list as scripts/check-copy.mjs).
const RETIRED_COPY = /\b(?:candidate[- ]roots?|independent roots?|verifiable origins?|primary[- ]evidence|roots? with (?:primary )?evidence|root sources?|(?:trace|check) the roots|answer from roots|cited roots|roots no longer cited|the roots or|an? root is)\b/i;

// Opens the result toolbar's More menu if it is closed.
async function openMoreOn(page) {
  const more = page.locator(".result-more-button");
  if ((await more.count()) && (await more.getAttribute("aria-expanded")) !== "true") await more.click();
}
// Clicks a result toolbar action by its visible words, opening More first when the action sits in it.
async function resultActionOn(page, name) {
  const button = page.locator(".result-actions button", { hasText: name }).first();
  if (!(await button.isVisible().catch(() => false))) await openMoreOn(page);
  await button.click();
}

// The saved Check these sources run (demo-slots.ts SAVED_SOURCE_CHECK): its button label, bundled file and links, and
// what its result must show (the v2 live run of the five phones links, 2026-11-13).
const savedCheck = (() => {
  const source = workbench.slice(workbench.indexOf("SAVED_SOURCE_CHECK"));
  const trace = source.match(/savedTrace: "([^"]+)"/)?.[1];
  return { label: source.match(/label: "([^"]+)"/)?.[1], trace, urls: [...(source.match(/urls: \[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]) };
})();
if (!savedCheck.label || !savedCheck.trace || savedCheck.urls.length !== 5) {
  process.stdout.write(`UI smoke test FAILED: could not read SAVED_SOURCE_CHECK from src/app/demo-slots.ts (${JSON.stringify(savedCheck)}).\n`);
  process.exit(1);
}
const SAVED_CHECK = {
  headline: /^5 supplied links → 1 independent origin\b/,
  rows: [
    "[1] asurion.com — independent origin, with its own evidence",
    "[2] prnewswire.com — published together with [1], one origin",
    "[3] fox13seattle.com — copy of [2]",
    "[4] kabc.com — possible copy of [1], link not confirmed",
    "[5] churchandculture.org — copy of [3]",
  ],
  tag: `SAVED LIVE RUN · captured ${new Date(JSON.parse(fs.readFileSync(path.join(root, "public", savedCheck.trace), "utf8")).analysis.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
  createdAt: JSON.parse(fs.readFileSync(path.join(root, "public", savedCheck.trace), "utf8")).analysis.createdAt,
};
// The live-run pages below open in a far-off timezone (liveZone), where the saved check's capture day is that viewer's
// own calendar day, not this machine's. Set when that context is made; null for pages in this machine's zone.
let liveZoneName = null;
/** The saved check's result as shown: headline, per-link rows, result tag and address bar; null parts when missing. */
async function readSavedCheckOn(page) {
  await page.locator("[aria-label='Each supplied link'] li").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  return {
    headline: ((await page.locator("[aria-label='Supplied sources result'] h2").textContent({ timeout: 2_000 }).catch(() => "")) ?? "").trim(),
    rows: await page.locator("[aria-label='Each supplied link'] li").evaluateAll((items) => items.map((item) => [...item.children].map((child) => child.textContent.trim()).join(" "))),
    tag: ((await page.locator(".result-mode-tag").innerText({ timeout: 2_000 }).catch(() => "")) ?? "").trim(),
    trace: new URL(page.url()).searchParams.get("trace"),
  };
}
/** zone: the page's own timezone when it is not this machine's (the live-run context); the tag is dated in it. */
const savedCheckProblems = (shown, zone = null) => {
  const tag = zone ? `SAVED LIVE RUN · captured ${new Date(SAVED_CHECK.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: zone })}` : SAVED_CHECK.tag;
  return [
    ...(SAVED_CHECK.headline.test(shown.headline) ? [] : [`headline "${shown.headline}"`]),
    ...(JSON.stringify(shown.rows) === JSON.stringify(SAVED_CHECK.rows) ? [] : [`rows ${JSON.stringify(shown.rows)}`]),
    // In this machine's zone (Pacific) the capture day is pinned; in the live-run zone it is that zone's day.
    ...(shown.tag === tag && (zone || shown.tag.endsWith("Nov 13, 2026")) ? [] : [`tag "${shown.tag}" (expected "${tag}")`]),
  ];
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

if (!fs.existsSync(path.join(root, ".next", "BUILD_ID"))) {
  process.stdout.write("No production build: run `npm run build` first.\n");
  process.exit(1);
}
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(path.join(root, "node_modules", ".bin", "next"), ["start", "-p", String(port), "-H", "127.0.0.1"], {
  cwd: root,
  stdio: "ignore",
  // Blank keys override .env.local, so a live run fails fast instead of calling a paid API (Telem's key too).
  // No extension listed: /embed must refuse every frame here (the side panel's own server, below, lists one).
  env: { ...process.env, ANTHROPIC_API_KEY: "", TAVILY_API_KEY: "", TELEM_API_KEY: "", ECHO_SEARCH_ROUTER: "tavily", ECHO_COPY_HUNT: "0", ECHO_EXTENSION_ORIGINS: "" },
});

// Shared by every browser context below (the main one and the mocked live run's), via addInitScript.
// A tree's link captions ("92%", "unclear") must sit in the gaps between page cards: a card drawn over one turned
// "92%" into "2%" and "80%" into "30%" on Present slide 3. Canvas coordinates (layout offsets for the cards), so the
// cards' arrival animation cannot move them.
const captionChecks = () => {
  window.__echoCaptionsUnderCards = (scope) => {
    const canvas = scope.querySelector(".tree-canvas");
    if (!canvas) return { count: 0, covered: [] };
    const frame = canvas.getBoundingClientRect();
    const cards = [...canvas.querySelectorAll(".source-node")].map((node) => ({ id: node.dataset.pageId, left: node.offsetLeft, top: node.offsetTop, right: node.offsetLeft + node.offsetWidth, bottom: node.offsetTop + node.offsetHeight, domain: node.querySelector(".node-domain")?.textContent ?? "" }));
    const captions = [...canvas.querySelectorAll(".edge-caption")];
    const covered = captions.flatMap((caption) => {
      const box = caption.getBoundingClientRect();
      const left = box.left - frame.left, right = box.right - frame.left, top = box.top - frame.top, bottom = box.bottom - frame.top;
      const card = cards.find((entry) => left < entry.right && right > entry.left && top < entry.bottom && bottom > entry.top);
      return card ? [`"${caption.firstChild?.textContent ?? ""}" at x ${Math.round(left)}-${Math.round(right)} under ${card.domain} (${card.left}-${card.right})`] : [];
    });
    // QA round 4 D10: each caption sits beside the page its link points to (level with that card), never beside
    // another row's card: head heat's WebMD → jamaicahospital "unclear" sat beside badgeraustralia on slide 3.
    const astray = captions.flatMap((caption) => {
      const target = cards.find((entry) => entry.id === caption.dataset.target);
      const box = caption.getBoundingClientRect();
      const middle = (box.top + box.bottom) / 2 - frame.top;
      return target && middle >= target.top && middle <= target.bottom ? [] : [`"${caption.firstChild?.textContent ?? ""}" for ${target?.domain ?? caption.dataset.target ?? "no target"} at y ${Math.round(middle)}${target ? `, its card ${target.top}-${target.bottom}` : ""}`];
    });
    return { count: captions.length, covered, astray };
  };
  // Nor may another link's curve be painted over a caption: on slot 02's slide 3 the Asurion → KABC curve struck
  // through the reference page's "60%". A curve that passes through a caption's box must be painted before it (SVG
  // paints in document order), and the caption must carry its background pill (the stroke halo, painted first).
  window.__echoCaptionsStruck = (scope) => {
    const svg = scope.querySelector(".tree-canvas svg.tree-lines");
    if (!svg) return { count: 0, struck: [] };
    const order = [...svg.querySelectorAll(".edge-path, .edge-caption")];
    const paths = order.filter((node) => node.classList.contains("edge-path"));
    const captions = order.filter((node) => node.classList.contains("edge-caption"));
    const struck = captions.flatMap((caption) => {
      const box = caption.getBBox();
      const style = getComputedStyle(caption);
      const pill = style.paintOrder.startsWith("stroke") && style.stroke !== "none" && parseFloat(style.strokeWidth) >= 3;
      const label = caption.firstChild?.textContent ?? "";
      return paths.flatMap((curve) => {
        const length = curve.getTotalLength();
        let crosses = false;
        for (let at = 0; at <= length && !crosses; at += 1.5) {
          const point = curve.getPointAtLength(at);
          crosses = point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
        }
        if (!crosses) return [];
        if (order.indexOf(curve) > order.indexOf(caption)) return [`"${label}" at ${Math.round(box.x)},${Math.round(box.y)} has a curve drawn over it`];
        return pill ? [] : [`"${label}" at ${Math.round(box.x)},${Math.round(box.y)} has a curve through it and no background pill`];
      });
    });
    return { count: captions.length, struck };
  };
};

let browser;
try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(base)).ok) break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  browser = await chromium.launch({ channel: "chrome", headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.addInitScript(captionChecks);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });

  process.stdout.write(`Echo UI smoke test (Chrome, ${base}, keys blanked)\n\nOnline\n`);
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // The trace for a different claim must replace the old one, so wait for this claim's own page count to appear.
  const waitForText = (text) => page.waitForFunction(
    ([wanted, claim]) => Boolean(document.querySelector("main")?.innerText.includes(wanted))
      && document.getElementById("claim-input")?.value.trim().toLowerCase() === claim.toLowerCase(),
    [text, currentClaim],
    { timeout: 10_000 },
  ).then(() => true, () => false);
  let currentClaim = "";
  const openMore = () => openMoreOn(page);
  const resultAction = (name) => resultActionOn(page, name);
  const openAndCheck = async (button, entry, label) => {
    currentClaim = summaryOf(entry.trace).claim;
    await button.click();
    await page.locator(".loading-card").waitFor({ state: "detached", timeout: 15_000 }).catch(() => undefined);
    const analysis = summaryOf(entry.trace);
    const pages = `${analysis.summary.totalPages} pages`;
    if (!(await waitForText(pages))) { fail(`${label}: page does not show "${pages}"`); return false; }
    if (await page.locator(".error-banner").count()) { fail(`${label}: an error banner is showing`); return false; }
    const extras = [];
    if (await page.locator(".accuracy-card").count()) {
      extras.push("accuracy card");
      // Runs made before the Nov 12 fixes must be marked on the card, so old errors are not read as today's.
      const earlier = (DEMO_SCORES[entry.trace]?.runs ?? []).filter((run) => run.earlierEcho).length;
      if (earlier) {
        await page.locator(".accuracy-card summary, .accuracy-card button").evaluateAll((items) => items.forEach((item) => item instanceof HTMLElement && item.tagName === "SUMMARY" && item.click()));
        const marked = await page.locator(".accuracy-card").innerText().then((text) => (text.match(/earlier Echo/g) ?? []).length);
        if (marked < earlier) { fail(`${label}: ${earlier} earlier-Echo runs but the card marks ${marked}`); return false; }
        extras.push(`${earlier} earlier-Echo runs marked`);
      }
    }
    if (analysis.copyHunt) {
      if (await page.locator(".copy-hunt-list, .copy-hunt").count()) extras.push("copy hunt");
      else { fail(`${label}: the saved copy hunt is not shown`); return false; }
    }
    ok(`${label}: opens the saved run (${pages}, ${analysis.summary.independentOrigins} origins${extras.length ? `; ${extras.join(", ")}` : ""})`);
    return true;
  };

  for (const slot of slots) {
    await openAndCheck(page.locator(`.preset-chip.preset-${slot.id}`), slot, `slot ${slot.slot} ${slot.label}`);
  }
  for (const backup of backups) {
    await openAndCheck(page.locator(".backup-chip", { hasText: backup.label }), backup, `backup "${backup.label}"`);
  }

  // The copy hunt opens collapsed, its summary line ("15 possible copies outside this trace · 8 dated after the
  // original") in view; one click on it opens the list, which shows only its five strongest candidates, with a button
  // for the rest. The tree no longer sits below an open list of possible copies.
  const expandCopyHunt = async () => {
    const summary = page.locator("details.copy-hunt > summary");
    if (!(await page.locator("details.copy-hunt").evaluate((node) => node.open).catch(() => true))) await summary.click().catch(() => undefined);
  };
  {
    // Prefer a hunt whose candidates match different numbers of phrases, so the ranking shows. Phrases listed as "Not
    // counted" are left out of a candidate's count and rank.
    const countedOf = (hunt, candidate) => candidate.matchedPhrases.filter((phrase) => !(hunt.commonPhrases ?? []).includes(phrase)).length;
    const hunts = slots.filter((candidate) => (summaryOf(candidate.trace).copyHunt?.candidates.length ?? 0) > 5);
    const entry = hunts.find((candidate) => { const hunt = summaryOf(candidate.trace).copyHunt; return new Set(hunt.candidates.map((c) => countedOf(hunt, c))).size > 1; }) ?? hunts[0];
    if (entry) {
      const hunt = summaryOf(entry.trace).copyHunt;
      currentClaim = summaryOf(entry.trace).claim;
      await page.goto(`${base}/?slot=${entry.slot}`);
      await waitForText(`${summaryOf(entry.trace).summary.totalPages} pages`);
      const later = hunt.candidates.filter((candidate) => candidate.timing === "after root").length;
      const wantSummary = `COPY HUNT · BETA${hunt.candidates.length} possible ${hunt.candidates.length === 1 ? "copy" : "copies"} outside this trace · ${later} dated after the original`;
      // checkVisibility(): a closed <details> hides its content with content-visibility, which a box size does not show.
      const collapsed = await page.locator("details.copy-hunt").evaluate((node) => ({ open: node.open, summary: node.querySelector("summary")?.innerText.replace(/\s+/g, "") ?? "", visible: Boolean(node.querySelector("summary")?.checkVisibility()), list: Boolean(node.querySelector(".copy-hunt-list")?.checkVisibility()) })).catch(() => null);
      if (!collapsed || collapsed.open || collapsed.list || !collapsed.visible || collapsed.summary !== wantSummary.replace(/\s+/g, "")) fail(`slot ${entry.slot} copy hunt on opening: ${JSON.stringify(collapsed)}, expected collapsed with "${wantSummary}" in view`);
      else ok(`slot ${entry.slot} copy hunt opens collapsed, its summary in view: "${wantSummary.replace("BETA", "BETA · ")}"`);
      await page.locator("details.copy-hunt > summary").click().catch(() => undefined);
      const open = await page.locator("details.copy-hunt").evaluate((node) => node.open && Boolean(node.querySelector(".copy-hunt-list")?.checkVisibility())).catch(() => false);
      const before = await page.locator(".copy-hunt-list > li").count();
      const top = await page.locator(".copy-hunt-list > li small:last-of-type").allInnerTexts();
      const bestMatches = Math.max(...hunt.candidates.map((candidate) => countedOf(hunt, candidate)));
      const button = page.locator(".copy-hunt-more");
      const label = (await button.innerText().catch(() => "")).trim();
      await button.click().catch(() => undefined);
      const after = await page.locator(".copy-hunt-list > li").count();
      if (!open || before !== 5 || !top[0]?.startsWith(`Matches ${bestMatches} of`) || label !== `Show all ${hunt.candidates.length}` || after !== hunt.candidates.length) fail(`slot ${entry.slot} copy hunt after one click: open ${open}, ${before} shown first ("${top[0]}"), button "${label}", ${after} after it`);
      else ok(`slot ${entry.slot} copy hunt: one click opens it, the top 5 first (best matches ${bestMatches} ${bestMatches === 1 ? "phrase" : "phrases"}), "${label}" shows all ${after}`);
    }
    // The phrases set aside as common wording show as separate chips, like the searched ones, never run together.
    for (const slot of slots.filter((candidate) => summaryOf(candidate.trace).copyHunt?.commonPhrases?.length)) {
      const common = summaryOf(slot.trace).copyHunt.commonPhrases;
      currentClaim = summaryOf(slot.trace).claim;
      await page.goto(`${base}/?slot=${slot.slot}`);
      await waitForText(`${summaryOf(slot.trace).summary.totalPages} pages`);
      await expandCopyHunt();
      const chips = await page.locator(".copy-hunt-phrases-common q").evaluateAll((nodes) => nodes.map((node) => {
        const style = getComputedStyle(node);
        return { text: node.textContent ?? "", chip: style.display === "inline-block" && parseFloat(style.paddingLeft) > 0 && parseFloat(style.marginRight) > 0 };
      }));
      if (chips.length !== common.length || chips.some((chip, index) => !chip.chip || chip.text !== common[index])) fail(`slot ${slot.slot} copy hunt: the "Not counted" phrases render as ${JSON.stringify(chips)}`);
      else ok(`slot ${slot.slot} copy hunt: ${common.length} "Not counted" ${common.length === 1 ? "phrase shows" : "phrases show"} as separate chips`);
      // Each candidate's count leaves the not-counted phrases out of its "N of M", so the numbers agree with the chips.
      const hunt = summaryOf(slot.trace).copyHunt;
      const want = hunt.phrases.length - common.length;
      const lines = await page.locator(".copy-hunt-list > li small:last-of-type").allInnerTexts();
      const wrong = lines.filter((line) => !new RegExp(`^Matches \\d+ of ${want} counted phrases?(?:, plus \\d+ not counted)?`).test(line));
      if (!lines.length || wrong.length) fail(`slot ${slot.slot} copy hunt: candidate counts read ${JSON.stringify(wrong.slice(0, 2))}, not "Matches N of ${want} counted…"`);
      else ok(`slot ${slot.slot} copy hunt: candidates count ${want} counted ${want === 1 ? "phrase" : "phrases"} ("${lines[0].split(":")[0]}")`);
    }
  }

  // Presenter shortcut: with nothing focused, pressing a slot's number opens it; typed into the claim box it is text.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  const shortcutSlot = slots[slots.length - 1];
  await openAndCheck({ click: () => page.keyboard.press(String(Number(shortcutSlot.slot))) }, shortcutSlot, `key ${Number(shortcutSlot.slot)} opens slot ${shortcutSlot.slot}`);
  await page.locator(".new-claim-button", { hasText: "New trace" }).click().catch(() => undefined);
  await page.locator("#claim-input").fill("");
  await page.locator("#claim-input").press(String(Number(shortcutSlot.slot)));
  const typedDigit = await page.locator("#claim-input").inputValue();
  if (typedDigit !== String(Number(shortcutSlot.slot)) || (await page.locator(".loading-card").count())) fail(`typing ${Number(shortcutSlot.slot)} in the claim box triggered the shortcut (box reads "${typedDigit}")`);
  else ok(`typing ${Number(shortcutSlot.slot)} in the claim box stays text`);
  await page.locator("#claim-input").fill("");

  // The home page's second action: "Check an AI answer's links" is a bordered button on the claim box's label row,
  // above the claim input and wholly above the fold at 1280x720 and 1920x1080, and opens the panel without a run.
  {
    for (const [width, height] of [[1280, 720], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await page.goto(base);
      await page.evaluate(() => window.scrollTo(0, 0));
      const entry = await page.evaluate(() => {
        const button = [...document.querySelectorAll(".claim-panel button")].find((node) => /Check an AI answer.s links/.test(node.textContent ?? ""));
        const box = button?.getBoundingClientRect();
        const input = document.getElementById("claim-input")?.getBoundingClientRect();
        const trace = document.querySelector(".claim-panel .trace-button")?.getBoundingClientRect();
        const style = button ? getComputedStyle(button) : null;
        return box && input && trace ? {
          text: button.textContent.trim(), top: Math.round(box.top), bottom: Math.round(box.bottom),
          aboveInput: box.bottom <= input.top, rightAligned: Math.abs(box.right - trace.right) <= 2,
          bordered: Number.parseFloat(style.borderTopWidth) >= 1 && style.borderTopStyle !== "none", fontSize: Number.parseFloat(style.fontSize),
          hero: document.querySelector(".hero-description")?.textContent ?? "",
        } : null;
      });
      if (!entry || entry.text !== "Check an AI answer's links →" || entry.top < 0 || entry.bottom > height || !entry.aboveInput || !entry.rightAligned || !entry.bordered || entry.fontSize < 12) fail(`at ${width}x${height}, the Check an AI answer's links entry: ${JSON.stringify(entry)}`);
      else ok(`at ${width}x${height}, "${entry.text}" is a bordered button on the claim box's label row, right-aligned with Trace sources, above the fold (${entry.top}–${entry.bottom}px)`);
      // The hero's sub-line names both ways in: tracing a claim and checking the links an AI answer cites.
      if (!/traces a claim/.test(entry?.hero ?? "") || !/links an AI answer cites/.test(entry?.hero ?? "")) fail(`at ${width}x${height}, the hero's sub-line reads "${entry?.hero}"`);
    }
    const posts = [];
    const countPosts = (request) => { if (request.url().includes("/api/analyze") && request.method() === "POST") posts.push(request.url()); };
    page.on("request", countPosts);
    await page.waitForTimeout(600);
    await page.locator("button", { hasText: "Check an AI answer's links" }).click();
    await page.locator("#source-check-text").waitFor({ timeout: 5_000 }).catch(() => undefined);
    const opened = await page.locator("#source-check-text").isVisible().catch(() => false);
    const focused = await page.evaluate(() => document.activeElement?.id ?? "");
    const expanded = await page.locator("button", { hasText: "Check an AI answer's links" }).getAttribute("aria-expanded");
    await page.waitForTimeout(500);
    page.off("request", countPosts);
    if (!opened || focused !== "source-check-text" || expanded !== "true" || posts.length) fail(`pressing Check an AI answer's links: panel open ${opened}, focus on #${focused}, aria-expanded ${expanded}, ${posts.length} runs`);
    else ok("pressing it opens the Check these sources panel with the focus in its paste box, and runs nothing");
    // QA round 4 D8: closing the panel (×) returns the focus to the button that opened it, not to the page body.
    await page.locator("button[aria-label='Close Check these sources']").click();
    await page.waitForTimeout(200);
    const afterClose = await page.evaluate(() => ({ id: document.activeElement?.id ?? "", tag: document.activeElement?.tagName ?? "", panel: Boolean(document.getElementById("source-check")) }));
    if (afterClose.panel || afterClose.id !== "source-check-open") fail(`closing the Check these sources panel: panel still shown ${afterClose.panel}, focus on ${afterClose.tag}#${afterClose.id}`);
    else ok("closing the panel with × returns the focus to Check an AI answer's links");
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(base);
  }

  // At 1280x720 a clicked slot scrolls its verdict into view (it opens about 80 px below the fold), and so does a
  // ?slot= link on first load (QA #15: it opened at the top with the verdict at y≈789).
  {
    const slot = slots[slots.length - 1];
    currentClaim = summaryOf(slot.trace).claim;
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(base);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(`.preset-chip.preset-${slot.id}`).click();
    await waitForText(`${summaryOf(slot.trace).summary.totalPages} pages`);
    // Measured once the smooth scroll has settled.
    let settled = -1;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(150);
      const scrollY = await page.evaluate(() => window.scrollY);
      if (scrollY === settled) break;
      settled = scrollY;
    }
    const inView = await page.evaluate(() => {
      const box = document.querySelector(".verdict-banner h2")?.getBoundingClientRect();
      return box ? { top: Math.round(box.top), bottom: Math.round(box.bottom), scrollY: Math.round(window.scrollY), visible: box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight } : null;
    });
    if (!inView?.visible || inView.scrollY <= 0) fail(`at 1280x720, clicking slot ${slot.slot} leaves its verdict heading off screen (${JSON.stringify(inView)})`);
    else ok(`at 1280x720, clicking slot ${slot.slot} scrolls its verdict heading into view (heading ${inView.top}–${inView.bottom}px of 720, page scrolled ${inView.scrollY}px)`);
    // The result toolbar above it is not clipped either: the Present button sits wholly inside the window.
    const toolbar = await page.evaluate(() => {
      const box = document.querySelector(".result-stack .present-button")?.getBoundingClientRect();
      return box ? { top: Math.round(box.top), bottom: Math.round(box.bottom), visible: box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight } : null;
    });
    if (!toolbar?.visible) fail(`at 1280x720, clicking slot ${slot.slot} clips the result toolbar (Present button ${JSON.stringify(toolbar)})`);
    else ok(`at 1280x720, the result toolbar's Present button is fully in view after the click (${toolbar.top}–${toolbar.bottom}px)`);
    for (const linked of slots) {
      currentClaim = summaryOf(linked.trace).claim;
      await page.goto(`${base}/?slot=${linked.slot}`);
      await waitForText(`${summaryOf(linked.trace).summary.totalPages} pages`);
      let linkSettled = -1;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await page.waitForTimeout(150);
        const scrollY = await page.evaluate(() => window.scrollY);
        if (scrollY === linkSettled) break;
        linkSettled = scrollY;
      }
      const linkView = await page.evaluate(() => {
        const box = document.querySelector(".verdict-banner h2")?.getBoundingClientRect();
        return box ? { top: Math.round(box.top), bottom: Math.round(box.bottom), scrollY: Math.round(window.scrollY), visible: box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight } : null;
      });
      if (!linkView?.visible || linkView.scrollY <= 0) fail(`at 1280x720, a ?slot=${linked.slot} link leaves its verdict heading off screen (${JSON.stringify(linkView)})`);
      else ok(`at 1280x720, a ?slot=${linked.slot} link scrolls its verdict heading into view (heading ${linkView.top}–${linkView.bottom}px of 720, page scrolled ${linkView.scrollY}px)`);
    }
    currentClaim = summaryOf(slot.trace).claim;
    await page.setViewportSize({ width: 1360, height: 900 });
  }

  // "How Echo checked this": one strip under the echo-spread timeline with the run's steps, counted from the trace
  // (each number checked by hand in check-readiness). On a Check these sources trace, Plan and Search read "skipped".
  // It sits below the verdict and the plain-search box, so a slot click scrolls exactly where it does without it.
  {
    const stripLines = () => page.locator(".how-checked-steps li").evaluateAll((items) => items.map((item) => {
      const time = item.querySelector(".how-checked-time")?.textContent ?? "";
      const label = item.querySelector(".how-checked-step")?.textContent ?? "";
      const step = (time ? label.slice(0, -time.length) : label).trim();
      const value = item.querySelector("strong")?.textContent?.trim() ?? "";
      const detail = item.querySelector(".how-checked-detail")?.textContent?.trim() ?? "";
      return `${step}: ${value} — ${detail}${time ? ` (${time.replace(/^\s*·\s*/, "")})` : ""}`;
    }));
    const expectedStrip = {
      "americans-check-phones-96-times": [
        "Plan: 10 query variants — built from the claim's wording, no model call",
        "Search: 13 searches run (3 deeper) — 124 results · 15 distinct pages found",
        "Read: 15 pages read — 9 with a reliable date · 1 only from its search snippet",
        "Group: 4 claim groups — 13 pages about the claim · 2 off-claim pages excluded",
        "Judge: 2 independent origins — from 3 root pages · 4 confirmed copies (by date or citation) · 6 unclear",
        "Verify: 8 of 8 answer figures — found in the passages they cite",
        "Answer: Written from 2 independent origins — root pages only; copies and unclear pages left out",
      ],
      "humans-use-10-percent-of-brain": [
        "Plan: 10 query variants — built from the claim's wording, no model call",
        "Search: 5 searches run — 50 results · 20 distinct pages found · 5 variants not run (enough pages found)",
        "Read: 20 pages read — 11 with a reliable date · 3 only from their search snippet",
        "Group: 1 claim group — 20 pages about the claim · none off-claim",
        "Judge: 8 independent origins — 3 confirmed copies (by date or citation) · 9 unclear",
        "Answer: No answer written — none of the 8 independent origins shows evidence of its own, so Echo lists them (no model call)",
      ],
    };
    const settledScroll = async () => {
      let settled = -1;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await page.waitForTimeout(150);
        const scrollY = await page.evaluate(() => window.scrollY);
        if (scrollY === settled) break;
        settled = scrollY;
      }
      return settled;
    };
    for (const slot of slots) {
      const want = expectedStrip[slugOf(slot.trace)];
      if (!want) continue;
      currentClaim = summaryOf(slot.trace).claim;
      await page.locator(`.preset-chip.preset-${slot.id}`).click();
      await waitForText(`${summaryOf(slot.trace).summary.totalPages} pages`);
      const lines = await stripLines();
      const head = (await page.locator(".how-checked-head").textContent().catch(() => "")) ?? "";
      if (JSON.stringify(lines) !== JSON.stringify(want)) fail(`slot ${slot.slot}: "How Echo checked this" reads ${JSON.stringify(lines)}`);
      else ok(`slot ${slot.slot}: "How Echo checked this" reads ${lines.map((line) => line.split(" — ")[0]).join(" · ")}`);
      if (/Stage times/.test(head)) fail(`slot ${slot.slot}: the strip shows stage times, but its trace has no cost receipt ("${head}")`);
      else ok(`slot ${slot.slot}: no stage times (its trace has no cost receipt)`);
      // Under the timeline: after the spread (when it shows) and below the plain-search box.
      const order = await page.evaluate(() => {
        const strip = document.querySelector(".how-checked");
        const spread = document.querySelector('[aria-label="Watch the echo spread"]');
        const plain = document.querySelector(".plain-search-line");
        const follows = (a, b) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return { afterSpread: !spread || follows(spread, strip), afterPlain: !plain || follows(plain, strip) };
      });
      if (!order.afterSpread || !order.afterPlain) fail(`slot ${slot.slot}: the strip is not under the timeline and the plain-search box (${JSON.stringify(order)})`);
      else ok(`slot ${slot.slot}: the strip sits under the echo-spread timeline`);
    }
    // The slot click lands where it would without the strip: measured with it shown, then hidden.
    {
      const slot = slots[slots.length - 1];
      currentClaim = summaryOf(slot.trace).claim;
      await page.setViewportSize({ width: 1280, height: 720 });
      const landing = async (hidden) => {
        await page.goto(base);
        if (hidden) await page.addStyleTag({ content: ".how-checked { display: none !important; }" });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.locator(`.preset-chip.preset-${slot.id}`).click();
        await waitForText(`${summaryOf(slot.trace).summary.totalPages} pages`);
        const scrollY = await settledScroll();
        const plain = await page.evaluate(() => { const box = document.querySelector(".plain-search-line")?.getBoundingClientRect(); return box ? { top: Math.round(box.top), bottom: Math.round(box.bottom) } : null; });
        return { scrollY, plain, shown: await page.locator(".how-checked").isVisible() };
      };
      const withStrip = await landing(false);
      const without = await landing(true);
      if (!withStrip.shown || without.shown) fail(`the strip's scroll comparison did not show and hide it (${JSON.stringify({ withStrip, without })})`);
      else if (withStrip.scrollY !== without.scrollY || JSON.stringify(withStrip.plain) !== JSON.stringify(without.plain)) fail(`at 1280x720 the strip moves where a slot ${slot.slot} click lands: ${JSON.stringify(withStrip)} with it, ${JSON.stringify(without)} without`);
      else ok(`at 1280x720 a slot ${slot.slot} click lands at ${withStrip.scrollY}px with or without the strip (plain-search box ${withStrip.plain?.top}–${withStrip.plain?.bottom}px)`);
      await page.setViewportSize({ width: 1360, height: 900 });
    }
    // An imported Check these sources trace: Plan and Search skipped, stage times from its receipt.
    {
      const fixture = path.join(root, "scripts", "fixtures", "sources-phones-live-2026-11-13.echo.json");
      currentClaim = JSON.parse(fs.readFileSync(fixture, "utf8")).analysis.claim;
      await page.goto(base);
      await page.locator('input[aria-label="Open saved Echo trace file"]').setInputFiles(fixture);
      await page.locator(".how-checked").waitFor({ timeout: 10_000 }).catch(() => undefined);
      const lines = await stripLines();
      const head = (await page.locator(".how-checked-head").textContent().catch(() => "")) ?? "";
      const want = [
        "Plan · Search: Skipped — read 5 supplied links; no web search",
        "Read: 5 of 5 supplied links read — 5 with a reliable date (0.9 s)",
        "Group: 1 claim group — 5 pages about the claim · none off-claim (2.5 s)",
        "Judge: 1 independent origin — 2 confirmed copies (by date or citation) · 2 unclear (7.9 s)",
        "Verify: 6 of 7 answer figures — found in the passages they cite; not found: 18",
        "Answer: Written from 1 independent origin — root pages only; copies and unclear pages left out (2.7 s)",
      ];
      if (JSON.stringify(lines) !== JSON.stringify(want)) fail(`an imported Check these sources trace's strip reads ${JSON.stringify(lines)}`);
      else ok(`an imported Check these sources trace's strip reads "${lines[0]}", then ${lines.slice(1).map((line) => line.split(" — ")[0]).join(" · ")}`);
      if (!head.includes("Stage times from the run’s receipt, 14 s in all.")) fail(`the sources trace's strip heading reads "${head}"`);
      else ok("its heading gives the receipt's stage times, 14 s in all");
    }
    // Readable without sideways scrolling: one or two rows on a laptop, two columns on a phone.
    for (const [width, height, maxRows] of [[1280, 720, 2], [1920, 1080, 2], [390, 844, 4]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(300);
      const fit = await page.evaluate(() => {
        const items = [...document.querySelectorAll(".how-checked-steps li")];
        const smallest = Math.min(...items.map((item) => parseFloat(getComputedStyle(item.querySelector(".how-checked-detail")).fontSize)));
        return { rows: new Set(items.map((item) => Math.round(item.getBoundingClientRect().top))).size, sideways: document.documentElement.scrollWidth > window.innerWidth, clipped: items.some((item) => item.scrollWidth > item.clientWidth + 1), smallest };
      });
      if (fit.sideways || fit.clipped || fit.rows > maxRows || fit.smallest < 11) fail(`at ${width}x${height} the strip does not fit (${JSON.stringify(fit)})`);
      else ok(`at ${width}x${height} the strip fits in ${fit.rows} ${fit.rows === 1 ? "row" : "rows"}, no sideways scroll, text at least ${fit.smallest}px`);
    }
    await page.setViewportSize({ width: 1360, height: 900 });
  }

  // The evidence funnel ("WHAT ECHO PROCESSED"), right under the plain-search box: its stages as the trace counts them
  // (check-readiness counts each by hand), counting up the first time it is in view (at once with reduced motion);
  // "Run details" closed, its one-line summary in view; the source detail's "Page details"; and Present slide 2, the
  // same funnel large ("How Echo searched", or "What Echo read" for supplied links): 7 slides on a slot, 6 on the check.
  process.stdout.write("\nEvidence funnel\n");
  {
    const shots = process.env.ECHO_SMOKE_SHOTS;
    // The count-up lasts 1.1 s plus 90 ms per stage after the first (COUNT_UP_MS, COUNT_UP_STAGGER_MS in the workbench).
    const COUNT_UP_SETTLE_MS = 2_200;
    const funnelRuns = [
      { name: "slot 02", address: "/?slot=02", trace: "/demo-traces/americans-check-phones-96-times.echo.json", slide: "How Echo searched", slides: 7,
        stages: ["10 query variants", "13 searches", "124 search results scanned", "15 distinct pages", "15 pages read", "4 claim groups", "13 pages about the claim", "2 independent origins"],
        headline: "From 124 search results to 2 independent origins", summary: "Tavily · 13 searches · 124 search results · 15 distinct pages · 15 read" },
      { name: "slot 01", address: "/?slot=01", trace: "/demo-traces/humans-use-10-percent-of-brain.echo.json", slide: "How Echo searched", slides: 7,
        stages: ["10 query variants", "5 searches", "50 search results scanned", "20 distinct pages", "20 pages read", "1 claim group", "20 pages about the claim", "8 independent origins"],
        headline: "From 50 search results to 8 independent origins", summary: "Tavily · 5 searches · 50 search results · 20 distinct pages · 20 read" },
      { name: "the saved check", address: `/?trace=${slugOf(SAVED_CHECK_TRACE)}`, trace: SAVED_CHECK_TRACE, slide: "What Echo read", slides: 6,
        stages: ["5 supplied links", "5 links read", "1 claim group", "5 pages about the claim", "3 Claude calls", "1 independent origin"],
        headline: "From 5 supplied links to 1 independent origin", summary: "no web search · 5 supplied links · 5 read · 3 Claude calls" },
    ];
    const readStages = (scope) => page.locator(`${scope} .funnel-stage`).evaluateAll((items) => items.map((item) => `${item.getAttribute("data-value")} ${item.querySelector(".funnel-label")?.textContent ?? ""}`));
    for (const run of funnelRuns) {
      currentClaim = summaryOf(run.trace).claim;
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(`${base}${run.address}`);
      await page.locator(".result-stack .evidence-funnel").waitFor({ timeout: 10_000 }).catch(() => undefined);
      // Count-up: sample the numbers while scrolling the funnel into view; some show less than their final value, then
      // all settle on it.
      const samples = await page.evaluate(async () => {
        const read = () => [...document.querySelectorAll(".result-stack .funnel-stage")].map((item) => ({ shown: Number((item.querySelector("strong")?.textContent ?? "").replace(/,/g, "")), value: Number(item.getAttribute("data-value")) }));
        const seen = [read()];
        document.querySelector(".result-stack .evidence-funnel")?.scrollIntoView({ block: "center" });
        for (let index = 0; index < 50; index += 1) { await new Promise((resolve) => setTimeout(resolve, 50)); seen.push(read()); }
        return seen;
      });
      const partial = samples.some((sample) => sample.some((stage) => stage.value > 1 && stage.shown < stage.value));
      const settled = samples.at(-1).every((stage) => stage.shown === stage.value);
      const stages = await readStages(".result-stack");
      const placement = await page.evaluate(() => {
        const funnel = document.querySelector(".result-stack .evidence-funnel");
        const plain = document.querySelector(".plain-search-line");
        const strip = document.querySelector(".trace-signal-strip");
        const follows = (a, b) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        return { afterPlain: !plain || follows(plain, funnel), beforeStrip: !strip || follows(funnel, strip), sideways: document.documentElement.scrollWidth > window.innerWidth };
      });
      const details = await page.evaluate(() => ({ open: document.querySelector(".result-stack .run-details")?.open ?? null, summary: document.querySelector(".result-stack .run-details-summary")?.textContent ?? "" }));
      const problems = [];
      if (JSON.stringify(stages) !== JSON.stringify(run.stages)) problems.push(`stages read ${JSON.stringify(stages)}`);
      if (!partial || !settled) problems.push(`count-up: partial ${partial}, settled ${settled}`);
      if (!placement.afterPlain || !placement.beforeStrip || placement.sideways) problems.push(`placement ${JSON.stringify(placement)}`);
      if (details.open !== false || !details.summary.endsWith(run.summary)) problems.push(`run details ${JSON.stringify(details)}`);
      // Hovering a stage puts what it counts in the note line.
      await page.locator(".result-stack .funnel-stage").nth(run.slides === 7 ? 2 : 0).hover();
      const note = (await page.locator(".result-stack .funnel-note").textContent().catch(() => "")) ?? "";
      if (run.slides === 7 ? !/Results are not sources\.$/.test(note) : !/Echo ran no web search/.test(note)) problems.push(`hover note "${note}"`);
      // Run details open on a click, every row from the trace.
      await page.locator(".result-stack .run-details > summary").click();
      const rowLabels = await page.locator(".result-stack .run-details-rows dt").allTextContents();
      if (!rowLabels.includes("Run") || !rowLabels.includes("Publisher dates") || !rowLabels.includes("Claude")) problems.push(`run details rows ${JSON.stringify(rowLabels)}`);
      // Page details on the selected page's source detail.
      const pageRows = await page.locator(".map-layout .detail-card .page-details-rows dt").allTextContents();
      const wantRows = run.slides === 7 ? ["Site", "Publisher date", "Text", "First found by"] : ["Site", "Publisher date", "Text", "Supplied as"];
      if (!wantRows.every((label) => pageRows.includes(label)) || !pageRows.includes("Own evidence")) problems.push(`page details rows ${JSON.stringify(pageRows)}`);
      // Present: slide 2 is the funnel, with the same numbers.
      await page.locator(".present-button").click();
      await page.locator(".stage-presentation").waitFor({ timeout: 5_000 });
      const tabs = await page.locator(".stage-progress button").allTextContents();
      if (tabs.length !== run.slides || tabs[1]?.replace(/^\d+/, "") !== run.slide) problems.push(`Present tabs ${JSON.stringify(tabs)}`);
      await page.locator(".stage-progress button").nth(1).click();
      await page.waitForTimeout(COUNT_UP_SETTLE_MS);
      const slideStages = await readStages(".stage-content");
      const slideShown = await page.locator(".stage-content .funnel-stage strong").allTextContents();
      const headline = (await page.locator(".stage-content .stage-funnel-slide h1").textContent().catch(() => "")) ?? "";
      if (JSON.stringify(slideStages) !== JSON.stringify(run.stages) || slideShown.join() !== run.stages.map((stage) => stage.split(" ")[0]).join()) problems.push(`slide 2 stages ${JSON.stringify(slideStages)} showing ${JSON.stringify(slideShown)}`);
      if (headline !== run.headline) problems.push(`slide 2 headline "${headline}"`);
      if (shots) await page.screenshot({ path: path.join(shots, `funnel-slide2-${run.name.replace(/\W+/g, "-")}-1280x720.png`) });
      await page.keyboard.press("Escape");
      await page.locator(".stage-presentation").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
      if (problems.length) fail(`${run.name}'s evidence funnel: ${problems.join("; ")}`);
      else ok(`${run.name}'s evidence funnel reads "${run.stages.join(" → ")}" under the plain-search box, counts up once in view, Run details closed ("…${run.summary}"); Present slide 2 "${run.slide}" of ${run.slides}: "${headline}"`);
    }
    // With reduced motion the numbers show their final values at once (no count-up).
    {
      const reduced = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: "reduce" });
      const still = await reduced.newPage();
      await still.goto(`${base}/?slot=02`);
      await still.locator(".result-stack .evidence-funnel").waitFor({ timeout: 10_000 }).catch(() => undefined);
      const shown = await still.locator(".result-stack .funnel-stage strong").allTextContents();
      await reduced.close();
      if (shown.join() !== funnelRuns[0].stages.map((stage) => stage.split(" ")[0]).join()) fail(`with reduced motion, slot 02's funnel shows ${JSON.stringify(shown)} at first`);
      else ok("with reduced motion, slot 02's funnel shows its final numbers at once");
    }
    await page.setViewportSize({ width: 1360, height: 900 });
  }

  // The trace strip shows the years spanned by reliably dated pages, matching the trace file.
  for (const slot of slots) {
    const analysis = summaryOf(slot.trace);
    const years = analysis.pages.filter((p) => p.publishedDate && p.publishedDateSource && p.publishedDateSource !== "Tavily estimate").map((p) => p.publishedDate.slice(0, 4)).sort();
    if (years.length < 2 || years[0] === years[years.length - 1]) continue;
    const expected = `${years[0]}–${years[years.length - 1]}`;
    currentClaim = analysis.claim;
    await page.locator(`.preset-chip.preset-${slot.id}`).click();
    await waitForText(`${analysis.summary.totalPages} pages`);
    const shownSpan = (await page.locator(".trace-signal-span strong").textContent({ timeout: 5_000 }).catch(() => null))?.trim();
    if (shownSpan !== expected) fail(`slot ${slot.slot}: dated span reads ${shownSpan ?? "nothing"}, expected ${expected}`);
    else ok(`slot ${slot.slot}: shows the dated span ${expected} (${years.length} reliably dated pages)`);
    // The strip's counts in plain words, from the trace; the undated pages and the dated span add up to every page.
    const strip = (await page.locator(".trace-signal-strip").innerText().catch(() => "")).replace(/\s+/g, " ");
    const copies = analysis.pages.filter((p) => p.judgment.kind === "derived").length;
    const possible = analysis.pages.filter((p) => p.judgment.kind === "unclear" && p.judgment.parentId).length;
    const undated = analysis.summary.totalPages - years.length;
    const wantStrip = [
      `${copies} confirmed ${copies === 1 ? "copy" : "copies"} (dated or cited)`,
      `${possible} possible ${possible === 1 ? "copy" : "copies"}, link not confirmed`,
      `${undated} ${undated === 1 ? "page has" : "pages have"} no reliable date`,
    ];
    const missingStrip = wantStrip.filter((text) => !strip.includes(text));
    if (missingStrip.length || /chronology|source paths?|likely echoes|search-estimated/i.test(strip)) fail(`slot ${slot.slot}: the trace strip reads "${strip}"`);
    else ok(`slot ${slot.slot}: the trace strip says "${wantStrip.join("; ")}"`);
    // Its button opens the earliest of those pages where the presenter can see it.
    const earliest = analysis.pages.filter((p) => p.publishedDate && p.publishedDateSource && p.publishedDateSource !== "Tavily estimate").sort((a, b) => a.publishedDate.localeCompare(b.publishedDate))[0];
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(".trace-signal-span button").click();
    const shownDetail = await page.waitForFunction((title) => {
      const heading = document.querySelector(".map-layout .detail-card h3");
      const top = heading?.getBoundingClientRect().top ?? -1;
      return heading?.textContent === title && top >= 0 && top < window.innerHeight;
    }, earliest.title, { timeout: 4_000 }).then(() => true, () => false);
    if (!shownDetail) fail(`slot ${slot.slot}: clicking the dated span does not show the earliest page (${earliest.domain}) on screen`);
    else ok(`slot ${slot.slot}: clicking the dated span shows the earliest dated page (${earliest.domain})`);
  }

  // A trace file whose pages carry a future or unreadable date must not stretch the span to a year nobody saw.
  if (slots[1]) {
    const file = JSON.parse(fs.readFileSync(path.join(root, "public", slots[1].trace), "utf8"));
    const dated = file.analysis.pages.filter((p) => p.publishedDate && p.publishedDateSource && p.publishedDateSource !== "Tavily estimate");
    const realYears = dated.map((p) => p.publishedDate.slice(0, 4)).sort();
    const future = `${new Date().getUTCFullYear() + 5}-05-01`;
    Object.assign(file.analysis.pages.find((p) => !dated.includes(p)) ?? dated[0], { publishedDate: future, publishedDateSource: "page text" });
    Object.assign(dated[dated.length - 1], { publishedDate: "Spring 1999", publishedDateSource: "page metadata" });
    currentClaim = file.analysis.claim;
    await page.locator('input[aria-label="Open saved Echo trace file"]').setInputFiles({ name: "future-dates.echo.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
    await waitForText(`${file.analysis.summary.totalPages} pages`);
    const shownSpan = (await page.locator(".trace-signal-span strong").textContent({ timeout: 3_000 }).catch(() => null))?.trim() ?? "";
    const years = shownSpan.match(/^(\d{4})–(\d{4})$/);
    if (!years || Number(years[2]) > new Date().getUTCFullYear() || years[1] < realYears[0]) fail(`a trace file with a future date (${future}) and an unreadable one ("Spring 1999") shows the span "${shownSpan || "nothing"}"`);
    else ok(`a trace file with a future and an unreadable page date shows only readable past years (${shownSpan})`);
  }

  // A page with verified citations lists them in its details ("Cites N retrieved pages").
  for (const slot of slots) {
    const analysis = summaryOf(slot.trace);
    // A title shared with another page (a co-published release) would make the click ambiguous.
    const uniqueTitle = (candidate) => analysis.pages.filter((other) => other.title.slice(0, 40) === candidate.title.slice(0, 40)).length === 1;
    const citing = analysis.pages.find((candidate) => uniqueTitle(candidate) && candidate.citations?.some((citation) => analysis.pages.some((other) => other.id === citation.pageId)));
    if (!citing) continue;
    currentClaim = analysis.claim;
    await page.locator(`.preset-chip.preset-${slot.id}`).click();
    await waitForText(`${analysis.summary.totalPages} pages`);
    const escaped = citing.title.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await page.getByRole("button", { name: new RegExp(`^(?:Inspect )?${escaped}`) }).first().click();
    const shown = await page.locator(".compare-relationship summary", { hasText: /^Cites \d+ retrieved/ }).first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
    if (shown) ok(`slot ${slot.slot}: ${citing.domain} lists the pages it cites`);
    else fail(`slot ${slot.slot}: ${citing.domain} does not show its citations panel`);
  }

  // Present mode on the first slot: every slide renders, then Esc closes it.
  if (slots[0]) {
    await page.locator(`.preset-chip.preset-${slots[0].id}`).click();
    await page.locator(".present-button").click();
    const stage = page.locator(".stage-presentation");
    await stage.waitFor({ timeout: 5_000 });
    const slideCount = await page.locator(".stage-progress button").count();
    const spanYears = summaryOf(slots[0].trace).pages.filter((p) => p.publishedDate && p.publishedDateSource && p.publishedDateSource !== "Tavily estimate").map((p) => p.publishedDate.slice(0, 4)).sort();
    if (spanYears.length >= 2 && spanYears[0] !== spanYears[spanYears.length - 1]) {
      const spanLine = `Reliably dated pages span ${spanYears[0]}–${spanYears[spanYears.length - 1]}.`;
      if (!(await page.locator(".stage-main").innerText()).includes(spanLine)) fail(`Present mode's first slide lacks "${spanLine}"`);
      else ok(`Present mode's first slide says "${spanLine}"`);
    }
    let blank = 0;
    let spreadDots = -1;
    for (let index = 0; index < slideCount; index += 1) {
      if (!(await page.locator(".stage-main").innerText()).trim()) blank += 1;
      if ((await page.locator(".stage-main h1").first().innerText().catch(() => "")) === "How the claim spread") spreadDots = await page.locator(".stage-main section[aria-label='Watch the echo spread'] circle").count();
      await page.keyboard.press("ArrowRight");
    }
    // On a 1280x720 projector the first slide's note must be on screen, not just in the page.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.keyboard.press("Home");
    for (let index = 0; index < slideCount; index += 1) await page.keyboard.press("ArrowLeft");
    const fits = await page.evaluate(() => {
      const note = document.querySelector(".stage-signal-note")?.getBoundingClientRect();
      const main = document.querySelector(".stage-main")?.getBoundingClientRect();
      return note && main ? { visible: note.bottom <= main.bottom + 1 && note.top >= main.top, note: Math.round(note.bottom), main: Math.round(main.bottom) } : null;
    });
    // The tree is slide 3 since the evidence funnel became slide 2 (11/14); open it by name.
    await page.locator(".stage-progress button", { hasText: "The source tree" }).click();
    await page.waitForTimeout(300);
    const treeFits = await page.evaluate(() => { const content = document.querySelector(".stage-content"); return content ? content.scrollHeight <= content.clientHeight + 2 : false; });
    await page.locator(".stage-progress button").first().click();
    await page.evaluate(() => document.querySelector(".stage-presentation")?.focus({ preventScroll: true }));
    if (!treeFits) fail("at 1280x720 the source-tree slide overflows, so the presenter must scroll the slide as well as the tree");
    else ok("at 1280x720 the source-tree slide fits; only the tree itself scrolls");
    await page.setViewportSize({ width: 1360, height: 900 });
    if (!fits?.visible) fail(`at 1280x720 the first slide's note is cut off (note ends at ${fits?.note}px, slide at ${fits?.main}px)`);
    else ok("at 1280x720 the first slide's verdict, figures and note all fit on screen");
    {
      const live = await page.evaluate(() => {
        const spread = document.querySelector(".stage-presentation section[aria-label='Watch the echo spread']") ?? document.querySelector(".stage-main");
        return { insideLive: Boolean(spread?.closest("[aria-live]:not([aria-live='off'])")), announced: [...document.querySelectorAll(".stage-presentation [aria-live='polite'].sr-only")].map((node) => node.textContent) };
      });
      if (live.insideLive) fail("Present mode's slide content sits inside a live region, so Play re-announces it");
      else if (!live.announced.some((text) => /^Slide \d+ of \d+: /.test(text ?? ""))) fail(`Present mode announces no slide change (${JSON.stringify(live.announced)})`);
      else ok(`Present mode announces slide changes only ("${live.announced[0]}")`);
    }
    {
      // "How it works" in the toolbar opens /how in a new tab and leaves the arrow keys to the slides.
      const how = page.locator(".stage-toolbar-actions a.stage-how-link");
      const attrs = await how.evaluate((node) => ({ href: node.getAttribute("href"), target: node.getAttribute("target"), text: node.textContent?.trim() })).catch(() => null);
      const before = await page.locator(".stage-progress-active").textContent().catch(() => "");
      await how.focus().catch(() => undefined);
      await page.keyboard.press("ArrowRight");
      const after = await page.locator(".stage-progress-active").textContent().catch(() => "");
      await page.keyboard.press("ArrowLeft");
      const [popup] = await Promise.all([page.context().waitForEvent("page", { timeout: 5_000 }).catch(() => null), how.click().catch(() => undefined)]);
      const opened = popup ? new URL(popup.url()).pathname : null;
      await popup?.close();
      const stillOpen = await page.locator(".stage-presentation").count();
      if (attrs?.href !== "/how" || attrs?.target !== "_blank" || opened !== "/how" || before === after || !stillOpen) fail(`Present's How it works link: ${JSON.stringify(attrs)}, opened ${opened}, arrow moved ${before} → ${after}, stage open ${stillOpen}`);
      else ok(`Present's toolbar "${attrs.text}" opens /how in a new tab; with it focused, → still changes slide; the presentation stays open`);
    }
    if (spreadDots < 1) fail(`Present mode has no "How the claim spread" slide with dots (${spreadDots})`);
    else ok(`Present mode's "How the claim spread" slide draws ${spreadDots} dated pages`);
    await page.keyboard.press("Escape");
    await stage.waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
    if (!slideCount) fail("Present mode shows no slides");
    else if (blank) fail(`Present mode: ${blank} of ${slideCount} slides are empty`);
    else if (await stage.count()) fail("Present mode did not close on Esc");
    else ok(`Present mode: ${slideCount} slides render, Esc closes it`);
  }

  // Plain search vs Echo: the first (plain-claim) query's results, followed to their roots, under the verdict and on
  // Present slide 1, which must still fit a 1280x720 projector without scrolling.
  process.stdout.write("\nPlain search vs Echo\n");
  {
    for (const entry of [...slots, ...backups]) {
      const analysis = summaryOf(entry.trace);
      const slug = entry.trace.split("/").pop().replace(/\.echo\.json$/, "");
      const want = expectedLines[slug];
      const isSlot = slots.includes(entry);
      const name = isSlot ? `slot ${entry.slot}` : `backup "${entry.label}"`;
      currentClaim = analysis.claim;
      await page.goto(`${base}/${isSlot ? `?slot=${entry.slot}` : `?trace=${slug}`}`);
      await waitForText(`${analysis.summary.totalPages} pages`);
      const shown = await page.evaluate(() => {
        const box = document.querySelector(".plain-search-line");
        const verdict = document.querySelector(".verdict-banner")?.getBoundingClientRect();
        const rect = box?.getBoundingClientRect();
        return {
          primary: box?.querySelector(".plain-search-primary")?.textContent ?? "",
          detail: box?.querySelector(".plain-search-detail")?.textContent ?? "",
          all: box?.textContent ?? "",
          separated: Boolean(box?.querySelector(".plain-search-label + .sr-only")),
          tooltip: box?.getAttribute("title") ?? "",
          below: Boolean(verdict && rect && rect.top >= verdict.bottom - 1 && rect.height > 10),
        };
      });
      const problems = [];
      if (!want) problems.push(`no expected wording for ${slug}`);
      else {
        if (shown.primary !== want.primary) problems.push(`primary "${shown.primary}"`);
        if (want.detail && shown.detail !== want.detail) problems.push(`detail "${shown.detail}"`);
      }
      if (/\bmatch|\bthe web\b|\breally\b|\bproof\b/i.test(shown.all)) problems.push(`forbidden word in "${shown.all}"`);
      if (!shown.separated) problems.push("label runs into the sentence for screen readers");
      if (!shown.tooltip.startsWith("Plain search is the trace's first Tavily search, the claim as typed: “") || !shown.tooltip.includes(analysis.searchAudit[0].query)) problems.push(`tooltip "${shown.tooltip}"`);
      if (!shown.below) problems.push("not under the verdict");
      if (await page.locator(".cost-receipt-line").count()) problems.push("a bundled run shows a cost line, but it has no receipt");
      if (problems.length) fail(`${name}: plain-search line: ${problems.join("; ")}`);
      else ok(`${name}: under the verdict, "${shown.primary}"`);
      {
        // How the page count adds up, under the verdict: the numbers sum to the total, each from the trace file.
        const roots = analysis.roots.length;
        const copies = analysis.pages.filter((p) => p.judgment.kind === "derived").length;
        const unclear = analysis.pages.filter((p) => p.judgment.kind === "unclear").length;
        const line = await page.evaluate(() => {
          const node = document.querySelector(".verdict-banner .page-breakdown-line");
          const rect = node?.getBoundingClientRect();
          const banner = document.querySelector(".verdict-banner")?.getBoundingClientRect();
          return { text: node?.textContent ?? "", inside: Boolean(rect && banner && rect.height > 0 && rect.left >= banner.left - 1 && rect.right <= banner.right + 1 && rect.bottom <= banner.bottom + 1), clipped: node ? node.scrollWidth > node.clientWidth + 1 : true };
        });
        const sums = roots + copies + unclear === analysis.summary.totalPages;
        if (line.text !== want?.breakdown || !sums || !line.inside || line.clipped) fail(`${name}: breakdown line "${line.text}" (${roots}+${copies}+${unclear} of ${analysis.summary.totalPages}; inside ${line.inside}, clipped ${line.clipped})`);
        else ok(`${name}: under the verdict, "${line.text}"`);
        // The verdict sentence, word for word (the singular "1 relationship remains" fix must not touch these plurals).
        const verdictLine = (await page.locator(".verdict-banner .verdict-copy p").first().textContent().catch(() => "")) ?? "";
        if (verdictLine !== want?.verdict) fail(`${name}: the verdict reads "${verdictLine}", expected "${want?.verdict}"`);
        else ok(`${name}: the verdict reads "${verdictLine}"`);
        // The spread counts root pages, so it agrees with the breakdown (it used to say "3 origins" on the phones run).
        const spreadCounts = (await page.locator(".result-stack section[aria-label='Watch the echo spread'] p").first().textContent({ timeout: 2_000 }).catch(() => null)) ?? "";
        const datedRoots = analysis.pages.filter((p) => p.judgment.kind === "origin" && p.publishedDate && p.publishedDateSource && p.publishedDateSource !== "Tavily estimate").length;
        if (spreadCounts && !spreadCounts.trim().startsWith(`${datedRoots} ${datedRoots === 1 ? "root page" : "root pages"} · `)) fail(`${name}: the spread's counts read "${spreadCounts.trim()}"`);
        else if (spreadCounts) ok(`${name}: the spread counts "${spreadCounts.trim()}"`);
      }
      if (!isSlot) continue;

      await page.setViewportSize({ width: 1280, height: 720 });
      const verdictTiles = await page.locator(".verdict-stats").innerText().catch(() => "");
      await page.locator(".present-button").click();
      await page.locator(".stage-presentation").waitFor({ timeout: 5_000 });
      const stagePrimary = await page.locator(".stage-plain-search .plain-search-primary").textContent({ timeout: 3_000 }).catch(() => "");
      if (want?.stage && !stagePrimary?.endsWith(want.stage)) fail(`${name} Present slide 1 says "${stagePrimary}", not "…${want.stage}"`);
      // One name for the independence count on every surface: "independent origin(s)", and "with own evidence".
      const tiles = { stage: await page.locator(".stage-metrics").innerText().catch(() => ""), verdict: verdictTiles };
      const originTile = `${analysis.summary.independentOrigins}\nindependent ${analysis.summary.independentOrigins === 1 ? "origin" : "origins"}`;
      const evidenceTile = `${analysis.summary.verifiableOrigins}\nwith own evidence`;
      const retired = RETIRED_COPY;
      const badTiles = Object.entries(tiles).filter(([, text]) => !text.includes(originTile) || !text.includes(evidenceTile) || retired.test(text));
      if (badTiles.length) fail(`${name}: figure tiles read ${JSON.stringify(Object.fromEntries(badTiles))}, not "${originTile.replace("\n", " ")}" and "${evidenceTile.replace("\n", " ")}"`);
      else ok(`${name}: Present slide 1 and the verdict tiles say "${originTile.replace("\n", " ")}" and "${evidenceTile.replace("\n", " ")}"`);
      const fit = await page.evaluate(() => {
        const content = document.querySelector(".stage-content");
        const box = (selector) => document.querySelector(selector)?.getBoundingClientRect() ?? null;
        const [frame, plain, metrics, note, breakdown] = [content?.getBoundingClientRect(), box(".stage-plain-search"), box(".stage-metrics"), box(".stage-signal-note"), box(".stage-breakdown-line")];
        if (!content || !frame || !plain || !metrics || !note || !breakdown) return null;
        const inside = (rect) => rect.top >= frame.top - 1 && rect.bottom <= frame.bottom + 1 && rect.right <= frame.right + 1;
        return { breakdown: document.querySelector(".stage-breakdown-line")?.textContent ?? "", breakdownInside: inside(breakdown) && breakdown.top >= metrics.bottom - 1, scrolls: content.scrollHeight > content.clientHeight + 2, plainInside: inside(plain), noteInside: inside(note), clearOfMetrics: plain.top >= metrics.bottom - 1 && note.top >= plain.bottom - 1, detail: [...document.querySelectorAll(".stage-plain-search .plain-search-detail")].some((node) => getComputedStyle(node).display !== "none"), plainBottom: Math.round(plain.bottom), noteBottom: Math.round(note.bottom), frameBottom: Math.round(frame.bottom) };
      });
      await page.keyboard.press("Escape");
      await page.locator(".stage-presentation").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
      await page.setViewportSize({ width: 1360, height: 900 });
      if (!fit || fit.scrolls || !fit.plainInside || !fit.noteInside || !fit.clearOfMetrics || !fit.breakdownInside || fit.breakdown !== want?.breakdown) fail(`${name} Present slide 1 at 1280x720: ${JSON.stringify(fit)}`);
      else ok(`${name} Present slide 1 at 1280x720: plain-search line${fit.detail ? " and its detail" : ""}, the breakdown and the note on screen, below the figures, no scrolling (note ends ${fit.noteBottom}/${fit.frameBottom} px)`);
    }
    // A trace without a search audit (older or hand-made files) shows no line rather than a made-up one.
    const stripped = JSON.parse(fs.readFileSync(path.join(root, "public", slots[0].trace), "utf8"));
    delete stripped.analysis.searchAudit;
    currentClaim = stripped.analysis.claim;
    await page.locator(".new-claim-button", { hasText: "New trace" }).click().catch(() => undefined);
    await page.locator('input[aria-label="Open saved Echo trace file"]').setInputFiles({ name: "no-audit.echo.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(stripped)) });
    const opened = await waitForText(`${stripped.analysis.summary.totalPages} pages`);
    const shown = await page.locator(".plain-search-line").count();
    if (!opened || shown) fail(`a trace without a search audit: opened ${opened}, plain-search line shown ${shown}`);
    else ok("a trace without a search audit shows no plain-search line");
    await page.goto(base);
  }

  // Every Present slide, for both slots, on the two common projector sizes and on a 720p projector with the browser
  // bar showing (1280x600): the slide itself never scrolls (only its designated inner boxes, like the tree, may), and
  // the controls a presenter needs are on screen and not covered. Slide 1's plain-search line stays above the fold.
  // The backup runs get the same fit pass (a stage fallback; their four roots once ran off slide 5 at 1280x720), and
  // the slots also at 1280x700, a laptop's browser window between the 720 and 660 px layouts, and 1920x1080 (a 1080p
  // projector in Full screen). The source tree fills the space its slide leaves, so it shows at least this many whole
  // rows of pages (on slot 02 at 1280x720: Asurion → Fox 13 → church blog, PR Newswire → KABC, and the reference page).
  process.stdout.write("\nPresent mode on projector sizes\n");
  const treeRowsAt = { 600: 2, 700: 3, 720: 3, 768: 3, 1080: 5 };
  const presentRuns = [
    ...slots.map((slot) => ({ ...slot, name: `slot ${slot.slot}`, address: `/?slot=${slot.slot}` })),
    ...backups.map((backup) => ({ ...backup, name: `backup "${backup.label}"`, address: `/?trace=${slugOf(backup.trace)}` })),
  ];
  for (const [width, height] of [[1280, 720], [1366, 768], [1280, 600], [1280, 700], [1920, 1080]]) {
    for (const slot of presentRuns.filter((run) => run.slot || height !== 700)) {
      const analysis = summaryOf(slot.trace);
      currentClaim = analysis.claim;
      await page.setViewportSize({ width, height });
      await page.goto(`${base}${slot.address}`);
      await waitForText(`${analysis.summary.totalPages} pages`);
      const problems = [];
      const resultCaptions = await page.evaluate(() => window.__echoCaptionsUnderCards(document.querySelector(".result-stack .source-tree-explorer") ?? document.body));
      if (!resultCaptions.count || resultCaptions.covered.length) problems.push(`result page tree: ${resultCaptions.covered.length} of ${resultCaptions.count} link captions overlap a page card (${resultCaptions.covered.slice(0, 3).join("; ")})`);
      if (resultCaptions.astray.length) problems.push(`result page tree: ${resultCaptions.astray.length} link captions sit away from the page their link points to (${resultCaptions.astray.slice(0, 3).join("; ")})`);
      const resultStruck = await page.evaluate(() => window.__echoCaptionsStruck(document.querySelector(".result-stack .source-tree-explorer") ?? document.body));
      if (resultStruck.struck.length) problems.push(`result page tree: ${resultStruck.struck.length} link captions are struck through by a curve (${resultStruck.struck.slice(0, 3).join("; ")})`);
      // QA #4: the tree tags one ORIGIN per independent origin (roots published together: the first ORIGIN, the others
      // SAME RELEASE), and its key reads the same here and on slide 3, with the percent line explaining the captions.
      const resultKey = await page.evaluate(() => ({
        tags: [...document.querySelectorAll(".result-stack .source-tree-explorer .node-tag")].map((tag) => tag.textContent ?? ""),
        legend: document.querySelector(".result-stack .tree-legend")?.textContent ?? "",
        percent: document.querySelector(".result-stack .tree-key-percent")?.textContent ?? "",
        captions: [...document.querySelectorAll(".result-stack .edge-caption")].map((caption) => caption.firstChild?.textContent ?? ""),
        cites: document.querySelectorAll(".result-stack .source-node .node-cite").length,
      }));
      const wantSame = analysis.roots.length - analysis.summary.independentOrigins;
      const tagCount = (tags, word) => tags.filter((tag) => tag === word).length;
      if (tagCount(resultKey.tags, "ORIGIN") !== analysis.summary.independentOrigins || tagCount(resultKey.tags, "SAME RELEASE") !== wantSame) problems.push(`result page tree tags ${tagCount(resultKey.tags, "ORIGIN")} ORIGIN and ${tagCount(resultKey.tags, "SAME RELEASE")} SAME RELEASE for ${analysis.summary.independentOrigins} independent origins from ${analysis.roots.length} root pages`);
      // Round 11: an unclear page's tag reads UNCLEAR, as the key says "Unclear relationship" (it read UNRESOLVED).
      const wantUnclear = analysis.pages.filter((entry) => entry.judgment.kind === "unclear").length;
      const otherTags = resultKey.tags.filter((tag) => !["ORIGIN", "SAME RELEASE", "UNCLEAR"].includes(tag));
      // A search result's cards carry no supplied-link number (only a supplied-sources result's do).
      if (resultKey.cites) problems.push(`result page tree: ${resultKey.cites} cards show a supplied-link number on a search result`);
      if (tagCount(resultKey.tags, "UNCLEAR") !== wantUnclear || otherTags.length) problems.push(`result page tree tags ${tagCount(resultKey.tags, "UNCLEAR")} UNCLEAR for ${wantUnclear} unclear pages${otherTags.length ? `, and ${JSON.stringify([...new Set(otherTags)])}` : ""}`);
      // QA #3: the selected root of a co-published pair shows Echo's pair note above its saved evidence (slot 02:
      // asurion.com, selected when the run opens), on the result page and in slide 3's strip.
      const wantPairNote = slot.slot === "02" ? "Published together with prnewswire.com: Echo counts them as one independent origin." : null;
      const resultPairNote = await page.evaluate(() => document.querySelector(".map-layout .detail-card .co-published-note")?.textContent ?? null);
      if (resultPairNote !== wantPairNote) problems.push(`result page detail card: pair note ${JSON.stringify(resultPairNote)}, expected ${JSON.stringify(wantPairNote)}`);
      // Round 11: a co-published root counts its group's echoes once each. On slot 02 Asurion's own links already reach
      // all 4 (Fox 13, the church blog, KABC, the reference page), so it stays 4 with no "(including …)" note, and its
      // same-release PR Newswire row in the root ledger shows the same 4, noting they include asurion.com's.
      if (slot.slot === "02") {
        const reach = await page.evaluate(() => ({
          count: document.querySelector(".map-layout .detail-card .source-reach-count > strong")?.textContent ?? "",
          together: document.querySelector(".map-layout .detail-card .source-reach-together")?.textContent ?? null,
          ledger: Object.fromEntries([...document.querySelectorAll(".root-ledger-list button")].map((button) => [
            `${button.querySelector(".root-ledger-source small")?.textContent?.split(" · ")[0] ?? ""} ${button.querySelector(".root-ledger-source strong")?.textContent?.slice(0, 24) ?? ""}`,
            [...button.querySelectorAll(":scope > span:nth-child(3) small")].map((small) => small.textContent).join(" "),
          ])),
        }));
        const prRow = Object.entries(reach.ledger).find(([key]) => key.startsWith("prnewswire.com"))?.[1];
        const asurionRows = Object.entries(reach.ledger).filter(([key]) => key.startsWith("asurion.com")).map(([, value]) => value);
        if (reach.count !== "4" || reach.together !== null || prRow !== "4 likely downstream echoes (including asurion.com's, published together)" || !asurionRows.includes("4 likely downstream echoes")) problems.push(`slot 02 downstream spread: ${JSON.stringify(reach)}`);
        else if (width === 1280 && height === 720) ok(`slot 02: Asurion's source detail still counts 4 likely downstream echoes with no partner note; the ledger's PR Newswire row reads "${prRow}"`);
      }
      const percentShown = resultKey.percent.match(/^(\d+)% on a link = Claude's confidence in it \(its own estimate, not measured\)$/);
      if (!percentShown || !resultKey.captions.includes(`${percentShown[1]}%`)) problems.push(`result page tree key: the percent line reads "${resultKey.percent}" (captions ${resultKey.captions.join(", ")})`);
      await page.locator(".present-button").click();
      await page.locator(".stage-presentation").waitFor({ timeout: 5_000 });
      const count = await page.locator(".stage-progress button").count();
      // Opening Present focuses the stage itself, so no focus ring sits on Full screen through the slides.
      const focused = await page.evaluate(() => document.activeElement?.className ?? "");
      if (focused !== "stage-presentation") problems.push(`opening Present focuses "${focused}", not the stage`);
      // Cited sources are told apart: two roots on one domain get a short title each, on slide 6 and on the result page.
      if (slot.slot && width === 1280 && height === 720) {
        const labels = await page.evaluate(() => ({
          result: [...document.querySelectorAll(".result-stack .source-chip")].map((node) => node.textContent?.trim() ?? ""),
        }));
        const cited = analysis.answerSourceIds.length;
        const distinct = (list) => new Set(list.map((text) => text.replace(/^\[\d+\]\s*/, ""))).size === list.length;
        if (labels.result.length !== cited || !distinct(labels.result)) fail(`${slot.name}: the answer's source chips read ${JSON.stringify(labels.result)}`);
        else ok(`${slot.name}: the answer's ${cited} source ${cited === 1 ? "chip reads" : "chips read"} ${labels.result.map((text) => `"${text}"`).join(", ").slice(0, 160)}`);
        // The takeaway is slide 6 since the evidence funnel became slide 2 (11/14); open it by name.
        await page.locator(".stage-progress button", { hasText: "The takeaway" }).click();
        const slideLabels = await page.evaluate(() => [...document.querySelectorAll(".stage-content .stage-source-links > a, .stage-content .stage-source-links > span:not(:first-child)")].map((node) => node.textContent?.trim() ?? ""));
        if (slideLabels.length !== cited || !distinct(slideLabels) || slideLabels.some((text, index) => !text.startsWith(`[${index + 1}] `))) fail(`${slot.name}: slide 6's source buttons read ${JSON.stringify(slideLabels)}`);
        else ok(`${slot.name}: slide 6's ${cited} source buttons are told apart (${slideLabels.slice(0, 2).map((text) => `"${text}"`).join(", ")}${cited > 2 ? ", …" : ""})`);
        // Slide 6 shows links, not page dates, so its caveat must not point at dates.
        const caveat = (await page.locator(".stage-content .stage-takeaway-slide .stage-caveat").innerText().catch(() => "")).trim();
        if (!caveat || /\bdates?\b/i.test(caveat)) fail(`${slot.name}: slide 6's caveat reads "${caveat}"`);
        else ok(`${slot.name}: slide 6's caveat names only what the slide shows ("${caveat.slice(0, 50)}…")`);
        // QA #7: slide 6, its slide tabs and footer say "origins", not "root sources" or another retired name. Text that
        // comes from the saved trace (the answer, what the echoes added, the cited pages' labels; marked data-trace-text)
        // is skipped: slot 01's answer is frozen in its bundled trace and still says "primary evidence" and
        // "candidate-root", which is Lucas's call, not a copy fix.
        const slideCopy = await page.evaluate(() => {
          const stage = document.querySelector(".stage-presentation")?.cloneNode(true);
          if (!stage) return "";
          for (const node of stage.querySelectorAll("[data-trace-text]")) node.remove();
          return stage.textContent ?? "";
        });
        const retiredOnSlide = slideCopy.match(RETIRED_COPY);
        if (!slideCopy.includes("ORIGINS CITED") || retiredOnSlide) fail(`${slot.name}: slide 6 reads "${retiredOnSlide?.[0] ?? "no ORIGINS CITED label"}"`);
        else ok(`${slot.name}: slide 6's own copy (label "ORIGINS CITED", tabs, footer) uses no retired name`);
        await page.locator(".stage-progress button").nth(0).click();
      }
      // Slide 1's note names possible copies only when there are some ("0 possible copies are not counted" reads as a glitch).
      if (slot.slot && width === 1280 && height === 720) {
        const noteText = (await page.locator(".stage-signal-note").innerText().catch(() => "")).trim();
        const wantPossible = analysis.pages.filter((p) => p.judgment.kind === "unclear" && p.judgment.parentId).length;
        if (/\b0 possible/.test(noteText) || (wantPossible > 0) !== /possible cop/.test(noteText)) fail(`${slot.name}'s first-slide note reads "${noteText}" with ${wantPossible} possible copies`);
        else ok(`${slot.name}'s first-slide note: "${noteText}"`);
      }      for (let index = 0; index < count; index += 1) {
        await page.locator(".stage-progress button").nth(index).click();
        await page.waitForTimeout(250);
        const check = await page.evaluate(() => {
          const name = document.querySelector(".stage-progress-active")?.textContent?.replace(/^\d+/, "") ?? "?";
          const content = document.querySelector(".stage-content");
          const scrolls = content ? content.scrollHeight > content.clientHeight + 2 || content.scrollWidth > content.clientWidth + 2 : true;
          const reachable = (element) => {
            if (!element) return "missing";
            const rect = element.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) return "hidden";
            if (rect.top < 0 || rect.left < 0 || rect.bottom > window.innerHeight || rect.right > window.innerWidth) return `off screen (${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)})`;
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return hit && (hit === element || element.contains(hit)) ? "" : `covered by ${hit?.className || hit?.tagName || "nothing"}`;
          };
          const nav = [...document.querySelectorAll(".stage-nav-buttons button")];
          const controls = {
            Previous: nav.find((button) => button.textContent?.includes("Previous")),
            Next: nav.find((button) => button.textContent?.includes("Next")),
            "Full screen": [...document.querySelectorAll(".stage-toolbar-actions button")].find((button) => /Full screen/.test(button.textContent ?? "")),
          };
          const spread = document.querySelector(".stage-content section[aria-label='Watch the echo spread']");
          if (spread) controls.Play = spread.querySelector("button");
          const blocked = Object.entries(controls).map(([label, element]) => [label, reachable(element)]).filter(([, why]) => why);
          // The takeaway's answer may scroll inside its box only as a fallback; on these sizes all of it must show.
          const answer = document.querySelector(".stage-content .stage-answer");
          const answerCut = answer ? answer.scrollHeight - answer.clientHeight > 2 : false;
          // "Check the roots": one numbered item per origin, every item on screen, the list itself not scrolling.
          const list = document.querySelector(".stage-content .stage-root-list");
          const frame = content?.getBoundingClientRect();
          const items = list ? [...list.querySelectorAll(":scope > li")] : [];
          const roots = list ? {
            items: items.length,
            numbers: items.map((item) => item.querySelector(".stage-root-index")?.textContent ?? ""),
            listScrolls: list.scrollHeight > list.clientHeight + 2,
            offFrame: items.filter((item) => { const rect = item.getBoundingClientRect(); return !frame || rect.top < frame.top - 1 || rect.bottom > frame.bottom + 1 || rect.right > frame.right + 1; }).length,
            together: items.map((item) => item.querySelector(".stage-root-domain")?.textContent ?? "").filter((text) => text.includes("published together, counted as one origin")),
            estimated: items.map((item) => item.querySelector(".stage-root-domain")?.textContent ?? "").filter((text) => text.includes("date: search estimate")).length,
            footnote: /No source found/.test(content?.textContent ?? ""),
          } : null;
          const label = document.querySelector(".stage-accuracy-slide .stage-echo-contribution > span")?.textContent ?? null;
          const runsLine = document.querySelector(".stage-accuracy-slide .stage-runs-line")?.textContent ?? null;
          const plain = content?.querySelector(".stage-claim-slide .stage-plain-search")?.getBoundingClientRect();
          const plainCut = plain && frame ? (plain.height < 1 || plain.bottom > frame.bottom + 1 ? `${Math.round(plain.bottom)} > ${Math.round(frame.bottom)}` : "") : "";
          // The source tree: which pages show whole inside the tree box, without scrolling it. Layout offsets, not screen
          // boxes, so the cards' arrival animation (a small slide-in) cannot shift the count.
          const treeBox = content?.querySelector(".stage-tree-slide .tree-scroll");
          const whole = treeBox ? [...treeBox.querySelectorAll(".source-node")].filter((node) => node.offsetTop >= treeBox.scrollTop && node.offsetTop + node.offsetHeight <= treeBox.scrollTop + treeBox.clientHeight + 1
            && node.offsetLeft >= treeBox.scrollLeft && node.offsetLeft + node.offsetWidth <= treeBox.scrollLeft + treeBox.clientWidth + 1) : null;
          const tree = whole ? { rows: new Set(whole.map((node) => node.offsetTop)).size, domains: whole.map((node) => node.querySelector(".node-domain")?.textContent ?? ""), height: treeBox.clientHeight } : null;
          const captions = treeBox ? window.__echoCaptionsUnderCards(treeBox) : null;
          const struck = treeBox ? window.__echoCaptionsStruck(treeBox).struck : [];
          const key = treeBox ? {
            tags: [...treeBox.querySelectorAll(".node-tag")].map((tag) => tag.textContent ?? ""),
            legend: content.querySelector(".stage-tree-legend")?.textContent ?? "",
            percent: content.querySelector(".tree-key-percent")?.textContent ?? "",
            pairNote: content.querySelector(".stage-selection .co-published-note")?.textContent?.trim() ?? null,
            cites: treeBox.querySelectorAll(".source-node .node-cite").length,
          } : null;
          // The detail strip under the tree describes the selected page, so that page must be one of the cards in view.
          const picked = treeBox?.querySelector(".source-node.node-selected");
          const selectedShown = treeBox ? Boolean(picked && whole?.includes(picked)) || (picked?.querySelector(".node-domain")?.textContent ?? "none") : true;
          return { name, scrolls, overflow: content ? content.scrollHeight - content.clientHeight : null, blocked, answerCut, roots, label, runsLine, plainCut, tree, captions, struck, key, selectedShown };
        });
        if (check.roots) {
          const want = analysis.summary.independentOrigins;
          const coPublished = (analysis.coPublishedRootGroups ?? []).filter((group) => group.length > 1).length;
          const numbers = Array.from({ length: want }, (_, index) => String(index + 1).padStart(2, "0"));
          if (check.roots.items !== want || check.roots.numbers.join() !== numbers.join()) problems.push(`"${check.name}": ${check.roots.items} items numbered ${check.roots.numbers.join(",")}, not ${want} origins`);
          if (check.roots.listScrolls || check.roots.offFrame) problems.push(`"${check.name}": the root list is cut off (scrolls ${check.roots.listScrolls}, ${check.roots.offFrame} items off the slide)`);
          if (check.roots.together.length !== coPublished) problems.push(`"${check.name}": ${check.roots.together.length} items say "published together", expected ${coPublished}`);
          if (check.roots.footnote) problems.push(`"${check.name}": the orphan "No source found" footnote is back`);
          // A root dated only by a search estimate says so instead of showing the guess as its date, so this slide never
          // dates more pages than the spread slide counts. (Roots published together are left out: a twin may be dated.)
          const twins = new Set((analysis.coPublishedRootGroups ?? []).filter((group) => group.length > 1).flat());
          const estimatedRoots = analysis.pages.filter((entry) => analysis.roots.includes(entry.id) && !twins.has(entry.id) && entry.publishedDate && entry.publishedDateSource === "Tavily estimate").length;
          if (check.roots.estimated !== estimatedRoots) problems.push(`"${check.name}": ${check.roots.estimated} roots say "date: search estimate", expected ${estimatedRoots}`);
          if (width === 1280 && height === 720 && !problems.length) ok(`${slot.name} "Check the roots": ${want} numbered ${want === 1 ? "origin" : "origins"} for ${analysis.roots.length} root pages${coPublished ? ` (${check.roots.together[0]})` : ""}, ${estimatedRoots} dated only by a search estimate and labeled so, all on screen at 1280x720`);
        }
        if (check.label !== null) {
          const disagreements = DEMO_SCORES[slot.trace]?.disagreements ?? [];
          const sameKind = disagreements.every((entry) => entry.expected.split(" ")[0] === entry.observed.split(" ")[0]);
          const wantLabel = sameKind ? "SAME CALL, DIFFERENT PARENT" : "WHERE ECHO DISAGREES WITH THE LABELS";
          if (check.label !== wantLabel) problems.push(`"${check.name}": the disagreement box is headed "${check.label}", not "${wantLabel}"`);
          if (check.runsLine && /Nov 12 fixes/.test(check.runsLine)) problems.push(`"${check.name}": the runs line still says "before the Nov 12 fixes"`);
          if (width === 1280 && height === 720 && !problems.length) ok(`${slot.name} "How we checked": headed "${check.label}"${check.runsLine ? `; "${check.runsLine.slice(0, 60)}…"` : ""}`);
        }
        if (check.selectedShown !== true) problems.push(`"${check.name}": the detail strip describes ${check.selectedShown}, which is not in view in the tree`);
        if (check.captions && (!check.captions.count || check.captions.covered.length)) problems.push(`"${check.name}": ${check.captions.covered.length} of ${check.captions.count} link captions overlap a page card (${check.captions.covered.slice(0, 3).join("; ")})`);
        if (check.captions?.astray.length) problems.push(`"${check.name}": ${check.captions.astray.length} link captions sit away from the page their link points to (${check.captions.astray.slice(0, 3).join("; ")})`);
        if (check.key) {
          if (tagCount(check.key.tags, "ORIGIN") !== analysis.summary.independentOrigins || tagCount(check.key.tags, "SAME RELEASE") !== wantSame) problems.push(`"${check.name}": the tree tags ${tagCount(check.key.tags, "ORIGIN")} ORIGIN and ${tagCount(check.key.tags, "SAME RELEASE")} SAME RELEASE for ${analysis.summary.independentOrigins} independent origins`);
          if (check.key.cites) problems.push(`"${check.name}": ${check.key.cites} cards show a supplied-link number on a search result`);
          if (tagCount(check.key.tags, "UNCLEAR") !== wantUnclear || check.key.tags.some((tag) => !["ORIGIN", "SAME RELEASE", "UNCLEAR"].includes(tag))) problems.push(`"${check.name}": the tree tags ${JSON.stringify(check.key.tags)}, expected ${wantUnclear} UNCLEAR for the unclear pages`);
          if (check.key.pairNote !== wantPairNote) problems.push(`"${check.name}": the detail strip's pair note is ${JSON.stringify(check.key.pairNote)}, expected ${JSON.stringify(wantPairNote)}`);
          if (check.key.legend !== resultKey.legend || check.key.percent !== resultKey.percent) problems.push(`"${check.name}": the tree key reads "${check.key.legend}" / "${check.key.percent}", the result page "${resultKey.legend}" / "${resultKey.percent}"`);
          if (width === 1280 && height === 720 && slot.slot === "02") ok(`${slot.name} "${check.name}": ${tagCount(check.key.tags, "ORIGIN")} ORIGIN + ${tagCount(check.key.tags, "SAME RELEASE")} SAME RELEASE tags beside ${analysis.summary.independentOrigins} independent origins; key "${check.key.legend}" and "${check.key.percent}", as on the result page`);
        }
        if (check.struck.length) problems.push(`"${check.name}": ${check.struck.length} link captions are struck through by a curve (${check.struck.slice(0, 3).join("; ")})`);
        if (check.tree) {
          const wantRows = treeRowsAt[height] ?? 1;
          if (check.tree.rows < wantRows) problems.push(`"${check.name}": the tree shows ${check.tree.rows} whole rows of pages in its ${check.tree.height}px box, fewer than ${wantRows}`);
          // DEMO_DAY's slide-2 beat: on slot 02 at 1280x720, KABC and the reference page citing "Asurion (2019)" show unscrolled.
          if (slot.slot === "02" && width === 1280 && height === 720) {
            const missing = ["asurion.com", "fox13seattle.com", "kabc.com", "narcissusandthechild.com"].filter((domain) => !check.tree.domains.includes(domain));
            if (missing.length) problems.push(`"${check.name}": ${missing.join(", ")} not wholly visible in the tree at 1280x720`);
            else ok(`${slot.name} "${check.name}" at 1280x720: ${check.tree.rows} whole rows in a ${check.tree.height}px tree, Asurion → Fox 13, KABC and the reference page in view without scrolling the tree`);
          }
        }
        if (check.scrolls) problems.push(`"${check.name}" slide scrolls by ${check.overflow}px`);
        for (const [label, why] of check.blocked) problems.push(`"${check.name}": ${label} ${why}`);
        if (check.answerCut) problems.push(`"${check.name}": the answer is cut off inside its box`);
        if (check.plainCut) problems.push(`"${check.name}": the plain-search line falls below the slide (bottom ${check.plainCut})`);
      }
      // QA round 6 (S3-1): a mouse click on Full screen left the focus on the button, so the next arrow key made Chrome
      // draw the keyboard focus ring on "Exit full screen" through every slide. A click hands the focus to the stage;
      // Enter on the focused button keeps it there (keyboard users stay put).
      if (slot.slot === "02" && width === 1920) {
        const fullScreenRing = () => page.evaluate(() => {
          const button = [...document.querySelectorAll(".stage-toolbar-actions button")].find((node) => /full screen/i.test(node.textContent ?? ""));
          return { ring: Boolean(button?.matches(":focus-visible")), focusOnButton: document.activeElement === button };
        });
        await page.locator(".stage-toolbar-actions button", { hasText: /Full screen/ }).click();
        await page.waitForTimeout(400);
        await page.keyboard.press("ArrowRight");
        const clicked = await fullScreenRing();
        await page.evaluate(() => document.fullscreenElement ? document.exitFullscreen() : undefined).catch(() => undefined);
        await page.locator(".stage-toolbar-actions button", { hasText: /Full screen/ }).focus();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(400);
        const keyed = await fullScreenRing();
        await page.evaluate(() => document.fullscreenElement ? document.exitFullscreen() : undefined).catch(() => undefined);
        if (clicked.ring || clicked.focusOnButton) problems.push(`after a click on Full screen and →, the focus ring sits on the full-screen button (${JSON.stringify(clicked)})`);
        else if (!keyed.focusOnButton) problems.push(`Enter on Full screen moved the focus off the button (${JSON.stringify(keyed)})`);
        else ok(`${slot.name}: a click on Full screen then → leaves no focus ring on the button; Enter on it keeps the focus there`);
      }
      await page.keyboard.press("Escape");
      await page.locator(".stage-presentation").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
      if (problems.length) fail(`${slot.name} at ${width}x${height}: ${problems.join("; ")}`);
      else ok(`${slot.name} at ${width}x${height}: all ${count} slides fit without scrolling; Previous, Next, Full screen (and Play on the spread slide) are on screen and uncovered; the whole answer shows; every tree link caption sits clear of the page cards and of other links' curves (result page and slide 3), and slide 3's selected page is in view`);
    }
  }
  await page.setViewportSize({ width: 1360, height: 900 });

  // Present at 390 px: the slide tabs are a sideways row, so the current one is scrolled into view; on "Check the roots"
  // every origin is reachable by scrolling the slide (no nested scroll box cutting items off).
  await page.setViewportSize({ width: 390, height: 844 });
  for (const slot of slots) {
    const analysis = summaryOf(slot.trace);
    currentClaim = analysis.claim;
    await page.goto(`${base}/?slot=${slot.slot}`);
    await waitForText(`${analysis.summary.totalPages} pages`);
    await page.locator(".present-button").click();
    await page.locator(".stage-presentation").waitFor({ timeout: 5_000 });
    const count = await page.locator(".stage-progress button").count();
    const problems = [];
    for (let index = 0; index < count; index += 1) {
      if (index) await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(450);
      const state = await page.evaluate(() => {
        const tab = document.querySelector(".stage-progress-active")?.getBoundingClientRect();
        const list = document.querySelector(".stage-content .stage-root-list");
        const answer = document.querySelector(".stage-content .stage-answer");
        return { name: document.querySelector(".stage-progress-active")?.textContent?.replace(/^\d+/, "") ?? "?", tabInView: Boolean(tab && tab.left >= -1 && tab.right <= window.innerWidth + 1), tabHeight: Math.round(tab?.height ?? 0), nested: list ? list.scrollHeight > list.clientHeight + 2 : false, answerScrolls: answer ? answer.scrollHeight > answer.clientHeight + 2 : false, sideways: document.documentElement.scrollWidth > window.innerWidth };
      });
      if (!state.tabInView) problems.push(`"${state.name}" tab off screen`);
      // One line of tabs: a short slide's spare room once stretched the row (and the active tab) to about 200 px.
      if (state.tabHeight > 50) problems.push(`"${state.name}" tab is ${state.tabHeight} px tall`);
      if (state.answerScrolls) problems.push(`"${state.name}" answer scrolls inside its own box`);
      if (state.nested) problems.push(`"${state.name}" root list scrolls inside the slide`);
      if (state.sideways) problems.push(`"${state.name}" scrolls sideways`);
    }
    await page.keyboard.press("Escape");
    await page.locator(".stage-presentation").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
    if (problems.length) fail(`slot ${slot.slot} Present at 390 px: ${problems.join("; ")}`);
    else ok(`slot ${slot.slot} Present at 390 px: each slide's tab is on screen and one line tall, no sideways scroll, the root list and the answer scroll with the slide`);
  }
  // Page titles in the result's lists wrap at phone width instead of being cut (Pages to inspect left one 44 px wide).
  for (const slot of slots) {
    currentClaim = summaryOf(slot.trace).claim;
    await page.goto(`${base}/?slot=${slot.slot}`);
    await waitForText(`${summaryOf(slot.trace).summary.totalPages} pages`);
    await page.evaluate(() => document.querySelectorAll("main details").forEach((details) => { details.open = true; }));
    await page.waitForTimeout(300);
    const selector = ".coverage-review li button strong, .root-ledger-list strong, .query-audit-pages button > span, .linked-page-button strong";
    const cut = await page.evaluate((query) => [...document.querySelectorAll(query)]
      .filter((node) => node.getBoundingClientRect().width > 0 && (node.scrollWidth > node.clientWidth + 1 || node.getBoundingClientRect().right > window.innerWidth + 0.5))
      .map((node) => `${node.textContent?.slice(0, 30)} (${node.clientWidth} of ${node.scrollWidth} px)`), selector);
    const total = await page.locator(selector).count();
    if (cut.length || !total) fail(`slot ${slot.slot} at 390 px: ${cut.length} page titles cut off (${cut.slice(0, 3).join("; ")}), ${total} checked`);
    else ok(`slot ${slot.slot} at 390 px: all ${total} page titles in the review lists wrap, none cut off`);
  }
  await page.setViewportSize({ width: 1360, height: 900 });

  // Phone width: no panel of a result, with every section opened, makes the page scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const slot of slots) {
    currentClaim = summaryOf(slot.trace).claim;
    await page.locator(`.preset-chip.preset-${slot.id}`).click();
    await waitForText(`${summaryOf(slot.trace).summary.totalPages} pages`);
    const [scrollWidth, clientWidth, wide] = await page.evaluate(async () => {
      const closed = [...document.querySelectorAll("main details:not([open])")];
      closed.forEach((details) => { details.open = true; });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const width = document.documentElement.clientWidth;
      const measured = [document.documentElement.scrollWidth, width, [...document.querySelectorAll("main *")].find((element) => element.getBoundingClientRect().right > width + 1)?.className ?? ""];
      closed.forEach((details) => { details.open = false; });
      return measured;
    });
    if (scrollWidth > clientWidth) fail(`slot ${slot.slot} at 390 px: the page is ${scrollWidth} px wide and scrolls sideways (first wide element: ${wide || "unnamed"})`);
    else ok(`slot ${slot.slot} at 390 px: no sideways scroll with every section open`);
  }
  await page.setViewportSize({ width: 1360, height: 900 });

  // A live run that fails (here: no keys) must offer the saved run of the same claim.
  if (slots[1]) {
    await page.locator("#claim-input").fill(slots[1].claim);
    await page.locator("#claim-input").press("Enter");
    const fallback = page.locator(".error-fallback");
    try {
      await fallback.waitFor({ timeout: 10_000 });
      // No keys: it failed before any paid call, its error carries no receipt, so the card names no spend.
      if (await page.locator(".error-banner .error-spend").count()) fail("a failed run with no cost receipt shows a spend line");
      else ok("a failed run with no cost receipt shows no spend line");
      await fallback.click();
      await page.locator(".error-banner").waitFor({ state: "detached", timeout: 10_000 });
      currentClaim = summaryOf(slots[1].trace).claim;
      const pages = `${summaryOf(slots[1].trace).summary.totalPages} pages`;
      if (await waitForText(pages)) ok("a failed live run offers the saved run, and it opens");
      else fail("the saved-run button did not open the saved run");
    } catch {
      fail("a failed live run did not offer the saved run");
    }
  }

  process.stdout.write("\nShared links\n");
  {
    // A pasted link unfurls with a title, description and a real preview image.
    const head = await (await fetch(base)).text();
    const meta = (property) => head.match(new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]*)"`))?.[1] ?? null;
    const missingMeta = ["og:title", "og:description", "og:image", "twitter:card", "twitter:image"].filter((property) => !meta(property));
    if (missingMeta.length) fail(`link preview tags missing: ${missingMeta.join(", ")}`);
    else ok(`link preview tags present (og:title "${meta("og:title")}", twitter:card ${meta("twitter:card")})`);
    const imageResponse = await fetch(new URL(new URL(meta("og:image") ?? "/opengraph-image", base).pathname, base));
    const imageBytes = imageResponse.ok ? (await imageResponse.arrayBuffer()).byteLength : 0;
    if (!imageResponse.ok || imageResponse.headers.get("content-type") !== "image/png" || imageBytes < 5_000) fail(`preview image: HTTP ${imageResponse.status}, ${imageResponse.headers.get("content-type")}, ${imageBytes} bytes`);
    else ok(`preview image serves as PNG (${Math.round(imageBytes / 1024)} KB)`);
    const analyzeCalls = [];
    page.on("request", (request) => { if (request.url().includes("/api/analyze") && request.method() === "POST") analyzeCalls.push(`${request.method()} ${new URL(request.url()).pathname}${new URL(request.url()).search} @${new URL(page.url()).search.slice(0, 20)}`); });
    const linked = slots[slots.length - 1];
    currentClaim = summaryOf(linked.trace).claim;
    await page.goto(`${base}/?slot=${linked.slot}`);
    if (!(await waitForText(`${summaryOf(linked.trace).summary.totalPages} pages`))) fail(`?slot=${linked.slot} did not open slot ${linked.slot}`);
    else ok(`?slot=${linked.slot} opens slot ${linked.slot}`);
    currentClaim = summaryOf(slots[0].trace).claim;
    await page.locator(`.preset-chip.preset-${slots[0].id}`).click();
    await waitForText(`${summaryOf(slots[0].trace).summary.totalPages} pages`);
    const slotUrl = new URL(page.url());
    if (slotUrl.searchParams.get("slot") !== slots[0].slot) fail(`opening slot ${slots[0].slot} left the address bar at ${slotUrl.search || "no query"}`);
    else ok(`opening slot ${slots[0].slot} puts ?slot=${slots[0].slot} in the address bar`);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.locator(".copy-link-button").click();
    const copiedLink = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    if (copiedLink !== `${base}/?slot=${slots[0].slot}`) fail(`Copy link copied "${copiedLink}", not the slot link`);
    else ok(`Copy link copies ${copiedLink.replace(base, "")}`);
    // Opening a different result after a slot (a backup, a trace file) must not keep sharing the old slot.
    for (const [index, entry] of backups.slice(0, 2).entries()) {
      currentClaim = summaryOf(entry.trace).claim;
      if (index === 0) await page.locator(".backup-chip", { hasText: entry.label }).click();
      else await page.locator('input[aria-label="Open saved Echo trace file"]').setInputFiles(path.join(root, "public", entry.trace));
      await waitForText(`${summaryOf(entry.trace).summary.totalPages} pages`);
      const how = index === 0 ? `the "${entry.label}" backup` : "a trace file";
      await page.locator(".copy-link-button").click();
      const link = new URL((await page.evaluate(() => navigator.clipboard.readText()).catch(() => "")) || "http://x/");
      const bar = new URL(page.url());
      // A bundled backup is shared by its own ?trace= link (it reopens this exact run, free); never the old slot.
      const wanted = entry.trace.split("/").pop().replace(/\.echo\.json$/, "");
      if (link.searchParams.get("slot") || link.searchParams.get("trace") !== wanted) fail(`after opening ${how}, Copy link copied ${link.search || "nothing"}, not ?trace=${wanted}`);
      else if (bar.searchParams.get("slot") || bar.searchParams.get("trace") !== wanted) fail(`after opening ${how}, the address bar still reads ${bar.search || "nothing"}`);
      else ok(`after opening ${how}, the address bar and Copy link name ?trace=${wanted}, not the old slot`);
      await page.locator(`.preset-chip.preset-${slots[0].id}`).click();
      currentClaim = summaryOf(slots[0].trace).claim;
      await waitForText(`${summaryOf(slots[0].trace).summary.totalPages} pages`);
    }
    // Embed badge: the snippet links to this exact run and its image states the same verdict.
    await openMore();
    await page.locator(".copy-badge-button").click();
    const snippet = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    const snippetHref = snippet.match(/<a href="([^"]+)"/)?.[1] ?? "";
    const snippetImg = snippet.match(/<img src="([^"]+)"/)?.[1] ?? "";
    const badgeSvg = snippetImg ? await (await fetch(snippetImg)).text().catch(() => "") : "";
    const slotHeadline = summaryOf(slots[0].trace).summary.verifiableOrigins === 0 ? "No origin with its own evidence" : `${summaryOf(slots[0].trace).summary.totalPages} pages`;
    if (snippetHref !== `${base}/?slot=${slots[0].slot}` || !snippetImg.endsWith(`/badge/${slots[0].trace.split("/").pop().replace(/\.echo\.json$/, "")}`) || !badgeSvg.startsWith("<svg") || !badgeSvg.includes(slotHeadline)) fail(`Embed badge copied ${JSON.stringify(snippet.slice(0, 160))}`);
    else ok(`Embed badge copies a linked badge for this run (image says "${slotHeadline}…")`);
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error("blocked")); });
    await page.locator(".copy-link-button").click();
    if ((await page.locator(".copy-link-button").innerText()).trim() !== "Copy unavailable") fail("a blocked clipboard does not say Copy unavailable");
    else ok("a blocked clipboard says Copy unavailable instead of failing silently");
    await page.locator(".new-claim-button", { hasText: "New trace" }).click();
    if (new URL(page.url()).search) fail(`New trace left ${new URL(page.url()).search} in the address bar`);
    else ok("New trace clears the shared link");
    for (const bad of ["99", "%3Cscript%3Ealert(1)%3C%2Fscript%3E", "0", "-1"]) {
      await page.goto(`${base}/?slot=${bad}`);
      await page.waitForTimeout(400);
      if ((await page.locator(".loading-card, .error-banner, .result-mode-tag").count()) || (await page.locator("#claim-input").inputValue())) fail(`?slot=${decodeURIComponent(bad)} did something`);
    }
    ok("unknown or hostile ?slot values open nothing and show no error");
    const hostile = `<img src=x onerror="window.__pwned=1"> ${"x".repeat(2_000)}`;
    let dialogs = 0;
    page.on("dialog", (dialog) => { dialogs += 1; void dialog.dismiss(); });
    await page.goto(`${base}/?claim=${encodeURIComponent(hostile)}`);
    await page.waitForFunction(() => Boolean(document.getElementById("claim-input")?.value), null, { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const filled = await page.locator("#claim-input").inputValue();
    const pwned = await page.evaluate(() => Boolean(window.__pwned));
    if (!filled.startsWith("<img src=x") || filled.length > 500) fail(`?claim= filled the box with ${filled.length} characters`);
    else if (pwned || dialogs) fail("?claim= ran script from the link");
    else if (analyzeCalls.length || (await page.locator(".loading-card").count())) fail(`?claim= started a run (${analyzeCalls.length} POST analyze requests: ${[...new Set(analyzeCalls)].join(" | ")})`);
    else ok(`?claim= fills the box as text (${filled.length} characters, capped at 500), runs no script and starts no run`);
    await page.locator("#claim-input").fill("");
    await page.goto(base);
  }

  process.stdout.write("\nLink and claim edge cases\n");
  {
    const slotRun = slots[0];
    currentClaim = summaryOf(slotRun.trace).claim;
    const slug = slotRun.trace.split("/").pop().replace(/\.echo\.json$/, "");
    await page.goto(`${base}/?trace=${slug}`);
    if (!(await waitForText(`${summaryOf(slotRun.trace).summary.totalPages} pages`))) fail(`?trace=${slug} did not open slot ${slotRun.slot}`);
    else ok(`?trace=${slug} opens slot ${slotRun.slot} too`);
    for (const bad of ["no-such-run", "../demo-traces/x", "99"]) {
      await page.goto(`${base}/?trace=${encodeURIComponent(bad)}`);
      await page.waitForTimeout(400);
      if (new URL(page.url()).search || (await page.locator(".result-mode-tag, .loading-card").count())) { fail(`?trace=${bad} left "${new URL(page.url()).search}" or opened something`); break; }
    }
    ok("an unknown ?trace= opens nothing and leaves a clean address bar");
    let posted = 0;
    const countPosts = (request) => { if (request.url().includes("/api/analyze") && request.method() === "POST") posted += 1; };
    page.on("request", countPosts);
    await page.locator("#claim-input").fill("........");
    await page.locator("#claim-input").press("Enter");
    const banner = await page.locator(".error-banner").innerText({ timeout: 3_000 }).catch(() => "");
    page.off("request", countPosts);
    const extraButtons = await page.locator(".error-banner .error-fallback").count();
    if (!/Write the claim to trace/.test(banner) || !/in words/.test(banner) || posted || extraButtons) fail(`a claim with no words: banner "${banner.replace(/\s+/g, " ").slice(0, 90)}", ${posted} runs sent, ${extraButtons} extra buttons`);
    else ok("a claim with no words gets a plain message at once, sends nothing, and offers no retry");
    await page.locator("#claim-input").fill("");
    await page.locator(".error-close").click().catch(() => undefined);
  }

  process.stdout.write("\nLive setup note\n");
  {
    // This server has blank keys: the note says live search is not set up, and shows no spending line.
    await page.goto(base);
    const note = await page.waitForFunction(() => {
      const text = document.querySelector(".key-note")?.textContent ?? "";
      return text.includes("Checking") ? false : text;
    }, null, { timeout: 5_000 }).then((handle) => handle.jsonValue(), () => "");
    const budgetLines = await page.locator(".key-note small").count();
    if (!note.includes("Live search isn't set up on this copy · saved runs still open") || budgetLines) fail(`with no keys the claim box note reads "${note}" (${budgetLines} budget lines)`);
    else ok(`with no keys the claim box says "${note}", with no budget line`);
    // Visitor-facing words: no internal jargon on the first screen; the network badge appears only when offline.
    const words = await page.evaluate(() => ({
      status: document.querySelector(".topbar-status")?.textContent?.trim() ?? null,
      saved: [...document.querySelectorAll(".backup-row .preset-label")].map((node) => node.textContent).join(" "),
      empty: document.querySelector(".empty-state .empty-copy p")?.textContent ?? "",
      jargon: /BACKUP POOL|NETWORK AVAILABLE/.test(document.body.innerText),
    }));
    if (words.status !== "" || words.saved !== "MORE SAVED RUNS" || words.empty !== "Open a saved run, or paste a claim and Echo traces it across the web." || words.jargon) fail(`first-screen words: ${JSON.stringify(words)}`);
    else ok("the first screen says MORE SAVED RUNS and \"Open a saved run, or paste a claim…\", with no network badge while online");
  }

  process.stdout.write("\nGlossary examples\n");
  {
    // Its example figures quote the bundled phones run, so they must be that run's figures, not invented ones.
    const phones = slots.find((slot) => slot.trace.includes("phones"));
    const analysis = summaryOf(phones.trace);
    const derived = analysis.pages.filter((p) => p.judgment.kind === "derived").length;
    await page.goto(base);
    // They are read from the trace when the glossary opens, so wait for them to load.
    await page.locator("details", { hasText: "PLAIN-LANGUAGE GLOSSARY" }).evaluate((details) => { details.open = true; });
    await page.waitForFunction(() => /pages are echoes/.test(document.getElementById("glossary")?.textContent ?? ""), null, { timeout: 5_000 }).catch(() => undefined);
    const glossary = await page.locator("#glossary").innerText().catch(() => "");
    const wanted = [
      `${derived} of its ${analysis.summary.totalPages} pages are echoes: ${analysis.summary.echoPercentage}%`,
      `“${analysis.summary.totalPages} pages → ${analysis.summary.independentOrigins} independent origins”`,
      "repeated widely, but no independent origin shows evidence of its own",
    ];
    const missing = wanted.filter((text) => !glossary.includes(text));
    if (missing.length || /21 of 23|23 pages|no original source can be found/.test(glossary)) fail(`the glossary lacks ${missing.join(" | ") || "nothing"} or keeps an invented figure`);
    else ok(`the glossary's examples are the saved phones run's own figures (${derived} of ${analysis.summary.totalPages} echoes, ${analysis.summary.echoPercentage}%)`);
  }

  process.stdout.write("\nSaved runs vs imported files\n");
  {
    // A bundled run is a saved live run with its capture date, not something the visitor imported.
    const entry = slots[1] ?? slots[0];
    const analysis = summaryOf(entry.trace);
    const captured = new Date(analysis.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    currentClaim = analysis.claim;
    await page.goto(`${base}/?slot=${entry.slot}`);
    await waitForText(`${analysis.summary.totalPages} pages`);
    const tag = (await page.locator(".result-mode-tag").innerText()).trim();
    await openMore();
    const keep = await page.locator("button", { hasText: "Keep in browser" }).count();
    const notice = await page.locator(".imported-notice").innerText().catch(() => "");
    if (tag !== `SAVED LIVE RUN · captured ${captured}` || keep || /IMPORTED/.test(notice) || /IMPORTED/.test(await page.locator(".page-footer").innerText())) fail(`slot ${entry.slot}: tag "${tag}", Keep in browser ${keep}, notice "${notice.slice(0, 60)}"`);
    else ok(`slot ${entry.slot} is labelled "${tag}", says nothing of importing, and offers no Keep in browser`);
    await page.locator(".present-button").click();
    const stageLabel = await page.locator(".stage-toolbar-center").innerText({ timeout: 5_000 }).catch(() => "");
    await page.keyboard.press("Escape");
    if (!stageLabel.includes("SAVED LIVE RUN") || /IMPORTED/.test(stageLabel)) fail(`Present mode labels slot ${entry.slot} "${stageLabel}"`);
    else ok(`Present mode labels it "${stageLabel.replace(/\s+/g, " ")}"`);
    // The same run opened as a file is the visitor's own import. A demo claim's run is kept in the browser only if it
    // passes the pinned-cache rule, which no bundled run does, so Keep in browser (which always failed) is not offered.
    await page.locator('input[aria-label="Open saved Echo trace file"]').setInputFiles(path.join(root, "public", entry.trace));
    await page.waitForFunction(() => document.querySelector(".result-mode-tag")?.textContent?.includes("IMPORTED"), null, { timeout: 5_000 }).catch(() => undefined);
    const fileTag = (await page.locator(".result-mode-tag").innerText()).trim();
    await openMore();
    const fileKeep = await page.locator("button", { hasText: /Keep in browser|Saved here/ }).count();
    if (fileTag !== "IMPORTED TRACE FILE" || fileKeep) fail(`the slot's run opened as a file: tag "${fileTag}", Keep in browser ${fileKeep} (this browser would refuse to keep it)`);
    else ok("the same run opened as a file is labelled IMPORTED TRACE FILE and offers no Keep in browser, which would be refused");
    // Every bundled trace would be refused the same way, so none may offer it.
    const refusable = [...slots, ...backups].filter((candidate) => {
      const run = summaryOf(candidate.trace);
      return run.pages.some((pageEntry) => pageEntry.extractionSource === "Search snippet" && pageEntry.judgment.kind === "unclear");
    }).length;
    if (refusable !== slots.length + backups.length) fail(`only ${refusable} of ${slots.length + backups.length} bundled traces leave a snippet page unclear; recheck which may offer Keep in browser`);
    // A trace file of any other claim is kept, and the button says so once it is.
    const other = path.join(root, "evaluation", "runs", "cracking-knuckles-causes-arthritis.2026-11-12-run1.echo.json");
    currentClaim = JSON.parse(fs.readFileSync(other, "utf8")).analysis.claim;
    await page.locator('input[aria-label="Open saved Echo trace file"]').setInputFiles(other);
    await waitForText(`${JSON.parse(fs.readFileSync(other, "utf8")).analysis.summary.totalPages} pages`);
    await openMore();
    const keepOther = page.locator("button", { hasText: "Keep in browser" });
    if (!(await keepOther.count())) fail("an opened trace file of another claim offers no Keep in browser");
    else {
      await keepOther.click();
      await openMore();
      const kept = await page.locator("button", { hasText: "Saved here" }).count();
      const error = await page.locator(".import-error").count();
      if (!kept || error) fail(`Keep in browser on another claim's trace file: Saved here ${kept}, error banner ${error}`);
      else ok("a trace file of another claim offers Keep in browser, and pressing it keeps it (Saved here)");
      // Leave the browser's recent traces as they were, so later checks see the same page.
      await page.evaluate((claim) => {
        const kept = JSON.parse(localStorage.getItem("echo-recent-traces:v8") ?? "[]").filter((entry) => entry?.claim !== claim);
        if (kept.length) localStorage.setItem("echo-recent-traces:v8", JSON.stringify(kept));
        else localStorage.removeItem("echo-recent-traces:v8");
      }, currentClaim);
    }
  }

  process.stdout.write("\nBrand link\n");
  {
    const entry = slots[slots.length - 1];
    currentClaim = summaryOf(entry.trace).claim;
    await page.goto(`${base}/?slot=${entry.slot}`);
    await waitForText(`${summaryOf(entry.trace).summary.totalPages} pages`);
    await page.locator("a.brand").click();
    await page.waitForTimeout(300);
    const left = { result: await page.locator(".result-mode-tag").count(), search: new URL(page.url()).search, box: await page.locator("#claim-input").inputValue() };
    if (left.result || left.search || left.box) fail(`the logo did not reset the workbench (${JSON.stringify(left)})`);
    else ok("the logo resets the workbench: no result, clean address, empty claim box");
  }

  process.stdout.write("\nTrace from any page (bookmarklet)\n");
  {
    await page.goto(`${base}/anywhere`);
    const href = await page.locator("a", { hasText: "Trace with Echo" }).getAttribute("href", { timeout: 5_000 }).catch(() => null);
    if (!href?.startsWith("javascript:")) fail(`the bookmarklet has no javascript: address (${href})`);
    else {
      // Select a sentence on this page and run the bookmark exactly as a browser would, capturing the tab it opens.
      const opened = await page.evaluate((code) => {
        const target = [...document.querySelectorAll("li")].find((item) => item.textContent?.includes("96 times a day"));
        const range = document.createRange();
        range.selectNodeContents(target);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        const tabs = [];
        window.open = (...args) => { tabs.push(args[0]); return null; };
        new Function(code)();
        return tabs;
      }, decodeURIComponent(href.slice("javascript:".length)));
      const tab = opened[0] ? new URL(opened[0]) : null;
      if (!tab || tab.origin !== base || !tab.searchParams.get("claim")?.includes("Americans check their phones 96 times a day")) fail(`the bookmarklet opened ${opened.join(", ") || "nothing"}`);
      else {
        ok("the bookmarklet turns a selection into a ?claim= tab on this Echo");
        let posted = 0;
        const countPosts = (request) => { if (request.url().includes("/api/analyze") && request.method() === "POST") posted += 1; };
        page.on("request", countPosts);
        await page.goto(tab.href);
        await page.waitForFunction(() => Boolean(document.getElementById("claim-input")?.value), null, { timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        const box = await page.locator("#claim-input").inputValue();
        page.off("request", countPosts);
        if (!box.includes("96 times a day") || posted) fail(`the bookmarklet's tab: box "${box.slice(0, 60)}", ${posted} runs started`);
        else ok("its tab fills the claim box and starts no run");
      }
    }
    await page.goto(base);
    if (!(await page.locator(".page-footer a[href='/anywhere']").count())) fail("the footer does not link to Trace from any page");
    else ok("the footer links to Trace from any page");
  }

  process.stdout.write("\nBrowser extension (extension/, run with a stand-in chrome API)\n");
  {
    const extDir = path.join(root, "extension");
    const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
    const listed = [manifest.background?.service_worker, manifest.options_ui?.page, manifest.side_panel?.default_path, ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []), ...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {})];
    const missing = listed.filter((file) => !file || !fs.existsSync(path.join(extDir, file)));
    const pngSize = (file) => { const bytes = fs.readFileSync(path.join(extDir, file)); return bytes.toString("latin1", 1, 4) === "PNG" ? bytes.readUInt32BE(16) : 0; };
    const badIcons = Object.entries(manifest.icons ?? {}).filter(([size, file]) => pngSize(file) !== Number(size));
    const permissions = [...(manifest.permissions ?? [])].sort().join(",");
    if (manifest.manifest_version !== 3 || missing.length || badIcons.length) fail(`extension manifest: version ${manifest.manifest_version}, missing ${missing.join(", ") || "none"}, wrong icons ${badIcons.map(([size]) => size).join(", ") || "none"}`);
    // The pop-up's script runs on http(s) pages only, in the top frame; host access (for a deployed Echo's sign-in in
    // the side panel) is optional and asked for one site at a time; no scripting, tabs or cookies permission.
    else if (permissions !== "contextMenus,sidePanel,storage" || manifest.host_permissions || manifest.optional_permissions
      || JSON.stringify(manifest.content_scripts) !== JSON.stringify([{ matches: ["http://*/*", "https://*/*"], js: ["echo-link.js", "content.js"], run_at: "document_idle", all_frames: false }])
      || JSON.stringify([...(manifest.optional_host_permissions ?? [])].sort()) !== JSON.stringify(["http://*/*", "https://*/*"])) fail(`the extension asks for more than it needs: ${permissions} ${JSON.stringify({ host: manifest.host_permissions, optionalHost: manifest.optional_host_permissions, scripts: manifest.content_scripts })}`);
    else ok("manifest V3, every file it names exists, icons are PNGs of their sizes; asks for contextMenus + storage + sidePanel, its pop-up script on http(s) pages, and host access only as an option");
    const command = manifest.commands?.["trace-selection"];
    if (command?.suggested_key?.default !== "Alt+Shift+E" || manifest.side_panel?.default_path !== "sidepanel.html") fail(`the extension's shortcut ${JSON.stringify(command)} or side panel ${JSON.stringify(manifest.side_panel)}`);
    else ok(`the shortcut is ${command.suggested_key.default} ("${command.description}"); the side panel is sidepanel.html`);
    // The manifest's key fixes the extension's id, so ECHO_EXTENSION_ORIGINS can be written down once (README).
    const extensionId = manifest.key ? [...createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("") : null;
    const documented = fs.readFileSync(path.join(extDir, "README.md"), "utf8").includes(`chrome-extension://${extensionId}`) && fs.readFileSync(path.join(root, ".env.example"), "utf8").includes(`chrome-extension://${extensionId}`);
    if (!extensionId || !documented) fail(`the extension's id from its manifest key (${extensionId}) is not the one extension/README.md and .env.example name`);
    else ok(`the manifest key fixes the extension's id (chrome-extension://${extensionId}), as extension/README.md and .env.example say`);

    // Run background.js in a page with a stand-in for the chrome.* calls it makes, then "right-click" each menu.
    const sources = { link: fs.readFileSync(path.join(extDir, "echo-link.js"), "utf8"), background: fs.readFileSync(path.join(extDir, "background.js"), "utf8") };
    await page.goto(`${base}/anywhere`);
    const run = await page.evaluate(async ({ link, background, site }) => {
      const listeners = {};
      const store = { echoSite: site };
      const menus = new Map();
      const opened = [];
      const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
      const panelOpens = [];
      const session = {};
      let panelFails = false;
      let pageSelection = null;
      globalThis.chrome = {
        runtime: { id: "binkgignaekgeoklkoplgpddepbefabb", onInstalled: on("installed"), onMessage: on("message"), getURL: (file) => `chrome-extension://binkgignaekgeoklkoplgpddepbefabb/${file}` },
        commands: { onCommand: on("command") },
        sidePanel: { open: (options) => { panelOpens.push({ ...options, opened: opened.length }); return panelFails ? Promise.reject(new Error("no user gesture")) : Promise.resolve(); } },
        contextMenus: {
          removeAll: (done) => { menus.clear(); done?.(); },
          create: (item) => { if (menus.has(item.id)) throw new Error(`duplicate menu ${item.id}`); menus.set(item.id, item); },
          onClicked: on("clicked"),
        },
        action: { onClicked: on("action") },
        storage: { sync: { get: async (defaults) => ({ ...defaults, ...store }), set: async (values) => Object.assign(store, values) }, session: { set: async (values) => Object.assign(session, values) } },
        tabs: { create: async (options) => { opened.push(options); }, sendMessage: async (_tabId, message) => (message.type === "echo:get-selection" ? pageSelection : null) },
      };
      globalThis.importScripts = () => (0, eval)(link);
      (0, eval)(background);
      listeners.installed();
      listeners.installed();
      const tab = { id: 7, index: 2 };
      const click = async (info) => { opened.length = 0; await listeners.clicked(info, tab); return opened[0]; };
      const long = `${"a".repeat(499)}😀 and more`;
      const result = {
        menus: [...menus.values()].map((item) => `${item.title} [${item.contexts}]`),
        selection: await click({ menuItemId: "echo-trace-selection", selectionText: "  Americans check\n their   phones 96 times a day  " }),
        long: await click({ menuItemId: "echo-trace-selection", selectionText: long }),
        blank: await click({ menuItemId: "echo-trace-selection", selectionText: "   " }),
        page: await click({ menuItemId: "echo-read-page", pageUrl: "https://news.example/story?id=3#comments" }),
        script: await click({ menuItemId: "echo-read-link", linkUrl: "javascript:alert(1)" }),
        checkLinks: await click({ menuItemId: "echo-check-links", selectionText: "Phones are everywhere. Americans check their phones 96 times a day, according to a 2019 survey [1][2].\n[1] https://www.asurion.com/press-releases/phones-96\n[2] http://prnewswire.com/news/phones-96#top." }),
        checkNoLinks: await click({ menuItemId: "echo-check-links", selectionText: "  Americans check their phones\n 96 times a day  " }),
        checkLink: await click({ menuItemId: "echo-check-link", linkUrl: "https://news.example/story?id=3#comments" }),
        checkScript: await click({ menuItemId: "echo-check-link", linkUrl: "javascript:alert(1)" }),
      };
      opened.length = 0;
      await listeners.action(tab);
      result.action = opened[0];
      store.echoSite = "javascript:alert(1)";
      result.badSite = await click({ menuItemId: "echo-trace-selection", selectionText: "Goldfish have a 3-second memory" });
      chrome.storage.sync.get = async () => { throw new Error("storage unavailable"); };
      result.noStorage = await click({ menuItemId: "echo-trace-selection", selectionText: "Goldfish have a 3-second memory" });
      // The selection pop-up's click (content.js) and the shortcut: the side panel opens at once, in the same turn as
      // the message (the browser allows it only then), and the job waits in session storage.
      const tabHere = { id: 7, index: 2, windowId: 3 };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
      const popup = async (message, sender = { id: chrome.runtime.id, tab: tabHere }) => {
        panelOpens.length = 0; opened.length = 0; delete session.echoJob;
        listeners.message(message, sender);
        const openedAtOnce = panelOpens.length;
        await settle();
        return { openedAtOnce, opens: [...panelOpens], job: session.echoJob ?? null, tabs: opened.map((entry) => entry.url) };
      };
      result.popupTrace = await popup({ type: "echo:popup", action: "trace", text: "  Americans check\n their phones 96 times a day " });
      result.popupLinks = await popup({ type: "echo:popup", action: "links", text: "Americans check their phones 96 times a day, a 2019 survey found [1].", pageLinks: ["https://www.asurion.com/press-releases/phones-96#top", "javascript:alert(1)"] });
      result.popupForeign = await popup({ type: "echo:popup", action: "trace", text: "Americans check their phones 96 times a day" }, { id: "another-extension", tab: tabHere });
      result.popupBlank = await popup({ type: "echo:popup", action: "trace", text: "   " });
      panelFails = true;
      result.popupNoPanel = await popup({ type: "echo:popup", action: "trace", text: "Goldfish have a 3-second memory" });
      panelFails = false;
      const command = async (selection) => {
        panelOpens.length = 0; opened.length = 0; delete session.echoJob; pageSelection = selection;
        listeners.command("trace-selection", tabHere);
        const openedAtOnce = panelOpens.length;
        await settle();
        return { openedAtOnce, job: session.echoJob ?? null };
      };
      result.command = await command({ text: "Goldfish have a 3-second memory", pageLinks: [] });
      result.commandNothing = await command(null);
      delete globalThis.chrome;
      delete globalThis.importScripts;
      return result;
    }, { ...sources, site: base });
    const claimOf = (url) => new URL(url).searchParams.get("claim");
    const longClaim = claimOf(run.long.url) ?? "";
    if (run.menus.length !== 5 || !run.menus.includes("Trace with Echo [selection]") || !run.menus.includes("Check links with Echo [selection]") || !run.menus.includes("Check this link with Echo [link]")) fail(`the extension's menu: ${run.menus.join(" | ")}`);
    else ok(`installing twice leaves one right-click menu: ${run.menus.join(" · ")}`);
    if (claimOf(run.selection.url) !== "Americans check their phones 96 times a day" || !run.selection.url.startsWith(`${base}/?claim=`) || run.selection.index !== 3 || run.selection.openerTabId !== 7) fail(`Trace with Echo opened ${JSON.stringify(run.selection)}`);
    else ok("Trace with Echo opens a ?claim= tab on the configured Echo, next to the reader's tab, whitespace collapsed");
    if (longClaim.length > 500 || /[\uD800-\uDBFF]$/.test(longClaim) || run.blank.url !== `${base}/`) fail(`a long selection gave ${longClaim.length} characters; a blank one opened ${run.blank.url}`);
    else ok(`a 2,000-character selection is cut to ${longClaim.length} characters with no half emoji; a blank one opens Echo empty`);
    if (claimOf(run.page.url) !== "https://news.example/story?id=3" || run.script.url !== `${base}/` || run.action.url !== `${base}/`) fail(`page menu ${run.page.url}, javascript: link ${run.script.url}, toolbar ${run.action.url}`);
    else ok("Find claims in this page sends the page address without its #fragment; a javascript: link and the toolbar button open Echo empty");
    if (run.badSite.url !== "http://localhost:3000/?claim=Goldfish%20have%20a%203-second%20memory" || run.noStorage.url !== run.badSite.url) fail(`a bad saved address opened ${run.badSite.url}; no storage opened ${run.noStorage.url}`);
    else ok("a saved address that is not a web address, or unreadable storage, falls back to http://localhost:3000");
    const paramsOf = (url) => Object.fromEntries(new URL(url).searchParams);
    const checked = paramsOf(run.checkLinks.url);
    if (!run.checkLinks.url.startsWith(`${base}/?urls=`) || JSON.stringify(Object.keys(checked).sort()) !== JSON.stringify(["claim", "urls"]) || checked.urls !== "https://www.asurion.com/press-releases/phones-96 http://prnewswire.com/news/phones-96" || checked.claim !== "Americans check their phones 96 times a day, according to a 2019 survey." || run.checkLinks.index !== 3) fail(`Check links with Echo opened ${JSON.stringify(run.checkLinks)}`);
    else ok(`Check links with Echo opens ?urls= with the selection's 2 links (fragment and punctuation dropped) and its cited sentence "${checked.claim}"`);
    if (paramsOf(run.checkNoLinks.url).claim !== "Americans check their phones 96 times a day" || "urls" in paramsOf(run.checkNoLinks.url)) fail(`Check links with Echo on a selection without links opened ${run.checkNoLinks.url}`);
    else ok("a selection with no written link opens as a claim instead, like Trace with Echo");
    if (run.checkLink.url !== `${base}/?urls=${encodeURIComponent("https://news.example/story?id=3")}` || run.checkScript.url !== `${base}/`) fail(`Check this link with Echo opened ${run.checkLink.url}; on a javascript: link ${run.checkScript.url}`);
    else ok("Check this link with Echo opens ?urls= with that one link (no #fragment); a javascript: link opens Echo empty");
    const { popupTrace, popupLinks, popupForeign, popupBlank, popupNoPanel } = run;
    if (popupTrace.openedAtOnce !== 1 || popupTrace.opens[0]?.windowId !== 3 || popupTrace.job?.kind !== "trace" || popupTrace.job?.claim !== "Americans check their phones 96 times a day" || typeof popupTrace.job?.at !== "number" || popupTrace.tabs.length) fail(`the pop-up's Trace: ${JSON.stringify(popupTrace)}`);
    else ok("the pop-up's Trace opens the side panel in the click's own turn and leaves one job (the cleaned claim) in session storage; no tab");
    if (popupLinks.job?.kind !== "links" || JSON.stringify(popupLinks.job?.urls) !== JSON.stringify(["https://www.asurion.com/press-releases/phones-96"]) || popupLinks.job?.claim !== "Americans check their phones 96 times a day, a 2019 survey found.") fail(`the pop-up's Check links: ${JSON.stringify(popupLinks.job)}`);
    else ok("the pop-up's Check links sends the selection's page links (no javascript:, no #fragment) and its cited sentence");
    if (popupForeign.opens.length || popupForeign.job || popupBlank.opens.length || popupBlank.job) fail(`a message from another extension or a blank selection: ${JSON.stringify({ popupForeign, popupBlank })}`);
    else ok("a message from another extension, or a blank selection, opens nothing and leaves no job");
    if (popupNoPanel.tabs[0] !== "chrome-extension://binkgignaekgeoklkoplgpddepbefabb/sidepanel.html?tab=1" || popupNoPanel.job?.claim !== "Goldfish have a 3-second memory") fail(`with no side panel the pop-up opened ${JSON.stringify(popupNoPanel)}`);
    else ok("where the side panel will not open, the same page opens in a tab next to the reader's, with the job");
    if (run.command.openedAtOnce !== 1 || run.command.job?.claim !== "Goldfish have a 3-second memory" || run.commandNothing.openedAtOnce !== 1 || run.commandNothing.job?.kind !== "none") fail(`the shortcut: ${JSON.stringify({ command: run.command, nothing: run.commandNothing })}`);
    else ok("the shortcut opens the side panel at once and traces the page's selection; with nothing selected, the panel shows a hint (no run)");

    // The tabs it opens: the claim box fills, and nothing is traced or read until the reader presses the button.
    let posted = 0;
    const countPosts = (request) => { if (/\/api\/(analyze|claims|copy-hunt)/.test(request.url()) && request.method() === "POST") posted += 1; };
    page.on("request", countPosts);
    await page.goto(run.selection.url);
    await page.waitForFunction(() => Boolean(document.getElementById("claim-input")?.value), null, { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const box = await page.locator("#claim-input").inputValue();
    const loading = await page.locator(".loading-card").count();
    await page.goto(run.page.url);
    await page.waitForFunction(() => Boolean(document.getElementById("claim-input")?.value), null, { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const pageBox = await page.locator("#claim-input").inputValue();
    const button = (await page.locator(".trace-button").innerText()).trim();
    const scanned = await page.locator(".article-scan").count();
    await page.goto(run.checkLinks.url);
    await page.locator("#source-check-claim").waitFor({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const linkChips = await page.locator("[aria-label='Links Echo will read'] li").count();
    const linkClaim = await page.locator("#source-check-claim").inputValue().catch(() => "");
    const linkLoading = await page.locator(".loading-card").count();
    page.off("request", countPosts);
    if (box !== "Americans check their phones 96 times a day" || loading || posted) fail(`the extension's claim tab: box "${box}", loading ${loading}, ${posted} POSTs`);
    else ok("its claim tab fills the claim box and starts no run");
    if (pageBox !== "https://news.example/story?id=3" || !/Find claims in this page/.test(button) || scanned || posted) fail(`the extension's page tab: box "${pageBox}", button "${button}", scan ${scanned}, ${posted} POSTs`);
    else ok("its page tab puts the address in the box under Find claims in this page, and reads nothing until pressed");
    if (linkChips !== 2 || linkClaim !== "Americans check their phones 96 times a day, according to a 2019 survey." || linkLoading || posted) fail(`the extension's Check links tab: ${linkChips} chips, sentence "${linkClaim}", loading ${linkLoading}, ${posted} POSTs`);
    else ok("its Check links tab fills the Check these sources panel (2 chips and the sentence) and starts no run");
    await page.locator("#claim-input").fill("");

    // The settings page, served from the folder as the browser would, with an in-memory chrome.storage.
    const optionsPage = await context.newPage();
    const extOrigin = "http://echo-extension.test";
    await optionsPage.route(`${extOrigin}/**`, (route) => {
      const file = path.join(extDir, new URL(route.request().url()).pathname);
      if (!file.startsWith(extDir) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[path.extname(file)] ?? "application/octet-stream";
      return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
    });
    await optionsPage.addInitScript(() => {
      const store = {};
      window.__echoStore = store;
      window.chrome = { storage: { sync: { get: async (defaults) => ({ ...defaults, ...store }), set: async (values) => { Object.assign(store, values); } } } };
    });
    const optionErrors = [];
    optionsPage.on("pageerror", (error) => optionErrors.push(error.message));
    await optionsPage.setViewportSize({ width: 390, height: 844 });
    await optionsPage.goto(`${extOrigin}/options.html`);
    const field = optionsPage.locator("#site");
    await optionsPage.waitForFunction(() => document.getElementById("site")?.value, null, { timeout: 3_000 }).catch(() => undefined);
    const shownDefault = await field.inputValue();
    const saveAs = async (value) => {
      await field.fill(value);
      await optionsPage.locator("button[type=submit]").click();
      await optionsPage.waitForTimeout(150);
      return { field: await field.inputValue(), status: await optionsPage.locator("#status").innerText(), stored: await optionsPage.evaluate(() => window.__echoStore.echoSite ?? null), invalid: await field.getAttribute("aria-invalid") };
    };
    const bare = await saveAs("localhost:4000");
    const path_ = await saveAs("  https://echo.example/some/path?x=1#y ");
    const hostile = await saveAs("javascript:alert(1)");
    await optionsPage.locator("#reset").click();
    await optionsPage.waitForTimeout(150);
    const reset = await optionsPage.evaluate(() => window.__echoStore.echoSite);
    if (shownDefault !== "http://localhost:3000" || bare.stored !== "http://localhost:4000" || path_.stored !== "https://echo.example" || path_.field !== "https://echo.example") fail(`extension settings: default "${shownDefault}", "localhost:4000" saved as ${bare.stored}, a path saved as ${path_.stored}`);
    else ok("extension settings default to http://localhost:3000; a bare localhost gets http://, a deployed address keeps only its site");
    if (hostile.stored !== "https://echo.example" || hostile.invalid !== "true" || !/not a web address/.test(hostile.status) || reset !== "http://localhost:3000") fail(`extension settings: javascript: stored ${hostile.stored}, status "${hostile.status}", reset to ${reset}`);
    else ok("a javascript: address is refused with a message and not saved; Use localhost resets it");
    const layout = await optionsPage.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect();
      const [input, save, reset] = [box("#site"), box("button[type=submit]"), box("#reset")];
      const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return { scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth, overlap: overlap(input, save) || overlap(save, reset) || overlap(input, reset), right: Math.max(input.right, save.right, reset.right), short: Math.min(input.height, save.height, reset.height) };
    });
    if (layout.scroll > layout.width || layout.overlap || layout.right > layout.width || layout.short < 40) fail(`extension settings at 390 px: ${JSON.stringify(layout)}`);
    else ok(`extension settings at 390 px: no sideways scroll, field and buttons apart and at least ${Math.round(layout.short)} px tall`);
    await optionsPage.locator("#popup").click();
    await optionsPage.waitForTimeout(150);
    const popupOff = await optionsPage.evaluate(() => window.__echoStore.echoPopup);
    const originShown = await optionsPage.locator("#origin-line").innerText();
    if (popupOff !== false || !/^ECHO_EXTENSION_ORIGINS=\S+$/.test(originShown)) fail(`extension settings: the pop-up switch saved ${popupOff}; the origin line reads "${originShown}"`);
    else ok(`the pop-up switch saves echoPopup: false; the settings show the line for Echo (${originShown})`);
    if (optionErrors.length) fail(`extension settings page errors: ${optionErrors.join(" | ")}`);
    await optionsPage.close();

    // The selection pop-up (content.js) on a real page, with a stand-in chrome API. The closed shadow root is kept
    // closed; the test only keeps a handle on it to read the buttons.
    process.stdout.write("\nSelection pop-up (extension/content.js, stand-in chrome API)\n");
    const popupPage = await context.newPage();
    const popupErrors = [];
    popupPage.on("pageerror", (error) => popupErrors.push(error.message));
    await popupPage.setViewportSize({ width: 1100, height: 900 });
    await popupPage.goto(`${base}/how`);
    await popupPage.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", `<section id="echo-popup-test" style="padding: 24px; max-width: 720px">
        <p id="pt-claim">Americans check their phones 96 times a day, according to a 2019 survey by Asurion.</p>
        <p id="pt-links">Phones are everywhere, as <a href="https://www.asurion.com/press-releases/phones-96#top">Asurion</a> and <a href="/news/phones">a report</a> say.</p>
        <input id="pt-input" value="Americans check their phones 96 times a day" style="width: 420px">
        <input id="pt-password" type="password" value="correct horse battery staple">
        <textarea id="pt-area">Goldfish have a 3-second memory, people say.</textarea>
        <div contenteditable="true" id="pt-editable">Humans use only 10% of their brains, they claim.</div>
      </section><div style="height: 1200px"></div>`);
      document.documentElement.style.scrollBehavior = "auto";
      document.getElementById("echo-popup-test").scrollIntoView({ block: "start", behavior: "instant" });
      const realAttach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) { const shadowRoot = realAttach.call(this, init); if (this.localName === "echo-selection-popup") window.__echoShadow = shadowRoot; return shadowRoot; };
      window.__echoSent = [];
      window.__echoListeners = {};
      window.chrome = {
        storage: { sync: { get: async (defaults) => ({ ...defaults }) }, onChanged: { addListener: (fn) => { window.__echoListeners.changed = fn; } } },
        runtime: { sendMessage: async (message) => { window.__echoSent.push(message); }, onMessage: { addListener: (fn) => { window.__echoListeners.message = fn; } } },
      };
    });
    await popupPage.addScriptTag({ content: fs.readFileSync(path.join(extDir, "echo-link.js"), "utf8") });
    await popupPage.addScriptTag({ content: fs.readFileSync(path.join(extDir, "content.js"), "utf8") });
    const shown = () => popupPage.evaluate(() => { const host = document.querySelector("echo-selection-popup"); if (!host || getComputedStyle(host).display === "none") return null; const box = window.__echoShadow.querySelector(".bar").getBoundingClientRect(); const links = window.__echoShadow.querySelector(".links"); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, position: getComputedStyle(host).position, links: links.hidden ? null : links.textContent, open: host.shadowRoot !== null }; });
    // Drags across the first line of an element, as a reader selects, and reports the selection's last line box.
    const dragSelect = async (selector, width = 360) => {
      const line = await popupPage.evaluate((wanted) => { const range = document.createRange(); range.selectNodeContents(document.querySelector(wanted)); const box = range.getClientRects()[0]; return { x: box.left, y: box.top + box.height / 2 }; }, selector);
      await popupPage.mouse.move(line.x + 1, line.y);
      await popupPage.mouse.down();
      await popupPage.mouse.move(line.x + width, line.y, { steps: 6 });
      await popupPage.mouse.up();
      await popupPage.waitForTimeout(120);
      return popupPage.evaluate(() => { const rects = [...window.getSelection().getRangeAt(0).getClientRects()].filter((rect) => rect.width || rect.height); const last = rects[rects.length - 1]; return { right: last.right, bottom: last.bottom, text: window.getSelection().toString() }; });
    };
    const heightBefore = await popupPage.evaluate(() => document.documentElement.scrollHeight);
    const selected = await dragSelect("#pt-claim");
    const popupBox = await shown();
    const heightAfter = await popupPage.evaluate(() => document.documentElement.scrollHeight);
    if (!popupBox || popupBox.position !== "fixed" || popupBox.open || Math.abs(popupBox.right - selected.right) > 2 || popupBox.top < selected.bottom || popupBox.top > selected.bottom + 14 || heightAfter !== heightBefore || popupBox.links) fail(`the pop-up after selecting “${selected.text}”: ${JSON.stringify({ popupBox, selected, heightBefore, heightAfter })}`);
    else ok(`selecting “${selected.text.slice(0, 40)}…” shows the pop-up at the selection's end (right edge on it, ${Math.round(popupBox.top - selected.bottom)} px below), fixed, in a closed shadow root, with no layout shift; no Check links without links`);
    await popupPage.screenshot({ path: path.join(os.tmpdir(), "echo-smoke-popup.png") }).catch(() => undefined);
    await popupPage.keyboard.press("Escape");
    await popupPage.waitForTimeout(80);
    const afterEscape = await shown();
    await dragSelect("#pt-claim");
    await popupPage.evaluate(() => window.scrollBy({ top: -40, behavior: "instant" }));
    await popupPage.waitForTimeout(120);
    const afterScroll = await shown();
    await dragSelect("#pt-claim");
    await popupPage.mouse.click(1050, 880);
    await popupPage.waitForTimeout(80);
    const afterClickAway = await shown();
    if (afterEscape || afterScroll || afterClickAway) fail(`the pop-up stayed after Escape (${Boolean(afterEscape)}), a scroll (${Boolean(afterScroll)}) or a click elsewhere (${Boolean(afterClickAway)})`);
    else ok("Escape, a scroll and a click elsewhere each hide the pop-up");
    // A page script cannot press it: el.click() and a dispatched click on the host send nothing.
    await dragSelect("#pt-claim");
    await popupPage.evaluate(() => { const host = document.querySelector("echo-selection-popup"); host.click(); host.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); window.__echoShadow.querySelector(".trace").click(); });
    await popupPage.waitForTimeout(80);
    const forged = await popupPage.evaluate(() => window.__echoSent.length);
    // A person's click on Trace sends the selection, once.
    const traceAt = await popupPage.evaluate(() => { const box = window.__echoShadow.querySelector(".trace").getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });
    await popupPage.mouse.click(traceAt.x, traceAt.y);
    await popupPage.waitForTimeout(80);
    const sent = await popupPage.evaluate(() => window.__echoSent);
    const hiddenAfterClick = !(await shown());
    if (forged || sent.length !== 1 || sent[0].type !== "echo:popup" || sent[0].action !== "trace" || !sent[0].text.startsWith("Americans check their phones") || !hiddenAfterClick) fail(`the pop-up's Trace: ${forged} forged clicks sent; a real click sent ${JSON.stringify(sent)}`);
    else ok("a page script's click sends nothing; a real click on Trace sends the selection once and hides the pop-up");
    // Links: the selection's <a href>s count, resolved, and the pop-up offers Check links.
    await popupPage.evaluate(() => { window.__echoSent.length = 0; });
    await popupPage.locator("#pt-links").click({ clickCount: 3 });
    await popupPage.waitForTimeout(120);
    const withLinks = await shown();
    const linksAt = await popupPage.evaluate(() => { const box = window.__echoShadow.querySelector(".links").getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });
    await popupPage.mouse.click(linksAt.x, linksAt.y);
    await popupPage.waitForTimeout(80);
    const linkSent = await popupPage.evaluate(() => window.__echoSent[0] ?? null);
    if (withLinks?.links !== "Check 2 links" || linkSent?.action !== "links" || !linkSent.pageLinks.includes("https://www.asurion.com/press-releases/phones-96#top") || !linkSent.pageLinks.includes(`${base}/news/phones`)) fail(`the pop-up on a selection with 2 links: ${JSON.stringify({ withLinks, linkSent })}`);
    else ok("on a selection with 2 links the pop-up offers “Check 2 links”, which sends both addresses, resolved");
    // Never in a text field, password field, text area or editable area, by mouse or by the shortcut.
    const inFields = [];
    for (const selector of ["#pt-input", "#pt-password", "#pt-area", "#pt-editable"]) {
      await popupPage.locator(selector).click({ clickCount: 3 });
      await popupPage.waitForTimeout(120);
      const reply = await popupPage.evaluate(() => new Promise((resolve) => { window.__echoListeners.message({ type: "echo:get-selection" }, {}, resolve); }));
      if ((await shown()) || reply) inFields.push(selector);
    }
    if (inFields.length) fail(`the pop-up or the shortcut took a selection inside ${inFields.join(", ")}`);
    else ok("no pop-up, and nothing for the shortcut, in a text field, password field, text area or editable area");
    // The shortcut's question (background.js asks the page): the current selection, by the same rules.
    await dragSelect("#pt-claim");
    const shortcutReply = await popupPage.evaluate(() => new Promise((resolve) => { window.__echoListeners.message({ type: "echo:get-selection" }, {}, resolve); }));
    if (!shortcutReply?.text?.startsWith("Americans check their phones")) fail(`the shortcut's selection: ${JSON.stringify(shortcutReply)}`);
    else ok("the keyboard shortcut gets the page's selection from the pop-up script");
    // Switched off on the options page: no pop-up.
    await popupPage.evaluate(() => window.__echoListeners.changed({ echoPopup: { newValue: false } }, "sync"));
    await dragSelect("#pt-claim");
    const whenOff = await shown();
    await popupPage.evaluate(() => window.__echoListeners.changed({ echoPopup: { newValue: true } }, "sync"));
    if (whenOff) fail("the pop-up showed with its switch off");
    else ok("with the switch off on the options page, selecting shows no pop-up");
    if (popupErrors.length) fail(`pop-up page errors: ${popupErrors.join(" | ")}`);
    await popupPage.close();

    // The side panel page (sidepanel.js), served as the browser would, framing a stand-in Echo that answers the
    // handshake. The job is taken once; the start goes only to the Echo origin, only after its frame says ready.
    process.stdout.write("\nSide panel handshake (extension/sidepanel.js, stand-in chrome API and Echo)\n");
    const panelPage = await context.newPage();
    const stubEcho = "http://echo-stub.test";
    await panelPage.route(`${extOrigin}/**`, (route) => {
      const file = path.join(extDir, new URL(route.request().url()).pathname);
      if (!file.startsWith(extDir) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[path.extname(file)] ?? "application/octet-stream";
      return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
    });
    await panelPage.route(`${stubEcho}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><body>stub echo<script>
      window.__got = [];
      const nonce = "0123456789abcdef0123456789abcdef";
      addEventListener("message", (event) => { window.__got.push({ data: event.data, origin: event.origin }); });
      window.__ready = () => parent.postMessage({ type: "echo:embed-ready", nonce }, "*");
      window.__ready();
    </script></body>` }));
    await panelPage.addInitScript((echoSite) => {
      const jobs = JSON.parse(sessionStorage.getItem("__jobs") ?? "{}");
      window.__opened = [];
      window.chrome = {
        storage: {
          sync: { get: async (defaults) => ({ ...defaults, echoSite }) },
          session: { get: async (key) => ({ [key]: jobs[key] }), remove: async (key) => { delete jobs[key]; sessionStorage.setItem("__jobs", JSON.stringify(jobs)); } },
          onChanged: { addListener: () => {} },
        },
        tabs: { create: async (options) => { window.__opened.push(options.url); } },
        runtime: { openOptionsPage: async () => {} },
      };
    }, stubEcho);
    await panelPage.setViewportSize({ width: 400, height: 800 });
    const panelWith = async (job) => {
      await panelPage.goto(`${extOrigin}/options.html`);
      await panelPage.evaluate((value) => sessionStorage.setItem("__jobs", JSON.stringify(value ? { echoJob: value } : {})), job);
      await panelPage.goto(`${extOrigin}/sidepanel.html`);
      await panelPage.waitForTimeout(600);
      const frame = panelPage.frames().find((entry) => entry.url().startsWith(stubEcho));
      return { src: await panelPage.locator("#echo").getAttribute("src"), got: frame ? await frame.evaluate(() => window.__got) : null, frame, notice: (await panelPage.locator("#notice").isVisible()) ? await panelPage.locator("#notice").innerText() : "" };
    };
    const claimJob = { kind: "trace", claim: "Goldfish have a 3-second memory", id: "job-1", at: Date.now() };
    const first = await panelWith(claimJob);
    await first.frame?.evaluate(() => window.__ready());
    await panelPage.evaluate(() => window.postMessage({ type: "echo:embed-ready", nonce: "0123456789abcdef0123456789abcdef" }, "*"));
    await panelPage.waitForTimeout(200);
    const gotAfterReplays = first.frame ? await first.frame.evaluate(() => window.__got) : null;
    const starts = (gotAfterReplays ?? []).filter((entry) => entry.data?.type === "echo:embed-start");
    if (first.src !== `${stubEcho}/embed?claim=${encodeURIComponent(claimJob.claim)}` || starts.length !== 1 || starts[0].origin !== extOrigin || starts[0].data.nonce !== "0123456789abcdef0123456789abcdef" || starts[0].data.claim !== claimJob.claim || "urls" in starts[0].data) fail(`the side panel's handshake: src ${first.src}, Echo got ${JSON.stringify(gotAfterReplays)}`);
    else ok("the side panel frames /embed?claim= on the configured Echo and answers its ready message once, with Echo's nonce and the job");
    const reopened = await panelWith(null);
    const stale = await panelWith({ ...claimJob, id: "job-2", at: Date.now() - 3 * 60_000 });
    const linksJob = await panelWith({ kind: "links", claim: "Americans check their phones 96 times a day", urls: ["https://a.example/one", "https://b.example/two"], id: "job-3", at: Date.now() });
    const noSentence = await panelWith({ kind: "links", claim: "", urls: ["https://a.example/one"], id: "job-4", at: Date.now() });
    const nothing = await panelWith({ kind: "none", id: "job-5", at: Date.now() });
    const startsIn = (entry) => (entry.got ?? []).filter((message) => message.data?.type === "echo:embed-start");
    if (reopened.src !== `${stubEcho}/embed` || startsIn(reopened).length || stale.src !== `${stubEcho}/embed` || startsIn(stale).length) fail(`a reopened panel (${reopened.src}, ${startsIn(reopened).length} starts) or a 3-minute-old job (${stale.src}, ${startsIn(stale).length} starts) started a run`);
    else ok("reopening the panel, or a job older than two minutes, opens Echo empty and starts nothing");
    if (JSON.stringify(startsIn(linksJob)[0]?.data.urls) !== JSON.stringify(["https://a.example/one", "https://b.example/two"]) || !/\/embed\?urls=/.test(linksJob.src) || startsIn(noSentence).length || !/\/embed\?urls=/.test(noSentence.src)) fail(`the side panel's links jobs: ${JSON.stringify({ links: startsIn(linksJob), noSentence: startsIn(noSentence), src: noSentence.src })}`);
    else ok("a links job sends its links; one with no sentence only fills the panel and waits for the reader");
    if (startsIn(nothing).length || !/Select a sentence first/.test(nothing.notice)) fail(`the shortcut with nothing selected: ${JSON.stringify(nothing.notice)}, ${startsIn(nothing).length} starts`);
    else ok("the shortcut with nothing selected shows “Select a sentence first” and starts nothing");
    // The real Echo here lists no extension, so it refuses the frame: after the wait the panel says what to add.
    await panelPage.unroute(`${stubEcho}/**`);
    await panelPage.addInitScript((echoSite) => { window.chrome.storage.sync.get = async (defaults) => ({ ...defaults, echoSite }); }, base);
    const refused = await panelWith({ ...claimJob, id: "job-6", at: Date.now() });
    await panelPage.locator("#notice-title").filter({ hasText: "Echo did not open here" }).waitFor({ timeout: 20_000 }).catch(() => undefined);
    const refusedNotice = await panelPage.locator("#notice").innerText().catch(() => "");
    const echoFrame = panelPage.frames().find((entry) => entry.url().startsWith(`${base}/embed`));
    const framedText = echoFrame ? await echoFrame.evaluate(() => document.body?.innerText ?? "").catch(() => "") : "";
    if (!/Echo did not open here/.test(refusedNotice) || !refusedNotice.includes(`ECHO_EXTENSION_ORIGINS=${extOrigin}`) || /SIDE PANEL|CLAIM TO TRACE/.test(framedText) || refused.src !== `${base}/embed?claim=${encodeURIComponent(claimJob.claim)}`) fail(`a side panel on an Echo that lists no extension: notice "${refusedNotice}", frame shows "${framedText.slice(0, 80)}"`);
    else ok("an Echo that lists no extension refuses the frame (frame-ancestors 'none'); the panel says which ECHO_EXTENSION_ORIGINS line to add");
    await panelPage.close();
  }

  process.stdout.write("\nWatch the echo spread\n");
  {
    const entry = slots[0];
    const analysis = summaryOf(entry.trace);
    const today = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const dated = analysis.pages.filter((p) => p.publishedDate && p.publishedDateSource && p.publishedDateSource !== "Tavily estimate" && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(p.publishedDate) && p.publishedDate <= today);
    currentClaim = analysis.claim;
    await page.goto(`${base}/?slot=${entry.slot}`);
    await waitForText(`${analysis.summary.totalPages} pages`);
    const spread = page.locator("section[aria-label='Watch the echo spread']");
    const dots = await spread.locator("circle").count();
    if (dots !== dated.length) fail(`the spread shows ${dots} dots, the trace has ${dated.length} reliably dated pages`);
    else ok(`the spread plots all ${dots} reliably dated pages and no others`);
    await spread.locator("button").click();
    await page.waitForTimeout(1_200);
    const mid = await spread.locator("h3").innerText();
    const midDots = await spread.locator("circle").count();
    if (!/so far$/.test(mid) || midDots >= dots) fail(`Play did not sweep the years (heading "${mid}", ${midDots} of ${dots} dots)`);
    else ok(`Play sweeps the years ("${mid}", ${midDots} of ${dots} pages shown)`);
    await page.waitForFunction(() => !document.querySelector("section[aria-label='Watch the echo spread'] h3")?.textContent?.endsWith("so far"), null, { timeout: 12_000 }).catch(() => undefined);
    if ((await spread.locator("circle").count()) !== dots) fail("after playing, the spread does not return to every page");
    else ok("after playing, every page is back");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await spread.locator("button").click();
    const reduced = await spread.locator("h3").innerText();
    if (/so far$/.test(reduced) || (await spread.locator("circle").count()) !== dots) fail("with reduced motion, Play still animates");
    else ok("with reduced motion, Play shows the whole spread at once");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // Opening another trace mid-Play stops the old sweep; the new trace shows its own pages, not "so far".
    await spread.locator("button").click();
    await page.waitForTimeout(600);
    const other = backups[0];
    const otherAnalysis = summaryOf(other.trace);
    const otherDated = otherAnalysis.pages.filter((p) => p.publishedDate && p.publishedDateSource && p.publishedDateSource !== "Tavily estimate" && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(p.publishedDate) && p.publishedDate <= today).length;
    currentClaim = otherAnalysis.claim;
    await page.locator(".backup-chip", { hasText: other.label }).click();
    await waitForText(`${otherAnalysis.summary.totalPages} pages`);
    await page.waitForTimeout(800);
    const afterSwap = { heading: await spread.locator("h3").innerText(), dots: await spread.locator("circle").count() };
    if (/so far$/.test(afterSwap.heading) || afterSwap.dots !== otherDated) fail(`after opening another trace mid-Play: "${afterSwap.heading}", ${afterSwap.dots} of ${otherDated} dots`);
    else ok("opening another trace mid-Play stops the sweep and shows the new trace's pages");
    currentClaim = analysis.claim;
    await page.goto(`${base}/?slot=${entry.slot}`);
    await waitForText(`${analysis.summary.totalPages} pages`);
    const target = dated[0];
    await spread.locator("circle").first().click();
    const detail = await page.locator(".map-layout .detail-card").innerText().catch(() => "");
    if (!detail.includes(target.title.slice(0, 30))) fail(`clicking the earliest dot did not open "${target.title.slice(0, 40)}"`);
    else ok("clicking a dot opens that page's details");
    await page.setViewportSize({ width: 390, height: 844 });
    await spread.scrollIntoViewIfNeeded();
    const dotWidth = await spread.locator("circle").first().evaluate((node) => node.getBoundingClientRect().width);
    await page.setViewportSize({ width: 1360, height: 900 });
    if (dotWidth < 12) fail(`on a 390 px phone a spread dot is ${dotWidth.toFixed(1)} px wide (under 12)`);
    else ok(`on a 390 px phone a spread dot is ${dotWidth.toFixed(0)} px wide`);
  }

  process.stdout.write("\nAccuracy card honesty\n");
  for (const entry of [...slots, ...backups]) {
    const analysis = summaryOf(entry.trace);
    const score = DEMO_SCORES[entry.trace];
    if (!score) continue;
    const link = slots.includes(entry) ? `/?slot=${entry.slot}` : `/?trace=${entry.trace.split("/").pop().replace(/\.echo\.json$/, "")}`;
    currentClaim = analysis.claim;
    await page.goto(`${base}${link}`);
    await waitForText(`${analysis.summary.totalPages} pages`);
    await page.locator(".accuracy-card summary").click();
    const body = await page.locator(".accuracy-card .coverage-body").innerText();
    const expected = score.matched >= analysis.summary.totalPages ? "Every page in this saved trace was labeled" : `${score.matched} of its ${analysis.summary.totalPages} pages were labeled`;
    const summaryLine = await page.locator(".accuracy-card summary").innerText();
    if (!body.includes(expected)) fail(`${link}: the accuracy card does not say "${expected}"`);
    else if (!/match AI-made labels/.test(summaryLine)) fail(`${link}: the accuracy card's summary line hides that the labels are AI-made ("${summaryLine.replace(/\s+/g, " ")}")`);
    else ok(`${link}: the accuracy card says "${expected}", and its summary line says the labels are AI-made`);
  }
  {
    // A confirmed copy's details call the confidence Claude's own guess, not a measurement.
    const entry = slots.find((slot) => summaryOf(slot.trace).pages.some((p) => p.judgment.kind === "derived"));
    const analysis = summaryOf(entry.trace);
    const copy = analysis.pages.find((p) => p.judgment.kind === "derived");
    currentClaim = analysis.claim;
    await page.goto(`${base}/?slot=${entry.slot}`);
    await waitForText(`${analysis.summary.totalPages} pages`);
    await page.locator(`[aria-label^="${copy.title.replace(/"/g, '\\"')}, derived source"]`).first().click();
    const row = await page.locator(".map-layout .detail-card .confidence-row").innerText({ timeout: 3_000 }).catch(() => "");
    if (!row.includes("Claude's confidence (self-reported, not measured)") || !row.includes(`${copy.judgment.confidence}%`)) fail(`a copy's details show "${row.replace(/\s+/g, " ")}"`);
    else ok(`a copy's details read "${row.replace(/\s+/g, " ")}"`);
    // Its details say in plain words what Echo saw on the link, from the two pages' own facts; a dashed link says nothing.
    const parentPage = analysis.pages.find((p) => p.id === copy.judgment.parentId);
    const facts = await page.locator(".map-layout .detail-card .edge-sentence").innerText({ timeout: 3_000 }).catch(() => "");
    const unclearPage = analysis.pages.find((p) => p.judgment.kind === "unclear" && p.judgment.parentId);
    let unclearFacts = 0;
    if (unclearPage) {
      await page.locator(`[aria-label^="${unclearPage.title.replace(/"/g, '\\"')}, relationship unclear"]`).first().click();
      await page.locator(".map-layout .detail-card h3", { hasText: unclearPage.title.slice(0, 20) }).waitFor({ timeout: 3_000 }).catch(() => undefined);
      unclearFacts = await page.locator(".map-layout .detail-card .edge-sentence").count();
    }
    if (!facts.includes(copy.domain.replace(/^www\./, "")) || !facts.includes(parentPage.domain.replace(/^www\./, "")) || /copied|proof/i.test(facts) || unclearFacts) fail(`a copy's plain-words link note: "${facts.replace(/\s+/g, " ")}"; on a dashed link ${unclearFacts} notes`);
    else ok(`a copy's details say what Echo saw: "${facts.replace(/^WHAT ECHO SAW ON THIS LINK\s*/, "").replace(/\s+/g, " ")}"; a dashed link shows none`);
  }

  process.stdout.write("\nExplore gallery\n");
  {
    await page.goto(`${base}/explore`);
    const cards = await page.locator("main li").evaluateAll((items) => items.map((item) => {
      const plain = item.querySelector("[class*='plainSearch']");
      const verdict = item.querySelector("[class*='verdict']")?.getBoundingClientRect();
      const rect = plain?.getBoundingClientRect();
      return { text: item.textContent ?? "", href: item.querySelector("a")?.getAttribute("href") ?? "", plain: plain?.textContent ?? "", plainShown: Boolean(rect && verdict && rect.height > 10 && rect.width > 100 && rect.top >= verdict.bottom - 1) };
    }));
    const expected = [...slots, ...backups];
    if (cards.length !== expected.length + 1) fail(`the gallery shows ${cards.length} cards, expected ${expected.length} traces and the saved check`);
    else ok(`the gallery shows all ${expected.length} bundled traces and the saved check`);
    {
      // The saved Check these sources run: counted in supplied links, with no echo rate and no page count.
      const check = summaryOf(SAVED_CHECK_TRACE);
      const card = cards.find((candidate) => candidate.href === "/?trace=check-these-sources-phones");
      const head = `${check.sourceCheck.urls.length} supplied links → ${check.summary.independentOrigins} independent origin`;
      if (!card || !card.text.includes(head) || /echo rate|\d+%/.test(card.text) || /\bpages\b/.test(card.text) || !card.text.includes("no web search")) fail(`the saved check's gallery card reads "${card?.text.replace(/\s+/g, " ") ?? "nothing"}"`);
      else ok(`the saved check's card says "${head}" with no echo rate and no page count, and links to ${card.href}`);
    }
    for (const entry of expected) {
      const analysis = summaryOf(entry.trace);
      const card = cards.find((candidate) => candidate.text.includes(analysis.claim));
      if (!card) { fail(`no gallery card for "${analysis.claim}"`); continue; }
      if (!card.text.includes(`${analysis.summary.totalPages}`) || !card.text.includes(`${analysis.summary.echoPercentage}%`)) fail(`the "${analysis.claim}" card's figures do not match its trace`);
      // The same plain-search line as the trace page, under the card's verdict.
      const wantPlain = expectedLines[slugOf(entry.trace)]?.primary;
      if (!wantPlain || card.plain !== wantPlain || !card.plainShown) fail(`the "${analysis.claim}" card's plain-search line reads "${card.plain}" (shown under the verdict: ${card.plainShown})`);
      else ok(`the "${analysis.claim}" card says "${card.plain}"`);
      await openAndCheck({ click: () => page.goto(`${base}${card.href}`) }, entry, `gallery card ${card.href}`);
      await page.goto(`${base}/explore`);
    }
    await page.goto(base);
    if (!(await page.locator(".page-footer a[href='/explore']").count())) fail("the footer does not link to the gallery");
    else ok("the footer links to the gallery");
  }

  process.stdout.write("\nHow Echo works (/how)\n");
  {
    // Four panels illustrated with the bundled phones run's own pages and dates, each linking to its slot; one screen
    // at 1280x720, no sideways scrolling on a phone.
    const entry = slots.find((slot) => slot.id === "phones");
    const analysis = summaryOf(entry.trace);
    const byId = new Map(analysis.pages.map((p) => [p.id, p]));
    const bare = (p) => p.domain.replace(/^www\./, "");
    const copy = analysis.pages.find((p) => p.judgment.kind === "derived" && byId.has(p.judgment.parentId) && p.publishedDate && p.publishedDateSource);
    const wanted = [
      analysis.searchAudit[0].pageIds.map((id) => bare(byId.get(id))),
      analysis.clusters.map((cluster) => cluster.label).slice(0, 1),
      [bare(copy), bare(byId.get(copy.judgment.parentId))],
      analysis.roots.map((id) => bare(byId.get(id))),
    ];
    await page.goto(base);
    const heroHow = await page.locator(".hero a[href='/how']").count();
    await page.goto(`${base}/explore`);
    const exploreHow = await page.locator("main a[href='/how']").count();
    if (!heroHow || !exploreHow) fail(`links to /how: hero ${heroHow}, Explore ${exploreHow}`);
    else ok("the hero and the Explore page link to /how");
    for (const [width, height] of [[390, 844], [1280, 720]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/how`);
      const shown = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        panels: [...document.querySelectorAll("main ol > li")].map((li) => {
          const rect = li.getBoundingClientRect();
          return { text: li.textContent ?? "", left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, links: [...li.querySelectorAll("a")].map((a) => a.getAttribute("href")) };
        }),
        limits: document.querySelector("main section[aria-labelledby='limits']")?.textContent ?? "",
        check: document.querySelector("main section[aria-labelledby='check']")?.textContent ?? "",
        checkLink: document.querySelector("main section[aria-labelledby='check'] a")?.getAttribute("href") ?? "",
        lede: document.querySelector("main h1 + p")?.textContent ?? "",
      }));
      const problems = [];
      if (shown.overflow > 0) problems.push(`${shown.overflow} px of sideways scroll`);
      if (shown.panels.length !== 4) problems.push(`${shown.panels.length} panels`);
      shown.panels.forEach((panel, index) => {
        if (panel.left < 0 || panel.right > width + 0.5) problems.push(`panel ${index + 1} spans ${Math.round(panel.left)}-${Math.round(panel.right)} px`);
        if (width >= 1280 && (panel.top < 0 || panel.bottom > height)) problems.push(`panel ${index + 1} is not on the first screen (${Math.round(panel.top)}-${Math.round(panel.bottom)} px)`);
        if (!panel.links.includes(`/?slot=${entry.slot}`)) problems.push(`panel ${index + 1} does not link to ?slot=${entry.slot}`);
        const missing = (wanted[index] ?? []).filter((text) => !panel.text.includes(text));
        if (missing.length) problems.push(`panel ${index + 1} lacks ${missing.join(", ")}`);
      });
      if (!shown.lede.includes(analysis.claim.replace(/\.$/, ""))) problems.push(`the lede does not name the claim: "${shown.lede}"`);
      for (const limit of ["AI-made", "scoped to the pages Echo found", "citation is not proof", "Tavily", analysis.searchAudit[0].query.replace(/\.$/, "")]) {
        if (!shown.limits.includes(limit)) problems.push(`the limits lack "${limit}"`);
      }
      for (const limit of ["possible copy", "Results vary between runs", "No comparison with Google"]) {
        if (!shown.limits.includes(limit)) problems.push(`the limits lack "${limit}"`);
      }
      // Step 01 names the search router honestly: Telem only with a Telem key, Tavily otherwise, and which this run used.
      const routed = analysis.searchAudit.some((entry) => entry.status === "searched" && entry.router === "telem") ? "Telem" : "Tavily";
      if (!/Telem/.test(shown.panels[0]?.text ?? "") || !(shown.panels[0]?.text ?? "").includes(`this run: ${routed}`)) problems.push(`step 01 does not say how searches are routed (this run: ${routed})`);
      // The Check these sources flow: supplied links only, no new search, the saved check's own headline and link.
      const savedCheck = summaryOf(SAVED_CHECK_TRACE);
      const checkHead = `${savedCheck.sourceCheck.urls.length} supplied links → ${savedCheck.summary.independentOrigins} independent origin`;
      if (!shown.check.includes("no new search") || !shown.check.includes("Cite once") || !shown.check.includes(checkHead) || shown.checkLink !== "/?trace=check-these-sources-phones") problems.push(`the check section reads "${shown.check.slice(0, 160)}…", links ${shown.checkLink}`);
      if (problems.length) fail(`/how at ${width}x${height}: ${problems.join("; ")}`);
      else ok(`/how at ${width}x${height}: 4 panels in view, no sideways scroll, each with the phones run's own pages and a ?slot=${entry.slot} link; step 01 names the search router; the check section shows the saved check's headline; the limits name possible copies, run-to-run variation and no Google comparison`);
    }
    {
      // Step 02's groups add up to every page, step 03's copies to every confirmed copy (a muted "+N more" row ends each).
      const lists = await page.evaluate(() => [...document.querySelectorAll("main ol > li")].map((li) => [...li.querySelectorAll("ul > li")].map((row) => row.textContent ?? "")));
      const grouped = (lists[1] ?? []).reduce((total, row) => total + Number((row.match(/(\d+) pages?/) ?? [0, 0])[1]), 0);
      const copiesShown = (lists[2] ?? []).filter((row) => row.includes(" repeats ")).length;
      const moreCopies = Number(((lists[2] ?? []).join(" ").match(/\+(\d+) more cop/) ?? [0, 0])[1]);
      const derived = analysis.pages.filter((p) => p.judgment.kind === "derived").length;
      const groupedPages = analysis.clusters.reduce((total, cluster) => total + cluster.pageIds.length, 0);
      const moreRow = (lists[2] ?? []).find((row) => row.startsWith("+")) ?? "";
      if (grouped !== groupedPages || copiesShown + moreCopies !== derived) fail(`/how: step 02 lists ${grouped} of ${groupedPages} grouped pages, step 03 ${copiesShown}+${moreCopies} of ${derived} copies`);
      else ok(`/how: step 02 adds up to ${grouped} pages, step 03 to ${derived} copies ("${moreRow}")`);
    }
    await page.setViewportSize({ width: 1360, height: 900 });
    currentClaim = analysis.claim;
    await openAndCheck({ click: () => page.locator("main ol > li").last().locator(`a[href='/?slot=${entry.slot}']`).click() }, entry, `/how's last panel link`);
  }

  process.stdout.write("\nText report\n");
  {
    // The copied and the downloaded report carry the trace page's plain-search line right after the verdict.
    const entry = slots[1] ?? slots[0];
    const analysis = summaryOf(entry.trace);
    const wantPlain = expectedLines[slugOf(entry.trace)].primary;
    currentClaim = analysis.claim;
    await page.goto(`${base}/?slot=${entry.slot}`);
    await waitForText(`${analysis.summary.totalPages} pages`);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await resultAction("Copy report");
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    const downloadEvent = page.waitForEvent("download", { timeout: 5_000 }).catch(() => null);
    await resultAction("Download");
    const download = await downloadEvent;
    const downloadedPath = download ? await download.path().catch(() => null) : null;
    const downloaded = downloadedPath ? fs.readFileSync(downloadedPath, "utf8") : "";
    for (const [how, text] of [["copied", copied], ["downloaded", downloaded]]) {
      const lines = text.split("\n");
      const at = lines.findIndex((line) => line.startsWith("Verdict: "));
      if (at < 0 || lines[at + 1] !== wantPlain) fail(`slot ${entry.slot}'s ${how} report: after "${lines[at] ?? "no verdict"}" comes "${lines[at + 1] ?? ""}"`);
      else ok(`slot ${entry.slot}'s ${how} report says "${wantPlain}" right after the verdict`);
      // QA round 5 (S3-9): the query audit lines read "1 new pages".
      const oneNew = analysis.searchAudit.filter((audit) => audit.uniquePagesAdded === 1).length;
      const singular = lines.filter((line) => /, 1 new page(?: \(|$)/.test(line)).length;
      if (/\b1 new pages\b/.test(text) || singular !== oneNew) fail(`slot ${entry.slot}'s ${how} report: "1 new pages" or ${singular} of ${oneNew} single-page query lines read "1 new page"`);
      else if (how === "copied") ok(`slot ${entry.slot}'s report says "1 new page" (singular) on its ${oneNew} single-page query lines`);
      // QA #4: roots published together print one [ORIGIN] and, for each other page, "[ORIGIN · published together
      // with <the first>]", as the tree tags them, so the report never lists more plain origins than the verdict counts.
      const tagged = lines.filter((line) => /^\d+\. \[ORIGIN[\] ·]/.test(line));
      const plainOrigins = tagged.filter((line) => /^\d+\. \[ORIGIN\]/.test(line)).length;
      const together = tagged.filter((line) => line.includes("[ORIGIN · published together with asurion.com]"));
      if (plainOrigins !== analysis.summary.independentOrigins || together.length !== 1 || !together[0].includes("prnewswire.com")) fail(`slot ${entry.slot}'s ${how} report tags ${plainOrigins} plain [ORIGIN] pages for ${analysis.summary.independentOrigins} independent origins; published-together lines: ${JSON.stringify(together)}`);
      else ok(`slot ${entry.slot}'s ${how} report: ${plainOrigins} [ORIGIN] pages for ${plainOrigins} independent origins, and PR Newswire reads "[ORIGIN · published together with asurion.com]"`);
      // QA #3: a root published together with another, whose saved evidence predates Echo's pair note, gets the note
      // first (the bundled trace is not edited), so its evidence never reads as if it were a separate origin.
      const pairNote = "Relationship evidence: Published together with prnewswire.com: Echo counts them as one independent origin. ";
      const noted = lines.filter((line) => line.trim().startsWith(pairNote.trim()));
      if (noted.length !== 1) fail(`slot ${entry.slot}'s ${how} report: ${noted.length} evidence lines start with the asurion.com pair note`);
      else ok(`slot ${entry.slot}'s ${how} report: asurion.com's evidence starts "${pairNote.trim()}"`);
    }
    // QA #8: comparing this web-search run with a supplied-links run of the same claim says one searched the web and
    // the other read only the links (here the same trace, saved as if its pages had been pasted as links).
    {
      const asSources = JSON.parse(fs.readFileSync(path.join(root, "public", entry.trace), "utf8"));
      delete asSources.analysis.searchAudit;
      asSources.analysis.sourceCheck = { urls: asSources.analysis.pages.map((entryPage) => entryPage.url) };
      asSources.analysis.createdAt = new Date(Date.parse(asSources.analysis.createdAt) + 86_400_000).toISOString();
      await page.locator('input[aria-label="Select a saved Echo trace to compare"]').setInputFiles({ name: "phones-sources.echo.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(asSources)) });
      const note = await page.locator(".trace-comparison-mode-note").innerText({ timeout: 5_000 }).catch(() => "");
      const wantNote = "The current run searched the web; the saved run read only the supplied links (no web search). Their pages and counts are not like for like.";
      if (note.trim() !== wantNote) fail(`comparing slot ${entry.slot} with a supplied-links run: the note reads "${note.trim()}"`);
      else ok(`comparing slot ${entry.slot} with a supplied-links run says "${wantNote}"`);
      // QA round 4 D6: the supplied-links side shows no echo rate, as its own result does not.
      const rate = await page.locator(".trace-comparison-metrics tr", { hasText: "Echo rate" }).locator("td").allInnerTexts().catch(() => []);
      const wantRate = [`${analysis.summary.echoPercentage}%`, "— (not shown for supplied links)"];
      if (JSON.stringify(rate.map((cell) => cell.trim())) !== JSON.stringify(wantRate)) fail(`comparing slot ${entry.slot} with a supplied-links run: Echo rate reads ${JSON.stringify(rate)}`);
      else ok(`and its Echo rate row reads "${wantRate.join(" / ")}" (no rate for the supplied links)`);
      await page.locator('button[aria-label="Close trace comparison"]').click().catch(() => undefined);
    }
  }

  process.stdout.write("\nResult toolbar\n");
  {
    // The first row keeps Present, Copy link and New trace; the rest sit in a More disclosure that the keyboard can
    // open, Tab into, and close with Esc (focus back on More); a click outside or Tab past its end closes it too.
    const entry = slots[1] ?? slots[0];
    const analysis = summaryOf(entry.trace);
    currentClaim = analysis.claim;
    for (const [width, height] of [[1360, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/?slot=${entry.slot}`);
      await waitForText(`${analysis.summary.totalPages} pages`);
      const visible = await page.locator(".result-actions button").evaluateAll((buttons) => buttons
        .filter((button) => button.getClientRects().length && getComputedStyle(button).visibility !== "hidden")
        .map((button) => button.textContent.replace(/[▶▾▴↗]/g, "").trim()));
      const more = page.locator(".result-more-button");
      await more.focus();
      await page.keyboard.press("Enter");
      const menuId = await more.getAttribute("aria-controls");
      const opened = await page.evaluate((id) => {
        const menu = document.getElementById(id);
        const rect = menu?.getBoundingClientRect();
        return { expanded: document.querySelector(".result-more-button")?.getAttribute("aria-expanded"), items: [...(menu?.querySelectorAll("button") ?? [])].map((button) => button.textContent.trim()), inView: Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth && rect.height > 40), overflow: document.documentElement.scrollWidth - window.innerWidth };
      }, menuId);
      await page.keyboard.press("Tab");
      const firstFocused = await page.evaluate(() => document.activeElement?.closest(".result-more-menu") ? document.activeElement.textContent.trim() : "");
      await page.keyboard.press("Escape");
      const closed = await page.evaluate(() => ({ expanded: document.querySelector(".result-more-button")?.getAttribute("aria-expanded"), menus: document.querySelectorAll(".result-more-menu").length, focusOnMore: document.activeElement === document.querySelector(".result-more-button") }));
      await page.keyboard.press(" ");
      const spaceOpens = (await more.getAttribute("aria-expanded")) === "true";
      await page.mouse.click(5, height - 5);
      const outsideCloses = (await more.getAttribute("aria-expanded")) === "false";
      await more.click();
      const lastItem = page.locator(".result-more-menu button:not(:disabled)").last();
      await lastItem.focus();
      await page.keyboard.press("Tab");
      const tabOutCloses = (await more.getAttribute("aria-expanded")) === "false";
      const problems = [];
      const wantRow = ["Present", "Copy link", "More", "New trace"];
      if (JSON.stringify(visible) !== JSON.stringify(wantRow)) problems.push(`first row shows ${JSON.stringify(visible)}`);
      if (opened.expanded !== "true" || !opened.inView || opened.overflow > 0) problems.push(`Enter on More: ${JSON.stringify(opened)}`);
      for (const item of ["Copy report", "Download report", "Embed badge", "Save trace file", "Open trace file", "Compare runs"]) if (!opened.items.includes(item)) problems.push(`More lacks ${item}`);
      if (firstFocused !== "Copy report") problems.push(`Tab from More focuses "${firstFocused}"`);
      if (closed.expanded !== "false" || closed.menus || !closed.focusOnMore) problems.push(`Esc: ${JSON.stringify(closed)}`);
      if (!spaceOpens) problems.push("Space does not open More");
      if (!outsideCloses) problems.push("a click outside leaves More open");
      if (!tabOutCloses) problems.push("Tab past the last item leaves More open");
      if (problems.length) fail(`toolbar at ${width}x${height}: ${problems.join("; ")}`);
      else ok(`toolbar at ${width}x${height}: first row is ${wantRow.join(", ")}; More opens with Enter or Space, Tab reaches its ${opened.items.length} items, Esc closes it with focus back on More, a click outside or Tab past the end closes it`);
    }
    await page.setViewportSize({ width: 1360, height: 900 });
    // Present-mode keys still work after using the menu: arrows move slides, Esc leaves; then 1 opens slot 01.
    await openMore();
    await page.locator(".present-button").click();
    await page.locator(".stage-presentation").waitFor({ timeout: 5_000 }).catch(() => undefined);
    const menuDuringPresent = await page.locator(".result-more-menu").count();
    const slideNow = () => page.locator(".stage-presentation [aria-current='step']").getAttribute("aria-label").catch(() => "");
    const before = await slideNow();
    await page.keyboard.press("ArrowRight");
    const after = await slideNow();
    await page.keyboard.press("ArrowLeft");
    const back = await slideNow();
    await page.keyboard.press("Escape");
    const stageGone = await page.locator(".stage-presentation").waitFor({ state: "detached", timeout: 5_000 }).then(() => true, () => false);
    if (menuDuringPresent || !before?.startsWith("Slide 1") || !after?.startsWith("Slide 2") || back !== before || !stageGone) fail(`Present keys after the More menu: menu ${menuDuringPresent}, slides "${before}" → "${after}" → "${back}", closed ${stageGone}`);
    else ok("after the More menu, Present opens with the menu closed, → and ← move slides, Esc closes it");
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    currentClaim = summaryOf(slots[0].trace).claim;
    await openAndCheck({ click: () => page.keyboard.press(String(Number(slots[0].slot))) }, slots[0], `after the More menu, key ${Number(slots[0].slot)} opens slot ${slots[0].slot}`);
  }

  process.stdout.write("\nPrinted report\n");
  {
    // In print media only the one-page report shows: verdict, plain-search line, origins, copies with what Echo saw
    // on each link, the answer, the AI-made-labels caveat and the trace date. No control prints.
    for (const entry of slots) {
      const analysis = summaryOf(entry.trace);
      const byId = new Map(analysis.pages.map((p) => [p.id, p]));
      const copies = analysis.pages.filter((p) => p.judgment.kind === "derived" && byId.has(p.judgment.parentId));
      currentClaim = analysis.claim;
      await page.goto(`${base}/?slot=${entry.slot}`);
      await waitForText(`${analysis.summary.totalPages} pages`);
      const headline = (await page.locator(".verdict-banner h2").innerText()).trim();
      const onScreen = await page.locator(".print-report").evaluate((node) => node.getClientRects().length).catch(() => -1);
      await page.emulateMedia({ media: "print" });
      const printed = await page.evaluate(() => {
        const report = document.querySelector(".print-report");
        const box = (selector) => { const rect = report?.querySelector(selector)?.getBoundingClientRect(); return rect ? { width: rect.width, height: rect.height, right: rect.right, left: rect.left } : null; };
        const text = (selector) => report?.querySelector(selector)?.textContent?.trim() ?? "";
        const shown = (selector) => [...document.querySelectorAll(selector)].some((node) => node.getClientRects().length > 0);
        return {
          sections: Object.fromEntries([".print-verdict", ".print-origins", ".print-copies", ".print-answer", ".print-caveat"].map((selector) => [selector, box(selector)])),
          headline: text(".print-verdict h2"),
          plain: text(".print-plain"),
          origins: report?.querySelectorAll(".print-origins li").length ?? 0,
          copies: [...(report?.querySelectorAll(".print-copies li") ?? [])].map((li) => li.textContent ?? ""),
          answer: text(".print-answer p"),
          caveat: text(".print-caveat"),
          controls: shown(".result-actions, .claim-panel, .topbar, .page-footer, button"),
          width: document.documentElement.clientWidth,
        };
      });
      const problems = [];
      if (onScreen !== 0) problems.push("the report shows on screen");
      for (const [selector, rect] of Object.entries(printed.sections)) if (!rect || rect.height < 10 || rect.left < 0 || rect.right > printed.width + 0.5) problems.push(`${selector} ${JSON.stringify(rect)}`);
      if (printed.headline !== headline) problems.push(`headline "${printed.headline}", screen "${headline}"`);
      const wantPlain = expectedLines[slugOf(entry.trace)]?.primary;
      if (printed.plain !== wantPlain) problems.push(`plain-search line "${printed.plain}"`);
      if (printed.origins !== Math.min(analysis.roots.length, 10)) problems.push(`${printed.origins} origins listed, the trace has ${analysis.roots.length}`);
      if (printed.copies.length !== Math.min(copies.length, 10)) problems.push(`${printed.copies.length} copies listed, the trace has ${copies.length}`);
      printed.copies.forEach((text, index) => {
        const copy = copies[index];
        const bare = (p) => p.domain.replace(/^www\./, "");
        if (!text.includes(bare(copy)) || !text.includes(bare(byId.get(copy.judgment.parentId))) || !/is dated after|cites|links to|names|shares/.test(text)) problems.push(`copy ${index + 1} reads "${text}"`);
      });
      if (!printed.answer.startsWith(analysis.answer.slice(0, 40))) problems.push(`answer "${printed.answer.slice(0, 60)}"`);
      if (!printed.caveat.includes("AI-made labels") || !printed.caveat.includes("not by a person") || !printed.caveat.includes("Trace date:")) problems.push(`caveat "${printed.caveat.slice(0, 80)}"`);
      if (printed.controls) problems.push("a control or the app page still prints");
      let pages = null;
      if (!headed) {
        const pdf = await page.pdf({ format: "Letter", printBackground: true }).catch(() => null);
        pages = pdf ? (pdf.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length : 0;
        if (pages !== 1) problems.push(`the report prints on ${pages} pages`);
      }
      await page.emulateMedia({ media: "screen" });
      if (problems.length) fail(`slot ${entry.slot} printed: ${problems.join("; ")}`);
      else ok(`slot ${entry.slot} prints ${pages === null ? "" : "on one page "}only the report: "${printed.headline}", the plain-search line, ${printed.origins} origins, ${printed.copies.length} copies with what Echo saw on each link, the answer, caveats and trace date`);
    }
    // More → Print report opens the browser's print dialog and closes the menu.
    await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed += 1; }; });
    await resultAction("Print report");
    const printCalls = await page.evaluate(() => window.__printed);
    const afterPrint = await page.evaluate(() => ({ expanded: document.querySelector(".result-more-button")?.getAttribute("aria-expanded"), focusOnMore: document.activeElement === document.querySelector(".result-more-button") }));
    if (printCalls !== 1 || afterPrint.expanded !== "false" || !afterPrint.focusOnMore) fail(`More → Print report: print called ${printCalls} times, ${JSON.stringify(afterPrint)}`);
    else ok("More → Print report opens the print dialog and closes the menu, focus back on More");
  }

  process.stdout.write("\nOffline (network switched off after one visit)\n");
  const cached = await page.evaluate(async (traces) => {
    await navigator.serviceWorker.ready;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const names = await caches.keys();
      let found = 0;
      for (const name of names) for (const trace of traces) if (await (await caches.open(name)).match(trace)) found += 1;
      if (found >= traces.length) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }, [...slots.map((entry) => entry.trace), ...backups.map((entry) => entry.trace), SAVED_CHECK_TRACE]);
  if (!cached) fail("the service worker did not cache every demo trace");
  else ok("the service worker cached every demo trace, the saved check too");
  {
    // The readiness panel counts what really opens offline: the bundled runs the service worker now holds. QA round 5
    // (S3-1): it read "4 / 4" and left out the saved check (cached, but it shares slot 02's claim); it lists runs by
    // trace now, the saved check as its own row.
    await page.goto(base);
    const total = slots.length + backups.length + 1;
    const readiness = await page.waitForFunction((want) => {
      const text = document.querySelector(".offline-readiness summary")?.textContent ?? "";
      return text.includes(want) ? text : false;
    }, `${total} / ${total} saved runs ready offline`, { timeout: 5_000 }).then((handle) => handle.jsonValue(), async () => page.locator(".offline-readiness summary").innerText().catch(() => "missing"));
    const shell = await page.locator(".offline-readiness .readiness-checks").textContent().catch(() => "") ?? "";
    const rows = await page.locator(".offline-readiness .readiness-cache-list > div").evaluateAll((items) => items.map((item) => [...item.children].map((child) => child.textContent.trim()).join(" ")));
    const savedRow = rows.find((row) => row.startsWith(savedCheck.label));
    if (!String(readiness).includes(`${total} / ${total} saved runs ready offline`) || !/Cached · \d+ app files/.test(shell) || rows.length !== total || savedRow !== `${savedCheck.label} Ready offline`) fail(`after caching, the readiness panel reads "${readiness}" / "${shell.replace(/\s+/g, " ")}", rows ${JSON.stringify(rows)}`);
    else ok(`after caching, the readiness panel reads "${total} / ${total} saved runs ready offline" (its row "${savedRow}") and the app shell as cached`);
  }
  // Online visits to the other pages must not replace the app shell (sw.js v8 cached every page as "/", so after
  // a look at /anywhere the slots opened /anywhere offline). The worker also precaches /how, /explore and /anywhere.
  for (const other of ["/how", "/explore", "/anywhere"]) await page.goto(`${base}${other}`);
  await page.goto(base);
  // QA round 4 D7: offline, the live-setup and copy-hunt status checks wait for the "online" event instead of sending
  // GET /api/analyze requests that can only fail.
  const offlineStatusChecks = [];
  const countStatusChecks = (request) => { if (request.url().includes("/api/analyze") && request.method() === "GET") offlineStatusChecks.push(request.url()); };
  await context.setOffline(true);
  page.on("request", countStatusChecks);
  await page.reload();
  if (!(await page.locator(".offline-notice").count())) fail("offline: the page did not load or show Offline mode");
  else ok("offline: the page reloads from the cache and shows Offline mode");
  {
    // The slots are real saved live runs; "rehearsal" is the app's word for the synthetic sample only.
    const notice = (await page.locator(".offline-notice").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const wantSlots = `slots ${slots.map((slot) => slot.slot).join(" and ")}`;
    if (/rehearsal/i.test(notice) || !notice.includes("saved live runs") || !notice.includes(wantSlots) || !notice.includes("the saved check")) fail(`offline, the banner reads "${notice}"`);
    else ok(`offline, the banner reads "${notice}"`);
  }
  {
    const badge = (await page.locator(".topbar-status").textContent().catch(() => ""))?.trim();
    if (badge !== "OFFLINE · SAVED RUNS STILL OPEN") fail(`offline, the top bar reads "${badge}"`);
    else ok(`offline, the top bar says "${badge}"`);
  }
  {
    // A typed claim offline: the banner says the saved runs still open, under an offline heading (not "another try").
    await page.locator("#claim-input").fill("Sharks have existed longer than trees");
    await page.locator("#claim-input").press("Enter");
    const offlineBanner = (await page.locator(".error-banner").innerText({ timeout: 3_000 }).catch(() => "")).replace(/\s+/g, " ").trim();
    // It names the saved check too, as the Offline mode notice does (QA round 6, S3-4: it named only the slots and backups).
    if (!/You are offline/.test(offlineBanner) || !/saved runs \(the demo slots, the backups and the saved check of five links\)/.test(offlineBanner) || /rehearsal|needs another try/i.test(offlineBanner)) fail(`offline, a typed claim's banner reads "${offlineBanner}"`);
    else ok(`offline, a typed claim's banner reads "${offlineBanner.replace(/^! /, "").replace(/ ×$/, "")}"`);
    await page.locator(".error-close").click().catch(() => undefined);
    await page.locator("#claim-input").fill("");
  }
  for (const slot of slots) await openAndCheck(page.locator(`.preset-chip.preset-${slot.id}`), slot, `offline slot ${slot.slot} ${slot.label}`);
  for (const backup of backups) await openAndCheck(page.locator(".backup-chip", { hasText: backup.label }), backup, `offline backup "${backup.label}"`);
  // The saved Check these sources run opens offline too (the worker precaches it), from its chip and from its ?trace=
  // link after a reload.
  {
    await page.locator(".backup-row .saved-check-chip").click().catch(() => undefined);
    const fromChip = await readSavedCheckOn(page);
    await page.goto(`${base}/?trace=check-these-sources-phones`).catch(() => undefined);
    await page.reload().catch(() => undefined);
    const afterReload = await readSavedCheckOn(page);
    const problems = [...savedCheckProblems(fromChip).map((problem) => `chip: ${problem}`), ...savedCheckProblems(afterReload).map((problem) => `?trace= reload: ${problem}`)];
    if (problems.length) fail(`offline, the saved Check these sources run: ${problems.join("; ")}`);
    else ok(`offline: "${savedCheck.label}" opens the saved run, and a reload of its ?trace= link opens it again ("${afterReload.tag}")`);
  }
  {
    const linked = slots[slots.length - 1];
    currentClaim = summaryOf(linked.trace).claim;
    await page.goto(`${base}/?slot=${linked.slot}`).catch(() => undefined);
    if (!(await waitForText(`${summaryOf(linked.trace).summary.totalPages} pages`))) fail(`offline: ?slot=${linked.slot} did not open`);
    else ok(`offline: a ?slot=${linked.slot} link still opens from the cache`);
    // A normal reload of the same link, as a presenter would press it.
    await page.reload().catch(() => undefined);
    if (!(await waitForText(`${summaryOf(linked.trace).summary.totalPages} pages`))) fail(`offline: reloading ?slot=${linked.slot} lost the trace`);
    else ok(`offline: reloading ?slot=${linked.slot} opens it again`);
  }
  {
    // /how, /explore and /anywhere open offline, by address and after a normal reload, with their own content.
    const expected = { "/how": "Many pages, few sources, in four steps.", "/explore": "Earlier runs, as captured.", "/anywhere": "See a claim? Trace it where you read it." };
    for (const [pathname, heading] of Object.entries(expected)) {
      const seen = [];
      await page.goto(`${base}${pathname}`).catch(() => undefined);
      seen.push(await page.locator("h1").first().innerText({ timeout: 3_000 }).catch(() => "nothing"));
      await page.reload().catch(() => undefined);
      seen.push(await page.locator("h1").first().innerText({ timeout: 3_000 }).catch(() => "nothing"));
      const cards = pathname === "/explore" ? await page.locator("main li a", { hasText: "Open this trace" }).count() : null;
      const checkCards = pathname === "/explore" ? await page.locator("main li a", { hasText: "Open this check" }).count() : null;
      if (seen.some((text) => text !== heading)) fail(`offline: ${pathname} showed ${JSON.stringify(seen)}, not "${heading}"`);
      else if (cards !== null && (cards !== slots.length + backups.length || checkCards !== 1)) fail(`offline: /explore shows ${cards} trace cards and ${checkCards} check cards, not ${slots.length + backups.length} and 1`);
      else ok(`offline: ${pathname} opens and reloads from the cache ("${heading}"${cards === null ? "" : `, ${cards} trace cards and the saved check`})`);
    }
    // Its "Open this trace" link still opens the run offline (Next falls back to a full page load, served from the cache).
    await page.goto(`${base}/how`).catch(() => undefined);
    const how = await page.locator("a", { hasText: "Open this trace" }).getAttribute("href").catch(() => null);
    const target = slots.find((slot) => how === `/?slot=${slot.slot}`);
    if (!target) fail(`/how's "Open this trace" points at ${how}, not a demo slot`);
    else {
      currentClaim = summaryOf(target.trace).claim;
      const before = pageErrors.length;
      await page.locator("a", { hasText: "Open this trace" }).click();
      if (!(await waitForText(`${summaryOf(target.trace).summary.totalPages} pages`))) fail(`offline: /how → Open this trace did not open slot ${target.slot}`);
      else ok(`offline: /how → Open this trace opens slot ${target.slot} from the cache`);
      // Next logs its fallback from the failed offline RSC fetch to a full page load; that is the expected path here.
      const logged = pageErrors.splice(before);
      pageErrors.push(...logged.filter((message) => !/^Failed to fetch RSC payload for .* Falling back to browser navigation/.test(message)));
    }
  }
  page.off("request", countStatusChecks);
  if (offlineStatusChecks.length) fail(`offline, the page sent ${offlineStatusChecks.length} status checks (GET /api/analyze) that could only fail`);
  else ok("offline, no status check (GET /api/analyze) is sent; it waits for the connection");
  await context.setOffline(false);

  // The blank-key live run logs its 4xx; anything else in the console is a real problem.
  const unexpected = pageErrors.filter((message) => !/status of 4\d\d|Failed to load resource/.test(message));
  if (unexpected.length) fail(`browser errors: ${[...new Set(unexpected)].slice(0, 5).join(" | ")}`);
  else ok("no unexpected browser errors");
} catch (error) {
  fail(`smoke test crashed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser?.close();
  server.kill();
}

// A presenter-locked deployment (ECHO_PRESENTER_KEY set) seen by a visitor without the presenter cookie: the claim box
// says live runs are reserved, shows no budget, and a typed claim sends nothing; saved runs still open.
process.stdout.write("\nPresenter lock, as a visitor\n");
{
  const lockedBase = `http://127.0.0.1:${await freePort()}`;
  const lockedServer = spawn(path.join(root, "node_modules", ".bin", "next"), ["start", "-p", new URL(lockedBase).port, "-H", "127.0.0.1"], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, ANTHROPIC_API_KEY: "", TAVILY_API_KEY: "", TELEM_API_KEY: "", ECHO_SEARCH_ROUTER: "tavily", ECHO_COPY_HUNT: "1", ECHO_PRESENTER_KEY: `smoke-${Math.random().toString(36).slice(2)}-${Date.now()}`, NEXT_TELEMETRY_DISABLED: "1" },
  });
  let lockedBrowser;
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { if ((await fetch(lockedBase)).ok) break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    lockedBrowser = await chromium.launch({ channel: "chrome", headless: !headed });
    const page = await (await lockedBrowser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
    let posts = 0;
    page.on("request", (request) => { if (/\/api\/(analyze|copy-hunt)/.test(request.url()) && request.method() === "POST") posts += 1; });
    await page.goto(lockedBase);
    const note = await page.waitForFunction(() => {
      const text = document.querySelector(".key-note")?.textContent ?? "";
      return text.includes("Checking") ? false : text;
    }, null, { timeout: 5_000 }).then((handle) => handle.jsonValue(), () => "");
    const budgetLines = await page.locator(".key-note small").count();
    if (!note.includes("Live runs are reserved for the presenter here · open a saved run") || budgetLines) fail(`locked, the claim box note reads "${note}" (${budgetLines} budget lines)`);
    else ok(`locked, the claim box says "${note}", with no budget line`);
    // The offline-readiness panel is the presenter's check; a visitor does not see it while online.
    if (await page.locator(".offline-readiness").count()) fail("locked, a visitor sees the offline-readiness panel");
    else ok("locked, a visitor online sees no offline-readiness panel");
    await page.locator("#claim-input").fill("Sharks have existed longer than trees");
    await page.locator("#claim-input").press("Enter");
    const banner = await page.locator(".error-banner").innerText({ timeout: 3_000 }).catch(() => "");
    await page.waitForTimeout(500);
    if (!/reserved for the presenter/.test(banner) || posts || (await page.locator(".loading-card").count())) fail(`locked, a typed claim: banner "${banner.replace(/\s+/g, " ").slice(0, 80)}", ${posts} POSTs`);
    else ok("locked, a typed claim explains the lock and sends 0 POSTs");
    // A pasted page link: reading a page is not a live run, and the refusal says what it is.
    await page.locator(".error-close").click().catch(() => undefined);
    await page.locator("#claim-input").fill("https://news.example/phones");
    await page.locator("#claim-input").press("Enter");
    const readNote = (await page.locator(".article-scan-note").textContent({ timeout: 5_000 }).catch(() => null)) ?? "";
    if (!/reading a page/.test(readNote) || /live run/i.test(readNote)) fail(`locked, Find claims in this page says "${readNote}"`);
    else ok(`locked, Find claims in this page says "${readNote}"`);
    await page.locator(".article-scan-head button").click().catch(() => undefined);
    await page.locator("#claim-input").fill("");
    const slot = slots[0];
    await page.locator(".error-close").click().catch(() => undefined);
    await page.locator(`.preset-chip.preset-${slot.id}`).click();
    const opened = await page.waitForFunction((pages) => document.querySelector("main")?.innerText.includes(pages), `${summaryOf(slot.trace).summary.totalPages} pages`, { timeout: 10_000 }).then(() => true, () => false);
    if (!opened || posts) fail(`locked, slot ${slot.slot} did not open (${posts} POSTs)`);
    else ok(`locked, slot ${slot.slot} still opens, with 0 POSTs in all`);
    // Copy hunt is on here (ECHO_COPY_HUNT=1), but a visitor's hunt would be refused (403): no paid button, one note.
    if (summaryOf(slot.trace).copyHunt) {
      await page.locator(".copy-hunt").waitFor({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      const huntButtons = await page.locator(".copy-hunt button", { hasText: /Search again|Hunt for more copies|Searching/ }).count();
      const lockNote = (await page.locator(".copy-hunt .copy-hunt-locked").textContent({ timeout: 2_000 }).catch(() => null)) ?? "";
      if (huntButtons || !/kept for the presenter/.test(lockNote)) fail(`locked, slot ${slot.slot}'s copy hunt shows ${huntButtons} search buttons and the note "${lockNote}"`);
      else ok(`locked, slot ${slot.slot}'s copy hunt offers no search button and says "${lockNote}"`);
    } else fail(`slot ${slot.slot} has no saved copy hunt to check the lock against`);
  } catch (error) {
    fail(`presenter-lock check crashed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await lockedBrowser?.close();
    lockedServer.kill();
  }
}

// A judge types their own claim, as a question, and gets a complete live trace. A second server answers every search
// and model call from scripts/smoke-mock-providers.mjs (no provider calls, no spend) and runs from a scratch folder, so
// the budget ledger it writes is not the real one in .echo/.
process.stdout.write("\nLive run of a judge-typed claim (mocked providers)\n");
const realLedger = path.join(root, ".echo", "anthropic-daily-budget.json");
const realLedgerMtime = fs.existsSync(realLedger) ? fs.statSync(realLedger).mtimeMs : null;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "echo-smoke-live-"));
const marker = path.join(scratch, "mock-loaded");
const mockBase = `http://127.0.0.1:${await freePort()}`;
const mockServer = spawn(path.join(root, "node_modules", ".bin", "next"), ["start", root, "-p", new URL(mockBase).port, "-H", "127.0.0.1"], {
  cwd: scratch,
  stdio: "ignore",
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: "smoke-mock-key",
    TAVILY_API_KEY: "smoke-mock-key",
    // The mocked providers answer Tavily only: a Telem key in .env.local must not route this server's searches.
    TELEM_API_KEY: "",
    ECHO_SEARCH_ROUTER: "tavily",
    ECHO_COPY_HUNT: "0",
    ECHO_DAILY_CAP_OVERRIDE_USD: "",
    NEXT_TELEMETRY_DISABLED: "1",
    ECHO_SMOKE_MOCK_MARKER: marker,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(path.join(root, "scripts", "smoke-mock-providers.mjs")).href}`.trim(),
  },
});
let liveBrowser;
try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(mockBase)).ok) break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!fs.existsSync(marker)) throw new Error("the mocked-provider server did not load its mock, so the live run was skipped");
  liveBrowser = await chromium.launch({ channel: "chrome", headless: !headed });
  // UTC-11 before 11:00 UTC, UTC+14 after 10:00 UTC: either way the local calendar day is not the UTC one.
  const liveZone = new Date().getUTCHours() < 11 ? "Pacific/Pago_Pago" : "Pacific/Kiritimati";
  const liveContext = await liveBrowser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: liveZone });
  liveZoneName = liveZone;
  await liveContext.addInitScript(captionChecks);
  const page = await liveContext.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(mockBase);
  const typed = "Is it true that 90% of startups fail?";
  await page.locator("#claim-input").fill(typed);
  await page.locator("#claim-input").press("Enter");
  // While it waits, the loading card lists the sites found so far (domains only), before the result arrives.
  const found = await page.waitForFunction(() => {
    const chips = [...document.querySelectorAll(".loading-card .loading-domains li:not(.loading-domains-more)")].map((chip) => chip.textContent?.trim() ?? "");
    // Sizes that stay readable in a 1920x1080 screen recording: the chips and the step detail ("Grouping 13 pages…").
    const px = (selector) => parseFloat(getComputedStyle(document.querySelector(selector) ?? document.body).fontSize);
    const cut = [...document.querySelectorAll(".loading-card .loading-domains li")].some((chip) => chip.scrollWidth > chip.clientWidth + 1);
    return chips.length >= 3 && !document.querySelector(".result-stack") ? { chips, label: document.querySelector(".loading-domains-label")?.textContent ?? "", chipPx: px(".loading-domains li"), detailPx: px(".loading-card .loading-detail"), cut } : false;
  }, null, { timeout: 15_000 }).then((handle) => handle.jsonValue(), () => null);
  if (!found) fail("the loading card shows fewer than 3 found sites before the live result");
  else if (found.chips.some((chip) => !/^[\w.-]+\.[a-z]{2,}$/i.test(chip))) fail(`the loading card's found sites are not bare domains: ${JSON.stringify(found.chips)}`);
  else if (found.chipPx < 13 || found.detailPx < 13 || found.cut) fail(`the loading card's found sites (${found.chipPx}px${found.cut ? ", cut off" : ""}) or step detail (${found.detailPx}px) are too small for a recording`);
  else ok(`the loading card lists sites as the search finds them, before the result ("${found.label}": ${found.chips.join(", ")}; ${found.chipPx}px chips, ${found.detailPx}px step detail)`);
  const clock = await page.locator(".loading-card .loading-elapsed").textContent({ timeout: 15_000 }).catch(() => null);
  if (!clock || !/· \d+:\d{2}$/.test(clock.trim())) fail(`the loading card shows no elapsed-time clock during the live run (${clock ?? "none"})`);
  else ok(`the loading card shows an elapsed-time clock mid-run (${clock.trim()})`);
  const status = await page.waitForFunction(
    () => [...document.querySelectorAll('[role="status"]')].map((element) => element.textContent ?? "").find((text) => text.includes("Trace complete.")) ?? false,
    null,
    { timeout: 30_000 },
  ).then((handle) => handle.jsonValue(), () => null);
  if (!status) fail(`live run did not finish${(await page.locator(".error-banner").count()) ? `: ${await page.locator(".error-banner").innerText()}` : ""}`);
  else if (!/2 pages found, 1 independent origin\b/.test(status)) fail(`live run finished with unexpected counts: ${status}`);
  else ok("a judge-typed question runs live to a finished trace (2 pages, 1 origin; off-claim page excluded)");
  const shownClaim = await page.locator("#claim-input").inputValue();
  if (shownClaim !== typed) fail(`after the run the claim box reads "${shownClaim}", not the claim as typed`);
  else ok("the claim stays exactly as typed");
  // The run's saved date is the viewer's own calendar day: the browser sits in a zone whose date differs from UTC now.
  const savedNote = (await page.locator(".saved-input-note").textContent({ timeout: 2_000 }).catch(() => null)) ?? "";
  const localDay = await page.evaluate(() => {
    const createdAt = JSON.parse(localStorage.getItem("echo-recent-traces:v8") ?? "[]")[0]?.createdAt;
    return createdAt ? new Date(createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "no saved run";
  });
  if (!savedNote.includes(`from ${localDay} `)) fail(`in ${liveZone} the saved run is dated "${savedNote}", not the local day ${localDay}`);
  else ok(`the saved run is dated on the viewer's own day (${localDay} in ${liveZone})`);
  // Trace an article: paste a page address, read its checkable sentences, pick one; nothing runs until Trace.
  {
    let articlePosts = 0;
    const countArticlePosts = (request) => { if (request.url().includes("/api/analyze") && request.method() === "POST") articlePosts += 1; };
    page.on("request", countArticlePosts);
    await page.locator("#claim-input").fill("https://article.echo-smoke.example/phones");
    const findLabel = (await page.locator(".trace-button").innerText()).trim();
    await page.locator("#claim-input").press("Enter");
    await page.locator(".article-scan-list button").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
    const chips = await page.locator(".article-scan-list button span").allInnerTexts();
    const head = await page.locator(".article-scan-head span").innerText().catch(() => "");
    if (!/Find claims in this page/.test(findLabel)) fail(`a pasted link shows "${findLabel}", not "Find claims in this page"`);
    else if (chips.length !== 2 || !chips[0].startsWith("Americans check their phones 96 times a day") || chips.some((chip) => /500|fake study|Subscribe/.test(chip))) fail(`the article's suggestions were ${JSON.stringify(chips)}`);
    else if (head !== "Phones & us") fail(`the suggestions are headed "${head}", not the page title`);
    else ok(`a pasted article link offers its ${chips.length} checkable sentences under its title (no script or nav text)`);
    await page.locator(".article-scan-list button").nth(1).click();
    const picked = await page.locator("#claim-input").inputValue();
    page.off("request", countArticlePosts);
    if (picked !== chips[1] || articlePosts) fail(`picking a suggestion: box "${picked}", ${articlePosts} runs started`);
    else ok("picking a suggestion fills the claim box and starts no run");
    await page.locator(".article-scan-head button").click();
    await page.locator("#claim-input").fill(typed);
  }
  if (new URL(page.url()).searchParams.get("claim") !== typed) fail(`after a live run the address bar is ${new URL(page.url()).search || "empty"}, not ?claim=<typed claim>`);
  else ok("after a live run the address bar carries ?claim= for sharing");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: mockBase });
  await page.locator(".copy-link-button").click();
  const claimLink = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  if (new URL(claimLink || "http://x/").searchParams.get("claim") !== typed) fail(`Copy link after a live run copied "${claimLink}"`);
  else ok("Copy link after a live run copies a ?claim= link with the claim as typed");
  await openMoreOn(page);
  if (await page.locator(".copy-badge-button").count()) fail("a fresh live run offers Embed badge, whose figures would not match a bundled run");
  else ok("a fresh live run offers no Embed badge");
  if (!(await page.locator("main").innerText()).includes("origin.example")) fail("live run does not show its origin page");
  else ok("the origin page is shown");
  {
    // One time on the row: the receipt starts with the run's own time, so the clock tag is not shown beside it.
    const runTime = (await page.locator(".result-mode-tag .result-run-time").textContent({ timeout: 1_000 }).catch(() => null))?.trim();
    const receiptTime = ((await page.locator(".cost-receipt-line").textContent({ timeout: 2_000 }).catch(() => null)) ?? "").match(/^(\d+ (?:s|min \d+ s))/)?.[1];
    if (runTime || !receiptTime) fail(`the fresh live result shows its time as tag "${runTime ?? "none"}" and receipt "${receiptTime ?? "none"}"`);
    else ok(`the fresh live result shows how long it took once, in its receipt (${receiptTime})`);
  }
  {
    // Its cost receipt: one line of list-price estimates from counted tokens and credits, also in the text report.
    const receipt = (await page.locator(".cost-receipt-line").textContent({ timeout: 2_000 }).catch(() => null))?.trim() ?? "";
    const pattern = /^\d+ (?:s|min \d+ s) · ≈\$\d+\.\d\d list-price estimate \(Claude \$\d+\.\d\d, search \$\d+\.\d\d\) · \d+ search(?:es)? \(\d+ credits?\) · \d+ Claude calls?$/;
    await resultActionOn(page, "Copy report").catch(() => undefined);
    const report = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    if (!pattern.test(receipt)) fail(`the fresh live run's cost line reads "${receipt}"`);
    else if (!report.includes(`Run cost (list-price estimate, not an invoice): ${receipt}`)) fail("the text report lacks the run's cost line");
    else ok(`the fresh live run shows its cost receipt, also in the report ("${receipt}")`);
  }
  if (realLedgerMtime !== (fs.existsSync(realLedger) ? fs.statSync(realLedger).mtimeMs : null)) fail("the mocked live run touched the real budget ledger in .echo/");
  else if (!fs.existsSync(path.join(scratch, ".echo", "anthropic-daily-budget.json"))) fail("the mocked live run did not record its spend in the scratch ledger");
  else ok("its spend went to a scratch ledger; the real .echo/ ledger is untouched");
  const unexpected = errors.filter((message) => !/Failed to load resource/.test(message));
  if (unexpected.length) fail(`live run browser errors: ${[...new Set(unexpected)].slice(0, 5).join(" | ")}`);
  else ok("no browser errors during the live run");

  // A busy provider: every Claude call answers 529 for this claim, so the run fails twice (retry included).
  await page.locator("#claim-input").fill("90% of startups fail, smoke overload check");
  await page.locator("#claim-input").press("Enter");
  const retry = page.locator(".error-banner button", { hasText: "Try again" });
  if (!(await retry.waitFor({ timeout: 30_000 }).then(() => true, () => false))) fail(`an overloaded run shows no Try again button${(await page.locator(".error-banner").count()) ? `: ${await page.locator(".error-banner").innerText()}` : ""}`);
  else {
    ok(`an overloaded run explains itself and offers Try again ("${(await page.locator(".error-banner p").first().innerText()).slice(0, 60)}")`);
    // It failed after its searches, so the stream carried what it spent: one muted line under the message.
    const spend = (await page.locator(".error-banner .error-spend").textContent({ timeout: 2_000 }).catch(() => null))?.trim() ?? "";
    if (!/^This run spent (?:≈\$\d+\.\d\d|under \$0\.01) before it stopped \(list-price estimate\)$/.test(spend)) fail(`the failed run's card shows no spend line ("${spend}")`);
    else ok(`the failed run's card says "${spend}"`);
    const retried = [];
    page.on("request", (request) => { if (request.url().includes("/api/analyze") && request.method() === "POST") retried.push(JSON.parse(request.postData() ?? "{}").claim); });
    await retry.dblclick();
    const reran = await page.locator(".loading-card").waitFor({ timeout: 5_000 }).then(() => true, () => false);
    const failedAgain = await page.locator(".error-banner").waitFor({ timeout: 30_000 }).then(() => true, () => false);
    if (!reran || !failedAgain) fail("Try again did not start a new live run");
    else if (retried.length !== 1 || retried[0] !== "90% of startups fail, smoke overload check") fail(`a double-clicked Try again sent ${retried.length} runs (${retried.join(" | ")})`);
    else ok("a double-clicked Try again starts exactly one new run of the same claim");
    // With the network gone, the same click can only fail, so it is not offered.
    await page.context().setOffline(true);
    const hidden = await retry.waitFor({ state: "detached", timeout: 3_000 }).then(() => true, () => false);
    await page.context().setOffline(false);
    if (!hidden) fail("Try again is still offered while the browser is offline");
    else ok("Try again is not offered while the browser is offline");
    // Reopening the finished claim is a cache hit: its receipt describes the original run, not new spend.
    await page.locator(".error-close").click().catch(() => undefined);
    await page.locator("#claim-input").fill(typed);
    await page.locator("#claim-input").press("Enter");
    const cachedLine = (await page.locator(".cost-receipt-line").textContent({ timeout: 5_000 }).catch(() => null))?.trim() ?? "";
    if (!cachedLine.startsWith("Saved run: cost of the original run, not new spend · ")) fail(`a reopened saved run's cost line reads "${cachedLine}"`);
    else ok("a reopened saved run says its cost line describes the original run, not new spend");
  }

  // "Check these sources": an AI answer pasted with its links. Pasting, removing a chip and typing the sentence send
  // nothing; a ?urls= link only fills the panel; the panel's button is the one thing that starts the run, which reads
  // exactly the links left (no search) and heads the trace with "N supplied links → M independent origins".
  {
    const posts = [];
    const countPosts = (request) => {
      if (request.url().includes("/api/analyze") && request.method() === "POST") posts.push(JSON.parse(request.postData() ?? "{}"));
    };
    page.on("request", countPosts);
    const sourcesClaim = "90% of startups fail within ten years";
    const [origin, repeat, coffee] = ["https://origin.example/startup-study", "https://repeat.example/startups-fail", "https://coffee.example/founders"];
    await page.goto(`${mockBase}/?claim=${encodeURIComponent(sourcesClaim)}&urls=${encodeURIComponent(`${origin} ${repeat}`)}`);
    await page.locator("#source-check-text").waitFor({ timeout: 10_000 }).catch(() => undefined);
    const linkChips = await page.locator("[aria-label='Links Echo will read'] li").count();
    const linkClaim = await page.locator("#source-check-claim").inputValue().catch(() => "");
    await page.waitForTimeout(1_500);
    if (linkChips !== 2 || linkClaim !== sourcesClaim || posts.length) fail(`a ?urls= link: ${linkChips} chips, claim "${linkClaim}", ${posts.length} runs started`);
    else ok("a ?urls= link fills the Check these sources panel (2 links and the sentence) and starts no run");
    await page.goto(mockBase);
    const startEntry = page.locator("button", { hasText: "Check an AI answer's links" }).first();
    if (!(await startEntry.isVisible().catch(() => false))) fail("the start screen offers no Check an AI answer's links entry");
    else {
      await startEntry.click();
      // Three paste shapes at once: a numbered markdown link, a bracketed number before a bare link, and an
      // unnumbered link in parentheses (it takes the next number after the highest, 3).
      const answer = `According to recent research, about 90% of startups fail within ten years [1](${origin}?utm_source=chatgpt.com). Founders love coffee: [2] ${coffee}. Many outlets repeat it (${repeat}).`;
      await page.locator("#source-check-text").fill(answer);
      // The empty sentence box fills itself with the sentence carrying the citation, markers and link taken out.
      const autoClaim = await page.locator("#source-check-claim").inputValue();
      const autoHint = await page.locator("#source-check", { hasText: "Picked from the pasted answer" }).count();
      if (autoClaim !== "According to recent research, about 90% of startups fail within ten years." || !autoHint) fail(`pasting the answer into an empty sentence box left it holding "${autoClaim}" (hint shown: ${autoHint > 0})`);
      else ok(`pasting into an empty sentence box fills it with the cited sentence: "${autoClaim}"`);
      const chips = page.locator("[aria-label='Links Echo will read'] li");
      const pasted = await chips.count();
      const chipTexts = await chips.evaluateAll((items) => items.map((item) => [...item.children].filter((child) => child.tagName !== "BUTTON").map((child) => child.textContent.trim()).join(" ")));
      const expectedChips = ["[1] origin.example/startup-study", "[2] coffee.example/founders", "[3] repeat.example/startups-fail"];
      if (JSON.stringify(chipTexts) !== JSON.stringify(expectedChips)) fail(`the pasted answer's chips read ${JSON.stringify(chipTexts)}, expected ${JSON.stringify(expectedChips)}`);
      else ok(`each chip carries the answer's own citation number: ${chipTexts.join(" · ")}`);
      await chips.filter({ hasText: "coffee.example" }).locator("button").click();
      const afterRemove = await chips.count();
      const keptNumbers = (await chips.locator("b").allInnerTexts()).join(" ");
      if (keptNumbers !== "[1] [3]") fail(`after removing [2] the chips are numbered ${keptNumbers}`);
      else ok("removing [2] leaves [1] and [3]: the answer's numbers are not reused");
      await page.locator("#source-check-claim").fill(sourcesClaim);
      // What the person typed stays: pasting more of the answer does not replace it.
      await page.locator("#source-check-text").fill(`${answer}\nResearchers also found that 40% of founders drink tea.`);
      const keptClaim = await page.locator("#source-check-claim").inputValue();
      if (keptClaim !== sourcesClaim) fail(`editing the answer after typing the sentence replaced it with "${keptClaim}"`);
      else ok("a sentence the person typed is never replaced when the pasted answer changes");
      await page.locator("#source-check-claim").press("Enter");
      await page.waitForTimeout(1_000);
      const button = page.locator("#source-check button.trace-button");
      const label = (await button.locator("span").first().innerText()).trim();
      if (pasted !== 3 || afterRemove !== 2) fail(`pasting an answer with 3 links made ${pasted} chips; removing one left ${afterRemove}`);
      else ok("pasting an answer with 3 links shows 3 chips (tracking stripped); removing one leaves 2");
      if (posts.length) fail(`pasting, removing a chip and typing the sentence started ${posts.length} runs`);
      else ok("pasting, removing a chip and pressing Enter in the sentence box start no run");
      await button.click();
      const headline = await page.locator("[aria-label='Supplied sources result'] h2").textContent({ timeout: 30_000 }).catch(() => null);
      if (!/^Check 2 sources/.test(label) || posts.length !== 1 || JSON.stringify(posts[0].urls) !== JSON.stringify([origin, repeat]) || posts[0].claim !== sourcesClaim) fail(`the panel's button ("${label}") sent ${JSON.stringify(posts)}`);
      else ok(`the panel's button ("${label}") is the one thing that started the run, with exactly the 2 links left`);
      if (!headline || !/^2 supplied links → 1 independent origin\b/.test(headline.trim())) fail(`the supplied-sources result is headed "${headline ?? "nothing"}"${(await page.locator(".error-banner").count()) ? `: ${await page.locator(".error-banner").innerText()}` : ""}`);
      else ok(`the result is headed "${headline.trim()}" over the normal trace view`);
      const fine = (await page.locator("[aria-label='Supplied sources result']").innerText().catch(() => "")) ?? "";
      if (!/not proof of the claim/.test(fine) || !/ran no web search/.test(fine)) fail(`the supplied-sources result does not say a citation is not proof or that no search ran: "${fine.slice(0, 160)}"`);
      else ok("it says Echo ran no web search and that a citation identifies a supplied source, not proof");
      if (!(await page.locator(".result-stack").count())) fail("the supplied-sources result does not show the normal trace view");
      // The per-link list, in pasted order with the answer's numbers, then the one plain line.
      const rows = await page.locator("[aria-label='Each supplied link'] li").evaluateAll((items) => items.map((item) => [...item.children].map((child) => child.textContent.trim()).join(" ")));
      const expectedRows = ["[1] origin.example — independent origin, with its own evidence", "[3] repeat.example — copy of [1]"];
      const point = (await page.locator("[aria-label='Supplied sources result'] p", { hasText: "Your answer's" }).textContent().catch(() => ""))?.trim();
      if (JSON.stringify(rows) !== JSON.stringify(expectedRows)) fail(`the per-link list reads ${JSON.stringify(rows)}, expected ${JSON.stringify(expectedRows)}`);
      else ok(`the result lists each link with its number and verdict: ${rows.join(" · ")}`);
      if (point !== "Your answer's 2 citations trace back to 1 independent origin, with its own evidence.") fail(`the per-link list's plain line reads "${point}"`);
      else ok(`then one plain line: "${point}"`);
      const shared = new URL(page.url()).searchParams;
      if (shared.get("claim") !== sourcesClaim || shared.get("urls") !== `${origin} ${repeat}`) fail(`after the run the address bar is ${new URL(page.url()).search}`);
      else ok("after the run the address bar carries ?claim= and ?urls=, which only fill the panel");
      // QA round 3 #9: Copy link keeps the answer's numbers ([1] and [3], after [2] was removed) as ?nums=, and the link
      // reopens the panel with those numbers, sending nothing.
      {
        await page.locator(".copy-link-button").click();
        const copiedLink = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
        const sentBefore = posts.length;
        const nums = (() => { try { return new URL(copiedLink).searchParams.get("nums"); } catch { return null; } })();
        if (nums !== "1,3" || shared.get("nums") !== "1,3") fail(`Copy link wrote ${copiedLink} (address bar nums ${shared.get("nums")})`);
        else {
          await page.goto(copiedLink);
          await page.locator("[aria-label='Links Echo will read'] li").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
          await page.waitForTimeout(600);
          const reopened = (await page.locator("[aria-label='Links Echo will read'] li b").allInnerTexts()).join(" ");
          if (reopened !== "[1] [3]" || posts.length !== sentBefore) fail(`the copied link reopens chips ${reopened} and sent ${posts.length - sentBefore} runs`);
          else ok("Copy link carries the answer's numbers (?nums=1,3) and reopens the panel as [1] and [3], sending nothing");
        }
      }
      const keptRecent = await page.evaluate(() => (localStorage.getItem("echo-recent-traces:v8") ?? "").includes("sourceCheck"));
      if (keptRecent) fail("a supplied-sources run was saved among the claim-keyed recent traces");
      else ok("the supplied-sources run is not saved among recent traces, which are found by claim alone");
    }
    page.off("request", countPosts);
  }

  // "Try an example": one button fills the panel with a sample answer (labelled as one) citing the five phones links,
  // and the sentence; it sends nothing. Pressing Check 5 sources then runs, here against a mocked /api/analyze that
  // answers with the live trace of those links saved on 2026-11-13, so the per-link list is the real one.
  // ECHO_SMOKE_SHOTS=<folder> also saves screenshots of the panel and the result at 1920×1080 and 1366×768.
  {
    const posts = [];
    const countPosts = (request) => { if (request.url().includes("/api/analyze") && request.method() === "POST") posts.push(JSON.parse(request.postData() ?? "{}")); };
    page.on("request", countPosts);
    const shots = process.env.ECHO_SMOKE_SHOTS;
    const saved = JSON.parse(fs.readFileSync(path.join(root, "scripts", "fixtures", "sources-phones-live-2026-11-13.echo.json"), "utf8")).analysis;
    await page.route("**/api/analyze", (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: result\ndata: ${JSON.stringify({ ...saved, createdAt: new Date().toISOString() })}\n\n` }));
    try {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(mockBase);
      await page.locator("button", { hasText: "Check an AI answer's links" }).first().click();
      const example = page.locator("#source-check button", { hasText: "Try an example" });
      const label = (await example.textContent().catch(() => ""))?.trim();
      await example.click();
      await page.waitForTimeout(800);
      const text = await page.locator("#source-check-text").inputValue();
      const claim = await page.locator("#source-check-claim").inputValue();
      const chipTexts = await page.locator("[aria-label='Links Echo will read'] li").evaluateAll((items) => items.map((item) => [...item.children].filter((child) => child.tagName !== "BUTTON").map((child) => child.textContent.trim()).join(" ")));
      const expectedChips = ["[1] asurion.com", "[2] prnewswire.com", "[3] fox13seattle.com", "[4] kabc.com", "[5] churchandculture.org"];
      if (!text.startsWith("Sample answer, written for this example:") || /chatgpt|perplexity|gemini|copilot|claude/i.test(`${text} ${label}`)) fail(`Try an example filled "${text.slice(0, 60)}" (button "${label}"); it must say it is a sample and name no AI product`);
      else ok(`"${label}" fills a sample answer that says it is one and names no AI product`);
      if (JSON.stringify(chipTexts.map((chip) => chip.split("/")[0])) !== JSON.stringify(expectedChips)) fail(`the example's chips read ${JSON.stringify(chipTexts)}`);
      else ok(`its five links show as numbered chips: ${chipTexts.map((chip) => chip.split("/")[0]).join(" · ")}`);
      if (claim !== "Americans check their phones 96 times a day") fail(`the example's sentence is "${claim}"`);
      else ok(`and the sentence "${claim}"`);
      if (posts.length) fail(`Try an example started ${posts.length} runs`);
      else ok("filling the example sends nothing; the person still presses the button");
      if (await example.count()) fail("Try an example is still offered over a filled answer box (it would replace it)");
      else ok("Try an example is offered only while the answer box is empty");
      for (const [width, height] of [[1920, 1080], [1366, 768]]) {
        await page.setViewportSize({ width, height });
        await page.locator("#source-check").scrollIntoViewIfNeeded();
        if (shots) await page.locator("#source-check").screenshot({ path: path.join(shots, `sources-panel-${width}x${height}.png`) });
      }
      await page.setViewportSize({ width: 1920, height: 1080 });
      const button = page.locator("#source-check button.trace-button");
      const buttonLabel = (await button.locator("span").first().innerText()).trim();
      await button.click();
      await page.locator("[aria-label='Each supplied link'] li").first().waitFor({ timeout: 15_000 }).catch(() => undefined);
      const rows = await page.locator("[aria-label='Each supplied link'] li").evaluateAll((items) => items.map((item) => [...item.children].map((child) => child.textContent.trim()).join(" ")));
      const expectedRows = [
        "[1] asurion.com — independent origin, with its own evidence",
        "[2] prnewswire.com — unclear (same text, no earlier date)",
        "[3] fox13seattle.com — copy of [2]",
        "[4] kabc.com — possible copy of [1], link not confirmed",
        "[5] churchandculture.org — copy of [3]",
      ];
      const point = (await page.locator("[aria-label='Supplied sources result'] p", { hasText: "Your answer's" }).textContent().catch(() => ""))?.trim();
      const headline = (await page.locator("[aria-label='Supplied sources result'] h2").textContent().catch(() => ""))?.trim();
      if (buttonLabel !== "Check 5 sources" || posts.length !== 1 || JSON.stringify(posts[0].urls) !== JSON.stringify(saved.sourceCheck.urls) || posts[0].claim !== saved.claim) fail(`"${buttonLabel}" sent ${JSON.stringify(posts)}`);
      else ok(`"${buttonLabel}" sends exactly the five example links and the sentence`);
      if (JSON.stringify(rows) !== JSON.stringify(expectedRows)) fail(`the example's per-link list reads ${JSON.stringify(rows)}`);
      else ok(`the saved live result lists each citation: ${rows.join(" · ")}`);
      if (!/^5 supplied links → 1 independent origin\b/.test(headline ?? "") || point !== "Your answer's 5 citations trace back to 1 independent origin, with its own evidence.") fail(`the example's result is headed "${headline}" and says "${point}"`);
      else ok(`headed "${headline}", then "${point}"`);
      // One verdict card: the sources card carries the tiles in links; no generic verdict banner, no echo rate (it
      // counts only confirmed copies), and the receipt says no web search ran.
      {
        const shown = await page.evaluate(() => ({
          tiles: [...document.querySelectorAll("[aria-label='Supplied links at a glance'] > div")].map((tile) => [...tile.children].map((child) => child.textContent.trim()).join(" ")),
          banners: document.querySelectorAll(".verdict-banner").length,
          echoRate: `${document.querySelector("[aria-label='Supplied sources result']")?.textContent ?? ""} ${document.querySelector(".result-stack")?.textContent ?? ""}`.match(/\d+% (?:sample )?echo/)?.[0] ?? null,
          receipt: document.querySelector(".cost-receipt-line")?.textContent ?? "",
        }));
        const wantTiles = ["5 links read", "1 independent origin", "1 with own evidence"];
        if (JSON.stringify(shown.tiles) !== JSON.stringify(wantTiles) || shown.banners || shown.echoRate) fail(`the sources result: tiles ${JSON.stringify(shown.tiles)}, ${shown.banners} generic verdict banners, echo rate ${JSON.stringify(shown.echoRate)}`);
        else ok(`the sources result has one verdict card, its tiles in links (${shown.tiles.join(" · ")}), no generic banner and no echo rate`);
        if (!/· no web search · 1 extract credit · 3 Claude calls$/.test(shown.receipt) || /search(?:es)? \(|search \$/.test(shown.receipt)) fail(`the sources run's receipt reads "${shown.receipt}"`);
        else ok(`its receipt reads "${shown.receipt}"`);
      }
      // Cite once: the line under the per-link list; Copy puts exactly that line on the clipboard and Show as data
      // shows the same result as JSON, labelled for tools. Neither sends anything.
      {
        const card = page.locator("[aria-label='Supplied sources result']");
        const group = card.locator("[aria-label='Which links to cite once']");
        const before = posts.length;
        const line = (await group.locator("p").first().textContent().catch(() => ""))?.trim();
        const want = "Cite once: [1] asurion.com. Unclear: [2], [4]. Repeats [2]: [3], [5].";
        await group.locator("button", { hasText: /^Copy$/ }).click();
        const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
        const copiedLabel = (await group.locator("button").first().textContent())?.trim();
        await group.locator("button", { hasText: "Show as data" }).click();
        const label = await group.getByText("The same result as data, for tools that use citations", { exact: true }).count();
        let parsed = null;
        try { parsed = JSON.parse((await group.locator("pre").textContent()) ?? ""); } catch { parsed = null; }
        const words = (await card.innerText()).match(/\b(?:drop(?:s|ped)?|wrong|public api)\b/i)?.[0] ?? null;
        if (line !== want || copied !== want || copiedLabel !== "Copied") fail(`cite once: the line reads "${line}", Copy put "${copied}" on the clipboard (button "${copiedLabel}")`);
        else ok(`under the per-link list: "${line}"; Copy puts exactly that line on the clipboard`);
        if (!label || parsed?.citeOnce !== want || parsed?.citations?.length !== 5 || parsed?.origins?.[0]?.cite !== 1 || posts.length !== before || words) fail(`Show as data: label ${label}, data ${JSON.stringify(parsed)?.slice(0, 160)}, ${posts.length - before} runs, word ${JSON.stringify(words)}`);
        else ok("Show as data shows the same result as JSON (5 citations, origin [1]) under \"The same result as data, for tools that use citations\"; nothing is sent, and the card never says drop, wrong or public API");
        await group.locator("button", { hasText: "Hide data" }).click();
      }
      for (const [width, height] of [[1920, 1080], [1366, 768]]) {
        await page.setViewportSize({ width, height });
        await page.locator("[aria-label='Supplied sources result']").scrollIntoViewIfNeeded();
        if (shots) await page.locator("[aria-label='Supplied sources result']").screenshot({ path: path.join(shots, `sources-result-${width}x${height}.png`) });
      }
      // The reports say the result came from supplied links: Copy report and Download report carry a "Checked supplied
      // links (no web search)" section with each link and the plain line, and a line that no search ran where a search
      // trace has its query audit; the printed page has the same section and says origins are among the supplied links.
      {
        await page.setViewportSize({ width: 1366, height: 768 });
        await resultActionOn(page, "Copy report");
        const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
        const [download] = await Promise.all([page.waitForEvent("download", { timeout: 5_000 }).catch(() => null), resultActionOn(page, "Download report")]);
        const downloaded = download ? fs.readFileSync(await download.path(), "utf8") : "";
        const wantLines = ["Checked supplied links (no web search):", "5 supplied links → 1 independent origin", ...expectedRows, point, "Web search: none ran. Echo read only the 5 supplied links, so there is no search query audit."];
        for (const [name, text] of [["Copy report", copied], ["Download report", downloaded]]) {
          const lines = text.split("\n");
          const missing = wantLines.filter((line) => !lines.includes(line));
          const urlsListed = saved.sourceCheck.urls.every((url) => lines.includes(`   ${url}`));
          if (missing.length || !urlsListed || /Search query audit|No search-query audit/.test(text)) fail(`${name} for the sources result: missing ${JSON.stringify(missing)}, every address listed ${urlsListed}, search audit wording ${/Search query audit|No search-query audit/.test(text)}`);
          else ok(`${name} has "Checked supplied links (no web search)" with all 5 links and addresses, the plain line, and "Web search: none ran" instead of a query audit`);
        }
        await page.emulateMedia({ media: "print" });
        await page.setViewportSize({ width: 794, height: 1123 });
        const printed = (await page.locator(".print-report").innerText().catch(() => "")) ?? "";
        if (shots) await page.screenshot({ path: path.join(shots, "sources-print-page1.png") });
        await page.emulateMedia({ media: "screen" });
        await page.setViewportSize({ width: 1920, height: 1080 });
        const printProblems = [];
        if (!/SUPPLIED LINKS, NO WEB SEARCH/.test(printed)) printProblems.push("no 'SUPPLIED LINKS, NO WEB SEARCH' in the header");
        if (!/^5 supplied links → 1 independent origin$/m.test(printed)) printProblems.push("not headed '5 supplied links → 1 independent origin'");
        if (!/Checked supplied links \(no web search\)/i.test(printed)) printProblems.push("no 'Checked supplied links (no web search)' section");
        for (const row of expectedRows) if (!printed.includes(row)) printProblems.push(`no row "${row}"`);
        if (!printed.includes(point)) printProblems.push("no plain line");
        if (!/among the supplied links/.test(printed) || /pages Echo found/.test(printed)) printProblems.push("the footer does not say 'among the supplied links'");
        if (printProblems.length) fail(`the printed sources report: ${printProblems.join("; ")}`);
        else ok("the printed sources report is headed by the supplied links, lists each with its verdict and the plain line, and its footer says origins are among the supplied links");
      }
      // Present: slide 1 leads with the supplied links (headline, each link's verdict, the plain line, then the Cite once
      // line under it, in one or two lines, inside the slide) and no slide scrolls or speaks of a search. Then a 20-link
      // trace: all 20 on the common projector sizes; on a 720p projector with the browser bar showing (1280x600) the
      // first 13 and "+7 more supplied links". Then the v2 fixture (PR Newswire published together with [1]).
      const presentSources = async (label, sizes, want) => {
        for (const [width, height] of sizes) {
          await page.setViewportSize({ width, height });
          await page.locator(".present-button").click();
          await page.locator(".stage-presentation").waitFor({ timeout: 5_000 });
          await page.waitForTimeout(250);
          const problems = [];
          const first = await page.evaluate(() => {
            const slide = document.querySelector(".stage-content article[aria-label='The claim and the supplied links']");
            const shown = [...(slide?.querySelectorAll("ol li") ?? [])].filter((item) => item.getBoundingClientRect().height > 0);
            const frame = document.querySelector(".stage-content")?.getBoundingClientRect();
            const more = [...(slide?.querySelectorAll("p") ?? [])].find((node) => /more supplied links/.test(node.textContent ?? "") && node.getBoundingClientRect().height > 0)?.textContent ?? null;
            const point = [...(slide?.querySelectorAll(":scope > p") ?? [])].find((node) => /^(?:Your answer's|Of your answer's|None of your answer's)/.test(node.textContent ?? ""));
            const cite = slide?.querySelector("[data-cite-once]");
            const citeBox = cite?.getBoundingClientRect();
            const citeStyle = cite ? getComputedStyle(cite) : null;
            const citeLines = citeBox && citeStyle ? Math.round((citeBox.height - parseFloat(citeStyle.paddingTop) - parseFloat(citeStyle.paddingBottom) - parseFloat(citeStyle.borderTopWidth) - parseFloat(citeStyle.borderBottomWidth)) / parseFloat(citeStyle.lineHeight)) : 0;
            return {
              cite: cite?.textContent ?? null,
              citeLines,
              citeInside: Boolean(citeBox && frame && citeBox.bottom <= frame.bottom + 1 && citeBox.right <= frame.right + 1),
              citeUnderPoint: Boolean(citeBox && point && citeBox.top >= point.getBoundingClientRect().bottom - 1),
              headline: slide?.querySelector(".stage-hero-verdict strong")?.textContent ?? "",
              kicker: slide?.querySelector(".stage-kicker")?.textContent ?? "",
              rows: shown.map((item) => [...item.children].map((child) => child.textContent.trim()).join(" ")),
              offFrame: shown.filter((item) => { const box = item.getBoundingClientRect(); return !frame || box.bottom > frame.bottom + 1 || box.right > frame.right + 1; }).length,
              more,
              point: point?.textContent ?? "",
              pointInside: Boolean(point && frame && point.getBoundingClientRect().bottom <= frame.bottom + 1),
              toolbar: document.querySelector(".stage-toolbar-center")?.textContent ?? "",
            };
          });
          if (!first.headline.startsWith(want.headline)) problems.push(`slide 1 is headed "${first.headline}"`);
          if (!/SUPPLIED LINKS, NO WEB SEARCH/.test(first.kicker) || !/SUPPLIED LINKS · NO WEB SEARCH/.test(first.toolbar)) problems.push(`slide 1 does not say the links were supplied and no search ran ("${first.kicker}" / "${first.toolbar}")`);
          const rowsWanted = want.rows(height);
          if (JSON.stringify(first.rows) !== JSON.stringify(rowsWanted) || first.offFrame) problems.push(`slide 1 lists ${JSON.stringify(first.rows)} (${first.offFrame} off the slide), expected ${JSON.stringify(rowsWanted)}`);
          if (first.more !== want.more(height)) problems.push(`slide 1's "more" line reads ${JSON.stringify(first.more)}, expected ${JSON.stringify(want.more(height))}`);
          if (first.point !== want.point || !first.pointInside) problems.push(`slide 1's plain line reads "${first.point}" (on the slide: ${first.pointInside})`);
          if (first.cite !== want.cite || !first.citeInside || !first.citeUnderPoint || first.citeLines < 1 || first.citeLines > 2) problems.push(`slide 1's Cite once line reads ${JSON.stringify(first.cite)} (on the slide: ${first.citeInside}, under the plain line: ${first.citeUnderPoint}, ${first.citeLines} lines), expected ${JSON.stringify(want.cite)} in one or two lines`);
          const count = await page.locator(".stage-progress button").count();
          let treeBadges = null;
          for (let index = 0; index < count; index += 1) {
            await page.locator(".stage-progress button").nth(index).click();
            await page.waitForTimeout(200);
            const check = await page.evaluate(() => {
              const content = document.querySelector(".stage-content");
              const text = document.querySelector(".stage-presentation")?.innerText ?? "";
              return { name: document.querySelector(".stage-progress-active")?.textContent?.replace(/^\d+/, "") ?? "?", scrolls: content ? content.scrollHeight - content.clientHeight : 999, search: text.match(/pages Echo found|other pages found|plain search|query audit|pages found|search quer/i)?.[0] ?? null };
            });
            if (check.scrolls > 2) problems.push(`"${check.name}" scrolls by ${check.scrolls}px`);
            if (check.search) problems.push(`"${check.name}" says "${check.search}"`);
            // Round 11: slide 3's cards show each page's supplied-link number, the per-link list's own, and the badges
            // leave every link caption in its gap beside its target card, never under a card or struck by a curve.
            if (check.name === "The source tree") {
              const tree = await page.evaluate(() => {
                const box = document.querySelector(".stage-content .stage-tree-slide .tree-scroll");
                if (!box) return null;
                return {
                  badges: [...box.querySelectorAll(".source-node")].map((node) => `${node.querySelector(".node-cite")?.textContent ?? "none"} ${node.querySelector(".node-domain")?.textContent ?? ""}`).sort(),
                  clipped: [...box.querySelectorAll(".source-node .node-cite")].filter((badge) => badge.scrollWidth > badge.clientWidth + 1 || badge.getBoundingClientRect().width < 8).length,
                  captions: window.__echoCaptionsUnderCards(box),
                  struck: window.__echoCaptionsStruck(box).struck,
                };
              });
              const wantBadges = rowsWanted.filter((row) => !/— (?:could not be read|not about this claim)$/.test(row)).map((row) => row.split(" — ")[0]).sort();
              if (!tree || JSON.stringify(tree.badges) !== JSON.stringify(wantBadges) || tree.clipped) problems.push(`slide 3's cards read ${JSON.stringify(tree?.badges)} (${tree?.clipped} badges clipped), expected ${JSON.stringify(wantBadges)}`);
              if (tree && (!tree.captions.count || tree.captions.covered.length || tree.captions.astray.length || tree.struck.length)) problems.push(`slide 3's link captions: ${tree.captions.count} drawn, under a card ${JSON.stringify(tree.captions.covered)}, away from their target ${JSON.stringify(tree.captions.astray)}, struck ${JSON.stringify(tree.struck)}`);
              treeBadges = tree?.badges.length ?? 0;
              if (shots) await page.screenshot({ path: path.join(shots, `sources-slide2-${label}-${width}x${height}.png`) });
            }
          }
          if (treeBadges === null) problems.push("no slide named \"The source tree\" to check the cards' supplied numbers on");
          await page.locator(".stage-progress button").first().click();
          await page.waitForTimeout(200);
          if (shots) await page.screenshot({ path: path.join(shots, `sources-present-${label}-${width}x${height}.png`) });
          await page.keyboard.press("Escape");
          await page.locator(".stage-presentation").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
          if (problems.length) fail(`${label} Present at ${width}x${height}: ${problems.join("; ")}`);
          else ok(`${label} Present at ${width}x${height}: slide 1 leads with "${first.headline}", ${first.rows.length} supplied links${first.more ? ` and "${first.more.split(" (")[0]}"` : ""}, then the plain line and the Cite once line (${first.citeLines} ${first.citeLines === 1 ? "line" : "lines"}); ${count} slides, none scrolls or speaks of a search; slide 3's cards carry their supplied numbers, link captions clear`);
        }
      };
      const presentSizes = [[1280, 720], [1366, 768], [1920, 1080], [1280, 600]];
      await presentSources("the 5-link example", presentSizes, { headline: "5 supplied links → 1 independent origin", rows: () => expectedRows, more: () => null, point: "Your answer's 5 citations trace back to 1 independent origin, with its own evidence.", cite: "Cite once: [1] asurion.com. Unclear: [2], [4]. Repeats [2]: [3], [5]." });
      {
        // The same saved trace with 15 more supplied links: 10 that could not be read and 5 off the claim.
        const twenty = structuredClone(saved);
        const extra = Array.from({ length: 15 }, (_, index) => `https://regional-news-${index + 6}.example/story`);
        twenty.sourceCheck = { urls: [...saved.sourceCheck.urls, ...extra], unreadUrls: extra.slice(0, 10) };
        twenty.excludedPageCount = 5;
        const twentyRows = [...expectedRows, ...extra.map((url, index) => `[${index + 6}] ${new URL(url).hostname} — ${index < 10 ? "could not be read" : "not about this claim"}`)];
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.locator("input[aria-label='Open saved Echo trace file']").setInputFiles({ name: "sources-twenty.echo.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ format: "echo-trace", version: 1, exportedAt: new Date().toISOString(), analysis: twenty })) });
        await page.locator("[aria-label='Supplied sources result'] h2", { hasText: "20 supplied links" }).waitFor({ timeout: 10_000 }).catch(() => undefined);
        await presentSources("a 20-link trace", presentSizes, {
          headline: "20 supplied links → 1 independent origin",
          rows: (height) => (height < 720 ? twentyRows.slice(0, 13) : twentyRows),
          more: (height) => (height < 720 ? "+7 more supplied links (all of them are on the result page and in the report)" : null),
          point: "Of your answer's 20 citations, 5 address this claim, and they trace back to 1 independent origin, with its own evidence.",
          cite: "Cite once: [1] asurion.com. Unclear: [2], [4]. Repeats [2]: [3], [5]. Could not be read: [6], [7], [8], [9], [10], [11], [12], [13], [14], [15]. Not about this claim: [16], [17], [18], [19], [20].",
        });
      }
      {
        // The v2 fixture of the same five links: PR Newswire published together with [1], so Cite once names it.
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.locator("input[aria-label='Open saved Echo trace file']").setInputFiles(path.join(root, "scripts", "fixtures", "sources-phones-live-2026-11-13-v2.echo.json"));
        await page.locator("[aria-label='Each supplied link'] li", { hasText: "published together with [1]" }).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
        await presentSources("the v2 5-link fixture", presentSizes, {
          headline: "5 supplied links → 1 independent origin",
          rows: () => [
            "[1] asurion.com — independent origin, with its own evidence",
            "[2] prnewswire.com — published together with [1], one origin",
            "[3] fox13seattle.com — copy of [2]",
            "[4] kabc.com — possible copy of [1], link not confirmed",
            "[5] churchandculture.org — copy of [3]",
          ],
          more: () => null,
          point: "Your answer's 5 citations trace back to 1 independent origin, with its own evidence.",
          cite: "Cite once: [1] asurion.com (also published as [2]). Repeats it: [3], [5]. Unclear: [4].",
        });
      }
    } finally {
      await page.unroute("**/api/analyze");
      page.off("request", countPosts);
    }
  }

  // The newer live trace of the same five links (v2, 2026-11-13), where PR Newswire is published together with [1]:
  // opened as a trace file, its card reads as one origin, and with one unclear relationship the verdict sentence (on
  // the printed page; the screen shows the sources card instead) says "1 relationship remains", not "1 relationships".
  {
    const v2 = path.join(root, "scripts", "fixtures", "sources-phones-live-2026-11-13-v2.echo.json");
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(mockBase);
    await page.locator("input[aria-label='Open saved Echo trace file']").setInputFiles(v2);
    await page.locator("[aria-label='Each supplied link'] li").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    const rows = await page.locator("[aria-label='Each supplied link'] li").evaluateAll((items) => items.map((item) => [...item.children].map((child) => child.textContent.trim()).join(" ")));
    const wantRows = [
      "[1] asurion.com — independent origin, with its own evidence",
      "[2] prnewswire.com — published together with [1], one origin",
      "[3] fox13seattle.com — copy of [2]",
      "[4] kabc.com — possible copy of [1], link not confirmed",
      "[5] churchandculture.org — copy of [3]",
    ];
    if (JSON.stringify(rows) !== JSON.stringify(wantRows)) fail(`the v2 phones sources trace lists ${JSON.stringify(rows)}`);
    else ok(`the v2 phones sources trace opens as one origin: ${rows.join(" · ")}`);
    // Round 11: the result page tree's cards show the supplied-link numbers of the per-link list, and the badges leave
    // every link caption beside its target card, never under a card or struck by a curve.
    {
      const tree = await page.evaluate(() => {
        const scope = document.querySelector(".result-stack .source-tree-explorer");
        return {
          badges: [...(scope?.querySelectorAll(".source-node") ?? [])].map((node) => `${node.querySelector(".node-cite")?.textContent ?? "none"} ${node.querySelector(".node-domain")?.textContent ?? ""}`).sort(),
          labels: [...(scope?.querySelectorAll(".source-node") ?? [])].map((node) => node.getAttribute("aria-label") ?? "").filter((label) => label.startsWith("Supplied link [")).length,
          captions: scope ? window.__echoCaptionsUnderCards(scope) : null,
          struck: scope ? window.__echoCaptionsStruck(scope).struck : ["no tree"],
        };
      });
      const wantBadges = wantRows.map((row) => row.split(" — ")[0]).sort();
      if (JSON.stringify(tree.badges) !== JSON.stringify(wantBadges) || tree.labels !== 5 || !tree.captions?.count || tree.captions.covered.length || tree.captions.astray.length || tree.struck.length) fail(`the v2 result page tree: cards ${JSON.stringify(tree.badges)} (${tree.labels} spoken), captions ${JSON.stringify(tree.captions)}, struck ${JSON.stringify(tree.struck)}`);
      else ok(`the v2 result page tree's cards read ${tree.badges.join(", ")}, as the per-link list; its ${tree.captions.count} link captions sit clear beside their target cards`);
    }
    // Round 11: asurion.com (the origin) has no derived link of its own; Fox 13 → church blog hang off PR Newswire, its
    // same release. Its source detail and root ledger row count the pair's echoes once each and say whose are included.
    {
      await page.locator(".result-stack .source-tree-explorer .source-node", { hasText: "asurion.com" }).first().click();
      await page.waitForTimeout(150);
      const reach = await page.evaluate(() => ({
        count: document.querySelector(".map-layout .detail-card .source-reach-count > strong")?.textContent ?? "",
        label: document.querySelector(".map-layout .detail-card .source-reach-count > span")?.textContent ?? "",
        explore: document.querySelector(".map-layout .detail-card .source-reach summary")?.textContent ?? "",
        ledger: Object.fromEntries([...document.querySelectorAll(".root-ledger-list button")].map((button) => [
          button.querySelector(".root-ledger-source small")?.textContent?.split(" · ")[0] ?? "",
          [...button.querySelectorAll(":scope > span:nth-child(3) small")].map((small) => small.textContent).join(" "),
        ])),
      }));
      const wantLabel = "likely downstream echoes1 directly linked(including prnewswire.com's, published together)";
      if (reach.count !== "2" || reach.label !== wantLabel || reach.explore !== "Explore these 2 pages" || reach.ledger["asurion.com"] !== "2 likely downstream echoes (including prnewswire.com's, published together)" || reach.ledger["prnewswire.com"] !== "2 likely downstream echoes") fail(`v2 asurion.com downstream spread: ${JSON.stringify(reach)}`);
      else ok("v2: asurion.com's source detail and root ledger show 2 likely downstream echoes \"(including prnewswire.com's, published together)\"; prnewswire.com's row shows its own 2");
    }
    const citeLine = (await page.locator("[aria-label='Which links to cite once'] p").first().textContent().catch(() => ""))?.trim();
    if (citeLine !== "Cite once: [1] asurion.com (also published as [2]). Repeats it: [3], [5]. Unclear: [4].") fail(`the v2 trace's cite-once line reads "${citeLine}"`);
    else ok(`its cite-once line: "${citeLine}"`);
    // QA round 4 D4: the read line accounts for every page, the root pages published together too, on the result card
    // and on Present slide 1.
    {
      const wantRead = "Echo read all 5 supplied links and ran no web search. Of the 5 pages about this claim: 2 root pages published together (1 independent origin), 2 confirmed copies of another supplied page, 1 unclear.";
      const cardRead = (await page.locator("[aria-label='Supplied sources result'] p", { hasText: "Echo read all" }).first().textContent().catch(() => ""))?.trim();
      await page.locator(".present-button").click();
      await page.locator(".stage-presentation").waitFor({ timeout: 5_000 });
      const slideRead = (await page.locator(".stage-content article[aria-label='The claim and the supplied links'] p", { hasText: "Echo read all" }).first().textContent().catch(() => ""))?.trim();
      await page.keyboard.press("Escape");
      await page.locator(".stage-presentation").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
      if (cardRead !== wantRead || slideRead !== wantRead) fail(`the v2 trace's read line: card "${cardRead}", slide 1 "${slideRead}"`);
      else ok(`its read line names every page, on the card and slide 1: "${wantRead.split(": ")[1]}"`);
    }
    await page.emulateMedia({ media: "print" });
    const printed = (await page.locator(".print-report .print-verdict").innerText().catch(() => "")) ?? "";
    await page.emulateMedia({ media: "screen" });
    if (!/Echo collapses repeated pages to their independent origins\. 1 relationship remains unresolved\./.test(printed) || /relationships remain/.test(printed) || /% echo/.test(printed)) fail(`the v2 sources trace's printed verdict reads "${printed.replace(/\s+/g, " ").slice(0, 240)}"`);
    else ok("its printed verdict says \"1 relationship remains unresolved\" (singular) and shows no echo rate");
    // QA round 5 (S2-1): the same five links pasted in another order or numbering keep one lead for the co-published
    // pair on every surface. With PR Newswire pasted first, the list and Cite once named prnewswire.com the origin while
    // the tree tagged asurion.com ORIGIN and the answer cited asurion.com. Now asurion.com (its own evidence, cited by
    // the answer) leads the list, Cite once, the result tree, Present slide 1's list and slide 3's tree.
    {
      const fixture = JSON.parse(fs.readFileSync(v2, "utf8"));
      const baseUrls = fixture.analysis.sourceCheck.urls;
      const hostOf = (url) => new URL(url).hostname.replace(/^www\./, "");
      for (const [label, order, numbers] of [["PR Newswire pasted first", [1, 0, 2, 3, 4], null], ["PR Newswire first, numbered [4]..[8]", [1, 0, 2, 3, 4], [4, 5, 6, 7, 8]], ["supplied order, numbered [4]..[8]", [0, 1, 2, 3, 4], [4, 5, 6, 7, 8]]]) {
        const variant = structuredClone(fixture);
        variant.analysis.sourceCheck = { ...variant.analysis.sourceCheck, urls: order.map((index) => baseUrls[index]) };
        if (numbers) variant.analysis.sourceCheck.numbers = numbers; else delete variant.analysis.sourceCheck.numbers;
        const shown = numbers ?? [1, 2, 3, 4, 5];
        const n = (host) => shown[order.findIndex((index) => hostOf(baseUrls[index]) === host)];
        const [asurion, pr] = [n("asurion.com"), n("prnewswire.com")];
        await page.setViewportSize({ width: 1366, height: 768 });
        await page.goto(mockBase);
        await page.locator("input[aria-label='Open saved Echo trace file']").setInputFiles({ name: "sources-reordered.echo.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(variant)) });
        await page.locator("[aria-label='Each supplied link'] li").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
        const seen = await page.evaluate(() => ({
          rows: [...document.querySelectorAll("[aria-label='Each supplied link'] li")].map((item) => [...item.children].map((child) => child.textContent.trim()).join(" ")),
          cite: document.querySelector("[aria-label='Which links to cite once'] p")?.textContent?.trim() ?? "",
          tags: Object.fromEntries([...document.querySelectorAll(".result-stack .source-tree-explorer .source-node")].map((node) => [node.querySelector(".node-domain")?.textContent ?? "", node.querySelector(".node-tag")?.textContent ?? ""]).filter(([, tag]) => tag)),
          answer: [...new Set([...document.querySelectorAll(".result-stack a.citation")].map((link) => new URL(link.href).hostname.replace(/^www\./, "")))],
        }));
        await page.locator(".present-button").click();
        await page.locator(".stage-presentation").waitFor({ timeout: 5_000 });
        const slide1 = await page.locator(".stage-content").innerText().catch(() => "");
        // The tree is slide 3 since the evidence funnel became slide 2 (11/14).
        await page.locator(".stage-progress button", { hasText: "The source tree" }).click();
        await page.waitForTimeout(300);
        const slide2 = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".stage-presentation .source-node")].map((node) => [node.querySelector(".node-domain")?.textContent ?? "", node.querySelector(".node-tag")?.textContent ?? ""]).filter(([, tag]) => tag)));
        await page.keyboard.press("Escape");
        await page.locator(".stage-presentation").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
        const wantOrigin = `[${asurion}] asurion.com — independent origin, with its own evidence`;
        const wantSame = `[${pr}] prnewswire.com — published together with [${asurion}], one origin`;
        const wantCite = `Cite once: [${asurion}] asurion.com (also published as [${pr}]).`;
        const problems = [
          seen.rows.includes(wantOrigin) && seen.rows.includes(wantSame) ? "" : `list ${JSON.stringify(seen.rows)}`,
          seen.cite.startsWith(wantCite) ? "" : `Cite once "${seen.cite}"`,
          seen.tags["asurion.com"] === "ORIGIN" && seen.tags["prnewswire.com"] === "SAME RELEASE" ? "" : `result tree tags ${JSON.stringify(seen.tags)}`,
          slide2["asurion.com"] === "ORIGIN" && slide2["prnewswire.com"] === "SAME RELEASE" ? "" : `slide 3 tags ${JSON.stringify(slide2)}`,
          slide1.includes(wantOrigin.replace(" — ", " ").split(" ")[0]) && slide1.includes("published together with [" + asurion + "]") && slide1.includes(wantCite) ? "" : `slide 1 "${slide1.replace(/\s+/g, " ").slice(0, 400)}"`,
          JSON.stringify(seen.answer) === JSON.stringify(["asurion.com"]) ? "" : `the answer cites ${JSON.stringify(seen.answer)}`,
        ].filter(Boolean);
        if (problems.length) fail(`v2 links, ${label}: the co-published lead differs by surface: ${problems.join("; ")}`);
        else ok(`v2 links, ${label}: asurion.com [${asurion}] leads everywhere: list, "${wantCite}", ORIGIN on the result tree and slide 3 (prnewswire.com SAME RELEASE), slide 1, and the answer cites it`);
      }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
  }

  // The saved Check these sources run, bundled (public/demo-traces, offline-cached): "Saved check: 5 links → 1 origin"
  // in the panel and under MORE SAVED RUNS opens it with its capture tag and starts nothing. A failed run of the same
  // five links (reordered, renumbered) offers "Open the saved run of these links"; a run of other links does not.
  // ECHO_SMOKE_SHOTS=<folder> saves the panel button and the opened result at 1280×720.
  {
    const posts = [];
    const countPosts = (request) => { if (request.url().includes("/api/analyze") && request.method() === "POST") posts.push(JSON.parse(request.postData() ?? "{}")); };
    page.on("request", countPosts);
    const shots = process.env.ECHO_SMOKE_SHOTS;
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(mockBase);
      await page.locator("button", { hasText: "Check an AI answer's links" }).first().click();
      const inPanel = page.locator("#source-check button", { hasText: savedCheck.label });
      if (!(await inPanel.isVisible().catch(() => false))) fail(`the Check these sources panel offers no "${savedCheck.label}" button`);
      else {
        if (shots) await page.locator("#source-check").screenshot({ path: path.join(shots, "saved-check-panel-1280x720.png") });
        await inPanel.click();
        const shown = await readSavedCheckOn(page);
        // QA round 5 (S3-10): the click scrolled to the result but left the panel open and the focus on its button, off
        // screen. The panel closes and the focus lands on the result's heading, in view.
        {
          await page.waitForFunction(() => document.activeElement?.matches("[aria-label='Supplied sources result'] h2"), null, { timeout: 3_000 }).catch(() => undefined);
          await page.waitForTimeout(700);
          const landed = await page.evaluate(() => {
            const focused = document.activeElement;
            const box = focused?.getBoundingClientRect();
            return { panel: Boolean(document.querySelector("#source-check")), heading: Boolean(focused?.matches("[aria-label='Supplied sources result'] h2")), text: focused?.textContent?.trim().slice(0, 60) ?? "", inView: Boolean(box && box.top >= 0 && box.bottom <= window.innerHeight) };
          });
          if (landed.panel || !landed.heading || !landed.inView) fail(`after the panel's "${savedCheck.label}": panel open ${landed.panel}, focus on "${landed.text}" (result heading ${landed.heading}, in view ${landed.inView})`);
          else ok(`the panel's "${savedCheck.label}" closes the panel and moves the focus to the result heading, in view ("${landed.text}")`);
        }
        const problems = savedCheckProblems(shown, liveZoneName);
        if (problems.length || posts.length || shown.trace !== "check-these-sources-phones") fail(`the panel's "${savedCheck.label}": ${problems.join("; ")}; ${posts.length} runs; ?trace=${shown.trace}`);
        else ok(`the panel's "${savedCheck.label}" opens the bundled run, "${shown.tag}", headed "${shown.headline.split(/\s*Every|\s*With/)[0]}", every link's verdict as saved (${shown.rows.map((row) => row.split(" — ")[1]).join(" · ")}), and starts no run`);
        if (shots) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.locator("[aria-label='Supplied sources result']").scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(shots, "saved-check-result-1280x720.png") });
        }
        // Its Copy link is the ?trace= link, which reopens the saved run (not the panel) and sends nothing.
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: mockBase });
        await page.locator(".copy-link-button").click();
        const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
        await page.goto(copied || mockBase);
        const again = await readSavedCheckOn(page);
        const panelOpen = await page.locator("#source-check-text").count();
        if (new URL(copied || "http://x/").searchParams.get("trace") !== "check-these-sources-phones" || savedCheckProblems(again, liveZoneName).length || panelOpen || posts.length) fail(`the saved check's Copy link "${copied}" reopens: ${savedCheckProblems(again, liveZoneName).join("; ") || "ok"}, panel open ${panelOpen > 0}, ${posts.length} runs`);
        else ok("its Copy link is ?trace=check-these-sources-phones, which reopens the saved run, fills no panel and sends nothing");
      }
      await page.goto(mockBase);
      const chip = page.locator(".backup-row .saved-check-chip", { hasText: savedCheck.label });
      if (!(await chip.isVisible().catch(() => false))) fail(`MORE SAVED RUNS offers no "${savedCheck.label}" chip`);
      else {
        await chip.click();
        const shown = await readSavedCheckOn(page);
        if (savedCheckProblems(shown, liveZoneName).length || posts.length) fail(`the MORE SAVED RUNS chip: ${savedCheckProblems(shown, liveZoneName).join("; ")}; ${posts.length} runs`);
        else ok(`the "${savedCheck.label}" chip under MORE SAVED RUNS opens the same saved run in one click and starts no run`);
        // QA round 5 (S2-2): the [n] badge truncated the domain on every tree card ("[2] prnewswire.c…",
        // "[3] fox13seattle.…") at every desktop size. The number and date now sit on the card's top line, so the
        // whole domain shows on the result page tree and on Present slide 3, the card's height unchanged.
        for (const [width, height] of [[1280, 720], [1920, 1080]]) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(200);
          const domainsOf = (scope) => page.evaluate((selector) => Object.fromEntries([...document.querySelectorAll(`${selector} .source-node`)].map((node) => {
            const domain = node.querySelector(".node-domain");
            const badge = node.querySelector(".node-cite")?.getBoundingClientRect();
            const card = node.getBoundingClientRect();
            const inside = badge && badge.width >= 8 && badge.left >= card.left && badge.right <= card.right && badge.top >= card.top && badge.bottom <= card.bottom;
            return [domain?.textContent ?? "", domain && domain.scrollWidth <= domain.clientWidth && inside ? "whole" : `cut (${domain?.clientWidth}/${domain?.scrollWidth}px, badge ${inside ? "inside" : "outside"} its card)`];
          })), scope);
          const onResult = await domainsOf(".result-stack .source-tree-explorer");
          await page.locator(".present-button").click();
          await page.locator(".stage-presentation").waitFor({ timeout: 5_000 });
          await page.locator(".stage-progress button", { hasText: "The source tree" }).click();
          await page.waitForTimeout(300);
          const onSlide = await domainsOf(".stage-content .stage-tree-slide");
          await page.keyboard.press("Escape");
          await page.locator(".stage-presentation").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
          const cut = ["prnewswire.com", "fox13seattle.com", "churchandculture.org"].flatMap((domain) => [["result page", onResult], ["slide 3", onSlide]].filter(([, seen]) => seen[domain] !== "whole").map(([where, seen]) => `${domain} on the ${where}: ${seen[domain] ?? "missing"}`));
          if (cut.length) fail(`the saved check at ${width}x${height}: ${cut.join("; ")}`);
          else ok(`the saved check at ${width}x${height}: prnewswire.com, fox13seattle.com and churchandculture.org show whole beside their [n] badges, on the result page tree and Present slide 3`);
        }
        await page.setViewportSize({ width: 1280, height: 720 });
      }
      // A failed run of the same five links, pasted in another order with other numbers: the card offers the saved run.
      await page.route("**/api/analyze", (route) => (route.request().method() === "POST"
        ? route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: error\ndata: ${JSON.stringify({ code: "CLAUDE_OVERLOADED", message: "Claude is busy. Try again in a moment." })}\n\n` })
        : route.continue()));
      const order = [3, 0, 4, 1, 2];
      for (const [label, urls, offered] of [["the same five links, reordered", order.map((index) => savedCheck.urls[index]), true], ["four of them", savedCheck.urls.slice(0, 4), false]]) {
        await page.goto(mockBase);
        await page.locator("button", { hasText: "Check an AI answer's links" }).first().click();
        await page.locator("#source-check-text").fill(`Sample answer: Americans check their phones 96 times a day.\n${urls.map((url, index) => `[${index + 2}] ${url}`).join("\n")}`);
        await page.locator("#source-check-claim").fill("Americans check their phones 96 times a day");
        const before = posts.length;
        await page.locator("#source-check button.trace-button").click();
        await page.locator(".error-banner").waitFor({ timeout: 15_000 }).catch(() => undefined);
        const fallback = page.locator(".error-banner button", { hasText: "Open the saved run of these links" });
        const shownFallback = await fallback.isVisible().catch(() => false);
        if (posts.length !== before + 1 || shownFallback !== offered) { fail(`a failed run of ${label}: ${posts.length - before} runs sent, "Open the saved run of these links" ${shownFallback ? "offered" : "not offered"}`); continue; }
        if (!offered) { ok(`a failed run of ${label} does not offer the saved run of the five`); continue; }
        await fallback.click();
        const shown = await readSavedCheckOn(page);
        if (savedCheckProblems(shown, liveZoneName).length || posts.length !== before + 1 || await page.locator(".error-banner").count()) fail(`"Open the saved run of these links": ${savedCheckProblems(shown, liveZoneName).join("; ")}; ${posts.length - before - 1} more runs`);
        else ok(`a failed run of ${label} offers "Open the saved run of these links", which opens the saved run ("${shown.tag}") and sends nothing more`);
      }
    } finally {
      await page.unroute("**/api/analyze");
      page.off("request", countPosts);
      await page.setViewportSize({ width: 1920, height: 1080 });
    }
  }

  // QA round 4 D1: a supplied-sources answer numbers its citations as the supplied links do. The v2 trace with its
  // links pasted as [2]–[6]: the answer card's markers, its cited-source list and passages, Present slide 6's ORIGINS
  // CITED and the copied report all say [2] asurion.com, as the per-link list and Cite once do (never the model's [1]).
  {
    const renumbered = JSON.parse(fs.readFileSync(path.join(root, "scripts", "fixtures", "sources-phones-live-2026-11-13-v2.echo.json"), "utf8"));
    renumbered.analysis.sourceCheck = { ...renumbered.analysis.sourceCheck, numbers: [2, 3, 4, 5, 6] };
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(mockBase);
    await page.locator("input[aria-label='Open saved Echo trace file']").setInputFiles({ name: "sources-renumbered.echo.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(renumbered)) });
    await page.locator("[aria-label='Each supplied link'] li", { hasText: "[6]" }).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
    const card = await page.evaluate(() => ({
      markers: [...new Set([...document.querySelectorAll(".answer-card .answer-text .citation")].map((node) => node.textContent))],
      chips: [...document.querySelectorAll(".answer-card .answer-sources .source-chip")].map((node) => node.textContent.replace("↗", "").trim()),
      passages: [...document.querySelectorAll(".answer-card .answer-evidence-item strong")].map((node) => node.textContent.split(" ")[0]),
      cite: document.querySelector("[aria-label='Which links to cite once'] p")?.textContent ?? "",
    }));
    if (JSON.stringify(card.markers) !== JSON.stringify(["[2]"]) || JSON.stringify(card.chips) !== JSON.stringify(["[2]asurion.com"]) || JSON.stringify(card.passages) !== JSON.stringify(["[2]"]) || !card.cite.startsWith("Cite once: [2] asurion.com")) fail(`links pasted as [2]–[6]: the answer card's markers ${JSON.stringify(card.markers)}, cited sources ${JSON.stringify(card.chips)}, passages ${JSON.stringify(card.passages)}; Cite once "${card.cite}"`);
    else ok("links pasted as [2]–[6]: the answer card cites [2] asurion.com in its text, its cited sources and passages, as Cite once does");
    {
      const cardsOf = (selector) => page.evaluate((scope) => [...document.querySelectorAll(`${scope} .source-node`)].map((node) => `${node.querySelector(".node-cite")?.textContent ?? "none"} ${node.querySelector(".node-domain")?.textContent ?? ""}`).sort(), selector);
      const want = ["[2] asurion.com", "[3] prnewswire.com", "[4] fox13seattle.com", "[5] kabc.com", "[6] churchandculture.org"];
      const cards = await cardsOf(".result-stack .source-tree-explorer");
      if (JSON.stringify(cards) !== JSON.stringify(want)) fail(`links pasted as [2]–[6]: the result page tree's cards read ${JSON.stringify(cards)}`);
      else ok(`links pasted as [2]–[6]: the result page tree's cards read ${cards.join(", ")}`);
    }
    await resultActionOn(page, "Copy report");
    const report = (await page.evaluate(() => navigator.clipboard.readText()).catch(() => "")).split("\n");
    const answerLine = report[report.indexOf("Answer from independent origins:") + 1] ?? "";
    const citedLine = report[report.indexOf("Answer citations and retrieved passages:") + 1] ?? "";
    if (!/\[2\]/.test(answerLine) || /\[1\]/.test(answerLine) || !/^\[2\] .* — asurion\.com$/.test(citedLine)) fail(`links pasted as [2]–[6]: the report's answer reads "${answerLine.slice(0, 120)}", its first citation "${citedLine}"`);
    else ok(`the copied report's answer and its citations say [2] too ("${citedLine}")`);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.locator(".present-button").click();
    await page.locator(".stage-presentation").waitFor({ timeout: 5_000 });
    {
      await page.locator(".stage-progress button", { hasText: "The source tree" }).click();
      await page.waitForTimeout(250);
      const cards = await page.evaluate(() => [...document.querySelectorAll(".stage-content .stage-tree-slide .source-node")].map((node) => `${node.querySelector(".node-cite")?.textContent ?? "none"} ${node.querySelector(".node-domain")?.textContent ?? ""}`).sort());
      const want = ["[2] asurion.com", "[3] prnewswire.com", "[4] fox13seattle.com", "[5] kabc.com", "[6] churchandculture.org"];
      if (JSON.stringify(cards) !== JSON.stringify(want)) fail(`links pasted as [2]–[6]: Present slide 3's cards read ${JSON.stringify(cards)}`);
      else ok("and Present slide 3's cards read [2] asurion.com … [6] churchandculture.org");
    }
    await page.locator(".stage-progress button", { hasText: "The takeaway" }).click();
    await page.waitForTimeout(250);
    const slide = await page.evaluate(() => ({
      markers: [...new Set([...document.querySelectorAll(".stage-answer .citation")].map((node) => node.textContent))],
      cited: [...document.querySelectorAll(".stage-source-links a, .stage-source-links span:not(:first-child)")].map((node) => node.textContent.replace("↗", "").trim()),
    }));
    if (JSON.stringify(slide.markers) !== JSON.stringify(["[2]"]) || JSON.stringify(slide.cited) !== JSON.stringify(["[2] asurion.com"])) fail(`links pasted as [2]–[6]: Present slide 6 cites ${JSON.stringify(slide.markers)} and lists ORIGINS CITED ${JSON.stringify(slide.cited)}`);
    else ok("and Present slide 6 cites [2] in the answer and lists ORIGINS CITED [2] asurion.com");
    await page.keyboard.press("Escape");
    await page.locator(".stage-presentation").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
  }

  // QA round 3 in the panel: a short cited sentence fills the sentence box, links with no sentence ask for one, IPv6
  // links get warning chips, an empty list's button says "Add links to check", and (QA round 4 D3) a flagged chip keeps
  // the button disabled, so a list the server would refuse is never sent.
  {
    const posts = [];
    const countPosts = (request) => { if (request.url().includes("/api/analyze") && request.method() === "POST") posts.push(request.url()); };
    page.on("request", countPosts);
    const panelText = async () => (await page.locator("#source-check").innerText().catch(() => "")) ?? "";
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(mockBase);
    await page.waitForTimeout(600);
    await page.locator("button", { hasText: "Check an AI answer's links" }).first().click();
    await page.locator("#source-check-text").fill("Americans check phones 96 times a day.[^1]\n\n[^1]: https://www.asurion.com/a");
    const shortPick = await page.locator("#source-check-claim").inputValue();
    if (shortPick !== "Americans check phones 96 times a day.") fail(`a short cited sentence filled the sentence box with "${shortPick}"`);
    else ok(`a short cited sentence (under 40 characters) still fills the sentence box: "${shortPick}"`);
    await page.locator("#source-check-text").fill("https://www.asurion.com/a\nhttps://www.prnewswire.com/b");
    const hint = /Type the sentence to check/.test(await panelText());
    const waiting = (await page.locator("#source-check button.trace-button span").first().innerText()).trim();
    if (!hint || (await page.locator("#source-check-claim").inputValue())) fail(`links with no sentence: hint shown ${hint}, sentence box "${await page.locator("#source-check-claim").inputValue()}"`);
    else ok(`links with no sentence leave the box empty and say "Type the sentence to check" (button "${waiting}", disabled)`);
    await page.locator("#source-check-text").fill("[1] http://[::1]/q\n[2] https://[2606:4700::1111]:8443/x\n[3] https://www.asurion.com/a");
    await page.locator("#source-check-claim").fill("Americans check their phones 96 times a day");
    const chips = await page.locator("[aria-label='Links Echo will read'] li").evaluateAll((items) => items.map((item) => `${item.querySelector("b")?.textContent} ${item.querySelector("span")?.textContent} ${item.dataset.unreadable ?? "readable"}: ${item.querySelector("small")?.textContent ?? ""}`));
    const wantChips = ["[1] [::1]/q not public: not a public address — Echo won't read it", "[2] [2606:4700::1111]:8443/x ipv6: an IPv6 address — Echo won't read it", "[3] asurion.com/a readable: "];
    if (JSON.stringify(chips) !== JSON.stringify(wantChips) || !/Check 3 sources/.test(await panelText())) fail(`IPv6 links: chips ${JSON.stringify(chips)}`);
    else ok("IPv6 links show as chips with warnings (http://[::1] not public, https://[2606:4700::1111]:8443 an IPv6 address, its port kept), and the count keeps them");
    // QA round 4 D3: while a chip is flagged the button stays disabled and says why, so no list the server would
    // refuse is sent; removing the flagged chips enables it.
    {
      const blocked = await page.locator("#source-check button.trace-button").isDisabled();
      const reason = /Remove the 2 links Echo won't read; the button waits for that\./.test(await panelText());
      for (let index = 0; index < 2; index += 1) await page.locator("[aria-label='Links Echo will read'] li[data-unreadable] button").first().click();
      const freed = await page.locator("#source-check button.trace-button").isEnabled();
      const reasonGone = !/the button waits for that/.test(await panelText());
      if (!blocked || !reason || !freed || !reasonGone || posts.length) fail(`flagged chips: button disabled ${blocked}, reason shown ${reason}; with them removed enabled ${freed}, reason gone ${reasonGone}; ${posts.length} POSTs`);
      else ok("with a flagged chip the Check button is disabled and says \"Remove the 2 links Echo won't read; the button waits for that.\"; removing them enables it, and nothing was sent");
    }
    // Cleared first: a removal lasts only while its link is still pasted.
    await page.locator("#source-check-text").fill("");
    await page.locator("#source-check-text").fill("[1] http://[::1]/q\n[2] https://[2606:4700::1111]/x\n[3] https://www.asurion.com/a");
    for (let index = 0; index < 3; index += 1) await page.locator("[aria-label='Links Echo will read'] li button").first().click();
    const emptyLabel = (await page.locator("#source-check button.trace-button span").first().innerText()).trim();
    const emptyDisabled = await page.locator("#source-check button.trace-button").isDisabled();
    if (emptyLabel !== "Add links to check" || !emptyDisabled) fail(`with every chip removed the button reads "${emptyLabel}" (disabled ${emptyDisabled})`);
    else ok("with every chip removed the disabled button reads \"Add links to check\", not \"Check 0 sources\"");
    // A local link is flagged too: the button waits, nothing is sent, and removing that chip lets the rest be checked.
    await page.locator("#source-check-text").fill("");
    await page.locator("#source-check-text").fill("[1] http://localhost:3000/x\n[2] https://www.asurion.com/a");
    await page.locator("#source-check-claim").fill("Americans check their phones 96 times a day");
    const localBlocked = await page.locator("#source-check button.trace-button").isDisabled();
    await page.locator("[aria-label='Links Echo will read'] li", { hasText: "localhost" }).locator("button").click();
    await page.waitForTimeout(300);
    const localFreed = await page.locator("#source-check button.trace-button").isEnabled();
    if (!localBlocked || !localFreed || await page.locator(".error-banner").count()) fail(`a local link: button disabled ${localBlocked}, enabled once removed ${localFreed}, error banner ${await page.locator(".error-banner").count()}`);
    else ok("a local link keeps the button disabled (no refused request, no error banner) until its chip is removed");
    if (posts.length) fail(`these panel checks sent ${posts.length} POSTs (expected none)`);
    else ok("none of these panel checks sent a request");
    page.off("request", countPosts);
    await page.setViewportSize({ width: 1920, height: 1080 });
  }

  // The panel's edges (QA round 2): a removed chip comes back when pasted again, removal says so and can be undone,
  // over-long and over-20 links are reported, a ?urls= link at 1366×768 brings the panel on screen without taking the
  // focus, and offline the panel says reading the links needs internet. None of it sends anything.
  {
    const posts = [];
    const countPosts = (request) => { if (request.url().includes("/api/analyze") && request.method() === "POST") posts.push(request.url()); };
    page.on("request", countPosts);
    const [one, two] = ["https://one.example/a", "https://two.example/b"];
    const chipCount = () => page.locator("[aria-label='Links Echo will read'] li").count();
    const panelText = async () => (await page.locator("#source-check").innerText().catch(() => "")) ?? "";
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(mockBase);
    await page.locator("button", { hasText: "Check an AI answer's links" }).first().click();
    await page.locator("#source-check-text").fill(`${one}\n${two}`);
    await page.locator("[aria-label='Links Echo will read'] li", { hasText: "two.example" }).locator("button").click();
    const removedNote = /1 link removed from this paste/.test(await panelText());
    await page.locator("#source-check-text").fill(two);
    const onlyRemoved = await chipCount();
    const onlyRemovedText = await panelText();
    await page.locator("#source-check button", { hasText: "Undo" }).click();
    const undone = await chipCount();
    await page.locator("[aria-label='Links Echo will read'] li").locator("button").click();
    await page.locator("#source-check-text").fill("");
    await page.locator("#source-check-text").fill(two);
    const repasted = await chipCount();
    if (!removedNote || onlyRemoved !== 0 || /No http or https links found/.test(onlyRemovedText) || !/Add links to check|1 link removed/.test(onlyRemovedText) || /Check 0 sources/.test(onlyRemovedText) || undone !== 1 || repasted !== 1) fail(`removing a chip: note ${removedNote}, only the removed link left shows ${onlyRemoved} chips ("${onlyRemovedText.slice(0, 120)}"), Undo gives ${undone}, cleared and pasted again gives ${repasted}`);
    else ok("a removed chip says so with Undo (never “no links found”), and pasting it again after clearing the box brings it back");
    // S3-4: a private or local address, or a link with a username or password, gets a warning chip with a short note
    // before any click (the server's own address rules, run on the text); the public link stays a normal chip.
    await page.locator("#source-check-text").fill(`[1] ${one}\n[2] http://192.168.1.1/admin\n[3] http://user:pw@example.com/x\n[4] http://localhost:3000/x`);
    const warned = await page.locator("[aria-label='Links Echo will read'] li").evaluateAll((items) => items.map((item) => `${item.dataset.unreadable ?? "readable"}: ${item.querySelector("small")?.textContent ?? ""}`));
    const warnLine = /Echo won't read 3 of these links: it reads only public web addresses without a username or password/.test(await panelText());
    const wantWarned = ["readable: ", "not public: not a public address — Echo won't read it", "credentials: has a username or password — Echo won't read it", "not public: not a public address — Echo won't read it"];
    if (JSON.stringify(warned) !== JSON.stringify(wantWarned) || !warnLine || /user:|:pw|pw@/.test(await page.locator("[aria-label='Links Echo will read']").innerText())) fail(`private and credential links before the click: chips ${JSON.stringify(warned)}, panel note ${warnLine}`);
    else ok("a private address, localhost and a link with a username or password get warning chips (“not a public address — Echo won't read it”) before any click, and the panel says Echo won't read 3 of them");
    await page.locator("#source-check-text").fill(`${one} https://long.example/${"x".repeat(2_100)}`);
    const longNote = /1 link is longer than 2,000 characters and left out/.test(await panelText());
    if (!longNote || (await chipCount()) !== 1) fail(`an over-long pasted link is not reported (${await chipCount()} chips)`);
    else ok("a pasted link over 2,000 characters is reported as left out");
    // A ?urls= link with 25 links: 20 chips and a note; at 1366×768 the sentence box and button are on screen; no focus taken.
    const many = Array.from({ length: 25 }, (_, index) => `https://n${index}.example/x`).join(" ");
    await page.goto(`${mockBase}/?claim=${encodeURIComponent("Americans check their phones 96 times a day")}&urls=${encodeURIComponent(many)}`);
    await page.locator("#source-check-claim").waitFor({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const fromLink = { chips: await chipCount(), note: /5 more links were left out/.test(await panelText()) };
    const placed = await page.evaluate(() => {
      const inView = (element) => { const box = element?.getBoundingClientRect(); return Boolean(box) && box.top >= 0 && box.bottom <= window.innerHeight; };
      return { claim: inView(document.getElementById("source-check-claim")), button: inView(document.querySelector("#source-check button.trace-button")), focusInPanel: Boolean(document.activeElement?.closest?.("#source-check")) };
    });
    if (fromLink.chips !== 20 || !fromLink.note) fail(`a ?urls= link with 25 links shows ${fromLink.chips} chips (left-out note: ${fromLink.note})`);
    else ok("a ?urls= link with 25 links shows 20 chips and says 5 more were left out");
    if (!placed.claim || !placed.button || placed.focusInPanel) fail(`a ?urls= link at 1366×768: ${JSON.stringify(placed)}`);
    else ok("at 1366×768 a ?urls= link brings the panel's sentence box and button on screen without taking the focus");
    // Offline, the button explains that reading the links needs internet (no search is involved).
    await page.goto(`${mockBase}/?claim=${encodeURIComponent("Americans check their phones 96 times a day")}&urls=${encodeURIComponent(one)}`);
    await page.locator("#source-check button.trace-button").waitFor({ timeout: 10_000 }).catch(() => undefined);
    await page.context().setOffline(true);
    await page.locator("#source-check button.trace-button").click();
    const offline = (await page.locator(".error-banner").innerText({ timeout: 5_000 }).catch(() => "")) ?? "";
    await page.context().setOffline(false);
    if (!/reading the supplied links needs internet/.test(offline) || !/the saved check of five links/.test(offline) || /live search needs/.test(offline)) fail(`offline, Check 1 source says "${offline.slice(0, 200)}"`);
    else ok("offline, Check 1 source says reading the supplied links needs internet");
    if (posts.length) fail(`the panel edge checks sent ${posts.length} POSTs`);
    else ok("none of these panel edges sent a request");
    page.off("request", countPosts);
    await page.setViewportSize({ width: 1920, height: 1080 });
  }
} catch (error) {
  fail(`live run check crashed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await liveBrowser?.close();
  mockServer.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
}

// At 1366x768, 1280x720 and 390x844 the progress card and the error banner render below the fold, so pressing Trace
// sources looked like it did nothing. Each must come into view on its own; at 1920x1080, where the card already shows,
// the page must not move. Its own mocked server and scratch ledger, so these runs cannot reach the day's mock cap above.
process.stdout.write("\nLive-run feedback in view (mocked providers)\n");
{
  const feedbackScratch = fs.mkdtempSync(path.join(os.tmpdir(), "echo-smoke-feedback-"));
  const feedbackMarker = path.join(feedbackScratch, "mock-loaded");
  const feedbackBase = `http://127.0.0.1:${await freePort()}`;
  const feedbackServer = spawn(path.join(root, "node_modules", ".bin", "next"), ["start", root, "-p", new URL(feedbackBase).port, "-H", "127.0.0.1"], {
    cwd: feedbackScratch,
    stdio: "ignore",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "smoke-mock-key",
      TAVILY_API_KEY: "smoke-mock-key",
      TELEM_API_KEY: "",
      ECHO_SEARCH_ROUTER: "tavily",
      ECHO_COPY_HUNT: "0",
      ECHO_DAILY_CAP_OVERRIDE_USD: "",
      NEXT_TELEMETRY_DISABLED: "1",
      ECHO_SMOKE_MOCK_MARKER: feedbackMarker,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(path.join(root, "scripts", "smoke-mock-providers.mjs")).href}`.trim(),
    },
  });
  let feedbackBrowser;
  // Where an element sits once any smooth scroll has settled.
  const placed = async (page, selector) => {
    let last = -1;
    for (let tries = 0; tries < 20; tries += 1) {
      await page.waitForTimeout(100);
      const y = await page.evaluate(() => window.scrollY);
      if (y === last) break;
      last = y;
    }
    return page.evaluate((wanted) => {
      const box = document.querySelector(wanted)?.getBoundingClientRect();
      return box ? { scrollY: Math.round(window.scrollY), top: Math.round(box.top), bottom: Math.round(box.bottom), height: window.innerHeight } : null;
    }, selector);
  };
  const fullyShown = (box) => Boolean(box && box.top >= 0 && box.bottom <= box.height);
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { if ((await fetch(feedbackBase)).ok) break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    if (!fs.existsSync(feedbackMarker)) throw new Error("the mocked-provider server did not load its mock");
    feedbackBrowser = await chromium.launch({ channel: "chrome", headless: !headed });
    for (const [width, height] of [[1366, 768], [1280, 720], [390, 844], [1920, 1080]]) {
      const size = `${width}x${height}`;
      const page = await (await feedbackBrowser.newContext({ viewport: { width, height } })).newPage();
      await page.goto(feedbackBase);
      await page.waitForFunction(() => !(document.querySelector(".key-note")?.textContent ?? "Checking").includes("Checking"), null, { timeout: 5_000 }).catch(() => undefined);
      // Slot 03 forces a fresh search, so the server's cache of the same claim from another viewport is not used.
      await page.locator(".preset-live").click();
      await page.locator("#claim-input").fill("Is it true that 90% of startups fail?");
      await page.locator("#claim-input").press("Enter");
      await page.locator(".loading-card").waitFor({ timeout: 5_000 }).catch(() => undefined);
      const card = await placed(page, ".loading-card");
      // Read at once with the card: this run finishes in about 5 s and then scrolls to its result.
      const claimBox = await page.evaluate(() => { const box = document.getElementById("claim-input")?.getBoundingClientRect(); return box ? { top: Math.round(box.top), bottom: Math.round(box.bottom), height: window.innerHeight } : null; });
      if (!fullyShown(card)) fail(`at ${size}, pressing Trace sources leaves the progress card off screen (${JSON.stringify(card)})`);
      else if (width === 1920 && card.scrollY !== 0) fail(`at ${size} the progress card was already on screen, but the page scrolled ${card.scrollY}px`);
      else ok(`at ${size}, the progress card is on screen once the run starts (card ${card.top}–${card.bottom}px of ${height}, page scrolled ${card.scrollY}px)`);
      // The card names the claim, and on a laptop screen the page scrolls only far enough to show the card, so the claim
      // box stays in view above it and no screen of empty page is left below (it once scrolled the card to the top,
      // pushing the claim off screen and leaving about 450 px blank for the whole wait).
      const tracing = (await page.locator(".loading-card .loading-claim").textContent().catch(() => "")) ?? "";
      if (tracing !== "Tracing: “Is it true that 90% of startups fail?”") fail(`at ${size}, the progress card does not name the claim (reads "${tracing}")`);
      else ok(`at ${size}, the progress card names the claim: "${tracing}"`);
      if (width >= 1280 && height < 1000) {
        const blank = card ? height - card.bottom : null;
        if (!fullyShown(claimBox) || blank === null || blank > 120) fail(`at ${size}, during the run the claim box is at ${claimBox?.top}–${claimBox?.bottom}px and ${blank}px of screen is empty below the card`);
        else ok(`at ${size}, during the run the claim box stays in view (${claimBox.top}–${claimBox.bottom}px) above the card, ${blank}px empty below it`);
      }
      await page.locator(".result-stack").waitFor({ timeout: 30_000 }).catch(() => undefined);
      const finished = await placed(page, ".result-stack");
      if (!finished || finished.top < 0 || finished.top > finished.height / 3) fail(`at ${size}, a finished live run leaves its result out of view (${JSON.stringify(finished)})`);
      else ok(`at ${size}, a finished live run scrolls to its result (top ${finished.top}px)`);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.locator("#claim-input").fill("90% of startups fail, smoke overload check");
      await page.locator("#claim-input").press("Enter");
      await page.locator(".error-banner").waitFor({ timeout: 30_000 }).catch(() => undefined);
      const banner = await placed(page, ".error-banner");
      const retryShown = fullyShown(await placed(page, ".error-banner .error-fallback"));
      if (!fullyShown(banner) || !retryShown) fail(`at ${size}, a failed live run leaves its error banner or Try again off screen (${JSON.stringify(banner)})`);
      else ok(`at ${size}, a failed live run's error banner and Try again are on screen (banner ${banner.top}–${banner.bottom}px, page scrolled ${banner.scrollY}px)`);
      // The card grows during a run (the sites found, the stall note); its bottom is kept on screen until the presenter
      // scrolls, and then the page is left where they put it. (At 1920x1080 a stall note once ended the card at 1104 px.)
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      await page.locator(".preset-live").click();
      await page.locator("#claim-input").fill("90% of startups fail (smoke slow)");
      await page.locator("#claim-input").press("Enter");
      await page.locator(".loading-card").waitFor({ timeout: 5_000 }).catch(() => undefined);
      await placed(page, ".loading-card");
      const grow = (px) => page.evaluate((extra) => { const filler = document.createElement("div"); filler.className = "smoke-filler"; filler.style.height = `${extra}px`; document.querySelector(".loading-card")?.append(filler); }, px);
      await grow(320);
      const grown = await placed(page, ".loading-card");
      const tall = grown && grown.bottom - grown.top + 32 > height;
      if (!grown || (tall ? grown.top < 0 || grown.top > 16 : !fullyShown(grown))) fail(`at ${size}, a progress card that grows 320 px leaves its bottom off screen (${JSON.stringify(grown)})`);
      else ok(`at ${size}, a progress card that grows 320 px is kept in view (card ${grown.top}–${grown.bottom}px of ${height}, page scrolled ${grown.scrollY}px)`);
      await page.mouse.move(width / 2, height / 2);
      await page.mouse.wheel(0, -120);
      const scrolledTo = (await placed(page, ".loading-card"))?.scrollY;
      await grow(200);
      const after = await placed(page, ".loading-card");
      if (!after || after.scrollY !== scrolledTo) fail(`at ${size}, after the presenter scrolled the card still moved the page (${scrolledTo}px, then ${after?.scrollY}px)`);
      else ok(`at ${size}, once the presenter scrolls, a growing card leaves the page where they put it (${after.scrollY}px)`);
      await page.locator(".loading-card .stop-button").click().catch(() => undefined);
      if (width === 1280) {
        // A "Check these sources" run starts below its own panel, lower still.
        await page.goto(`${feedbackBase}/?claim=${encodeURIComponent("90% of startups fail within ten years")}&urls=${encodeURIComponent("https://origin.example/startup-study https://repeat.example/startups-fail")}`);
        await page.locator("#source-check button.trace-button").click({ timeout: 10_000 });
        await page.locator(".loading-card").waitFor({ timeout: 5_000 }).catch(() => undefined);
        const sourcesCard = await placed(page, ".loading-card");
        if (!fullyShown(sourcesCard)) fail(`at ${size}, a Check these sources run leaves the progress card off screen (${JSON.stringify(sourcesCard)})`);
        else ok(`at ${size}, a Check these sources run brings its progress card on screen (card ${sourcesCard.top}–${sourcesCard.bottom}px)`);
        const checking = (await page.locator(".loading-card .loading-claim").textContent().catch(() => "")) ?? "";
        if (checking !== "Checking 2 supplied links for: “90% of startups fail within ten years”") fail(`at ${size}, a Check these sources card reads "${checking}"`);
        else ok(`at ${size}, a Check these sources card names its links and claim: "${checking}"`);
      }
      await page.context().close();
    }

    // The search plan during the wait: the "queries" step lists the claim's variants and the search steps tick them
    // off. The page's own POST to /api/analyze gets a stream this test writes event by event (a fulfilled route would
    // deliver every event at once), so each tick can be seen arriving, and nothing is searched.
    const plan = [
      "\"90% of startups fail\"",
      `90% of startups fail original source ${"with a very long tail of extra words ".repeat(5)}`,
      "90% of startups fail first published",
      "90% of startups fail study",
      "90% of startups fail statistics source",
      "90% of startups fail evidence",
      "\"90 percent of startups fail\"",
      "90% of startups fail survey data",
      "90% of startups fail research report",
      "90% of startups fail who said it first",
    ];
    const streamedPage = async (width, height) => {
      const context = await feedbackBrowser.newContext({ viewport: { width, height } });
      await context.addInitScript(() => {
        const realFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("/api/analyze") && (init?.method ?? "GET").toUpperCase() === "POST") {
            window.__smokePosts = (window.__smokePosts ?? 0) + 1;
            const body = new ReadableStream({ start(controller) { window.__smokeStream = controller; } });
            return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
          }
          return realFetch(input, init);
        };
      });
      const page = await context.newPage();
      const push = (data) => page.evaluate((value) => window.__smokeStream?.enqueue(new TextEncoder().encode(`event: progress\ndata: ${JSON.stringify(value)}\n\n`)), data);
      return { page, push };
    };
    const readPlan = (page) => page.evaluate(() => {
      const box = document.querySelector(".loading-plan");
      const card = document.querySelector(".loading-card")?.getBoundingClientRect();
      const items = [...document.querySelectorAll(".loading-plan li:not(.loading-plan-more)")];
      return {
        shown: Boolean(box),
        label: box?.querySelector(".loading-domains-label")?.textContent ?? "",
        items: items.map((item) => item.querySelector(".loading-plan-query")?.textContent ?? ""),
        states: items.map((item) => item.dataset.state ?? ""),
        marks: items.map((item) => item.querySelector(".loading-plan-mark")?.textContent ?? ""),
        more: document.querySelector(".loading-plan .loading-plan-more")?.textContent ?? "",
        px: Math.min(...items.map((item) => parseFloat(getComputedStyle(item).fontSize))),
        oneLine: items.every((item) => item.getBoundingClientRect().height < 34),
        // How much taller the plan makes the card: its height now, less its height with the plan taken out (measured
        // and put back in one go, so the page never draws or follows the shorter card).
        grownBy: (() => {
          const node = document.querySelector(".loading-card");
          if (!box || !node) return 0;
          const withPlan = node.getBoundingClientRect().height;
          node.classList.remove("has-plan");
          box.style.display = "none";
          const without = node.getBoundingClientRect().height;
          box.style.display = "";
          node.classList.add("has-plan");
          return Math.round(withPlan - without);
        })(),
        card: card ? { top: Math.round(card.top), bottom: Math.round(card.bottom), height: Math.round(card.height), screen: window.innerHeight } : null,
        domains: document.querySelector(".loading-domains .loading-domains-label")?.textContent ?? "",
        tracing: document.querySelector(".loading-card .loading-claim")?.textContent ?? "",
      };
    });
    const settle = async (page, check) => {
      for (let tries = 0; tries < 30; tries += 1) {
        const state = await readPlan(page);
        if (check(state)) return state;
        await page.waitForTimeout(100);
      }
      return readPlan(page);
    };
    for (const [width, height] of [[1280, 720], [1920, 1080]]) {
      const size = `${width}x${height}`;
      const { page, push } = await streamedPage(width, height);
      await page.goto(feedbackBase);
      await page.waitForFunction(() => !(document.querySelector(".key-note")?.textContent ?? "Checking").includes("Checking"), null, { timeout: 5_000 }).catch(() => undefined);
      await page.locator("#claim-input").fill("Is it true that 90% of startups fail?");
      await page.locator("#claim-input").press("Enter");
      await page.locator(".loading-card").waitFor({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForFunction(() => Boolean(window.__smokeStream), null, { timeout: 5_000 }).catch(() => undefined);
      const before = await readPlan(page);
      await push({ stage: "queries", label: "Building search variants", detail: "Preparing quoted-phrase and origin-focused searches without an extra model call.", queries: plan });
      const listed = await settle(page, (state) => state.shown);
      if (!listed.shown || listed.label !== "SEARCH PLAN · 10 VARIANTS" || listed.items.length !== 5 || listed.more !== "+5 more" || listed.items[0] !== plan[0] || listed.states.some((state) => state !== "waiting")) fail(`at ${size}, the search plan reads ${JSON.stringify(listed)}`);
      else if (listed.items[1].length > 120 || !listed.items[1].endsWith("…")) fail(`at ${size}, an over-long variant is not cut to 120 characters (${listed.items[1].length})`);
      else if (listed.px < 13 || !listed.oneLine) fail(`at ${size}, the plan's variants are ${listed.px}px${listed.oneLine ? "" : " and wrap"}: too small or too tall for a recording`);
      else ok(`at ${size}, the wait lists the search plan before any search ("${listed.label}", 5 variants and "${listed.more}", ${listed.px}px, one line each, none ticked)`);
      if (listed.tracing !== "Tracing: “Is it true that 90% of startups fail?”") fail(`at ${size}, with the plan the claim line reads "${listed.tracing}"`);
      await push({ stage: "search", label: "Searching across the web", detail: "Searching 5 of 10 query variants.", current: 0, total: 10, queriesDone: 0 });
      await push({ stage: "search", label: "Searching across the web", detail: "5 of 10 query variants searched · 6 unique pages so far.", current: 5, total: 10, domains: ["startup.example", "repeat.example", "news.example"], queriesDone: 5 });
      const half = await settle(page, (state) => state.states.filter((state) => state === "done").length === 5 && /3 SITES/.test(state.domains));
      if (half.label !== "SEARCH PLAN · 10 VARIANTS · 5 SEARCHED" || half.states.some((state) => state !== "done") || half.marks.some((mark) => mark !== "✓") || !/FOUND SO FAR · 3 SITES/.test(half.domains)) fail(`at ${size}, after 5 searches the plan reads ${JSON.stringify(half)}`);
      else ok(`at ${size}, the plan ticks variants as they finish, next to the sites found ("${half.label}"; "${half.domains}")`);
      await push({ stage: "search", label: "Searching across the web", detail: "10 of 10 query variants searched · 9 unique pages so far.", current: 10, total: 10, domains: ["startup.example", "repeat.example", "news.example", "blog.example"], queriesDone: 10 });
      // A count never goes back (a late or repeated event), and never past the plan.
      await push({ stage: "search", label: "Searching across the web", detail: "stale", queriesDone: 3 });
      await push({ stage: "search", label: "Searching across the web", detail: "overshoot", queriesDone: 99 });
      const all = await settle(page, (state) => /10 SEARCHED/.test(state.label) && /4 SITES/.test(state.domains));
      if (all.label !== "SEARCH PLAN · 10 VARIANTS · 10 SEARCHED") fail(`at ${size}, after every search (and a stale and an overshooting count) the plan reads "${all.label}"`);
      else ok(`at ${size}, the count reaches all 10 and ignores a stale or overshooting event ("${all.label}")`);
      const grownBy = before.card && all.card ? all.grownBy : null;
      // Where the card sits once the page has followed it (a smooth scroll may still be running).
      const fitted = await placed(page, ".loading-card");
      if (grownBy === null || grownBy > 120) fail(`at ${size}, the search plan makes the card ${grownBy}px taller (at most 120)`);
      else if (!fullyShown(fitted)) fail(`at ${size}, with the plan and the sites the card does not fit on screen (${JSON.stringify(fitted)})`);
      else if (width === 1920 && fitted.scrollY !== 0) fail(`at ${size}, the plan pushed the card past the screen, so the page scrolled ${fitted.scrollY}px`);
      else ok(`at ${size}, the plan adds ${grownBy}px and the card fits on screen (${fitted.top}–${fitted.bottom}px of ${fitted.height}, page scrolled ${fitted.scrollY}px)`);
      if (width === 1280) {
        // The search stopped early (enough pages): once the run moves on, the variants it never needed show a dash.
        await page.locator(".loading-card .stop-button").click().catch(() => undefined);
        await page.locator(".loading-card").waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
        await page.evaluate(() => { window.__smokeStream = null; });
        await page.locator("#claim-input").fill("Is it true that 90% of startups fail?");
        await page.locator("#claim-input").press("Enter");
        await page.waitForFunction(() => Boolean(window.__smokeStream), null, { timeout: 5_000 }).catch(() => undefined);
        await push({ stage: "queries", label: "Building search variants", detail: "x", queries: plan.slice(0, 6) });
        await push({ stage: "search", label: "Enough distinct pages found", detail: "x", current: 6, total: 6, queriesDone: 5 });
        await push({ stage: "extract", label: "Reading source pages", detail: "x", domains: ["startup.example"] });
        const stopped = await settle(page, (state) => /NOT NEEDED/.test(state.label));
        if (stopped.label !== "SEARCH PLAN · 6 VARIANTS · 5 SEARCHED · 1 NOT NEEDED" || stopped.items.length !== 6 || stopped.more || stopped.states.join() !== "done,done,done,done,done,skipped" || stopped.marks[5] !== "–") fail(`at ${size}, an early-stopped search's plan reads ${JSON.stringify(stopped)}`);
        else ok(`at ${size}, a search that stopped early shows the unneeded variant with a dash ("${stopped.label}")`);
      }
      await page.context().close();
    }
    // QA round 6 (S2, beat 5 of the recording): after a 5-link check, the echo. logo (Home) left the Check these
    // sources panel open with the sample answer, between the claim box and the next run's wait card, and both run
    // buttons read the other run's busy label ("Tracing" during the 5-link check, "Checking" during a search). Home
    // now closes the panel and clears its links; each button says "Tracing" or "Checking" only for its own kind of
    // run and is simply disabled during the other. The stream is mocked; nothing is searched or read.
    {
      const size = "1920x1080";
      const { page } = await streamedPage(1920, 1080);
      await page.goto(feedbackBase);
      await page.waitForFunction(() => !(document.querySelector(".key-note")?.textContent ?? "Checking").includes("Checking"), null, { timeout: 5_000 }).catch(() => undefined);
      const buttons = () => page.evaluate(() => {
        const read = (node) => node ? { text: node.textContent?.replace("↗", "").trim() ?? "", disabled: node.disabled } : null;
        return { claim: read(document.querySelector(".claim-row .trace-button")), panel: read(document.querySelector("#source-check button.trace-button")), panelText: document.getElementById("source-check-text")?.value ?? null };
      });
      await page.locator("#source-check-open").click();
      await page.getByRole("button", { name: /Try an example/ }).click();
      // A search run with the panel open: the panel's button keeps its own label, disabled.
      await page.locator(".preset-live").click();
      await page.locator("#claim-input").fill("Americans check their phones 96 times a day");
      await page.locator("#claim-input").press("Enter");
      await page.waitForFunction(() => Boolean(window.__smokeStream), null, { timeout: 5_000 }).catch(() => undefined);
      const searching = await buttons();
      if (searching.claim?.text !== "Tracing" || searching.panel?.text !== "Check 5 sources" || !searching.panel?.disabled) fail(`at ${size}, during a search the buttons read ${JSON.stringify(searching)}`);
      else ok(`at ${size}, during a search the claim box's button reads "Tracing" and the panel's "Check 5 sources" (disabled)`);
      await page.locator(".loading-card .stop-button").click().catch(() => undefined);
      await page.evaluate(() => { window.__smokeStream = null; });
      // The 5-link check: the claim box's button keeps its own label, disabled.
      await page.locator("#source-check button.trace-button").click();
      await page.waitForFunction(() => Boolean(window.__smokeStream), null, { timeout: 5_000 }).catch(() => undefined);
      const checking = await buttons();
      if (checking.panel?.text !== "Checking" || /Tracing|Checking/.test(checking.claim?.text ?? "") || !checking.claim?.disabled) fail(`at ${size}, during a 5-link check the buttons read ${JSON.stringify(checking)}`);
      else ok(`at ${size}, during a 5-link check the panel's button reads "Checking" and the claim box's "${checking.claim.text}" (disabled)`);
      if (process.env.ECHO_SMOKE_SHOTS) await page.screenshot({ path: path.join(process.env.ECHO_SMOKE_SHOTS, "beat5-checking-1920.png") });
      // Home (the echo. logo) mid-run: the panel closes and forgets the sample; reopening it shows an empty paste box.
      await page.locator(".brand").click();
      await page.locator("#source-check").waitFor({ state: "detached", timeout: 3_000 }).catch(() => undefined);
      const home = await buttons();
      await page.evaluate(() => { window.__smokeStream = null; });
      await page.locator("#claim-input").fill("Americans check their phones 96 times a day");
      await page.locator(".preset-live").click();
      await page.locator("#claim-input").press("Enter");
      await page.waitForFunction(() => Boolean(window.__smokeStream), null, { timeout: 5_000 }).catch(() => undefined);
      const traced = await buttons();
      if (process.env.ECHO_SMOKE_SHOTS) await page.screenshot({ path: path.join(process.env.ECHO_SMOKE_SHOTS, "beat5-after-home-1920.png") });
      if (home.panel || home.panelText !== null) fail(`at ${size}, after Home the Check these sources panel is still open (${JSON.stringify(home)})`);
      else if (traced.panel || traced.claim?.text !== "Tracing") fail(`at ${size}, a trace after Home shows ${JSON.stringify(traced)}`);
      else ok(`at ${size}, Home closes the Check these sources panel, and the next trace's wait card sits under the claim box ("Tracing", no panel)`);
      await page.locator(".loading-card .stop-button").click().catch(() => undefined);
      await page.locator("#source-check-open").click();
      const reopened = await buttons();
      if (reopened.panelText !== "") fail(`at ${size}, after Home the reopened panel still holds ${JSON.stringify(reopened.panelText?.slice(0, 80))}`);
      else ok(`at ${size}, after Home the reopened panel's paste box is empty`);
      await page.context().close();
    }
    // Telem routes the searches (TELEM_API_KEY set): each ticked variant shows the providers it went to as small
    // tags ("exa · tavily · brave"), the plan keeps one line per variant and the card still fits; FOUND SO FAR is
    // unchanged. A finished trace whose search audit names Telem says so in the "How Echo checked this" Search cell,
    // naming only the providers it used. The stream is mocked; nothing is searched.
    // ECHO_SMOKE_SHOTS=<folder> also saves the card and the strip.
    {
      const telemShots = process.env.ECHO_SMOKE_SHOTS;
      // QA round 5 (S3-3, S3-4): five lowercase 10px tags squeezed the query to a few characters ("Americans …",
      // "exa · tavily · brave · parallel · perpl…"). Tags are Title Case, three names at most then "+N", 11px, and the
      // query keeps about 20 characters at 1920x1080; on a phone the tags take their own line.
      const routed = { 0: ["exa", "tavily", "brave"], 1: ["exa", "brave"], 2: ["perplexity", "exa"], 3: ["tavily"], 4: ["exa", "parallel", "brave", "perplexity", "tavily"] };
      const bundled = JSON.parse(fs.readFileSync(path.join(root, "public", "demo-traces", "americans-check-phones-96-times.echo.json"), "utf8")).analysis;
      const cycle = [["exa", "tavily", "brave"], ["exa", "brave"], ["tavily", "exa"]];
      const telemTrace = { ...structuredClone(bundled), createdAt: new Date().toISOString(), searchAudit: bundled.searchAudit.map((entry, index) => ({ ...entry, router: "telem", ...(entry.status === "searched" ? { providers: cycle[index % cycle.length] } : {}) })) };
      delete telemTrace.costReceipt;
      for (const [width, height] of [[1280, 720], [1920, 1080]]) {
        const size = `${width}x${height}`;
        const { page, push } = await streamedPage(width, height);
        await page.goto(feedbackBase);
        await page.waitForFunction(() => !(document.querySelector(".key-note")?.textContent ?? "Checking").includes("Checking"), null, { timeout: 5_000 }).catch(() => undefined);
        await page.locator("#claim-input").fill("Is it true that 90% of startups fail?");
        await page.locator("#claim-input").press("Enter");
        await page.waitForFunction(() => Boolean(window.__smokeStream), null, { timeout: 5_000 }).catch(() => undefined);
        await push({ stage: "queries", label: "Building search variants", detail: "x", queries: plan });
        await push({ stage: "search", label: "Searching across the web", detail: "Searching 5 of 10 query variants.", current: 0, total: 10, queriesDone: 0 });
        await push({ stage: "search", label: "Searching across the web", detail: "5 of 10 query variants searched · 23 unique pages so far.", current: 5, total: 10, domains: ["startup.example", "repeat.example", "news.example"], queriesDone: 5, queryProviders: { ...routed, 7: ["exa"], 99: ["brave"], "-1": ["exa"] } });
        // Bad names are dropped (spaces, capitals, markup); a stale event never takes tags away.
        await push({ stage: "search", label: "Searching across the web", detail: "x", queriesDone: 5, queryProviders: { 0: ["Exa Search", "<b>x</b>"], 1: [] } });
        const tagged = await settle(page, (state) => state.states.filter((state) => state === "done").length === 5);
        const tags = await page.evaluate(() => [...document.querySelectorAll(".loading-plan li:not(.loading-plan-more)")].map((item) => item.querySelector(".loading-plan-providers")?.textContent?.replace(/^\s*routed to\s*/, "").trim() ?? ""));
        const tagPx = await page.evaluate(() => Math.min(...[...document.querySelectorAll(".loading-plan-providers")].map((tag) => parseFloat(getComputedStyle(tag).fontSize))));
        // The tags are the point: none is cut short (the query gives way instead).
        const cutTags = await page.evaluate(() => [...document.querySelectorAll(".loading-plan-providers")].filter((tag) => tag.scrollWidth > tag.clientWidth + 1).map((tag) => tag.textContent));
        const wantTags = ["Exa · Tavily · Brave", "Exa · Brave", "Perplexity · Exa", "Tavily", "Exa · Parallel · Brave +2"];
        // How many characters of each tagged variant's query show (its visible share of the text).
        const queryChars = await page.evaluate(() => [...document.querySelectorAll(".loading-plan li")].filter((item) => item.querySelector(".loading-plan-providers")).map((item) => { const query = item.querySelector(".loading-plan-query"); return Math.floor(query.textContent.length * Math.min(1, query.clientWidth / Math.max(1, query.scrollWidth))); }));
        if (JSON.stringify(tags) !== JSON.stringify(wantTags)) fail(`at ${size}, the routed variants' tags read ${JSON.stringify(tags)}`);
        else if (!tagged.oneLine || tagged.px < 13) fail(`at ${size}, with provider tags the plan's variants are ${tagged.px}px${tagged.oneLine ? "" : " and wrap"}`);
        else if (!(tagPx >= 11)) fail(`at ${size}, the provider tags are ${tagPx}px (at least 11)`);
        else if (width === 1920 && Math.min(...queryChars) < 20) fail(`at ${size}, provider tags squeeze a query to ${Math.min(...queryChars)} characters (${JSON.stringify(queryChars)})`);
        else if (cutTags.length) fail(`at ${size}, provider tags are cut short: ${JSON.stringify(cutTags)}`);
        else if (!/FOUND SO FAR · 3 SITES/.test(tagged.domains)) fail(`at ${size}, with provider tags the found-so-far label reads "${tagged.domains}"`);
        else ok(`at ${size}, each routed variant shows its providers (${wantTags.map((tag) => `"${tag}"`).join(", ")}; ${tagPx}px), one line each, the queries keeping ${Math.min(...queryChars)}+ characters; "${tagged.domains}" unchanged`);
        const fitted = await placed(page, ".loading-card");
        if (tagged.grownBy > 120) fail(`at ${size}, the plan with provider tags makes the card ${tagged.grownBy}px taller (at most 120)`);
        else if (!fullyShown(fitted)) fail(`at ${size}, with provider tags the card does not fit on screen (${JSON.stringify(fitted)})`);
        else ok(`at ${size}, with provider tags the plan adds ${tagged.grownBy}px and the card fits (${fitted.top}–${fitted.bottom}px of ${fitted.height})`);
        if (telemShots) {
          fs.mkdirSync(telemShots, { recursive: true });
          await page.locator(".loading-card").screenshot({ path: path.join(telemShots, `telem-wait-${size}.png`) });
        }
        await page.evaluate((trace) => {
          window.__smokeStream?.enqueue(new TextEncoder().encode(`event: result\ndata: ${JSON.stringify(trace)}\n\n`));
          window.__smokeStream?.close();
        }, telemTrace);
        await page.locator(".how-checked").waitFor({ timeout: 10_000 }).catch(() => undefined);
        const searchCell = await page.evaluate(() => {
          const item = [...document.querySelectorAll(".how-checked-steps li")].find((entry) => /Search/.test(entry.querySelector(".how-checked-step")?.textContent ?? ""));
          return item ? `${item.querySelector("strong")?.textContent?.trim()} — ${item.querySelector(".how-checked-detail")?.textContent?.trim()}` : "";
        });
        const searched = telemTrace.searchAudit.filter((entry) => entry.status === "searched");
        const deeper = searched.filter((entry) => entry.depth === "advanced").length;
        if (!searchCell.startsWith(`${searched.length} searches routed by Telem${deeper ? ` (${deeper} deeper)` : ""} — across Exa, Tavily and Brave · `)) fail(`at ${size}, a Telem trace's Search cell reads "${searchCell}"`);
        else ok(`at ${size}, a Telem trace's strip reads "${searchCell}"`);
        if (telemShots) await page.locator(".how-checked").screenshot({ path: path.join(telemShots, `telem-strip-${size}.png`) });
        // The search query audit lists the providers per query.
        const auditLines = await page.evaluate(() => {
          const audit = document.querySelector("details.query-audit");
          if (audit) audit.open = true;
          return [...document.querySelectorAll(".query-audit-item")].slice(0, 3).map((item) => item.querySelector(".query-audit-providers")?.textContent?.trim() ?? "");
        });
        const auditPx = await page.evaluate(() => Math.min(...[...document.querySelectorAll(".query-audit-providers")].map((line) => parseFloat(getComputedStyle(line).fontSize))));
        if (JSON.stringify(auditLines) !== JSON.stringify(["Routed by Telem to Exa, Tavily and Brave", "Routed by Telem to Exa and Brave", "Routed by Telem to Tavily and Exa"]) || !(auditPx >= 11)) fail(`at ${size}, the search audit's provider lines read ${JSON.stringify(auditLines)} at ${auditPx}px`);
        else ok(`at ${size}, the search audit names each query's providers ("${auditLines[0]}", ${auditPx}px)`);
        await page.context().close();
      }
      // On a phone the tags take their own line under the query, which keeps its whole cell width.
      {
        const { page, push } = await streamedPage(390, 844);
        await page.goto(feedbackBase);
        await page.waitForFunction(() => !(document.querySelector(".key-note")?.textContent ?? "Checking").includes("Checking"), null, { timeout: 5_000 }).catch(() => undefined);
        await page.locator("#claim-input").fill("Is it true that 90% of startups fail?");
        await page.locator("#claim-input").press("Enter");
        await page.waitForFunction(() => Boolean(window.__smokeStream), null, { timeout: 5_000 }).catch(() => undefined);
        await push({ stage: "queries", label: "Building search variants", detail: "x", queries: plan });
        await push({ stage: "search", label: "Searching across the web", detail: "x", current: 5, total: 10, queriesDone: 5, queryProviders: routed });
        await settle(page, (state) => state.states.filter((state) => state === "done").length === 5);
        const phone = await page.evaluate(() => [...document.querySelectorAll(".loading-plan li")].filter((item) => item.querySelector(".loading-plan-providers")).map((item) => {
          const query = item.querySelector(".loading-plan-query").getBoundingClientRect();
          const tags = item.querySelector(".loading-plan-providers");
          const box = tags.getBoundingClientRect();
          return { below: box.top >= query.bottom - 1, cut: tags.scrollWidth > tags.clientWidth + 1, px: parseFloat(getComputedStyle(tags).fontSize), text: tags.textContent.replace(/^\s*routed to\s*/, "").trim() };
        }));
        if (phone.length !== 5 || phone.some((tag) => !tag.below || tag.cut || tag.px < 11)) fail(`at 390x844, the provider tags: ${JSON.stringify(phone)}`);
        else ok(`at 390x844, each routed variant's tags sit on their own line under the query (${phone.map((tag) => `"${tag.text}"`).join(", ")})`);
        await page.context().close();
      }
    }
    // A Check these sources run has no search, so no plan, even if an event carried one.
    {
      const { page, push } = await streamedPage(1280, 720);
      await page.goto(`${feedbackBase}/?claim=${encodeURIComponent("90% of startups fail within ten years")}&urls=${encodeURIComponent("https://origin.example/startup-study https://repeat.example/startups-fail")}`);
      await page.locator("#source-check button.trace-button").click({ timeout: 10_000 });
      await page.waitForFunction(() => Boolean(window.__smokeStream), null, { timeout: 5_000 }).catch(() => undefined);
      await push({ stage: "search", label: "Using the links you supplied", detail: "No web search in this run: Echo reads exactly the 2 links you gave it.", queries: plan, queriesDone: 4 });
      await page.waitForTimeout(400);
      const sourcesPlan = await readPlan(page);
      if (sourcesPlan.shown || !sourcesPlan.card) fail(`a Check these sources run shows a search plan (${JSON.stringify(sourcesPlan)})`);
      else ok("a Check these sources run shows no search plan");
      // QA round 3: its stage track named query building and searching (ticked) and its chips "FOUND SO FAR", under
      // "No web search in this run". Its steps are the ones it takes, and the chips are the supplied links' sites.
      const track = () => page.evaluate(() => [...document.querySelectorAll(".loading-card .progress-step")].map((step) => `${step.classList.contains("is-done") ? "✓" : step.classList.contains("is-current") ? "▶" : "·"} ${step.textContent?.replace(/^\s*(✓|\d+)\s*/, "").trim()}`));
      const firstTrack = await track();
      await push({ stage: "extract", label: "Reading source pages", detail: "Extracting claim-relevant text from 2 pages in batches.", domains: ["origin.example", "repeat.example"] });
      await page.waitForFunction(() => /2 SITES/.test(document.querySelector(".loading-domains .loading-domains-label")?.textContent ?? ""), null, { timeout: 3_000 }).catch(() => undefined);
      const readingTrack = await track();
      const chipsLabel = (await page.locator(".loading-domains .loading-domains-label").textContent().catch(() => "")) ?? "";
      const wantFirst = ["▶ Take the supplied links", "· Read the supplied pages", "· Group matching claims", "· Trace source relationships", "· Answer from origins"];
      const wantReading = ["✓ Take the supplied links", "▶ Read the supplied pages", "· Group matching claims", "· Trace source relationships", "· Answer from origins"];
      if (JSON.stringify(firstTrack) !== JSON.stringify(wantFirst) || JSON.stringify(readingTrack) !== JSON.stringify(wantReading) || chipsLabel !== "SUPPLIED · 2 SITES") fail(`a Check these sources card's steps read ${JSON.stringify(firstTrack)} then ${JSON.stringify(readingTrack)}, its chips "${chipsLabel}"`);
      else ok(`a Check these sources card shows only the steps it takes (${readingTrack.join(" ")}) and labels its chips "${chipsLabel}"`);
      await page.context().close();
    }
  } catch (error) {
    fail(`live-run feedback check crashed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await feedbackBrowser?.close();
    feedbackServer.kill();
    fs.rmSync(feedbackScratch, { recursive: true, force: true });
  }
}

// Echo in the extension's side panel: /embed at side-panel widths, through a live run (mocked providers) started by
// its own button, as the side panel's start message would start it. Its own mocked server lists the extension's id
// in ECHO_EXTENSION_ORIGINS, so /embed may be framed by that extension and by nothing else.
process.stdout.write("\nSide panel layout (/embed at 400×800, mocked providers)\n");
{
  const embedScratch = fs.mkdtempSync(path.join(os.tmpdir(), "echo-smoke-embed-"));
  const embedMarker = path.join(embedScratch, "mock-loaded");
  const embedBase = `http://127.0.0.1:${await freePort()}`;
  const manifestKey = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8")).key;
  const extensionOrigin = `chrome-extension://${[...createHash("sha256").update(Buffer.from(manifestKey, "base64")).digest("hex").slice(0, 32)].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("")}`;
  const embedServer = spawn(path.join(root, "node_modules", ".bin", "next"), ["start", root, "-p", new URL(embedBase).port, "-H", "127.0.0.1"], {
    cwd: embedScratch,
    stdio: "ignore",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "smoke-mock-key",
      TAVILY_API_KEY: "smoke-mock-key",
      TELEM_API_KEY: "",
      ECHO_SEARCH_ROUTER: "tavily",
      ECHO_COPY_HUNT: "0",
      ECHO_DAILY_CAP_OVERRIDE_USD: "",
      NEXT_TELEMETRY_DISABLED: "1",
      ECHO_SMOKE_MOCK_MARKER: embedMarker,
      ECHO_EXTENSION_ORIGINS: `${extensionOrigin}, https://evil.example, chrome-extension://*`,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(path.join(root, "scripts", "smoke-mock-providers.mjs")).href}`.trim(),
    },
  });
  let embedBrowser;
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { if ((await fetch(embedBase)).ok) break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    if (!fs.existsSync(embedMarker)) throw new Error("the mocked-provider server did not load its mock");
    // Framing: /embed by the listed extension only (the website and the wildcard are dropped); every other page by none.
    const headersOf = async (address) => { const response = await fetch(`${embedBase}${address}`, { redirect: "manual" }); return { csp: response.headers.get("content-security-policy"), xfo: response.headers.get("x-frame-options") }; };
    const embedHeaders = await headersOf("/embed?claim=x");
    const homeHeaders = await headersOf("/");
    const howHeaders = await headersOf("/how");
    const listed = await (await fetch(`${embedBase}/api/embed`)).json();
    if (embedHeaders.csp !== `frame-ancestors ${extensionOrigin}` || embedHeaders.xfo || homeHeaders.csp !== "frame-ancestors 'none'" || homeHeaders.xfo !== "DENY" || howHeaders.csp !== "frame-ancestors 'none'" || JSON.stringify(listed.extensionOrigins) !== JSON.stringify([extensionOrigin])) fail(`framing headers: /embed ${JSON.stringify(embedHeaders)}, / ${JSON.stringify(homeHeaders)}, /how ${JSON.stringify(howHeaders)}, /api/embed ${JSON.stringify(listed)}`);
    else ok(`/embed may be framed by ${extensionOrigin} only (a website and a wildcard in the list are dropped); / and /how by nothing`);

    embedBrowser = await chromium.launch({ channel: "chrome", headless: !headed });
    const embedContext = await embedBrowser.newContext({ viewport: { width: 400, height: 800 } });
    const page = await embedContext.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let posts = 0;
    page.on("request", (request) => { if (request.method() === "POST" && /\/api\/(analyze|claims|copy-hunt)/.test(request.url())) posts += 1; });
    const layout = () => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth, hero: Boolean(document.querySelector(".hero, .topbar, .preset-list, .page-footer")) }));
    const typed = "Is it true that 90% of startups fail in a side panel?";
    await page.goto(`${embedBase}/embed?claim=${encodeURIComponent(typed)}`);
    await page.waitForFunction(() => Boolean(document.getElementById("claim-input")?.value), null, { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const before = { box: await page.locator("#claim-input").inputValue(), loading: await page.locator(".loading-card").count(), ...(await layout()) };
    if (before.box !== typed || before.loading || posts || before.hero || before.scroll > before.width) fail(`/embed?claim= at 400×800 before a click: ${JSON.stringify({ ...before, posts })}`);
    else ok("/embed?claim= at 400×800 fills the claim box, starts nothing, shows no home-page chrome, no sideways scroll");
    await page.locator("button[type=submit]").click();
    const wait = await page.locator(".loading-card").waitFor({ timeout: 5_000 }).then(async () => ({ plan: await page.locator(".loading-card .loading-plan").count(), ...(await layout()) }), () => null);
    await page.screenshot({ path: path.join(os.tmpdir(), "echo-smoke-embed-wait.png") }).catch(() => undefined);
    if (!wait || wait.scroll > wait.width) fail(`/embed's wait card at 400×800: ${JSON.stringify(wait)}`);
    else ok(`/embed shows the live wait card at 400×800${wait.plan ? " with its search plan" : ""}, no sideways scroll`);
    await page.locator("[aria-label='Echo result']").waitFor({ timeout: 40_000 }).catch(() => undefined);
    const done = await page.evaluate(() => {
      const result = document.querySelector("[aria-label='Echo result']");
      const full = [...(result?.querySelectorAll("a") ?? [])].find((link) => link.textContent.includes("Open full result"));
      const overflow = [...(result?.querySelectorAll("*") ?? [])].filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length;
      return { text: result?.innerText ?? "", full: full?.getAttribute("href") ?? null, overflow, scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth };
    });
    await page.screenshot({ path: path.join(os.tmpdir(), "echo-smoke-embed-result.png") }).catch(() => undefined);
    if (!/SOURCE INDEPENDENCE VERDICT/.test(done.text) || !/independent origin/.test(done.text) || !/PLAIN SEARCH VS ECHO/.test(done.text) || done.full !== `/?claim=${encodeURIComponent(typed).replace(/%20/g, "+")}` && done.full !== `/?${new URLSearchParams({ claim: typed })}` || done.overflow || done.scroll > done.width || posts !== 1) fail(`/embed's result at 400×800: ${JSON.stringify({ ...done, text: done.text.slice(0, 300), posts })}`);
    else ok("/embed's result at 400×800: the verdict, the plain-search line and Open full result (a ?claim= link), nothing wider than the panel, one POST");
    // Open full result: a new tab with the full result, handed over from the panel; no second run.
    const [fullTab] = await Promise.all([embedContext.waitForEvent("page", { timeout: 10_000 }), page.locator("[aria-label='Echo result'] a", { hasText: "Open full result" }).click()]);
    let fullPosts = 0;
    fullTab.on("request", (request) => { if (request.method() === "POST" && /\/api\/analyze/.test(request.url())) fullPosts += 1; });
    const fullShown = await fullTab.locator(".result-stack").waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const fullClaim = await fullTab.locator("#claim-input").inputValue().catch(() => "");
    if (!fullShown || fullPosts || fullClaim !== typed) fail(`Open full result: result shown ${fullShown}, ${fullPosts} POSTs, claim box "${fullClaim}"`);
    else ok("Open full result opens the full app in a new tab showing the same result, handed over without a second run");
    await fullTab.close();
    // Check links: per-link verdicts in the side-panel layout.
    await page.goto(`${embedBase}/embed?urls=${encodeURIComponent("https://origin.example/startup-study https://repeat.example/startups-fail")}&claim=${encodeURIComponent("90% of startups fail, a 2019 study found.")}`);
    await page.locator("#source-check-claim").waitFor({ timeout: 10_000 }).catch(() => undefined);
    const postsBeforeCheck = posts;
    await page.waitForTimeout(400);
    const idle = posts - postsBeforeCheck;
    await page.locator("button.trace-button").click();
    await page.locator("[aria-label='Supplied sources result']").waitFor({ timeout: 40_000 }).catch(() => undefined);
    const checked = await page.evaluate(() => ({ rows: document.querySelectorAll("[aria-label='Each supplied link'] li").length, ...{ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }, full: [...document.querySelectorAll("[aria-label='Echo result'] a")].find((link) => link.textContent.includes("Open full result"))?.getAttribute("href") ?? "" }));
    await page.screenshot({ path: path.join(os.tmpdir(), "echo-smoke-embed-links.png"), fullPage: true }).catch(() => undefined);
    if (idle || checked.rows !== 2 || checked.scroll > checked.width || !checked.full.includes("urls=")) fail(`/embed Check links at 400×800: ${JSON.stringify({ idle, ...checked })}`);
    else ok("/embed?urls= waits for its button, then shows each link's verdict at 400×800 with Open full result (?urls=)");
    for (const width of [360, 480]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(150);
      const fit = await layout();
      if (fit.scroll > fit.width) fail(`/embed at ${width} px scrolls sideways (${fit.scroll} > ${fit.width})`);
      else ok(`/embed's Check links result fits ${width} px without sideways scroll`);
    }
    if (errors.length) fail(`/embed page errors: ${errors.join(" | ")}`);
  } catch (error) {
    fail(`side panel layout check crashed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await embedBrowser?.close();
    embedServer.kill();
    fs.rmSync(embedScratch, { recursive: true, force: true });
  }
}

process.stdout.write(failures.length ? `\nUI smoke test FAILED (${failures.length}).\n` : "\nUI smoke test passed.\n");
process.exitCode = failures.length ? 1 : 0;
