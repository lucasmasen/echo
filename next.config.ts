import type { NextConfig } from "next";

// Safe defaults for a public deployment. A full Content-Security-Policy is deliberately not set here: it would have to
// allow Next's inline scripts and the offline service worker, and a wrong one would break the stage demo.
// No other site may frame Echo (clickjacking): the CSP form for modern browsers, the old header for the rest.
// /embed is the exception, set per request in src/proxy.ts: framed only by the extension origins listed in
// ECHO_EXTENSION_ORIGINS, and by nothing when none is listed.
const frameHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
];
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Cited pages Echo links to see only the origin, never the ?claim= being checked.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Echo uses none of these; fullscreen (Present mode) and clipboard (Copy link) stay allowed.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Every path but /embed exactly ("/", "/how", "/embedded", "/embed/x" all match).
      { source: "/", headers: frameHeaders },
      { source: "/:path((?!embed$).+)", headers: frameHeaders },
    ];
  },
};

export default nextConfig;
