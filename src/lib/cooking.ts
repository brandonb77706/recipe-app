// Shared vocabulary for cooking history. Safe to import from .tsx — no runtime
// dependencies, same contract as types.ts and preferences.ts.

/**
 * Three levels, not five stars.
 *
 * A 5-point scale invites agonising over 3 vs 4 and the extra resolution is
 * noise at one user — you either want to make it again or you don't. These map
 * to a decision, not a score.
 */
export const COOK_RATINGS = ["meh", "good", "great"] as const;
export type CookRating = (typeof COOK_RATINGS)[number];

export const RATING_LABELS: Record<CookRating, string> = {
  meh: "Meh",
  good: "Good",
  great: "Great",
};

/** What each rating actually means, shown under the buttons. */
export const RATING_HINTS: Record<CookRating, string> = {
  meh: "Wouldn't make again",
  good: "Would make again",
  great: "In the rotation",
};

export type Cook = {
  id: string;
  recipe_id: string;
  cooked_at: string;
  rating: CookRating | null;
  note: string | null;
  created_at: string;
};

export type RecipeNote = {
  recipe_id: string;
  note: string;
  updated_at: string;
};

/**
 * "3 days ago", "last week". Absolute dates make you do arithmetic to answer
 * the only question you're actually asking — was this recent.
 */
export function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86_400_000);

  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "a year ago" : `${years} years ago`;
}

/** "Cooked 4 times · last week" — omits entirely at zero, never renders "0". */
export function cookSummary(
  count: number,
  lastCookedAt: string | null
): string | null {
  if (!count) return null;
  const times = count === 1 ? "Cooked once" : `Cooked ${count} times`;
  return lastCookedAt ? `${times} · ${relativeDate(lastCookedAt)}` : times;
}
