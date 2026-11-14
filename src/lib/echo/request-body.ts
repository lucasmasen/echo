/**
 * True when the request says its body is JSON. Any web page can make a browser POST a form or text/plain body (a
 * CORS "simple" request, sent without asking the server), and such a body can still be valid JSON. A JSON content
 * type needs a preflight that Echo never grants, so a route that starts paid work and takes only JSON cannot be
 * started from another site the presenter happens to visit, whether Echo runs locally or unlocked.
 */
export function isJsonRequest(request: Request): boolean {
  return /^application\/json\s*(?:;|$)/i.test((request.headers.get("content-type") ?? "").trim());
}

export const JSON_REQUIRED = { code: "JSON_REQUIRED", error: "Send the request as JSON (content-type: application/json)." } as const;

/**
 * Reads a request body as text, stopping as soon as it passes `maxBytes`. Returns null when the body is too large.
 * Content-Length can be absent (chunked uploads) or wrong, so the bytes themselves are counted while reading;
 * an oversized body is cancelled instead of being buffered in full.
 */
export async function readBodyWithin(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
