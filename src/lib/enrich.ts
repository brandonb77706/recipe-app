// Derived fields that need no LLM and no network. Everything here is a pure
// function of a row we already have, so it's free to re-run.
import type { Ingredient } from "./types";

export type Effort = "quick" | "moderate" | "project";

/** Null when the time is unknown — never guess an effort band. */
export function deriveEffort(totalMinutes: number | null): Effort | null {
  if (totalMinutes == null || !Number.isFinite(totalMinutes) || totalMinutes <= 0)
    return null;
  if (totalMinutes <= 30) return "quick";
  if (totalMinutes <= 60) return "moderate";
  return "project";
}

/** Counted, never asked of the model. */
export function isFiveIngredientsOrLess(ingredients: Ingredient[]): boolean {
  return ingredients.length > 0 && ingredients.length <= 5;
}

/**
 * "Light for its kind" — the 33rd-percentile calorie count within each meal
 * type. Measured from the corpus, not chosen.
 *
 * Derived 2026-08-02 from the 7,153 corpus rows carrying calorie data (of
 * 8,462 total). **These numbers drift as the corpus grows** — every run of
 * enrich-deterministic prints the current p33 per type alongside these, so a
 * drift shows up without anyone going looking for it.
 *
 * This replaced a flat `calories <= 500`, which turned out to be a step
 * function with no judgment in it at all: it tagged 71% of everything, 65% of
 * main meals and 97% of sauces, and carried exactly the information already
 * in the calories column. A flat line can't mean "light" across dish types
 * whose medians run from 110 (sauce) to 455 (dinner).
 *
 * The tag deliberately does NOT feed ranking — rank.ts scores calories
 * continuously by percentile within the candidate set, which is strictly
 * better because it's relative to what you actually filtered to. This exists
 * for search ("low calorie dessert" should return light desserts) and to give
 * the preference chip something true to say.
 */
export const LOW_CALORIE_P33: Record<string, number> = {
  dinner: 364,
  lunch: 351,
  breakfast: 245,
  dessert: 247,
  snack: 193,
  drink: 180,
  side: 175,
  sauce: 69,
};

export const LOW_CALORIE_DERIVED = {
  on: "2026-08-02",
  /** Corpus rows with calorie data that the percentiles were taken from. */
  sample: 7153,
  corpus: 8462,
} as const;

/**
 * A recipe is light when it sits in the lightest third of dishes of its kind.
 *
 * Multi-type dishes are judged as the largest meal they claim to be: a recipe
 * tagged lunch/dinner gets the dinner line, because that's what it is when
 * you eat it. Using the strictest line instead would demand a dinner come in
 * under a side dish's 175 calories.
 *
 * Two ways to get no tag, both deliberate:
 *   - no calorie data — unknown is not light, and never assume in our favour
 *   - no meal type — we can't say "light for its kind" without knowing kind
 */
export function isLowCalorie(
  calories: number | null,
  mealTypes: string[] | null
): boolean {
  if (calories == null || !(calories > 0)) return false;

  const limits = (mealTypes ?? [])
    .map((t) => LOW_CALORIE_P33[t])
    .filter((n): n is number => n != null);

  if (limits.length === 0) return false;
  return calories <= Math.max(...limits);
}

// ---------------------------------------------------------------------------
// Diet candidates
//
// Keyword scanning only. These are *candidates* for the LLM pass to confirm,
// never final answers: "chicken broth" in an otherwise vegetarian dish trips
// the meat list, fish sauce hides in Thai curries, and almond flour trips the
// gluten list. A false `gluten_free` is worse than a missing one, so nothing
// here writes to diet_tags directly.
// ---------------------------------------------------------------------------

const MEAT = [
  "beef", "pork", "chicken", "turkey", "lamb", "bacon", "ham", "sausage",
  "prosciutto", "pancetta", "chorizo", "veal", "duck", "venison", "gelatin",
  "lard", "meat", "steak", "brisket", "ribs", "salami", "pepperoni", "bresaola",
  "mutton", "poultry", "tallow", "suet",
];

