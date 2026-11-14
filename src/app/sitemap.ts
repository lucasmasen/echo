import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/echo/site";
import { BACKUP_POOL, bundledRunLink, PRESETS } from "./demo-slots";

// The home page, the gallery, explainer and bookmarklet pages, and every bundled run's link (?slot= for the demo slots, ?trace=
// for the backups; each opens a real saved trace, never a paid run). Empty without a public address, so a local build
// never advertises localhost.
export default function sitemap(): MetadataRoute.Sitemap {
  const site = siteUrl();
  if (!site) return [];
  const at = (path: string) => new URL(path, site).toString();
  const runs = [...PRESETS, ...BACKUP_POOL]
    .map((entry) => (entry.capturedTrace ? bundledRunLink(entry.capturedTrace) : null))
    .filter((link): link is string => Boolean(link));
  return [
    { url: at("/"), changeFrequency: "weekly", priority: 1 },
    { url: at("/explore"), changeFrequency: "weekly", priority: 0.9 },
    { url: at("/how"), changeFrequency: "monthly", priority: 0.8 },
    { url: at("/anywhere"), changeFrequency: "monthly", priority: 0.7 },
    ...runs.map((link) => ({ url: at(link), changeFrequency: "monthly" as const, priority: 0.8 })),
  ];
}
