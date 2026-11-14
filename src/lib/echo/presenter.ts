import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Optional presenter lock for a public deployment. With ECHO_PRESENTER_KEY set, only a browser that opened
 * /api/presenter?key=… once may start paid work (live analysis, copy hunts); everyone else can still open the demo
 * slots and saved traces. A shared link therefore cannot spend the daily cap before the demo. With the key unset
 * (the default, and local development) nothing is locked.
 */
export const PRESENTER_COOKIE = "echo_presenter";
export const PRESENTER_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function presenterKey(): string | null {
  const key = process.env.ECHO_PRESENTER_KEY?.trim();
  return key ? key : null;
}

/** The cookie holds a token derived from the key, never the key itself. */
export function presenterToken(key: string): string {
  return createHmac("sha256", key).update("echo-presenter-v1").digest("hex");
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** True when `candidate` is the configured key. */
export function isPresenterKey(candidate: string | null | undefined): boolean {
  const key = presenterKey();
  return Boolean(key && typeof candidate === "string" && sameSecret(presenterToken(candidate), presenterToken(key)));
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [rawName, ...rest] = part.split("=");
    if (rawName?.trim() === name) {
      try { return decodeURIComponent(rest.join("=").trim()); } catch { return null; }
    }
  }
  return null;
}

/** True when this request may start paid work: no key is configured, or it carries the presenter cookie. */
export function mayStartPaidWork(request: Request): boolean {
  const key = presenterKey();
  if (!key) return true;
  const token = cookieValue(request.headers.get("cookie"), PRESENTER_COOKIE);
  return Boolean(token && sameSecret(token, presenterToken(key)));
}

export const PRESENTER_ONLY_MESSAGE =
  "Live runs on this deployment are reserved for the presenter. Open a demo slot or a saved trace to explore Echo.";

/** "Find claims in this page" reads a page (no search, no model call), so it is not called a live run. */
export const PAGE_READ_PRESENTER_ONLY_MESSAGE =
  "On this deployment, reading a page for claims is kept for the presenter. Open a demo slot or a saved trace to explore Echo.";
