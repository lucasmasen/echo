import { useEffect, useRef, useState } from "react";
import { makePortableTrace, parsePortableTrace } from "@/lib/echo/portable";
import { urlsFromParam } from "@/lib/echo/supplied-urls";
import type { EchoAnalysis } from "@/lib/echo/types";

/**
 * The one way a run starts without a click in Echo: the browser extension's side panel, which frames /embed, asks for
 * it after the reader clicked the extension's pop-up (or pressed its shortcut) on a page. The handshake:
 *
 *   1. /embed reads the allowed extension origins from /api/embed (ECHO_EXTENSION_ORIGINS on the server; empty by
 *      default, and then nothing below happens).
 *   2. It makes a one-time nonce (16 random bytes) and posts { type: "echo:embed-ready", nonce } to its parent window
 *      once per allowed origin, with that origin as postMessage's targetOrigin: the browser delivers it only when the
 *      parent really is that extension's page. A website framing /embed (which the frame-ancestors header refuses
 *      anyway), another extension, or a page opening /embed in a tab never learns the nonce.
 *   3. It accepts exactly one { type: "echo:embed-start", nonce, claim, urls? } whose event.source is its parent,
 *      whose event.origin is an allowed origin and whose nonce matches. Then it stops listening: a repeated or later
 *      message starts nothing, and a reload makes a new nonce (the side panel sends a job once).
 *
 * The run itself is the workbench's runLive, as a click would start it: JSON POST from Echo's own origin, the
 * presenter lock and the daily cap unchanged. scripts/check-links.mjs runs this gate with forged messages.
 */
export const EMBED_READY = "echo:embed-ready";
export const EMBED_START = "echo:embed-start";
export const HANDOFF_READY = "echo:handoff-ready";
export const HANDOFF = "echo:handoff";
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const MAX_CLAIM = 500;
const MAX_LINKS = 20;

export type EmbedJob = { claim: string; urls?: string[] };
/**
 * off: not the embed page. standalone: /embed opened in a tab, not framed. checking: asking /api/embed. unlisted: no
 * allowed origin, or the parent is not one of them (a click in Echo still runs). ready: waiting for the start message.
 * started: the one message came and its run started.
 */
export type EmbedStartState = "off" | "standalone" | "checking" | "unlisted" | "ready" | "started";

function nonceHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The job a start message asks for, or null when it is not one: wrong type or nonce, no claim, bad links. */
export function embedJobFrom(data: unknown, nonce: string): EmbedJob | null {
  if (!data || typeof data !== "object" || !nonce) return null;
  const message = data as Record<string, unknown>;
  if (message.type !== EMBED_START || message.nonce !== nonce) return null;
  if (typeof message.claim !== "string") return null;
  const claim = message.claim.replace(/\s+/g, " ").trim().slice(0, MAX_CLAIM);
  if (claim.length < 8) return null;
  if (message.urls === undefined) return { claim };
  if (!Array.isArray(message.urls) || !message.urls.length || message.urls.length > MAX_LINKS || message.urls.some((url) => typeof url !== "string")) return null;
  // The same reader as ?urls=: public http(s) links only, tracking parameters and #fragments dropped, at most 20.
  const urls = urlsFromParam(message.urls.join(" ")).slice(0, MAX_LINKS);
  return urls.length ? { claim, urls } : null;
}

