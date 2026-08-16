/**
 * Deterministic enrichment. Free, no LLM, no network — everything here is
 * derived from data already in the row, so it is safe to re-run at any time.
 *
 *   npx tsx scripts/enrich-deterministic.ts --dry-run
 *   npx tsx scripts/enrich-deterministic.ts
 *   npx tsx scripts/enrich-deterministic.ts --limit=100
 *
 * Writes: effort, protein_grams, calories, protein_source, protein_confidence,
 * and the five_ingredients_or_less concept tag.
 *
 * Deliberately does NOT set enriched_at — that belongs to the LLM pass, which
 * uses it to skip rows.
 *
 * It DOES own three diet tags — dairy_free, nut_free, pescatarian — which are
 * derivable rather than judgment calls, and which the LLM under-tagged badly
 * (99 dairy_free against 1,357 vegan, though vegan implies dairy-free). The
 * ambiguous tags stay the model's: vegetarian, vegan, gluten_free,
 * high_protein. Run this AFTER enrich-llm so main_protein is populated.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseNutrition } from "../src/lib/nutrition";
import {
  deriveEffort,
  isFiveIngredientsOrLess,
  dietCandidates,
  deriveDietTags,
  deriveProteinTraces,
  isLowCalorie,
  LOW_CALORIE_P33,
  LOW_CALORIE_DERIVED,
} from "../src/lib/enrich";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0 && !line.trimStart().startsWith("#")) {
    const key = line.slice(0, i).trim();
    if (!process.env[key]) process.env[key] = line.slice(i + 1).trim();
  }
}

// The project URL lives under either name depending on when .env.local
// was written; it is public either way.
process.env.SUPABASE_URL ||= process.env.NEXT_PUBLIC_SUPABASE_URL!;

const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
const VERBOSE = args.includes("--verbose");

const BATCH = 500;

type Row = {
  id: string;
  title: string;
  total_minutes: number | null;
  servings: number | null;
  ingredients: { quantity: number | null; unit: string | null; name: string; raw: string }[];
  concept_tags: string[] | null;
  meal_types: string[] | null;
  diet_tags: string[] | null;
  main_protein: string | null;
  raw_payload: { jsonld?: { nutrition?: unknown } } | null;
};

async function main() {
  if (DRY_RUN) {
    console.log("DRY RUN — computing only, nothing will be written.\n");
  }

  const stats = {
    scanned: 0,
    updated: 0,
    effort: { quick: 0, moderate: 0, project: 0, unknown: 0 },
    protein: { measured: 0, unknown: 0 },
    fiveIngredients: 0,
    lowCalorie: 0,
    proteinTraces: {} as Record<string, number>,
    caloriesByType: {} as Record<string, number[]>,
    dietCandidates: { vegetarian: 0, vegan: 0, gluten_free: 0 },
    failed: 0,
  };

  let from = 0;
  for (;;) {
    if (stats.scanned >= LIMIT) break;
    const take = Math.min(BATCH, LIMIT - stats.scanned);

    const { data, error } = await db
      .from("recipes")
      .select(
        "id,title,total_minutes,servings,ingredients,concept_tags,meal_types,raw_payload,diet_tags,main_protein"
      )
      .order("created_at", { ascending: true })
      .range(from, from + take - 1);

    if (error) {
      console.error("query failed:", error.message);
      process.exit(1);
    }
    if (!data?.length) break;

    for (const row of data as Row[]) {
      stats.scanned++;

      const ingredients = Array.isArray(row.ingredients) ? row.ingredients : [];
      const effort = deriveEffort(row.total_minutes);
      const nutrition = parseNutrition(
        row.raw_payload?.jsonld?.nutrition,
        row.servings
      );
      const fiveOrLess = isFiveIngredientsOrLess(ingredients);
      const lowCal = isLowCalorie(nutrition.calories, row.meal_types);
      const diet = dietCandidates(ingredients);
      // Strict avoidance only — see deriveProteinTraces.
      const traces = deriveProteinTraces(ingredients);
      // Merge the derivable tags over the LLM's, leaving its judgment calls.
      const dietTags = deriveDietTags(
        ingredients,
        row.main_protein,
        row.diet_tags ?? []
      );

      stats.effort[effort ?? "unknown"]++;
      stats.protein[nutrition.protein_source === "measured" ? "measured" : "unknown"]++;
      if (fiveOrLess) stats.fiveIngredients++;
      if (lowCal) stats.lowCalorie++;
      if (nutrition.calories != null) {
        for (const t of row.meal_types ?? []) {
          (stats.caloriesByType[t] ??= []).push(nutrition.calories);
        }
      }
      if (diet.vegetarian) stats.dietCandidates.vegetarian++;
      if (diet.vegan) stats.dietCandidates.vegan++;
      if (diet.gluten_free) stats.dietCandidates.gluten_free++;
      for (const t of traces)
        stats.proteinTraces[t] = (stats.proteinTraces[t] ?? 0) + 1;

      // Merge rather than replace — the LLM pass owns the other concept tags.
      const existingTags = row.concept_tags ?? [];
      const conceptTags = new Set(existingTags);
      if (fiveOrLess) conceptTags.add("five_ingredients_or_less");
      else conceptTags.delete("five_ingredients_or_less");
      // meal_prep is the LLM's call; low_calorie is arithmetic.
      if (lowCal) conceptTags.add("low_calorie");
      else conceptTags.delete("low_calorie");

      if (VERBOSE || DRY_RUN) {
        console.log(
          `  ${row.title.slice(0, 42).padEnd(44)} ` +
            `${String(effort ?? "—").padEnd(9)} ` +
            `${nutrition.protein_source.padEnd(9)} ` +
            `p=${String(nutrition.protein_grams ?? "—").padEnd(7)}` +
            `cal=${String(nutrition.calories ?? "—").padEnd(8)}` +
            `${fiveOrLess ? "5-ingr " : "       "}` +
            [
              diet.vegetarian ? "veg?" : "",
              diet.vegan ? "vegan?" : "",
              diet.gluten_free ? "gf?" : "",
            ]
              .filter(Boolean)
              .join(" ")
        );
      }

      if (DRY_RUN) continue;

      const { error: updateError } = await db
        .from("recipes")
        .update({
          effort,
          protein_grams: nutrition.protein_grams,
          calories: nutrition.calories,
          protein_source: nutrition.protein_source,
          protein_confidence: nutrition.protein_confidence,
          concept_tags: [...conceptTags],
          diet_tags: dietTags,
          protein_traces: traces,
        })
        .eq("id", row.id);

      if (updateError) {
        stats.failed++;
        console.error(`  update failed for ${row.id}: ${updateError.message}`);
      } else {
        stats.updated++;
      }
    }

    from += data.length;
    if (data.length < take) break;
  }

  const pct = (n: number) =>
    stats.scanned === 0 ? "—" : `${Math.round((n / stats.scanned) * 100)}%`;

  console.log("\n================ SUMMARY ================");
  console.log(`scanned                 ${stats.scanned}`);
  console.log(
    `${DRY_RUN ? "would update" : "updated"}            ${DRY_RUN ? stats.scanned : stats.updated}`
  );
  if (stats.failed) console.log(`failed                  ${stats.failed}`);
  console.log("\neffort");
  console.log(`  quick    (<=30 min)   ${stats.effort.quick}  (${pct(stats.effort.quick)})`);
  console.log(`  moderate (31-60)      ${stats.effort.moderate}  (${pct(stats.effort.moderate)})`);
  console.log(`  project  (>60)        ${stats.effort.project}  (${pct(stats.effort.project)})`);
  console.log(`  unknown (no time)     ${stats.effort.unknown}  (${pct(stats.effort.unknown)})`);
  // The thresholds in enrich.ts are a snapshot. Print what the corpus says
  // *now* next to them, so drift surfaces on every run instead of silently
  // making the tag mean something else.
  // Only a full scan can speak to drift. A --limit run reads rows in crawl
  // order, so its percentiles describe one blog, not the corpus, and flagging
  // "drift" from that would send someone re-deriving against a biased sample.
  const fullScan = LIMIT === Infinity;
  console.log(
    `\nlow_calorie thresholds (p33 per meal type, derived ${LOW_CALORIE_DERIVED.on} ` +
      `from ${LOW_CALORIE_DERIVED.sample} rows)`
  );
  console.log(
    fullScan
      ? "  type        in use   now    drift"
      : `  type        in use   this run (${stats.scanned} rows, crawl order — not a drift signal)`
  );
  for (const [type, inUse] of Object.entries(LOW_CALORIE_P33)) {
    const seen = (stats.caloriesByType[type] ?? []).sort((a, b) => a - b);
    if (!seen.length) {
      console.log(`  ${type.padEnd(10)} ${String(inUse).padStart(6)}      —`);
      continue;
    }
    const now = Math.round(seen[Math.floor(seen.length * 0.33)]);
    const drift = now - inUse;
    const flag =
      fullScan && Math.abs(drift) > inUse * 0.15 ? "  <-- re-derive" : "";
    console.log(
      `  ${type.padEnd(10)} ${String(inUse).padStart(6)} ${String(now).padStart(6)}` +
        (fullScan ? `  ${(drift > 0 ? "+" : "") + drift}${flag}` : "")
    );
  }

  console.log("\nprotein traces (strict-avoidance scan)");
  for (const [k, v] of Object.entries(stats.proteinTraces).sort((a, b) => b[1] - a[1]))
    console.log(`  ${k.padEnd(21)} ${v}  (${pct(v)})`);
  console.log("\nprotein");
  console.log(`  measured              ${stats.protein.measured}  (${pct(stats.protein.measured)})`);
  console.log(`  unknown               ${stats.protein.unknown}  (${pct(stats.protein.unknown)})`);
  console.log("\nconcept tags");
  console.log(`  five_ingredients_or_less  ${stats.fiveIngredients}  (${pct(stats.fiveIngredients)})`);
  console.log(`  low_calorie (p33/type)       ${stats.lowCalorie}  (${pct(stats.lowCalorie)})`);
  console.log("\ndiet CANDIDATES (keyword scan — the LLM pass confirms these)");
  console.log(`  vegetarian?           ${stats.dietCandidates.vegetarian}  (${pct(stats.dietCandidates.vegetarian)})`);
  console.log(`  vegan?                ${stats.dietCandidates.vegan}  (${pct(stats.dietCandidates.vegan)})`);
  console.log(`  gluten_free?          ${stats.dietCandidates.gluten_free}  (${pct(stats.dietCandidates.gluten_free)})`);
  if (DRY_RUN) console.log("\nNothing was written. Drop --dry-run to commit.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
