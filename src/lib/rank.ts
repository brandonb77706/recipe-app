// Ranking for Discover. Pure functions over already-fetched rows — no network,
// no Supabase — so the whole thing is testable and the API route stays thin.
import type { Answer, Preferences } from "./preferences";
import { hasPreference, isStrict } from "./preferences";
import { PROTEIN_CHIPS, type ChipFilters, type Facets } from "./filters";
import { tasteScore, type TasteProfile } from "./taste";

/**
 * Every weight in one place, because in three weeks the number won't explain
 * itself. Each comment says what raising it costs, not just what it does.
 *
 * A component's raw score is always 0..1, so `weight` is directly comparable:
 * PROTEIN at 1.0 can move a card exactly as far as CUISINE at 0.3 can, three
 * times over. Max achievable total is the sum of the active weights.
 */
export const WEIGHTS = {
  /**
   * The strongest signal, because it's the one backed by a measured number on
   * 63% of the corpus rather than a model's judgment. Raising it past ~1.2
   * makes protein dominate: a bland high-protein bowl outranks a favourite
   * cuisine every time, and the feed turns into a bodybuilding app.
   *
   * Lowered from 1.0 once we established what `measured` actually means: every
   * source site is WordPress running a recipe-card plugin that computes
   * nutrition from ingredient text. 100% of rows declare a servingSize and 82%
   * carry a full macro set including trans fat — nobody hand-enters that. It's
   * someone else's calculator, not an observation, and a third of the corpus
   * has none at all. Soft data shouldn't be the largest term in the ranking.
   */
  PROTEIN: 0.7,

  /**
   * Below protein deliberately. Calorie data covers more rows (85%) but is a
   * weaker statement of intent — "lower calorie" is a constraint people accept,
   * "high protein" is a thing they seek. Equalizing the two double-counts the
   * same nutritional axis and buries anything rich regardless of cuisine.
   * Lowered from 0.8 alongside PROTEIN, for the same provenance reason.
   */
  CALORIE: 0.5,

  /**
   * meal_prep and five_ingredients_or_less. Mid-weight because these are binary
   * LLM judgments — real signal, but a wrong tag shouldn't outrank measured
   * nutrition. Above ~0.8 the 2,302 meal_prep rows crowd out everything else.
   */
  CONCEPT: 0.6,

  /**
   * Intentionally small. Cuisine is a taste, not a need, and the corpus is 60%
   * american — a heavy cuisine weight would collapse the feed onto one bucket
   * and starve discovery. Low enough that a great non-favourite still surfaces.
   */
  CUISINE: 0.3,

  /**
   * "Is this an answer to what should I cook tonight." Weighted above cuisine
   * because it fixes a failure the other terms can't see: with no preferences
   * set, the corpus's 321 sauces, 506 drinks and 1,126 sides won the feed
   * outright — the first cold-start cards were dill pickles, burger seasoning
   * and homemade ketchup, all of which are fast, keep well, and are not
   * dinner. A boost rather than a filter, so a great sauce can still appear;
   * lowering it toward 0.3 lets condiments back into the top ten.
   */
  MAIN_DISH: 0.7,

  /**
   * Learned from swipe history — the only weight here that reflects what you
   * did rather than what you said.
   *
   * Capped just under PROTEIN on purpose. High enough to fix a feed that's
   * showing the wrong food, low enough that it can never fully close: a card
   * with a strong protein and calorie score still surfaces even when its
   * cuisine and source are ones you've passed on. Raising it past ~1.2 lets a
   * small number of saves lock the feed onto their incidental features, which
   * with 11 examples would be overfitting, not learning.
   *
   * The term also scales itself down by profile confidence, so it starts near
   * zero and grows with evidence rather than switching on at a threshold.
   */
  TASTE: 0.9,

  /**
   * A tiebreak, nothing more. max_minutes already hard-filters; this just
   * prefers 20 minutes over 45 among survivors. Any higher and it fights the
   * nutrition terms, pushing the feed toward fast-but-uninteresting food.
   */
  EFFORT: 0.15,
} as const;

