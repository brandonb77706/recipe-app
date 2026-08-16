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
 * The check that matters is MEDIAN SHOWN RANK. If it drifts toward the middle
 * of the candidate pool, the ranking has stopped reaching the screen — whether
 * from a scoring regression or a broken deck. Read it after any scoring change.
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
  const ranks = logged.map((s) => s.shown_rank!);
  const pool = median(logged.map((s) => s.candidate_count ?? 0));
  const med = median(ranks);
  console.log(`\nMEDIAN SHOWN RANK: ${med} of ~${pool} candidates`);
  if (Number.isFinite(pool) && pool > 0) {
    const ratio = med / pool;
    console.log(
      ratio > 0.25
        ? `  ⚠ that is ${Math.round(ratio * 100)}% down the pool — the ranking may not be reaching the deck.\n` +
            `    Random sampling would sit near 50%. Investigate before trusting any scoring change.`
        : `  healthy — ${Math.round(ratio * 100)}% down the pool (random sampling would be ~50%)`
    );
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
  const explorePct =
    logged.filter((s) => s.shown_source === "explore").length / logged.length;
  console.log(
    `\n  Expected explore share is ~20% (every 5th card). ` +
      (Math.abs(explorePct - 0.2) > 0.12
        ? `Measured ${Math.round(explorePct * 100)}% — off enough to look at.`
        : `Measured ${Math.round(explorePct * 100)}% — as designed.`)
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