const SEAFOOD = [
  "fish", "salmon", "tuna", "cod", "halibut", "tilapia", "trout", "bass",
  "shrimp", "prawn", "prawns", "crab", "lobster", "scallop", "scallops",
  "clam", "clams", "mussel", "mussels", "oyster", "oysters", "anchovy",
  "anchovies", "sardine", "sardines", "squid", "calamari", "octopus",
  "worcestershire", "bonito", "dashi",
];

const DAIRY = [
  "milk", "cream", "butter", "cheese", "yogurt", "yoghurt", "parmesan",
  "parmigiano", "mozzarella", "cheddar", "feta", "ricotta", "mascarpone",
  "ghee", "buttermilk", "gruyere", "provolone", "gouda", "brie", "halloumi",
  "quark", "creme", "custard",
];

const EGG = ["egg", "eggs", "mayonnaise", "mayo", "aioli", "meringue"];

const GLUTEN = [
  "flour", "wheat", "bread", "breadcrumbs", "breadcrumb", "panko", "pasta",
  "noodle", "noodles", "spaghetti", "macaroni", "penne", "orzo", "couscous",
  "barley", "rye", "farro", "bulgur", "semolina", "seitan", "cracker",
  "crackers", "pastry", "phyllo", "filo", "puff", "biscuit", "croutons",
  "soy sauce", "beer", "malt", "cake", "cookie", "cookies", "tortilla",
];

const HONEY = ["honey", "beeswax", "royal jelly"];

// Word-boundary matching keeps "coconut" and "nutritional yeast" out of this.
// Peanuts are legumes, but they're the allergen people actually mean.
const NUTS = [
  "almond", "almonds", "walnut", "walnuts", "pecan", "pecans", "cashew",
  "cashews", "pistachio", "pistachios", "hazelnut", "hazelnuts", "macadamia",
  "peanut", "peanuts", "pine nut", "pine nuts", "nut butter", "nutella",
  "marzipan", "praline", "almond flour", "almond milk", "almond meal",
  "brazil nut", "chestnut", "chestnuts", "nuts",
];

// Compounds that contain a dairy or gluten word but aren't. Without these the
// vegan signal is worthless on exactly the blogs that publish vegan food —
// coconut milk curries and peanut butter noodles would all be excluded.
const NOT_ACTUALLY_DAIRY = [
  "peanut butter", "almond butter", "cashew butter", "sunflower butter",
  "sunflower seed butter", "seed butter", "nut butter", "apple butter",
  "cocoa butter", "shea butter", "coconut butter", "vegan butter",
  "coconut milk", "almond milk", "oat milk", "soy milk", "rice milk",
  "cashew milk", "hemp milk", "flax milk", "plant milk", "nut milk",
  "coconut cream", "cashew cream", "oat cream", "soy cream",
  "vegan cheese", "vegan cream cheese", "coconut yogurt", "coconut yoghurt",
  "soy yogurt", "almond yogurt", "nutritional yeast", "milk chocolate chips",
  "cream of tartar", "creamy",
];

const NOT_ACTUALLY_GLUTEN = [
  "almond flour", "coconut flour", "rice flour", "chickpea flour",
  "tapioca flour", "cassava flour", "corn flour", "buckwheat flour",
  "gluten free flour", "gluten-free flour", "oat flour", "nut flour",
  "corn tortilla", "corn tortillas", "rice noodles", "glass noodles",
  "sweet potato noodles", "zucchini noodles", "tamari", "coconut aminos",
  "gluten free", "gluten-free", "rice paper", "almond meal",
];

/** Removes phrases that would otherwise trip a keyword list. */
function withoutPhrases(text: string, phrases: string[]): string {
  let out = text;
  for (const phrase of phrases) {
    out = out.replace(
      new RegExp(`\\b${phrase.replace(/\s+/g, "\\s+")}\\b`, "gi"),
      " "
    );
  }
  return out;
}

/** Word-boundary match so "butternut" isn't butter and "eggplant" isn't egg. */
function mentions(haystack: string, terms: string[]): string | null {
  for (const term of terms) {
    const pattern = term.includes(" ")
      ? new RegExp(`\\b${term.replace(/\s+/g, "\\s+")}\\b`, "i")
      : new RegExp(`\\b${term}\\b`, "i");
    if (pattern.test(haystack)) return term;
  }
  return null;
}