/**
 * How much each meal type reads as "dinner". Sides and desserts are real
 * things to cook, just not answers to the question Discover is asking, so they
 * score low rather than zero. An untagged row gets the benefit of the doubt —
 * a missing meal_types is an enrichment gap, not evidence of a condiment.
 */
const DISH_SCORE: Record<string, number> = {
  dinner: 1,
  lunch: 1,
  breakfast: 0.9,
  snack: 0.35,
  dessert: 0.35,
  side: 0.25,
  sauce: 0,
  drink: 0,
};
const UNTAGGED_DISH_SCORE = 0.6;

/**
 * Multiplier on a value's raw score when the number was inferred rather than
 * read off the page.
 *
 * Currently unreachable, and deliberately kept. LLM nutrition estimation was
 * built, tested and removed on 2026-08-04: estimating calories from an
 * ingredient list means guessing at marinade absorption, rendered fat and what
 * "1 large onion" weighs, and no prompt clears that. Tuning until a sample of
 * 8 passed would have been fitting to the sample.
 *
 * The enum value and this discount stay so the distinction survives if a
 * trustworthy source of estimates ever appears. Nothing writes 'estimated'
 * today — verified 0 rows corpus-wide.
 */
export const ESTIMATED_DISCOUNT = 0.7;

/**
 * Raw score for a recipe with no measured number but a positive LLM tag. Sits
 * mid-range on purpose: below every measured row that actually clears the bar,
 * above every row with no evidence at all. Raising it toward 1.0 lets a binary
 * guess beat a measurement, which is the thing we set out not to do.
 */
export const TAG_FALLBACK = 0.5;

/**
 * Weight multiplier for a question the user never answered (`null`), scored
 * against a population default instead of a stated preference.
 *
 *   null  — never asked. Assume the popular answer, quietly, at 40% weight.
 *   []    — asked, answered "no preference". Contribute exactly nothing.
 *
 * That difference is the whole point of the tri-state: "surprise me" should
 * genuinely surprise, while "we haven't asked yet" shouldn't serve a stranger
 * something bizarre on card one.
 */
export const COLD_START = 0.4;

/** The corpus's own centre of gravity — the default when we've never asked. */
const COLD_START_CUISINES: readonly string[] = [
  "american",
  "italian",
  "mexican",
  "mediterranean",
];
const COLD_START_CONCEPTS: readonly string[] = ["meal_prep"];

/** Every 5th card ignores the ranking entirely. See buildFeed. */
export const EXPLORE_EVERY = 5;

/**
 * Calories below this are a condiment, not a meal, and shouldn't win the
 * "lower calorie" term by default.
 *
 * Measured, not guessed: of the 972 corpus rows under 150 calories, 887 (91%)
 * are sauces, drinks, snacks or desserts. Pure minimization ranks an enchilada
 * sauce above every actual dinner — technically the lowest-calorie thing in
 * the set, and useless as a suggestion. Scores taper linearly below this line
 * rather than cutting off, so a genuine 200-calorie light lunch still competes.
 */
export const CALORIE_MEAL_FLOOR = 250;

/** Concepts the continuous terms own; they must not be double-counted as tags. */
const CONTINUOUS_CONCEPTS: readonly string[] = ["high_protein", "low_calorie"];

// ---------------------------------------------------------------------------

/** The columns scoring needs. Deliberately excludes ingredients/steps/payload
 *  so the candidate sweep can pull thousands of rows cheaply. */
export const RANK_COLUMNS =
  "id, total_minutes, cuisine, meal_types, diet_tags, concept_tags, effort, protein_grams, calories, protein_source, main_protein, source_domain";

