import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";
import { RECIPE_COLUMNS } from "@/lib/types";
import type { Preferences } from "@/lib/preferences";
import {
  TASTE_COLUMNS,
  buildTasteProfile,
  type SwipeRecord,
  type TasteRow,
} from "@/lib/taste";
import { chipsFromParams } from "@/lib/filters";
import {
  RANK_COLUMNS,
  computeFacets,
  passesChips,
  WEIGHTS,
  buildFeed,
  makeRng,
  passesHardFilters,
  scoreCandidates,
  type RankRow,
} from "@/lib/rank";


// PostgREST caps any single query at 1000 rows no matter what .limit() says.
// Both sweeps below page around it — this bit us twice during enrichment.
const PAGE = 1000;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Loads the candidates for one request.
 *
 * The hard filters run in SQL and the scoring runs in JS, which is the split
 * that survived measurement. Two earlier designs did not:
 *
 *   1. Fetch the whole corpus, score in JS. 17,474 rows in 18 SEQUENTIAL
 *      PostgREST pages = 2,629ms. The cost was round trips, not data.
 *   2. Score in SQL, return the top N. The three percentile terms need three
 *      sorts of ~10,000 rows, which Postgres does in 509ms where the JS scorer
 *      does the same work in 44ms. Paging by offset then repeated that whole
 *      computation once per call. The wave measured 1,376-1,599ms.
 *
 * So: let Postgres do what it is fast at (indexed filtering, ~7,300 rows
 * discarded before they cross the wire) and let JS do what it is fast at (one
 * flat sort). One scorer, in TypeScript, where the taste profile and the
 * tri-state preference rules already live and are tested.
 *
 * Deliberately NOT cached. A cache keyed on preferences would have to be
 * invalidated on every settings change and every crawl, and the cold path is
 * the normal case for a few-times-a-week app — warm numbers would be flattering
 * rather than useful.
 */
async function loadCandidates(
  prefs: Preferences | null,
  swiped: ReadonlySet<string>
): Promise<{ rows: RankRow[]; error?: string; pagesFetched: number }> {
  const avoidStrict: string[] = prefs?.strict_proteins ?? [];
  const avoidSoft: string[] = (prefs?.avoid_proteins ?? []).filter(
    (p) => !avoidStrict.includes(p)
  );

  // Every filter here has an exact counterpart in passesHardFilters, which
  // still runs below as a guard. If the two ever disagree the guard wins and
  // the feed gets shorter — never wrong, just smaller.
  const notIn = avoidSoft.length ? `(${avoidSoft.join(",")})` : null;
  const overlaps = avoidStrict.length ? `{${avoidStrict.join(",")}}` : null;

  const countQuery = () => {
    let q = supabase
      .from("recipes")
      .select("*", { count: "exact", head: true })
      .eq("saved", false);
    if (prefs?.max_minutes != null) q = q.lte("total_minutes", prefs.max_minutes);
    if ((prefs?.diets ?? []).length) q = q.contains("diet_tags", prefs!.diets!);
    if (notIn) q = q.not("main_protein", "in", notIn);
    if (overlaps) q = q.not("protein_traces", "ov", overlaps);
    return q;
  };

  const pageQuery = (index: number) => {
    let q = supabase.from("recipes").select(RANK_COLUMNS).eq("saved", false);
    if (prefs?.max_minutes != null) q = q.lte("total_minutes", prefs.max_minutes);
    if ((prefs?.diets ?? []).length) q = q.contains("diet_tags", prefs!.diets!);
    if (notIn) q = q.not("main_protein", "in", notIn);
    if (overlaps) q = q.not("protein_traces", "ov", overlaps);
    return q.order("id", { ascending: true }).range(index * PAGE, index * PAGE + PAGE - 1);
  };

  const { count, error: countError } = await countQuery();
  if (countError) return { rows: [], error: countError.message, pagesFetched: 0 };

  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE));
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) => pageQuery(i))
  );

  const rows: RankRow[] = [];
  for (const r of results) {
    // Abort rather than rank a partial set — a silently short sweep looks like
    // a working feed with most of the good recipes missing.
    if (r.error) return { rows: [], error: r.error.message, pagesFetched: pages };
    for (const row of (r.data ?? []) as unknown as RankRow[]) {
      if (passesHardFilters(row, prefs, swiped)) rows.push(row);
    }
  }
  return { rows, pagesFetched: pages };
}


/**
 * GET /api/discover
 *   ?limit=20     cards to return
 *   ?debug=true   include the per-component score breakdown
 *   ?seed=123     seed the exploration RNG so the feed is reproducible
 */