export type DietCandidates = {
  vegetarian: boolean;
  vegan: boolean;
  gluten_free: boolean;
  /** What tripped each exclusion — the LLM prompt uses these as hints. */
  hits: { meat?: string; seafood?: string; dairy?: string; egg?: string; gluten?: string; honey?: string };
};

/**
 * Three diet tags are derivable rather than judgment calls, and asking a model
 * to be "conservative" about them produced nonsense: 1,357 vegan recipes but
 * only 99 dairy_free, when every vegan recipe is dairy-free by definition.
 *
 * These are computed here and merged over whatever the LLM pass wrote. The
 * genuinely ambiguous tags — vegetarian, vegan, gluten_free, high_protein —
 * stay the model's call.
 */
export const DERIVED_DIET_TAGS = ["dairy_free", "nut_free", "pescatarian"] as const;

export function deriveDietTags(
  ingredients: Ingredient[],
  mainProtein: string | null,
  llmTags: string[]
): string[] {
  const { hits, vegetarian } = dietCandidates(ingredients);
  const text = ingredients.map((i) => `${i.raw ?? ""} ${i.name ?? ""}`).join(" \n ");

  const derived: string[] = [];
  // Vegan implies dairy-free, so trust the model's vegan call as a floor.
  if (!hits.dairy || llmTags.includes("vegan")) derived.push("dairy_free");
  if (!mentions(text, NUTS)) derived.push("nut_free");
  // Pescatarian = no meat; fish and shellfish are fine.
  if (vegetarian || mainProtein === "fish" || mainProtein === "shellfish") {
    derived.push("pescatarian");
  }

  // Keep the model's tags, but let the derived ones win their own slots.
  const kept = llmTags.filter(
    (t) => !(DERIVED_DIET_TAGS as readonly string[]).includes(t)
  );
  return [...new Set([...kept, ...derived])];
}

// ---------------------------------------------------------------------------
// Protein traces
//
// For *strict* avoidance only. `main_protein` answers "what is this dish built
// around" — the right question for "I'd rather not see beef tonight", and the
// wrong one for "I don't eat pork", where a bacon garnish disqualifies the
// whole dish.
//
// The error costs are asymmetric, so the scanning is deliberately eager:
// wrongly excluding a chicken dish over a splash of broth is a mildly annoying
// missing card, while wrongly including bacon for someone who strictly avoids
// pork is a broken app. Where a term is ambiguous (pepperoni and salami are
// sometimes all beef) it goes in the list anyway.
//
// Computed once at enrichment and stored on the row. A per-request scan would
// mean pulling the ingredients of every candidate on every feed load.
// ---------------------------------------------------------------------------

export const PROTEIN_TRACE_TERMS: Record<string, string[]> = {
  pork: [
    "pork", "bacon", "ham", "prosciutto", "pancetta", "chorizo", "lard",
    "gelatin", "gelatine", "salami", "pepperoni", "speck", "guanciale",
    "sausage", "bratwurst", "andouille",
  ],
  shellfish: [
    "shrimp", "prawn", "prawns", "crab", "lobster", "scallop", "scallops",
    "clam", "clams", "mussel", "mussels", "oyster", "oysters", "crawfish",
    "crayfish", "langoustine", "shellfish",
  ],
  // The hidden ones are the point: fish sauce and worcestershire are what
  // catch people out, not a fillet they can see on the plate.
  fish: [
    "anchovy", "anchovies", "fish sauce", "worcestershire", "nam pla",
    "bonito", "dashi", "fish stock", "fish broth", "salmon", "tuna", "cod",
    "halibut", "tilapia", "trout", "sardine", "sardines", "mackerel",
    "sea bass", "swordfish", "caviar", "roe",
  ],
  chicken: [
    "chicken", "poultry", "chicken broth", "chicken stock", "schmaltz",
  ],
  beef: [
    "beef", "steak", "brisket", "veal", "oxtail", "beef broth", "beef stock",
    "tallow", "suet", "bresaola",
  ],
  eggs: ["egg", "eggs", "mayonnaise", "mayo", "aioli", "meringue", "egg wash"],
  cheese: [
    "cheese", "parmesan", "parmigiano", "mozzarella", "cheddar", "feta",
    "ricotta", "mascarpone", "gruyere", "provolone", "gouda", "brie",
    "halloumi", "queso", "cotija", "pecorino",
  ],
  tofu: ["tofu", "bean curd", "tempeh"],
  // Narrow on purpose — a bare "bean" would catch green beans, vanilla beans
  // and coffee beans, none of which are what someone avoiding beans means.
  beans: [
    "black beans", "pinto beans", "kidney beans", "cannellini", "chickpea",
    "chickpeas", "garbanzo", "navy beans", "butter beans", "refried beans",
    "white beans", "borlotti",
  ],
  lentils: ["lentil", "lentils", "dal", "dahl"],
};

