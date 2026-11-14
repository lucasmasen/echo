import type { Metadata } from "next";
import EchoWorkbench from "../echo-workbench";

export const metadata: Metadata = {
  title: "Echo — side panel",
  robots: { index: false, follow: false },
};

/**
 * Echo in the browser extension's side panel (extension/sidepanel.html frames it). The same workbench in a compact
 * layout. Its address, like every other, only fills a box (?claim=, ?urls=); a run starts from a click here or from
 * the listed extension's start message (src/app/embed-bridge.ts). Framed only by ECHO_EXTENSION_ORIGINS (src/proxy.ts).
 */
export default function EmbedPage() {
  return <EchoWorkbench embed />;
}
