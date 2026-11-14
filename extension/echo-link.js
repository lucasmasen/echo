// Builds the Echo links the extension opens. Shared by background.js (importScripts), content.js, sidepanel.js and
// options.js, and loaded by scripts/smoke-ui.mjs and scripts/check-links.mjs to test it. Every link is a ?claim= link
// (it only fills Echo's claim box) or a ?urls=…&claim=… link (it only fills the Check these sources panel), on Echo's
// home page or its side-panel page /embed, so no link the extension opens can start a paid run. The reader presses
// "Trace sources", "Find claims in this page" or "Check N sources", or clicks the selection pop-up, whose side panel
// then asks Echo for the one run (sidepanel.js).
(function (scope) {
  "use strict";

  const DEFAULT_SITE = "http://localhost:3000";
  // Echo's claim box and ?claim= reader both stop at 500 characters, like the bookmarklet.
  const MAX_CLAIM = 500;
  // Check these sources reads at most 20 links, each at most 2,000 characters (src/lib/echo/supplied-urls.ts).
  const MAX_LINKS = 20;
  const MAX_LINK = 2000;
  const ADDRESS = /https?:\/\/[^\s<>"'`\][{}|\\^]+/gi;
  const TRAILING = /[.,;:!?'"’”»>\]*_]+$/;

  // Whitespace collapsed, cut to 500 characters without leaving half an emoji behind.
  function cleanClaim(text) {
    let claim = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CLAIM).replace(/[\uD800-\uDBFF]$/, "");
    if (typeof claim.toWellFormed === "function") claim = claim.toWellFormed();
    return claim;
  }

  // The Echo address a person typed, as an origin ("https://echo.example"), or null when it is not a web address.
  // A bare host gets https://, except localhost and 127.0.0.1, which get http:// as `npm run dev` serves them.
  function normalizeSite(input) {
    let text = String(input ?? "").trim();
    if (!text) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
      text = `${/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text) ? "http" : "https"}://${text}`;
    }
    let url;
    try { url = new URL(text); } catch { return null; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || !url.hostname) return null;
    return url.origin;
  }

  // The tab to open for a selection: Echo with the claim filled in, or Echo's home page when nothing usable is left.
  function claimLink(site, text) {
    const origin = normalizeSite(site) ?? DEFAULT_SITE;
    const claim = cleanClaim(text);
    return claim ? `${origin}/?claim=${encodeURIComponent(claim)}` : `${origin}/`;
  }

  // The tab to open for a page or link: Echo with that address in the claim box, where "Find claims in this page"
  // reads it. Only http(s) addresses; the #fragment is dropped (a server never sees it). An address too long for the
  // claim box would arrive cut and broken, so Echo opens empty instead.
  function pageLink(site, address) {
    const origin = normalizeSite(site) ?? DEFAULT_SITE;
    let url;
    try { url = new URL(String(address ?? "")); } catch { return `${origin}/`; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${origin}/`;
    url.hash = "";
    const text = url.href;
    return text.length <= MAX_CLAIM && !/\s/.test(text) ? `${origin}/?claim=${encodeURIComponent(text)}` : `${origin}/`;
  }

  // One http(s) address as Echo would read it: trailing punctuation and the #fragment dropped, or null.
  function cleanLink(raw) {
    let text = String(raw ?? "").replace(TRAILING, "");
    // A closing parenthesis belongs to the address only when it opens one too.
    while (text.endsWith(")") && (text.match(/\(/g) || []).length < (text.match(/\)/g) || []).length) text = text.slice(0, -1).replace(TRAILING, "");
    let url;
    try { url = new URL(text); } catch { return null; }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.hash = "";
    return url.href.length <= MAX_LINK && !/\s/.test(url.href) ? url.href : null;
  }

  // The web addresses written in a selection, in order, once each (http/https and www. copies are one page), at most 20.
  function linksIn(text) {
    const seen = new Set();
    const links = [];
    for (const match of String(text ?? "").replace(/,(?=https?:\/\/)/gi, " ").matchAll(ADDRESS)) {
      const link = cleanLink(match[0]);
      const page = link && link.replace(/^https?:\/\/(?:www\.)?/i, "");
      if (!link || seen.has(page)) continue;
      seen.add(page);
      links.push(link);
      if (links.length === MAX_LINKS) break;
    }
    return links;
  }

  // The sentence to check from a selected answer: the one carrying its citation markers or links, preferring one with
  // a figure; markers and links taken out. "" when none fits (Echo then leaves the sentence box for the reader).
  function sentenceIn(text) {
    const prose = String(text ?? "")
      .split("\n")
      .filter((line) => !/^\s*(?:[-*•+]\s+)?(?:\[\^?\d{1,3}\]:?|\(\d{1,3}\)|\d{1,3}[.)])\s.*https?:\/\//i.test(line))
      .join("\n")
      .replace(/\[([^\]\n]{0,200})\]\((https?:\/\/[^\s)]+)\)/gi, (_, label) => (/^\[?\^?\d{1,3}\]?$/.test(label.trim()) || /^[\w.-]+\.[a-z]{2,}$/i.test(label.trim()) ? " \u0000" : `${label} \u0000`))
      .replace(/\s*\[\^?\d{1,3}\]/g, " \u0000")
      .replace(ADDRESS, " \u0000");
    let best = "";
    let bestScore = 0;
    for (const raw of prose.split(/(?<=[.!?])\s+|\n\s*\n/)) {
      const cited = raw.includes("\u0000");
      const sentence = raw.replace(/\u0000/g, " ").replace(/\(\s*\)/g, "").replace(/\s+([.,;:!?])/g, "$1").replace(/\s+/g, " ").trim();
      if (sentence.length < 20 || sentence.length > 300 || /\?$/.test(sentence) || sentence.split(" ").length < 4) continue;
      const score = (cited ? 4 : 0) + (/\d/.test(sentence) ? 2 : 0);
      if (score > bestScore) { best = sentence; bestScore = score; }
    }
    return cleanClaim(best);
  }

  // "Check links with Echo" on a selection: Echo's Check these sources panel filled with the selection's links and
  // its cited sentence. A selection with no written web address (many chat apps show links as buttons) opens as a
  // claim instead, like "Trace with Echo".
  function sourcesLink(site, text) {
    const origin = normalizeSite(site) ?? DEFAULT_SITE;
    const links = linksIn(text);
    if (!links.length) return claimLink(origin, text);
    const claim = sentenceIn(text);
    return `${origin}/?urls=${encodeURIComponent(links.join(" "))}${claim ? `&claim=${encodeURIComponent(claim)}` : ""}`;
  }

  // "Check this link with Echo" on a right-clicked link: the panel filled with that one link.
  function linkSourcesLink(site, address) {
    const origin = normalizeSite(site) ?? DEFAULT_SITE;
    const link = cleanLink(address);
    return link ? `${origin}/?urls=${encodeURIComponent(link)}` : `${origin}/`;
  }

  // The selection pop-up's job: what its button (or the shortcut) asks the side panel to run. "trace": the selected
  // text as a claim. "links": the links written in the selection plus the page links it covers (`pageLinks`, read from
  // its <a href>s by content.js), and its cited sentence ("" when none fits: the side panel then waits for the reader).
  // A "links" job with no usable link becomes a trace, like Check links with Echo; null when nothing is left to run.
  function popupJob(action, text, pageLinks) {
    if (action === "links") {
      const links = linksIn(`${String(text ?? "")}\n${(Array.isArray(pageLinks) ? pageLinks : []).map(String).join("\n")}`);
      if (links.length) return { kind: "links", claim: sentenceIn(text), urls: links };
    }
    const claim = cleanClaim(text);
    return claim ? { kind: "trace", claim } : null;
  }

  // The page the side panel frames: Echo's compact /embed, its box filled from the job (?claim=, or ?urls= and
  // ?claim= for links), exactly like the menu's links: the address alone runs nothing. The run starts only from the
  // side panel's start message, which Echo accepts from an extension origin it lists (src/app/embed-bridge.ts).
  function embedLink(site, job) {
    const origin = normalizeSite(site) ?? DEFAULT_SITE;
    if (!job) return `${origin}/embed`;
    if (job.kind === "links" && Array.isArray(job.urls) && job.urls.length) {
      const claim = cleanClaim(job.claim);
      return `${origin}/embed?urls=${encodeURIComponent(job.urls.slice(0, MAX_LINKS).join(" "))}${claim ? `&claim=${encodeURIComponent(claim)}` : ""}`;
    }
    const claim = cleanClaim(job.claim);
    return claim ? `${origin}/embed?claim=${encodeURIComponent(claim)}` : `${origin}/embed`;
  }

  // The same job as a plain Echo tab (where the side panel is unavailable or Echo refuses to be framed): fills only.
  function jobTabLink(site, job) {
    if (job?.kind === "links" && Array.isArray(job.urls) && job.urls.length) {
      const origin = normalizeSite(site) ?? DEFAULT_SITE;
      const claim = cleanClaim(job.claim);
      return `${origin}/?urls=${encodeURIComponent(job.urls.slice(0, MAX_LINKS).join(" "))}${claim ? `&claim=${encodeURIComponent(claim)}` : ""}`;
    }
    return claimLink(site, job?.claim ?? "");
  }

  scope.EchoLink = Object.freeze({ DEFAULT_SITE, MAX_CLAIM, MAX_LINKS, cleanClaim, normalizeSite, claimLink, pageLink, linksIn, sentenceIn, sourcesLink, linkSourcesLink, popupJob, embedLink, jobTabLink });
})(globalThis);
