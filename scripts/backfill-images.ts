/**
 * Finds a real photograph for saved recipes that have no image — currently the
 * AI-generated staples, which are written with image_url null.
 *
 *   npx tsx scripts/backfill-images.ts --dry-run     # show matches, write nothing
 *   npx tsx scripts/backfill-images.ts
 *   npx tsx scripts/backfill-images.ts --only=chicken-rice-bowl
 *   npx tsx scripts/backfill-images.ts --force       # also replace existing images
 *
 * Provider: Pexels when PEXELS_API_KEY is set (professional food photography,
 * free key, no attribution required), otherwise Openverse (no key, but the
 * results are Flickr-grade and narrow queries often return nothing).
 *
 * These are stock photos of the dish, not photographs of the actual food —
 * fine for a meal-prep staple, and the honest alternative to generating a
 * fake photo of something nobody has cooked.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

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

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const only = args.find((a) => a.startsWith("--only="))?.split("=")[1];

const PEXELS_KEY = process.env.PEXELS_API_KEY;
const PROVIDER = PEXELS_KEY ? "pexels" : "openverse";

// Stock libraries index dishes, not techniques. "Air Fryer Boneless Chicken
// Thighs" returns nothing; "chicken thighs" returns plenty.
const NOISE =
  /\b(easy[- ]peel|air fryer|instant pot|slow cooker|sheet pan|skillet|stovetop|one[- ]pot|reliable|crispy|juicy|soft|simple|easy|best|classic|homemade|pantry|for the week|meal prep|bowls?|recipe)\b/gi;

function searchQuery(title: string): string {
  const cleaned = title
    .replace(NOISE, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Keep it short — long queries narrow stock search to zero.
  const words = (cleaned || title).split(" ").filter(Boolean).slice(0, 4);
  return words.join(" ").toLowerCase();
}

type Hit = { url: string; credit: string; alt: string; score: number };

// Stock search almost always returns *something*, so the danger isn't an empty
// result — it's a confident mismatch (a rice paddy for "white rice"). Score the
// candidates against the query and refuse anything that doesn't clearly depict
// the dish; a null image falls back to the generated card, which is fine.
const STOPWORDS = new Set(["and", "with", "the", "of", "in", "on", "a"]);

// Word overlap alone can't tell a cooked dish from its raw ingredients —
// "uncooked white rice grains" matches "white rice" perfectly. These photos are
// the single most common wrong answer, so they're disqualified outright rather
// than merely penalised.
const RAW_MARKERS =
  /\b(raw|uncooked|unbaked|unprepared|frozen|grains?|kernels?|cutting board|chopping board|ingredients?|market|grocery|harvest|field|farm|crop|seeds?|dough)\b/i;

// Multi-dish scenes match the words but never depict the recipe — a
// "Thanksgiving spread" contains turkey and sweet potato without being a
// turkey and sweet potato skillet.
const MULTI_DISH =
  /\b(buffet|spread|assortment|variety|selection|feast|banquet|charcuterie|thanksgiving|christmas|holiday table|brunch table|potluck|smorgasbord)\b/i;

// Signals the photo shows a finished, plated dish.
const DISH_MARKERS =
  /\b(dish|plate|plated|bowl|served|serving|meal|cooked|grilled|roasted|fried|baked|sauteed|seared|steaming|homemade|delicious|garnished)\b/i;

/** Below this, we'd rather show no photo than the wrong one. */
const MIN_RELEVANCE = 0.5;

function relevance(query: string, alt: string): number {
  const terms = query.split(" ").filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (!terms.length) return 0;

  const haystack = alt.toLowerCase();
  if (RAW_MARKERS.test(haystack)) return 0; // ingredients, not the dish
  if (MULTI_DISH.test(haystack)) return 0; // a table of food, not this dish

  const hits = terms.filter((t) => haystack.includes(t)).length;
  const overlap = hits / terms.length;

  // The plated-dish bonus ranks equally-matching candidates; it must never
  // rescue a weak one. "Stuffed sweet potato" matched 1 of 3 terms for a ground
  // turkey skillet and cleared the bar purely on the bonus.
  if (overlap < MIN_RELEVANCE) return overlap;
  return DISH_MARKERS.test(haystack) ? Math.min(1, overlap + 0.25) : overlap;
}