export type RankRow = {
  id: string;
  total_minutes: number | null;
  cuisine: string | null;
  meal_types: string[] | null;
  diet_tags: string[] | null;
  concept_tags: string[] | null;
  effort: string | null;
  protein_grams: number | null;
  calories: number | null;
  /*
   * protein_source is deliberately ABSENT from this type.
   *
   * It was dropped from RANK_COLUMNS to cut egress, so it is never fetched.
   * Declaring it — even as `?: never` — does not help: `never` is the bottom
   * type, so TypeScript happily compares it to a string and the read silently
   * yields undefined. Verified, not assumed. Leaving the property out entirely
   * is what makes `row.protein_source` a compile error (TS2339).
   *
   * If a trustworthy estimate source ever appears: add the column back to
   * RANK_COLUMNS, add the field here, and reinstate the discount in
   * proteinComponent — all three in the same commit. The runtime assert there
   * exists to catch anyone who does one and forgets the others.
   */
  main_protein: string | null;
  /** Every protein appearing anywhere in the ingredients. Strict use only. */
  protein_traces: string[] | null;
  /** A crude proxy for house style, used only by the learned taste term. */
  source_domain: string | null;
  saved: boolean;
};

export type Component = {
  name: "protein" | "calorie" | "concept" | "cuisine" | "dish" | "taste" | "effort";
  /** 0..1 before weighting. null when the term is inactive for this user. */
  raw: number | null;
  weight: number;
  points: number;
  /** Plain-language reason. This is what makes a baffling card explainable. */
  note: string;
};

export type Scored = {
  id: string;
  total: number;
  components: Component[];
  /** True when the card was drawn from outside the top set. */
  exploration: boolean;
};

// --- seedable RNG ----------------------------------------------------------

/**
 * mulberry32. Small, fast, and — the only property that matters here —
 * reproducible: the same seed always yields the same feed, so exploration
 * behaviour can be asserted in a test instead of eyeballed.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- hard filters ----------------------------------------------------------

/**
 * The only places a wrong answer is unacceptable. Everything else is a boost,
 * so the feed can run short but never empty.
 *
 * Note that `null` and `[]` collapse here: "no dietary needs" and "never asked
 * about dietary needs" both mean don't filter. That's unavoidable — you can't
 * enforce a restriction you don't know about — and it's the one axis where the
 * tri-state genuinely has only two outcomes.
 */
export function passesHardFilters(
  row: RankRow,
  prefs: Preferences | null,
  swiped: ReadonlySet<string>
): boolean {
  if (row.saved) return false; // library rows are not discoverable
  if (swiped.has(row.id)) return false;
  return passesPreferenceFilters(row, prefs);
}

/**
 * The preference half on its own, without the corpus-only checks.
 *
 * Search needs this: library search must not apply dietary filters to recipes
 * I deliberately saved, and it must not exclude `saved = true` rows the way
 * Discover does.
 */
export function passesPreferenceFilters(
  row: RankRow,
  prefs: Preferences | null
): boolean {
  if (!prefs) return true;

  if (prefs.max_minutes != null) {
    // Unknown time fails a time cap. We can't promise 30 minutes on a recipe
    // that never said, and a broken promise costs more than a missed card.
    if (row.total_minutes == null) return false;
    if (row.total_minutes > prefs.max_minutes) return false;
  }

  const diets = prefs.diets as Answer<string>;
  if (hasPreference(diets)) {
    const tags = row.diet_tags ?? [];
    if (!diets.every((d) => tags.includes(d))) return false;
  }

  const avoid = prefs.avoid_proteins;
  if (hasPreference(avoid)) {
    for (const protein of avoid) {
      if (isStrict(protein, prefs.strict_proteins)) {
        // Strict: a trace anywhere disqualifies the dish. Validated against
        // 1,200 corpus rows — 46% of pork traces and 61% of fish traces sit in
        // recipes whose main_protein is something else entirely (prosciutto on
        // a caprese, fish sauce in a noodle salad, worcestershire in a
        // dressing). main_protein alone would have served every one of them.
        if ((row.protein_traces ?? []).includes(protein)) return false;
      } else if (row.main_protein === protein) {
        // Preference: only what the dish is built around. A splash of beef
        // broth in a chicken recipe isn't worth losing the card over.
        return false;
      }
    }
  }

  return true;
}

/**
 * Session filter chips, applied after preferences and before scoring.
 *
 * Kept separate from passesHardFilters because these aren't preferences —
 * they're a temporary narrowing you clear when you're done. Narrowing before
 * ranking (rather than filtering the ranked output) means the survivors stay
 * ordered by taste score instead of becoming an arbitrary list.
 */
