import fs from "node:fs/promises";
import path from "node:path";
import { parsePortableTrace } from "@/lib/echo/portable";
import { BACKUP_POOL, PRESETS, traceSlug } from "../../demo-slots";
import { verdictHeadline } from "../../trace-view";

// An embeddable badge for a bundled run ("ECHO · 13 pages → 2 independent origins"), for a blog or newsroom to link
// to that exact saved trace. Only bundled runs get one, so the badge's figures always match what its link opens.
// Built at build time; unknown names are 404. Text is XML-escaped and the SVG carries no script.

export const dynamicParams = false;

const RUNS = [...PRESETS, ...BACKUP_POOL].filter((entry): entry is typeof entry & { capturedTrace: string } => Boolean(entry.capturedTrace));

export function generateStaticParams() {
  return RUNS.map((entry) => ({ slug: traceSlug(entry.capturedTrace) }));
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// A rough width for 11 px sans-serif text, enough to size the badge without a font engine.
const textWidth = (text: string) => Math.ceil([...text].reduce((sum, char) => sum + (/[A-Z0-9]/.test(char) ? 7.2 : /[ .,'·]/.test(char) ? 3.6 : 6.3), 0));

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const entry = RUNS.find((candidate) => traceSlug(candidate.capturedTrace) === slug);
  if (!entry) return new Response("Not found", { status: 404 });
  const analysis = parsePortableTrace(JSON.parse(await fs.readFile(path.join(process.cwd(), "public", entry.capturedTrace), "utf8")));
  if (!analysis) return new Response("Not found", { status: 404 });
  const left = "ECHO";
  const right = verdictHeadline(analysis);
  const leftWidth = textWidth(left) + 24; // + letter-spacing
  const rightWidth = textWidth(right) + 20;
  const width = leftWidth + rightWidth;
  const label = `Echo trace of "${analysis.claim}": ${right}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22" role="img" aria-label="${escapeXml(label)}">
<title>${escapeXml(label)}</title>
<rect width="${width}" height="22" rx="4" fill="#2e6f68"/>
<rect x="${leftWidth}" width="${rightWidth}" height="22" rx="4" fill="#fffefa"/>
<rect x="${leftWidth}" width="6" height="22" fill="#fffefa"/>
<rect x="0.5" y="0.5" width="${width - 1}" height="21" rx="3.5" fill="none" stroke="#2e6f68"/>
<g font-family="Verdana, DejaVu Sans, sans-serif" font-size="11">
<text x="10" y="15" fill="#ffffff" font-weight="bold" letter-spacing="1">${left}</text>
<text x="${leftWidth + 10}" y="15" fill="#183331">${escapeXml(right)}</text>
</g>
</svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
