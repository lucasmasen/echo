// The side panel: Echo's compact /embed page in a frame, and the one place a run can start without a click in Echo.
// background.js leaves one job (the selection's claim, or its links) in chrome.storage.session when the reader clicks
// the selection pop-up or presses the shortcut. This page takes that job once (if under two minutes old), loads
// /embed with its box filled (the address alone runs nothing), waits for Echo's "echo:embed-ready" message from that
// frame on the configured Echo origin, and answers it once with "echo:embed-start", the job and the nonce Echo sent.
// Echo accepts it only because this extension's origin is listed in ECHO_EXTENSION_ORIGINS (src/app/embed-bridge.ts).
// Reopening the panel, reloading it, or Echo reloading inside it starts nothing: the job is gone.
(function () {
  "use strict";

  const { DEFAULT_SITE, normalizeSite, embedLink, jobTabLink } = globalThis.EchoLink;
  const JOB_KEY = "echoJob";
  const JOB_MAX_AGE_MS = 2 * 60_000;
  // A first visit to a `npm run dev` server compiles /embed, which can take a while; the note says so and goes away
  // when Echo answers after all.
  const READY_TIMEOUT_MS = 15_000;
  const NONCE = /^[0-9a-f]{32}$/;
  const frame = document.getElementById("echo");
  const notice = document.getElementById("notice");
  const noticeTitle = document.getElementById("notice-title");
  const noticeBody = document.getElementById("notice-body");
  const noticeCode = document.getElementById("notice-code");
  const noticeLine = document.getElementById("notice-line");
  const self = location.origin;

  let site = DEFAULT_SITE;
  let pending = null; // the job waiting for Echo's ready message; sent once, then null
  let shown = null; // the job the frame shows, for "Open in a tab instead"
  let answered = false;
  let readyTimer = 0;
  const taken = new Set();

  let noticeKind = null;
  function say(kind, title, body, line) {
    noticeKind = kind;
    noticeTitle.textContent = title;
    noticeBody.textContent = body;
    noticeCode.hidden = !line;
    noticeLine.textContent = line ?? "";
    notice.hidden = false;
  }
  const quiet = () => { notice.hidden = true; noticeKind = null; };

  async function readSite() {
    try {
      const { echoSite } = await chrome.storage.sync.get({ echoSite: DEFAULT_SITE });
      site = normalizeSite(echoSite) ?? DEFAULT_SITE;
    } catch {
      site = DEFAULT_SITE;
    }
  }

  function load(job) {
    const runnable = job && job.kind !== "none" && typeof job.claim === "string" && job.claim.trim().length >= 8;
    pending = runnable ? job : null;
    shown = job && job.kind !== "none" ? job : null;
    answered = false;
    quiet();
    if (job?.kind === "none") say("hint", "Select a sentence first", "Select a claim on the page (8 characters or more), then click the Echo button next to it or press the shortcut again.");
    frame.src = embedLink(site, shown);
    window.clearTimeout(readyTimer);
    readyTimer = window.setTimeout(() => {
      if (answered) return;
      say(
        "blocked",
        "Echo did not open here",
        `Check that Echo is running at ${site}. The side panel also needs Echo to list this extension: add this line to Echo's .env.local and restart Echo.`,
        `ECHO_EXTENSION_ORIGINS=${self}`,
      );
    }, READY_TIMEOUT_MS);
  }

  // Echo's ready message: only from the frame, only from the configured Echo origin.
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || event.origin !== site) return;
    const data = event.data;
    if (!data || data.type !== "echo:embed-ready" || typeof data.nonce !== "string" || !NONCE.test(data.nonce)) return;
    answered = true;
    window.clearTimeout(readyTimer);
    if (noticeKind === "blocked") quiet();
    if (!pending) return;
    const job = pending;
    pending = null;
    frame.contentWindow.postMessage({ type: "echo:embed-start", nonce: data.nonce, claim: job.claim, ...(job.kind === "links" ? { urls: job.urls } : {}) }, site);
  });

  // The job background.js left, taken once: removed from storage, and never run twice by this page.
  async function takeJob() {
    let record = null;
    try {
      record = (await chrome.storage.session.get(JOB_KEY))[JOB_KEY] ?? null;
      if (record) await chrome.storage.session.remove(JOB_KEY);
    } catch {
      return null;
    }
    if (!record || typeof record !== "object" || typeof record.at !== "number" || Date.now() - record.at > JOB_MAX_AGE_MS || taken.has(record.id)) return null;
    taken.add(record.id);
    return record;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[JOB_KEY]?.newValue) void takeJob().then((job) => { if (job) load(job); });
    if (area === "sync" && changes.echoSite) void readSite().then(() => load(null));
  });

  document.getElementById("notice-tab").addEventListener("click", () => {
    void chrome.tabs.create({ url: jobTabLink(site, shown) });
  });
  document.getElementById("notice-options").addEventListener("click", () => {
    void chrome.runtime.openOptionsPage();
  });
  document.getElementById("notice-copy").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(noticeLine.textContent);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    window.setTimeout(() => { button.textContent = "Copy"; }, 1_600);
  });

  void (async () => {
    await readSite();
    load(await takeJob());
  })();
})();
