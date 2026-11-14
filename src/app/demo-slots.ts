// The bundled demo runs, shared by the workbench (client) and the Explore gallery (server).

// Each preset opens a real live trace captured with this build (bundled in public/demo-traces and cached for offline
// use). It takes priority over a live run saved in this browser, which is the fallback; the synthetic fixture is only
// a last resort.
export const PRESETS: Array<{ id: string; slot: string; label: string; claim: string; capturedTrace?: string }> = [
  { id: "brain", slot: "01", label: "Ghost stat", claim: "Humans use only 10% of their brains", capturedTrace: "/demo-traces/humans-use-10-percent-of-brain.echo.json" },
  { id: "phones", slot: "02", label: "Zombie stat", claim: "Americans check their phones 96 times a day", capturedTrace: "/demo-traces/americans-check-phones-96-times.echo.json" },
];

export const LIVE_SLOT = { slot: "03", label: "Live claim" };

// A backup with a capturedTrace opens that saved live run (offline-cached); the others only fill the claim box.
export const BACKUP_POOL: Array<{ label: string; claim: string; capturedTrace?: string }> = [
  { label: "3-second goldfish memory", claim: "Goldfish have a 3-second memory", capturedTrace: "/demo-traces/goldfish-3-second-memory.echo.json" },
  { label: "Head heat loss", claim: "You lose most of your body heat through your head", capturedTrace: "/demo-traces/lose-most-body-heat-through-head.echo.json" },
];

/** "/demo-traces/goldfish-3-second-memory.echo.json" → "goldfish-3-second-memory", the name a ?trace= link uses. */
export function traceSlug(path: string): string {
  return path.split("/").pop()!.replace(/\.echo\.json$/, "");
}

/** The link that opens a bundled run: ?slot= for a demo slot, ?trace= for a backup. */
export function bundledRunLink(capturedTrace: string): string | null {
  const preset = PRESETS.find((entry) => entry.capturedTrace === capturedTrace);
  if (preset) return `/?slot=${preset.slot}`;
  return BACKUP_POOL.some((entry) => entry.capturedTrace === capturedTrace) ? `/?trace=${traceSlug(capturedTrace)}` : null;
}

// The saved "Check these sources" run: the five phones links of the panel's Try an example, read live on 2026-11-13
// (5 supplied links → 1 independent origin). It opens from its own button in the Check these sources panel and under
// MORE SAVED RUNS, or a ?trace= link, never from a slot chip or a shortcut key, and the service worker precaches it
// like the slots. The file is a byte-for-byte copy of scripts/fixtures/sources-phones-live-2026-11-13-v2.echo.json
// (check:freeze holds it to that); `urls` are its sourceCheck.urls, in its order (check:links compares them).
export const SAVED_SOURCE_CHECK = {
  label: "Saved check: 5 links → 1 origin",
  claim: "Americans check their phones 96 times a day",
  savedTrace: "/demo-traces/check-these-sources-phones.echo.json",
  urls: [
    "https://www.asurion.com/press-releases/americans-check-their-phones-96-times-a-day",
    "https://www.prnewswire.com/news-releases/americans-check-their-phones-96-times-a-day-300962643.html",
    "https://www.fox13seattle.com/news/americans-check-their-smartphones-96-times-a-day-survey-says",
    "https://www.kabc.com/2021/10/03/reality-check-you-check-your-phone-96-times-a-day-96-times-a-day",
    "https://www.churchandculture.org/blog/2021/10/28/96-times-a-day",
  ],
};
