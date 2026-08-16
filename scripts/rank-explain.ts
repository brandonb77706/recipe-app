/**
 * Prints the full score breakdown for the ranked feed, so a baffling card can
 * be traced to the term that caused it instead of guessed at.
 *
 *   npx tsx scripts/rank-explain.ts                    # your saved preferences
 *   npx tsx scripts/rank-explain.ts --profile=lchpmp   # a canned profile
 *   npx tsx scripts/rank-explain.ts --n=5 --seed=42
 *   npx tsx scripts/rank-explain.ts --spread           # top, middle and bottom
 *
 * --spread is the tuning view: instead of the feed (which is all winners) it
 * samples across the whole ranked range, which is where weight problems show.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { Preferences } from "../src/lib/preferences";
import {
  RANK_COLUMNS,
  WEIGHTS,
  buildFeed,
  makeRng,
  passesHardFilters,
  scoreCandidates,
  type RankRow,
  type Scored,
} from "../src/lib/rank";

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

const MY_USER_ID = "00000000-0000-0000-0000-000000000001";
const PAGE = 1000;

const args = process.argv.slice(2);
const arg = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const N = Number(arg("n") ?? 5);
const SEED = arg("seed") ? Number(arg("seed")) : null;
const SPREAD = args.includes("--spread");
const PROFILE = arg("profile");

/** Canned profiles so the ranking can be inspected without touching real data. */
const PROFILES: Record<string, Partial<Preferences>> = {
  // "low cal, high protein, meal prep" — the combination that started this.
  lchpmp: {
    max_minutes: 45,
    diets: [],
    avoid_proteins: [],
    strict_proteins: [],
    favorite_cuisines: ["italian", "mexican", "thai"],
    prefer_high_protein: true,
    prefer_concepts: ["low_calorie", "meal_prep"],
  },
  // Everything answered "no preference" — the pure-exploration case.
  neutral: {
    max_minutes: null,
    diets: [],
    avoid_proteins: [],
    strict_proteins: [],
    favorite_cuisines: [],
    prefer_high_protein: false,
    prefer_concepts: [],
  },
  // Nothing answered at all — every cold-start prior active.
  cold: {
    max_minutes: null,
    diets: null,
    avoid_proteins: null,
    strict_proteins: null,
    favorite_cuisines: null,
    prefer_high_protein: false,
    prefer_concepts: null,
  },
};

function asPreferences(p: Partial<Preferences>): Preferences {
  return {
    user_id: MY_USER_ID,
    max_minutes: null,
    diets: null,
    avoid_proteins: null,
    strict_proteins: null,
    favorite_cuisines: null,
    prefer_high_protein: false,
    prefer_concepts: null,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...p,
  };
}

const bar = (n: number, width = 24) =>
  "█".repeat(Math.round(n * width)).padEnd(width, "·");

async function main() {
  let prefs: Preferences | null;
  if (PROFILE) {
    if (!PROFILES[PROFILE]) {
      console.log(`Unknown profile. Try: ${Object.keys(PROFILES).join(", ")}`);
      process.exit(1);
    }
    prefs = asPreferences(PROFILES[PROFILE]);
    console.log(`Profile: ${PROFILE}\n`);
  } else {
    const { data } = await db
      .from("preferences")
      .select("*")
      .eq("user_id", MY_USER_ID)
      .maybeSingle();
    prefs = data ?? null;
    console.log(
      prefs
        ? "Using your saved preferences\n"
        : "No preferences row — everything is cold start\n"
    );
  }

  console.log("PREFERENCES");
  console.log(`  max_minutes        ${prefs?.max_minutes ?? "—"}`);
  const show = (v: unknown[] | null | undefined) =>
    v === null || v === undefined
      ? "null (never answered)"
      : v.length === 0
        ? "[] (no preference)"
        : v.join(", ");
  console.log(`  diets              ${show(prefs?.diets)}`);
  console.log(`  avoid_proteins     ${show(prefs?.avoid_proteins)}`);
  console.log(`  strict_proteins    ${show(prefs?.strict_proteins)}`);
  console.log(`  favorite_cuisines  ${show(prefs?.favorite_cuisines)}`);
  console.log(`  prefer_high_protein ${prefs?.prefer_high_protein ?? false}`);
  console.log(`  prefer_concepts    ${show(prefs?.prefer_concepts)}`);

  const swiped = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data } = await db
      .from("swipes")
      .select("recipe_id")
      .eq("user_id", MY_USER_ID)
      .range(from, from + PAGE - 1);
    for (const s of data ?? []) swiped.add(s.recipe_id as string);
    if (!data || data.length < PAGE) break;
  }

  let total = 0;
  const candidates: RankRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("recipes")
      .select(RANK_COLUMNS)
      .eq("saved", false)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as RankRow[];
    total += rows.length;
    for (const row of rows)
      if (passesHardFilters(row, prefs, swiped)) candidates.push(row);
    if (rows.length < PAGE) break;
  }

  console.log(`\nHARD FILTERS`);
  console.log(`  corpus             ${total}`);
  console.log(`  already swiped     ${swiped.size}`);
  console.log(
    `  candidates         ${candidates.length}  (${Math.round(
      (candidates.length / Math.max(1, total)) * 100
    )}% survived)`
  );

  const scored = scoreCandidates(candidates, prefs);
  const ranked = [...scored].sort(
    (a, b) => b.total - a.total || (a.id < b.id ? -1 : 1)
  );

  let picks: Scored[];
  if (SPREAD) {
    // Even slices across the ranked list, so the bottom of the corpus is
    // visible next to the top — you can't tune weights on winners alone.
    picks = Array.from({ length: N }, (_, i) => {
      const idx = Math.round((i / (N - 1)) * (ranked.length - 1));
      return ranked[idx];
    });
  } else {
    picks = buildFeed(
      scored,
      N,
      SEED != null ? makeRng(SEED) : undefined
    );
  }

  const ids = picks.map((p) => p.id);
  const { data: full } = await db
    .from("recipes")
    .select("id, title, source_domain, total_minutes, protein_grams, calories, cuisine, concept_tags")
    .in("id", ids);
  const byId = new Map((full ?? []).map((r) => [r.id as string, r]));

  const rankOf = new Map(ranked.map((s, i) => [s.id, i + 1]));

  console.log(`\nWEIGHTS  ${JSON.stringify(WEIGHTS)}`);
  console.log(
    `\n${SPREAD ? "SPREAD ACROSS THE RANKING" : "THE FEED"} — ${N} recipes\n`
  );

  for (const pick of picks) {
    const r = byId.get(pick.id);
    console.log(
      `  #${String(rankOf.get(pick.id)).padStart(4)} of ${ranked.length}   ${
        r?.title ?? pick.id
      }${pick.exploration ? "   [exploration pick]" : ""}`
    );
    console.log(
      `        ${r?.source_domain ?? "?"} · ${r?.cuisine ?? "no cuisine"} · ${
        r?.total_minutes ?? "?"
      } min · ${r?.protein_grams ?? "?"}g protein · ${r?.calories ?? "?"} cal`
    );
    console.log(`        TOTAL ${pick.total.toFixed(3)}`);
    for (const c of pick.components) {
      if (c.raw === null) {
        console.log(`          ${c.name.padEnd(8)} —      off    ${c.note}`);
        continue;
      }
      console.log(
        `          ${c.name.padEnd(8)} ${bar(c.raw)} ${c.raw
          .toFixed(2)
          .padStart(5)} × ${String(c.weight).padEnd(5)} = ${c.points
          .toFixed(3)
          .padStart(6)}   ${c.note}`
      );
    }
    console.log();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
