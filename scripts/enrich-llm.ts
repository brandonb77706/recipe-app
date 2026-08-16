/**
 * LLM tagging pass — the fields the discover feed filters on that can't be
 * derived: cuisine, meal_types, diet_tags, main_protein.
 *
 *   npx tsx scripts/enrich-llm.ts --limit=100 --dry-run   # read the distribution first
 *   npx tsx scripts/enrich-llm.ts --limit=100
 *   npx tsx scripts/enrich-llm.ts                          # the whole corpus
 *
 * Incremental by design: rows with enriched_at set are skipped, so a crash or
 * a Ctrl-C costs nothing, and the whole pass can be re-run later against an
 * improved prompt without re-crawling a single page.
 *
 * Only title + ingredient names + existing tags are sent. Step text triples
 * the token cost for almost no accuracy gain.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { dietCandidates } from "../src/lib/enrich";

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

const MODEL = "claude-haiku-4-5";
const BATCH = 20; // recipes per call
const CONCURRENCY = 4; // calls in flight

// ---------------------------------------------------------------------------
// The vocabulary is closed. Free-form tagging produces hundreds of near
// duplicates that are useless for filtering, so these lists are enforced twice:
// as schema enums, and again when the response is validated.
// ---------------------------------------------------------------------------

const CUISINES = [
  "american", "italian", "mexican", "chinese", "japanese", "korean", "thai",
  "vietnamese", "indian", "mediterranean", "middle_eastern", "french",
  "spanish", "german", "caribbean", "african", "latin_american", "british",
  "eastern_european", "fusion",
] as const;

const MEAL_TYPES = [
  "breakfast", "lunch", "dinner", "snack", "dessert", "side", "sauce", "drink",
] as const;

const DIET_TAGS = [
  "vegetarian", "vegan", "gluten_free", "dairy_free", "nut_free", "low_carb",
  "high_protein", "pescatarian",
] as const;

const MAIN_PROTEINS = [
  "chicken", "beef", "pork", "fish", "shellfish", "tofu", "beans", "lentils",
  "eggs", "cheese", "none",
] as const;

const SYSTEM = `You classify recipes into a fixed, closed vocabulary for a
recipe filtering system. Return one object per input recipe.

cuisine — exactly one, or null if genuinely unclear:
${CUISINES.join(", ")}

meal_types — one or more:
${MEAL_TYPES.join(", ")}

diet_tags — zero or more, ONLY when confident:
${DIET_TAGS.join(", ")}

main_protein — exactly one, or null:
${MAIN_PROTEINS.join(", ")}

meal_prep — true only if the dish genuinely works cooked ahead in portions.

Rules:
- Diet tags are conservative. Omit rather than guess. A false gluten_free is
  far worse than a missing one — someone may rely on it.
- "diet_candidates" in the input comes from crude keyword scanning. Treat it as
  a hint, not an answer: it is fooled by chicken broth in an otherwise
  vegetarian dish, by fish sauce, and by almond flour.
- high_protein only when protein is plausibly >=25g per serving. When
  protein_grams is given, trust that number. When it is null, judge from the
  ingredients and the serving count.
- main_protein is what the dish is built around. Use "none" for dishes with no
  meaningful protein component (a drink, a simple side, most desserts).
- Do not invent values outside the lists above.

meal_prep is the one judgment that matters most here, so be strict. Say true
only when ALL of these hold:
  - it keeps 3-4 days refrigerated without the texture falling apart
  - it reheats well, or is meant to be eaten cold
  - it portions into containers sensibly
Say false for: anything crispy or fried that goes soggy, delicate fish,
dressed salads and greens that wilt, soft-set or runny eggs, pasta that turns
to mush, avocado-based dishes that brown, anything served immediately from the
pan, most baked goods eaten fresh, and drinks.
meal_prep applies to MEALS and meal components only. A dessert, snack, sweet
bake or drink is false even when it keeps and portions perfectly — someone
filtering for meal prep is planning lunches and dinners, not cookies.
Braises, stews, chilis, grain bowls, roasted proteins with sturdy vegetables,
curries, casseroles and soups are typical trues. A dish serving 4+ is NOT
automatically meal-prep — a stir-fry serving 6 still dies in the fridge.`;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    recipes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          cuisine: { anyOf: [{ type: "string", enum: CUISINES }, { type: "null" }] },
          meal_types: { type: "array", items: { type: "string", enum: MEAL_TYPES } },
          diet_tags: { type: "array", items: { type: "string", enum: DIET_TAGS } },
          main_protein: {
            anyOf: [{ type: "string", enum: MAIN_PROTEINS }, { type: "null" }],
          },
          meal_prep: { type: "boolean" },
        },
        required: ["id", "cuisine", "meal_types", "diet_tags", "main_protein", "meal_prep"],
        additionalProperties: false,
      },
    },
  },
  required: ["recipes"],
  additionalProperties: false,
} as const;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

type Row = {
  id: string;
  title: string;
  tags: string[] | null;
  servings: number | null;
  protein_grams: number | null;
  ingredients: { name?: string; raw?: string }[];
  concept_tags: string[] | null;
};

type Tagged = {
  id: string;
  cuisine: string | null;
  meal_types: string[];
  diet_tags: string[];
  main_protein: string | null;
  meal_prep: boolean;
};

function promptFor(rows: Row[]): string {
  return rows
    .map((r) => {
      const ing = (Array.isArray(r.ingredients) ? r.ingredients : [])
        .map((i) => i.name || i.raw || "")
        .filter(Boolean)
        .slice(0, 25)
        .join(", ");
      const cand = dietCandidates(
        (r.ingredients ?? []) as { quantity: number | null; unit: string | null; name: string; raw: string }[]
      );
      const hints = [
        cand.vegetarian ? "vegetarian?" : "",
        cand.vegan ? "vegan?" : "",
        cand.gluten_free ? "gluten_free?" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return [
        `id: ${r.id}`,
        `title: ${r.title}`,
        `ingredients: ${ing}`,
        r.tags?.length ? `existing_tags: ${r.tags.join(", ")}` : "",
        r.servings != null ? `servings: ${r.servings}` : "",
        r.protein_grams != null ? `protein_grams_per_serving: ${r.protein_grams}` : "",
        hints ? `diet_candidates: ${hints}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n---\n");
}

const inVocab = (v: string, list: readonly string[]) => list.includes(v);

/**
 * Some failures mean "stop", not "try the next batch". An empty credit balance
 * or a bad key will fail every remaining call identically — retrying just
 * burns through the queue logging thousands of identical errors.
 */
