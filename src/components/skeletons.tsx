/**
 * Loading placeholders.
 *
 * ONE definition, shared by Discover and the library, because the previous
 * version was duplicated in both pages and had drifted from the real card: it
 * still used the pre-dense design (aspect-[16/10] inside a ringed box) while
 * cards had moved to aspect-[4/5] with no chrome. At 390px that is a 105px
 * image standing in for a 211px one — every row jumped ~87px when data landed.
 *
 * A skeleton whose dimensions don't match the real thing is worse than no
 * skeleton, because content moving under your thumb is more annoying than a
 * brief blank. If the card layout changes, change it HERE too.
 *
 * Motion is opt-out: `motion-safe:` means anyone with prefers-reduced-motion
 * gets a static placeholder rather than a pulse.
 */

/** Mirrors RecipeCard dense mode exactly: 4/5 image, mt-2 title, mt-0.5 meta. */
export function SkeletonTile() {
  return (
    <li aria-hidden>
      <div className="aspect-[4/5] motion-safe:animate-pulse rounded-[var(--radius-card)] bg-line/50" />
      {/* Same mt-2 + h-[60px] box the real card reserves, so the tile is
          byte-identical in height whether it holds a skeleton or a recipe. */}
      <div className="mt-2 h-[60px]">
        <div className="h-[15px] w-[85%] motion-safe:animate-pulse rounded bg-line/50" />
        <div className="mt-[4px] h-[15px] w-[55%] motion-safe:animate-pulse rounded bg-line/50" />
        <div className="mt-[6px] h-[13px] w-[32%] motion-safe:animate-pulse rounded bg-line/40" />
      </div>
    </li>
  );
}

/**
 * `count` should match what the real fetch returns, so the scroll height
 * doesn't jump either. Discover asks for 24, the library varies.
 */
export function SkeletonGrid({ count = 24 }: { count?: number }) {
  return (
    <ul
      className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4"
      aria-label="Loading recipes"
      aria-busy="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonTile key={i} />
      ))}
    </ul>
  );
}

/**
 * The swipe deck's placeholder card.
 *
 * Sized and positioned like a real SwipeCard (absolute inset-0, 62% photo) so
 * the deck's frame and controls are on screen immediately and only the content
 * fills in. Previously the whole screen waited on the fetch.
 */
export function SkeletonSwipeCard() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 overflow-hidden rounded-3xl bg-surface shadow-lg ring-1 ring-line"
    >
      <div className="h-[62%] w-full motion-safe:animate-pulse bg-line/50" />
      <div className="px-6 py-5">
        <div className="h-[22px] w-[80%] motion-safe:animate-pulse rounded bg-line/50" />
        <div className="mt-2 h-[16px] w-[45%] motion-safe:animate-pulse rounded bg-line/40" />
      </div>
    </div>
  );
}
