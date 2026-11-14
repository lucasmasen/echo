import { analyzeClaim, EchoPipelineError, suppliedSourceUrls } from "@/lib/echo/pipeline";
import { costReceiptOf } from "@/lib/echo/cost-receipt";
import { dailyCapUsd, getAnthropicBudgetSnapshot } from "@/lib/echo/daily-budget";
import { copyHuntEnabled } from "@/lib/echo/copy-hunt";
import { mayStartPaidWork, PRESENTER_ONLY_MESSAGE, presenterKey } from "@/lib/echo/presenter";
import { isJsonRequest, JSON_REQUIRED, readBodyWithin } from "@/lib/echo/request-body";
import { searchRouterStatus } from "@/lib/echo/telem";
import type { PipelineProgress } from "@/lib/echo/types";

export const runtime = "nodejs";
export const maxDuration = 300;
const MAX_ANALYZE_BODY_BYTES = 8_192;

export async function GET(request: Request) {
  // The ledger could not be read: no figures, and live runs read as paused.
  const dailyBudget = await getAnthropicBudgetSnapshot().catch(() => ({
    capUsd: dailyCapUsd("claude"),
    day: "",
    spentUsd: 0,
    reservedUsd: 0,
    available: false,
    storage: "unavailable" as const,
  }));
  return Response.json(
    {
      anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      tavilyConfigured: Boolean(process.env.TAVILY_API_KEY),
      // Which search router a live run uses ("telem" | "tavily"), or "misconfigured" (Telem chosen, its key missing or
      // malformed). A name only: never the key or the router's address.
      searchRouter: searchRouterStatus(),
      copyHuntEnabled: copyHuntEnabled(),
      // A locked deployment (ECHO_PRESENTER_KEY set) runs live claims only for the presenter's browser.
      liveRunsLocked: Boolean(presenterKey()) && !mayStartPaidWork(request),
      dailyBudget,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  if (!mayStartPaidWork(request)) {
    return Response.json({ code: "PRESENTER_ONLY", error: PRESENTER_ONLY_MESSAGE }, { status: 403 });
  }
  // JSON only, so another site cannot start a paid run with a form or text/plain POST (see isJsonRequest).
  if (!isJsonRequest(request)) return Response.json(JSON_REQUIRED, { status: 415 });
  let body: { claim?: unknown; forceFresh?: unknown; urls?: unknown; searchMode?: unknown };
  try {
    // A claim is at most 500 characters; stop reading a body (chunked or not) as soon as it passes 8 KB.
    const raw = await readBodyWithin(request, MAX_ANALYZE_BODY_BYTES);
    if (raw === null) {
      return Response.json({ code: "REQUEST_TOO_LARGE", error: "That request is too large. Send a claim of 500 characters or fewer." }, { status: 413 });
    }
    body = JSON.parse(raw) as { claim?: unknown; forceFresh?: unknown; urls?: unknown; searchMode?: unknown };
  } catch {
    return Response.json({ error: "Send a JSON request with a claim field." }, { status: 400 });
  }

  if (typeof body.claim !== "string") {
    return Response.json({ code: "CLAIM_REQUIRED", error: "Add a claim to analyze." }, { status: 400 });
  }
  // Deep search (search-mode.ts) is asked for in the body only, by the claim box's toggle: "deep", or "standard" / absent
  // for the run Echo has always made. Anything else is refused before anything runs. No URL or GET can set it.
  if (body.searchMode !== undefined && body.searchMode !== "standard" && body.searchMode !== "deep") {
    return Response.json({ code: "SEARCH_MODE_INVALID", error: "searchMode must be \"standard\" or \"deep\"." }, { status: 400 });
  }
  const searchMode = body.searchMode === "deep" ? "deep" as const : undefined;
  // "Check these sources": at most 20 public http(s) links replace the search. A bad list is refused before anything
  // runs (analyzeClaim checks it again); a body without urls is an ordinary search run, exactly as before.
  let urls: string[] | undefined;
  if (body.urls !== undefined) {
    try {
      urls = suppliedSourceUrls(body.urls);
    } catch (error) {
      if (error instanceof EchoPipelineError) return Response.json({ code: error.code, error: error.message }, { status: 400 });
      throw error;
    }
  }

  const encoder = new TextEncoder();
  let cancelled = false;
  const analysisController = new AbortController();
  const abortAnalysis = () => analysisController.abort(request.signal.reason);
  if (request.signal.aborted) abortAnalysis();
  else request.signal.addEventListener("abort", abortAnalysis, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, value: unknown) => {
        if (!cancelled) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
      };
      const onProgress = (value: PipelineProgress) => send("progress", value);

      void analyzeClaim(body.claim as string, onProgress, {
        forceFresh: body.forceFresh === true,
        signal: analysisController.signal,
        ...(urls ? { urls } : {}),
        ...(searchMode ? { searchMode } : {}),
      })
        .then((result) => send("result", result))
        .catch((error: unknown) => {
          if (analysisController.signal.aborted) return;
          // What the run spent before it failed, when analyzeClaim knew (it puts the receipt on any error it throws
          // after spending can start); older clients read only code and message, and an error without one keeps the old shape.
          const receipt = costReceiptOf(error);
          const spent = receipt ? { costReceipt: receipt } : {};
          if (error instanceof EchoPipelineError) {
            send("error", { code: error.code, message: error.message, ...spent });
          } else if (error instanceof DOMException && error.name === "TimeoutError") {
            send("error", { code: "TIMEOUT", message: "A provider request timed out. Try the claim again.", ...spent });
          } else {
            send("error", { code: "ANALYSIS_FAILED", message: "Echo could not finish this analysis. Please try again.", ...spent });
          }
        })
        .finally(() => {
          request.signal.removeEventListener("abort", abortAnalysis);
          if (!cancelled) controller.close();
        });
    },
    cancel() {
      cancelled = true;
      analysisController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
