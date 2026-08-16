// Deterministic nutrition parsing from JSON-LD. No LLM, no network.
// Roughly half of crawled recipes carry no nutrition block at all, so the
// absence of data is a first-class outcome here rather than a null that
// quietly leaks into filters.

/** How a protein figure was arrived at. `unknown` is the default. */
export type ProteinSource = "measured" | "estimated" | "unknown";
export type ProteinConfidence = "high" | "low";

export type NutritionParse = {
  protein_grams: number | null;
  calories: number | null;
  protein_source: ProteinSource;
  protein_confidence: ProteinConfidence | null;
  /** Why parsing produced what it did — for the enrichment run log. */
  reason: string;
};

// Above these, the value is a parse artifact rather than a real measurement
// (usually whole-recipe totals mislabelled as per-serving).
export const MAX_PROTEIN_GRAMS = 200;
export const MAX_CALORIES = 5000;

// Atwater factors: protein and carbs 4 cal/g, fat 9. When all three macros
// are present the stated calorie figure has to roughly agree with them. It
// won't if the site mixed scopes — per-recipe calories beside per-serving
// macros drift by a factor of the serving count, which dwarfs the rounding
// and fiber noise this tolerance absorbs.
const MACRO_CALORIE_TOLERANCE = 0.3;

/**
 * Nutrition values arrive as strings, not numbers: "12 g", "12g", "12",
 * "12 grams". Take the number, discard the unit.
 */
export function parseNutritionValue(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

// A servingSize carrying a unit ("4 g", "1.25 cups", "2 slices") describes
// how big one serving is, so it can never be a per-recipe count — even when
// its number happens to equal the yield. Sites emit junk like "4 g" for a
// whole dinner, which would otherwise collide with a yield of 4 and get
// perfectly good figures thrown away.
const SERVING_MEASURE_UNIT =
  /\d\s*(g|gram|grams|kg|mg|oz|ounce|ounces|lb|lbs|pound|pounds|ml|l|liter|liters|litre|litres|cup|cups|tbsp|tsp|tablespoon|tablespoons|teaspoon|teaspoons|slice|slices|piece|pieces|bowl|bowls|plate|plates|bar|bars|cookie|cookies|muffin|muffins)\b/i;

const unknown = (reason: string): NutritionParse => ({
  protein_grams: null,
  calories: null,
  protein_source: "unknown",
  protein_confidence: null,
  reason,
});

/**
 * @param nutritionNode  `raw_payload.jsonld.nutrition`
 * @param servings       the recipe's stored servings (from recipeYield)
 */
export function parseNutrition(
  nutritionNode: unknown,
  servings: number | null
): NutritionParse {
  if (!nutritionNode || typeof nutritionNode !== "object") {
    return unknown("no nutrition block");
  }

  const node = nutritionNode as Record<string, unknown>;

  // Per-serving vs per-recipe ambiguity makes a number worse than useless.
  // A bare servingSize that restates the yield ("4 servings" for a yield of
  // 4) means these figures describe the whole dish.
  const servingSizeRaw =
    node.servingSize == null ? null : String(node.servingSize);
  const servingSize = parseNutritionValue(servingSizeRaw);
  const describesOneServing = servingSizeRaw
    ? SERVING_MEASURE_UNIT.test(servingSizeRaw)
    : false;

  if (
    !describesOneServing &&
    servings != null &&
    servingSize != null &&
    servingSize > 1 &&
    Math.round(servingSize) === Math.round(servings)
  ) {
    return unknown(
      `servingSize (${servingSizeRaw}) restates recipeYield (${servings}) — figures look per-recipe`
    );
  }

  let protein = parseNutritionValue(node.proteinContent);
  let calories = parseNutritionValue(node.calories);
  const rejected: string[] = [];

  if (protein != null && (protein < 0 || protein > MAX_PROTEIN_GRAMS)) {
    rejected.push(`protein ${protein}g out of range`);
    protein = null;
  }
  if (calories != null && (calories < 0 || calories > MAX_CALORIES)) {
    rejected.push(`calories ${calories} out of range`);
    calories = null;
  }

  if (protein == null && calories == null) {
    return unknown(
      rejected.length ? rejected.join("; ") : "no parseable protein or calories"
    );
  }

  // Scope cross-check. A servingSize can be junk or absent, so this catches
  // the mixed-scope case it misses. If the figures disagree we can't tell
  // which one is per-serving, so neither is trustworthy.
  const carbs = parseNutritionValue(node.carbohydrateContent);
  const fat = parseNutritionValue(node.fatContent);
  if (calories != null && protein != null && carbs != null && fat != null) {
    const fromMacros = 4 * protein + 4 * carbs + 9 * fat;
    if (fromMacros > 0) {
      const drift = Math.abs(calories - fromMacros) / fromMacros;
      if (drift > MACRO_CALORIE_TOLERANCE) {
        return unknown(
          `calories (${calories}) disagree with macros (~${Math.round(fromMacros)} ` +
            `from ${protein}p/${carbs}c/${fat}f, ${Math.round(drift * 100)}% off) — scopes look mixed`
        );
      }
    }
  }

  return {
    protein_grams: protein,
    calories,
    // Only a real protein figure earns `measured`; calories alone leaves the
    // protein columns untouched so the high-protein filter can't be fooled.
    protein_source: protein != null ? "measured" : "unknown",
    protein_confidence: protein != null ? "high" : null,
    reason: rejected.length ? `partial: ${rejected.join("; ")}` : "parsed",
  };
}

/**
 * Display rule for every nullable nutrition figure: never render "0g" or a
 * dash for missing data — "Protein: 0g" reads as a factual claim. Callers
 * omit the element entirely when this returns null. Estimated values carry a
 * tilde, measured ones don't.
 */
export function formatProtein(
  grams: number | null,
  source: ProteinSource
): string | null {
  if (grams == null || source === "unknown") return null;
  const rounded = Math.round(grams);
  return source === "estimated" ? `~${rounded}g` : `${rounded}g`;
}

export function formatCalories(calories: number | null): string | null {
  if (calories == null) return null;
  return `${Math.round(calories)} cal`;
}
