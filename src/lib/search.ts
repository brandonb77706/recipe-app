// Query understanding for search. Pure string work — no network, no Supabase.

/**
 * Concept and diet tags aren't words that appear on recipe pages. No blog
 * writes "this is meal prep friendly", so a literal full-text search for
 * "meal prep" hits almost nothing — and that is exactly the first query worth
 * typing. These map the phrases people actually use onto the tags we store.
 *
 * The generated tsvector already contains the tag text with underscores turned
 * into spaces, so "meal prep" would match something. This map exists for the
 * phrasings that *don't* look like the tag: "batch cooking", "low cal",
 * "make ahead".
 */
const CONCEPT_ALIASES: Record<string, string[]> = {
  meal_prep: [
    "meal prep", "mealprep", "meal-prep", "meal prepping", "batch cook",
    "batch cooking", "make ahead", "make-ahead", "prep ahead", "freezer",
  ],
  low_calorie: [
    "low calorie", "low cal", "lower calorie", "low-calorie", "light",
    "lighter", "diet",
  ],
  five_ingredients_or_less: [
    "5 ingredients", "five ingredients", "few ingredients", "5 ingredient",
    "minimal ingredients", "short ingredient list", "simple ingredients",
  ],
};

const DIET_ALIASES: Record<string, string[]> = {
  high_protein: ["high protein", "protein packed", "high-protein"],
  vegan: ["vegan", "plant based", "plant-based"],
  vegetarian: ["vegetarian", "veggie", "meatless"],
  gluten_free: ["gluten free", "gluten-free", "no gluten", "celiac"],
  dairy_free: ["dairy free", "dairy-free", "no dairy"],
  nut_free: ["nut free", "nut-free", "no nuts"],
  pescatarian: ["pescatarian", "pescetarian"],
};

const MEAL_TYPE_ALIASES: Record<string, string[]> = {
  breakfast: ["breakfast", "brunch"],
  lunch: ["lunch", "packed lunch"],
  dinner: ["dinner", "supper", "weeknight dinner", "main course", "main"],
  dessert: ["dessert", "sweet", "pudding"],
  snack: ["snack", "snacks"],
  side: ["side dish", "sides", "side"],
  drink: ["drink", "cocktail", "smoothie"],
  sauce: ["sauce", "dressing", "condiment"],
};

export type ExpandedQuery = {
  /** What's left for full-text after alias phrases are lifted out. */
  text: string;
  conceptTags: string[];
  dietTags: string[];
  mealTypes: string[];
  /** The alias phrases that matched, for the debug view. */
  matchedAliases: string[];
  /** True when the whole query was tags — nothing left to full-text search. */
  tagOnly: boolean;
};

function normalize(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Lifts known tag phrases out of the query and returns them separately.
 *
 * "chicken meal prep" → text "chicken", concept meal_prep. The two are then
 * ANDed, which is what the phrase means: chicken recipes that are also meal
 * prep, not chicken recipes plus every meal-prep recipe.
 */
export function expandQuery(raw: string): ExpandedQuery {
  let text = normalize(raw);
  const conceptTags: string[] = [];
  const dietTags: string[] = [];
  const mealTypes: string[] = [];
  const matchedAliases: string[] = [];

  const lift = (
    map: Record<string, string[]>,
    into: string[],
    // Meal types are common words ("main", "side", "light") that are also
    // legitimate text searches, so they only count as a tag when the query is
    // nothing but the alias. "side" means the tag; "side of salmon" does not.
    wholeQueryOnly = false
  ) => {
    for (const [tag, aliases] of Object.entries(map)) {
      // Longest first, so "low calorie" wins over a bare "low".
      for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
        if (wholeQueryOnly) {
          if (text === alias) {
            into.push(tag);
            matchedAliases.push(alias);
            text = "";
          }
          continue;
        }
        const pattern = new RegExp(
          `(^|\\s)${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`,
          "i"
        );
        if (pattern.test(text)) {
          into.push(tag);
          matchedAliases.push(alias);
          text = normalize(text.replace(pattern, " "));
          break; // one alias per tag is enough
        }
      }
    }
  };

  lift(CONCEPT_ALIASES, conceptTags);
  lift(DIET_ALIASES, dietTags);
  lift(MEAL_TYPE_ALIASES, mealTypes, true);

  const tagOnly =
    text.length === 0 &&
    conceptTags.length + dietTags.length + mealTypes.length > 0;

  return { text, conceptTags, dietTags, mealTypes, matchedAliases, tagOnly };
}

/** Nothing to search on — the route falls through to the ranked feed. */
export function isEmptyQuery(e: ExpandedQuery): boolean {
  return (
    e.text.length === 0 &&
    e.conceptTags.length === 0 &&
    e.dietTags.length === 0 &&
    e.mealTypes.length === 0
  );
}
