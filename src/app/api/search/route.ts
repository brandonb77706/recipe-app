import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";
import { RECIPE_COLUMNS } from "@/lib/types";
import type { Preferences } from "@/lib/preferences";
import {
  RANK_COLUMNS,
  passesPreferenceFilters,
  scoreCandidates,
  type RankRow,
} from "@/lib/rank";
import { expandQuery, isEmptyQuery } from "@/lib/search";

const PAGE = 1000;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 60;
/** Below this, the SQL side has already added trigram matches. */
const THIN_RESULTS = 5;

/**
 * How many matches to pull before preference filtering.
 *
 * This has to be generous, because filtering happens *after* ranking: with a
 * 30-minute cap set, roughly three quarters of any result set is removed, so a
 * small cap here silently throws away good matches that would have passed. At
 * 300 a search for "chicken" reported 72 results out of 1,000+ real matches.
 *
 * 1000 is the ceiling worth asking for — PostgREST truncates any response
 * there regardless of what the query says.
 */
const MAX_MATCHES = 1000;

/**
 * GET /api/search
 *   ?q=chicken            the query
 *   ?scope=corpus|library corpus (Discover) is the default
 *   ?limit=30
 *   ?debug=true           how the query was parsed and what each result scored
 *
 * An empty query is not an error — the caller falls through to the ranked
 * Discover feed (corpus) or the plain library list.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  const params = req.nextUrl.searchParams;
  const raw = (params.get("q") ?? "").trim();
  const scope = params.get("scope") === "library" ? "library" : "corpus";
  const debug = params.get("debug") === "true";
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(params.get("limit")) || DEFAULT_LIMIT)
  );

  const expanded = expandQuery(raw);
  if (isEmptyQuery(expanded)) {
    return NextResponse.json({ recipes: [], empty: true, query: raw });
  }

  const wantSaved = scope === "library";

  // Preferences only shape corpus results. Filtering my own library by diet
  // would hide recipes I chose on purpose.
  let prefs: Preferences | null = null;
  if (scope === "corpus") {
    const { data, error } = await supabase
      .from("preferences")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    prefs = data ?? null;
  }

  // --- candidate ids -------------------------------------------------------

  let relevance = new Map<string, number>();
  const matchKinds = new Map<string, string>();
  // Only the text arm is capped. The tag arms page through everything, so a
  // 2,302-row meal_prep result is complete, not truncated.
  let textArmCapped = false;

  if (expanded.text.length > 0) {
    const { data, error } = await supabase.rpc("search_recipes", {
      q: expanded.text,
      want_saved: wantSaved,
      max_rows: MAX_MATCHES,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    for (const row of (data ?? []) as {
      id: string;
      relevance: number;
      match_kind: string;
    }[]) {
      relevance.set(row.id, row.relevance);
      matchKinds.set(row.id, row.match_kind);
    }
    textArmCapped = (data ?? []).length >= MAX_MATCHES;
  }

  // Tag arms. ANDed with the text arm — "chicken meal prep" means chicken
  // recipes that are also meal prep, not the union of the two.
  const tagArms: [string, string[]][] = [
    ["concept_tags", expanded.conceptTags],
    ["diet_tags", expanded.dietTags],
    ["meal_types", expanded.mealTypes],
  ];

  for (const [column, values] of tagArms) {
    if (values.length === 0) continue;

    const ids = new Set<string>();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("recipes")
        .select("id")
        .eq("saved", wantSaved)
        .contains(column, values)
        .range(from, from + PAGE - 1);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      for (const row of data ?? []) ids.add(row.id as string);
      if (!data || data.length < PAGE) break;
    }

    if (expanded.text.length === 0 && relevance.size === 0) {
      // Pure tag query — every match is equally relevant, so taste ranks them.
      relevance = new Map([...ids].map((id) => [id, 0]));
    } else {
      relevance = new Map(
        [...relevance].filter(([id]) => ids.has(id))
      );
    }
  }

  if (relevance.size === 0) {
    return NextResponse.json({
      recipes: [],
      total: 0,
      query: raw,
      ...(debug && { debug: { expanded } }),
    });
  }

  // --- hydrate, filter, rank ----------------------------------------------

  const ids = [...relevance.keys()];
  // .in() gets unreliable past ~200 values, so chunk at 100 — but issue the
  // chunks together. Ten sequential round trips to hydrate a common term is
  // the difference between a search that feels instant and one that doesn't.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

  const responses = await Promise.all(
    chunks.map((chunk) =>
      supabase.from("recipes").select(RANK_COLUMNS).in("id", chunk)
    )
  );
  const failed = responses.find((r) => r.error);
  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 });
  }
  const rows = responses.flatMap(
    (r) => (r.data ?? []) as unknown as RankRow[]
  );

  const eligible = rows.filter((r) => passesPreferenceFilters(r, prefs));

  // Taste score, normalized within the search results — same rule as Discover.
  const scored = scoreCandidates(eligible, prefs);
  const taste = new Map(scored.map((s) => [s.id, s]));

  const ranked = eligible
    .map((r) => ({
      id: r.id,
      relevance: relevance.get(r.id) ?? 0,
      matchKind: matchKinds.get(r.id) ?? "tag",
      taste: taste.get(r.id)?.total ?? 0,
    }))
    // Relevance leads; the taste score only breaks ties, so searching
    // "chicken" can't hand you a salmon dish because it ranked well.
    .sort((a, b) => b.relevance - a.relevance || b.taste - a.taste)
    .slice(0, limit);

  const pageIds = ranked.map((r) => r.id);
  const { data: full, error: fullError } = await supabase
    .from("recipes")
    .select(RECIPE_COLUMNS)
    .in("id", pageIds);
  if (fullError) {
    return NextResponse.json({ error: fullError.message }, { status: 500 });
  }

  const byId = new Map((full ?? []).map((r) => [r.id as string, r]));
  const recipes = ranked.map((r) => byId.get(r.id)).filter(Boolean);

  return NextResponse.json({
    recipes,
    total: eligible.length,
    query: raw,
    fuzzy: ranked.some((r) => r.matchKind === "trigram"),
    // The text arm hit the ceiling, so `total` is a floor, not a count.
    truncated: textArmCapped,
    ...(debug && {
      debug: {
        expanded,
        matchedBeforeFilters: rows.length,
        removedByPreferences: rows.length - eligible.length,
        thinResults: eligible.length < THIN_RESULTS,
        results: ranked.map((r) => ({
          title: byId.get(r.id)?.title ?? null,
          relevance: r.relevance,
          matchKind: r.matchKind,
          taste: r.taste,
        })),
      },
    }),
  });
}
