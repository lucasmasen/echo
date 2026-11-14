import { NextResponse } from "next/server";
import { embedFrameAncestors, extensionOrigins } from "@/lib/echo/extension-origins";

/**
 * /embed is the one page another page may frame: the browser extension's side panel, and only when its origin is
 * listed in ECHO_EXTENSION_ORIGINS (read on each request, so a restart picks up a change without a rebuild). Every
 * other page keeps next.config.ts's frame-ancestors 'none' and X-Frame-Options: DENY. With no extension listed,
 * /embed is not frameable either. Framing grants nothing by itself: a run still needs a click in Echo, or the
 * listed extension's start message carrying the page's one-time nonce (src/app/embed-bridge.ts).
 */
export function proxy() {
  const origins = extensionOrigins();
  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", embedFrameAncestors(origins));
  if (!origins.length) response.headers.set("X-Frame-Options", "DENY");
  return response;
}

export const config = { matcher: ["/embed"] };
