import { NextResponse } from "next/server";
import { isPresenterKey, PRESENTER_COOKIE, PRESENTER_COOKIE_MAX_AGE_SECONDS, presenterKey, presenterToken } from "@/lib/echo/presenter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open /api/presenter?key=… once on the presenting browser to allow its live runs on a locked deployment
 * (ECHO_PRESENTER_KEY set); /api/presenter?logout=1 removes that permission. Returns to the app either way.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // A relative redirect keeps the browser on the host it used (127.0.0.1 vs localhost), so the cookie it was just
  // given is sent with its next request.
  const home = () => new NextResponse(null, { status: 303, headers: { location: "/", "cache-control": "no-store" } });
  const key = presenterKey();
  if (!key) return Response.json({ code: "PRESENTER_KEY_UNSET", error: "This deployment has no presenter key; live runs are open." }, { status: 404, headers: { "cache-control": "no-store" } });

  if (url.searchParams.get("logout") === "1") {
    const response = home();
    response.cookies.delete(PRESENTER_COOKIE);
    return response;
  }

  if (!isPresenterKey(url.searchParams.get("key"))) {
    // A short pause makes guessing the key slow.
    await new Promise((resolve) => setTimeout(resolve, 750));
    return Response.json({ code: "PRESENTER_KEY_WRONG", error: "That presenter key is not right." }, { status: 403, headers: { "cache-control": "no-store" } });
  }

  const response = home();
  response.cookies.set(PRESENTER_COOKIE, presenterToken(key), {
    httpOnly: true,
    sameSite: "lax",
    secure: url.protocol === "https:",
    path: "/",
    maxAge: PRESENTER_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