async function searchPexels(q: string): Promise<Hit | null> {
  const res = await fetch(
    `https://api.pexels.com/v1/search?per_page=10&orientation=landscape&query=${encodeURIComponent(q)}`,
    { headers: { Authorization: PEXELS_KEY! }, signal: AbortSignal.timeout(20000) }
  );
  if (!res.ok) throw new Error(`pexels ${res.status}`);
  const body = await res.json();

  const scored = (body?.photos ?? [])
    .filter((p: { src?: { large?: string } }) => p?.src?.large)
    .map((p: { src: { large: string }; alt?: string; photographer?: string }) => ({
      url: p.src.large,
      alt: p.alt ?? "",
      credit: `Pexels / ${p.photographer ?? "unknown"}`,
      score: relevance(q, p.alt ?? ""),
    }))
    .sort((a: Hit, b: Hit) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < MIN_RELEVANCE) return null;
  return best;
}

async function searchOpenverse(q: string): Promise<Hit | null> {
  const res = await fetch(
    `https://api.openverse.org/v1/images/?page_size=10&license_type=all-cc&q=${encodeURIComponent(q)}`,
    {
      headers: { "User-Agent": "recipe-vault/1.0 (personal project)" },
      signal: AbortSignal.timeout(20000),
    }
  );
  if (!res.ok) throw new Error(`openverse ${res.status}`);
  const body = await res.json();

  const scored = (body?.results ?? [])
    .filter((r: { url?: string }) => r?.url)
    .map((r: { url: string; title?: string; creator?: string; license?: string }) => ({
      url: r.url,
      alt: r.title ?? "",
      credit: `Openverse / ${r.creator ?? "unknown"} (${r.license})`,
      score: relevance(q, r.title ?? ""),
    }))
    .sort((a: Hit, b: Hit) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < MIN_RELEVANCE) return null;
  return best;
}

const search = PEXELS_KEY ? searchPexels : searchOpenverse;

async function main() {
  console.log(
    `provider: ${PROVIDER}${PROVIDER === "openverse" ? "  (set PEXELS_API_KEY for better food photos)" : ""}`
  );
  if (DRY_RUN) console.log("DRY RUN — nothing will be written.\n");

  let query = db
    .from("recipes")
    .select("id,title,image_url,source_url")
    .eq("saved", true)
    .order("title");
  if (!FORCE) query = query.is("image_url", null);

  const { data, error } = await query;
  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }

  const rows = (data ?? []).filter(
    (r) => !only || r.source_url === `generated:${only}`
  );
  if (!rows.length) {
    console.log("Nothing to do — every saved recipe already has an image.");
    return;
  }

  const stats = { matched: 0, noMatch: 0, failed: 0 };

  for (const row of rows) {
    const q = searchQuery(row.title);
    let hit: Hit | null = null;
    try {
      hit = await search(q);
    } catch (e) {
      stats.failed++;
      console.log(
        `  FAIL     ${row.title.slice(0, 42).padEnd(44)} "${q}"  ${e instanceof Error ? e.message : e}`
      );
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }

    if (!hit) {
      stats.noMatch++;
      console.log(
        `  no match ${row.title.slice(0, 42).padEnd(44)} "${q}"  ` +
          `(nothing scored >=${Math.round(MIN_RELEVANCE * 100)}% — leaving it blank)`
      );
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }

    stats.matched++;
    console.log(
      `  ok       ${row.title.slice(0, 42).padEnd(44)} "${q}"  ` +
        `${Math.round(hit.score * 100)}%  “${hit.alt.slice(0, 54)}”`
    );
    if (DRY_RUN) console.log(`             ${hit.credit}  ${hit.url}`);

    if (!DRY_RUN) {
      const { error: updateError } = await db
        .from("recipes")
        .update({ image_url: hit.url })
        .eq("id", row.id);
      if (updateError) {
        stats.failed++;
        console.log(`             update failed: ${updateError.message}`);
      }
    }

    // These are free APIs — don't hammer them.
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log("\n================ SUMMARY ================");
  console.log(`${DRY_RUN ? "would set" : "set"}    ${stats.matched}`);
  console.log(`no match     ${stats.noMatch}  (these keep the generated card)`);
  console.log(`failed       ${stats.failed}`);
  if (DRY_RUN) console.log("\nNothing was written. Drop --dry-run to commit.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
