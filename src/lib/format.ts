// Display formatting only. Never cleaning — ingredient text is cleaned once,
// at ingest, in the import route.

import type { Ingredient } from "./types";

/** `40` -> `"40 min"`. Null when there's no time to show. */
export function formatMinutes(minutes: number | null): string | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return `${minutes} min`;
}

// Ordered low to high; the importer stores thirds as 0.333/0.667.
const FRACTIONS: ReadonlyArray<readonly [number, string]> = [
  [0.125, "⅛"],
  [0.25, "¼"],
  [0.333, "⅓"],
  [0.375, "⅜"],
  [0.5, "½"],
  [0.625, "⅝"],
  [0.667, "⅔"],
  [0.75, "¾"],
  [0.875, "⅞"],
];

// Tight enough that a literal 0.33 stays "0.33", loose enough that stored
// thirds (0.333) and values drifted by serving-scaling (0.333 * 2 = 0.666)
// still snap to a glyph.
const TOLERANCE = 0.002;

/**
 * `1.75` -> `"1¾"`, `2` -> `"2"`, `0.5` -> `"½"`, `0.4` -> `"0.4"`.
 * Falls back to 2 decimals with trailing zeros dropped.
 */
export function formatQuantity(quantity: number): string {
  if (!Number.isFinite(quantity)) return "";

  // Whole numbers never show a decimal.
  if (Math.abs(quantity - Math.round(quantity)) < TOLERANCE) {
    return String(Math.round(quantity));
  }

  const whole = Math.floor(quantity);
  const fraction = quantity - whole;

  for (const [value, glyph] of FRACTIONS) {
    if (Math.abs(fraction - value) < TOLERANCE) {
      return whole > 0 ? `${whole}${glyph}` : glyph;
    }
  }

  return String(Number(quantity.toFixed(2)));
}

/**
 * The one rule that matters: a null quantity means `raw` is the only
 * trustworthy text ("salt to taste"), so render it verbatim and scale nothing.
 */
export function formatIngredient(ingredient: Ingredient, scale = 1): string {
  if (ingredient.quantity == null) return ingredient.raw;

  return [
    formatQuantity(ingredient.quantity * scale),
    ingredient.unit,
    ingredient.name,
  ]
    .filter((part) => part && part.trim())
    .join(" ");
}