/** The parent's origin as the browser reports it (Chrome's location.ancestorOrigins), for the setup note only. */
function parentOrigin(): string | null {
  try {
    return window.location.ancestorOrigins?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The /embed page's start gate (see above). `onStart` runs at most once per page load, for an accepted message only.
 * Returns the gate's state and the parent's reported origin (shown in the setup note when it is not listed).
 */
export function useEmbedStart(enabled: boolean, onStart: (job: EmbedJob) => void): { state: EmbedStartState; parent: string | null } {
  const [state, setState] = useState<EmbedStartState>(enabled ? "checking" : "off");
  const [parent, setParent] = useState<string | null>(null);
  const start = useRef(onStart);
  useEffect(() => {
    start.current = onStart;
  });
  useEffect(() => {
    if (!enabled) return;
    if (window.parent === window) {
      const timer = window.setTimeout(() => setState("standalone"), 0);
      return () => window.clearTimeout(timer);
    }
    const controller = new AbortController();
    const nonce = nonceHex();
    let allowed: string[] = [];
    let used = false;
    const onMessage = (event: MessageEvent) => {
      if (used || !allowed.length || event.source !== window.parent || !allowed.includes(event.origin)) return;
      const job = embedJobFrom(event.data, nonce);
      if (!job) return;
      used = true;
      window.removeEventListener("message", onMessage);
      setState("started");
      start.current(job);
    };
    window.addEventListener("message", onMessage);
    fetch("/api/embed", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { extensionOrigins?: unknown } | null) => {
        if (controller.signal.aborted) return;
        allowed = Array.isArray(body?.extensionOrigins) ? body.extensionOrigins.filter((origin): origin is string => typeof origin === "string" && EXTENSION_ORIGIN.test(origin)) : [];
        const reported = parentOrigin();
        setParent(reported);
        if (!allowed.length) {
          setState("unlisted");
          return;
        }
        // Delivered only where the parent's origin is that allowed origin; elsewhere the browser drops it.
        for (const origin of allowed) window.parent.postMessage({ type: EMBED_READY, nonce }, origin);
        setState(reported && !allowed.includes(reported) ? "unlisted" : "ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("unlisted");
      });
    return () => {
      controller.abort();
      window.removeEventListener("message", onMessage);
    };
  }, [enabled]);
  return { state, parent };
}

/**
 * "Open full result" from the side panel: opens the full app at `href` (a ?claim= or ?urls= link, which only fills a
 * box) in a new tab and hands it this result, so it shows without a second run. The new tab asks for it with
 * echo:handoff-ready; only that window, on Echo's own origin, gets the trace. Returns false when no tab opened
 * (the link then opens as a plain link).
 */
export function openFullResult(href: string, result: EchoAnalysis): boolean {
  const opened = window.open(href, "_blank");
  if (!opened) return false;
  const trace = makePortableTrace(result);
  const onMessage = (event: MessageEvent) => {
    if (event.source !== opened || event.origin !== window.location.origin || (event.data as { type?: unknown } | null)?.type !== HANDOFF_READY) return;
    window.removeEventListener("message", onMessage);
    opened.postMessage({ type: HANDOFF, trace }, window.location.origin);
  };
  window.addEventListener("message", onMessage);
  window.setTimeout(() => window.removeEventListener("message", onMessage), 60_000);
  return true;
}

/**
 * The full app's side of "Open full result": when this tab was opened by an Echo page on the same origin (the side
 * panel's /embed), ask it for the result and show the trace it sends. A trace opens like a saved run; nothing runs
 * and nothing is spent. Any other window's message is ignored.
 */
export function useOpenerHandoff(enabled: boolean, onTrace: (analysis: EchoAnalysis) => void) {
  const accept = useRef(onTrace);
  useEffect(() => {
    accept.current = onTrace;
  });
  useEffect(() => {
    if (!enabled) return;
    let opener: Window | null = null;
    try {
      opener = window.opener && (window.opener as Window).location.origin === window.location.origin ? (window.opener as Window) : null;
    } catch {
      opener = null;
    }
    if (!opener) return;
    const from = opener;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== from || event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; trace?: unknown } | null;
      if (data?.type !== HANDOFF) return;
      window.removeEventListener("message", onMessage);
      const analysis = parsePortableTrace(data.trace);
      if (analysis) accept.current(analysis);
    };
    window.addEventListener("message", onMessage);
    from.postMessage({ type: HANDOFF_READY }, window.location.origin);
    // Listens until the one handoff arrives (or the page closes): only its opener, on this origin, can send it.
    return () => window.removeEventListener("message", onMessage);
  }, [enabled]);
}
