import { copyHuntEnabled, runCopyHunt } from "@/lib/echo/copy-hunt";
import { EchoPipelineError } from "@/lib/echo/pipeline";
import { MAX_PORTABLE_TRACE_BYTES, parsePortableTrace } from "@/lib/echo/portable";
import { mayStartPaidWork, PRESENTER_ONLY_MESSAGE } from "@/lib/echo/presenter";
import { isJsonRequest, JSON_REQUIRED, readBodyWithin } from "@/lib/echo/request-body";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  // A copy hunt spends search credits, so a locked deployment keeps it for the presenter too.
  if (!mayStartPaidWork(request)) {
    return Response.json({ code: "PRESENTER_ONLY", error: PRESENTER_ONLY_MESSAGE }, { status: 403 });
  }
  // JSON only, so another site cannot start a copy hunt with a form or text/plain POST (see isJsonRequest).
  if (!isJsonRequest(request)) return Response.json(JSON_REQUIRED, { status: 415 });
  if (!copyHuntEnabled()) {
    return Response.json({ code: "COPY_HUNT_DISABLED", error: "Copy hunt is off. Set ECHO_COPY_HUNT=1 in .env.local to turn it on." }, { status: 404 });
  }
  let body: { trace?: unknown; rootId?: unknown };
  try {
    // Stop reading a body (chunked or not) as soon as it passes the trace limit plus room for the wrapper.
    const raw = await readBodyWithin(request, MAX_PORTABLE_TRACE_BYTES + 4_096);
    if (raw === null) {
      return Response.json({ code: "TRACE_TOO_LARGE", error: "That trace is over Echo's 2 MB limit." }, { status: 413 });
    }
    body = JSON.parse(raw) as { trace?: unknown; rootId?: unknown };
  } catch {
    return Response.json({ code: "BAD_REQUEST", error: "Send JSON with a trace field." }, { status: 400 });
  }
  const analysis = parsePortableTrace(body.trace);
  if (!analysis) return Response.json({ code: "INVALID_TRACE", error: "That trace did not pass Echo's import check." }, { status: 400 });
  try {
    const copyHunt = await runCopyHunt(analysis, {
      rootId: typeof body.rootId === "string" ? body.rootId : undefined,
      signal: request.signal,
    });
    return Response.json({ copyHunt }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof EchoPipelineError) {
      const status = /BUDGET/.test(error.code) ? 429 : error.code.startsWith("COPY_HUNT_") ? 422 : 502;
      return Response.json({ code: error.code, error: error.message }, { status });
    }
    return Response.json({ code: "COPY_HUNT_FAILED", error: "Copy hunt failed. The trace is unchanged." }, { status: 500 });
  }
}