export async function GET(req: NextRequest) {
  // Phase timings, always collected (they cost a Date.now per stage) and
  // returned only under ?timing=true. Guessing at which stage is slow is how
  // you end up optimising three things and learning nothing.
  //
  // t0 starts BEFORE requireUser(). It used to start after, which hid a whole
  // network round trip: requireUser() calls supabase.auth.getUser(), and the
  // proxy has already made the same call for the same request. Two auth round
  // trips per request, neither of them measured — 438ms of a 2.1s dev request
  // was unaccounted for until this moved.
  const t0 = performance.now();
  const marks: Record<string, number> = {};
  let last = t0;
  const mark = (name: string) => {
    const now = performance.now();
    marks[name] = Math.round((now - last) * 10) / 10;
    last = now;
  };

  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;
  mark("auth");

  const params = req.nextUrl.searchParams;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(params.get("limit")) || DEFAULT_LIMIT)
  );
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const debug = params.get("debug") === "true";
  const chips = chipsFromParams(params);
  const seedParam = params.get("seed");
  const seed = seedParam != null && seedParam !== "" ? Number(seedParam) : null;

  // Wave 1: preferences and swipes have no dependency on each other, so they
  // go together. Each round trip to Supabase costs ~64ms from a laptop, and
  // the route used to have five of them in series — most of the remaining
  // time was waiting, not working.
  const [prefResult, swipeResult] = await Promise.all([
    supabase.from("preferences").select("*").eq("user_id", userId).maybeSingle(),
    // Every swipe, paged. .in() starts failing silently above ~200 values, so
    // the exclusion set is built here and applied in memory.
    (async () => {
      const rows: SwipeRecord[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("swipes")
          .select("recipe_id, direction")
          .eq("user_id", userId)
          .range(from, from + PAGE - 1);
        if (error) return { data: null, error };
        rows.push(...((data ?? []) as SwipeRecord[]));
        if (!data || data.length < PAGE) break;
      }
      return { data: rows, error: null };
    })(),
  ]);

  if (prefResult.error) {
    return NextResponse.json({ error: prefResult.error.message }, { status: 500 });
  }
  if (swipeResult.error) {
    return NextResponse.json({ error: swipeResult.error.message }, { status: 500 });
  }
  const prefs: Preferences | null = prefResult.data ?? null;
  const swipeLog: SwipeRecord[] = swipeResult.data ?? [];
  const swiped = new Set(swipeLog.map((s) => s.recipe_id));
  mark("prefsAndSwipes");



  // Candidate sweep. Scoring columns only — pulling ingredients and steps for
  // 17,000 rows to rank them would move megabytes to throw nearly all of it away.
  // Wave 2: the candidate sweep and the swiped-recipe fetch are independent —
  // one reads the corpus, the other reads rows already excluded from it.
  const swipedIds = [...swiped];
  const [loaded, tasteChunks] = await Promise.all([
    loadCandidates(prefs, swiped),
    Promise.all(
      Array.from({ length: Math.ceil(swipedIds.length / 100) }, (_, i) =>
        supabase
          .from("recipes")
          .select(TASTE_COLUMNS)
          .in("id", swipedIds.slice(i * 100, i * 100 + 100))
      )
    ),
  ]);

  if (loaded.error) {
    return NextResponse.json({ error: loaded.error }, { status: 500 });
  }
  const candidates = loaded.rows;

  const swipedRows = new Map<string, TasteRow>();
  for (const chunk of tasteChunks) {
    if (chunk.error) {
      return NextResponse.json({ error: chunk.error.message }, { status: 500 });
    }
    for (const row of (chunk.data ?? []) as unknown as TasteRow[]) {
      swipedRows.set(row.id, row);
    }
  }
  mark("candidatesAndTaste");

  const taste = buildTasteProfile(swipeLog, swipedRows);

  // Facets are counted over the pool BEFORE chips, so the numbers on the
  // chips don't move as you tap them.
  const facets = computeFacets(candidates, chips);

  // Chips narrow before scoring, so what survives stays ranked by taste.
  const filtered = candidates.filter((row) => passesChips(row, chips));
  mark("facets");

  // Notes are only ever read inside the debug block below.
  const scored = scoreCandidates(filtered, prefs, taste, { notes: debug });
  const feed = buildFeed(
    scored,
    limit,
    seed != null && Number.isFinite(seed) ? makeRng(seed) : undefined,
    offset
  );
  mark("scoring");

  if (feed.length === 0) {
    return NextResponse.json({
      recipes: [],
      candidates: filtered.length,
      poolSize: candidates.length,
      facets,
      exhausted: true,
    });
  }

  // Hydrate only what's actually being shown.
  const ids = feed.map((f) => f.id);
  const { data: full, error: fullError } = await supabase
    .from("recipes")
    .select(RECIPE_COLUMNS)
    .in("id", ids);

  if (fullError) {
    return NextResponse.json({ error: fullError.message }, { status: 500 });
  }

  mark("hydrate");

  const byId = new Map((full ?? []).map((r) => [r.id as string, r]));

  // Counterfactual logging. The client posts these straight back on the swipe,
  // so we can later ask "what rank was I actually served?" rather than only
  // "what did I swipe on". This is the signal that made the median-rank-1728
  // bug findable at all — without it a broken deck and a bad scoring change
  // look identical.
  const rankOf = new Map(
    [...scored]
      .sort((a, b) => b.total - a.total || (a.id < b.id ? -1 : 1))
      .map((s, i) => [s.id, i + 1])
  );
  const recipes = feed
    .map((f) => {
      const row = byId.get(f.id);
      if (!row) return null;
      return {
        ...row,
        shown_rank: rankOf.get(f.id) ?? null,
        shown_source: f.exploration ? "explore" : "ranked",
        candidate_count: filtered.length,
      };
    })
    .filter(Boolean);
  const timing = params.get("timing") === "true"
    ? { ...marks,
        proxyMs: Number(req.headers.get("x-proxy-ms")) || null,
        total: Math.round((performance.now() - t0) * 10) / 10,
        candidates: candidates.length, pagesFetched: loaded.pagesFetched }
    : undefined;

  return NextResponse.json({
    recipes,
    candidates: filtered.length,
    poolSize: candidates.length,
    facets,
    /** Whether walking further down the ranking would return anything. */
    hasMore: offset + feed.length < candidates.length,
    ...(timing && { timing }),
    ...(debug && {
      debug: {
        weights: WEIGHTS,
        seed,
        taste,
        preferences: prefs,
        scores: feed.map((f) => ({
          id: f.id,
          title: byId.get(f.id)?.title ?? null,
          total: f.total,
          exploration: f.exploration,
          components: f.components,
        })),
      },
    }),
  });
}
