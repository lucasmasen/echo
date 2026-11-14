import fs from "node:fs/promises";
import path from "node:path";
import { parsePortableTrace } from "@/lib/echo/portable";
import { savedCheck, savedClaims, type SavedRun } from "@/lib/echo/saved-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * echo_check over plain HTTP, for any agent framework that can make a GET: /api/echo-check?claim=<one sentence>.
 *
 * Free and read-only. It answers only from the saved run files on disk (public/demo-traces and mcp/traces), with the
 * same matching rule as the MCP tool (src/lib/echo/saved-check.ts). It starts no search and no model call, reads no
 * setting and no key, and writes nothing. A claim with no saved run is refused with the list of claims that have
 * one. Add &links=1 to ask for the saved "Check these sources" run of a claim (links someone supplied, no search).
 * When at least half of the run's origins mention one name that no page of the run is the source of, the reply carries
 * shared_names and shared_names_note (savedCheck adds them, by rule): the origins may share a source.
 * Any site may read it (it serves saved public runs only), and no reply is cached.
 */
const HEADERS = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const MAX_CLAIM = 500;

const reply = (body: unknown, status: number) => Response.json(body, { status, headers: HEADERS });

function parsed(file: string, text: string): SavedRun[] {
  try {
    const analysis = parsePortableTrace(JSON.parse(text));
    return analysis ? [{ file, analysis }] : [];
  } catch {
    return [];
  }
}

const traceNames = (names: string[]) => names.filter((name) => name.endsWith(".echo.json")).sort();

// Each folder is read through its own literal path, so a build traces these two folders and not the whole project.
async function bundledRuns(): Promise<SavedRun[]> {
  const names = traceNames(await fs.readdir(path.join(process.cwd(), "public", "demo-traces")).catch(() => []));
  const runs = await Promise.all(names.map(async (name) => parsed(name, await fs.readFile(path.join(process.cwd(), "public", "demo-traces", name), "utf8").catch(() => ""))));
  return runs.flat();
}

async function telemRuns(): Promise<SavedRun[]> {
  const names = traceNames(await fs.readdir(path.join(process.cwd(), "mcp", "traces")).catch(() => []));
  const runs = await Promise.all(names.map(async (name) => parsed(name, await fs.readFile(path.join(process.cwd(), "mcp", "traces", name), "utf8").catch(() => ""))));
  return runs.flat();
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const claim = (params.get("claim") ?? "").trim();
  if (!claim) return reply({ error: "Pass the claim as one sentence in the claim parameter of the address." }, 400);
  if (claim.length > MAX_CLAIM) return reply({ error: `Pass the claim as one sentence of at most ${MAX_CLAIM} characters.` }, 400);
  const kind = params.get("links") === "1" ? "links" : "search";
  // Read on every call, so a run saved while the server is up is found.
  const runs = [...(await bundledRuns()), ...(await telemRuns())];
  const found = savedCheck(claim, runs, kind);
  if (found) return reply(found, 200);
  return reply({
    error: "No saved Echo run matches this claim. This address answers from saved runs only and never starts a live run. The claims that do have a saved run are listed in hint.",
    hint: savedClaims(runs, kind),
  }, 404);
}

/** A browser asks first when a page on another site adds its own request headers. Nothing runs here. */
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...HEADERS, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" } });
}
