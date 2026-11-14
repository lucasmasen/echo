import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Echo — Source Independence",
    short_name: "Echo",
    description: "Trace repeated claims back to their independent sources.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f3f6f3",
    theme_color: "#f3f6f3",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
