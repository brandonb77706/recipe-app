import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { requireUser } from "@/lib/auth";
import { RECIPE_COLUMNS } from "@/lib/types";

const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

/**
 * GET /api/passed — recipes you swiped left on, newest first.
 *
 * A recovery screen, not a browsing destination. A left swipe permanently
 * removes a recipe from Discover (passesHardFilters excludes anything swiped),
 * so without this there is no way back from a mis-swipe — the same shape of
 * problem as a delete with no undo.
 *
 * Unpassing is DELETE /api/swipe, which already removes the row and makes the
 * recipe discoverable again. No second endpoint for it.
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if ("response" in auth) return auth.response;
  const userId = auth.user.id;

  const params = req.nextUrl.searchParams;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(params.get("limit")) || DEFAULT_LIMIT)
  );
  const offset = Math.max(0, Number(params.get("offset")) || 0);

  // Ordered by when you swiped, not when the recipe was crawled — the whole
  // point is "what did I just dismiss".
  const { data: swipes, error: swipeError } = await supabase
    .from("swipes")
    .select("recipe_id, created_at")
    .eq("user_id", userId)
    .eq("direction", "left")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (swipeError) {
    return NextResponse.json({ error: swipeError.message }, { status: 500 });
  }

  const { count, error: countError } = await supabase
    .from("swipes")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("direction", "left");

  if (countError) {
    return NextResponse.json({ error: countError.message }, { status: 500 });
  }

  const ids = (swipes ?? []).map((s) => s.recipe_id as string);
  if (!ids.length) {
    return NextResponse.json({ recipes: [], total: count ?? 0, hasMore: false });
  }

  // Chunked at 100 — .in() starts failing above ~200 values.
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await supabase
      .from("recipes")
      .select(RECIPE_COLUMNS)
      .in("id", ids.slice(i, i + 100));
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    rows.push(...(data ?? []));
  }

  // Restore swipe order — the .in() above returns rows in arbitrary order.
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const recipes = ids.map((id) => byId.get(id)).filter(Boolean);

  return NextResponse.json({
    recipes,
    total: count ?? 0,
    hasMore: offset + ids.length < (count ?? 0),
  });
}
