import type { Metadata } from "next";
import PwaRegister from "./pwa-register";
import { siteUrl } from "@/lib/echo/site";
import "./globals.css";

const description =
  "Trace claims back to their original sources. See which pages add evidence and which repeat the same story.";

// Shared links need an absolute preview-image URL (see siteUrl); on Vercel, Next also reads VERCEL_* itself.
export const metadata: Metadata = {
  metadataBase: siteUrl() ?? undefined,
  title: "Echo — Source Independence",
  description,
  // How a shared link unfurls; the image is src/app/opengraph-image.tsx.
  openGraph: { title: "Echo — Follow the source, not the crowd", description, type: "website", siteName: "Echo" },
  twitter: { card: "summary_large_image", title: "Echo — Follow the source, not the crowd", description },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
