// Learned taste, built from swipe history. Pure functions over rows already
// fetched — same contract as rank.ts, so it stays testable without a database.
//
// This is the only part of ranking that changes on its own. Preferences are
// what you said you wanted; this is what you actually did.
import type { RankRow } from "./rank";

/**
 * A left swipe is much weaker evidence than a right one.
 *
 * You pass on things for reasons the data can't see — a bad photo, already had
 * it this week, not in the mood — while a save is a deliberate act. The counts
 * make this load-bearing rather than philosophical: 154 lefts against 11 rights
 * at equal weight would bury the saves completely, and the profile would come
 * to mean "not the things I skipped" instead of "more of what I liked".
 *
 * At 0.25 the negative mass still dominates (38.5 vs 11.0), which is correct —
 * there IS more information in the lefts — but the saves stay visible.
 */
export const LEFT_WEIGHT = 0.25;

/**
 * Below this many right swipes, the profile is advisory only: its influence
 * scales up linearly rather than switching on. Eleven saves is enough to notice
 * "meat, not vegetables"; it is not enough to justify a hard commitment, and a
 * profile that arrives at full strength on save number one would lock the feed
 * onto whatever you happened to tap first.
 */
export const CONFIDENCE_AT = 25;

/**
 * Features are scored independently and averaged, rather than multiplied, so
 * one unusual attribute can't veto a card. A recipe doesn't stop being
 * appealing because its cuisine is unfamiliar.
 */
export type TasteProfile = {
  /** Swipes the profile was built from. */
  rights: number;
  lefts: number;
  /** 0..1. Scales the whole profile's influence. See CONFIDENCE_AT. */
  confidence: number;
  /** Per-feature preference, each roughly -1..1. */
  mainProtein: Record<string, number>;
  cuisine: Record<string, number>;
  mealType: Record<string, number>;
  effort: Record<string, number>;
  sourceDomain: Record<string, number>;
  /** True when there's nothing to say yet and the term should stay off. */
  coldStart: boolean;
};

export type SwipeRecord = { recipe_id: string; direction: "left" | "right" };

/** Columns the profile builder needs on top of RANK_COLUMNS. */
export const TASTE_COLUMNS =
  "id, main_protein, cuisine, meal_types, effort, source_domain";

export type TasteRow = {
  id: string;
  main_protein: string | null;
  cuisine: string | null;
  meal_types: string[] | null;
  effort: string | null;
  source_domain: string | null;
};

const EMPTY: TasteProfile = {
  rights: 0,
  lefts: 0,
  confidence: 0,
  mainProtein: {},
  cuisine: {},
  mealType: {},
  effort: {},
  sourceDomain: {},
  coldStart: true,
};

/**
 * Laplace-smoothed save rate, centred on zero.
 *
 * The naive rate — saves / times shown — is wildly overconfident on thin data:
 * one save out of one sighting reads as a perfect 1.0. Adding a pseudo-count
 * pulls sparse features toward the overall average, so a feature needs repeated
 * evidence before it can move a card much. This is the same reason the corpus
 * analysis used percentiles over min–max: one observation shouldn't own a scale.
 */
