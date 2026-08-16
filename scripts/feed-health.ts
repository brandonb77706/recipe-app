/**
 * Is the deck still serving the ranking?
 *
 *   npx tsx scripts/feed-health.ts
 *   npx tsx scripts/feed-health.ts --since=2026-08-16
 *
 * This exists because of a specific failure. The swipe deck once degenerated
 * into pure random sampling — a refill raced ahead of the swipe writes, the
 * server returned the same top-ranked cards, the client dropped them all as
 * already-seen, and only the exploration picks survived. 165 cards were served
 * at a median rank of 1,728 out of 3,469, against an exploration-only
 * expectation of 1,745. Nothing errored. The only symptom was "the food looks
 * wrong", and it took a rank reconstruction to find.
 *
 * TWO checks matter, and they must stay separate:
 *
 *   EXPLORE SHARE — should sit near 20%. If it climbs, ranked cards are being
 *   dropped client-side as already-seen and exploration is filling the gap.
 *
 *   MEDIAN RANK OF RANKED CARDS — should be near the top of the pool.
 *
 * The first version of this script computed one median across BOTH kinds and
 * called a 59%-exploration session "healthy". Exploration draws uniformly from
 * the whole tail, so a deck serving nothing but exploration still yields a
 * middling median — the number looked fine while the deck was broken. A check
 * that stays quiet during a real regression is worse than one that cries wolf.
 *
 * Exits non-zero when a check fails. Read it after any scoring change.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
  const i = line.indexOf("=");
  if (i > 0 && !line.trimStart().startsWith("#")) {
    const key = line.slice(0, i).trim();
    if (!process.env[key]) process.env[key] = line.slice(i + 1).trim();
  }
}
process.env.SUPABASE_URL ||= process.env.NEXT_PUBLIC_SUPABASE_URL!;

const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const args = process.argv.slice(2);
const since = args.find((a) => a.startsWith("--since="))?.split("=")[1];

type Swipe = {
  direction: "left" | "right";
  shown_rank: number | null;
  shown_source: string | null;
  candidate_count: number | null;
  created_at: string;
};

const median = (xs: number[]) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN;

async function main() {
  let q = db
    .from("swipes")
    .select("direction, shown_rank, shown_source, candidate_count, created_at")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (since) q = q.gte("created_at", since);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const swipes = (data ?? []) as Swipe[];

  if (!swipes.length) {
    console.log("No swipes recorded yet.");
    return;
  }

  const logged = swipes.filter((s) => s.shown_rank != null);
  console.log(`SWIPES: ${swipes.length}${since ? ` since ${since}` : ""}`);
  console.log(
    `  with rank logged: ${logged.length}` +
      (logged.length < swipes.length
        ? `  (${swipes.length - logged.length} predate the logging columns)`
        : "")
  );

  if (!logged.length) {
    console.log("\nNothing to analyse — swipe a few cards on a deployed build.");
    return;
  }

  // --- the headline ---------------------------------------------------------
  //
  // Two separate checks, because the first version of this script conflated
  // them and reported "healthy" on a session that was 59% exploration.
  // Exploration picks are drawn uniformly from the whole tail, so a deck
  // serving nothing BUT exploration still produces a middling median. The
  // median only means something over the RANKED cards.
  const pool = median(logged.map((s) => s.candidate_count ?? 0));
  const rankedCards = logged.filter((s) => s.shown_source === "ranked");
  const exploreShare =
    logged.filter((s) => s.shown_source === "explore").length / logged.length;

  let problems = 0;

  console.log(`\nEXPLORE SHARE: ${Math.round(exploreShare * 100)}% (expected ~20%)`);
  if (exploreShare > 0.32) {
    problems++;
    console.log(
      `  ⚠ TOO HIGH. The deck is serving exploration picks in place of ranked\n` +
        `    ones — the signature of ranked cards being dropped client-side as\n` +
        `    already-seen. This is what the 1,728-median bug looked like.`
    );
  } else if (exploreShare < 0.08) {
    problems++;
    console.log(`  ⚠ TOO LOW. Exploration has effectively stopped; the feed can't learn.`);
  } else {
    console.log(`  as designed`);
  }

  if (rankedCards.length) {
    const med = median(rankedCards.map((s) => s.shown_rank!));
    console.log(
      `\nMEDIAN RANK OF *RANKED* CARDS: ${med} of ~${pool}  (${rankedCards.length} cards)`
    );
    if (Number.isFinite(pool) && pool > 0 && med / pool > 0.1) {
      problems++;
      console.log(
        `  ⚠ ${Math.round((med / pool) * 100)}% down the pool. Ranked cards should\n` +
          `    cluster near the top — anything else means the ranking isn't reaching you.`
      );
    } else {
      console.log(`  healthy — ranked cards are coming from the top of the ranking`);
    }
  } else {
    problems++;
    console.log(`\n⚠ NOT ONE RANKED CARD SERVED. The deck is pure exploration.`);
  }

  // --- save rate by rank bucket --------------------------------------------
  console.log(`\nSAVE RATE BY RANK BUCKET`);
  const buckets: [number, number][] = [
    [1, 20], [21, 50], [51, 200], [201, 1000], [1001, Infinity],
  ];
  for (const [lo, hi] of buckets) {
    const inB = logged.filter((s) => s.shown_rank! >= lo && s.shown_rank! <= hi);
    if (!inB.length) continue;
    const saves = inB.filter((s) => s.direction === "right").length;
    const rate = saves / inB.length;
    const label = hi === Infinity ? `${lo}+` : `${lo}-${hi}`;
    console.log(
      `  ${label.padStart(9)}  ${String(inB.length).padStart(4)} shown  ` +
        `${String(saves).padStart(3)} saved  ${String(Math.round(rate * 100)).padStart(3)}%  ` +
        "█".repeat(Math.round(rate * 40))
    );
  }
  console.log(
    `\n  If the top bucket doesn't save better than the bottom, the ranking\n` +
      `  isn't ordering by anything you actually want.`
  );

  // --- ranked vs explore ----------------------------------------------------
  console.log(`\nRANKED vs EXPLORE`);
  for (const source of ["ranked", "explore"]) {
    const inS = logged.filter((s) => s.shown_source === source);
    if (!inS.length) continue;
    const saves = inS.filter((s) => s.direction === "right").length;
    console.log(
      `  ${source.padEnd(8)} ${String(inS.length).padStart(4)} shown ` +
        `(${Math.round((inS.length / logged.length) * 100)}%)  ` +
        `${saves} saved (${Math.round((saves / inS.length) * 100)}%)`
    );
  }
  console.log(
    problems
      ? `\n${problems} PROBLEM(S) ABOVE — do not trust a scoring comparison against this data.`
      : `\nAll checks passed.`
  );
  if (problems) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
