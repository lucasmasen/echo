import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/echo/site";

// Search engines may index the app and its demo slots, never the API (paid runs, presenter key).
export default function robots(): MetadataRoute.Robots {
  const site = siteUrl();
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    ...(site ? { sitemap: new URL("/sitemap.xml", site).toString() } : {}),
  };
}
