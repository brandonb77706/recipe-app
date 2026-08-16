/**
 * Generates the simple meal-prep staples that recipe blogs don't cover well —
 * protein + starch combinations you cook on repeat and don't need a story for.
 *
 *   npx tsx scripts/generate-staples.ts --dry-run     # print, write nothing
 *   npx tsx scripts/generate-staples.ts               # commit
 *   npx tsx scripts/generate-staples.ts --only=chicken-rice-bowl
 *
 * These are AI-written and have not been cooked by anyone, so they are marked
 * as such everywhere: extraction_method 'llm_generated', a synthetic
 * source_url, and protein_source 'estimated'/'low' — never 'measured'.
 *
 * Re-runnable: a staple already stored is skipped, same as the crawler.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { parseIngredient } from "../src/lib/extract";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split("\n")) {
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
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ---------------------------------------------------------------------------
// The list. Edit freely — one line per staple, nothing else to change.
// ---------------------------------------------------------------------------

type Staple = { slug: string; brief: string };

const STAPLES: Staple[] = [
  { slug: "chicken-rice-bowl", brief: "Chicken and rice meal prep bowl, stovetop" },
  { slug: "beef-rice-bowl", brief: "Ground beef and rice meal prep bowl, skillet" },
  { slug: "air-fryer-chicken-thighs", brief: "Air fryer boneless chicken thighs, seasoned simply" },
  { slug: "air-fryer-chicken-breast", brief: "Air fryer chicken breast, juicy not dry" },
  { slug: "air-fryer-potatoes", brief: "Air fryer diced potatoes, crispy" },
  { slug: "air-fryer-sweet-potatoes", brief: "Air fryer sweet potato cubes" },
  { slug: "chicken-potatoes-sheet-pan", brief: "Sheet pan chicken and potatoes, one tray" },
  { slug: "chicken-quesadilla", brief: "Chicken quesadilla, skillet, for one or two" },
  { slug: "beef-quesadilla", brief: "Ground beef quesadilla, skillet" },
  { slug: "stovetop-white-rice", brief: "Plain stovetop white rice, reliable ratio" },
  { slug: "ground-turkey-sweet-potato", brief: "Ground turkey and sweet potato skillet" },
  { slug: "black-beans-rice", brief: "Black beans and rice, pantry staple, vegetarian" },
  { slug: "hard-boiled-eggs", brief: "Hard boiled eggs for the week, easy peel" },
  { slug: "roasted-broccoli", brief: "Oven roasted broccoli, simple side" },
  { slug: "scrambled-eggs", brief: "Soft scrambled eggs" },
  { slug: "chicken-fried-rice", brief: "Chicken fried rice using leftover rice" },
];

const MY_USER_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "claude-opus-5";

// Claude 5 models reject assistant-message prefill (the trick the import route
// uses with Haiku), so the JSON shape is enforced with a schema instead. Note
// the schema language is restricted: every object needs additionalProperties
// false, nullable fields use anyOf, and min/max constraints aren't supported —
// the plausibility bounds live in validate() below.
const nullable = (type: string) => ({ anyOf: [{ type }, { type: "null" }] });

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    total_minutes: { type: "integer" },
    servings: { type: "integer" },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          quantity: nullable("number"),
          unit: nullable("string"),
          name: { type: "string" },
          raw: { type: "string" },
        },
        required: ["quantity", "unit", "name", "raw"],
        additionalProperties: false,
      },
    },
    steps: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    protein_grams: nullable("number"),
    calories: nullable("number"),
  },
  required: [
    "title",
    "total_minutes",
    "servings",
    "ingredients",
    "steps",
    "tags",
    "protein_grams",
    "calories",
  ],
  additionalProperties: false,
} as const;

// Cooking a protein to time alone is a guess; these are the temperatures that
// actually matter, and the prompt is required to state them.
const TEMP_REQUIRED = /\b(chicken|turkey|poultry|pork|beef|steak|fish|salmon|shrimp)\b/i;
const TEMP_MENTIONED = /\b\d{2,3}\s*°?\s*(f|c)\b|\bdegrees\b/i;

const SYSTEM = `You write simple, reliable meal-prep recipes — the kind someone
cooks on repeat and does not need a story for.

Output ONLY a JSON object, no prose, no markdown fences:
{
  "title": string,
  "total_minutes": number,
  "servings": number,
  "ingredients": [{"quantity": number|null, "unit": string|null, "name": string, "raw": string}],
  "steps": [string],
  "tags": [string],
  "protein_grams": number|null,
  "calories": number|null
}

Rules:
- Keep it genuinely simple: 3 to 9 ingredients, 3 to 6 steps. No garnishes, no
  sub-recipes, no specialty equipment beyond an air fryer, skillet, or oven.
- "raw" is the ingredient as a person would write it on a list, e.g.
  "1 lb boneless chicken thighs". "quantity" is a number or null; use null for
  things like "salt to taste" and repeat the phrase verbatim in "raw".
- Pantry staples (salt, pepper, oil) are fine as null-quantity ingredients.
- FOOD SAFETY, non-negotiable: for any poultry, pork, beef, or seafood, the
  steps MUST state the target internal temperature (chicken and turkey 165°F,
  ground beef 160°F, whole-cut beef and pork 145°F, fish 145°F) and instruct
  the cook to check it. Air fryer and oven times vary by model, so give times
  as approximate and make the temperature the real doneness test.
- protein_grams and calories are per serving, your best estimate. Use null if
  you genuinely cannot estimate. These are estimates, not measurements.
- tags: meal type and cuisine if obvious. Keep to a few.`;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const only = args.find((a) => a.startsWith("--only="))?.split("=")[1];

type Generated = {
  title: string;
  total_minutes: number | null;
  servings: number | null;
  ingredients: { quantity: number | null; unit: string | null; name: string; raw: string }[];
  steps: string[];
  tags: string[];
  protein_grams: number | null;
  calories: number | null;
};

/** Rejects anything that fails the shape or the safety rule. */
function validate(r: Generated, brief: string): string | null {
  if (!r.title?.trim()) return "no title";
  if (!Array.isArray(r.ingredients) || r.ingredients.length < 3)
    return `too few ingredients (${r.ingredients?.length ?? 0})`;
  if (r.ingredients.length > 12) return `too many ingredients (${r.ingredients.length})`;
  if (!Array.isArray(r.steps) || r.steps.length < 3)
    return `too few steps (${r.steps?.length ?? 0})`;
  if (r.steps.length > 8) return `too many steps (${r.steps.length})`;
  if (!r.servings || r.servings < 1) return "no servings";
  if (!r.total_minutes || r.total_minutes < 1) return "no total_minutes";

  const text = `${brief} ${r.title} ${r.ingredients.map((i) => i.raw).join(" ")}`;
  if (TEMP_REQUIRED.test(text) && !TEMP_MENTIONED.test(r.steps.join(" "))) {
    return "protein recipe with no internal temperature in the steps";
  }
  if (r.protein_grams != null && (r.protein_grams < 0 || r.protein_grams > 200))
    return `implausible protein ${r.protein_grams}`;
  if (r.calories != null && (r.calories < 0 || r.calories > 5000))
    return `implausible calories ${r.calories}`;
  return null;
}

