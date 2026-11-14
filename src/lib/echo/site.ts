/**
 * The deployment's public address, for absolute URLs (link-preview images, sitemap). ECHO_SITE_URL wins; on Vercel the
 * production domain is used. Null when neither is set (local use): callers then leave absolute URLs out rather than
 * point at localhost. An invalid value is ignored rather than breaking the build.
 */
export function siteUrl(): URL | null {
  for (const value of [process.env.ECHO_SITE_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`]) {
    try {
      const url = value?.trim() ? new URL(value.trim()) : null;
      if (url && (url.protocol === "https:" || url.protocol === "http:")) return new URL(url.origin);
    } catch {
      // Try the next source.
    }
  }
  return null;
}