function isFatal(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (/credit balance is too low/i.test(msg)) return "out of API credits";
  if (/authentication_error|invalid x-api-key/i.test(msg)) return "bad API key";
  if (/permission_error/i.test(msg)) return "API key lacks permission";
  return null;
}

let abortReason: string | null = null;

async function tagBatch(rows: Row[]): Promise<Tagged[]> {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: RESULT_SCHEMA } },
    messages: [{ role: "user", content: promptFor(rows) }],
  });

  if (msg.stop_reason === "max_tokens") throw new Error("response truncated");
  const block = msg.content.find((c) => c.type === "text");
  if (!block || block.type !== "text") throw new Error("no text block");

  const parsed = JSON.parse(block.text) as { recipes?: Tagged[] };
  const byId = new Map(rows.map((r) => [r.id, r]));

  // The schema constrains the model, but validate anyway — a value outside the
  // vocabulary silently breaks every filter that depends on it.
  return (parsed.recipes ?? []).filter((t) => {
    if (!byId.has(t.id)) return false;
    if (t.cuisine != null && !inVocab(t.cuisine, CUISINES)) return false;
    if (t.main_protein != null && !inVocab(t.main_protein, MAIN_PROTEINS)) return false;
    t.meal_types = (t.meal_types ?? []).filter((m) => inVocab(m, MEAL_TYPES));
    t.diet_tags = (t.diet_tags ?? []).filter((d) => inVocab(d, DIET_TAGS));
    return true;
  });
}

