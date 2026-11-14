// Bump the version whenever the precache list or the caching rules change: the new worker then installs a fresh
// cache and deletes every older echo-shell-* one on activate, so an old worker's shells are never served again.
const CACHE_NAME = "echo-shell-v12";
// The two slots, the two backups, and the saved Check these sources run (v12).
const DEMO_TRACES = [
  "/demo-traces/humans-use-10-percent-of-brain.echo.json",
  "/demo-traces/americans-check-phones-96-times.echo.json",
  "/demo-traces/goldfish-3-second-memory.echo.json",
  "/demo-traces/lose-most-body-heat-through-head.echo.json",
  "/demo-traces/check-these-sources-phones.echo.json",
];
const APP_SHELL = "/";
// Pages that open with the network off after one online visit. Each is cached under its own path (the query is
// ignored, so "/?slot=02" opens the "/" shell), with every script and stylesheet its HTML names.
const OFFLINE_PAGES = [APP_SHELL, "/how", "/explore", "/anywhere"];

/** The cache key for a page: its path without a trailing slash, never the query. */
function pageKey(url) {
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  return new URL(pathname, self.location.origin).toString();
}

async function cacheOfflinePages() {
  const cache = await caches.open(CACHE_NAME);
  const pages = await Promise.all(OFFLINE_PAGES.map(async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Could not cache the Echo page ${path}.`);
    return { path, response, html: await response.clone().text() };
  }));
  const assetPaths = [
    ...pages.flatMap(({ html }) => [...html.matchAll(/(?:src|href)=["']([^"']*\/_next\/static\/[^"']+)["']/g)]
      .map((match) => new URL(match[1], self.location.origin).toString())),
    // The tab icon as each page names it: Next adds a hash query (/icon.svg?icon.<hash>.svg), and the cache matches
    // the query too, so the plain /icon.svg alone left every offline page with a failed icon request.
    ...pages.flatMap(({ html }) => [...html.matchAll(/href=["'](\/icon\.svg[^"']*)["']/g)]
      .map((match) => new URL(match[1].replace(/&amp;/g, "&"), self.location.origin).toString())),
    new URL("/manifest.webmanifest", self.location.origin).toString(),
    new URL("/icon.svg", self.location.origin).toString(),
    ...DEMO_TRACES.map((path) => new URL(path, self.location.origin).toString()),
  ];
  await Promise.all([...new Set(assetPaths)].map(async (path) => {
    const asset = await fetch(path);
    if (!asset.ok) throw new Error(`Could not cache app asset: ${path}`);
    await cache.put(path, asset);
  }));
  // The pages go in last, so a cache that holds a page also holds everything that page needs.
  await Promise.all(pages.map(({ path, response }) => cache.put(pageKey(new URL(path, self.location.origin)), response)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    cacheOfflinePages()
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("echo-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Next.js also fetches React Server Component data from each page (RSC header or ?_rsc=...). Never cache that as
  // a page: serving it on an offline reload shows raw data instead of the page.
  const isRscRequest = request.headers.get("RSC") === "1" || url.searchParams.has("_rsc");
  if (isRscRequest) return;
  const isPage = request.mode === "navigate";
  const isNextAsset = url.pathname.startsWith("/_next/static/");
  const isPwaAsset = url.pathname === "/manifest.webmanifest" || url.pathname === "/icon.svg" || DEMO_TRACES.includes(url.pathname);
  if (!isPage && !isNextAsset && !isPwaAsset) return;
  // Each page keeps its own copy: storing every navigation as "/" would let a visit to /how replace the app shell.
  const key = isPage ? pageKey(url) : request;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const isHtml = (response.headers.get("content-type") || "").includes("text/html");
        // Only a page's own HTML, never a redirect or an error page, replaces its cached copy.
        if (response.ok && !response.redirected && (!isPage || isHtml)) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(key, copy));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        // A page never visited online falls back to the app shell, as before.
        return (await cache.match(key)) || (isPage ? await cache.match(pageKey(new URL(APP_SHELL, self.location.origin))) : undefined) || Response.error();
      }),
  );
});
