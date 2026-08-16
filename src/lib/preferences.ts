// Shared preference vocabulary and the tri-state contract. Safe to import from
// client components — no runtime dependencies.

/**
 * Every multi-select answer has three distinct states, and the ranker treats
 * them differently:
 *
 *   null   — never answered (a question added after this row was written).
 *            Cold-start heuristics may apply.
 *   []     — answered "no preference". Never filter or boost on this axis.
 *   [...]  — a real choice. Filter (diets, proteins) or boost (cuisines).
 *
 * Collapsing null and [] would make "I don't care about cuisine" indistinguishable
 * from "we never asked", which are different situations.
 */
export type Answer<T extends string> = T[] | null;

export type Preferences = {
  user_id: string;
  /** null = no time limit. */
  max_minutes: number | null;
  diets: Answer<DietNeed>;
  avoid_proteins: Answer<ProteinChoice>;
  /**
   * The subset of avoid_proteins where a trace disqualifies the dish. Not a
   * tri-state — it's a refinement of an answer already given, so it's only
   * meaningful alongside a non-empty avoid_proteins.
   */
  strict_proteins: ProteinChoice[] | null;
  favorite_cuisines: Answer<CuisineChoice>;
  prefer_high_protein: boolean;
  prefer_concepts: Answer<ConceptChoice>;
  completed_at: string | null;
  updated_at: string;
};

export const TIME_OPTIONS = [
  { value: 20, label: "20 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 45, label: "45 minutes" },
  { value: null, label: "No limit" },
] as const;

// Only the diet tags with real corpus volume. dairy_free/nut_free/pescatarian
// are derived and plentiful; the rest are the model's judgment calls.
export const DIET_NEEDS = [
  { value: "vegetarian", label: "Vegetarian" },
  { value: "vegan", label: "Vegan" },
  { value: "gluten_free", label: "Gluten free" },
  { value: "dairy_free", label: "Dairy free" },
  { value: "nut_free", label: "Nut free" },
  { value: "pescatarian", label: "Pescatarian" },
] as const;
export type DietNeed = (typeof DIET_NEEDS)[number]["value"];

export const PROTEIN_CHOICES = [
  { value: "chicken", label: "Chicken" },
  { value: "beef", label: "Beef" },
  { value: "pork", label: "Pork" },
  { value: "fish", label: "Fish" },
  { value: "shellfish", label: "Shellfish" },
  { value: "eggs", label: "Eggs" },
  { value: "cheese", label: "Cheese" },
  { value: "tofu", label: "Tofu" },
  { value: "beans", label: "Beans" },
  { value: "lentils", label: "Lentils" },
] as const;
export type ProteinChoice = (typeof PROTEIN_CHOICES)[number]["value"];

/**
 * The ten cuisines with enough corpus volume to be worth offering. The tail —
 * japanese 89, korean 49, vietnamese 36, german 10, african 10 — stays
 * available as a filter chip on /discover, but offering it here would produce
 * a preference that matches almost nothing.
 */
export const CUISINE_CHOICES = [
  { value: "american", label: "American" },
  { value: "italian", label: "Italian" },
  { value: "mexican", label: "Mexican" },
  { value: "mediterranean", label: "Mediterranean" },
  { value: "thai", label: "Thai" },
  { value: "indian", label: "Indian" },
  { value: "french", label: "French" },
  { value: "middle_eastern", label: "Middle Eastern" },
  { value: "chinese", label: "Chinese" },
  { value: "fusion", label: "Fusion" },
] as const;
export type CuisineChoice = (typeof CUISINE_CHOICES)[number]["value"];

export const MAX_FAVORITE_CUISINES = 5;

/**
 * Which avoidances default to strict when the user first picks them.
 *
 * Pork and shellfish are usually religious or allergic, where a trace matters
 * and a bacon garnish disqualifies the whole dish. The rest are usually taste,
 * where excluding every recipe with a splash of broth costs more than it
 * saves. The user can flip any of them; this is only the starting position.
 */
export const STRICT_BY_DEFAULT: readonly ProteinChoice[] = ["pork", "shellfish"];

/**
 * Keeps strict_proteins in step with avoid_proteins as the selection changes.
 * Proteins the user already ruled on keep that ruling; newly added ones take
 * the default; deselected ones are dropped so a stale entry can't quietly
 * hard-exclude on an answer that has since changed.
 */
export function reconcileStrict(
  nextAvoided: Answer<ProteinChoice>,
  prevAvoided: Answer<ProteinChoice>,
  currentStrict: ProteinChoice[] | null
): ProteinChoice[] | null {
  if (!hasPreference(nextAvoided)) return null;
  const prev = prevAvoided ?? [];
  const current = currentStrict ?? [];
  return nextAvoided.filter((p) =>
    prev.includes(p) ? current.includes(p) : STRICT_BY_DEFAULT.includes(p)
  );
}

/** True when a trace of this protein anywhere disqualifies the recipe. */
export function isStrict(
  protein: ProteinChoice,
  strict: ProteinChoice[] | null
): boolean {
  return strict === null
    ? STRICT_BY_DEFAULT.includes(protein)
    : strict.includes(protein);
}

/**
 * These are boosts, never hard filters — a wrong answer here costs nothing but
 * a slightly worse ordering, so the feed can't be emptied by them.
 * high_protein lives in its own boolean column but is presented alongside.
 */
export const CONCEPT_CHOICES = [
  { value: "high_protein", label: "High protein", hint: "25g+ per serving" },
  { value: "meal_prep", label: "Meal prep", hint: "Keeps and reheats well" },
  // Relative, not absolute: the tag is now the lightest third *within a dish
  // type*, so a number here would be a different number for every recipe.
  {
    value: "low_calorie",
    label: "Lighter than most",
    hint: "In the lightest third of its kind",
  },
  {
    value: "five_ingredients_or_less",
    label: "Few ingredients",
    hint: "Five or fewer",
  },
] as const;
export type ConceptChoice = (typeof CONCEPT_CHOICES)[number]["value"];

/**
 * high_protein is stored in its own boolean column (the ranker scores it
 * against measured protein_grams, not a tag) but is presented as one of the
 * concept chips. These two functions are the only places that seam exists.
 */
export function conceptsFromRow(
  p: Pick<Preferences, "prefer_concepts" | "prefer_high_protein"> | null
): Answer<ConceptChoice> {
  if (!p) return null;
  if (p.prefer_concepts === null && !p.prefer_high_protein) return null;
  const rest = p.prefer_concepts ?? [];
  return p.prefer_high_protein ? ["high_protein", ...rest] : [...rest];
}

/** True once onboarding has been completed at least once. */
export function isOnboarded(p: Preferences | null): boolean {
  return !!p?.completed_at;
}

/** `[]` and `null` both mean "don't rank on this", for different reasons. */
export function hasPreference<T extends string>(a: Answer<T>): a is T[] {
  return Array.isArray(a) && a.length > 0;
}