export function passesChips(row: RankRow, chips: ChipFilters): boolean {
  if (chips.maxTime != null) {
    // Unknown time is excluded, same principle as the library sort: unknown
    // isn't fast, and we can't promise 20 minutes on a recipe that never said.
    if (row.total_minutes == null) return false;
    if (row.total_minutes > chips.maxTime) return false;
  }

  // Within a group: OR. Across groups: AND.
  if (chips.mealTypes.length) {
    const types = row.meal_types ?? [];
    if (!chips.mealTypes.some((m) => types.includes(m))) return false;
  }

  if (chips.proteins.length) {
    if (!chips.proteins.some((p) => matchesProtein(row, p))) return false;
  }

  if (chips.concepts.length) {
    const tags = row.concept_tags ?? [];
    if (!chips.concepts.some((c) => tags.includes(c))) return false;
  }

  return true;
}

/** `vegetarian` is a diet tag; everything else is main_protein. */
function matchesProtein(row: RankRow, chip: string): boolean {
  const def = PROTEIN_CHIPS.find((p) => p.value === chip);
  if (!def) return false;
  if (def.field === "diet_tags") return (row.diet_tags ?? []).includes(chip);
  return row.main_protein === chip;
}

/**
 * Per-chip counts over the eligible pool, before any chip is applied, so the
 * numbers don't shift under you as you tap and a thin option is visible in
 * advance rather than after it returns nothing.
 */
export function computeFacets(rows: RankRow[], chips: ChipFilters): Facets {
  const mealTypes: Record<string, number> = {};
  const proteins: Record<string, number> = {};
  const concepts: Record<string, number> = {};
  const time: Record<string, number> = {};

  for (const row of rows) {
    for (const m of row.meal_types ?? []) mealTypes[m] = (mealTypes[m] ?? 0) + 1;
    for (const c of row.concept_tags ?? []) concepts[c] = (concepts[c] ?? 0) + 1;
    for (const p of PROTEIN_CHIPS) {
      if (matchesProtein(row, p.value)) proteins[p.value] = (proteins[p.value] ?? 0) + 1;
    }
    if (row.total_minutes != null) {
      for (const t of [20, 30, 45]) {
        if (row.total_minutes <= t) time[String(t)] = (time[String(t)] ?? 0) + 1;
      }
    }
  }

  // What an active time chip is costing you purely for missing data.
  const hiddenNoTime =
    chips.maxTime == null
      ? 0
      : rows.filter((r) => r.total_minutes == null).length;

  return { mealTypes, proteins, concepts, time, hiddenNoTime };
}

// --- scoring ---------------------------------------------------------------

/**
 * A value's position within the candidate set, 0..1.
 *
 * Percentile rank, not min–max, and the corpus is why: protein runs p90=29g,
 * p99=56g, max=117g — that top 1% is source-data garbage (nobody eats 117g of
 * protein in one serving), and under min–max a single bad row squashes every
 * honest recipe into the bottom third. A genuinely excellent 30g dinner scored
 * 0.28. Percentile rank asks "how many candidates did this beat", which no
 * outlier can distort.
 */
type Distribution = {
  /** Ascending, nulls dropped. */
  sorted: number[];
  count: number;
  min: number;
  max: number;
};

