// Library organization vocabulary. Safe to import from .tsx — no runtime deps.
//
// Every option here is derived from data the app already has: enrichment tags
// and the Phase 10 cook log. Nothing needs manual curation, because a
// single-user app where organizing is a chore is an app that never gets
// organized — the folders stay empty and the flat list stays flat.

export const SORT_OPTIONS = [
  { value: "recent", label: "Recently added" },
  { value: "cooked", label: "Recently cooked" },
  { value: "most_cooked", label: "Most cooked" },
  { value: "title", label: "A–Z" },
  { value: "quick", label: "Quickest" },
] as const;
export type SortOption = (typeof SORT_OPTIONS)[number]["value"];
export const DEFAULT_SORT: SortOption = "recent";

/**
 * The one filter that isn't a tag, and the most useful one: a library fills up
 * with things you meant to cook and never did. "Never cooked" surfaces exactly
 * that backlog; "In the rotation" is the opposite — the proven ones.
 */
export const COOKED_FILTERS = [
  { value: "never", label: "Never cooked" },
  { value: "cooked", label: "Cooked before" },
  { value: "rotation", label: "In the rotation" },
] as const;
export type CookedFilter = (typeof COOKED_FILTERS)[number]["value"];

export const MEAL_TYPE_FILTERS = [
  { value: "dinner", label: "Dinner" },
  { value: "lunch", label: "Lunch" },
  { value: "breakfast", label: "Breakfast" },
  { value: "dessert", label: "Dessert" },
  { value: "side", label: "Side" },
  { value: "snack", label: "Snack" },
] as const;
export type MealTypeFilter = (typeof MEAL_TYPE_FILTERS)[number]["value"];

/** Applied server-side; this is only the shape the client sends. */
export type LibraryQuery = {
  sort: SortOption;
  cooked: CookedFilter | null;
  mealType: MealTypeFilter | null;
};

export const EMPTY_QUERY: LibraryQuery = {
  sort: DEFAULT_SORT,
  cooked: null,
  mealType: null,
};

export function isFiltered(q: LibraryQuery): boolean {
  return q.cooked !== null || q.mealType !== null;
}
