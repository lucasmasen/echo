/**
 * The browser-extension origins allowed to frame Echo's /embed page and to start its one run (ECHO_EXTENSION_ORIGINS,
 * comma- or space-separated, e.g. "chrome-extension://abcdefghijklmnopabcdefghijklmnop"). Only chrome-extension://
 * origins with a 32-letter Chrome extension id (letters a–p) are kept; anything else (a website, a wildcard, a path)
 * is dropped, so a typo can never open Echo to every site. Empty by default: /embed then cannot be framed at all, and
 * nothing can start a run there without a click in Echo itself.
 *
 * Read by src/proxy.ts (the frame-ancestors header, per request) and /api/embed (the list the embed page checks a
 * start message's origin against). An extension id is not a secret; the list grants no key, only "may ask for a run".
 */
export const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export function extensionOrigins(value: string | undefined = process.env.ECHO_EXTENSION_ORIGINS): string[] {
  const kept = new Set<string>();
  for (const raw of String(value ?? "").split(/[\s,]+/)) {
    const origin = raw.trim().toLowerCase().replace(/\/+$/, "");
    if (EXTENSION_ORIGIN.test(origin)) kept.add(origin);
  }
  return [...kept];
}

/** The Content-Security-Policy for /embed: framed only by the listed extensions, or by nothing. */
export function embedFrameAncestors(origins: readonly string[]): string {
  return `frame-ancestors ${origins.length ? origins.join(" ") : "'none'"}`;
}