function distributionOf(
  rows: RankRow[],
  pick: (r: RankRow) => number | null
): Distribution {
  const sorted: number[] = [];
  for (const r of rows) {
    const v = pick(r);
    if (v == null || !Number.isFinite(v)) continue;
    sorted.push(v);
  }
  sorted.sort((a, b) => a - b);
  return {
    sorted,
    count: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** First index whose value is >= target. */
function lowerBound(sorted: number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is > target. */
function upperBound(sorted: number[], target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Midrank percentile: ties all land on the same score instead of one of them
 * arbitrarily beating its identical twin. An empty or single-valued set scores
 * neutral rather than 0 or 1, which would be a claim the data can't support.
 */
function percentile(value: number, dist: Distribution): number {
  if (dist.count === 0) return 0.5;
  if (dist.min === dist.max) return 0.5;
  const below = lowerBound(dist.sorted, value);
  const atOrBelow = upperBound(dist.sorted, value);
  return (below + atOrBelow) / 2 / dist.count;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Scores every candidate against the set it belongs to.
 *
 * Normalization is deliberately *within* `candidates`, not against the corpus:
 * if you've filtered to 20-minute vegetarian, 20g of protein is the top of that
 * world and should score like it. Against the global max (a 90g steak) every
 * survivor would look mediocre and the protein term would go flat, which is the
 * opposite of useful.
 */
export function scoreCandidates(
  candidates: RankRow[],
  prefs: Preferences | null,
  /** Learned profile. Omit for the stated-preferences-only ranking. */
  taste: TasteProfile | null = null
): Scored[] {
  const proteinDist = distributionOf(candidates, (r) => r.protein_grams);
  const calorieDist = distributionOf(candidates, (r) => r.calories);
  const timeDist = distributionOf(candidates, (r) => r.total_minutes);

  const wantsProtein = prefs?.prefer_high_protein === true;
  const conceptAnswer = (prefs?.prefer_concepts ?? null) as Answer<string>;
  const wantsLowCalorie = hasPreference(conceptAnswer)
    ? conceptAnswer.includes("low_calorie")
    : false;

  // high_protein and low_calorie are scored continuously above; only the
  // genuinely tag-shaped concepts are left for the CONCEPT term.
  const tagConcepts = hasPreference(conceptAnswer)
    ? conceptAnswer.filter((c) => !CONTINUOUS_CONCEPTS.includes(c))
    : [];
  const conceptsUnanswered = conceptAnswer === null;

  const cuisineAnswer = (prefs?.favorite_cuisines ?? null) as Answer<string>;
  const cuisinesUnanswered = cuisineAnswer === null;

  return candidates.map((row) => {
    const components: Component[] = [
      proteinComponent(row, proteinDist, wantsProtein),
      calorieComponent(row, calorieDist, wantsLowCalorie),
      conceptComponent(row, tagConcepts, conceptsUnanswered),
      cuisineComponent(row, cuisineAnswer, cuisinesUnanswered),
      tasteComponent(row, taste),
      dishComponent(row),
      effortComponent(row, timeDist),
    ];

    const total = round(components.reduce((sum, c) => sum + c.points, 0));
    return { id: row.id, total, components, exploration: false };
  });
}

function inactive(name: Component["name"], note: string): Component {
  return { name, raw: null, weight: 0, points: 0, note };
}

function proteinComponent(
  row: RankRow,
  dist: Distribution,
  wanted: boolean
): Component {
  if (!wanted)
    return inactive("protein", "not requested — no protein preference set");

  if (row.protein_grams != null) {
    // Loud, not silent. protein_source is no longer fetched, so the discount
    // below cannot fire. If a row ever carries 'estimated' again, the ranking
    // would quietly score an inferred number as if it were measured — the
    // exact class of bug that gets found six months later as "the ranking
    // feels slightly off". Throwing here forces the two to be fixed together.
    const source = (row as { protein_source?: string }).protein_source;
    if (source === "estimated") {
      throw new Error(
        "rank.ts: protein_source='estimated' found, but ESTIMATED_DISCOUNT is " +
          "unreachable because protein_source was dropped from RANK_COLUMNS. " +
          "Restore the column AND reinstate the discount in proteinComponent."
      );
    }

    const p = percentile(row.protein_grams, dist);
    const estimated = false;
    const raw = estimated ? p * ESTIMATED_DISCOUNT : p;
    const points = round(raw * WEIGHTS.PROTEIN);
    return {
      name: "protein",
      raw: round(raw),
      weight: WEIGHTS.PROTEIN,
      points,
      note: `${row.protein_grams}g ${
        estimated ? "estimated" : "measured"
      } — beats ${Math.round(p * 100)}% of the ${dist.count} candidates with a number${
        estimated ? ` (×${ESTIMATED_DISCOUNT} estimated discount)` : ""
      }`,
    };
  }

  const tagged = (row.diet_tags ?? []).includes("high_protein");
  const raw = tagged ? TAG_FALLBACK : 0;
  return {
    name: "protein",
    raw,
    weight: WEIGHTS.PROTEIN,
    points: round(raw * WEIGHTS.PROTEIN),
    note: tagged
      ? `no measured protein — high_protein tag, scored at the ${TAG_FALLBACK} fallback`
      : "no measured protein and no high_protein tag — no evidence, no boost",
  };
}

function calorieComponent(
  row: RankRow,
  dist: Distribution,
  wanted: boolean
): Component {
  if (!wanted)
    return inactive("calorie", "not requested — no calorie preference set");

  if (row.calories == null) {
    // No tag fallback exists here: low_calorie is *derived* from calories, so
    // a row without calories can never carry the tag. Unknown means unknown.
    return {
      name: "calorie",
      raw: 0,
      weight: WEIGHTS.CALORIE,
      points: 0,
      note: "no calorie data — nothing to score, no boost",
    };
  }

  const lowness = 1 - percentile(row.calories, dist); // lower is better

  // Then walk it back for anything too small to be dinner. Without this the
  // term is won permanently by sauces and drinks, which are the lowest-calorie
  // rows in any candidate set and never the answer to "what should I cook".
  const mealFactor =
    row.calories >= CALORIE_MEAL_FLOOR ? 1 : row.calories / CALORIE_MEAL_FLOOR;
  const raw = lowness * mealFactor;

  return {
    name: "calorie",
    raw: round(raw),
    weight: WEIGHTS.CALORIE,
    points: round(raw * WEIGHTS.CALORIE),
    note:
      `${row.calories} cal — lower than ${Math.round(lowness * 100)}% of ${
        dist.count
      } candidates` +
      (mealFactor < 1
        ? `, scaled ×${round(mealFactor)} for sitting under the ${CALORIE_MEAL_FLOOR}-cal meal floor`
        : ""),
  };
}

function conceptComponent(
  row: RankRow,
  wanted: string[],
  unanswered: boolean
): Component {
  const tags = row.concept_tags ?? [];

  if (wanted.length === 0 && !unanswered)
    return inactive("concept", "answered “nothing in particular” — term off");

  const target = wanted.length ? wanted : COLD_START_CONCEPTS;
  const weight = wanted.length
    ? WEIGHTS.CONCEPT
    : round(WEIGHTS.CONCEPT * COLD_START);

  const hit = target.filter((c) => tags.includes(c));
  const raw = hit.length / target.length;

  return {
    name: "concept",
    raw: round(raw),
    weight,
    points: round(raw * weight),
    note: wanted.length
      ? `${hit.length}/${target.length} of ${target.join(", ")}`
      : `never asked — cold-start prior on ${target.join(", ")} at ${COLD_START}× weight`,
  };
}

function cuisineComponent(
  row: RankRow,
  answer: Answer<string>,
  unanswered: boolean
): Component {
  if (!hasPreference(answer) && !unanswered)
    return inactive("cuisine", "answered “surprise me” — term off");

  const target = hasPreference(answer) ? answer : COLD_START_CUISINES;
  const weight = hasPreference(answer)
    ? WEIGHTS.CUISINE
    : round(WEIGHTS.CUISINE * COLD_START);

  const match = row.cuisine != null && target.includes(row.cuisine);
  const raw = match ? 1 : 0;

  return {
    name: "cuisine",
    raw,
    weight,
    points: round(raw * weight),
    note: hasPreference(answer)
      ? match
        ? `${row.cuisine} is a favourite`
        : `${row.cuisine ?? "unknown"} is not among ${target.join(", ")}`
      : `never asked — cold-start prior, ${row.cuisine ?? "unknown"} ${
          match ? "is" : "is not"
        } a popular cuisine`,
  };
}

function dishComponent(row: RankRow): Component {
  const types = row.meal_types ?? [];
  if (types.length === 0) {
    return {
      name: "dish",
      raw: UNTAGGED_DISH_SCORE,
      weight: WEIGHTS.MAIN_DISH,
      points: round(UNTAGGED_DISH_SCORE * WEIGHTS.MAIN_DISH),
      note: "no meal type recorded — scored neutral rather than assumed a side",
    };
  }

  // Best of its types: a dish tagged lunch+snack is a lunch you can also snack
  // on, not a snack. Taking the max keeps multi-tagged mains where they belong.
  const raw = Math.max(...types.map((t) => DISH_SCORE[t] ?? UNTAGGED_DISH_SCORE));
  return {
    name: "dish",
    raw: round(raw),
    weight: WEIGHTS.MAIN_DISH,
    points: round(raw * WEIGHTS.MAIN_DISH),
    note: `${types.join("/")} — scores ${round(raw)} as a thing to cook for a meal`,
  };
}

function tasteComponent(row: RankRow, taste: TasteProfile | null): Component {
  if (!taste || taste.coldStart) {
    return inactive(
      "taste",
      "no swipe history yet — nothing learned to apply"
    );
  }

  const { raw, reasons } = tasteScore(row, taste);

  // Shift -1..1 into 0..1 so this term can't produce a negative total and
  // reorder the whole feed by sign. A disliked card scores 0 here, not below
  // zero — it loses the boost rather than being pushed under everything.
  const normalized = (raw + 1) / 2;

  return {
    name: "taste",
    raw: round(normalized),
    weight: WEIGHTS.TASTE,
    points: round(normalized * WEIGHTS.TASTE),
    note: reasons.length
      ? `learned from ${taste.rights} saves / ${taste.lefts} passes (confidence ${round(taste.confidence)}): ${reasons.join(", ")}`
      : `learned profile has nothing on this card — scored neutral`,
  };
}

function effortComponent(row: RankRow, dist: Distribution): Component {
  if (row.total_minutes == null) {
    // Neutral, not zero: unknown time is an extraction gap, and systematically
    // burying those rows would silently shrink the corpus by a few hundred.
    return {
      name: "effort",
      raw: 0.5,
      weight: WEIGHTS.EFFORT,
      points: round(0.5 * WEIGHTS.EFFORT),
      note: "unknown time — scored neutral rather than penalised",
    };
  }

  const raw = 1 - percentile(row.total_minutes, dist); // faster is better
  return {
    name: "effort",
    raw: round(raw),
    weight: WEIGHTS.EFFORT,
    points: round(raw * WEIGHTS.EFFORT),
    note: `${row.total_minutes} min — faster than ${Math.round(raw * 100)}% of ${
      dist.count
    } candidates`,
  };
}

// --- feed assembly ---------------------------------------------------------

/**
 * Sorts by score, then hands every EXPLORE_EVERY-th slot to a random card from
 * outside the top set.
 *
 * Without this the feed is a fixed point: preferences pick a corner of the
 * corpus, swipes confirm it, and nothing new ever appears. The explore slots
 * are the only way the ranking learns it was wrong.
 *
 * `rng` defaults to Math.random in production and takes a seeded generator in
 * tests, so "every 5th card is an explore pick" is an assertion, not a vibe.
 */
export function buildFeed(
  scored: Scored[],
  limit: number,
  rng: () => number = Math.random,
  /** How far down the ranking to start. Paging through Discover, not a filter. */
  offset = 0
): Scored[] {
  const all = [...scored].sort((a, b) => b.total - a.total || (a.id < b.id ? -1 : 1));
  const ranked = offset > 0 ? all.slice(offset) : all;
  if (ranked.length <= limit) return ranked.slice(0, limit);

  // Anything the user wouldn't have seen anyway is fair game to explore into.
  const pool = ranked.slice(limit);
  const used = new Set<number>();
  const feed: Scored[] = [];
  let top = 0;

  for (let i = 0; i < limit; i++) {
    const isExplore = pool.length > used.size && (i + 1) % EXPLORE_EVERY === 0;

    if (isExplore) {
      let idx = Math.floor(rng() * pool.length);
      // Linear probe keeps the draw uniform-ish without an unbounded retry loop.
      for (let tries = 0; used.has(idx) && tries < pool.length; tries++)
        idx = (idx + 1) % pool.length;
      used.add(idx);
      feed.push({ ...pool[idx], exploration: true });
      continue;
    }

    feed.push(ranked[top++]);
  }

  return feed;
}
