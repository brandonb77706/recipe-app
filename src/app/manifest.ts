import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Recipe Vault",
    short_name: "Recipes",
    description: "Personal recipe collection",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    // Matches --paper so the splash and surrounding chrome don't flash white.
    background_color: "#faf6f0",
    theme_color: "#faf6f0",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
