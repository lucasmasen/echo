import { extensionOrigins } from "@/lib/echo/extension-origins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The extension origins /embed accepts a start message from (ECHO_EXTENSION_ORIGINS; see extension-origins.ts). A
 * GET only: it reads one setting, spends nothing and starts nothing. An extension id is public (it is in the
 * extension's own address), so listing it reveals no secret.
 */
export async function GET() {
  return Response.json({ extensionOrigins: extensionOrigins() }, { headers: { "cache-control": "no-store" } });
}
