// Shared shapes for the `recipes` table. Safe to import from client
// components — this file has no runtime dependencies.
import type { ProteinSource } from "./nutrition";

export type { ProteinSource };

export type Ingredient = {
  quantity: number | null;
  unit: string | null;
  name: string;
  raw: string;
};

export type Recipe = {
  id: string;
  user_id: string;
  source_url: string;
  title: string;
  image_url: string | null;
  author: string | null;
  total_minutes: number | null;
  servings: number | null;
  ingredients: Ingredient[];
  steps: string[];
  tags: string[];
  extraction_method: string;
  created_at: string;
  /** true = in the library (hand-saved). false = crawled corpus. */
  saved: boolean;
  /** Set only on cards served by /api/discover — the rank it was shown at. */
  shown_rank?: number | null;
  shown_source?: "ranked" | "explore" | null;
  candidate_count?: number | null;
  source_domain: string | null;
  // Enrichment. Present on corpus rows; null on anything not yet enriched.
  cuisine: string | null;
  meal_types: string[] | null;
  diet_tags: string[] | null;
  concept_tags: string[] | null;
  effort: string | null;
  protein_grams: number | null;
  calories: number | null;
  protein_source: ProteinSource;
};

// Columns the UI actually reads. `raw_payload` and `url_hash` are storage-only,
// so they never travel to the browser.
export const RECIPE_COLUMNS =
  "id, user_id, source_url, title, image_url, author, total_minutes, servings, ingredients, steps, tags, extraction_method, created_at, saved, source_domain, cuisine, meal_types, diet_tags, concept_tags, effort, protein_grams, calories, protein_source";
