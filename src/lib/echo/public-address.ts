// Which addresses Echo reads: public http(s) hosts only. Pure (no DNS, no Node modules), so both the server, which is the
// authority (pipeline.ts: suppliedSourceUrls, fetchPublicPage, which also checks every DNS answer), and the Check these
// sources panel, which only warns before the click, run the same rules on a link's text.

/** Only public http(s) hosts; refuses localhost and private-network address literals. */
export function isFetchablePublicUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password) return false;
  // "localhost." is a fully qualified localhost: trailing dots are dropped before the name checks.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  // A literal IPv4 host is judged by the same ranges as a DNS answer.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && isPrivateAddress(host)) return false;
  if (host.includes(":")) return false; // IPv6 literals are rare for articles; refuse rather than classify.
  return true;
}

/** True for loopback, private, link-local, carrier-grade NAT, multicast and IPv6 local addresses. */
export function isPrivateAddress(address: string): boolean {
  let canonical = address.toLowerCase();
  // IPv6 in its shortest form ("0:0:0:0:0:0:0:1" is "::1"); an IPv4-mapped address in hex ("::ffff:7f00:1") is
  // rewritten as the IPv4 address it carries.
  if (canonical.includes(":")) {
    try { canonical = new URL(`http://[${canonical}]/`).hostname.slice(1, -1); } catch { return true; }
    // IPv6 forms that carry an IPv4 address are judged by that address: mapped (::ffff:a.b.c.d), NAT64
    // (64:ff9b::a.b.c.d, which DNS64 resolvers return for ordinary public sites), the old compatible form
    // (::a.b.c.d) and 6to4 (2002:aabb:ccdd::).
    const hex = canonical.match(/^(?:::ffff:|64:ff9b::|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/) ?? canonical.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/);
    if (hex) canonical = [parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255, parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join(".");
  }
  const mapped = canonical.replace(/^::ffff:/, "");
  const v4 = mapped.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    // Also reserved: 192.0.0.0/24 (protocol assignments), 198.18.0.0/15 (benchmarking) and the three documentation
    // ranges, none of which a public page lives on.
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  return mapped === "::1" || mapped === "::" || /^f[cd]/.test(mapped) || /^fe[89ab]/.test(mapped) || /^ff/.test(mapped);
}

/** True when a link carries a username or password ("https://user:pw@example.com/x"), which Echo never reads. */
export function hasCredentials(url: string): boolean {
  try { const parsed = new URL(url); return Boolean(parsed.username || parsed.password); } catch { return false; }
}

/**
 * Why Echo will not read a link, judged from its text alone (the panel's warning), or null when it may. The server
 * still decides: a public-looking name can resolve to a private address, which only its DNS check sees.
 */
export function unreadableAddressReason(url: string): "credentials" | "not public" | "ipv6" | null {
  if (hasCredentials(url)) return "credentials";
  if (isFetchablePublicUrl(url)) return null;
  // The server refuses every IPv6 address link; a private one ("http://[::1]/") is "not public", a public one
  // ("https://[2606:4700::1111]/") is refused for being an IPv6 address.
  let host = "";
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ""); } catch { /* not a URL: not public */ }
  return host.includes(":") && !isPrivateAddress(host) ? "ipv6" : "not public";
}