function score(
  positive: number,
  negative: number,
  baseRate: number,
  smoothing = 3
): number {
  const total = positive + negative;
  if (total === 0) return 0;
  const rate = (positive + smoothing * baseRate) / (total + smoothing);
  // Centre on the base rate so "average" is 0, not "rarely saved".
  return clamp((rate - baseRate) / Math.max(baseRate, 1 - baseRate), -1, 1);
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

/**
 * Builds the profile from swipes joined to the recipes they landed on.
 *
 * Everything here is a frequency count — no model, no embedding. At one user
 * and a few hundred swipes that's not a compromise, it's the right size of
 * tool: it's inspectable, it explains itself, and it can't overfit in ways you
 * can't see in a printout.
 */
export function buildTasteProfile(
  swipes: SwipeRecord[],
  rows: Map<string, TasteRow>
): TasteProfile {
  const rights = swipes.filter((s) => s.direction === "right").length;
  const lefts = swipes.length - rights;

  if (rights === 0) return { ...EMPTY, rights, lefts };

  // Weighted, so a left counts for less than a right everywhere below.
  const positiveMass = rights;
  const negativeMass = lefts * LEFT_WEIGHT;
  const baseRate = positiveMass / Math.max(1e-9, positiveMass + negativeMass);

  const pos: Record<string, Record<string, number>> = {
    mainProtein: {},
    cuisine: {},
    mealType: {},
    effort: {},
    sourceDomain: {},
  };
  const neg: Record<string, Record<string, number>> = {
    mainProtein: {},
    cuisine: {},
    mealType: {},
    effort: {},
    sourceDomain: {},
  };

  for (const swipe of swipes) {
    const row = rows.get(swipe.recipe_id);
    if (!row) continue;
    const bucket = swipe.direction === "right" ? pos : neg;
    const amount = swipe.direction === "right" ? 1 : LEFT_WEIGHT;

    const add = (feature: string, key: string | null | undefined) => {
      if (!key) return;
      bucket[feature][key] = (bucket[feature][key] ?? 0) + amount;
    };

    add("mainProtein", row.main_protein);
    add("cuisine", row.cuisine);
    add("effort", row.effort);
    add("sourceDomain", row.source_domain);
    for (const meal of row.meal_types ?? []) add("mealType", meal);
  }

  const resolve = (feature: string): Record<string, number> => {
    const out: Record<string, number> = {};
    const keys = new Set([
      ...Object.keys(pos[feature]),
      ...Object.keys(neg[feature]),
    ]);
    for (const key of keys) {
      out[key] = score(pos[feature][key] ?? 0, neg[feature][key] ?? 0, baseRate);
    }
    return out;
  };

  return {
    rights,
    lefts,
    confidence: clamp(rights / CONFIDENCE_AT, 0, 1),
    mainProtein: resolve("mainProtein"),
    cuisine: resolve("cuisine"),
    mealType: resolve("mealType"),
    effort: resolve("effort"),
    sourceDomain: resolve("sourceDomain"),
    coldStart: false,
  };
}

/** How much each feature contributes to the learned score. */
export const TASTE_FEATURE_WEIGHTS = {
  /** The clearest signal in the data — 21% save rate on meat vs 2% without. */
  mainProtein: 0.4,
  cuisine: 0.2,
  mealType: 0.2,
  /** Weakest: effort is already a hard filter and a scored term. */
  effort: 0.1,
  /** A proxy for house style. Real, but the crudest of the five. */
  sourceDomain: 0.1,
} as const;

/**
 * Scores one recipe against the profile. Returns -1..1 before weighting, where
 * 0 means "nothing learned about this card" — not "disliked".
 */
export function tasteScore(
  row: RankRow & { source_domain?: string | null },
  profile: TasteProfile
): { raw: number; reasons: string[] } {
  if (profile.coldStart) return { raw: 0, reasons: [] };

  const parts: { value: number; weight: number; label: string }[] = [];

  const push = (
    table: Record<string, number>,
    key: string | null | undefined,
    weight: number,
    label: string
  ) => {
    if (!key) return;
    const value = table[key];
    if (value === undefined) return; // never seen — silent, not negative
    parts.push({ value, weight, label: `${label} ${key}` });
  };

  push(profile.mainProtein, row.main_protein, TASTE_FEATURE_WEIGHTS.mainProtein, "protein");
  push(profile.cuisine, row.cuisine, TASTE_FEATURE_WEIGHTS.cuisine, "cuisine");
  push(profile.effort, row.effort, TASTE_FEATURE_WEIGHTS.effort, "effort");
  push(
    profile.sourceDomain,
    row.source_domain ?? null,
    TASTE_FEATURE_WEIGHTS.sourceDomain,
    "source"
  );

  // Meal types are multi-valued; take the best one rather than the average, so
  // a lunch/dinner recipe is judged as whichever you actually save.
  const mealValues = (row.meal_types ?? [])
    .map((m) => profile.mealType[m])
    .filter((v): v is number => v !== undefined);
  if (mealValues.length) {
    parts.push({
      value: Math.max(...mealValues),
      weight: TASTE_FEATURE_WEIGHTS.mealType,
      label: "meal type",
    });
  }

  if (parts.length === 0) return { raw: 0, reasons: [] };

  // Average over the weights actually present, so a row missing cuisine isn't
  // penalised for the absence — it's judged on what it does have.
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const weighted = parts.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;

  const raw = clamp(weighted * profile.confidence, -1, 1);

  const reasons = parts
    .filter((p) => Math.abs(p.value) > 0.15)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 3)
    .map((p) => `${p.label} ${p.value > 0 ? "+" : ""}${p.value.toFixed(2)}`);

  return { raw, reasons };
}