async function generate(staple: Staple): Promise<Generated | null> {
  const msg = await anthropic.messages.create({
    model: MODEL,
    // Thinking is on by default on Claude 5 and counts against max_tokens,
    // so leave room for it or the JSON truncates mid-object.
    max_tokens: 8000,
    system: SYSTEM,
    output_config: {
      effort: "low", // writing a simple recipe isn't an intelligence-bound task
      format: { type: "json_schema", schema: RECIPE_SCHEMA },
    },
    messages: [{ role: "user", content: `Write this recipe: ${staple.brief}` }],
  });

  if (msg.stop_reason === "max_tokens") return null; // truncated, not trustworthy

  const block = msg.content.find((c) => c.type === "text");
  if (!block || block.type !== "text") return null;
  try {
    return JSON.parse(block.text) as Generated;
  } catch {
    return null;
  }
}

async function main() {
  if (DRY_RUN) console.log("DRY RUN — generating only, nothing will be written.\n");

  const list = only ? STAPLES.filter((s) => s.slug === only) : STAPLES;
  if (!list.length) {
    console.error(`No staple matches --only=${only}`);
    process.exit(1);
  }

  const stats = { generated: 0, skipped: 0, rejected: 0, failed: 0 };

  for (const staple of list) {
    const sourceUrl = `generated:${staple.slug}`;

    const { data: existing } = await db
      .from("recipes")
      .select("id")
      .eq("source_url", sourceUrl)
      .maybeSingle();
    if (existing) {
      console.log(`  skip     ${staple.slug} (already stored)`);
      stats.skipped++;
      continue;
    }

    let recipe: Generated | null = null;
    try {
      recipe = await generate(staple);
    } catch (e) {
      console.log(`  FAIL     ${staple.slug}: ${e instanceof Error ? e.message : e}`);
      stats.failed++;
      continue;
    }
    if (!recipe) {
      console.log(`  FAIL     ${staple.slug}: unparseable response`);
      stats.failed++;
      continue;
    }

    const problem = validate(recipe, staple.brief);
    if (problem) {
      console.log(`  REJECT   ${staple.slug}: ${problem}`);
      stats.rejected++;
      continue;
    }

    stats.generated++;
    console.log(
      `  ok       ${recipe.title}  —  ${recipe.ingredients.length} ingr, ` +
        `${recipe.steps.length} steps, ${recipe.total_minutes} min, ` +
        `serves ${recipe.servings}, ~${recipe.protein_grams ?? "?"}g protein`
    );

    if (DRY_RUN) {
      for (const i of recipe.ingredients) console.log(`             - ${i.raw}`);
      recipe.steps.forEach((s, n) => console.log(`             ${n + 1}. ${s}`));
      console.log("");
      continue;
    }

    // Re-parse through the same ingredient parser the importer uses, so
    // generated rows are structurally identical to crawled ones.
    const ingredients = recipe.ingredients.map((i) =>
      i.quantity == null ? parseIngredient(i.raw) : i
    );

    const { error } = await db.from("recipes").insert({
      user_id: MY_USER_ID,
      source_url: sourceUrl,
      source_domain: null,
      saved: true, // yours, not corpus
      title: recipe.title,
      image_url: null,
      author: null,
      total_minutes: recipe.total_minutes,
      servings: recipe.servings,
      ingredients,
      steps: recipe.steps,
      tags: recipe.tags ?? [],
      concept_tags: ["simple_staple"],
      extraction_method: "llm_generated",
      protein_grams: recipe.protein_grams,
      calories: recipe.calories,
      // Never 'measured' — nobody weighed this.
      protein_source: recipe.protein_grams != null ? "estimated" : "unknown",
      protein_confidence: recipe.protein_grams != null ? "low" : null,
      raw_payload: { generated_at: new Date().toISOString(), model: MODEL, brief: staple.brief },
    });

    if (error) {
      console.log(`  FAIL     ${staple.slug}: ${error.message}`);
      stats.failed++;
    }
  }

  console.log("\n================ SUMMARY ================");
  console.log(`${DRY_RUN ? "would write" : "written"}   ${stats.generated}`);
  console.log(`skipped      ${stats.skipped}`);
  console.log(`rejected     ${stats.rejected}`);
  console.log(`failed       ${stats.failed}`);
  if (DRY_RUN) console.log("\nNothing was written. Drop --dry-run to commit.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
