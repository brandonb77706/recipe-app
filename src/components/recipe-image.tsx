"use client";

import { useState } from "react";
import Image from "next/image";
import { isOptimisableHost } from "@/lib/image-hosts";

/** Marker illustration for AI-written recipes. Contained, so any aspect works. */
const AI_IMAGE = "/ai-chef.jpg";

// The illustration carries its own cream ground. Matching the tile to it hides
// the letterboxing, so one asset sits correctly in both the 16:10 card and the
// much wider detail hero without ever cropping the chef.
const AI_IMAGE_BG = "#FDF6E8";

/**
 * Uses next/image with an open remotePatterns allowlist. Before this the raw
 * <img> shipped 1500px source photos into 170px tiles — twenty of those per
 * screen is minutes of cellular data for a page you scroll past in seconds.
 *
 * `sizes` matters as much as the component: without it next/image assumes
 * 100vw and serves a full-width file to a quarter-width tile.
 *
 * AI-written recipes deliberately do NOT show a food photo. Nobody has cooked
 * them, so any photo — stock or generated — would imply a result that doesn't
 * exist. They get a marked illustration instead.
 */
export function RecipeImage({
  src,
  title = "",
  generated = false,
  className = "",
  imgClassName = "",
  eager = false,
  optimise = true,
  sizes = "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw",
}: {
  src: string | null;
  /** Used to derive the fallback card when there's no photo. */
  title?: string;
  /** True for `extraction_method === "llm_generated"`. */
  generated?: boolean;
  className?: string;
  imgClassName?: string;
  eager?: boolean;
  /** False for grid and deck cards — see the comment on the render path. */
  optimise?: boolean;
  /** Tell the browser the rendered width, or it downloads a full-width file. */
  sizes?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [aiFailed, setAiFailed] = useState(false);

  // Generated recipes ignore image_url entirely — the marker is the point.
  if (generated) {
    return (
      <div
        className={`recipe-image-frame relative overflow-hidden ${className}`}
        style={{ background: aiFailed ? undefined : AI_IMAGE_BG }}
      >
        {aiFailed ? (
          <GeneratedCard title={title} />
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element -- see note above */
          <img
            src={AI_IMAGE}
            alt=""
            loading={eager ? "eager" : "lazy"}
            onError={() => setAiFailed(true)}
            className="h-full w-full object-contain"
          />
        )}
        <AiBadge />
      </div>
    );
  }

  const showImage = src && !failed;

  return (
    <div
      className={`recipe-image-frame relative overflow-hidden bg-accent-soft ${className}`}
    >
      {showImage ? (
        optimise && isOptimisableHost(src) ? (
          <Image
            src={src}
            alt=""
            fill
            sizes={sizes}
            priority={eager}
            onError={() => setFailed(true)}
            className={`object-cover ${imgClassName}`}
          />
        ) : (
          /* Two reasons to land here.
             1. Unconfigured host: hand-imported recipes come from arbitrary
                blogs, and next/image THROWS on an unknown host rather than
                degrading — one photo would take the whole page down.
             2. optimise={false}: grid tiles and swipe cards.

             On (2) the meter is the reason. Vercel Hobby allows 5,000 image
             transformations a month, counted per unique source + size. With
             17,525 distinct photos and a 24-tile grid, roughly 200 screens of
             fresh recipes would exhaust the month — a week of normal use.
             next/image stays on the detail hero, where there is one image per
             page view and the quality is worth a transformation. The source
             blogs already serve sensibly-sized photos. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt=""
            loading={eager ? "eager" : "lazy"}
            onError={() => setFailed(true)}
            className={`absolute inset-0 h-full w-full object-cover ${imgClassName}`}
          />
        )
      ) : (
        <GeneratedCard title={title} />
      )}
    </div>
  );
}

/**
 * Sits top-RIGHT: the detail page pins its back button top-left, and the two
 * collided there. Solid accent rather than a translucent tint, because a
 * see-through pill disappears against the illustration's cream ground.
 */
function AiBadge() {
  return (
    <span
      className="absolute top-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-[13px] font-semibold text-white shadow-md"
      style={{
        // Respect the notch on the full-bleed detail hero.
        top: "max(0.75rem, env(safe-area-inset-top))",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        className="h-3.5 w-3.5"
      >
        <path d="M12 2l1.9 5.5L19.5 9l-4.4 3.3L16.6 18 12 14.8 7.4 18l1.5-5.7L4.5 9l5.6-1.5z" />
      </svg>
      AI generated
    </span>
  );
}

// Matched longest-first, so "sweet potato" wins over "potato" and
// "fried rice" over "rice".
const GLYPHS: ReadonlyArray<readonly [string, string]> = [
  ["sweet potato", "🍠"],
  ["fried rice", "🍚"],
  ["hard boiled egg", "🥚"],
  ["scrambled egg", "🍳"],
  ["quesadilla", "🧀"],
  ["black bean", "🫘"],
  ["chickpea", "🫘"],
  ["lentil", "🫘"],
  ["broccoli", "🥦"],
  ["asparagus", "🥦"],
  ["chicken", "🍗"],
  ["turkey", "🦃"],
  ["beef", "🥩"],
  ["steak", "🥩"],
  ["pork", "🥓"],
  ["bacon", "🥓"],
  ["salmon", "🐟"],
  ["fish", "🐟"],
  ["shrimp", "🦐"],
  ["tofu", "🧊"],
  ["potato", "🥔"],
  ["rice", "🍚"],
  ["pasta", "🍝"],
  ["noodle", "🍝"],
  ["spaghetti", "🍝"],
  ["pizza", "🍕"],
  ["taco", "🌮"],
  ["burrito", "🌯"],
  ["sandwich", "🥪"],
  ["burger", "🍔"],
  ["soup", "🍲"],
  ["stew", "🍲"],
  ["chili", "🌶️"],
  ["curry", "🍛"],
  ["salad", "🥗"],
  ["egg", "🥚"],
  ["oat", "🥣"],
  ["pancake", "🥞"],
  ["waffle", "🧇"],
  ["bread", "🍞"],
  ["muffin", "🧁"],
  ["cookie", "🍪"],
  ["cake", "🍰"],
  ["smoothie", "🥤"],
  ["bowl", "🥣"],
];

function glyphFor(title: string): string {
  const t = title.toLowerCase();
  for (const [term, glyph] of GLYPHS) if (t.includes(term)) return glyph;
  return "🍽️";
}

/** Stable per-title, so a recipe always looks the same between renders. */
function hueFor(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0;
  // Warm band only (reds through golds) — keeps the grid in the app's palette
  // instead of turning into a rainbow.
  return 12 + (Math.abs(h) % 44);
}

/** Fallback when there's no photo and no illustration yet. */
function GeneratedCard({ title }: { title: string }) {
  const hue = hueFor(title);

  return (
    <div
      className="flex h-full w-full items-center justify-center"
      style={{
        background: `linear-gradient(145deg, hsl(${hue} 62% 92%), hsl(${hue + 14} 54% 84%))`,
      }}
      aria-hidden="true"
    >
      <span className="text-[clamp(2rem,18cqw,3.5rem)] leading-none opacity-80 select-none">
        {glyphFor(title)}
      </span>
    </div>
  );
}
