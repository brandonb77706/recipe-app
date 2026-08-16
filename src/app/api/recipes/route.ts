import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { RECIPE_COLUMNS } from "@/lib/types";
import {
  COOKED_FILTERS,
  MEAL_TYPE_FILTERS,
  SORT_OPTIONS,
  DEFAULT_SORT,
  type CookedFilter,
  type MealTypeFilter,
  type SortOption,
} from "@/lib/library";

/**
 * GET /api/recipes — the library.
 *   ?sort=recent|cooked|most_cooked|title|quick
 *   ?cooked=never|cooked|rotation
 *   ?meal_type=dinner|lunch|…
 *
 * Sorting and filtering happen in the query, not in the page — same reason as
 * everywhere else: a React Native client should get this for free.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const asOption = <T extends string>(
    raw: string | null,
    allowed: readonly { value: T }[]
  ): T | null =>
    allowed.some((a) => a.value === raw) ? (raw as T) : null;

  const sort = asOption<SortOption>(params.get("sort"), SORT_OPTIONS) ?? DEFAULT_SORT;
  const cooked = asOption<CookedFilter>(params.get("cooked"), COOKED_FILTERS);
  const mealType = asOption<MealTypeFilter>(
    params.get("meal_type"),
    MEAL_TYPE_FILTERS
  );

  // Library only. Without this filter the list becomes thousands of crawled
  // corpus rows the user never chose.
  let query = supabase.from("recipes").select(RECIPE_COLUMNS).eq("saved", true);

  if (mealType) query = query.contains("meal_types", [mealType]);

  if (cooked === "never") query = query.eq("cook_count", 0);
  if (cooked === "cooked") query = query.gt("cook_count", 0);
  if (cooked === "rotation") {
    // "Proven" means you went back to it, not that you rated it once. Two
    // cooks is a low bar that still excludes everything tried and abandoned.
    query = query.gte("cook_count", 2);
  }

  switch (sort) {
    case "cooked":
      // Never-cooked rows sort last, not first. A null here means "no
      // history", and floating those above the things you actually cook is
      // backwards for a sort that asks "what did I make recently".
      query = query.order("last_cooked_at", {
        ascending: false,
        nullsFirst: false,
      });
      break;
    case "most_cooked":
      query = query
        .order("cook_count", { ascending: false })
        .order("last_cooked_at", { ascending: false, nullsFirst: false });
      break;
    case "title":
      query = query.order("title", { ascending: true });
      break;
    case "quick":
      // Unknown time sorts last for the same reason: it isn't fast, it's
      // unknown, and promoting it would be a claim the data can't support.
      query = query.order("total_minutes", {
        ascending: true,
        nullsFirst: false,
      });
      break;
    default:
      // saved_at, not created_at: for a swipe-saved corpus row created_at is
      // the crawl date, which has nothing to do with when you kept it.
      query = query.order("saved_at", { ascending: false, nullsFirst: false });
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ recipes: data ?? [], sort, cooked, mealType });
}