/**
 * Vegan stand-ins named after the thing they replace. Caught in validation:
 * "coconut bacon" in a vegan split pea soup was flagged pork, and a vegan
 * papaya salad's "vegan fish sauce" was flagged fish. Same failure mode as
 * NOT_ACTUALLY_DAIRY, and it lands hardest on exactly the recipes a strict
 * avoider would most want to see.
 *
 * Imitation crab is deliberately absent — surimi is real fish.
 */
const NOT_ACTUALLY_MEAT = [
  "coconut bacon", "vegan bacon", "tempeh bacon", "mushroom bacon",
  "facon", "vegan fish sauce", "vegetarian fish sauce", "vegan sausage",
  "veggie sausage", "vegetarian sausage", "plant-based sausage",
  "vegan chorizo", "soy chorizo", "vegan ham", "vegan pepperoni",
  "vegan worcestershire", "vegetarian worcestershire", "vegan gelatin",
  "agar", "vegan beef", "vegan chicken", "vegetarian chicken",
  "plant-based beef", "plant-based chicken", "meatless", "imitation bacon",
  "bacon bits", "vegetable broth", "vegetable stock", "chicken-style",
  "no-chicken", "not-chicken",
];

/**
 * Which proteins appear anywhere in the ingredients, at any quantity.
 * Stored as `recipes.protein_traces` and used only for strict exclusions.
 */
export function deriveProteinTraces(ingredients: Ingredient[]): string[] {
  const raw = ingredients
    .map((i) => `${i.raw ?? ""} ${i.name ?? ""}`)
    .join(" \n ");
  const text = withoutPhrases(raw, NOT_ACTUALLY_MEAT);
  // Vegan stand-ins shouldn't trip the cheese scan either.
  const cheeseText = withoutPhrases(text, NOT_ACTUALLY_DAIRY);

  const found: string[] = [];
  for (const [protein, terms] of Object.entries(PROTEIN_TRACE_TERMS)) {
    const haystack = protein === "cheese" ? cheeseText : text;
    if (mentions(haystack, terms)) found.push(protein);
  }
  return found;
}

export function dietCandidates(ingredients: Ingredient[]): DietCandidates {
  // `raw` carries the full phrase; `name` alone can drop qualifiers.
  const text = ingredients
    .map((i) => `${i.raw ?? ""} ${i.name ?? ""}`)
    .join(" \n ");

  const dairyText = withoutPhrases(text, NOT_ACTUALLY_DAIRY);
  const glutenText = withoutPhrases(text, NOT_ACTUALLY_GLUTEN);

  const hits = {
    meat: mentions(text, MEAT) ?? undefined,
    seafood: mentions(text, SEAFOOD) ?? undefined,
    dairy: mentions(dairyText, DAIRY) ?? undefined,
    egg: mentions(text, EGG) ?? undefined,
    gluten: mentions(glutenText, GLUTEN) ?? undefined,
    honey: mentions(text, HONEY) ?? undefined,
  };

  const vegetarian = !hits.meat && !hits.seafood;
  const vegan = vegetarian && !hits.dairy && !hits.egg && !hits.honey;
  const gluten_free = !hits.gluten;

  return { vegetarian, vegan, gluten_free, hits };
}
