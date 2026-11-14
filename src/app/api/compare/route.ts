import { compareOriginAnswers, EchoPipelineError, originCompareEnabled } from "@/lib/echo/pipeline";
import { MAX_PORTABLE_TRACE_BYTES, parsePortableTrace } from "@/lib/echo/portable";
import { mayStartPaidWork, PRESENTER_ONLY_MESSAGE } from "@/lib/echo/presenter";
import { isJsonRequest, JSON_REQUIRED, readBodyWithin } from "@/lib/echo/request-body";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Origin layer token comparison: the same question answered with every result in context and with one page per
 * independent origin. Two Claude answer calls, through the daily budget guard. Off unless ECHO_ORIGIN_LAYER=1.
 */
export async function POST(request: Request) {
  if (!mayStartPaidWork(request)) {
    return Response.json({ code: "PRESENTER_ONLY", error: PRESENTER_ONLY_MESSAGE }, { status: 403 });
  }
  if (!isJsonRequest(request)) return Response.json(JSON_REQUIRED, { status: 415 });
  if (!originCompareEnabled()) {
    return Response.json({ code: "ORIGIN_COMPARE_DISABLED", error: "The live token comparison is off. Set ECHO_ORIGIN_LAYER=1 in .env.local to turn it on (two Claude calls per comparison)." }, { status: 404 });
  }
  let body: { trace?: unknown };
  try {
    const raw = await readBodyWithin(request, MAX_PORTABLE_TRACE_BYTES + 4_096);
    if (raw === null) {
      return Response.json({ code: "TRACE_TOO_LARGE", error: "That trace is over Echo's 2 MB limit." }, { status: 413 });
    }
    body = JSON.parse(raw) as { trace?: unknown };
  } catch {
    return Response.json({ code: "BAD_REQUEST", error: "Send JSON with a trace field." }, { status: 400 });
  }
  const analysis = parsePortableTrace(body.trace);
  if (!analysis) return Response.json({ code: "INVALID_TRACE", error: "That trace did not pass Echo's import check." }, { status: 400 });
  if (analysis.mode !== "live") return Response.json({ code: "NOT_A_LIVE_TRACE", error: "The comparison runs on real traces only, not on rehearsal fixtures." }, { status: 422 });
  try {
    const comparison = await compareOriginAnswers(analysis, request.signal);
    return Response.json({ comparison }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof EchoPipelineError) {
      return Response.json({ code: error.code, error: error.message }, { status: /BUDGET/.test(error.code) ? 429 : error.code === "ORIGIN_COMPARE_NO_ORIGINS" ? 422 : 502 });
    }
    return Response.json({ code: "ORIGIN_COMPARE_FAILED", error: "The comparison failed. The trace is unchanged." }, { status: 500 });
  }
}
