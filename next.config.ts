import { IMAGE_HOSTS } from "./src/lib/image-hosts";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Default position is bottom-left, which sits exactly on cook mode's
  // Previous button — it covered the control in a real screenshot and blocked
  // clicks in automated testing. Dev-only, but it obscures the one screen
  // that's hardest to test any other way.
  devIndicators: { position: "top-left" },

  images: {
    // Recipe photos come from arbitrary blog hosts, so the allowlist has to be
    // open. Without this, next/image refuses them and we fall back to raw
    // <img> — which is what was shipping 1500px sources into 170px tiles.
    // Narrowed from "**". An open allowlist makes the image optimiser a free
    // proxy for any image on the internet — a bandwidth and cost vector once
    // this is deployed. These are the twelve crawled sources plus the two
    // stock hosts used by scripts/backfill-images.ts. Adding a source to
    // SOURCES in seed.ts means adding it here too.
    remotePatterns: IMAGE_HOSTS.flatMap((host) => [
      { protocol: "https" as const, hostname: host },
      { protocol: "https" as const, hostname: `*.${host}` },
    ]),
    // The widths actually used: dense tiles, swipe cards, detail heroes.
    imageSizes: [96, 128, 180, 256, 384],
    deviceSizes: [390, 640, 828, 1080, 1440],
  },
  async headers() {
    return [
      {
        // A cached service worker is a service worker you can't update.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
