// Discover filter chips. Safe to import from .tsx — no runtime dependencies.
//
// Chips narrow the candidate set BEFORE ranking, so results stay ordered by
// taste score rather than collapsing into an arbitrary list. Within a group is
// OR, across groups is AND: "chicken + beef" shows both, "dinner + chicken"
// means chicken dinners.

/**
 * Time first, because it's the most trustworthy field here. total_minutes
 * comes straight from the source — not derived, not estimated, not an LLM
 * judgment — and it's usually the actual constraint at 6pm.
 */
export const TIME_CHIPS = [20, 30, 45] as const;

export const MEAL_CHIPS = [
  { value: "dinner", label: "Dinner" },
  { value: "lunch", label: "Lunch" },
  { value: "breakfast", label: "Breakfast" },
  { value: "dessert", label: "Dessert" },
  { value: "snack", label: "Snack" },
] as const;

/**
 * The protein itself, not a nutrition threshold. main_protein is categorical
 * and verifiable — you can look at a recipe and tell whether it's a chicken
 * dish — where "high protein" depends on numbers we've established are soft.
 *
 * `vegetarian` reads diet_tags, NOT main_protein = 'none'. Those are different
 * claims: 'none' covers 39% of the corpus and is full of sides, sauces and
 * drinks, none of which are a vegetarian main course.
 */
export const PROTEIN_CHIPS = [
  { value: "chicken", label: "Chicken", field: "main_protein" },
  { value: "beef", label: "Beef", field: "main_protein" },
  { value: "pork", label: "Pork", field: "main_protein" },
  { value: "fish", label: "Fish", field: "main_protein" },
  { value: "shellfish", label: "Seafood", field: "main_protein" },
  { value: "vegetarian", label: "Vegetarian", field: "diet_tags" },
] as const;

export const CONCEPT_CHIPS = [
  { value: "low_calorie", label: "Low calorie" },
  { value: "meal_prep", label: "Meal prep" },
  { value: "five_ingredients_or_less", label: "5 ingredients" },
] as const;

/** Below this, a chip is a dead option — don't render it at all. */
export const MIN_CHIP_COUNT = 100;

export type ChipFilters = {
  /** Single-select: the options nest, so two at once is meaningless. */
  maxTime: number | null;
  mealTypes: string[];
  proteins: string[];
  concepts: string[];
};

export const NO_CHIPS: ChipFilters = {
  maxTime: null,
  mealTypes: [],
  proteins: [],
  concepts: [],
};

export function anyChipActive(c: ChipFilters): boolean {
  return (
    c.maxTime !== null ||
    c.mealTypes.length > 0 ||
    c.proteins.length > 0 ||
    c.concepts.length > 0
  );
}

/**
 * Time chips at or below the saved max_minutes only.
 *
 * A chip can narrow the pool but never widen it past the preference — so the
 * two can't disagree, and nothing silently overrides a setting. A chip equal
 * to the ceiling is dropped too, since it would be a no-op that looks broken.
 */
export function availableTimeChips(maxMinutes: number | null): number[] {
  if (maxMinutes == null) return [...TIME_CHIPS];
  return TIME_CHIPS.filter((t) => t < maxMinutes);
}

export function chipsToParams(c: ChipFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (c.maxTime != null) p.set("max_time", String(c.maxTime));
  if (c.mealTypes.length) p.set("meal_types", c.mealTypes.join(","));
  if (c.proteins.length) p.set("proteins", c.proteins.join(","));
  if (c.concepts.length) p.set("concepts", c.concepts.join(","));
  return p;
}

const csv = (raw: string | null, allowed: readonly string[]): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => allowed.includes(s));

export function chipsFromParams(p: URLSearchParams): ChipFilters {
  const t = Number(p.get("max_time"));
  return {
    maxTime: (TIME_CHIPS as readonly number[]).includes(t) ? t : null,
    mealTypes: csv(p.get("meal_types"), MEAL_CHIPS.map((m) => m.value)),
    proteins: csv(p.get("proteins"), PROTEIN_CHIPS.map((m) => m.value)),
    concepts: csv(p.get("concepts"), CONCEPT_CHIPS.map((m) => m.value)),
  };
}

/** Per-chip counts over the eligible pool, so a thin option is visible first. */
export type Facets = {
  mealTypes: Record<string, number>;
  proteins: Record<string, number>;
  concepts: Record<string, number>;
  time: Record<string, number>;
  /** Recipes excluded by an active time chip purely for having no time. */
  hiddenNoTime: number;
};