async function main() {
  if (DRY_RUN) console.log("DRY RUN — tagging, but nothing will be written.\n");

  // PostgREST caps a single response at 1000 rows regardless of .limit(), so
  // the corpus has to be walked in pages. Setting enriched_at as we go means
  // each page naturally returns the next untagged slice.
  const PAGE = 1000;

  const fetchPage = async (want: number): Promise<Row[]> => {
    const { data, error } = await db
      .from("recipes")
      .select("id,title,tags,servings,protein_grams,ingredients,concept_tags")
      .is("enriched_at", null)
      .order("created_at", { ascending: true })
      .limit(Math.min(PAGE, want));
    if (error) {
      console.error("query failed:", error.message);
      process.exit(1);
    }
    return (data ?? []) as Row[];
  };

  const first = await fetchPage(LIMIT);
  if (!first.length) {
    console.log("Nothing to do — every recipe already has enriched_at set.");
    return;
  }
  let rows = first;

  const dist = {
    cuisine: new Map<string, number>(),
    meal: new Map<string, number>(),
    diet: new Map<string, number>(),
    protein: new Map<string, number>(),
  };
  let mealPrepCount = 0;
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const stats = { tagged: 0, written: 0, failed: 0, batchesDone: 0 };

  let batches: Row[][] = [];
  let rowsById = new Map<string, Row>();
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= batches.length) return;
      const batch = batches[i];

      if (abortReason) return;

      let tagged: Tagged[];
      try {
        tagged = await tagBatch(batch);
      } catch (e) {
        const fatal = isFatal(e);
        if (fatal) {
          abortReason = fatal;
          console.error(`\n  ABORTING — ${fatal}. Nothing further will be attempted.`);
          return;
        }
        stats.failed += batch.length;
        console.log(`  batch ${i + 1} failed: ${e instanceof Error ? e.message : e}`);
        continue;
      }

      for (const t of tagged) {
        stats.tagged++;
        bump(dist.cuisine, t.cuisine ?? "(null)");
        bump(dist.protein, t.main_protein ?? "(null)");
        if (t.meal_prep) mealPrepCount++;
        for (const m of t.meal_types) bump(dist.meal, m);
        for (const d of t.diet_tags) bump(dist.diet, d);

        if (DRY_RUN) continue;
        const existing = new Set(rowsById.get(t.id)?.concept_tags ?? []);
        if (t.meal_prep) existing.add("meal_prep");
        else existing.delete("meal_prep");

        const { error: e2 } = await db
          .from("recipes")
          .update({
            concept_tags: [...existing],
            cuisine: t.cuisine,
            meal_types: t.meal_types,
            diet_tags: t.diet_tags,
            main_protein: t.main_protein,
            enriched_at: new Date().toISOString(),
          })
          .eq("id", t.id);
        if (e2) stats.failed++;
        else stats.written++;
      }

      stats.batchesDone++;
      if (stats.batchesDone % 5 === 0 || stats.batchesDone === batches.length) {
        console.log(
          `  [${stats.batchesDone}/${batches.length}] tagged=${stats.tagged} ` +
            `${DRY_RUN ? "" : `written=${stats.written} `}failed=${stats.failed}`
        );
      }
    }
  };

  // Page through the corpus until nothing untagged is left (or --limit is hit).
  for (;;) {
    batches = [];
    rowsById = new Map(rows.map((r) => [r.id, r]));
    for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));
    next = 0;
    stats.batchesDone = 0;
    console.log(
      `page: ${rows.length} recipes in ${batches.length} calls (${CONCURRENCY} concurrent)`
    );

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (abortReason) break;
    // A dry run writes no enriched_at, so the next page would be identical.
    if (DRY_RUN) break;
    if (stats.tagged >= LIMIT) break;
    rows = await fetchPage(LIMIT === Infinity ? PAGE : LIMIT - stats.tagged);
    if (!rows.length) break;
  }

  const show = (label: string, m: Map<string, number>) => {
    console.log(`\n${label}`);
    const total = stats.tagged || 1;
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) =>
        console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}  ${Math.round((v / total) * 100)}%`)
      );
  };

  console.log("\n================ SUMMARY ================");
  console.log(`tagged   ${stats.tagged}`);
  if (!DRY_RUN) console.log(`written  ${stats.written}`);
  console.log(`failed   ${stats.failed}`);
  show("cuisine", dist.cuisine);
  show("meal_types", dist.meal);
  show("diet_tags", dist.diet);
  show("main_protein", dist.protein);
  console.log(
    `\nmeal_prep\n  true                 ${String(mealPrepCount).padStart(5)}  ` +
      `${Math.round((mealPrepCount / (stats.tagged || 1)) * 100)}%`
  );
  if (abortReason) {
    console.log(
      `\nStopped early: ${abortReason}. Progress is saved — re-run to resume.`
    );
  }
  if (DRY_RUN) console.log("\nNothing was written. Drop --dry-run to commit.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
