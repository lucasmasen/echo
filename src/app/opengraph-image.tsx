import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { parsePortableTrace } from "@/lib/echo/portable";
import { PRESETS } from "./demo-slots";
import { plainSearchHeadline, plainSearchLineage, verdictHeadline } from "./trace-view";

// The preview a shared Echo link unfurls with (Slack, iMessage, X, LinkedIn). Generated once at build time. Its example
// lines are read from the bundled phones run, never typed in, so they always match what the link opens.
export const alt = "Echo traces a claim back to its independent sources";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const node = (label: string, background: string, color: string) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 74, height: 74, borderRadius: 37, background, color, fontSize: 34, fontWeight: 700 }}>{label}</div>
);

/** The phones run's claim, verdict and plain-search headline; null if the bundled trace cannot be read. */
async function phonesExample(): Promise<{ claim: string; verdict: string; plain: string | null } | null> {
  const trace = PRESETS.find((preset) => preset.id === "phones")?.capturedTrace;
  if (!trace) return null;
  try {
    const analysis = parsePortableTrace(JSON.parse(await readFile(path.join(process.cwd(), "public", trace), "utf8")));
    if (!analysis || analysis.mode !== "live") return null;
    const lineage = plainSearchLineage(analysis);
    return { claim: analysis.claim, verdict: verdictHeadline(analysis), plain: lineage ? plainSearchHeadline(lineage) : null };
  } catch {
    return null;
  }
}

export default async function Image() {
  const example = await phonesExample();
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", padding: "64px 80px", background: "#fbfdf9", color: "#20372d", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 720 }}>
          <div style={{ display: "flex", fontSize: 26, letterSpacing: 6, color: "#3f715d", fontWeight: 700 }}>ECHO</div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 60, lineHeight: 1.08, fontWeight: 700 }}>Follow the source, not the crowd.</div>
            {example ? (
              <div style={{ display: "flex", flexDirection: "column", marginTop: 26, paddingLeft: 20, borderLeft: "4px solid #548b79" }}>
                <div style={{ display: "flex", fontSize: 24, color: "#55695f" }}>{`“${example.claim}”`}</div>
                <div style={{ display: "flex", marginTop: 8, fontSize: 30, fontWeight: 700, color: "#294f45" }}>{example.verdict}</div>
                {example.plain ? <div style={{ display: "flex", marginTop: 10, fontSize: 22, lineHeight: 1.35, color: "#55695f" }}>{example.plain}</div> : null}
              </div>
            ) : (
              <div style={{ display: "flex", marginTop: 26, fontSize: 30, lineHeight: 1.35, color: "#55695f" }}>Trace a claim through the web. See which pages add evidence and which only repeat the story.</div>
            )}
          </div>
          <div style={{ display: "flex", fontSize: 22, color: "#7a8982" }}>Independent origins · copied echoes · answers from the origins</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexGrow: 1, gap: 26 }}>
          {node("A", "#3f715d", "#ffffff")}
          <div style={{ display: "flex", gap: 30 }}>
            {node("B", "#e3efe7", "#3f715d")}
            {node("C", "#e3efe7", "#3f715d")}
            {node("D", "#e3efe7", "#3f715d")}
          </div>
          <div style={{ display: "flex", fontSize: 22, color: "#7a8982" }}>Illustration: 1 origin, 3 echoes</div>
        </div>
      </div>
    ),
    size,
  );
}
